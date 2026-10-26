import { test } from "node:test";
import assert from "node:assert/strict";
const saved = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", search: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) } });
const { waitForResultPreview, continuePreviewSetup, NO_PREVIEW_COMMAND } = await import("../ui/result-preview.js");
const { store } = await import("../ui/lib.js");
const app = { key: "run/solo", command: "node app.js", cwd: "/scratch", port: 54321, url: "http://localhost:54321", status: "running" as const, startedAt: 100, logs: ["starting"] }, base = "/api/runs/run/worktrees/solo/serve";
function respond(read: (url: string, method: string) => unknown) { globalThis.fetch = (async (url: string, options: RequestInit = {}) => new Response(JSON.stringify(read(url, options.method ?? "GET")), { status: 200 })) as typeof fetch; }
test("binding once then crashing is a startup failure with exit code and log tail", async () => {
  let count = 0; respond(url => url.endsWith("/ready") ? (++count === 1 ? { ready: true, status: "running" } : { ready: false, status: "exited" }) : { ...app, status: "exited", exitCode: 1, logs: ["FATAL startup"] });
  await assert.rejects(waitForResultPreview(base, app, { attempts: 8, interval: 1, stable: 20 }), /exit 1.*FATAL startup/);
});
test("readiness must remain stable before returning the fresh app state", async () => {
  let count = 0; respond(url => url.endsWith("/ready") ? (count++, { ready: true, status: "running" }) : { ...app, logs: ["healthy"] });
  assert.deepEqual((await waitForResultPreview(base, app, { attempts: 30, interval: 2, stable: 10 })).logs, ["healthy"]); assert.ok(count >= 2);
});
test("a wrong-port startup stops only that instance and explains PORT with its allocated port", async () => {
  const deleted: string[] = []; respond((url, method) => { if (method === "DELETE") { deleted.push(url); return { stopped: true }; } return url.endsWith("/ready") ? { ready: false, status: "running" } : app; });
  await assert.rejects(waitForResultPreview(base, app, { attempts: 2, interval: 1, stable: 10 }), /port 54321.*stopped.*\$PORT/); assert.deepEqual(deleted, [`${base}?startedAt=100`]);
});
test("a competing preview replacement is never stopped by the older startup timeout", async () => {
  let deleted = false; respond((url, method) => { if (method === "DELETE") deleted = true; return url.endsWith("/ready") ? { ready: false, status: "running" } : { ...app, startedAt: 200 }; });
  await assert.rejects(waitForResultPreview(base, app, { attempts: 1, interval: 1, stable: 10 }), /changed while starting/); assert.equal(deleted, false);
});
test("an agent setup reply without a command is remembered and not automatically repeated", async () => {
  const run = { id: "setup", status: "done", followUps: [{ id: "turn", at: 20, worktree: "solo", message: "request", status: "done" }] } as any, tree = { name: "solo" } as any; let calls = 0;
  store.set("preview-setup:setup:solo", JSON.stringify({ since: 10, message: "request" })); respond(url => { calls++; return url.endsWith("/config") ? null : run; });
  await assert.rejects(continuePreviewSetup(run, tree), { message: NO_PREVIEW_COMMAND }); const before = calls; await assert.rejects(continuePreviewSetup(run, tree), { message: NO_PREVIEW_COMMAND }); assert.equal(calls, before);
});

test("replacement instance identity stays unique within one clock tick", async () => {
  const { DevServers } = await import("../src/serve.js"), servers = new DevServers(), now = Date.now;
  Date.now = () => 12345;
  try { const one = await servers.start("qa", process.cwd(), "true"), two = await servers.start("qa", process.cwd(), "true"); assert.ok(two.startedAt > one.startedAt); }
  finally { Date.now = now; servers.stopAll(); }
});
