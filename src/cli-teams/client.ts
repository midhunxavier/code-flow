import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { CODEFLOW_HOME } from "../config.js";
import { CliTeamError } from "./model.js";
import { randomUUID } from "node:crypto";
import { ensureStore, OWNER_PROTOCOL_VERSION, type OwnerIdentity, type OwnerStartedBy, type OwnerLifetime } from "../store-identity.js";
import { RUNTIME_FILE, type RuntimeDescriptor } from "./transport.js";

export async function runtimeRequest(runtime: RuntimeDescriptor, path: string, body: unknown, token = runtime.bootstrap): Promise<any> {
  const response = await fetch(new URL(path, runtime.endpoint), { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  const value = await response.json() as any;
  if (!response.ok || !value.ok) throw new CliTeamError(value.error?.code ?? "runtime_unavailable", value.error?.message ?? "CLI runtime unavailable", value.error?.details);
  return value.data;
}
export type OwnerDescriptor = RuntimeDescriptor & Partial<OwnerIdentity>;
export async function readOwnerDescriptor(home = CODEFLOW_HOME): Promise<OwnerDescriptor | undefined> {
  try {
    const r = JSON.parse(await readFile(join(home, RUNTIME_FILE), "utf8"));
    if (r.version !== 1 || !Number.isInteger(r.pid) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(r.endpoint) || !/^[a-f0-9]{64}$/.test(r.bootstrap)) return;
    process.kill(r.pid, 0); return r;
  } catch { return; }
}
/** Enrich the existing transport record without changing fields used by older clients. */
export async function publishOwnerDescriptor(runtime: RuntimeDescriptor, options: { home?: string; origin: string; startedBy?: OwnerStartedBy; lifetime?: OwnerLifetime }): Promise<RuntimeDescriptor & OwnerIdentity> {
  const home = options.home ?? CODEFLOW_HOME, store = await ensureStore(home);
  const descriptor = { ...runtime, storeId: store.storeId, environment: store.environment, origin: new URL(options.origin).origin,
    protocol: OWNER_PROTOCOL_VERSION, startedBy: options.startedBy ?? ownerStartedBy(), lifetime: options.lifetime ?? ownerLifetime() };
  const file = join(home, RUNTIME_FILE), temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(descriptor) + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
  return descriptor;
}
export function ownerStartedBy(): OwnerStartedBy {
  const value = process.env.CODEFLOW_STARTED_BY;
  if (value === "desktop" || value === "cli" || value === "start" || value === "service") return value;
  return process.env.CODEFLOW_CLI_HEADLESS === "1" ? "cli" : "start";
}
export function ownerLifetime(): OwnerLifetime {
  return process.env.CODEFLOW_OWNER_LIFETIME === "service" || process.env.CODEFLOW_CLI_HEADLESS === "1" ? "service" : "attached";
}
async function startOwner() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const js = fileURLToPath(new URL("../server.js", import.meta.url));
  const args = existsSync(js) ? [js] : ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../server.ts", import.meta.url))];
  mkdirSync(resolve(CODEFLOW_HOME), { recursive: true });
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", cwd: resolve(CODEFLOW_HOME), env: { ...process.env, CODEFLOW_HOME: resolve(CODEFLOW_HOME), PORT: String(port), CODEFLOW_CLI_HEADLESS: "1", CODEFLOW_STARTED_BY: "cli", CODEFLOW_OWNER_LIFETIME: "service" } });
  child.unref();
  let spawnError: Error | undefined, runtime: RuntimeDescriptor | undefined; child.once("error", e => { spawnError = e; });
  for (let i = 0; i < 200 && !runtime; i++) { await new Promise(resolve => setTimeout(resolve, 100)); runtime = await readOwnerDescriptor(); if (spawnError) throw spawnError; }
  if (!runtime) throw new Error("Code Flow could not start or the running owner has no CLI bridge. Restart the owner with this version; for a source checkout run npm run build first.");
  return runtime;
}

/** The request never reached a backend, or one refused it before doing anything: safe to send again after reconnecting. */
function unsent(error: unknown) {
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  if (error instanceof TypeError && cause === "ECONNREFUSED") return true;
  return error instanceof CliTeamError && ((error.details as { reconnect?: boolean } | undefined)?.reconnect === true ||
    /handing over an idle backend|^Invalid CLI connection|^Connection expired/.test(error.message));
}
/** The backend went away (an update, a restart, a crash): the next request should find the current one. */
const gone = (error: unknown) => unsent(error) || error instanceof TypeError && /fetch failed/.test(error.message);

/**
 * Existing owner first; acquireLock in server.ts arbitrates simultaneous bootstrap.
 * The connection follows the backend: after an update hands over, or the computer slept past
 * the heartbeat, the next request reconnects to the current owner and is sent once more if the
 * first never reached one.
 */
export async function connectRuntime(projectRoot: string, start = true, kind: "mcp" | "terminal" = "terminal") {
  const attach = async (runtime: RuntimeDescriptor) => ({ runtime, ...await runtimeRequest(runtime, "/connect", { projectRoot, kind }) as { token: string; connectionId: string } });
  let runtime = await readOwnerDescriptor();
  if (!runtime && start) runtime = await startOwner();
  if (!runtime) throw new Error("No compatible Code Flow owner is running");
  let current = await attach(runtime), reconnecting: Promise<typeof current> | undefined, closed = false;
  const reconnect = (failed: typeof current) => reconnecting ??= (async () => {
    if (current !== failed) return current;
    // An updating owner's successor starts within seconds; wait for it rather than starting an older copy.
    // The same owner also answers here when only this connection expired (the computer slept).
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const found = await readOwnerDescriptor();
      if (found) try { return current = await attach(found); } catch (error) { if (!gone(error)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (start) return current = await attach(await startOwner());
    throw new CliTeamError("runtime_unavailable", "Code Flow is not running; start it again, then retry");
  })().finally(() => { reconnecting = undefined; });
  const send = async (request: (c: typeof current) => Promise<any>) => {
    const used = current;
    try { return await request(used); }
    catch (error) {
      if (closed || !gone(error)) throw error;
      const next = await reconnect(used);
      if (!unsent(error)) throw error;
      return await request(next);
    }
  };
  // The caller may be remote even when the shared owner has a local display.
  const remote = process.env.CODEFLOW_NO_BROWSER === "1" || !!process.env.SSH_CONNECTION || !!process.env.CODEFLOW_SSH_HOST;
  return {
    get runtime() { return current.runtime; },
    get token() { return current.token; },
    get connectionId() { return current.connectionId; },
    call: (name: string, args: unknown) => {
      const input = name === "codeflow_open_task" && remote && args && typeof args === "object" && !Array.isArray(args) ? { ...args, open: false } : args;
      return send(c => runtimeRequest(c.runtime, "/call", { name, arguments: input }, c.token));
    },
    /** Owner-level requests (previews, confirmations) that use the backend's bootstrap credential. */
    privileged: (path: string, body: unknown) => send(c => runtimeRequest(c.runtime, path, body)),
    heartbeat: () => send(c => runtimeRequest(c.runtime, "/heartbeat", {}, c.token)),
    close: () => { closed = true; return runtimeRequest(current.runtime, "/disconnect", {}, current.token).catch(() => undefined); },
  };
}
