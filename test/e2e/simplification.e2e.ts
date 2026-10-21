import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";

import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = await new Promise<number>((resolve) => { const listener = createServer().listen(0, "127.0.0.1", () => { const port = (listener.address() as AddressInfo).port; listener.close(() => resolve(port)); }); });
const folder = mkdtempSync(join(tmpdir(), "codeflow-simplification-ui-"));
const repo = join(folder, "repo");
execFileSync("mkdir", [repo]);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
writeFileSync(join(repo, "asset.bin"), Buffer.from([137, 80, 78, 71, 0, 1]));
writeFileSync(join(repo, "large.txt"), "Large file preview\n".repeat(40000));
writeFileSync(join(repo, "README.md"), "Title\n=======\n\nFixture documentation.\n");
writeFileSync(join(repo, "sum.mjs"), "export function sum(a, b) { return a - b; }\n");
writeFileSync(join(repo, "sum.test.mjs"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(1, 2), 3));\n");
git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
writeFileSync(join(repo, "sum.mjs"), "export function sum(a, b) { return a + b; }\n");
git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "fix sum");
const base = `http://localhost:${port}`;
let server: ChildProcess, browser: Browser, page: Page;
before(async () => {
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(folder, "data"), CODEFLOW_TOKEN: "simplification-ui-token", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  let healthy = false;
  for (let n = 0; n < 150; n++) { healthy = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer simplification-ui-token" } }).then((response) => response.ok, () => false); if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(healthy);
  const project = await fetch(`${base}/api/projects`, { method: "POST", headers: { authorization: "Bearer simplification-ui-token", "content-type": "application/json" }, body: JSON.stringify({ name: "Simplification fixture", repos: [repo] }) });
  assert.equal(project.status, 201);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((repo) => localStorage.setItem("repo", repo), repo);
  await page.goto(`${base}/#/settings/workspace`);
  await page.getByRole("heading", { name: "Inspect, verify, and recover" }).waitFor();
  await page.waitForFunction(() => !!(document.querySelector("#wb-folder") as HTMLSelectElement)?.value);
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (server?.exitCode !== null) return resolve(); server?.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(folder, { recursive: true, force: true }); });


const errors: string[] = [];
test("Connections consolidates old bookmarks and keeps access setup discoverable with an optional Board shortcut", { timeout: 45_000 }, async () => {
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#/settings/ssh`);
  await page.getByRole("navigation", { name: "Connection purpose" }).getByRole("link", { name: "Work on another computer" }).waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: "Connections", exact: true }).count(), 1);
  await page.getByRole("link", { name: "Delegate execution", exact: true }).click();
  await page.getByRole("heading", { name: /Remote workers/ }).waitFor();
  await page.goto(`${base}/#/settings/team`);
  const toggle = page.getByLabel("Show Board in the app menu");
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await page.getByRole("link", { name: "Open Board" }).waitFor();
  await page.reload();
  assert.equal(await toggle.isChecked(), true);
  await toggle.uncheck();
  assert.equal(await page.getByRole("link", { name: "Open Board" }).count(), 1, "navigation preference never hides access setup");
});

test("one template library restores complete saved configurations and keeps legacy workflows", { timeout: 45_000 }, async () => {
  await page.goto(`${base}/#/`);
  await page.getByRole("button", { name: "Template library", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Template library", exact: true });
  await dialog.getByLabel("Template", { exact: true }).selectOption("starter-explore");
  await dialog.getByRole("button", { name: "Use template", exact: true }).click();
  assert.equal(await page.getByLabel("Workflow", { exact: true }).inputValue(), "debate");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("roleSel")!).debate.builder), []);
  await page.evaluate(() => {
    const config = { pattern: "solo", roles: { agent: ["codex"] }, options: {}, agentSettings: { codex: { model: "gpt-5" } }, roleSettings: {}, trust: "safe", limits: { maxMinutes: 23, maxSteps: 17 }, approvePlan: false, toolApprovals: true, check: "node --test", setup: "", baseRef: "main" };
    localStorage.setItem("composerLibrary", JSON.stringify({ schemaVersion: 1, presets: [{ id: "legacy", name: "Old workflow", revision: 1, updatedAt: 1, config, history: [] }], templates: [{ id: "complete", name: "Full task", pattern: "solo", task: "Review {{component}}", criteria: ["Keep behavior"], config, runOptions: { verification: "", container: { enabled: false, image: "", authVolume: "" } } }] }));
  });
  await page.getByRole("button", { name: "Template library", exact: true }).click();
  await dialog.getByLabel("Library", { exact: true }).selectOption("personal");
  await dialog.getByLabel("Template", { exact: true }).selectOption("saved:complete");
  await dialog.getByLabel("component", { exact: true }).fill("sum");
  await dialog.getByRole("button", { name: "Use template", exact: true }).click();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Review sum");
  assert.match(await page.getByLabel("Run configuration summary").innerText(), /17 calls · 23 minutes/);
  await page.getByRole("button", { name: "Run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save as template…", exact: true }).click();
  const save = page.getByRole("dialog", { name: "Save as template", exact: true });
  await save.getByLabel("Template name", { exact: true }).fill("Roundtrip");
  await save.getByLabel("Save to").selectOption("personal");
  await save.getByRole("button", { name: "Save template", exact: true }).click();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("composerLibrary")!).templates.find((item: any) => item.name === "Roundtrip"));
  assert.equal(stored.config.agentSettings.codex.model, "gpt-5");
  assert.equal(stored.config.check, "node --test"); assert.equal(stored.config.toolApprovals, true);
  assert.deepEqual(stored.runOptions.container, { enabled: false, image: "", authVolume: "" });
  await page.getByRole("button", { name: "Template library", exact: true }).click();
  await dialog.getByLabel("Template", { exact: true }).selectOption("workflow:legacy");
  await dialog.getByRole("button", { name: "Use template", exact: true }).click();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Review sum");
});

