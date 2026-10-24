import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { CHUNK_BYTES, InferenceInputError, digest, integer } from "../ml/model.js";
import { inferenceInput, inferenceResult, release, type ServingRelease } from "../ml/deployment-model.js";
import { atomic, canonical, exec, identity, json, syncDir } from "./files.js";
async function checksum(path: string, expected: number) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat(); if (!before.isFile() || before.size !== expected) throw new Error("Serving archive size changed");
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of fd.createReadStream({ autoClose: false })) { bytes += chunk.length; if (bytes > expected) throw new Error("Serving archive grew"); hash.update(chunk); }
    const after = await fd.stat(); if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== expected) throw new Error("Serving archive changed");
    return hash.digest("hex");
  } finally { await fd.close(); }
}
export async function servingUpload(root: string, request: Record<string, any>) {
  const hash = digest(request.hash), bytes = integer(request.bytes, 1, 512 * 1024 ** 2, "Serving export size"), directory = join(root, "serving/uploads"), file = join(directory, hash + ".tar.gz");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const present = await stat(file).then(async () => await checksum(file, bytes).then(actual => actual === hash, () => false), (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return false; });
  if (request.action === "serve-upload-status" || present) return { present };
  const names = await readdir(directory); let retained = 0;
  for (const name of names) if (name.endsWith(".tar.gz") || name.endsWith(".part")) retained += (await stat(join(directory, name))).size;
  const temp = file + ".part", current = await stat(temp).then(s => s.size, () => 0);
  if (names.filter(n => n.endsWith(".tar.gz")).length >= 200 || retained - current + bytes > 2 * 1024 ** 3) throw new Error("Serving exports reached their retention limit");
  const offset = integer(request.offset, 0, bytes, "Serving transfer offset");
  if (typeof request.data !== "string" || request.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.data)) throw new Error("Invalid serving transfer chunk");
  const data = Buffer.from(request.data, "base64"); if (!data.length || data.length > CHUNK_BYTES || offset + data.length > bytes) throw new Error("Invalid serving chunk size");
  // A new transfer can repair a corrupt cached archive; an abandoned partial resumes by exact bytes.
  const fd = await open(temp, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await fd.stat(); if (!info.isFile()) throw new Error("Invalid serving transfer file");
    if (offset < info.size) { const previous = Buffer.alloc(data.length); const read = await fd.read(previous, 0, data.length, offset); if (read.bytesRead !== data.length || !previous.equals(data)) throw new Error("Serving transfer conflicts with previous bytes"); }
    else { if (offset !== info.size) throw new Error(`Resume serving transfer at byte ${info.size}`); await fd.write(data, 0, data.length, offset); await fd.sync(); }
  } finally { await fd.close(); }
  if ((await stat(temp)).size === bytes) {
    if (await checksum(temp, bytes) !== hash) { await rm(temp); throw new Error("Serving export checksum mismatch"); }
    await rename(temp, file); await syncDir(directory);
  }
  return { present: offset + data.length === bytes };
}
interface Execution { mode: "prepare" | "predict"; release: ServingRelease; input?: unknown; python: string }
/** Give the control lock to a detached supervisor before sending any model/input bytes.
 * A lost local/SSH control process cannot free compute while its inference still runs. */
