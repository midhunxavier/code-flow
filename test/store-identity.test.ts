import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { ensureStore, readStore, detectStoreEnvironment, separateStore, OWNER_PROTOCOL_VERSION } from "../src/store-identity.js";
import { publishOwnerDescriptor, readOwnerDescriptor } from "../src/cli-teams/client.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "codeflow-identity-"));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
test("store is created once, survives restarts and concurrent launchers reuse its identity", async t => {
  const home = await fixture(t);
  assert.equal(await readStore(home), undefined);
  const stores = await Promise.all(Array.from({ length: 12 }, () => ensureStore(home)));
  const first = stores[0]!;
  assert.match(first.storeId, /^[a-f0-9-]{36}$/);
  assert.ok(first.name); assert.ok(Date.parse(first.createdAt)); assert.equal(first.port, 4317);
  for (const store of stores) assert.deepEqual(store, first);
  const file = join(home, "store.json"), bytes = await readFile(file, "utf8");
  assert.deepEqual(await ensureStore(home), first);
  assert.equal(await readFile(file, "utf8"), bytes);
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const {ensureStore}=await import('./src/store-identity.ts');console.log(JSON.stringify(await ensureStore()))"], { env: { ...process.env, CODEFLOW_HOME: home } });
  assert.deepEqual(JSON.parse(stdout), first);
});
test("invalid store records are reported without replacing identity", async t => {
  const home = await fixture(t), file = join(home, "store.json");
  await writeFile(file, '{"storeId":"keep-me"}');
  await assert.rejects(ensureStore(home), /Invalid store identity/);
  assert.equal(await readFile(file, "utf8"), '{"storeId":"keep-me"}');
});
test("environment detection distinguishes native, WSL, Docker and remote stores", () => {
  const base = { env: {}, docker: false, kernel: "Linux", host: "test-host" };
  assert.equal(detectStoreEnvironment({ ...base, platform: "darwin" }), "native-macos");
  assert.equal(detectStoreEnvironment({ ...base, platform: "linux" }), "native-linux");
  assert.equal(detectStoreEnvironment({ ...base, platform: "win32" }), "native-windows");
  assert.equal(detectStoreEnvironment({ ...base, env: { WSL_DISTRO_NAME: "Ubuntu" } }), "wsl:Ubuntu");
  assert.equal(detectStoreEnvironment({ ...base, docker: true }), "docker:test-host");
  assert.equal(detectStoreEnvironment({ ...base, env: { SSH_CONNECTION: "remote" } }), "remote:test-host");
  assert.equal(detectStoreEnvironment({ ...base, env: { CODEFLOW_STORE_ENVIRONMENT: "docker:install/workspace" } }), "docker:install/workspace");
  assert.ok(separateStore("wsl:Ubuntu")); assert.ok(separateStore("docker:abc")); assert.equal(separateStore("native-linux"), false);
});
test("owner descriptor enrichment preserves legacy reader fields and reads older descriptors", async t => {
  const home = await fixture(t), file = join(home, "cli-teams-runtime.json");
  const legacy = { version: 1 as const, pid: process.pid, endpoint: "http://127.0.0.1:12345", bootstrap: "a".repeat(64), releaseRoot: "/release" };
  await writeFile(file, JSON.stringify(legacy));
  assert.deepEqual(await readOwnerDescriptor(home), legacy);
  const published = await publishOwnerDescriptor(legacy, { home, origin: "http://localhost:4317/", startedBy: "desktop", lifetime: "attached" });
  assert.equal(published.storeId, (await readStore(home))!.storeId);
  assert.equal(published.protocol, OWNER_PROTOCOL_VERSION); assert.equal(published.origin, "http://localhost:4317");
  assert.equal(published.startedBy, "desktop"); assert.equal(published.lifetime, "attached");
  for (const key of Object.keys(legacy) as (keyof typeof legacy)[]) assert.equal(published[key], legacy[key]);
  assert.deepEqual(await readOwnerDescriptor(home), published);
  await writeFile(file, JSON.stringify({ ...legacy, endpoint: "http://example.com:12345" }));
  assert.equal(await readOwnerDescriptor(home), undefined);
});
test("codeflow status reports identity without starting an owner or requiring a repository", async t => {
  const home = await fixture(t);
  const run = (args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `const {launchCli}=await import('./src/cli-teams/cli.ts');await launchCli(${JSON.stringify(args)})`], { env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_STORE_ENVIRONMENT: "wsl:Test" } });
  const first = JSON.parse((await run(["status", "--json"])).stdout);
  assert.equal(first.path, home); assert.equal(first.store.environment, "wsl:Test"); assert.equal(first.owner, null);
  await publishOwnerDescriptor({ version: 1, pid: process.pid, endpoint: "http://127.0.0.1:12345", bootstrap: "b".repeat(64) }, { home, origin: "http://localhost:4317", startedBy: "cli", lifetime: "service" });
  const { stdout } = await run(["status"]);
  for (const value of [home, "wsl:Test", "separate store", String(process.pid), "http://localhost:4317", "Started by: cli"]) assert.ok(stdout.includes(value), value);
});

test("authenticated store API and published owner descriptor identify the same running store", { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "codeflow-identity-api-"));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const token = "store-identity-test-token";
  const child = fork("src/server.ts", [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), HOST: "127.0.0.1", CODEFLOW_LAUNCHER: "1", CODEFLOW_STARTED_BY: "desktop", CODEFLOW_OWNER_LIFETIME: "attached", CODEFLOW_NO_BROWSER: "1", PATH: `${join(process.cwd(), "test/fake-bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` } });
  let diagnostics = "";
  child.stdout?.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  child.stderr?.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref();
      await exited; clearTimeout(timer);
    }
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owner did not start: ${diagnostics}`)), 30000);
    child.on("message", message => { if ((message as { type?: string }).type === "codeflow-ready") { clearTimeout(timer); resolve(); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Owner exited: ${diagnostics}`)); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const origin = `http://localhost:${port}`;
  assert.equal((await fetch(`${origin}/api/store`)).status, 401);
  const response = await fetch(`${origin}/api/store`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const identity = await response.json() as any, descriptor = await readOwnerDescriptor(home);
  assert.deepEqual(identity.store, await readStore(home));
  assert.equal(identity.store.storeId, descriptor?.storeId);
  assert.equal(identity.owner.origin, origin); assert.equal(descriptor?.origin, origin);
  assert.equal(identity.owner.startedBy, "desktop"); assert.equal(identity.owner.pid, child.pid);
  assert.equal(identity.owner.protocol, OWNER_PROTOCOL_VERSION);
  assert.equal(identity.owner.bootstrap, undefined); assert.equal(identity.owner.token, undefined);
});
