import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, resolveCommit, withRepoLock } from "../git.js";
import { verificationIntegrity } from "../verification-integrity.js";
import { childEnv } from "../env.js";
import { CHUNK_BYTES, COMMIT_ID, contextPath, MAX_BUNDLE_BYTES, MAX_CONTEXT_BYTES, RemoteWorkerError, REQUEST_ID, type ContextFile, type WorkerArtifact } from "./protocol.js";

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const identity = ["-c", "core.hooksPath=/dev/null", "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "-c", "submodule.recurse=false"];
/** Stream binary Git output with a hard byte cap, before creating a transfer file. */
export async function boundedBundle(repo: string, path: string, revisions: string[]) {
  const data = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", [...identity, "bundle", "create", "-", ...revisions], { cwd: repo, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const parts: Buffer[] = []; let size = 0, stderr = "", error: Error | undefined;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = setTimeout(() => { error = new RemoteWorkerError("Git bundle creation exceeded 30 seconds. Sync the provisioned worker mapping, then retry explicitly."); kill(); }, 30_000);
    child.stdout.on("data", (part: Buffer) => { size += part.length; if (size > MAX_BUNDLE_BYTES) { error = new RemoteWorkerError("Git bundle exceeds 64 MiB. Sync the provisioned worker mapping to the repository base, then retry explicitly."); kill(); } else if (!error) parts.push(part); });
    child.stderr.on("data", (part: Buffer) => { stderr = (stderr + part.toString()).slice(-2000); }); child.on("error", (failure) => { error = failure; });
    child.on("close", (code) => { clearTimeout(timer); if (error || code) reject(error ?? new RemoteWorkerError(stderr.trim() || "Cannot create Git bundle")); else resolve(Buffer.concat(parts)); });
  });
  await writeFile(path, data, { flag: "wx", mode: 0o600 }); return data;
}
export async function gitChecked(repo: string, args: string[]) {
  const result = await git([...identity, ...args], repo, { timeoutMs: 30_000 });
  if (result.code) throw new RemoteWorkerError(result.stderr.trim().slice(-1000) || `Remote Git ${args[0]} failed`);
  return result.stdout.trim();
}
/** A Git bundle does not carry submodule contents or materialized checkout-filter output. */
export async function assertTransferTree(repo: string, revision: string) {
  if (!COMMIT_ID.test(revision)) throw new RemoteWorkerError("Remote transfer needs an exact Git object ID");
  const entries = (await gitChecked(repo, ["ls-tree", "-r", "-l", "-z", revision])).split("\0").filter(Boolean);
  let bytes = 0; const attributes: string[] = [];
  for (const entry of entries) { const at = entry.indexOf("\t"), fields = entry.slice(0, at).split(/\s+/), path = entry.slice(at + 1); if (fields[0] === "160000") throw new RemoteWorkerError("Remote Git bundle turns do not transfer submodule contents. Use local execution for this repository."); bytes += Number(fields[3]) || 0; if (path === ".gitattributes" || path.endsWith("/.gitattributes")) attributes.push(path); }
  if (entries.length > 20_000 || bytes > 256 * 1024 * 1024 || attributes.length > 100) throw new RemoteWorkerError("Remote source/result tree exceeds 20,000 files, 256 MiB or 100 attribute files");
  let attributeBytes = 0;
  for (const path of attributes) { const value = await gitChecked(repo, ["show", `${revision}:${path}`]); attributeBytes += Buffer.byteLength(value); if (attributeBytes > 256 * 1024) throw new RemoteWorkerError("Remote checkout attributes exceed 256 KiB"); if (value.split(/\r?\n/).some((row) => !row.trimStart().startsWith("#") && row.split(/\s+/).some((part) => /^[-!]?filter(?:=|$)/.test(part)))) throw new RemoteWorkerError("Remote Git bundle turns do not materialize checkout filters such as Git LFS. Use local execution or a repository without checkout filters."); }
}
/** Suppress configured filters even when an agent introduces new attributes before Git stages its work. */
export async function disabledCheckoutFilters(repo: string) {
  const result = await git(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(smudge|clean|process|required)$"], repo, { timeoutMs: 10_000 }); if (result.code > 1) throw new RemoteWorkerError("Cannot inspect checkout filter policy");
  const keys = [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))]; if (keys.length > 100 || keys.some((key) => !/^filter\.[^\x00-\x20\x7f]+\.(?:smudge|clean|process|required)$/.test(key))) throw new RemoteWorkerError("Worker Git checkout filter configuration exceeds its supported bound");
  return keys.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
}
export async function sourceBundle(repo: string, baseCommit: string, requestId: string, exclude?: string) {
  if (!COMMIT_ID.test(baseCommit) || !REQUEST_ID.test(requestId) || exclude && !COMMIT_ID.test(exclude)) throw new RemoteWorkerError("Choose exact transfer commits and a valid request ID");
  const folder = await mkdtemp(join(tmpdir(), "codeflow-remote-source-")), path = join(folder, "source.bundle"), ref = `refs/codeflow/transfers/${requestId}`;
  let claimed = false;
  try {
    await gitChecked(repo, ["update-ref", ref, baseCommit, "0".repeat(baseCommit.length)]); claimed = true;
    const data = await boundedBundle(repo, path, [ref, ...(exclude && exclude !== baseCommit ? [`^${exclude}`] : [])]);
    return { data, size: data.length, sha256: sha256(data), ref };
  } finally {
    try { if (claimed) await gitChecked(repo, ["update-ref", "-d", ref, baseCommit]); }
    finally { await rm(folder, { recursive: true, force: true }); }
  }
}
export async function contextManifest(repo: string): Promise<{ files: ContextFile[]; data: Map<string, Buffer> }> {
  const root = join(repo, ".codeflow-context"), files: ContextFile[] = [], data = new Map<string, Buffer>(); let total = 0, entries = 0;
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return { files, data };
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RemoteWorkerError("Remote staged context must be a regular directory");
  const visit = async (directory: string, relative: string) => {
    for (const name of await readdir(directory)) {
      if (++entries > 1000) throw new RemoteWorkerError("Remote context contains too many filesystem entries");
      const path = `${relative}/${name}`, absolute = join(directory, name), info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new RemoteWorkerError("Remote context cannot contain symbolic links");
      if (info.isDirectory()) { if (path.split("/").length > 32) throw new RemoteWorkerError("Remote context nesting exceeds its bound"); await visit(absolute, path); continue; }
      if (!info.isFile() || !contextPath(path) || info.size > 8 * 1024 * 1024 || files.length >= 100) throw new RemoteWorkerError("Remote context contains an unsupported, sensitive or oversized file");
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: Buffer;
      try { const current = await handle.stat(); if (!current.isFile() || current.size > 8 * 1024 * 1024 || current.ino !== info.ino || current.dev !== info.dev) throw new RemoteWorkerError("Staged context changed while being inspected"); value = await handle.readFile(); const after = await handle.stat(); if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || value.length > 8 * 1024 * 1024) throw new RemoteWorkerError("Staged context changed while being copied"); }
      finally { await handle.close(); }
      total += value.length;
      if (total > MAX_CONTEXT_BYTES) throw new RemoteWorkerError("Remote staged context exceeds 16 MiB");
      files.push({ path, size: value.length, sha256: sha256(value) }); data.set(path, value);
    }
  };
  await visit(root, ".codeflow-context"); return { files, data };
}
/** Import only a validated descendant into the unchanged run checkout; no host paths come from bundles. */
export async function importWorkerArtifact(repo: string, artifact: WorkerArtifact & { file: string }, expectedHead: string) {
  if (!REQUEST_ID.test(artifact.requestId) || !COMMIT_ID.test(artifact.head) || artifact.baseCommit !== expectedHead || artifact.ref !== `refs/codeflow/results/${artifact.requestId}` || artifact.size > MAX_BUNDLE_BYTES) throw new RemoteWorkerError("Invalid remote result artifact");
  const info = await lstat(artifact.file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size || sha256(await readFile(artifact.file)) !== artifact.sha256) throw new RemoteWorkerError("Remote result bundle failed its integrity check");
  return withRepoLock(repo, async () => {
    if (await resolveCommit(repo) !== expectedHead) throw new RemoteWorkerError("The local worktree changed while remote work was running");
    const integrity = await verificationIntegrity(repo);
    const ref = `refs/codeflow/imports/${artifact.requestId}`;
    let claimed = false;
    try {
      const heads = await gitChecked(repo, ["bundle", "list-heads", artifact.file]);
      if (heads !== `${artifact.head} ${artifact.ref}`) throw new RemoteWorkerError("Remote result bundle has unexpected references");
      await gitChecked(repo, ["bundle", "verify", artifact.file]);
      const exists = await git(["show-ref", "--verify", "--quiet", ref], repo);
      if (!exists.code) throw new RemoteWorkerError("This remote import reference is already claimed");
      await gitChecked(repo, ["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", artifact.file, `${artifact.ref}:${ref}`]); claimed = true;
      const imported = await resolveCommit(repo, ref);
      if (imported !== artifact.head || (await git(["merge-base", "--is-ancestor", expectedHead, imported], repo)).code) throw new RemoteWorkerError("Remote result is not a descendant of the accepted base");
      await assertTransferTree(repo, imported); const filters = await disabledCheckoutFilters(repo);
      await integrity.assert("remote result import");
      await gitChecked(repo, [...filters, "merge", "--ff-only", "--no-edit", imported]);
      return { head: imported };
    } finally { if (claimed) await gitChecked(repo, ["update-ref", "-d", ref, artifact.head]); }
  });
}
export async function writeContext(root: string, path: string, value: Uint8Array) {
  if (!contextPath(path)) throw new RemoteWorkerError("Invalid remote context path");
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part); await mkdir(current, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new RemoteWorkerError("Remote context directory is not regular");
  }
  await writeFile(join(root, path), value, { flag: "wx", mode: 0o600 });
}
export function chunks(data: Uint8Array) { const parts: { offset: number; data: string }[] = []; for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) parts.push({ offset, data: Buffer.from(data.subarray(offset, offset + CHUNK_BYTES)).toString("base64") }); return parts; }
