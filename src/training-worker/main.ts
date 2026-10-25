import { holdoutResult } from "../ml/holdout-model.js";
import { assertNoResident, residentDiscard, residentPrepare, residentRequest, residentStatus, residentStop, residentSupervisor } from "./resident.js";
import { inferenceSupervisor, servingExecute, servingUpload } from "./serving.js";
import { release as servingRelease } from "../ml/deployment-model.js";
import { fingerprintFile } from "../ml/source.js";
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { cpus, freemem, hostname, homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHUNK_BYTES, DATA_LIMIT, InferenceInputError, ML_PROTOCOL, RECIPE, LLM_RECIPE, recipe, isLlm, modelSnapshot, jobStatus, type Recipe, dataset, digest, id, integer, intent, object, string, terminal, type Dataset, type Intent, type JobStatus, type Probe, type ProcessIdentity, type Evaluation } from "../ml/model.js";
import { alive, atomic, canonical, exec, hash, identity, json, locked, syncDir } from "./files.js";
const executable = fileURLToPath(import.meta.url);
const bundleDir = dirname(executable);
interface Enrollment { version: 1; workerId: string; controllerId: string }
interface Request { controllerId: string; workerId?: string; action: string; [key: string]: unknown }
const jobDir = (root: string, value: unknown) => join(root, "jobs", id(value));
const recipePath = (selected: Recipe = RECIPE) => join(bundleDir, selected === LLM_RECIPE ? "llm_recipe.py" : "recipe.py");
export const workerRoot = (value: string) => {
  string(value, "worker directory", 4096);
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded) || expanded === "/" || expanded === homedir()) throw new Error("Choose a dedicated absolute worker directory");
  return resolve(expanded);
};
function environment(root: string, threads = 1, gpu: string | null = ""): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, "runtime-home"), LANG: "en_US.UTF-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", MPLCONFIGDIR: join(root, "runtime-home", "matplotlib"), OMP_NUM_THREADS: String(threads), OPENBLAS_NUM_THREADS: String(threads), MKL_NUM_THREADS: String(threads), NUMEXPR_NUM_THREADS: String(threads), ...(gpu === null ? {} : { CUDA_VISIBLE_DEVICES: gpu }), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", WANDB_DISABLED: "true", TOKENIZERS_PARALLELISM: "false" };
  return env;
}
const managedPython = (root: string, selected: Recipe = RECIPE) => join(root, "environments", basename(bundleDir), ...(selected === LLM_RECIPE ? ["llm"] : []), "bin", "python");
async function pythonFor(root: string, requested: unknown, selected: Recipe = RECIPE): Promise<string> {
  const python = string(requested, "Python executable", 4096);
  if (python !== "python3" && !isAbsolute(python)) throw new Error("Use python3 or an absolute Python executable");
  return await stat(managedPython(root, selected)).then(() => managedPython(root, selected), () => python);
}
async function probe(root: string, enrollment: Enrollment, requested: unknown, selected: Recipe = RECIPE, serving = false): Promise<Probe> {
  const recipes: NonNullable<Probe["recipes"]> = [];
  for (const selectedRecipe of [RECIPE, LLM_RECIPE] as const) {
    const python = await pythonFor(root, requested, selectedRecipe);
    try {
      const { stdout } = await exec(python, (serving ? [join(bundleDir, "inference.py"), "probe", selectedRecipe] : [recipePath(selectedRecipe), "probe"]), { env: environment(root, 1, null), cwd: root, timeout: 40000, maxBuffer: 64000 });
      const result = JSON.parse(stdout);
      recipes.push({ id: selectedRecipe, python, ready: true, devices: selectedRecipe === LLM_RECIPE ? result.devices : ["cpu"] });
    } catch { recipes.push({ id: selectedRecipe, python, ready: false, issue: "Install the pinned Python 3.12 environment for this recipe, or choose a compatible existing Python environment." }); }
  }
  const selectedResult = recipes.find(r => r.id === selected)!;
  const gpus = await exec("nvidia-smi", ["--query-gpu=uuid,name,memory.total,memory.free", "--format=csv,noheader,nounits"], { timeout: 5000, maxBuffer: 64000 }).then(({ stdout }) => stdout.trim().split("\n").filter(Boolean).map(line => { const [uuid, name, memory, free] = line.split(",").map(s => s.trim()); return { uuid: uuid!, name: name!, memoryMiB: Number(memory), freeMiB: Number(free) }; }).filter(g => Number.isFinite(g.memoryMiB) && Number.isFinite(g.freeMiB)), () => []);
  const disk = await statfs(root);
  return { workerId: enrollment.workerId, protocol: ML_PROTOCOL, commonHoldout: 1, boundedSearch: 1, dataWatch: 1, serving: 1, persistentServing: 1, platform: platform(), hostname: hostname(), cpus: cpus().length, memoryBytes: freemem(), freeBytes: disk.bavail * disk.bsize, python: selectedResult.python, ready: selectedResult.ready, issue: selectedResult.issue, recipe: selected, recipes, gpus, limits: { datasetBytes: DATA_LIMIT, concurrentJobs: 1, hardMemoryLimit: false } };
}
async function state(root: string, jobId: unknown): Promise<JobStatus> {
  const directory = jobDir(root, jobId), accepted = intent(await json(join(directory, "intent.json")));
  for (let attempt = 0; ; attempt++) {
    const status = await json<JobStatus>(join(directory, "status.json"), true) ?? { id: accepted.id, state: "submitted", updatedAt: accepted.createdAt };
    if (accepted.recipe === LLM_RECIPE && accepted.kind === "training") {
      const progress = await json<JobStatus["progress"]>(join(directory, "progress.json"), true);
      if (progress) { jobStatus({ ...status, progress }); status.progress = progress; }
    }
    if (terminal(status.state)) return status;
    const supervisor = status.runner ?? await json<ProcessIdentity>(join(directory, "supervisor.json"), true);
    if (await alive(supervisor)) return await json(join(directory, "cancel.json"), true) ? { ...status, state: "cancel_requested" } : status;
    // Exit can race the first read. The runner writes its final receipt before
    // exiting; read it again after the identity check, without launching a retry.
    if (attempt) return { ...status, state: "unknown", error: "Supervisor identity cannot be confirmed. Inspect the worker; this job will not be retried automatically." };
  }
}
async function snapshotHash(path: string) {
  const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest("hex");
}
async function finishSnapshot(root: string, request: Record<string, any>): Promise<Dataset> {
  const fingerprint = digest(request.hash), format = request.format;
  if (!["csv", "parquet", "jsonl"].includes(format)) throw new Error("Use CSV, Parquet or JSONL");
  const key = `${fingerprint}-${format}`, destination = join(root, "datasets", `${fingerprint}.${format}`);
  const partial = join(root, "transfers", key + ".part");
  const existing = await json<Dataset>(join(root, "datasets", key + ".json"), true);
  if (existing) { if (await snapshotHash(destination) !== fingerprint) throw new Error("Cached dataset hash changed"); await rm(partial, { force: true }); await rm(partial + "." + format, { force: true }); return dataset(existing); }
  const input = await stat(destination).then(() => destination, () => partial);
  const size = (await stat(input)).size;
  integer(size, 1, format === "jsonl" ? 32 * 1024 * 1024 : DATA_LIMIT, "Dataset size");
  if (await snapshotHash(input) !== fingerprint) throw new Error("Dataset transfer checksum mismatch");
  const selected = format === "jsonl" ? LLM_RECIPE : RECIPE;
  const python = await pythonFor(root, request.python, selected);
  const inspection = input.endsWith(".part") ? await copyForInspection(input, format) : input;
  let stdout: string;
  try { ({ stdout } = await exec(python, [recipePath(selected), "inspect", inspection], { env: environment(root), cwd: root, timeout: 60000, maxBuffer: 256000 })); }
  finally { if (inspection !== input) await rm(inspection, { force: true }); }
  const result = dataset({ id: key, hash: fingerprint, bytes: size, format, ...JSON.parse(stdout) });
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (input !== destination) { await rename(input, destination); await chmod(destination, 0o400); await syncDir(dirname(destination)); await rm(input + "." + format, { force: true }); }
  await atomic(join(root, "datasets", key + ".json"), result);
  return result;
}
async function reserveHoldout(root: string, request: Record<string, any>, prepared: Dataset) {
  if (request.purpose !== undefined && request.purpose !== "holdout") throw new Error("Invalid dataset purpose");
  if (request.purpose === "holdout") {
    if (prepared.rows > 10000 || prepared.duplicateRows) throw new Error("Holdout needs 30–10,000 independent rows without duplicates");
    for (const value of await readdir(join(root, "jobs")).catch(() => [])) {
      const prior = intent(await json(join(jobDir(root, value), "intent.json")));
      if (prior.kind === "training" && prior.dataset?.hash === prepared.hash) throw new Error("Previously trained data cannot become a holdout");
    }
    await atomic(join(root, "holdouts", prepared.hash + ".json"), { hash: prepared.hash });
  }
  return prepared;
}
async function copyForInspection(path: string, format: string) { const file = path + "." + format; await copyFile(path, file); return file; }

