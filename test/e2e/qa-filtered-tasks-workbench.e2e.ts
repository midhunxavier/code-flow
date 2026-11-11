import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url)), directory = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-workbench-browser-"))), repo = join(directory, "repo"), home = join(directory, "data"), state = join(directory, "daemon"), bin = join(directory, "bin");
const token = "qa-workbench-owner", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const value = (probe.address() as AddressInfo).port; probe.close(() => resolve(value)); }); }), base = `http://127.0.0.1:${port}`;
let server: ChildProcess, browser: Browser;
const pageErrors: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@test", ...args], { cwd, encoding: "utf8" }).trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function finished(id: string) { for (let attempt = 0; attempt < 300; attempt++) { const run = await api(`/api/runs/${id}`); if (run.status !== "running") return run; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Run fixture did not finish"); }
async function open(repository?: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((path) => { localStorage.setItem("sideOpen", "0"); if (path) localStorage.setItem("repo", path); }, repository ?? "");
  await page.goto(`${base}/?token=${token}`); return page;
}
before(async () => {
  mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(home); mkdirSync(bin); mkdirSync(state);
  writeFileSync(join(repo, "README.md"), "older\n"); git(repo, "init", "-q", "-b", "main"); git(repo, "add", "."); git(repo, "commit", "-qm", "older main commit");
  writeFileSync(join(repo, "src/allowed.txt"), "original browser source\n"); writeFileSync(join(repo, "README.md"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "run base");
  writeFileSync(join(home, "projects.json"), JSON.stringify([{ id: "project", name: "Filtered project", repos: [repo], createdAt: 1, defaults: {} }, { id: "other", name: "Other project", repos: [], createdAt: 2, defaults: {} }]));
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_TOKEN: token, CODEFLOW_HOME: home, PATH: `${bin}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  let ready = false; for (let attempt = 0; attempt < 150; attempt++) { ready = await fetch(`${base}/api/health`, { headers }).then((response) => response.ok, () => false); if (ready) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.ok(ready);
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(directory, { recursive: true, force: true }); });


test("History hides removed worktrees, forks only from the run's own checkpoints and asks before deleting files", { timeout: 90_000 }, async () => {
  const start = (task: string) => api<{ id: string }>("/api/runs", { repo, pattern: "solo", task, roles: { agent: ["codex"] }, loop: { check: "", maxSteps: 3 } });
  const kept = await finished((await start("Kept run for history")).id), removed = await finished((await start("Removed run for history")).id);
  assert.equal(kept.status, "done", kept.error); assert.equal(removed.status, "done", removed.error);
  await api(`/api/runs/${removed.id}/archive`, { cleanup: true });
  const tree = kept.worktrees[0].path, older = git(repo, "rev-parse", "HEAD~1");
  git(tree, "add", "-A"); writeFileSync(join(tree, "run-made.txt"), "made by the run\n"); git(tree, "add", "-A"); git(tree, "commit", "-qm", "run work");
  const page = await open(repo); await page.goto(`${base}/#/settings/workspace`);
  const folder = page.locator("#wb-folder"); await folder.locator(`option[value="${tree}"]`).waitFor({ state: "attached" });
  assert.equal(await folder.locator(`option[value="${removed.worktrees[0].path}"]`).count(), 0, "an archived run's removed worktree is not offered");
  await folder.selectOption(tree); await page.getByRole("button", { name: "History", exact: true }).click(); await page.getByRole("button", { name: "Load checkpoints", exact: true }).click();
  const checkpoint = page.getByLabel("Checkpoint", { exact: true }), fork = page.getByRole("button", { name: "Fork from checkpoint", exact: true });
  await checkpoint.selectOption(older); await page.getByText(/This commit is from before the run started/).waitFor(); assert.equal(await fork.isDisabled(), true);
  assert.match(await checkpoint.locator(`option[value="${older}"]`).innerText(), /before this run/);
  await checkpoint.selectOption(kept.baseRef); assert.equal(await fork.isDisabled(), false);
  assert.match(await checkpoint.locator(`option[value="${kept.baseRef}"]`).innerText(), /where this run started/);
  await page.getByLabel("Checkpoint paths", { exact: true }).fill("run-made.txt"); await page.getByRole("button", { name: "Apply selected files", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete files from the worktree?" }); await dialog.getByText(/applying it deletes it from the worktree: run-made\.txt/).waitFor();
  assert.equal(git(tree, "status", "--porcelain"), ""); await dialog.getByRole("button", { name: "Apply and delete", exact: true }).click();
  await page.getByRole("status").getByText(/deleted run-made\.txt/).waitFor(); assert.equal(git(tree, "status", "--porcelain"), "D run-made.txt");
  assert.equal(await page.getByRole("alert").count(), 0); assert.deepEqual(pageErrors, []);
  await page.close();
});
