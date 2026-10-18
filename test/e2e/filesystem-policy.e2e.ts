// Persisted restrictions must apply before plugins, CLI health probes and public/shared views.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectFilePolicies } from "../../src/filesystem-policy.js";
import { SharedAccounts } from "../../src/shared-accounts.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
test("persisted restrictions defer plugin initialization and interpreter health, hide restricted shared history and block public phone views", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-policy-startup-"))), home = join(directory, "data"), repo = join(directory, "repo");
  const token = "policy-startup-owner", phoneToken = "a".repeat(32), pluginMarker = join(directory, "plugin-executed"), pythonMarker = join(directory, "python-executed");
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const selected = (probe.address() as AddressInfo).port; probe.close(() => resolve(selected)); }); }); const base = `http://localhost:${port}`, headers = { authorization: `Bearer ${token}` };
  mkdirSync(join(home, "runs"), { recursive: true }); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "public source\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "initial"], { cwd: repo }); const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(home, "projects.json"), JSON.stringify([{ id: "restricted", name: "Restricted project", repos: [repo], createdAt: 1, defaults: {} }]));
  const run = { id: "restricted-result", project: "restricted", task: "RESTRICTED_PRIVATE_TASK", summary: "RESTRICTED_PRIVATE_SUMMARY", pattern: "solo", repo, baseRef: head, baseLabel: "main", branchPrefix: "codeflow/restricted-result", worktreeDir: join(directory, "worktrees"), roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { setup: "", check: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: 1, endedAt: 2, seen: false, archived: false, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [] };
  writeFileSync(join(home, "runs", `${run.id}.jsonl`), JSON.stringify({ seq: 1, ts: 1, runId: run.id, type: "run", run }) + "\n");
  await new ProjectFilePolicies(home).set("restricted", { revision: 0, read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } });
  const accounts = new SharedAccounts(join(home, "shared-accounts.json")); await accounts.load(); const password = "long restricted project password"; await accounts.create({ revision: 0, username: "viewer", displayName: "Scoped viewer", password, roles: { restricted: "viewer" } });
  writeFileSync(join(home, "remote.json"), JSON.stringify({ enabled: true, token: phoneToken, controlToken: "b".repeat(32), control: false, lan: false }));
  const plugin = join(directory, "plugin.mjs"), source = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pluginMarker)},'executed');export default {api:{major:1,minor:0},providers:[],workflows:[]};`;
  writeFileSync(plugin, source); const extensions = JSON.stringify({ version: 1, extensions: [{ id: "startup-fixture", version: "1.0.0", module: plugin, sha256: createHash("sha256").update(source).digest("hex"), api: { major: 1, minimumMinor: 0 }, requires: [] }] });
  const python = join(directory, "python-probe"); writeFileSync(python, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pythonMarker)},'executed');\n`); chmodSync(python, 0o700);
  const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, CODEFLOW_EXTENSIONS_FILE: "", CODEFLOW_EXTENSIONS_JSON: extensions, CODEFLOW_PYTHON: python, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  try {
    let healthy = false; for (let attempt = 0; attempt < 150; attempt++) { healthy = await fetch(`${base}/api/health`, { headers }).then((response) => response.ok, () => false); if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.equal(healthy, true, "restricted startup remains recoverable by the owner");
    assert.equal((await fetch(`${base}/api/health`, { headers }).then((response) => response.json())).interactiveTerminal, false); assert.equal(existsSync(pythonMarker), false); assert.equal(existsSync(pluginMarker), false, "a valid pinned bundle is not imported before the saved policy is checked");
    assert.equal((await fetch(`${base}/r/${phoneToken}`)).status, 403); assert.equal((await fetch(`${base}/api/runs/restricted-result`, { headers })).status, 403);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ username: "viewer", password }) }); assert.equal(login.status, 200); const cookie = login.headers.getSetCookie().find((value) => !value.includes("Max-Age=0"))!.split(";")[0]!;
    const scopedHeaders = { cookie }; const listed = await fetch(`${base}/api/runs?limit=100`, { headers: scopedHeaders }).then((response) => response.json()); assert.equal(listed.total, 0); assert.deepEqual(listed.runs, []);
    for (const suffix of ["", "/diff", "/export", "/review-coverage", "/collaboration"]) assert.equal((await fetch(`${base}/api/runs/restricted-result${suffix}`, { headers: scopedHeaders })).status, 404, suffix);
    const controller = new AbortController(); try { const response = await fetch(`${base}/api/events?limit=100`, { headers: scopedHeaders, signal: controller.signal }); const reader = response.body!.getReader(); const first = await reader.read(); const content = new TextDecoder().decode(first.value); assert.equal(content.includes("RESTRICTED_PRIVATE"), false); assert.match(content, /"total":0/); await reader.cancel(); } finally { controller.abort(); }
    assert.equal(existsSync(pluginMarker), false); assert.equal(existsSync(pythonMarker), false);
  } finally { server.kill("SIGTERM"); await new Promise<void>((resolve) => { if (server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(directory, { recursive: true, force: true }); }
});