test("templates wait for repository configuration before restoring check commands", { timeout: 45_000 }, async () => {
  let release!: () => void;
  const loading = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/repo-config?*", async request => { await loading; await request.continue(); });
  try {
    const requested = page.waitForRequest("**/api/repo-config?*");
    await page.reload(); await requested;
    await page.getByText("Restoring your project draft…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Template library", exact: true }).count(), 0, "restoring blocks editing a partial draft");
    release();
    await page.getByRole("button", { name: "Template library", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Template library", exact: true });
    await dialog.getByLabel("Library", { exact: true }).selectOption("personal");
    await dialog.getByLabel("Template", { exact: true }).selectOption({ label: "Roundtrip" });
    const apply = dialog.getByRole("button", { name: "Use template", exact: true });
    await apply.click();
    assert.match(await page.getByLabel("Run configuration summary").innerText(), /node --test/);
  } finally { release(); await page.unroute("**/api/repo-config?*"); }
});

test("scheduling shares four purposes and comparisons live in Insights", { timeout: 45_000 }, async () => {
  await page.getByRole("button", { name: "Run actions", exact: true }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Compare setups…", exact: true }).count(), 0);
  await page.getByRole("menuitem", { name: "Schedule…", exact: true }).click();
  const choices = page.getByRole("dialog", { name: "Schedule work", exact: true });
  await choices.getByRole("button", { name: /Run once later/ }).click();
  await page.getByRole("dialog", { name: "Start later", exact: true }).waitFor();
  await page.getByRole("dialog", { name: "Start later", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`${base}/#/automations/once`);
  await page.getByRole("navigation", { name: "Scheduling purpose" }).waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Scheduling purpose" }).getByRole("link").count(), 4);
  await page.getByRole("region", { name: "Deferred runs", exact: true }).waitFor();
  await page.getByRole("link", { name: "Process a backlog", exact: true }).click();
  await page.getByRole("heading", { name: "Scheduled backlog work", exact: true }).waitFor();
  await page.getByRole("link", { name: "Pursue a mission", exact: true }).click();
  await page.getByText("Choose a project to create or manage its missions.").waitFor();
  await page.goto(`${base}/#/`);
  await page.getByLabel("Task", { exact: true }).fill("Compare this task");
  await page.getByRole("button", { name: "Application menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Insights", exact: true }).click();
  await page.getByText("Experiments", { exact: true }).click();
  await page.getByRole("button", { name: "Compare setups…", exact: true }).click();
  await page.getByRole("dialog", { name: "Compare setups", exact: true }).waitFor();
  await page.keyboard.press("Escape");
});

test("side-panel and repository tools share file editing and draft recovery", { timeout: 45_000 }, async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/#/`);
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Files", exact: true });
  await panel.getByLabel("File to edit").fill("README.md");
  await panel.getByRole("button", { name: "Open file", exact: true }).click();
  await panel.getByLabel("File contents").fill("Shared editor draft\n");
  assert.match(await panel.locator(".code-scope").innerText(), /repo/);
  await page.getByRole("button", { name: "Close side panel", exact: true }).click();
  await page.goto(`${base}/#/workspace`);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.locator(".workbench").getByLabel("File to edit").fill("README.md");
  await page.locator(".workbench").getByRole("button", { name: "Open file", exact: true }).click();
  assert.equal(await page.locator(".workbench").getByLabel("File contents").inputValue(), "Shared editor draft\n");
  await page.locator(".workbench").getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("status").getByText("File saved", { exact: true }).waitFor();
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "Shared editor draft\n");
});