export async function servingExecute(root: string, executable: string, bundle: string, requested: unknown, python: string, mode: "prepare" | "predict", input?: unknown) {
  const r = release(requested);
  if (r.bundle !== bundle) throw new Error("Serving bundle differs from deployment");
  const payload: Execution = { mode, release: r, python, ...(mode === "predict" ? { input: inferenceInput(input, r) } : {}) };
  const record = join(root, "serving/releases", r.id + ".json"), previous = await json<ServingRelease>(record, true);
  if (previous && canonical(previous) !== canonical(r)) throw new Error("Serving release inputs changed");
  if (mode === "predict" && !previous) throw new Error("Prepare this deployment release before inference");
  const child = spawn(process.execPath, [executable, "infer", root], { detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let output = "", failure = "";
  const completion = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  void completion.catch(() => {});
  child.stdout.on("data", data => { output += data; if (output.length > 300000) { failure = "Inference output exceeded its limit"; child.kill("SIGTERM"); } });
  child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const owner = await identity(child.pid!); if (!owner) throw new Error("Cannot establish inference supervisor identity");
    await atomic(join(root, ".control-lock/owner.json"), owner);
    child.stdin.end(JSON.stringify(payload));
    const code = await completion;
    if (failure || code !== 0) throw new Error(failure || "Inference supervisor stopped before a result was confirmed");
    const response = JSON.parse(output);
    if (response.ok !== true) { if (response.kind === "input") throw new InferenceInputError(response.error); throw new Error(response.error || "Model inference failed"); }
    const result = inferenceResult(response.result, r, mode === "predict" ? payload.input as ReturnType<typeof inferenceInput> : undefined);
    if (mode === "prepare") await atomic(record, r);
    return result;
  } catch (error) { child.stdin.destroy(); child.kill("SIGTERM"); await completion.catch(() => {}); throw error; }
}
async function groupExists(group: number) {
  const { stdout } = await exec("ps", ["-axo", "pgid=,stat="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").some(line => { const [id, state] = line.trim().split(/\s+/); return Number(id) === group && !state?.startsWith("Z"); });
}
/** Independent of the SSH/controller connection; owns and reaps the Python process group. */
export async function inferenceSupervisor(root: string, bundleDirectory: string, environment: (threads: number, gpu: string) => NodeJS.ProcessEnv) {
  process.stdout.on("error", () => {});
  let stopping = false; process.on("SIGTERM", () => { stopping = true; }); process.on("SIGINT", () => { stopping = true; });
  const inputTimer = setTimeout(() => process.exit(1), 10000);
  let body = "";
  for await (const chunk of process.stdin) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Inference request is too large"); }
  clearTimeout(inputTimer);
  const payload = JSON.parse(body) as Execution, r = release(payload.release);
  if (r.bundle !== basename(bundleDirectory) || !["prepare", "predict"].includes(payload.mode) || stopping) throw new Error("Inference authority changed");
  const envelope = { root, release: r, mode: payload.mode, ...(payload.mode === "predict" ? { input: inferenceInput(payload.input, r) } : {}) };
  const deadline = Date.now() + r.config.timeoutSeconds * 1000;
  const child = spawn(payload.python, [join(bundleDirectory, "inference.py")], { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"], env: environment(r.config.cpus, r.config.gpu ?? "") });
  let output = "", closed = false, code: number | null = null, failure = "", stopAt = 0;
  child.stdout.on("data", chunk => { output += chunk; if (output.length > 256000) { failure = "Inference output exceeded its limit"; stopping = true; } });
  child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
  child.once("error", () => { closed = true; failure = "Inference Python environment is unavailable"; });
  child.once("close", value => { closed = true; code = value; });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const group = child.pid!; child.stdin.end(JSON.stringify(envelope));
  try { while (!closed || await groupExists(group)) {
    if (stopping || Date.now() >= deadline || closed) {
      if (!stopAt) stopAt = Date.now();
      try { process.kill(-group, Date.now() - stopAt > 1000 ? "SIGKILL" : "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  } finally {
    // Keep the supervisor (and its lock authority) alive until all owned children
    // are confirmed gone, including when process inspection temporarily fails.
    while (!closed || await groupExists(group).catch(() => true)) {
      try { process.kill(-group, "SIGKILL"); } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (stopping || stopAt && Date.now() >= deadline || code !== 0) throw new Error(failure || (Date.now() >= deadline ? "Inference exceeded its request timeout; the owned process group was stopped" : "Inference did not complete"));
  const result = JSON.parse(output);
  if (result.ok !== true) { if (result.kind === "input") throw new InferenceInputError(String(result.error).slice(0, 1000)); throw new Error(typeof result.error === "string" ? result.error.slice(0, 1000) : "Model inference failed"); }
  return inferenceResult(result.result, r, payload.mode === "predict" ? envelope.input as ReturnType<typeof inferenceInput> : undefined);
}
