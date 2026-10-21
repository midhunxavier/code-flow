import { remoteWorkerFixture, git } from "./remote-worker-fixture.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RemoteWorkers, SSH_OPTIONS } from "../src/remote-workers/client.js";
import { loadWorkerConfig, ProvisionedWorker } from "../src/remote-workers/worker.js";
import { assertTransferTree, contextManifest, disabledCheckoutFilters, gitChecked, importWorkerArtifact } from "../src/remote-workers/bundles.js";
import { validateWorkerRequest } from "../src/remote-workers/protocol.js";

const root = mkdtempSync(join(tmpdir(), "codeflow-workers-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fixture = () => remoteWorkerFixture(root);

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const deadline = Date.now() + 12_000; while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((r) => setTimeout(r, 100)); } }

test("registered SSH transport executes in a separate provisioned worker and imports a pinned bounded bundle", async () => {
  const f = await fixture(); process.env.HOST_PRIVATE_SECRET = "never-forward-this-host-value"; process.env.CODEFLOW_TOKEN = "never-forward-this-app-value";
  try {
    const probe = await f.workers.probe("fixture", { repoMapping: "project", baseCommit: git(f.source, "rev-parse", "HEAD"), repositoryBase: f.repositoryBase });
    assert.equal(probe.hasBase, false); assert.equal(probe.hasRepositoryBase, true); assert.equal(probe.capabilities.providers[0]?.available, true); assert.equal(probe.capabilities.resumeSessions, false);
    const head = git(f.source, "rev-parse", "HEAD"), result = await f.execute("WRITE"); assert.equal(result.ok, true, result.error); assert.equal(result.remote.state, "completed"); assert.equal(result.sessionId, undefined); assert.ok(result.artifact);
    assert.equal(git(f.source, "rev-parse", "HEAD"), head); assert.equal(git(f.mapping, "rev-parse", "HEAD"), f.repositoryBase);
    const receiptJSON = JSON.stringify(result); assert.ok(!receiptJSON.includes("capability")); assert.ok(!receiptJSON.includes("never-forward"));
    await f.workers.importArtifact(f.source, result.artifact!, head); assert.equal(readFileSync(join(f.source, "result.txt"), "utf8"), "local exact base\nexplicit staged reference"); assert.notEqual(git(f.source, "rev-parse", "HEAD"), head); assert.equal(git(f.source, "for-each-ref", "--format=%(refname)", "refs/codeflow"), "");
    const audit = JSON.parse(readFileSync(f.audit, "utf8").trim()); assert.notEqual(audit.pid, process.pid); assert.ok(audit.cwd.startsWith(realpathSync(f.workerRoot))); assert.equal(audit.hostSecret, undefined); assert.equal(audit.codeflowToken, undefined);
    for (const line of readFileSync(f.sshAudit, "utf8").trim().split("\n")) { const row = JSON.parse(line); assert.deepEqual(row.args.slice(0, SSH_OPTIONS.length), SSH_OPTIONS); assert.equal(row.hostSecret, undefined); assert.equal(row.codeflowToken, undefined); }
  } finally { delete process.env.HOST_PRIVATE_SECRET; delete process.env.CODEFLOW_TOKEN; }
});

test("read-only mutations are rejected and discarded; remote sessions and unsupported live tools never escape", async () => {
  const f = await fixture(), result = await f.execute("MUTATE", "read"); assert.equal(result.ok, false); assert.match(result.error!, /modified|changed/); assert.equal(result.artifact, undefined); assert.equal(readFileSync(join(f.source, "README.md"), "utf8"), "initial\n");
  await assert.rejects(f.execute("WRITE", "write", { options: { cwd: f.source, prompt: "WRITE", mode: "write", resumeSessionId: "host-private-session" } }), /fresh sessions/);
  assert.equal(readdirSync(join(f.workerRoot, "requests", result.remote.requestId)).includes("checkout"), false);
});