/** Control requests are short-lived; admitted job supervisors are detached and durable. */
export async function control(directory: string, raw: unknown): Promise<unknown> {
  const root = workerRoot(directory);
  const request = object(raw, ["action", "controllerId", "workerId", "python", "path", "format", "hash", "offset", "data", "bytes", "intent", "id", "cursor", "recipe", "release", "input", "serving", "deploymentId", "revision", "expectedSession", "requestId", "stream", "purpose"], "worker request") as Request;
  id(request.controllerId);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Training workers currently support Linux and macOS");
  return locked(root, async () => {
    const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Worker directory must not be a symlink");
    await mkdir(join(root, "runtime-home"), { recursive: true, mode: 0o700 });
    let enrollment = await json<Enrollment>(join(root, "worker.json"), true);
    if (!enrollment) {
      if (request.action !== "enroll") throw new Error("Enroll this worker before using it");
      enrollment = { version: 1, workerId: randomUUID(), controllerId: request.controllerId };
      await atomic(join(root, "worker.json"), enrollment);
    }
    if (enrollment.controllerId !== request.controllerId || request.workerId !== undefined && request.workerId !== enrollment.workerId) throw new Error("Worker identity or controller enrollment changed");
    if (request.action === "resident-status") return residentStatus(root);
    if (request.action === "resident-stop") return residentStop(root, request.deploymentId, request.revision);
    if (request.action === "resident-discard") return residentDiscard(root, request.deploymentId, request.revision, request.expectedSession);
    if (["resident-start", "resident-poll", "resident-cancel"].includes(request.action)) return residentRequest(root, request.action, request);
    if (request.action === "resident-prepare") {
      const r = servingRelease(request.release);
      if (r.controllerId !== enrollment.controllerId || r.workerId !== enrollment.workerId) throw new Error("Serving worker authority changed");
      for (const previous of await readdir(join(root, "jobs")).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return []; })) if (!terminal((await state(root, previous)).state)) throw new Error("Training or an unresolved job owns this worker");
      return residentPrepare(root, executable, r, await pythonFor(root, request.python, r.recipe), request.deploymentId, request.revision, request.expectedSession);
    }
    if (["enroll", "probe", "submit", "snapshot", "finish-upload", "serve-prepare", "serve-predict"].includes(request.action)) await assertNoResident(root);
    if (request.serving !== undefined && typeof request.serving !== "boolean") throw new Error("Invalid inference probe");
    if (request.action === "enroll" || request.action === "probe") return probe(root, enrollment, request.python, recipe(request.recipe), request.serving === true);
    if (request.action === "serve-upload" || request.action === "serve-upload-status") return servingUpload(root, request);
    if (request.action === "serve-prepare" || request.action === "serve-predict") {
      const r = servingRelease(request.release);
      if (r.controllerId !== enrollment.controllerId || r.workerId !== enrollment.workerId) throw new Error("Serving worker authority changed");
      for (const previous of await readdir(join(root, "jobs")).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return []; })) if (!terminal((await state(root, previous)).state)) throw new Error("Training or an unresolved job owns this worker");
      return servingExecute(root, executable, basename(bundleDir), r, await pythonFor(root, request.python, r.recipe), request.action === "serve-prepare" ? "prepare" : "predict", request.input);
    }
    if (request.action === "fingerprint") return fingerprintFile(request.path);
    if (request.action === "snapshot") {
      const source = string(request.path, "dataset path", 4096);
      if (!isAbsolute(source)) throw new Error("Dataset paths must be absolute on the selected computer");
      const format = source.toLowerCase().endsWith(".csv") ? "csv" : source.toLowerCase().endsWith(".parquet") ? "parquet" : source.toLowerCase().endsWith(".jsonl") ? "jsonl" : undefined;
      if (!format) throw new Error("Use a .csv, .parquet or .jsonl dataset");
      const fd = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const temp = join(root, "transfers", randomUUID() + ".part");
      await mkdir(dirname(temp), { recursive: true, mode: 0o700 });
      const output = await open(temp, "wx", 0o600), hasher = createHash("sha256");
      let bytes = 0;
      try {
        const before = await fd.stat(); if (!before.isFile()) throw new Error("Choose a regular dataset file"); integer(before.size, 1, format === "jsonl" ? 32 * 1024 * 1024 : DATA_LIMIT, "Dataset size");
        for await (const chunk of fd.createReadStream({ autoClose: false })) { bytes += chunk.length; if (bytes > DATA_LIMIT) throw new Error("Dataset is too large"); hasher.update(chunk); await output.write(chunk); }
        const after = await fd.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Dataset changed while it was being copied");
        await output.sync();
      } catch (error) { await rm(temp, { force: true }); throw error; }
      finally { await fd.close(); await output.close(); }
      const fingerprint = hasher.digest("hex");
      await rename(temp, join(root, "transfers", `${fingerprint}-${format}.part`));
      return reserveHoldout(root, request, await finishSnapshot(root, { hash: fingerprint, format, python: request.python }));
    }
    if (request.action === "upload") {
      const fingerprint = digest(request.hash), format = request.format;
      if (!["csv", "parquet", "jsonl"].includes(String(format))) throw new Error("Invalid dataset format");
      const total = integer(request.bytes, 1, format === "jsonl" ? 32 * 1024 * 1024 : DATA_LIMIT, "Dataset bytes"), offset = integer(request.offset, 0, total, "Transfer offset");
      if (typeof request.data !== "string" || request.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.data)) throw new Error("Invalid transfer chunk");
      const data = Buffer.from(request.data, "base64"); if (!data.length || data.length > CHUNK_BYTES || offset + data.length > total) throw new Error("Invalid chunk size");
      const file = join(root, "transfers", `${fingerprint}-${format}.part`);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const fd = await open(file, "a+", 0o600);
      try {
        const size = (await fd.stat()).size;
        if (offset < size) { const prior = Buffer.alloc(data.length); const read = await fd.read(prior, 0, data.length, offset); if (read.bytesRead !== data.length || !prior.equals(data)) throw new Error("Transfer chunk conflicts with existing data"); }
        else { if (offset !== size) throw new Error(`Resume this transfer at byte ${size}`); await fd.write(data); await fd.sync(); }
        return { offset: (await fd.stat()).size };
      } finally { await fd.close(); }
    }
    if (request.action === "finish-upload") return reserveHoldout(root, request, await finishSnapshot(root, request));
    if (request.action === "reconcile") {
      const accepted = intent(request.intent);
      if (accepted.controllerId !== enrollment.controllerId || accepted.workerId !== enrollment.workerId || accepted.bundle !== basename(bundleDir)) throw new Error("Job authority changed");
      const dir = jobDir(root, accepted.id), prior = await json<Intent>(join(dir, "intent.json"), true);
      if (prior && canonical(prior) !== canonical(accepted)) throw new Error("Operation inputs changed");
      if (!prior) {
        // Fence a missing admission before reporting failure. A delayed submit
        // sees this same receipt and cannot launch after the reservation releases.
        await atomic(join(dir, "intent.json"), accepted);
        await atomic(join(dir, "status.json"), { id: accepted.id, state: "failed", updatedAt: Date.now(), endedAt: Date.now(), error: "Submission was not accepted and has been fenced. Start a new experiment to try again." });
      }
      return state(root, accepted.id);
    }
    if (request.action === "submit") {
      const accepted = intent(request.intent);
      if (accepted.controllerId !== enrollment.controllerId || accepted.workerId !== enrollment.workerId || accepted.bundle !== basename(bundleDir)) throw new Error("Job authority or worker bundle mismatch");
      const dir = jobDir(root, accepted.id), prior = await json<Intent>(join(dir, "intent.json"), true);
      if (prior) { if (canonical(prior) !== canonical(accepted)) throw new Error("Operation ID was reused with different inputs"); return state(root, accepted.id); }
      if (Date.now() >= accepted.deadline) throw new Error("Job deadline already expired");
      await mkdir(join(root, "jobs"), { recursive: true, mode: 0o700 });
      const ids = await readdir(join(root, "jobs")); if (ids.length >= 200) throw new Error("Worker history is full; archive it before admitting more work");
      for (const previous of ids) if (!terminal((await state(root, previous)).state)) throw new Error("This worker has an active or unresolved job; inspect it before starting another");
      if (accepted.kind === "training" || accepted.kind === "holdout") {
        const d = accepted.dataset!;
        const registered = dataset(await json(join(root, "datasets", d.id + ".json")));
        if (canonical(registered) !== canonical(d) || await snapshotHash(join(root, "datasets", `${d.hash}.${d.format}`)) !== d.hash) throw new Error("Dataset snapshot changed");
        const reserved = await json(join(root, "holdouts", d.hash + ".json"), true);
        if (accepted.kind === "training" && reserved || accepted.kind === "holdout" && !reserved) throw new Error("Dataset purpose does not permit this job");
        const capability = await probe(root, enrollment, accepted.python, recipe(accepted.recipe), accepted.kind === "holdout");
        if (!capability.ready) throw new Error(capability.issue);
        if (isLlm(accepted.spec)) {
          if (!capability.recipes?.find(r => r.id === LLM_RECIPE)?.devices?.includes(accepted.spec.device)) throw new Error("The selected device is unavailable in this environment");
          if (accepted.spec.device === "cuda" && !capability.gpus.some(g => g.uuid === (accepted.spec as import("../ml/model.js").LlmSpec).gpu)) throw new Error("The selected NVIDIA GPU is unavailable");
        }
        if ((accepted.spec?.cpus ?? accepted.holdout!.candidate.config.cpus) > capability.cpus) throw new Error("Requested CPU threads exceed this computer's capacity");
      }
      // Receipt before launch. A crash after this write leaves an unresolved, non-retriable admission.
      await atomic(join(dir, "intent.json"), accepted);
      await atomic(join(dir, "status.json"), { id: accepted.id, state: "submitted", updatedAt: Date.now() });
      const child = spawn(process.execPath, [executable, "run", root, accepted.id], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      // A separate launch receipt bridges startup without overwriting a running
      // or completed status that the detached supervisor has already published.
      const supervisor = await identity(child.pid!);
      if (supervisor) await atomic(join(dir, "supervisor.json"), supervisor);
      return { id: accepted.id, state: "submitted", updatedAt: Date.now() };
    }
    if (request.action === "inspect") return state(root, request.id);
    if (request.action === "cancel") {
      const current = await state(root, request.id);
      if (terminal(current.state)) return current;
      await atomic(join(jobDir(root, request.id), "cancel.json"), { at: Date.now() });
      return { ...current, state: current.state === "unknown" ? "unknown" : "cancel_requested" };
    }
    if (request.action === "logs" || request.action === "artifact") {
      const dir = jobDir(root, request.id), current = await state(root, request.id);
      if (request.action === "artifact" && (current.state !== "succeeded" || !current.artifact)) throw new Error("An evaluated export is not available");
      const file = join(dir, request.action === "logs" ? "output.log" : "model.tar.gz");
      const fd = await open(file, "r").catch(error => { if (request.action === "logs" && error.code === "ENOENT") return undefined; throw error; });
      if (!fd) return { data: "", cursor: 0, bytes: 0 };
      try { const info = await fd.stat(), cursor = integer(request.cursor ?? 0, 0, info.size, "Read cursor"), buffer = Buffer.alloc(request.action === "logs" ? 32768 : CHUNK_BYTES); const { bytesRead } = await fd.read(buffer, 0, buffer.length, cursor); return { data: buffer.subarray(0, bytesRead).toString("base64"), cursor: cursor + bytesRead, bytes: info.size }; }
      finally { await fd.close(); }
    }
    throw new Error("Unknown training-worker operation");
  });
}

