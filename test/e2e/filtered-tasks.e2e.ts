import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
import { ProjectFilePolicies } from "../../src/filesystem-policy.js";
const root = fileURLToPath(new URL("../..", import.meta.url)), directory = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-filtered-browser-"))), repo = join(directory, "repo"), home = join(directory, "data"), state = join(directory, "daemon"), bin = join(directory, "bin");
const token = "filtered-browser-owner", headers = { authorization: `Bearer ${token}` }; const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const value = (probe.address() as AddressInfo).port; probe.close(() => resolve(value)); }); }), base = `http://localhost:${port}`;
let server: ChildProcess, browser: Browser, page: Page;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
before(async () => {
  mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(join(repo, "private")); mkdirSync(home); mkdirSync(bin); mkdirSync(state); writeFileSync(join(repo, "src/allowed.txt"), "original browser source\n"); writeFileSync(join(repo, "private/secret.txt"), "DENIED_BROWSER_SENTINEL\n"); git("init", "-q", "-b", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "source"); writeFileSync(join(home, "projects.json"), JSON.stringify([{ id: "project", name: "Filtered project", repos: [repo], createdAt: 1, defaults: {} }])); await new ProjectFilePolicies(home).set("project", { revision: 0, read: { allow: ["src"], deny: [] }, write: { allow: ["src"], deny: [] } });
  chmodSync(join(root, "test/fake-filtered-docker.mjs"), 0o755); symlinkSync(join(root, "test/fake-filtered-docker.mjs"), join(bin, "docker")); execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_TOKEN: token, CODEFLOW_HOME: home, FAKE_FILTERED_DOCKER_STATE: state, PATH: `${bin}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  let ready = false; for (let attempt = 0; attempt < 150; attempt++) { ready = await fetch(`${base}/api/health`, { headers }).then((response) => response.ok, () => false); if (ready) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.ok(ready); browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await page.addInitScript((repo) => { localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); }, repo); await page.goto(`${base}/?token=${token}`); await page.goto(`${base}/#/settings/workspace`); await page.getByRole("button", { name: "Filtered tasks", exact: true }).click(); await page.getByLabel("Filtered tasks project", { exact: true }).selectOption("project");
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(directory, { recursive: true, force: true }); });
test("filtered task UI runs a prepared snapshot, protects a conflicting original, imports a reviewed branch and clears only private artifacts", async () => {
  const panel = page.getByRole("region", { name: "Filtered Docker tasks", exact: true }); await panel.getByLabel("Prepared filtered Docker image", { exact: true }).fill("prepared-browser:1"); await panel.getByLabel("Filtered task instructions", { exact: true }).fill("Change the allowed source through the filtered task"); await panel.getByRole("button", { name: "Start filtered Docker task", exact: true }).click(); await panel.getByText(/^Filtered task status: completed/).waitFor();
  const id = await panel.getByRole("heading", { level: 3 }).first().textContent(); assert.ok(id); const before = git("rev-parse", "HEAD");
  await panel.getByRole("button", { name: "Preview allowed import", exact: true }).click(); await panel.getByRole("region", { name: "Filtered import preview" }).waitFor(); await panel.getByText("modified · src/allowed.txt", { exact: true }).click(); assert.match(await panel.getByRole("region", { name: "Filtered import preview" }).textContent() ?? "", /filtered browser result/);
  writeFileSync(join(repo, "src/allowed.txt"), "A concurrent original edit\n"); await panel.getByRole("button", { name: "Import into new review branch", exact: true }).click(); await panel.getByRole("alert").getByText(/Original file contents changed/).waitFor(); assert.equal(git("branch", "--list", `codeflow/${id}`), ""); writeFileSync(join(repo, "src/allowed.txt"), "original browser source\n");
  await panel.getByRole("button", { name: "Import into new review branch", exact: true }).click(); await panel.getByText(/^Filtered task status: imported/).waitFor(); assert.equal(git("rev-parse", "HEAD"), before); assert.equal(readFileSync(join(repo, "src/allowed.txt"), "utf8"), "original browser source\n"); assert.equal(git("show", `codeflow/${id}:src/allowed.txt`), "filtered browser result"); assert.equal(git("show", `codeflow/${id}:private/secret.txt`), "DENIED_BROWSER_SENTINEL");
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "filtered task controls and immutable hashes fit a phone"); await page.emulateMedia({ reducedMotion: "reduce" }); await page.addScriptTag({ content: axe.source }); const audit = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })); assert.deepEqual(audit.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) })), []);
  if (process.env.CODEFLOW_UI_SCREENSHOTS) { mkdirSync(join(root, "output/playwright"), { recursive: true }); await page.screenshot({ path: join(root, "output/playwright/filtered-task-mobile.png") }); }
  await panel.getByRole("button", { name: "Delete private task and export", exact: true }).click(); await panel.getByText("Private task/export deleted; any imported review branch is preserved.", { exact: true }).waitFor(); assert.equal(git("rev-parse", `codeflow/${id}`) !== before, true); assert.deepEqual(await fetch(`${base}/api/filtered-tasks`, { headers }).then((response) => response.json()), []);
});
test("filtered task cancellation waits for the owned daemon receipt and permits explicit private cleanup", async () => {
  const panel = page.getByRole("region", { name: "Filtered Docker tasks", exact: true });
  await panel.getByLabel("Filtered task instructions", { exact: true }).fill("linger until I cancel this task");
  await panel.getByRole("button", { name: "Start filtered Docker task", exact: true }).click();
  // Preparation includes Git and Docker probes; wait for the daemon receipt rather
  // than assuming those processes can all start within five seconds on a busy host.
  const running = () => readdirSync(state).some((name) => name.endsWith(".json"));
  const deadline = Date.now() + 30_000;
  while (!running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(running(), `a fixture daemon child actually runs: ${await panel.innerText()}`);
  await panel.getByRole("button", { name: "Cancel task and confirm container stopped", exact: true }).click();
  await panel.getByText(/^Filtered task status: cancelled/).waitFor();
  assert.equal(readdirSync(state).filter((name) => name.endsWith(".json")).length, 0);
  await panel.getByRole("button", { name: "Delete private task and export", exact: true }).click();
  await panel.getByText("Private task/export deleted; any imported review branch is preserved.", { exact: true }).waitFor();
});