test("receipt capabilities survive client restart and duplicate request IDs inspect without another invocation", async () => {
  const f = await fixture(), requestId = "a".repeat(32); const result = await f.execute("WRITE", "write", { requestId }); assert.equal(result.ok, true, result.error);
  const restored = new RemoteWorkers({ home: f.home, sshBinary: f.ssh, environment: f.env }); await restored.load(); const receipt = await restored.receipt("fixture", requestId); assert.equal(receipt.ok, true); assert.equal(receipt.remote.state, "completed"); assert.ok(receipt.artifact);
  const again = await f.execute("WRITE", "write", { requestId }); assert.equal(again.ok, true); assert.equal(readFileSync(f.audit, "utf8").trim().split("\n").length, 1);
  await assert.rejects(f.execute("different", "write", { requestId }), /another scoped invocation/);
  const worker = new ProvisionedWorker(await loadWorkerConfig(f.configFile)); await assert.rejects(worker.receipt(requestId, "b".repeat(64)), /does not own/);
  const missing = await worker.cancel("f".repeat(32), "b".repeat(64)); assert.equal(missing.state, "unknown"); assert.match(missing.reason!, /nothing was cancelled/);
  await assert.rejects(restored.receipt("fixture", requestId, { expectedScope: { runId: "different-run", stepIds: ["step"] } }), /different run or step/); await assert.rejects(restored.cancel("fixture", requestId, { expectedScope: { runId: "run", stepIds: ["different-step"] } }), /different run or step/);
  const changed = JSON.parse(f.env.CODEFLOW_REMOTE_WORKERS_JSON); changed.workers[0].sshHost = "different-host"; const before = readFileSync(f.sshAudit, "utf8");
  const retargeted = new RemoteWorkers({ home: f.home, sshBinary: f.ssh, environment: { CODEFLOW_REMOTE_WORKERS_JSON: JSON.stringify(changed) } }); await retargeted.load(); await assert.rejects(retargeted.receipt("fixture", requestId), /SSH target changed/); assert.equal(readFileSync(f.sshAudit, "utf8"), before, "old capability never reaches a replacement target");
});

test("a dropped SSH channel leaves a durable inspectable outcome and never auto-duplicates an invocation", async () => {
  const f = await fixture(), requestId = "c".repeat(32), result = await f.execute("SLOW DROP WRITE", "write", { requestId }); assert.equal(result.ok, false); assert.equal(result.remote.ambiguous, true);
  const receipt = await until(() => f.workers.receipt("fixture", requestId), (value) => ["completed", "failed", "cancelled"].includes(value.remote.state)); assert.equal(receipt.remote.state, "cancelled");
  await f.execute("SLOW DROP WRITE", "write", { requestId }); assert.equal(readFileSync(f.audit, "utf8").trim().split("\n").length, 1);
});

test("explicit cancellation reaches an active worker and persists the terminal receipt", async () => {
  const f = await fixture(), requestId = "d".repeat(32), running = f.execute("SLOW WRITE", "write", { requestId });
  await until(async () => existsSync(f.audit), Boolean); await f.workers.cancel("fixture", requestId); const result = await running; assert.equal(result.ok, false); assert.equal(result.remote.state, "cancelled"); assert.equal(result.errorKind, "cancelled");
});

test("remote config, context and request bounds reject paths, auth forwarding and oversized data", async () => {
  const f = await fixture(); writeFileSync(join(f.source, ".codeflow-context", ".env"), "secret"); await assert.rejects(contextManifest(f.source), /sensitive/);
  const workers = new RemoteWorkers({ home: join(f.folder, "invalid"), environment: { CODEFLOW_REMOTE_WORKERS_JSON: JSON.stringify({ version: 1, workers: [{ id: "bad", name: "bad", sshHost: "-oProxyCommand=bad", command: "worker", repoMappings: ["project"] }] }) } }); await assert.rejects(workers.load(), /Invalid registered/);
  assert.throws(() => validateWorkerRequest({ id: "a".repeat(32), capability: "b".repeat(64), scope: { runId: "r", stepId: "s", threadId: "t" }, repoMapping: "project", baseCommit: "c".repeat(40), agent: "claude", mode: "write", prompt: "request", trust: "safe", timeoutMs: 1000, context: [], env: { TOKEN: "forged" } }), /arbitrary environment/);
  await assert.rejects(importWorkerArtifact(f.source, { requestId: "f".repeat(32), baseCommit: "0".repeat(40), head: "1".repeat(40), ref: "refs/codeflow/results/" + "f".repeat(32), size: 1, sha256: "2".repeat(64), file: join(f.folder, "absent") }, git(f.source, "rev-parse", "HEAD")), /Invalid remote result/);
});

test("result import rejects tampered bytes and a changed local head before touching the checkout", async () => {
  const f = await fixture(), original = git(f.source, "rev-parse", "HEAD"), result = await f.execute("WRITE"); assert.ok(result.artifact, result.error);
  const file = result.artifact!.file, bytes = readFileSync(file); writeFileSync(file, Buffer.concat([bytes, Buffer.from("tampered")]));
  await assert.rejects(importWorkerArtifact(f.source, result.artifact!, original), /integrity/); assert.equal(git(f.source, "rev-parse", "HEAD"), original);
  writeFileSync(file, bytes); writeFileSync(join(f.source, "new-local.txt"), "concurrent host work"); git(f.source, "add", "."); git(f.source, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "host advanced");
  await assert.rejects(f.workers.importArtifact(f.source, result.artifact!, original), /changed while/); assert.equal(existsSync(join(f.source, "result.txt")), false);
});

