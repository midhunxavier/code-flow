import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "codeflow-delivery-ui-")), repo = join(directory, "repo"), origin = join(directory, "origin.git"), stateFile = join(directory, "github.json");
const headers = { authorization: "Bearer delivery-e2e", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const update = (fn: (s: any) => void) => { const s = state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json();
}
async function until(read: () => Promise<any>, ready: (value: any) => boolean): Promise<any> {
  const end = Date.now() + 25000;
  while (true) { const v = await read(); if (ready(v)) return v; if (Date.now() > end) throw new Error(`Timeout: ${JSON.stringify(v)}`); await new Promise(resolve => setTimeout(resolve, 100)); }
}
before(async () => {
  mkdirSync(repo); mkdirSync(origin);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "README.md"), "initial\n"); git("add", "."); git("commit", "-qm", "initial"); git("remote", "add", "origin", origin); git("push", "-q", "origin", "main");
  git("checkout", "-qb", "dependabot/update"); writeFileSync(join(repo, "dependency.txt"), "v2\n"); git("add", "."); git("commit", "-qm", "upgrade"); git("push", "-q", "origin", "HEAD:refs/heads/dependabot/update", "HEAD:refs/pull/248/head"); git("checkout", "-q", "main");
  writeFileSync(join(repo, "new-main.txt"), "new main\n"); git("add", "."); git("commit", "-qm", "advance main"); git("push", "-q", "origin", "main");
  writeFileSync(stateFile, JSON.stringify({ issues: [], prs: { 248: { number: 248, title: "Update dependency", body: "Verify this upgrade", url: "https://github.com/o/r/pull/248", state: "OPEN", headRefName: "dependabot/update", baseRefName: "main", author: { login: "owner" }, authorAssociation: "OWNER", mergeStateStatus: "BEHIND", comments: [] } } }));
  const port = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const n = (s.address() as AddressInfo).port; s.close(() => resolve(n)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "delivery-e2e", FAKE_GH_STATE: stateFile, FAKE_NOOP_VENDOR: "codex", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let logs = ""; server.stdout?.on("data", v => logs += v); server.stderr?.on("data", v => logs += v);
  await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean).catch(e => { throw new Error(`${e.message}\n${logs}`); });
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1414, height: 900 } });
  await page.addInitScript(() => { localStorage.setItem("sideOpen", "0"); });
  await page.goto(base + "/?token=delivery-e2e");
});
after(async () => { await browser?.close(); if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); } rmSync(directory, { recursive: true, force: true }); });

async function start(pattern: "solo" | "fix-review", source?: object, testRun?: object) {
  const r = await api("/api/runs", { repo, task: "Verify the dependency with no edits", pattern, source, testRun, checkpointOnFinish: true, roles: pattern === "solo" ? { agent: ["codex"] } : { builder: ["codex"], reviewer: ["claude"] }, approvals: { plan: false }, loop: { check: "true", prove: false, maxSteps: 8, maxMinutes: 1 } });
  return until(() => api(`/api/runs/${r.id}`), value => value.status !== "running");
}

test("PR result moves from update to checks to confirmed merge and preserves files when archived", { timeout: 90000 }, async () => {
  const run = await start("fix-review", { kind: "pr", number: 248 }), tree = run.worktrees.find((t: any) => t.branch === run.artifacts[0].branch);
  assert.equal(run.status, "done", run.error);
  await page.goto(base + `/#/run/${run.id}`);
  const card = page.locator(".result-compact");
  await card.getByRole("heading", { name: "Update PR before merging" }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Merge pull request", exact: true }).count(), 0);
  await card.getByRole("button", { name: "Update branch", exact: true }).click();
  await card.getByRole("heading", { name: "Waiting for GitHub checks" }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Checks running…" }).isDisabled(), true);
  assert.equal(state().prs[248].state, "OPEN"); assert.equal(state().updates.length, 1);
  await page.reload(); await card.getByRole("heading", { name: "Waiting for GitHub checks" }).waitFor();
  update(s => { s.prs[248].pending = false; });
  await card.getByRole("button", { name: "Refresh status" }).click();
  await card.getByRole("heading", { name: "PR #248 is ready to merge" }).waitFor();
  await card.getByRole("button", { name: "Merge pull request", exact: true }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "Merge pull request?" });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(state().prs[248].state, "OPEN", "cancel never merges");
  await card.getByRole("button", { name: "Merge pull request", exact: true }).click();
  await confirm.getByRole("button", { name: "Merge pull request", exact: true }).click();
  await card.getByRole("heading", { name: "PR #248 merged", exact: true }).waitFor();
  assert.equal(state().prs[248].state, "MERGED");
  await card.getByRole("button", { name: "Archive run", exact: true }).click();
  await until(() => api(`/api/runs/${run.id}`), value => value.archived);
  assert.ok(existsSync(tree.path)); assert.ok(git("rev-parse", tree.branch));
});

test("Agent test result explains its purpose, hides publishing and keeps archive reversible", { timeout: 60000 }, async () => {
  const run = await start("solo", undefined, { reason: "Regression replay of issue #242. Its fix is already merged in PR #246." });
  await page.goto(base + `/#/run/${run.id}`);
  const card = page.locator(".result-compact");
  await card.getByRole("heading", { name: "Test complete — archive this run" }).waitFor();
  await card.getByText(/already merged in PR #246/).waitFor();
  for (const width of [1414, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await card.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => (await (window as any).axe.run('.result-compact', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', "wcag21a"] } })).violations);
    assert.deepEqual(violations.map((v: any) => v.id), []);
  }
  assert.equal(await card.getByRole("button", { name: /Preview|Review test changes/ }).count(), 0, "a no-op test does not promise code changes");
  await page.goto(`${base}/#/review/${run.id}/${run.artifacts[0].branch.split("/").map(encodeURIComponent).join("/")}`);
  await page.locator(".review").waitFor();
  assert.equal(await page.getByText("Publish changes", { exact: true }).count(), 0);
  await page.goto(base + `/#/run/${run.id}`);
  await card.getByRole("button", { name: "Archive test run" }).click();
  await until(() => api(`/api/runs/${run.id}`), value => value.archived);
  assert.ok(existsSync(run.worktrees[0].path));
});
