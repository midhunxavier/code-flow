import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { CODEFLOW_HOME } from "../config.js";
import { CliTeamError } from "./model.js";
import { RUNTIME_FILE, type RuntimeDescriptor } from "./transport.js";

export async function runtimeRequest(runtime: RuntimeDescriptor, path: string, body: unknown, token = runtime.bootstrap): Promise<any> {
  const response = await fetch(new URL(path, runtime.endpoint), { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  const value = await response.json() as any;
  if (!response.ok || !value.ok) throw new CliTeamError(value.error?.code ?? "runtime_unavailable", value.error?.message ?? "CLI runtime unavailable", value.error?.details);
  return value.data;
}
async function descriptor(): Promise<RuntimeDescriptor | undefined> {
  try {
    const r = JSON.parse(await readFile(join(CODEFLOW_HOME, RUNTIME_FILE), "utf8"));
    if (r.version !== 1 || !Number.isInteger(r.pid) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(r.endpoint) || !/^[a-f0-9]{64}$/.test(r.bootstrap)) return;
    process.kill(r.pid, 0); return r;
  } catch { return; }
}
/** Existing owner first; acquireLock in server.ts arbitrates simultaneous bootstrap. */
export async function connectRuntime(projectRoot: string, start = true) {
  let runtime = await descriptor();
  if (!runtime && start) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const js = fileURLToPath(new URL("../server.js", import.meta.url));
    const args = existsSync(js) ? [js] : ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../server.ts", import.meta.url))];
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", cwd: projectRoot, env: { ...process.env, CODEFLOW_HOME: resolve(CODEFLOW_HOME), PORT: String(port), CODEFLOW_CLI_HEADLESS: "1" } });
    child.unref();
    let spawnError: Error | undefined; child.once("error", e => { spawnError = e; });
    for (let i = 0; i < 200 && !runtime; i++) { await new Promise(resolve => setTimeout(resolve, 100)); runtime = await descriptor(); if (spawnError) throw spawnError; }
    if (!runtime) throw new Error("Code Flow could not start or the running owner has no CLI bridge. Restart the owner with this version; for a source checkout run npm run build first.");
  }
  if (!runtime) throw new Error("No compatible Code Flow owner is running");
  const connection = await runtimeRequest(runtime, "/connect", { projectRoot });
  return { runtime, ...connection, call: (name: string, args: unknown) => runtimeRequest(runtime!, "/call", { name, arguments: args }, connection.token), close: () => runtimeRequest(runtime!, "/disconnect", {}, connection.token).catch(() => undefined) };
}