test("typing with a large attachment avoids copying its payload and comparisons retain the draft", { timeout: 45_000 }, async () => {
  await page.goto(`${base}/#/`);
  await page.locator('.taskbox input[type="file"]').setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.alloc(2 * 1024 * 1024, "x") });
  await page.locator('.chip-ctx[title="context.txt"]').waitFor();
  await page.evaluate(() => {
    const host = window as any;
    host.payloadCopies = 0;
    host.originalStringify = JSON.stringify;
    host.originalClone = window.structuredClone;
    JSON.stringify = ((value: any, ...args: any[]) => { if (value?.context?.attachments?.some((item: any) => item.data?.length > 1024 * 1024)) host.payloadCopies++; return host.originalStringify(value, ...args); }) as typeof JSON.stringify;
    window.structuredClone = ((value: any, ...args: any[]) => { if (value?.context?.attachments?.some((item: any) => item.data?.length > 1024 * 1024)) host.payloadCopies++; return host.originalClone(value, ...args); }) as typeof structuredClone;
  });
  try {
    await page.getByLabel("Task", { exact: true }).fill("Compare attachment context");
    await page.getByLabel("Task", { exact: true }).pressSequentially(" while editing the latest draft");
    assert.equal(await page.evaluate(() => (window as any).payloadCopies), 0);
  } finally {
    await page.evaluate(() => { JSON.stringify = (window as any).originalStringify; window.structuredClone = (window as any).originalClone; });
  }
  await page.evaluate(() => { location.hash = "/insights"; });
  await page.getByText("Experiments", { exact: true }).click();
  await page.getByRole("button", { name: "Compare setups…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Compare setups", exact: true });
  await dialog.locator('.compare-choice input:checked').uncheck();
  await dialog.locator('.compare-choice:not(.off) input').nth(0).check();
  await dialog.locator('.compare-choice:not(.off) input').nth(1).check();
  let request: any;
  await page.route("**/api/compare", async route => { request = route.request().postDataJSON(); await route.fulfill({ json: { group: "fixture-comparison" } }); });
  try {
    await dialog.getByRole("button", { name: "Start 2 runs", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.match(request.run.task, /while editing the latest draft/);
    assert.equal(request.run.context.attachments[0].name, "context.txt");
    assert.equal(Buffer.from(request.run.context.attachments[0].data, "base64").length, 2 * 1024 * 1024);
  } finally { await page.unroute("**/api/compare"); }
});

test("the shared browser keeps binary and oversized files in bounded read-only previews", { timeout: 45_000 }, async () => {
  await page.goto(`${base}/#/workspace`);
  await page.getByRole("navigation", { name: "Repository tools" }).getByRole("button", { name: "Code", exact: true }).click();
  const browser = page.locator(".workbench .code-browser");
  for (const path of ["asset.bin", "large.txt"]) {
    await browser.getByLabel("File to edit", { exact: true }).fill(path);
    await browser.getByRole("button", { name: "Open file", exact: true }).click();
    const preview = browser.getByRole("region", { name: "Read-only file preview", exact: true });
    await preview.getByRole("heading", { name: path, exact: true }).waitFor();
    assert.equal(await browser.getByRole("button", { name: "Save file", exact: true }).count(), 0);
    if (path === "asset.bin") await preview.getByText("This is a binary file.", { exact: true }).waitFor();
    else {
      await preview.getByText("Showing a bounded preview; the rest of the file is omitted.", { exact: true }).waitFor();
      assert.ok((await preview.locator("pre").innerText()).length <= 512 * 1024);
      assert.ok((await preview.locator("pre").innerText()).split("\n").length <= 5000);
    }
  }
});

test("revised hubs and template picker fit phones and have no serious accessibility errors", { timeout: 45_000 }, async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["#/automations/once", "#/automations/repeat", "#/automations/backlog", "#/settings/connections/workspace", "#/settings/connections/sharing", "#/"]) {
    await page.goto(`${base}/${route}`);
    await page.locator("#main-content").waitFor();
    if (route === "#/") await page.getByRole("button", { name: "Template library", exact: true }).click();
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] }));
    assert.deepEqual(result.violations.filter((item: any) => ["serious", "critical"].includes(item.impact)).map((item: any) => ({ id: item.id, targets: item.nodes.map((node: any) => node.target) })), [], route);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, route);
  }
  assert.deepEqual(errors, []);
});