test("stale or missing durable receipts stay unknown and do not relaunch a previously claimed ID", async () => {
  const f = await fixture(), requestId = "e".repeat(32); assert.equal((await f.execute("WRITE", "write", { requestId })).ok, true);
  const file = join(f.workerRoot, "requests", requestId, "receipt.json"), saved = JSON.parse(readFileSync(file, "utf8"));
  saved.state = "running"; saved.heartbeatAt = 0; saved.updatedAt = 0; delete saved.result; delete saved.artifact; writeFileSync(file, JSON.stringify(saved));
  const stale = await f.execute("WRITE", "write", { requestId }); assert.equal(stale.remote.state, "unknown"); assert.equal(stale.remote.ambiguous, true); assert.match(stale.error!, /expired|ambiguous/);
  rmSync(file); const missing = await f.execute("WRITE", "write", { requestId }); assert.equal(missing.remote.state, "unknown"); assert.equal(missing.remote.ambiguous, true);
  assert.equal(readFileSync(f.audit, "utf8").trim().split("\n").length, 1);
});

test("remote transfers reject submodules and checkout filters, and suppress configured filter execution", async () => {
  const f = await fixture(), head = git(f.source, "rev-parse", "HEAD"), marker = join(f.folder, "filter-must-not-execute");
  git(f.source, "config", "filter.probe.clean", `touch ${quote(marker)}`); git(f.source, "config", "filter.probe.smudge", `touch ${quote(marker)}`); git(f.source, "config", "filter.probe.required", "true");
  writeFileSync(join(f.source, ".gitattributes"), "*.txt filter=probe\n");
  await gitChecked(f.source, [...await disabledCheckoutFilters(f.source), "add", "--all", "--", "."]); assert.equal(existsSync(marker), false);
  await gitChecked(f.source, [...await disabledCheckoutFilters(f.source), "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "filter attributes"]);
  await assert.rejects(f.execute("WRITE"), /checkout filters/); assert.equal(existsSync(f.audit), false, "unsupported source never invokes the worker CLI");
  await gitChecked(f.source, [...await disabledCheckoutFilters(f.source), "reset", "--hard", head]); assert.equal(existsSync(marker), false); git(f.source, "update-index", "--add", "--cacheinfo", `160000,${head},submodule`); const tree = git(f.source, "write-tree"); await assert.rejects(assertTransferTree(f.source, tree), /submodule contents/);
});

test("worker container inventory probes the configured image without host CLI availability or auth volumes", async () => {
  const f = await fixture(), config = JSON.parse(readFileSync(f.configFile, "utf8")); config.containers = { isolated: { image: "fixture/image:local", network: false } }; writeFileSync(f.configFile, JSON.stringify(config));
  const bin = join(f.folder, "docker-bin"), record = join(f.folder, "docker-probes.jsonl"); mkdirSync(bin); writeFileSync(join(bin, "docker"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  const { adapters } = await import("../src/adapters/index.js"), previous = adapters.claude.available, path = process.env.PATH; adapters.claude.available = async () => false; process.env.PATH = `${bin}:${path}`;
  try { const worker = new ProvisionedWorker(await loadWorkerConfig(f.configFile)); assert.equal((await worker.capabilities()).providers[0]!.available, false); assert.equal((await worker.capabilities("isolated")).providers[0]!.available, true); await assert.rejects(worker.capabilities("missing"), /explicit worker-local/); const calls: string[][] = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)); assert.equal(calls.length, 2); assert.ok(calls[0]!.includes("--network=none")); assert.ok(calls[0]!.includes("--pull=never")); assert.ok(calls[0]!.includes("--read-only")); assert.ok(calls[0]!.includes("claude")); assert.equal(calls[0]!.includes("--mount"), false); assert.deepEqual(calls[1]!.slice(0, 2), ["rm", "-f"]); }
  finally { adapters.claude.available = previous; process.env.PATH = path; }
});

test("remote request policies retain all required capabilities and reject truncated records", () => {
  const policy = { version: 1, revision: 3, trust: "safe", toolApprovals: false, delegation: "managed", required: ["no-command-network", "workspace-writes"] };
  const request = { id: "a".repeat(32), capability: "b".repeat(64), scope: { runId: "r", stepId: "s", threadId: "t" }, repoMapping: "project", baseCommit: "c".repeat(40), agent: "codex", mode: "write", prompt: "request", trust: "safe", timeoutMs: 1000, context: [], managedPermissions: policy };
  assert.deepEqual(validateWorkerRequest(request).managedPermissions, policy);
  assert.throws(() => validateWorkerRequest({ ...request, managedPermissions: { revision: 3, externalTools: "disabled" } }), /permission policy/);
  assert.throws(() => validateWorkerRequest({ ...request, managedPermissions: { ...policy, required: ["unknown"] } }), /permission policy/);
});
