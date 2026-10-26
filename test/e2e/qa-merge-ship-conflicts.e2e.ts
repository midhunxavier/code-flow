// The Merge… panel in the browser: it says what a local merge does, never offers another run's
// result branch (whatever its prefix) as a target, keeps a finished validation across a reload
// and names the gate that failed, says when a conflict resolution failed (and nothing was
// committed), and shows git's warning when a merge's hook outlasted it. After a resolution the
// Review labels the files that came in from the target, and Merge… asks before merging lines that
// look like conflict markers. Fake agents; Codex write turns fail (FAKE_FAIL_VENDOR), and a merge
// in a checkout may take 2 s.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-merge-ship-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string, flag: string;
const errors: string[] = [];
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd: repo }).toString().trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
}
const finished = (id: string) => until(() => api(`/api/runs/${id}`), (run) => run.status !== "running");

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-merge-e2e-")));
  repo = join(directory, "repo");
  flag = join(directory, "fail-validation");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "merge fixture\n");
  await writeFile(join(repo, "shared.txt"), "base\n");
  git("add", "."); git("commit", "-qm", "initial");
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: token, CODEFLOW_MERGE_TIMEOUT_SEC: "2", FAKE_FAIL_VENDOR: "codex", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { authorization: headers.authorization } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** The review's Merge… panel for `branch`, opened fresh. */
async function openMerge(id: string, branch: string) {
  await page.goto(`${base}/#/review/${id}/${branch}`);
  await page.reload(); // a fresh page, whatever was open before
  await page.getByText("Publish changes", { exact: true }).click();
  await page.locator(".review-delivery .artifact-actions > summary").click();
  await page.getByRole("button", { name: "Merge…", exact: true }).click();
  const panel = page.locator(".ship-panel");
  await panel.getByRole("button", { name: "Validate merge result", exact: true }).waitFor();
  return panel;
}

