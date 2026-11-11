import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { git, type GitCwd } from "../git.js";
import { childEnv } from "../env.js";

export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const COMMIT_ID = /^[a-f0-9]{40,64}$/i;
export const DIGEST = /^[a-f0-9]{64}$/;
export class GitTransferError extends Error {}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const identity = ["-c", "core.hooksPath=/dev/null", "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "-c", "submodule.recurse=false"];
/** Stream binary Git output with a hard byte cap, before creating a transfer file. */
export async function boundedBundle(repo: string, path: string, revisions: string[]) {
  const data = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", [...identity, "bundle", "create", "-", ...revisions], { cwd: repo, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const parts: Buffer[] = []; let size = 0, stderr = "", error: Error | undefined;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = setTimeout(() => { error = new GitTransferError("Git bundle creation exceeded 30 seconds."); kill(); }, 30_000);
    child.stdout.on("data", (part: Buffer) => { size += part.length; if (size > MAX_BUNDLE_BYTES) { error = new GitTransferError("Git bundle exceeds 64 MiB."); kill(); } else if (!error) parts.push(part); });
    child.stderr.on("data", (part: Buffer) => { stderr = (stderr + part.toString()).slice(-2000); }); child.on("error", (failure) => { error = failure; });
    child.on("close", (code) => { clearTimeout(timer); if (error || code) reject(error ?? new GitTransferError(stderr.trim() || "Cannot create Git bundle")); else resolve(Buffer.concat(parts)); });
  });
  await writeFile(path, data, { flag: "wx", mode: 0o600 }); return data;
}
export async function gitChecked(repo: GitCwd, args: string[]) {
  const result = await git([...identity, ...args], repo, { timeoutMs: 30_000 });
  if (result.code) throw new GitTransferError(result.stderr.trim().slice(-1000) || `Git ${args[0]} failed`);
  return result.stdout.trim();
}
/** A Git bundle does not carry submodule contents or materialized checkout-filter output. */
export async function assertTransferTree(repo: GitCwd, revision: string) {
  if (!COMMIT_ID.test(revision)) throw new GitTransferError("A Git bundle transfer needs an exact Git object ID");
  const entries = (await gitChecked(repo, ["ls-tree", "-r", "-l", "-z", revision])).split("\0").filter(Boolean);
  let bytes = 0; const attributes: string[] = [];
  for (const entry of entries) { const at = entry.indexOf("\t"), fields = entry.slice(0, at).split(/\s+/), path = entry.slice(at + 1); if (fields[0] === "160000") throw new GitTransferError("Git bundles do not transfer submodule contents."); bytes += Number(fields[3]) || 0; if (path === ".gitattributes" || path.endsWith("/.gitattributes")) attributes.push(path); }
  if (entries.length > 20_000 || bytes > 256 * 1024 * 1024 || attributes.length > 100) throw new GitTransferError("The transferred tree exceeds 20,000 files, 256 MiB or 100 attribute files");
  let attributeBytes = 0;
  for (const path of attributes) { const value = await gitChecked(repo, ["show", `${revision}:${path}`]); attributeBytes += Buffer.byteLength(value); if (attributeBytes > 256 * 1024) throw new GitTransferError("Checkout attributes exceed 256 KiB"); if (value.split(/\r?\n/).some((row) => !row.trimStart().startsWith("#") && row.split(/\s+/).some((part) => /^[-!]?filter(?:=|$)/.test(part)))) throw new GitTransferError("Git bundles do not materialize checkout filters such as Git LFS."); }
}
