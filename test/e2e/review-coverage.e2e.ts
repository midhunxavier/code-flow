import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer review-coverage-e2e", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string;
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-review-coverage-e2e-")));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test subject.test.mjs" } }));
  await writeFile(join(repo, "subject.txt"), "original subject\n");
  await writeFile(join(repo, "subject.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('fixture', () => assert.equal(1 + 1, 2));\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "review-coverage-e2e", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "1"); localStorage.setItem("sideTab", "changes"); }, repo);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("criterion mappings show uncovered and covered outcomes in the workspace", { timeout: 45_000 }, async () => {
  await page.goto(base + "/#/settings/workspace");
  await page.getByRole("button", { name: "Detect checks", exact: true }).click();
  const mappings = page.locator("details", { has: page.getByText("Requirement evidence mapping", { exact: true }) });
  await mappings.locator("summary").click();
  await mappings.getByRole("button", { name: "Add criterion", exact: true }).click();
  await mappings.getByLabel("Description for criterion-1", { exact: true }).fill("Arithmetic behavior is exercised");
  await page.getByRole("button", { name: "Run verification", exact: true }).click();
  await page.getByRole("heading", { name: "Result: needs-changes", exact: true }).waitFor();
  await page.getByLabel("Requirement verification results", { exact: true }).getByText("Uncovered: Arithmetic behavior is exercised · no checks mapped", { exact: true }).waitFor();
  await mappings.getByLabel("unit", { exact: true }).check();
  await page.getByRole("button", { name: "Run verification", exact: true }).click();
  await page.getByRole("heading", { name: "Result: verified", exact: true }).waitFor();
  await page.getByLabel("Requirement verification results", { exact: true }).getByText("Covered: Arithmetic behavior is exercised", { exact: true }).waitFor();
});

test("standalone verification rejects setup or per-gate candidate drift and removes disposable checkouts", async () => {
  const worktrees = () => execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString().match(/^worktree /gm)?.length;
  const before = worktrees();
  const profile = (commands: string[]) => ({ name: "pinned", checks: commands.map((command, index) => ({ id: `gate-${index}`, kind: "custom", command, required: true, timeoutMs: 10000 })) });
  for (const request of [
    { profile: profile(["true"]), setup: "printf 'setup rewrite\\n' > subject.txt" },
    { profile: profile(["printf 'gate rewrite\\n' > subject.txt", "git checkout -- subject.txt"]) },
    { profile: profile(["printf 'staged rewrite\\n' > subject.txt && git add subject.txt"]) },
    { profile: profile(["git -c user.name=test -c user.email=test@test commit --allow-empty -qm moved"]) },
  ]) {
    const response = await fetch(base + "/api/verification", { method: "POST", headers, body: JSON.stringify({ repo, ...request }) });
    assert.equal(response.status, 409, await response.clone().text());
    assert.match((await response.json()).error, /original commit was not verified/);
    assert.equal(worktrees(), before);
  }
  assert.equal(await readFile(join(repo, "subject.txt"), "utf8"), "original subject\n");
});

