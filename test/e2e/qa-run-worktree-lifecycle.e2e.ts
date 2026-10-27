// Run worktree and branch lifecycle in the browser: the side panel knows a run's worktree while its
// first step runs, the Archive dialog says what it did (and what it couldn't), a run whose branch was
// deleted says so, an Agent conversation can be cleaned up from the sidebar, and a run whose log
// stopped saving says so in its column until it's saved again.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-run-worktree-lifecycle";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, home: string, repo: string, project: string;
const errors: string[] = [];
const toasts: string[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 100)); }
}
const runOf = (id: string) => api<Run>(`/api/runs/${id}`);
async function finishedRun(task: string, extra: Record<string, unknown> = {}) {
  const { id } = await api<Run>("/api/runs", { repo, project, pattern: "fix-review", task, roles: { builder: ["claude"], reviewer: ["claude"] }, options: {}, loop: { check: "true" }, ...extra });
  return until(() => runOf(id), (run) => run.status !== "running");
}
async function openRun(id: string) {
  await page.goto(`${base}/#/run/${id}`);
  await page.locator(".run-head").waitFor();
}
async function archiveDialog(id: string) {
  await openRun(id);
  await page.getByRole("button", { name: "More run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive…", exact: true }).click();
  return page.getByRole("dialog", { name: "Archive this run", exact: true });
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-worktree-lifecycle-")));
  home = join(directory, "home"); repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "Lifecycle fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  // Codex takes a while (a first step to look at the side panel during); Claude answers at once.
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_SLEEP_VENDOR: "codex", FAKE_SLEEP_MS: "4000", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (attempt === 149) throw new Error("Server did not start"); await new Promise((resolve) => setTimeout(resolve, 100)); }
  project = (await api<{ id: string }>("/api/projects", { name: "Lifecycle", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().includes("/api/") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.exposeFunction("recordToast", (text: string) => toasts.push(text));
  await page.addInitScript(() => new MutationObserver(() => document.querySelectorAll<HTMLElement>(".toast").forEach((toast) => {
    if (toast.dataset.recorded) return; toast.dataset.recorded = "1"; (window as unknown as { recordToast(text: string): void }).recordToast(toast.textContent ?? "");
  })).observe(document, { childList: true, subtree: true }));
  await page.goto(`${base}/?token=${token}`);
});
after(async () => {
  try { chmodSync(join(home, "runs"), 0o755); } catch { /* not changed */ }
  await browser?.close();
  if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

test("the side panel works in a run's worktree while its first step is still running", { timeout: 60_000 }, async () => {
  const { id } = await api<Run>("/api/runs", { repo, project, pattern: "fix-review", task: "Side panel during the first step", roles: { builder: ["codex"], reviewer: ["claude"] }, options: {}, loop: { check: "true" } });
  await openRun(id);
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.locator("#side-pane-chat h3", { hasText: "Chat about this run" }).waitFor();
  const run = await runOf(id);
  assert.equal(run.steps.at(-1)?.status, "running", "still in its first step");
  assert.ok((await api<Run[]>("/api/runs")).find((summary) => summary.id === id)!.worktrees.some((tree) => tree.name === "build"), "the run list has its worktree");
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.locator("#side-pane-changes").getByText(`codeflow/${id}/build`).first().waitFor();
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await until(() => runOf(id), (value) => value.status !== "running");
});

test("Archive… shows what it will do and says what it couldn't remove", { timeout: 60_000 }, async () => {
  const run = await finishedRun("Archive dialog");
  const tree = run.worktrees[0]!.path;
  let dialog = await archiveDialog(run.id);
  const remove = dialog.getByRole("checkbox", { name: /Remove its 1 worktree/ });
  const branches = dialog.getByRole("checkbox", { name: /Also delete its branches/ });
  await branches.check();
  await remove.uncheck();
  assert.equal(await branches.isChecked(), false, "branches only go with their worktrees");
  assert.equal(await branches.isDisabled(), true);
  await remove.check();
  assert.equal(await branches.isChecked(), false, "re-ticking doesn't bring back a hidden choice");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // A worktree that isn't the checkout code-flow expects is left alone, and the dialog says so.
  renameSync(join(tree, ".git"), join(tree, ".git.kept")); symlinkSync(join(repo, ".git"), join(tree, ".git"));
  dialog = await archiveDialog(run.id);
  toasts.length = 0;
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  const alert = dialog.getByRole("alert");
  await alert.waitFor();
  assert.match(await alert.innerText(), /Archived, but this couldn't be removed:[\s\S]*isn't the checkout code-flow expects/);
  assert.ok(!toasts.includes("Archived"), "no plain success");
  assert.ok(existsSync(tree));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  assert.match(await page.locator(".run-kicker").innerText(), /Archived/);
  rmSync(join(tree, ".git")); renameSync(join(tree, ".git.kept"), join(tree, ".git"));
});

test("a run whose branch was deleted says its changes are gone and offers no review or merge", { timeout: 60_000 }, async () => {
  const run = await finishedRun("Delete my branch");
  const dialog = await archiveDialog(run.id);
  await dialog.getByRole("checkbox", { name: /Also delete its branches/ }).check();
  toasts.length = 0;
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await until(async () => toasts, (seen) => seen.includes("Archived · removed 1 worktree and 1 branch"));
  assert.equal(git("branch", "--list", run.artifacts[0]!.branch), "");
  await page.getByRole("button", { name: "More run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
  await page.getByText("This run's branch was deleted, so its changes are gone.").waitFor();
  const main = await page.locator("main").innerText();
  assert.doesNotMatch(main, /Branches and files are kept|Fix check command/);
  assert.equal(await page.locator("section.result-studio").count(), 0);
  assert.ok((await page.locator("[role=alert]").allInnerTexts()).every((text) => !/rev-parse|fatal/.test(text)));
  await page.getByText("Details and publishing").click();
  await page.locator(".artifact .badge", { hasText: "Branch deleted" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Merge/ }).count(), 0);
});

test("an Agent conversation is archived and cleaned up from the sidebar", { timeout: 60_000 }, async () => {
  const { id } = await api<Run>("/api/runs", { repo, project, pattern: "solo", task: "Chat to clean up", roles: { agent: ["claude"] }, options: {}, trust: "standard" });
  const chat = await until(() => runOf(id), (run) => run.status !== "running");
  await openRun(id);
  const row = page.getByRole("group", { name: "Chat to clean up", exact: true });
  await row.hover();
  await row.getByRole("button", { name: "Run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive and clean up…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Archive this conversation", exact: true });
  await dialog.getByRole("checkbox", { name: /Also delete its branches/ }).check();
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const after = await until(() => runOf(id), (run) => run.archived && !run.worktrees.length);
  assert.equal(after.deletedWorktrees?.[0]?.branch, chat.worktrees[0]!.branch);
  assert.ok(!git("worktree", "list", "--porcelain").includes(chat.worktrees[0]!.path));
  assert.equal(git("branch", "--list", chat.worktrees[0]!.branch), "");
  assert.ok(!existsSync(chat.worktreeDir), "nothing of it is left in .worktrees");
});

test("a run whose log stopped saving says so in its column, and stops once it's saved again", { timeout: 90_000 }, async () => {
  const { id } = await api<Run>("/api/runs", { repo, project, pattern: "solo", task: "Unsaved run", roles: { agent: ["codex"] }, options: {}, trust: "standard" });
  const runs = join(home, "runs"), log = join(runs, `${id}.jsonl`);
  await until(() => runOf(id), (run) => run.steps.some((step) => step.status === "running"));
  chmodSync(log, 0o444); chmodSync(runs, 0o555);
  const banner = page.locator(".thread .banner.bad[role=alert]");
  try {
    await openRun(id);
    await until(() => runOf(id), (run) => run.status !== "running");
    await banner.waitFor({ timeout: 20_000 });
    const text = await banner.innerText();
    assert.match(text, /have not been saved/);
    assert.ok(!text.includes(home) && !/EACCES/.test(text), "no raw error or private path");
  } finally { chmodSync(runs, 0o755); chmodSync(log, 0o644); }
  await banner.waitFor({ state: "detached", timeout: 40_000 });
  await page.reload();
  await page.locator(".run-head").waitFor();
  assert.equal(await page.locator("[role=alert]", { hasText: "have not been saved" }).count(), 0);
});
