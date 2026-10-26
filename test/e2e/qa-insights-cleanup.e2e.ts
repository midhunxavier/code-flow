// Insights → Disk → Clean up in the browser: the Days field takes only a whole number of days (a
// blank or negative one never becomes "every finished run"), the confirm says what goes and what
// stays, and the runs Clean up kept are listed with the reason. Fake agents; a throwaway repo.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-insights-cleanup-fixture";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
let directory: string, home: string, repo: string, base: string, server: ChildProcess, browser: Browser, page: Page;
const browserErrors: string[] = [];
const cleanups: { olderThanDays?: unknown }[] = [];
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); });
}
async function finishedRun(task: string) {
  const { id } = await api<{ id: string }>("/api/runs", { repo, pattern: "solo", task, roles: { agent: ["claude"] }, options: {} });
  for (let i = 0; i < 200; i++) {
    const run = await api(`/api/runs/${id}`);
    if (run.status !== "running" && run.endedAt) { assert.equal(run.status, "done", run.error); await api(`/api/runs/${id}/seen`, {}); return run; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${task} didn't finish`);
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-insights-cleanup-"))); home = join(directory, "home"); repo = join(directory, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "Clean up fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += String(chunk); }); server.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; ; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (server.exitCode !== null || attempt >= 200) throw new Error(`Clean up server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("request", (request) => { if (request.url().endsWith("/api/cleanup")) cleanups.push(request.postDataJSON()); });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => { await browser?.close(); await stop(); await rm(directory, { recursive: true, force: true }); });

test("Days takes only 0–365, the confirm discloses archiving and what's kept, and kept runs are listed with the reason", { timeout: 60_000 }, async () => {
  const dirty = await finishedRun("Chat whose notes are only in its worktree");
  const clean = await finishedRun("Chat with nothing left over");
  await writeFile(join(dirty.worktrees[0].path, "notes.txt"), "Only here\n");
  execFileSync("git", ["clean", "-fdq"], { cwd: clean.worktrees[0].path });

  await page.goto(`${base}/?token=${token}#/insights`);
  const disk = page.getByRole("region", { name: "Disk", exact: true });
  const days = disk.getByLabel("Days", { exact: true });
  const cleanUp = disk.getByRole("button", { name: "Clean up", exact: true });
  await days.waitFor();
  assert.equal(await days.inputValue(), "7");
  assert.equal(await cleanUp.isEnabled(), true);

  for (const value of ["-3", "", "400", "1.5"]) {
    await days.fill(value);
    assert.equal(await cleanUp.isDisabled(), true, `Clean up is off for ${JSON.stringify(value)}`);
    assert.equal(await days.getAttribute("aria-invalid"), "true");
    await disk.getByRole("alert").getByText("Enter a whole number of days from 0 to 365", { exact: true }).waitFor();
    assert.equal(await days.inputValue(), value === "1.5" ? "1.5" : value, "the field keeps what was typed");
  }
  // Typed for real: Backspace on an empty field and a stray minus never become 0.
  await days.fill("7"); await days.press("ControlOrMeta+a"); await days.press("Backspace"); await days.pressSequentially("-");
  assert.equal(await cleanUp.isDisabled(), true);
  assert.equal(cleanups.length, 0, "nothing was sent for an invalid value");

  await days.fill("1");
  await cleanUp.click();
  const dialog = page.getByRole("dialog", { name: "Remove old worktrees?" });
  assert.match(await dialog.innerText(), /runs that finished more than 1 day ago/);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await days.fill("0");
  assert.equal(await disk.getByRole("alert").count(), 0);
  await cleanUp.click();
  const text = await dialog.innerText();
  assert.match(text, /Remove the worktrees of all finished runs that need nothing from you, and archive those runs\?/);
  assert.match(text, /Runs with uncommitted changes, a locked worktree or a workspace shared with other chats are left as they are/);
  assert.doesNotMatch(text, /more than 0 days/);
  await dialog.getByRole("button", { name: "Remove worktrees", exact: true }).click();

  await page.getByRole("status").getByText("Removed 1 worktree(s) from 1 run(s) and archived them; kept 1 run(s) as they are (see below)", { exact: true }).waitFor();
  assert.equal(cleanups.at(-1)?.olderThanDays, 0);
  const kept = disk.getByRole("region", { name: "Runs Clean up kept", exact: true });
  const row = kept.getByRole("row").filter({ hasText: dirty.task });
  await row.waitFor();
  assert.match(await row.innerText(), /has uncommitted changes/);
  assert.equal(await kept.getByRole("row").filter({ hasText: clean.task }).count(), 0);

  assert.equal(await readFile(join(dirty.worktrees[0].path, "notes.txt"), "utf8"), "Only here\n");
  assert.equal((await api(`/api/runs/${dirty.id}`)).archived, false);
  assert.equal((await api(`/api/runs/${clean.id}`)).archived, true);
  assert.ok(!existsSync(clean.worktrees[0].path));

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "no sideways scroll on a phone");
  await row.click();
  await page.waitForURL(new RegExp(`#/run/${dirty.id}`));
  assert.deepEqual(browserErrors, []);
});
