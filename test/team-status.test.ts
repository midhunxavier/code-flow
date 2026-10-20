import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AddressInfo } from "node:net";
import { createServer as httpServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
test("status probes the existing server without starting it, reports HTTPS honestly and strips secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "cf-status-"));
  const root = join(home, ".codeflow/team-server");
  const token = "a".repeat(64), instance = "b".repeat(32);
  let remote: object = { enabled: false, lan: false }, identity = instance;
  const server = httpServer((req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/team-host-runtime" ? { instance: identity } : remote));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const probe = async () => {
    const { stdout } = await execute(process.execPath, [fileURLToPath(new URL("../src/ssh-projects/team-status.mjs", import.meta.url))], { env: { ...process.env, HOME: home } });
    assert.ok(!stdout.includes(token)); assert.ok(!stdout.includes("private-link"));
    return JSON.parse(stdout.trim().slice(21));
  };
  try {
    assert.deepEqual(await probe(), { state: "not-installed" }); await assert.rejects(access(root));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "runtime.json"), JSON.stringify({ protocol: 1, port: (server.address() as AddressInfo).port, token, instance }));
    assert.equal((await probe()).access, "disabled");
    remote = { enabled: true, lan: true, secure: true, transport: "tailscale", tailscaleUrl: "https://team.example:4318/r/private-link?token=secret" };
    assert.deepEqual(await probe(), { state: "running", access: "ready", address: "https://team.example:4318", network: "Tailscale" });
    remote = { ...remote, lanError: "certificate invalid" }; assert.equal((await probe()).access, "error"); assert.equal((await probe()).address, undefined);
    remote = { enabled: true, lan: true, secure: false, lanUrls: ["http://team.example:4318/r/private-link"] };
    assert.equal((await probe()).access, "incomplete"); assert.equal((await probe()).address, undefined);
    identity = "wrong"; assert.deepEqual(await probe(), { state: "unavailable" });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});
