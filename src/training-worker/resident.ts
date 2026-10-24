import { spawn } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { chmod, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { id, integer, type ProcessIdentity } from "../ml/model.js";
import { inferenceInput, inferenceResult, release, type ServingRelease, type ResidentStatus } from "../ml/deployment-model.js";
import { alive, atomic, canonical, exec, identity, json } from "./files.js";

interface ResidentRecord { sessionId: string; deploymentId: string; revision: number; release: ServingRelease; owner: ProcessIdentity; child?: ProcessIdentity; startedAt: number; reason?: string }
const recordPath = (root: string) => join(root, "serving/resident.json");
const socketPath = (sessionId: string) => `/tmp/codeflow-serving-${id(sessionId)}.sock`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function record(root: string) { const r = await json<ResidentRecord | undefined>(recordPath(root), true); if (r) { id(r.sessionId); id(r.deploymentId); release(r.release); integer(r.revision, 1, Number.MAX_SAFE_INTEGER, "Serving revision"); } return r; }
async function groupMemory(group: number) {
  const { stdout } = await exec("ps", ["-axo", "pgid=,stat=,rss="], { timeout: 3000, maxBuffer: 4 * 1024 ** 2 });
  let exists = false, bytes = 0;
  for (const line of stdout.split("\n")) { const [pgid, state, rss] = line.trim().split(/\s+/); if (Number(pgid) === group && !state?.startsWith("Z")) { exists = true; const n = Number(rss); if (!Number.isFinite(n)) throw new Error("Cannot measure serving memory"); bytes += n * 1024; } }
  return { exists, bytes };
}
async function orphaned(r: ResidentRecord) { return !!r.child && (await identity())?.boot === r.child.boot && (await groupMemory(r.child.pid)).exists; }
async function reap(r: ResidentRecord) {
  if (!r.child || (await identity())?.boot !== r.child.boot) return;
  const current = await identity(r.child.pid);
  if (current && canonical(current) !== canonical(r.child)) throw new Error("Serving process identity changed; inspect this worker before reusing compute");
  const started = Date.now();
  while ((await groupMemory(r.child.pid)).exists) {
    try { process.kill(-r.child.pid, Date.now() - started > 1000 ? "SIGKILL" : "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    if (Date.now() - started > 10000) throw new Error("Serving process cleanup is unconfirmed");
    await pause(100);
  }
}
async function rpc<T = any>(r: ResidentRecord, request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath(r.sessionId)); let body = "", finished = false;
    const timer = setTimeout(() => finish(new Error("Resident worker response timed out")), 4000);
    function finish(error?: Error) { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); if (error) { reject(error); return; } try { const response = JSON.parse(body); if (!response.ok) throw new Error(response.error); resolve(response.result); } catch (e) { reject(e); } }
    socket.setEncoding("utf8"); socket.on("error", finish); socket.on("connect", () => socket.end(JSON.stringify({ sessionId: r.sessionId, ...request }) + "\n"));
    socket.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 350000) finish(new Error("Resident response exceeds its limit")); });
    socket.on("end", () => finish());
  });
}
export async function residentStatus(root: string): Promise<ResidentStatus> {
  let r = await record(root); if (!r) return { state: "unloaded" };
  if (await alive(r.owner)) {
    try { return { ...await rpc<ResidentStatus>(r, { action: "status" }), sessionId: r.sessionId, revision: r.revision, deploymentId: r.deploymentId, releaseId: r.release.id }; }
    catch (error) { if (await alive(r.owner)) throw error; }
  }
  // Socket teardown and the final receipt precede supervisor exit. Only after
  // confirming exit may we use that receipt; a live but unreachable owner still
  // reserves compute. Check the fresh child identity before reporting unloaded.
  const latest = await record(root);
  if (!latest || latest.sessionId !== r.sessionId || canonical(latest.owner) !== canonical(r.owner)) throw new Error("Resident generation changed during inspection; check its status again");
  r = latest;
  if (await orphaned(r)) throw new Error("An orphaned serving process still reserves this worker; stop its deployment to recover");
  return { state: "unloaded", sessionId: r.sessionId, revision: r.revision, deploymentId: r.deploymentId, releaseId: r.release.id, ...(r.reason ? { reason: r.reason } : {}) };
}
export async function assertNoResident(root: string) {
  const r = await record(root);
  if (r && (await alive(r.owner) || await orphaned(r))) throw new Error("Persistent serving reserves this worker; stop the deployment before training or on-demand inference");
}
async function stopRecord(r: ResidentRecord) {
  if (await alive(r.owner)) {
    await rpc(r, { action: "stop" }).catch(async () => { if (await alive(r.owner)) process.kill(r.owner.pid, "SIGTERM"); });
    const deadline = Date.now() + 15000;
    while (await alive(r.owner)) { if (Date.now() > deadline) throw new Error("Resident supervisor has not confirmed cleanup"); await pause(100); }
  }
  await reap(r); await rm(socketPath(r.sessionId), { force: true });
}
async function stops(root: string) { return await json<Record<string, number>>(join(root, "serving/stops.json"), true) ?? {}; }
export async function residentStop(root: string, deploymentId: unknown, revision: unknown) {
  const owner = id(deploymentId), fence = integer(revision, 1, Number.MAX_SAFE_INTEGER, "Deployment revision"), saved = await stops(root);
  if (!Object.hasOwn(saved, owner) && Object.keys(saved).length >= 200) throw new Error("Serving stop history is full; archive this worker before new deployments");
  saved[owner] = Math.max(saved[owner] ?? 0, fence); await atomic(join(root, "serving/stops.json"), saved);
  const r = await record(root);
  // A delayed stop from an earlier revision must not shut down a resumed model.
  if (r?.deploymentId === owner && r.revision <= fence) await stopRecord(r);
  return { stopped: !r || r.deploymentId !== owner || r.revision <= fence };
}
/** Discard one uncommitted preparation without fencing a future retry of its revision. */
export async function residentDiscard(root: string, deploymentId: unknown, revision: unknown, expectedSession: unknown) {
  const owner = id(deploymentId), rev = integer(revision, 1, Number.MAX_SAFE_INTEGER, "Prepared revision"), session = id(expectedSession), r = await record(root);
  if (r?.sessionId === session && r.deploymentId === owner && r.revision === rev) await stopRecord(r);
  return { stopped: true };
}
export async function residentPrepare(root: string, executable: string, requested: unknown, python: string, deploymentId: unknown, revision: unknown, expectedSession: unknown) {
  const r = release(requested), owner = id(deploymentId), rev = integer(revision, 1, Number.MAX_SAFE_INTEGER, "Deployment revision");
  if (r.config.mode !== "persistent" || r.bundle !== basename(join(executable, ".."))) throw new Error("Invalid persistent serving release");
  const fences = await stops(root);
  if (!Object.hasOwn(fences, owner)) { if (Object.keys(fences).length >= 200) throw new Error("Serving stop history is full; archive this worker before new deployments"); fences[owner] = 0; await atomic(join(root, "serving/stops.json"), fences); }
  if (fences[owner]! >= rev) throw new Error("This serving revision was stopped; refresh the deployment");
  const prior = await record(root);
  if ((prior?.sessionId ?? null) !== expectedSession) throw new Error("Resident generation changed during preparation; retry after checking its status");
  if (prior && await alive(prior.owner)) {
    const status = await rpc<ResidentStatus>(prior, { action: "status" });
    if (prior.deploymentId !== owner) throw new Error("Another persistent deployment reserves this worker");
    if (status.state === "busy") throw new Error("Wait for the active inference request before switching models");
    if (status.state === "ready" && prior.release.id === r.id && prior.revision === rev) return residentStatus(root);
    await stopRecord(prior);
  } else if (prior && await orphaned(prior)) throw new Error("An orphaned serving process requires a confirmed stop before loading another model");
  const child = spawn(process.execPath, [executable, "resident", root], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  child.stdin!.on("error", () => {});
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const processIdentity = await identity(child.pid!); if (!processIdentity) { child.kill(); throw new Error("Cannot identify resident supervisor"); }
  const receipt: ResidentRecord = { sessionId: randomUUID(), deploymentId: owner, revision: rev, release: r, owner: processIdentity, startedAt: Date.now() };
  try { await atomic(recordPath(root), receipt); child.stdin!.end(JSON.stringify({ ...receipt, python })); child.unref();
    const deadline = Date.now() + r.config.timeoutSeconds * 1000 + 7000;
    while (Date.now() < deadline) {
      const latest = await residentStatus(root).catch(async () => {
        // It may exit between residentStatus's last probe and this one. Resolve
        // the final receipt instead of surfacing an obsolete socket error.
        if (!await alive(processIdentity)) return residentStatus(root);
        return { state: "loading" } as ResidentStatus;
      });
      if (latest.state === "ready") return latest;
      if (latest.state === "unloaded") throw new Error(latest.reason || "Persistent model failed to load");
      await pause(150);
    }
    throw new Error("Persistent model loading exceeded its timeout");
  } catch (error) {
    child.stdin!.destroy();
    const latest = await record(root);
    await stopRecord(latest?.sessionId === receipt.sessionId ? latest : receipt).catch(() => {});
    throw error;
  }
}
export async function residentRequest(root: string, action: string, values: Record<string, any>) {
  const r = await record(root); if (!r || !await alive(r.owner)) { const status = await residentStatus(root); throw new Error(status.reason || "Persistent model is unloaded; warm it before inference"); }
  if (r.deploymentId !== id(values.deploymentId)) throw new Error("Resident deployment identity differs");
  if (action === "resident-start") {
    if (values.revision !== r.revision || values.expectedSession !== r.sessionId) throw new Error("Resident request revision or session changed; admit a new request");
    const selected = release(values.release);
    if (canonical(selected) !== canonical(r.release) || (await stops(root))[r.deploymentId]! >= r.revision) throw new Error("Resident version differs from the admitted request");
    if (values.stream !== undefined && typeof values.stream !== "boolean") throw new Error("Invalid stream mode");
    return rpc(r, { action: "start", requestId: id(values.requestId), input: inferenceInput(values.input, r.release), stream: values.stream === true });
  }
  const result = await rpc(r, { action: action === "resident-poll" ? "poll" : "cancel", requestId: id(values.requestId), ...(action === "resident-poll" ? { cursor: integer(values.cursor, 0, 2048, "Stream cursor") } : {}) });
  // A cancelled request must finish releasing its session before a new warm can race its socket teardown.
  if (action === "resident-cancel" && result.releasing) await stopRecord(r);
  return result;
}

/** Private local IPC on either computer; no public listening port or persisted prompts. */
export async function residentSupervisor(root: string, bundleDirectory: string, environment: (threads: number, gpu: string) => NodeJS.ProcessEnv) {
  let stopping = false, reason = "Serving stopped", ready = false, closed = false, memoryBytes = 0, lastUse = Date.now(), sampled = 0;
  process.on("SIGTERM", () => { stopping = true; }); process.on("SIGINT", () => { stopping = true; });
  const timer = setTimeout(() => process.exit(1), 10000); let body = "";
  for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Resident startup request too large"); } clearTimeout(timer);
  const payload = JSON.parse(body) as ResidentRecord & { python: string }, r = release(payload.release), cfg = r.config;
  if (r.bundle !== basename(bundleDirectory) || cfg.mode !== "persistent" || payload.owner.pid !== process.pid || (await record(root))?.sessionId !== payload.sessionId) throw new Error("Resident startup authority changed");
  const expiresAt = payload.startedAt + cfg.lifetimeSeconds! * 1000;
  type Event = { type: "delta"; text: string } | { type: "done"; result: any } | { type: "error"; error: string; kind?: "input" };
  let active: { id: string; input: ReturnType<typeof inferenceInput>; stream: boolean; events: Event[]; bytes: number; done: boolean; deadline: number; lastPoll: number } | undefined;
  const connections = new Set<Socket>();
  const child = spawn(payload.python, [join(bundleDirectory, "inference.py"), "serve"], { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"], env: environment(cfg.cpus, cfg.gpu ?? "") });
  child.stdin.on("error", () => {}); child.stderr.on("data", () => {});
  child.once("error", () => { closed = true; reason = "Serving Python environment is unavailable"; stopping = true; }); child.once("close", () => { closed = true; if (!stopping) reason = "Serving Python process exited"; stopping = true; });
  const decoder = new StringDecoder("utf8"); let buffer = "";
  function fail(message: string) { reason = message; stopping = true; }
  function event(value: Event) {
    if (!active || active.done) { fail("Serving protocol emitted an unexpected response"); return; }
    active.bytes += Buffer.byteLength(JSON.stringify(value));
    if (active.bytes > 256000 || active.events.length >= 1024) { fail("Serving response exceeded its output limit"); return; }
    active.events.push(value); if (value.type !== "delta") { active.done = true; lastUse = Date.now(); }
  }
  child.stdout.on("data", chunk => {
    buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > 300000) { fail("Serving output exceeded its limit"); return; }
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (!ready) { if (value.type !== "ready") throw new Error(typeof value.error === "string" ? value.error.slice(0, 1000) : "Model did not become ready"); ready = true; lastUse = Date.now(); continue; }
        if (value.type === "done") event({ type: "done", result: inferenceResult(value.result, r, active?.input) });
        else if (value.type === "delta" && active?.stream && typeof value.text === "string") { for (let i = 0; i < value.text.length; i += 4096) event({ type: "delta", text: value.text.slice(i, i + 4096) }); }
        else if (value.type === "error" && typeof value.error === "string") event({ type: "error", error: value.error.slice(0, 1000), ...(value.kind === "input" ? { kind: "input" as const } : {}) });
        else throw new Error("Invalid resident response");
      } catch (error) { fail((error as Error).message); }
    }
  });
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket); socket.on("close", () => connections.delete(socket)); socket.on("error", () => {}); socket.setTimeout(5000, () => socket.destroy()); socket.setEncoding("utf8"); let input = "";
    socket.on("data", chunk => { input += chunk; if (Buffer.byteLength(input) > 128000) socket.destroy(); });
    socket.on("end", () => {
      try {
        const v = JSON.parse(input); if (v.sessionId !== payload.sessionId) throw new Error("Resident session changed");
        let result: unknown;
        if (v.action === "status") result = { state: stopping ? "stopped" : !ready ? "loading" : active && !active.done ? "busy" : "ready", pid: child.pid, startedAt: payload.startedAt, expiresAt, memoryBytes };
        else if (v.action === "stop") { stopping = true; result = { stopped: true }; }
        else if (v.action === "start") {
          if (stopping || !ready || active && !active.done) throw new Error("Resident model is not ready or is busy");
          const checked = inferenceInput(v.input, r); id(v.requestId);
          active = { id: v.requestId, input: checked, stream: v.stream === true, events: [], bytes: 0, done: false, deadline: Date.now() + cfg.timeoutSeconds * 1000, lastPoll: Date.now() };
          child.stdin.write(JSON.stringify({ input: checked, stream: active.stream }) + "\n"); result = { requestId: active.id, sessionId: payload.sessionId };
        } else if (v.action === "cancel") { const releasing = !!active && active.id === v.requestId && !active.done; if (releasing) fail("Inference cancelled; resident model released"); result = { cancelled: true, releasing }; }
        else if (v.action === "poll") {
          if (!active || active.id !== v.requestId) throw new Error("Inference request is no longer retained");
          const cursor = integer(v.cursor, 0, active.events.length, "Stream cursor"); active.lastPoll = Date.now();
          const events = active.events.slice(cursor, cursor + 32); result = { events, cursor: cursor + events.length, done: active.done && cursor + events.length === active.events.length };
        } else throw new Error("Unknown resident action");
        socket.end(JSON.stringify({ ok: true, result }));
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: (error as Error).message })); }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    payload.child = await identity(child.pid!); if (!payload.child) throw new Error("Cannot identify serving Python process");
    await atomic(recordPath(root), { ...payload, python: undefined });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath(payload.sessionId), resolve); }); await chmod(socketPath(payload.sessionId), 0o600);
    child.stdin.write(JSON.stringify({ root, release: r, mode: "prepare" }) + "\n");
    while (!stopping) {
      const now = Date.now();
      if (!ready && now > payload.startedAt + cfg.timeoutSeconds * 1000) fail("Persistent model loading exceeded its timeout");
      if (now >= expiresAt) fail("Persistent serving reached its maximum lifetime");
      if (ready && (!active || active.done) && now - lastUse >= cfg.idleSeconds! * 1000) fail("Persistent serving reached its idle timeout");
      if (active && !active.done && now >= active.deadline) fail("Inference exceeded its request timeout; resident model released");
      if (active && !active.done && now - active.lastPoll > 15000) fail("Inference client disconnected; resident model released");
      if (now - sampled >= 500) { memoryBytes = (await groupMemory(child.pid!)).bytes; sampled = Date.now(); if (memoryBytes > cfg.memoryMiB! * 1024 ** 2) fail("Serving exceeded its memory limit; resident model released"); }
      await pause(100);
    }
  } catch (error) { reason = (error as Error).message; }
  finally {
    stopping = true; child.stdin.destroy();
    // Retain the supervisor's reservation until all owned descendants are gone.
    while (!closed || await groupMemory(child.pid!).then(x => x.exists, () => true)) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {} await pause(100);
    }
    for (const socket of connections) socket.destroy(); server.close(); await rm(socketPath(payload.sessionId), { force: true });
    if ((await record(root))?.sessionId === payload.sessionId) await atomic(recordPath(root), { ...payload, python: undefined, reason: reason.slice(0, 1000) });
  }
}
