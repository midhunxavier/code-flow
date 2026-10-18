import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "cf-settings-"));
const port = await new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
const base = `http://localhost:${port}`;
let server: ChildProcess, browser: Browser, page: Page;
const errors: string[] = [];
before(async () => {
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: directory, CODEFLOW_TOKEN: "settings-test", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let n = 0; n < 150; n++) { if (await fetch(`${base}/api/health`, { headers: { authorization: "Bearer settings-test" } }).then((res) => res.ok, () => false)) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (server?.exitCode !== null) return resolve(); server?.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(directory, { recursive: true, force: true }); });
const category = (name: string) => page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name, exact: true }).click();

test("settings navigation, search, appearance, and run defaults persist and drive the composer", async () => {
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "System", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByLabel("Search settings").fill("vm");
  await page.getByRole("region", { name: "Settings search results" }).getByRole("button", { name: /SSH connections/ }).click();
  assert.ok(page.url().endsWith("#/settings/ssh"));
  await page.goBack();
  await page.getByRole("heading", { name: "General", exact: true }).waitFor();
  await page.getByLabel("Search settings").fill("no-such-setting-9283");
  await page.getByText("No matching settings").waitFor();
  await page.getByRole("button", { name: "Clear search" }).click();
  await category("Run defaults");
  await page.getByLabel("Default workflow").selectOption("pipeline");
  await page.getByLabel("Agent permissions", { exact: true }).selectOption("safe");
  await page.getByLabel("Minutes per run").fill("37");
  await page.getByLabel("Agent steps per run").fill("18");
  await page.getByLabel("Agent steps per run").blur();
  await page.reload();
  assert.equal(await page.getByLabel("Minutes per run").inputValue(), "37");
  assert.equal(await page.getByLabel("Agent steps per run").inputValue(), "18");
  await page.getByLabel("Minutes per run").fill("9000");
  await page.getByLabel("Minutes per run").blur();
  assert.equal(await page.getByLabel("Minutes per run").inputValue(), "37");
  await page.getByRole("button", { name: "New run", exact: true }).click();
  await page.locator("details.advanced-controls > summary").click();
  await page.locator("details.settings > summary").filter({ has: page.locator(".st", { hasText: /^Settings$/ }) }).click();
  assert.equal(await page.locator("#maxMinutes").inputValue(), "37");
  assert.equal(await page.locator("#maxSteps").inputValue(), "18");
  assert.equal(await page.getByRole("radio", { name: "Safe", exact: true }).getAttribute("aria-checked"), "true");
  await page.keyboard.press("Control+,");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
});

test("desktop notification controls stay synchronized with the sidebar and survive reload", async () => {
  await page.context().grantPermissions(["notifications"]);
  await page.goto(`${base}/`);
  await page.reload();
  await page.getByRole("button", { name: "New run", exact: true }).waitFor();
  await page.keyboard.press("Control+,");
  await category("Notifications");
  const toggle = page.getByRole("switch", { name: "Desktop notifications", exact: true });
  const bell = page.getByRole("button", { name: "Notifications", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  assert.equal(await bell.getAttribute("aria-pressed"), "false");
  await bell.click();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await page.reload();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
});

test("saved SSH connections survive reload, reject invalid ports, and retain a connection after open failure", async () => {
  await page.goto(`${base}/#/settings/ssh`);
  await page.getByLabel("SSH host", { exact: true }).fill("developer@vm.invalid");
  await page.getByLabel("Display name").fill("Development VM");
  await page.getByLabel("SSH port", { exact: true }).fill("70000");
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  assert.equal(await page.getByLabel("SSH port", { exact: true }).evaluate((input: HTMLInputElement) => input.validity.valid), false);
  await page.getByLabel("SSH port", { exact: true }).fill("2222");
  await page.getByLabel("Identity file").fill("~/.ssh/my vm key");
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await page.getByRole("button", { name: "Open Development VM", exact: true }).waitFor();
  await page.reload();
  await page.getByText("developer@vm.invalid:2222 · disconnected").waitFor();
  await page.getByText("~/.ssh/my vm key", { exact: true }).waitFor();
  await page.route("**/api/ssh-hosts/*/connect", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "SSH host key verification failed. Verify the VM in a terminal first." }) }));
  await page.getByLabel("SSH host", { exact: true }).fill("other@vm.invalid");
  await page.getByLabel("Display name").fill("Retry VM");
  await page.getByRole("button", { name: "Connect and open", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "host key verification failed" }).waitFor();
  await page.getByRole("button", { name: "Open Retry VM", exact: true }).waitFor();
  assert.equal(await page.locator(".ssh-connections article").count(), 2);
  await page.getByRole("button", { name: "Open Retry VM", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "host key verification failed" }).waitFor();
  assert.equal(await page.locator(".ssh-connections article").count(), 2);
  await page.unroute("**/api/ssh-hosts/*/connect");
  await page.locator(".ssh-connections article").filter({ hasText: "Retry VM" }).getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Open Retry VM", exact: true }).waitFor({ state: "hidden" });
});