/** Final testing copies only checksum-verified artifacts from the admitted winning trial. */
async function copySelectedModel(root: string, accepted: Intent, destination: string) {
  const binding = accepted.search!.fromJob!, source = jobDir(root, binding.id);
  const previous = intent(await json(join(source, "intent.json"))), receipt = await json<JobStatus>(join(source, "status.json"));
  if (receipt.state !== "succeeded" || receipt.evaluation?.partition !== "validation" || receipt.evaluation.modelHash !== binding.modelHash || previous.search?.cycleId !== accepted.search!.cycleId || previous.search.partition !== "validation" || previous.bundle !== accepted.bundle || previous.workerId !== accepted.workerId || previous.controllerId !== accepted.controllerId || canonical(previous.spec) !== canonical(accepted.spec) || canonical(previous.dataset) !== canonical(accepted.dataset) || canonical(previous.model ?? null) !== canonical(accepted.model ?? null) || canonical(previous.source) !== canonical(accepted.source)) throw new Error("Selected trial does not match final evaluation inputs");
  const manifest = await json<{ files?: { path: string; hash: string; bytes: number }[]; adapterFiles?: { path: string; hash: string; bytes: number }[]; tokenizerFiles?: { path: string; hash: string; bytes: number }[] }>(join(source, "manifest.json"));
  const modelFiles = isLlm(accepted.spec) ? manifest.adapterFiles : manifest.files;
  if (!Array.isArray(modelFiles) || hash(canonical(modelFiles)) !== binding.modelHash) throw new Error("Selected model manifest changed");
  const files = [...modelFiles, ...(isLlm(accepted.spec) ? manifest.tokenizerFiles ?? [] : [])];
  if (!files.length || files.length > 10000) throw new Error("Invalid selected artifact manifest");
  let bytes = 0;
  for (const file of files) {
    if (typeof file.path !== "string" || !/^(model|adapter|tokenizer)\//.test(file.path) || file.path.split("/").some(p => !p || p === "." || p === "..") || file.path.includes("\\")) throw new Error("Invalid selected artifact path");
    let path = source;
    for (const part of file.path.split("/")) { path = join(path, part); if ((await lstat(path)).isSymbolicLink()) throw new Error("Selected artifacts cannot contain symlinks"); }
    const info = await lstat(path); bytes += info.size;
    if (!info.isFile() || bytes > 512 * 1024 ** 2 || info.size !== file.bytes || await snapshotHash(path) !== digest(file.hash)) throw new Error("Selected artifact checksum changed");
    const output = join(destination, file.path); await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await copyFile(path, output, constants.COPYFILE_EXCL);
    if (await snapshotHash(output) !== file.hash) throw new Error("Artifact changed during copying");
  }
  if (isLlm(accepted.spec)) await atomic(join(destination, "training-result.json"), { selectedTrial: binding.id, modelHash: binding.modelHash, retrained: false });
}

async function groupExists(pgid: number) {
  const { stdout } = await exec("ps", ["-axo", "pgid=,stat="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").some(line => { const [group, status] = line.trim().split(/\s+/); return Number(group) === pgid && !status?.startsWith("Z"); });
}
async function runner(root: string, jobId: string) {
  const dir = jobDir(root, jobId), accepted = intent(await json(join(dir, "intent.json")));
  // O_EXCL is the launch fence, even if two supervisors were accidentally spawned.
  const claim = await open(join(dir, "started"), "wx", 0o600); await claim.sync(); await claim.close(); await syncDir(dir);
  const runnerIdentity = await identity(); if (!runnerIdentity) throw new Error("Cannot establish supervisor identity");
  let status: JobStatus = { id: jobId, state: "preparing", updatedAt: Date.now(), startedAt: Date.now(), runner: runnerIdentity };
  const persist = async (patch: Partial<JobStatus>) => { status = { ...status, ...patch, updatedAt: Date.now() }; await atomic(join(dir, "status.json"), status); };
  await persist({});
  const log = await open(join(dir, "output.log"), "a", 0o600);
  let logged = (await log.stat()).size;
  let logTail: Promise<unknown> = Promise.resolve();
  const append = (data: Buffer | string) => { const chunk = Buffer.from(data).subarray(0, Math.max(0, 4 * 1024 * 1024 - logged)); logged += chunk.length; if (chunk.length) logTail = logTail.then(() => log.write(chunk)); };
  let stopping = false;
  let childGroup: number | undefined;
  const stopRequested = async () => stopping || Date.now() >= accepted.deadline || !!await json(join(dir, "cancel.json"), true);
  process.once("SIGTERM", () => { stopping = true; }); process.once("SIGINT", () => { stopping = true; });
  async function run(command: string, args: string[], stageSeconds?: number) {
    const stageDeadline = stageSeconds === undefined ? Infinity : Date.now() + stageSeconds * 1000;
    if (await stopRequested()) throw new Error("Job cancelled or deadline exceeded");
    append(`\nStarting ${args[1] ?? "environment setup"}\n`);
    const child = spawn(command, args, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: environment(root, accepted.spec?.cpus ?? accepted.holdout?.candidate.config.cpus, accepted.holdout?.candidate.config.gpu ?? (isLlm(accepted.spec) ? accepted.spec.gpu ?? "" : "")) });
    let closed = false, code: number | null = null, launchError: Error | undefined;
    child.stdout!.on("data", append); child.stderr!.on("data", append);
    child.once("error", error => { launchError = error; closed = true; });
    child.once("close", value => { code = value; closed = true; });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const pid = child.pid!;
    childGroup = pid;
    // Record identity before waiting, and stop the process if that authoritative write fails.
    const owned = await identity(pid);
    try { await persist({ child: owned }); } catch (error) { try { process.kill(-pid, "SIGKILL"); } catch {} throw error; }
    let stopAt = 0, sampled = 0, limitError = "";
    while (!closed || await groupExists(pid)) {
      if (accepted.holdout && Date.now() - sampled > 500) {
        const { stdout } = await exec("ps", ["-axo", "pgid=,stat=,rss="], { timeout: 3000, maxBuffer: 4 * 1024 ** 2 });
        let memory = 0; for (const line of stdout.split("\n")) { const [group, state, rss] = line.trim().split(/\s+/); if (Number(group) === pid && !state?.startsWith("Z")) { const n = Number(rss); if (!Number.isFinite(n)) throw new Error("Cannot measure holdout memory"); memory += n * 1024; } }
        if (memory > accepted.holdout.memoryMiB * 1024 ** 2) limitError = "Common holdout exceeded its memory limit";
        sampled = Date.now();
      }
      if (limitError || await stopRequested() || Date.now() >= stageDeadline || closed) {
        if (!stopAt) { stopAt = Date.now(); try { process.kill(-pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
        if (Date.now() - stopAt > 2000) { try { process.kill(-pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
        if (Date.now() - stopAt > 15000) throw new Error("Could not confirm process-group termination");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await logTail;
    if (limitError) throw new Error(limitError);
    if (await stopRequested()) throw new Error("Job cancelled or deadline exceeded");
    if (Date.now() >= stageDeadline) throw new Error("Reserved training time exceeded");
    if (launchError || code !== 0) throw launchError ?? new Error(`Recipe process exited with code ${code}; inspect the training log`);
    await persist({ child: undefined });
    childGroup = undefined;
  }
  try {
    const selected = recipe(accepted.recipe), script = recipePath(selected);
    if (accepted.kind === "setup") {
      const destination = dirname(dirname(managedPython(root, selected)));
      await exec(accepted.python!, ["-c", "import sys; assert sys.version_info[:2] == (3, 12), 'Use Python 3.12'"], { timeout: 10000, env: environment(root) });
      await run(accepted.python!, ["-m", "venv", destination]);
      await run(managedPython(root, selected), ["-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--require-hashes", "--only-binary=:all:", "-r", join(bundleDir, selected === LLM_RECIPE ? "llm_requirements.txt" : "requirements.txt")]);
      await run(managedPython(root, selected), [script, "probe"]);
      await persist({ state: "succeeded", endedAt: Date.now() });
    } else if (accepted.kind === "model") {
      await run(await pythonFor(root, accepted.python, selected), [script, "snapshot-model", dir, accepted.modelPath!, root]);
      await persist({ state: "succeeded", endedAt: Date.now(), model: modelSnapshot(await json(join(dir, "model.json"))) });
    } else if (accepted.kind === "holdout") {
      await persist({ state: "evaluating" });
      try { await run(await pythonFor(root, accepted.python, selected), [join(bundleDir, "holdout.py"), dir, root]); }
      catch (error) {
        const failure = await json<{ error?: string }>(join(dir, "holdout-error.json"), true);
        if (typeof failure?.error === "string" && failure.error.length > 0 && failure.error.length <= 1000 && !await stopRequested()) throw new Error(failure.error);
        throw error;
      }
      const result = holdoutResult(await json(join(dir, "holdout.json")), accepted.holdout, accepted.dataset);
      await persist({ state: "succeeded", endedAt: Date.now(), holdout: result });
    } else {
      const python = await pythonFor(root, accepted.python, selected), snapshot = join(root, "datasets", `${accepted.dataset!.hash}.${accepted.dataset!.format}`);
      if (await snapshotHash(snapshot) !== accepted.dataset!.hash) throw new Error("Dataset snapshot hash changed before execution");
      await run(python, [script, "prepare", dir, snapshot, ...(selected === LLM_RECIPE ? [root] : [])]);
      if (accepted.search?.fromJob) await copySelectedModel(root, accepted, dir);
      if (selected === LLM_RECIPE) await run(python, [script, "baseline", dir, root]);
      if (!accepted.search?.fromJob) {
        await persist({ state: "training" }); await run(python, [script, "train", dir, ...(selected === LLM_RECIPE ? [root] : [])], accepted.search ? accepted.spec!.trainSeconds : undefined);
      }
      await persist({ state: "evaluating" }); await run(python, [script, "evaluate", dir, ...(selected === LLM_RECIPE ? [root] : [])]);
      const evaluation = await json<Evaluation>(join(dir, "evaluation.json"));
      if (!Number.isFinite(evaluation.candidate) || !Number.isFinite(evaluation.baseline) || evaluation.datasetHash !== accepted.dataset!.hash) throw new Error("Invalid evaluation evidence");
      if (accepted.search && evaluation.partition !== accepted.search.partition) throw new Error("Recipe used the wrong evaluation partition");
      if (accepted.search?.fromJob) {
        const previous = await json<JobStatus>(join(jobDir(root, accepted.search.fromJob.id), "status.json"));
        if (evaluation.modelHash !== accepted.search.fromJob.modelHash || evaluation.splitHash !== previous.evaluation?.splitHash) throw new Error("Selected model or split changed during final evaluation");
      }
      if (accepted.search?.partition === "validation") { await persist({ state: "succeeded", endedAt: Date.now(), evaluation }); return; }
      await persist({ state: "exporting", evaluation }); await run(python, [script, "package", dir]);
      const artifact = await json<JobStatus["artifact"]>(join(dir, "artifact.json"));
      if (!artifact || await snapshotHash(join(dir, "model.tar.gz")) !== artifact.hash) throw new Error("Export checksum mismatch");
      await persist({ state: "succeeded", endedAt: Date.now(), artifact });
    }
  } catch (error) {
    const cancellation = !!await json(join(dir, "cancel.json"), true) || stopping;
    // A failed receipt/log write must not abandon a live Python process. The
    // supervisor owns this group even when persisting its identity failed.
    if (childGroup) {
      try { process.kill(-childGroup, "SIGKILL"); } catch {}
      for (let i = 0; i < 50 && await groupExists(childGroup).catch(() => true); i++) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const stillOwned = !!childGroup && await groupExists(childGroup).catch(() => true);
    if (!stillOwned && accepted.kind === "model") await rm(join(root, "models", accepted.id + ".partial"), { recursive: true, force: true }).catch(() => {});
    await persist({ state: stillOwned ? "unknown" : cancellation ? "cancelled" : "failed", endedAt: stillOwned ? undefined : Date.now(), error: Date.now() >= accepted.deadline ? "Job deadline exceeded" : (error as Error).message });
  } finally { await logTail; await log.sync(); await log.close(); }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === await realpath(executable)) {
  try {
    if (process.argv[2] === "run") await runner(workerRoot(process.argv[3]!), id(process.argv[4]));
    else if (process.argv[2] === "resident") {
      const root = workerRoot(process.argv[3]!);
      await residentSupervisor(root, bundleDir, (threads, gpu) => environment(root, threads, gpu));
    }
    else if (process.argv[2] === "infer") {
      const root = workerRoot(process.argv[3]!);
      process.stdout.on("error", () => {});
      try { process.stdout.write(JSON.stringify({ ok: true, result: await inferenceSupervisor(root, bundleDir, (threads, gpu) => environment(root, threads, gpu)) })); }
      catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: (error as Error).message, ...(error instanceof InferenceInputError ? { kind: "input" } : {}) })); }
    }
    else if (process.argv[2] === "control") {
      let body = ""; for await (const chunk of process.stdin) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Worker request too large"); }
      process.stdout.write(JSON.stringify({ ok: true, result: await control(process.argv[3]!, JSON.parse(body)) }));
    } else throw new Error("Use control or run");
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: (error as Error).message, ...(error instanceof InferenceInputError ? { kind: "input" } : {}) })); process.exitCode = 1; }
}
