import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = await new Promise<number>((resolve) => { const listener = createServer().listen(0, "127.0.0.1", () => { const port = (listener.address() as AddressInfo).port; listener.close(() => resolve(port)); }); });
const folder = mkdtempSync(join(tmpdir(), "codeflow-workspace-ui-"));
const repo = join(folder, "repo");
execFileSync("mkdir", [repo]);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }));
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
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(folder, "data"), CODEFLOW_TOKEN: "workspace-ui-token", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  let healthy = false;
  for (let n = 0; n < 150; n++) { healthy = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer workspace-ui-token" } }).then((response) => response.ok, () => false); if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(healthy);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((repo) => localStorage.setItem("repo", repo), repo);
  await page.goto(`${base}/#/settings/workspace`);
  await page.getByRole("heading", { name: "Inspect, verify, and recover" }).waitFor();
  await page.waitForFunction(() => !!(document.querySelector("#wb-folder") as HTMLSelectElement)?.value);
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (server?.exitCode !== null) return resolve(); server?.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(folder, { recursive: true, force: true }); });

test("workspace verification runs real isolated gates and exports their evidence", async () => {
  await page.getByRole("button", { name: "Detect checks", exact: true }).click();
  await page.getByLabel("Compare baseline").fill("HEAD~1");
  await page.getByRole("button", { name: "Run verification", exact: true }).click();
  await page.getByRole("heading", { name: "Result: verified", exact: true }).waitFor({ timeout: 30000 });
  assert.match(readFileSync(join(repo, "sum.mjs"), "utf8"), /a \+ b/);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export report", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "verification.md");
  await page.getByRole("button", { name: "Add custom gate", exact: true }).click();
  await page.getByLabel("Command for custom-2").fill("node -e 'process.exit(1)'");
  await page.getByRole("button", { name: "Run verification", exact: true }).click();
  await page.getByRole("heading", { name: "Result: needs-changes", exact: true }).waitFor({ timeout: 30000 });
});

test("workspace editing preserves a conflicting draft, searches definitions, and inspects imports", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("File to edit").fill("sum.mjs");
  await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByLabel("File contents").fill("export function sum(a, b) { return a + b + 0; }\n");
  writeFileSync(join(repo, "sum.mjs"), "export function sum(a, b) { return a + b; } // concurrent\n");
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("alert").getByText(/changed since/).waitFor();
  assert.match(await page.getByLabel("File contents").inputValue(), /\+ 0/);
  await page.getByRole("button", { name: "Load current version and keep draft", exact: true }).click();
  await page.getByRole("heading", { name: "Current file", exact: true }).waitFor();
  assert.match(await page.getByLabel("File contents").inputValue(), /<<<<<<< Current file/);
  assert.equal(await page.getByRole("button", { name: "Save file", exact: true }).isDisabled(), true);
  await page.getByLabel("File contents").fill("export function sum(a, b) { return a + b + 0; } // concurrent\n");
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("status").getByText("File saved", { exact: true }).waitFor();
  assert.match(readFileSync(join(repo, "sum.mjs"), "utf8"), /\+ 0/);
  await page.getByLabel("Code search mode").selectOption("symbols");
  await page.getByLabel("Search code", { exact: true }).fill("sum");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /sum\.mjs:1 sum/ }).waitFor();
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  await page.getByRole("button", { name: "Inspect dependencies", exact: true }).click();
  await page.getByRole("cell").getByRole("button", { name: "sum.test.mjs", exact: true }).waitFor();
  await page.goto(`${base}/#/settings/advanced`);
  writeFileSync(join(folder, "data", "server.log"), `old-log-marker\n${"x".repeat(1_000_000)}\ncurrent-log-marker\n`);
  await page.getByRole("button", { name: "Collect diagnostics", exact: true }).click();
  await page.getByRole("button", { name: "Export diagnostics", exact: true }).waitFor();
  await page.getByText("Collected diagnostics", { exact: true }).click();
  const diagnostics = await page.locator(".settings-content pre").innerText();
  assert.match(diagnostics, /current-log-marker/); assert.doesNotMatch(diagnostics, /old-log-marker/);
});

test("ordinary Markdown dividers do not block file saves or tab draft recovery", async () => {
  await page.goto(`${base}/#/settings/workspace`);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("File to edit").fill("README.md"); await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("heading", { name: "README.md", exact: true }).waitFor();
  await page.getByLabel("File contents").fill("Title\n=======\n\nRecovered documentation draft.\n");
  await page.getByRole("button", { name: "New run", exact: true }).click();
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("File to edit").fill("README.md"); await page.getByRole("button", { name: "Open file", exact: true }).click();
  await page.getByRole("heading", { name: "README.md", exact: true }).waitFor();
  assert.match(await page.getByLabel("File contents").inputValue(), /Recovered documentation draft/);
  assert.equal(await page.getByRole("button", { name: "Save file", exact: true }).isDisabled(), false);
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("status").getByText("File saved", { exact: true }).waitFor();
  assert.match(readFileSync(join(repo, "README.md"), "utf8"), /Title\n=======/);
});

test("workspace resolves saved JavaScript symbols and imported references", async () => {
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("Code search mode").selectOption("semantic");
  await page.getByLabel("Search code", { exact: true }).fill("sum");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const declaration = page.locator("p", { has: page.getByRole("button", { name: "sum.mjs:1 sum", exact: true }) });
  await declaration.getByRole("button", { name: "Find references to sum", exact: true }).click();
  await page.getByText(/references in 2 saved source files/).waitFor();
  assert.ok(await page.getByRole("button", { name: /^sum\.test\.mjs:\d+$/ }).count());
});
