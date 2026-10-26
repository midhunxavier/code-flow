import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpConnection } from "../src/adapters/acp-types.js";
const home = mkdtempSync(join(tmpdir(), "cf-acp-connections-"));
process.env.CODEFLOW_HOME = home;
const { AcpConnections, validateAcpConnection, acpBindings, assertAcpBindings } = await import("../src/acp-connections.js");
const { replaceAcpAdapters, isAgentId, agentCatalog } = await import("../src/adapters/index.js");
const { createAcpAdapter } = await import("../src/adapters/acp.js");
const fixture = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
const connection: AcpConnection = { id: "acp:opencode", name: "OpenCode fixture", command: process.execPath, args: [fixture, "write"], enabled: true };
const publish = (connections: AcpConnection[]) => replaceAcpAdapters(connections.map(createAcpAdapter));
after(() => { replaceAcpAdapters([]); rmSync(home, { recursive: true, force: true }); });

test("ACP settings persist, register immediately, reject stale writes, invalidate models, and pin command changes", async () => {
  const store = new AcpConnections(publish, home); await store.load();
  assert.equal(store.snapshot().revision, 0);
  await store.save(0, connection); assert.equal(isAgentId(connection.id), true);
  assert.equal(statSync(join(home, "acp-connections.json")).mode & 0o777, 0o600);
  const catalog = await agentCatalog(connection.id); assert.equal(catalog.models.length, 2);
  const run = { roles: { agent: [connection.id] }, acpConnections: acpBindings({ agent: [connection.id] }) };
  assert.doesNotThrow(() => assertAcpBindings(run));
  await assert.rejects(store.save(0, { ...connection, name: "stale" }), /another window/);
  const loaded = new AcpConnections(publish, home); await loaded.load(); assert.equal(loaded.snapshot().connections[0]?.command, process.execPath);
  await loaded.save(1, { ...connection, args: [fixture, "legacy"] });
  assert.equal((await agentCatalog(connection.id)).models.length, 1, "catalog cache refreshed");
  assert.throws(() => assertAcpBindings(run), /arguments changed/);
  await loaded.save(2, { ...connection, enabled: false }); assert.equal(isAgentId(connection.id), false);
  assert.throws(() => assertAcpBindings(run), /disabled or missing/);
  await loaded.remove(3, connection.id); assert.equal(loaded.snapshot().connections.length, 0);
});
test("invalid invocations and malformed storage cannot become active or overwrite saved configuration", async () => {
  for (const patch of [{ id: "claude" }, { id: "acp:../escape" }, { name: " " }, { command: "opencode acp" }, { command: "./repo-controlled" }, { args: "acp" }, { args: ["bad\narg"] }, { env: { SECRET: "value" } }]) assert.throws(() => validateAcpConnection({ ...connection, ...patch }));
  assert.equal(validateAcpConnection({ ...connection, command: "/Applications/My Agent/agent", args: ["path with spaces"] }).args[0], "path with spaces");
  const corruptHome = mkdtempSync(join(home, "corrupt-")); writeFileSync(join(corruptHome, "acp-connections.json"), "broken");
  const broken = new AcpConnections(() => { throw new Error("Must not register"); }, corruptHome);
  await assert.rejects(broken.load()); await assert.rejects(broken.save(0, connection), /Repair/);
  assert.equal(readFileSync(join(corruptHome, "acp-connections.json"), "utf8"), "broken");
});
test("new engine runs reject ACP when managed delegation cannot be enforced", async () => {
  const store = new AcpConnections(publish, home); await store.load(); await store.save(store.snapshot().revision, connection);
  const repo = mkdtempSync(join(home, "repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: repo });
  const { RunManager } = await import("../src/engine.js"), { findPattern } = await import("../src/patterns/index.js");
  const manager = new RunManager(findPattern), input = { pattern: findPattern("solo")!, repo, task: "Create the fixture result", roles: { agent: [connection.id] }, options: {}, trust: "full" as const };
  try {
    await assert.rejects(manager.start({ ...input, trust: "standard" }), /native-delegation restriction/);
    await assert.rejects(manager.start(input), /native-delegation restriction/);
    assert.equal(manager.list().length, 0, "provider rejection happens before creating a run");
  } finally { await manager.shutdown(); }
});