test("all settings categories render; desktop and mobile preferences are accessible", async () => {
  await page.goto(`${base}/#/settings`);
  for (const name of ["Agents & models", "Notifications", "Remote access", "Integrations", "Workspace", "Insights", "Automations", "Projects & access", "Extensions", "Data & storage", "Advanced"]) {
    await category(name);
    await page.getByRole("heading", { name, exact: true }).first().waitFor();
  }
  await category("General");
  await page.addScriptTag({ content: axe.source });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ["General", "SSH connections", "Run defaults", "Automations", "Workspace", "Insights"]) {
      await category(name);
      const violations = await page.evaluate(async () => (await (window as any).axe.run(".settings-page", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations);
      assert.deepEqual(violations.map((v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(" ")).join(", ")}`), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflows at ${width}`);
    }
  }
  assert.deepEqual(errors, []);
});


test("Workspace, Insights and Automations have one destination inside Settings", async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/#/workspace`);
  const names = ["Verification", "Code", "Dependencies", "Context", "History", "Services", "Coordinated changes", "Filtered tasks"];
  const tools = page.getByRole("navigation", { name: "Workspace tools" });
  await tools.waitFor();
  assert.deepEqual(await tools.getByRole("button").allTextContents(), names);
  assert.deepEqual(await page.getByLabel("Workspace tool", { exact: true }).locator("option").allTextContents(), names);
  assert.ok(page.url().endsWith("#/settings/workspace"));
  for (const name of ["Workspace", "Insights", "Automations"]) assert.equal(await page.getByRole("navigation", { name: "Runs", exact: true }).getByRole("button", { name, exact: true }).count(), 0);
  await category("Automations");
  await page.getByRole("region", { name: "Deferred runs", exact: true }).waitFor();
  assert.ok(page.url().endsWith("#/settings/automations"));
  assert.equal(await page.getByRole("checkbox", { name: "Enable remote access", exact: true }).count(), 0);
  await page.getByRole("link", { name: "Remote access settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enable remote access", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Automations", exact: true }).waitFor();

  await page.goto(`${base}/#/workspace`);
  await tools.waitFor();
  await page.evaluate(() => { location.hash = "/automations"; });
  await page.getByRole("heading", { name: "Automations", exact: true }).waitFor();
  assert.ok(page.url().endsWith("#/settings/automations"), "legacy deep links canonicalize to Settings");
  await page.goBack();
  await tools.waitFor();
  await page.keyboard.press("a");
  await page.getByRole("heading", { name: "Automations", exact: true }).waitFor();
  assert.ok(page.url().endsWith("#/settings/automations"), "keyboard shortcut opens Settings");
  await page.keyboard.press("i");
  await page.getByRole("heading", { name: "Insights", exact: true }).waitFor();
  assert.ok(page.url().endsWith("#/settings/insights"));
  await page.evaluate(() => { location.hash = "/insights/comparison%2F1"; });
  await page.waitForURL("**/#/settings/insights/comparison%2F1");
  await page.reload();
  await page.getByRole("heading", { name: "Insights", exact: true }).waitFor();
  assert.ok(page.url().endsWith("#/settings/insights/comparison%2F1"));
  for (const name of ["Workspace", "Insights", "Automations"]) {
    await page.getByRole("button", { name: "Open command palette", exact: true }).click();
    await page.getByRole("combobox", { name: "Find a command, project or run" }).fill(name);
    const commands = page.getByRole("listbox", { name: "Matching commands" });
    await commands.getByRole("option", { name: new RegExp(`^${name} Settings`) }).waitFor();
    assert.equal(await commands.getByRole("option").count(), 1, `the command palette has no duplicate ${name} entry`);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name, exact: true }).waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("region", { name: "Deferred runs", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