test("the Merge… panel tells the truth about targets, validation, a failed resolution and a merge git didn't finish", { timeout: 120_000 }, async () => {
  const start = (extra: Record<string, unknown>) => api("/api/runs", { repo, pattern: "fix-review", roles: { builder: ["claude"], reviewer: ["codex"] }, options: {}, loop: { check: `test ! -e ${JSON.stringify(flag)}`, prove: false, maxSteps: 4, maxMinutes: 1 }, ...extra });
  const run = await finished((await start({ task: "Edit shared.txt CONFLICT" })).id);
  assert.equal(run.status, "done", run.error);
  const other = await finished((await start({ task: "Write something else", branchPrefix: "qa-other" })).id);
  assert.equal(other.status, "done", other.error);
  const branch = run.artifacts[0].branch;
  git("checkout", "-q", "-b", "theirs"); await writeFile(join(repo, "shared.txt"), "their version\n"); git("commit", "-qam", "theirs"); git("checkout", "-q", "main");

  // What a local merge does, said as it is.
  let panel = await openMerge(run.id, branch);
  const help = await page.locator(".review-delivery > p.help").innerText();
  assert.match(help, /Merge… merges into the branch you pick as soon as you click Merge, without asking again \(tick Require verification there to test the merged result first\)\./);
  assert.doesNotMatch(help, /confirmation still apply/);

  // Your branches only: not this run's result, nor another run's under a custom prefix.
  await panel.getByLabel("Merge into", { exact: true }).locator("option", { hasText: "theirs" }).waitFor({ state: "attached" });
  const targets = await panel.getByLabel("Merge into", { exact: true }).locator("option").allInnerTexts();
  assert.deepEqual([...targets].sort(), ["main", "theirs"]);

  // A finished validation survives a reload, and a failed one names its gate.
  await panel.getByRole("button", { name: "Validate merge result", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Merge verification: verified" }).waitFor({ timeout: 20_000 });
  await page.reload();
  panel = await openMerge(run.id, branch);
  await panel.getByRole("status").filter({ hasText: "Merge verification: verified · target" }).waitFor();
  await panel.getByLabel("Require verification of the current merge target").check();
  assert.equal(await panel.getByRole("button", { name: "Merge into main", exact: true }).isEnabled(), true, "no need to validate again");
  await writeFile(flag, "fail\n");
  await panel.getByRole("button", { name: "Validate merge result", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Merge verification: needs-changes" }).waitFor({ timeout: 20_000 });
  const gates = panel.getByRole("list", { name: "Merge verification gates" });
  assert.match(await gates.innerText(), /run-check: failed \(required\)/);
  assert.equal(await panel.getByRole("button", { name: "Merge into main", exact: true }).isDisabled(), true);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => (await (window as any).axe.run(".ship-panel", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.map((v: any) => v.id));
  assert.deepEqual(violations, []);
  await rm(flag);

  // A resolver that fails: nothing is committed, and the panel says so.
  const head = git("rev-parse", branch);
  await panel.getByLabel("Require verification of the current merge target").uncheck();
  await panel.getByLabel("Merge into", { exact: true }).selectOption("theirs");
  await panel.getByLabel(/Archive the run afterwards/).uncheck();
  await panel.getByRole("button", { name: "Merge into theirs", exact: true }).click();
  await panel.getByText("Merging would conflict in 1 file: shared.txt").waitFor();
  await panel.getByLabel("Agent", { exact: true }).selectOption("codex");
  await panel.getByRole("button", { name: "Ask to resolve", exact: true }).click();
  const resolved = await until(() => api(`/api/runs/${run.id}`), (value) => value.status !== "running" && value.followUps.some((f: any) => f.kind === "resolve-conflicts" && f.status !== "pending"));
  const f = resolved.followUps.at(-1);
  assert.equal(f.status, "failed"); assert.equal(f.commit, undefined);
  assert.equal(git("rev-parse", branch), head);
  assert.doesNotMatch(git("show", `${branch}:shared.txt`), /^<{7}/m);
  panel = await openMerge(run.id, branch);
  await panel.getByText(/Resolving the conflicts with theirs failed: codex's turn failed .*code-flow undid the merge and committed nothing/).waitFor();

  // Stopped in a slow post-merge hook: merged, and the warning is shown where you look.
  const hook = join(repo, ".git", "hooks", "post-merge");
  await writeFile(hook, "#!/bin/sh\nsleep 20\n"); chmodSync(hook, 0o755);
  await panel.getByLabel(/Archive the run afterwards/).uncheck();
  await panel.getByRole("button", { name: "Merge into main", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "Merged into main, but git was stopped after 2 s" }).waitFor({ timeout: 15_000 });
  await panel.getByRole("status").filter({ hasText: "a post-merge hook (an install, a download) may not have finished" }).waitFor();
  await rm(hook);
  assert.equal(existsSync(join(repo, ".git", "MERGE_HEAD")), false, "your checkout isn't left mid-merge");
  assert.equal(git("log", "-1", "--format=%P").split(" ")[1], head);
  assert.deepEqual(errors, []);
});

test("after a resolution, Review lists what the target brought in, labelled, and Merge… asks before merging marker lines", { timeout: 120_000 }, async () => {
  const seen = errors.length;
  const second = join(directory, "repo2");
  const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd }).toString().trim();
  execFileSync("git", ["init", "-q", "-b", "main", second]);
  await writeFile(join(second, "README.md"), "review fixture\n");
  await writeFile(join(second, "shared.txt"), "base\n");
  g(second, "add", "."); g(second, "commit", "-qm", "initial");
  const run = await finished((await api("/api/runs", { repo: second, pattern: "solo", checkpointOnFinish: true, roles: { agent: ["claude"] }, options: {}, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 }, task: "Edit shared.txt CONFLICT" })).id);
  assert.equal(run.status, "done", run.error);
  const branch = run.artifacts[0].branch, worktree = run.worktrees[0];
  g(second, "checkout", "-q", "-b", "qa-conflict-t");
  await writeFile(join(second, "shared.txt"), "target version\n"); await writeFile(join(second, "target-only.txt"), "target-only change\n");
  g(second, "add", "."); g(second, "commit", "-qm", "target"); g(second, "checkout", "-q", "main");
  assert.deepEqual((await api(`/api/runs/${run.id}/merge`, { branch, into: "qa-conflict-t" })).conflicts, ["shared.txt"]);
  await api(`/api/runs/${run.id}/followups`, { kind: "resolve-conflicts", worktree: worktree.name, agent: "claude", mergeFrom: "qa-conflict-t" });
  const resolved = await until(() => api(`/api/runs/${run.id}`), (value) => value.status !== "running" && value.followUps.some((f: any) => f.kind === "resolve-conflicts" && f.status !== "pending"));
  assert.equal(resolved.followUps.at(-1).status, "done", resolved.followUps.at(-1).result);

  // main doesn't have qa-conflict-t: merging there (or into a branch off it) brings target-only.txt along.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/#/review/${run.id}/${branch}`);
    await page.reload();
    const files = page.locator(".review-files");
    const brought = files.locator(".rf", { hasText: "target-only.txt" });
    await brought.waitFor();
    assert.match(await brought.locator(".merged-from").innerText(), /^merged in$/);
    assert.equal(await files.locator(".rf", { hasText: "shared.txt" }).locator(".merged-from").count(), 0, "the run's own change isn't labelled");
    assert.match(await files.locator(".merged-note").innerText(), /The file marked “merged in” came from qa-conflict-t.*merging into a branch without qa-conflict-t's changes brings it along/);
    assert.match(await page.locator(".review-totals").innerText(), /^2 files · \+\d+ −\d+ · 1 from qa-conflict-t$/);
    const badge = await brought.locator(".merged-from").boundingBox();
    assert.ok(badge && badge.x >= 0 && badge.x + badge.width <= width, `the label is on screen at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no sideways scroll at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByText("Review tools", { exact: true }).click();
  const coverage = page.locator(".review-coverage");
  await coverage.locator("summary").filter({ hasText: "Human review coverage · 0/2 files" }).click();
  assert.match(await coverage.locator(".rc-file", { hasText: "target-only.txt" }).innerText(), /merged in/);
  await coverage.getByText(/came from qa-conflict-t when it was merged to resolve conflicts\. They count here/).waitFor();
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => (await (window as any).axe.run(".review", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.map((v: any) => v.id));
  assert.deepEqual(violations, []);

  // A documented conflict example: Merge… says what it found and merges only once you confirm.
  await writeFile(join(worktree.path, "merging.md"), "Git shows a conflict like this:\n\n```\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> theirs\n```\n");
  g(worktree.path, "add", "."); g(worktree.path, "commit", "-qm", "docs");
  const main = g(second, "rev-parse", "main");
  const panel = await openMerge(run.id, branch);
  await panel.getByLabel(/Archive the run afterwards/).uncheck();
  await panel.getByRole("button", { name: "Merge into main", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Merge with conflict markers?", exact: true });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), new RegExp(`${branch} still has conflict markers in merging\\.md\\.`));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(g(second, "rev-parse", "main"), main, "cancelled: main didn't move");
  await panel.getByRole("button", { name: "Merge into main", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Merge with conflict markers?", exact: true });
  await dialog.getByRole("button", { name: "Merge anyway", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "Merged into main" }).waitFor({ timeout: 15_000 });
  assert.match(g(second, "show", "main:merging.md"), /^<{7} HEAD$/m);
  // The refusal's 409 is the browser's to log; nothing else went wrong.
  assert.deepEqual(errors.slice(seen).filter((text) => !/status of 409/.test(text)), []);
});