test("human review is commit-scoped and a rejected rework record retains the user's draft", { timeout: 45_000 }, async () => {
  const started = await api<{ id: string }>("/api/runs", { repo, pattern: "solo", task: "Human review browser fixture", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } });
  const run = await until(() => api(`/api/runs/${started.id}`), (value) => value.status !== "running");
  assert.equal(run.status, "done", run.error);
  const tree = run.worktrees[0]; const endpoint = `/api/runs/${run.id}/review-coverage?branch=${encodeURIComponent(tree.branch)}`;
  const coverage = await api(endpoint); assert.ok(coverage.files.length);
  await page.goto(base + `/#/run/${run.id}`);
  const panel = page.locator(".review-coverage"); await panel.locator(":scope > summary").click();
  await panel.getByLabel(`Mark ${coverage.files[0]} reviewed`, { exact: true }).click();
  await until(() => api(endpoint), (value) => value.reviewed.includes(coverage.files[0]));
  await until(() => panel.getByLabel(`Mark ${coverage.files[0]} reviewed`, { exact: true }).isChecked(), (value) => value);
  await panel.getByText("Record human rework", { exact: true }).click();
  await panel.getByLabel("Minutes", { exact: true }).fill("15");
  await panel.getByLabel("What changed", { exact: true }).fill("Corrected the result after manual review");
  await panel.getByRole("button", { name: "Record rework", exact: true }).click();
  await panel.getByText("15 minutes recorded across 1 entries.", { exact: true }).waitFor();
  await panel.getByLabel("Minutes", { exact: true }).fill("25");
  await panel.getByLabel("What changed", { exact: true }).fill("This draft must survive a changed branch");
  await writeFile(join(tree.path, "subject.txt"), "external later commit\n");
  execFileSync("git", ["add", "."], { cwd: tree.path }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "branch moved externally"], { cwd: tree.path });
  await panel.getByRole("button", { name: "Record rework", exact: true }).click();
  await panel.getByRole("alert").getByText(/branch changed/).waitFor();
  assert.equal(await panel.getByLabel("Minutes", { exact: true }).inputValue(), "25");
  assert.equal(await panel.getByLabel("What changed", { exact: true }).inputValue(), "This draft must survive a changed branch");
  const moved = await api(endpoint); assert.equal(moved.stale, true); assert.equal(moved.coverage.reviewed, 0); assert.equal(moved.rework.length, 1);
  await page.reload(); await panel.locator(":scope > summary").click();
  await panel.getByText(/previous review refers to older code/).waitFor();
  assert.equal(await panel.getByLabel(`Mark ${coverage.files[0]} reviewed`, { exact: true }).isChecked(), false);
});

test("workspace compares a complete commit and stages only its reviewed inverse", { timeout: 45_000 }, async () => {
  const started = await api<{ id: string }>("/api/runs", { repo, pattern: "solo", task: "Checkpoint revert browser fixture", roles: { agent: ["claude"] }, loop: { check: "true", maxSteps: 4, maxMinutes: 1 } });
  const run = await until(() => api(`/api/runs/${started.id}`), (value) => value.status !== "running");
  assert.equal(run.status, "done", run.error);
  const tree = run.worktrees[0];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: tree.path }).toString().trim();
  const previous = git("rev-parse", "HEAD");
  await writeFile(join(tree.path, "checkpoint.txt"), "This commit will be reverted.\n");
  git("add", "checkpoint.txt"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "reviewed checkpoint addition");
  const head = git("rev-parse", "HEAD");
  await page.goto(base + "/#/settings/workspace");
  await page.locator("#wb-folder").selectOption(tree.path);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Load checkpoints", exact: true }).click();
  await page.getByLabel("Checkpoint", { exact: true }).selectOption(previous);
  await page.getByRole("button", { name: "Compare selected checkpoint to HEAD", exact: true }).click();
  const compare = page.getByLabel("Full checkpoint comparison", { exact: true });
  await compare.getByText(/1 changed paths/).waitFor();
  await compare.getByText("Full commit patch", { exact: true }).click();
  assert.match(await compare.innerText(), /\+This commit will be reverted/);
  await page.getByLabel("Checkpoint", { exact: true }).selectOption(head);
  await page.getByRole("button", { name: "Preview inverse commit", exact: true }).click();
  const preview = page.getByLabel("Reviewed commit revert", { exact: true });
  await preview.getByText("Revert: reviewed checkpoint addition", { exact: true }).waitFor();
  assert.equal(await readFile(join(tree.path, "checkpoint.txt"), "utf8"), "This commit will be reverted.\n");
  assert.equal(git("status", "--porcelain"), "");
  await preview.getByRole("button", { name: "Stage reviewed inverse change", exact: true }).click();
  await page.getByRole("status").getByText(/Inverse change staged/).waitFor();
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.match(git("status", "--porcelain"), /D  checkpoint.txt/);
  await assert.rejects(readFile(join(tree.path, "checkpoint.txt")), { code: "ENOENT" });
});
