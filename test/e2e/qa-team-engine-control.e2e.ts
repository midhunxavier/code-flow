// A finished Auto team's reply box: a direct reply can change the delivered result (the lead in
// the integration worktree, which clears the team's approval), and a worker's branch is marked
// as outside it. Fake agents.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-team-engine-control-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string;
const errors: string[] = [];
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd: repo }).toString().trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value).slice(0, 2000)}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
}
const finished = (id: string) => until(() => api<Run>(`/api/runs/${id}`), (run) => run.status !== "running");

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-team-engine-e2e-")));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await mkdir(join(repo, ".codeflow")); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  await writeFile(join(repo, "README.md"), "team fixture\n");
  await writeFile(join(repo, "baseline.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('baseline', () => assert.equal(1, 1));\n");
  git("add", "."); git("commit", "-qm", "initial");
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { authorization: headers.authorization } });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a direct reply in a finished Auto team run can change the delivered result, which clears its approval", { timeout: 180_000 }, async () => {
  let run = await finished((await api<Run>("/api/runs", { repo, pattern: "auto-team", task: "AUTO-SAME-PROVIDER Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, loop: { check: "node --test", maxSteps: 20, maxMinutes: 5 }, approvals: { plan: false } })).id);
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team?.verification?.approved, true);
  const integration = run.worktrees.find((tree) => tree.name === "integration")!;
  const before = git("rev-parse", integration.branch);

  await page.goto(`${base}/#/run/${run.id}`);
  const to = page.locator("main .convo").getByLabel("Who gets this", { exact: true });
  await to.waitFor();
  const groups = await to.locator("optgroup").evaluateAll((items) => items.map((group) => ({ label: (group as HTMLOptGroupElement).label, values: [...(group as HTMLOptGroupElement).querySelectorAll("option")].map((option) => option.value) })));
  assert.deepEqual(groups[0], { label: "Change the result", values: ["claude@integration"] }, JSON.stringify(groups));
  const workers = groups.find((group) => group.label === "Worker branches (not in the result)");
  assert.ok(workers?.values.length && workers.values.every((value) => !value.endsWith("@integration")), JSON.stringify(groups));
  assert.equal(await to.locator("option[value='claude@integration']").innerText(), "Claude Code · result (integration)");

  // A worker's branch says it isn't the delivered result; the result says what changing it means.
  await to.selectOption(workers!.values[0]!);
  assert.match(await page.locator("main .convo .chatbox-hint").innerText(), /changes only auto-\w+'s branch, which isn't part of the delivered result/);
  await to.selectOption("claude@integration");
  assert.match(await page.locator("main .convo .chatbox-hint").innerText(), /changes the delivered result in integration; the team's review then no longer covers it/);
  assert.doesNotMatch(await page.locator("main .convo .chatbox-hint").innerText(), /session/);

  await page.locator(".followup-budget > summary").click();
  await page.getByLabel("Follow-up maximum calls", { exact: true }).fill("1");
  await page.getByLabel("Reply", { exact: true }).fill("Add a short documentation file for the result.");
  await page.locator("main .convo").getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Sent — the agent is on it", { exact: true }).waitFor();
  run = await until(() => api<Run>(`/api/runs/${run.id}`), (value) => value.status !== "running" && value.followUps.length === 1 && value.followUps[0]!.status !== "pending");
  assert.equal(run.followUps[0]!.worktree, "integration");
  assert.equal(run.followUps[0]!.agent, "claude");
  assert.notEqual(git("rev-parse", integration.branch), before, "the delivered result moved");
  assert.equal(run.team?.verification?.approved, false);
  assert.ok(run.team?.gaps.some((gap) => /changed after the team's review/.test(gap)), JSON.stringify(run.team?.gaps));
  assert.equal(run.facts?.approved, false);
  assert.deepEqual(errors, []);
});
