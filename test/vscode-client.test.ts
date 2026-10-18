import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CodeFlowClient, serverOrigin, localContextPath } = require("../integrations/vscode/client.cjs");

test("editor integration refuses remote/plain credentials URLs and unsafe context filenames", () => {
  assert.equal(serverOrigin("http://localhost:4317/"), "http://localhost:4317");
  for (const url of ["http://example.com", "https://example.com", "http://user:password@localhost:4317", "http://localhost:4317/?token=secret", "file:///tmp", "http://localhost:4317/other"]) assert.throws(() => serverOrigin(url));
  assert.equal(localContextPath("/repo", "/repo/src/main.ts"), "src/main.ts");
  for (const file of ["/elsewhere/file.ts", "/repo/.env", "/repo/.env.local", "/repo/key.pem", "/repo/.git/config"]) assert.equal(localContextPath("/repo", file), undefined);
});
test("editor start uses authenticated versioned API, selected saved paths and Safe execution", async () => {
  const calls: { url: string; options: any }[] = [];
  const client = new CodeFlowClient("http://localhost:4317", "editor-secret", async (url: string, options: any) => {
    calls.push({ url, options });
    return Response.json(url.endsWith("capabilities") ? { version: 1 } : url.includes("/check?") ? { command: "npm test" } : { id: "new-run" });
  });
  assert.equal((await client.start("/repo", "Fix this", ["src/main.ts"])).id, "new-run");
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.options.headers.authorization, "Bearer editor-secret"); assert.equal(call.options.redirect, "error"); assert.ok(call.options.signal instanceof AbortSignal); }
  const saved = JSON.parse(calls[2]!.options.body);
  assert.equal(saved.trust, "safe"); assert.deepEqual(saved.loop.copy, []); assert.equal(saved.loop.check, "npm test");
  assert.deepEqual(saved.context.paths, [{ path: "src/main.ts" }]); assert.deepEqual(saved.roles, { agent: ["auto"] });
});
test("editor API refuses compatibility mismatch, oversized responses and automatic redirects", async () => {
  await assert.rejects(new CodeFlowClient("http://localhost", "token", async () => Response.json({ version: 2 })).compatibility(), /unsupported/);
  const tooBig = new CodeFlowClient("http://localhost", "token", async () => new Response("x".repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(tooBig.request("/api/v1/capabilities"), /too much/);
  await assert.rejects(new CodeFlowClient("http://localhost", "token", async () => Response.json({ error: "no" }, { status: 401 })).request("/api/v1/runs"), /Reconnect/);
});
