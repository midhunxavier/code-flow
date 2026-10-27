import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RunManager } from "../src/engine.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "qa-diagnostics-maintenance-")));
const home = join(root, "home"); await mkdir(join(home, "runs"), { recursive: true });
process.env.CODEFLOW_HOME = home;
after(() => rm(root, { recursive: true, force: true }));
const { redactText, redactExport } = await import("../src/privacy.js");
const { createEncryptedBackup, restoreEncryptedBackup, compactRunLog } = await import("../src/maintenance.js");
const { acquireLock } = await import("../src/store.js");
const { RetentionPolicyStore, previewRetention } = await import("../src/retention-policy.js");
const { handleWorkspaceApi } = await import("../src/workspace-api.js");
const password = "only a fake QA password";
const days = { archivedRuns: null, attachments: 30, worktrees: 30, memory: null };
const policy = { days, keepRunIds: [], keepMemoryIds: [] };
function child(args: string[], extra: Record<string, string> = {}) {
  const processHandle = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: resolve("."), env: { ...process.env, CODEFLOW_HOME: home, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; processHandle.stdout.on("data", data => out += data); processHandle.stderr.on("data", data => err += data);
  return new Promise<{ code: number | null; out: string; err: string }>((accept, reject) => { processHandle.once("error", reject); processHandle.once("exit", code => accept({ code, out, err })); });
}

test("quoted and nested log credentials redact completely without losing adjacent fields or token metrics", () => {
  const secret = "fake_value with spaces and \\\"quotes\\\" and trailing\\";
  for (const key of ["api_key", "password", "token", "secret", "Authorization", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "x-api-key"]) {
    let text = JSON.stringify({ [key]: secret, status: "kept", inputTokens: 25 });
    for (let depth = 0; depth < 3; depth++) {
      const result = redactText(text, []);
      assert.ok(!result.includes("fake_value"), `${key}, depth ${depth}`);
      assert.ok(result.includes("kept"), `${key}, depth ${depth} retains neighboring data`);
      assert.ok(result.includes("inputTokens"));
      assert.equal(redactText(result, []), result);
      text = JSON.stringify({ error: text });
    }
  }
  assert.deepEqual(redactExport({ inputTokens: 25, outputTokens: 30, authorization: { value: "fake" }, nested: { "aws-secret-access-key": "fake" } }), { inputTokens: 25, outputTokens: 30, authorization: "[REDACTED]", nested: { "aws-secret-access-key": "[REDACTED]" } });
});

test("header schemes, common vendor credentials and context token assignments redact once", () => {
  const values = ["abc12345xyz", "dXNlcjpwYXNzd29yZA==", "AKIAIOSFODNN7EXAMPLE", "xoxb-1234567890-0987654321", "glpat-abcdefghijklmnopqrst", "npm_" + "x".repeat(36), "AIza" + "x".repeat(35), "sk_live_" + "x".repeat(20)];
  for (const input of [`Authorization: token ${values[0]}`, `Authorization: Basic ${values[1]}`, `Cookie: access=first; session=second`, ...values.slice(2)]) {
    const result = redactText(input, []);
    for (const value of values) assert.ok(!result.includes(value));
    assert.equal(redactText(result, []), result);
  }
  for (const input of ['api_key = "sk-ant-api03-QAFAKEabcdefghijklmnop"', "password: ghp_QAFAKEabcdefghijklmnopqrstuv", "client_secret=github_pat_QAFAKEabcdefghijklmnopqrst", "https://x.test/cb?token=sk-ant-api03-QAFAKEabcdefghijklmnop"]) {
    const result = redactText(input, []);
    assert.ok(result.includes("[REDACTED]")); assert.ok(!result.includes("QAFAKE")); assert.ok(!result.includes("TOKEN]")); assert.equal(redactText(result, []), result);
  }
});

test("diagnostics and capabilities tolerate a missing repository while file operations stay closed", async () => {
  const manager = { list: () => [], busy: {}, inspectRepositoryActivity: () => [] } as unknown as RunManager;
  const request = (path: string) => { const req = Readable.from([]) as unknown as IncomingMessage; req.method = "GET"; const url = new URL(path, "http://127.0.0.1"); return handleWorkspaceApi(req, url, url.pathname.split("/").filter(Boolean), manager, new AbortController().signal); };
  const repo = encodeURIComponent(join(root, "missing-repo"));
  const fake = "FAKE_diagnostics_json_secret";
  await writeFile(join(home, "server.log"), JSON.stringify({ error: `Request failed: ${JSON.stringify({ api_key: fake, password: fake })}\nAuthorization: token ${fake}` }) + "\n");
  const result = await request(`/api/diagnostics?repo=${repo}`);
  assert.equal(result?.status, 200); assert.equal((result?.body as any).repository, "missing"); assert.match((result?.body as any).git, /^git version /); assert.ok(!JSON.stringify(result?.body).includes(fake));
  assert.equal((await request(`/api/v1/capabilities?repo=${repo}`))?.status, 200);
  await assert.rejects(request(`/api/workspace/file?repo=${repo}&path=x`), /existing Git repository/);
  await writeFile(join(home, "server.log"), JSON.stringify({ password: "unkeyed-secret-fragment".repeat(2000) }) + "\n" + JSON.stringify({ error: "complete safe record" }) + "\n");
  const truncated = await request("/api/diagnostics"); assert.ok(!JSON.stringify(truncated?.body).includes("unkeyed-secret-fragment")); assert.ok(JSON.stringify(truncated?.body).includes("complete safe record"));
});

test("backup preflight rejects existing outputs, missing folders and invalid passwords before reading data", async () => {
  const output = join(root, "existing.cfb"); await writeFile(output, "existing backup");
  await assert.rejects(createEncryptedBackup({ home: join(root, "missing-home"), output, password: "short" }), /Backup file already exists/);
  assert.equal(await readFile(output, "utf8"), "existing backup");
  await assert.rejects(createEncryptedBackup({ home, output: join(root, "missing", "file.cfb"), password }), /Backup folder does not exist/);
  await assert.rejects(createEncryptedBackup({ home: join(root, "missing-home"), output: join(root, "new.cfb"), password: "" }), /backup password/);
  await assert.rejects(restoreEncryptedBackup({ input: join(root, "missing.cfb"), destination: join(root, "restore"), password: "" }), /backup password/);
  await assert.rejects(restoreEncryptedBackup({ input: join(root, "missing.cfb"), destination: join(root, "restore"), password }), /Backup file not found/);
  assert.equal((await readdir(root)).some(name => name.endsWith(".tmp")), false);
  await assert.rejects(compactRunLog({ home, runId: "nope-123" }), /^Error: Run nope-123 not found\.$/);
});

test("maintenance settings and preview obey the active server lock and explain input/output failures", async () => {
  const input = join(root, "settings.json"), output = join(root, "plan.json"); await writeFile(input, JSON.stringify(policy));
  const store = new RetentionPolicyStore(join(home, "retention-policy.json")); await store.set(policy, 0); const before = await readFile(store.file, "utf8");
  const release = await acquireLock(0, home);
  try {
    for (const args of [["retention-settings", "--input", input], ["retention-policy"]]) {
      const result = await child(["scripts/maintenance.ts", ...args]); assert.equal(result.code, 1); assert.match(result.err, /Another code-flow server/);
    }
    assert.equal(await readFile(store.file, "utf8"), before);
  } finally { release(); }
  assert.equal((await child(["scripts/maintenance.ts", "retention-settings", "--input", input])).code, 0);
  await writeFile(output, "keep"); const collision = await child(["scripts/maintenance.ts", "retention-policy", "--output", output, "--home", join(root, "absent")]); assert.equal(collision.code, 1); assert.match(collision.err, /Plan file already exists/); assert.equal(await readFile(output, "utf8"), "keep");
  const missing = await child(["scripts/maintenance.ts", "retention-settings", "--input", join(root, "absent.json")]); assert.equal(missing.code, 1); assert.match(missing.err, /Retention settings file not found/); assert.doesNotMatch(missing.err, /ENOENT|\.tmp/);
});

test("concurrent policy writers in separate processes preserve exactly one revision winner", async () => {
  const file = join(root, "concurrent.json"), script = join(root, "writer.mts"), gate = join(root, "gate");
  await writeFile(script, `import { RetentionPolicyStore } from ${JSON.stringify(resolve("src/retention-policy.ts"))}; import { access } from 'node:fs/promises'; while (!(await access(process.env.QA_GATE!).then(()=>true,()=>false))) await new Promise(r=>setTimeout(r,5)); try { await new RetentionPolicyStore(process.env.QA_POLICY!).set(${JSON.stringify(policy)},0); console.log('saved'); } catch(error) { if(error.name==='Error' && error.status===409) console.log('conflict'); else throw error; }`);
  const first = child([script], { QA_GATE: gate, QA_POLICY: file }), second = child([script], { QA_GATE: gate, QA_POLICY: file }); await writeFile(gate, "go");
  const results = await Promise.all([first, second]); assert.deepEqual(results.map(result => result.code), [0, 0]); assert.deepEqual(results.map(result => result.out.trim()).sort(), ["conflict", "saved"]); assert.equal((await new RetentionPolicyStore(file).get()).revision, 1);
});

test("retention omits already-removed workspaces but protects symlink and non-directory ancestors", async () => {
  const repo = join(root, "repo"); await mkdir(repo); const id = "gone-workspace", managed = join(repo, ".worktrees", id);
  await writeFile(join(home, "runs", `${id}.jsonl`), JSON.stringify({ type: "run", seq: 1, run: { id, repo, worktreeDir: managed, status: "done", archived: true, worktrees: [], followUps: [], watches: {} } }) + "\n");
  for (const parentExists of [false, true]) {
    if (parentExists) await mkdir(join(repo, ".worktrees"));
    const plan = await previewRetention({ home }); assert.equal(plan.protected.some(item => item.id === id && ["attachments", "worktrees"].includes(item.kind)), false);
  }
  await rm(join(repo, ".worktrees"), { recursive: true }); await symlink(join(root, "missing-target"), join(repo, ".worktrees"));
  const linked = await previewRetention({ home }); assert.ok(linked.protected.some(item => item.id === id && /symbolic link/.test(item.reason))); assert.ok(!linked.protected.some(item => /ENOENT|lstat/.test(item.reason)));
  await rm(join(repo, ".worktrees")); await writeFile(join(repo, ".worktrees"), "not a directory"); const regular = await previewRetention({ home }); assert.ok(regular.protected.some(item => item.id === id && /not a directory/.test(item.reason)));
});
