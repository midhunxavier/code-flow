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

test("Kilo and Cline presets connect through ACP, preserve edited invocations, and appear in model settings", async () => {
  for (const [name, command, args, login, scenario] of [
    ["Kilo", "kilo", "acp", "kilo auth login", "happy"],
    ["Cline", "cline", "--acp", "cline auth", "cline"],
  ] as const) {
    await page.goto(`${base}/#/settings/general`);
    await page.getByRole("heading", { name: "General", exact: true }).waitFor();
    await page.getByLabel("Search settings").fill(name);
    await page.getByRole("region", { name: "Settings search results" }).getByRole("button", { name: /Agents & models/ }).click();
    const panel = page.getByRole("region", { name: "ACP connections", exact: true });
    await panel.getByRole("button", { name: `Connect ${name}`, exact: true }).click();
    assert.equal(await panel.getByLabel("ACP connection ID").inputValue(), command);
    assert.equal(await panel.getByLabel("ACP executable").inputValue(), command);
    assert.equal(await panel.getByLabel("ACP arguments").inputValue(), args);
    await panel.getByText(login, { exact: true }).waitFor();
    if (name === "Cline") await panel.getByText(/Cline asks before edits and commands/).waitFor();
    // Keep preset identity but use the deterministic process fixture in browser CI.
    await panel.getByLabel("ACP executable").fill(process.execPath);
    const fixtureArgs = `${join(root, "test/fake-acp.mjs")}\n${scenario}`;
    await panel.getByLabel("ACP arguments").fill(fixtureArgs);
    await panel.getByRole("button", { name: "Check connection", exact: true }).click();
    await panel.getByText(`${name}: connected`, { exact: true }).waitFor();
    await panel.getByText(/2 models/).waitFor();
    await panel.getByRole("button", { name: "Save connection", exact: true }).click();
    await page.getByLabel(`${name} model`, { exact: true }).click();
    await page.getByRole("combobox", { name: /^Search / }).fill("fixture/model-b");
    await page.getByRole("listbox").getByRole("option").click();
    await page.reload();
    assert.match(await page.getByLabel(`${name} model`, { exact: true }).textContent() ?? "", /Model B/i);
    await panel.getByRole("button", { name: `Connect ${name}`, exact: true }).click();
    assert.equal(await panel.getByLabel("ACP connection ID").getAttribute("readonly"), "");
    assert.equal(await panel.getByLabel("ACP executable").inputValue(), process.execPath);
    assert.equal(await panel.getByLabel("ACP arguments").inputValue(), fixtureArgs);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.getByRole("button", { name: "Save connection", exact: true }).click();
    assert.equal(await panel.getByRole("button", { name: `Edit ${name}`, exact: true }).count(), 1);
    await panel.getByRole("button", { name: `Disable ${name}`, exact: true }).click();
    await page.getByLabel(`${name} model`, { exact: true }).waitFor({ state: "detached" });
    await panel.getByRole("button", { name: `Enable ${name}`, exact: true }).click();
    await page.getByLabel(`${name} model`, { exact: true }).waitFor();
    await panel.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
    await panel.getByRole("button", { name: `Edit ${name}`, exact: true }).waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  assert.deepEqual(errors, []);
});

test("ACP settings connect, discover models, persist, edit, disable and remove a compatible CLI", async () => {
  await page.goto(`${base}/#/settings/agents`);
  const panel = page.getByRole("region", { name: "ACP connections", exact: true });
  await panel.getByRole("button", { name: "Connect OpenCode", exact: true }).click();
  assert.equal(await panel.getByLabel("ACP executable").inputValue(), "opencode");
  assert.equal(await panel.getByLabel("ACP arguments").inputValue(), "acp");
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByRole("button", { name: "Add compatible CLI", exact: true }).click();
  await panel.getByLabel("ACP connection ID").fill("fixture");
  await panel.getByLabel("ACP connection name").fill("Fixture ACP");
  await panel.getByLabel("ACP executable").fill(process.execPath);
  await panel.getByLabel("ACP arguments").fill(`${join(root, "test/fake-acp.mjs")}\nhappy`);
  await panel.getByRole("button", { name: "Check connection", exact: true }).click();
  await panel.getByText("Fixture ACP: connected", { exact: true }).waitFor();
  await panel.getByText(/2 models/).waitFor();
  await panel.getByRole("button", { name: "Save connection", exact: true }).click();
  await page.getByLabel("Fixture ACP model", { exact: true }).click();
  await page.getByRole("combobox", { name: /^Search / }).fill("fixture/model-b");
  await page.getByRole("listbox").getByRole("option").click();
  await page.reload();
  assert.match(await page.getByLabel("Fixture ACP model", { exact: true }).textContent() ?? "", /Model B/i);
  await panel.getByRole("button", { name: "Edit Fixture ACP", exact: true }).click();
  assert.equal(await panel.getByLabel("ACP connection ID").getAttribute("readonly"), "");
  await panel.getByLabel("ACP connection name").fill("Renamed ACP");
  await panel.getByRole("button", { name: "Save connection", exact: true }).click();
  await page.getByLabel("Renamed ACP model", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Disable Renamed ACP", exact: true }).click();
  await page.getByLabel("Renamed ACP model", { exact: true }).waitFor({ state: "detached" });
  await panel.getByRole("button", { name: "Enable Renamed ACP", exact: true }).click();
  await page.getByLabel("Renamed ACP model", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "Edit Renamed ACP", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const screenshots = process.env.CODEFLOW_TEST_SCREENSHOTS ?? directory;
  await page.screenshot({ path: join(screenshots, "acp-mobile.png"), fullPage: true });
  await page.addScriptTag({ content: axe.source });
  const accessibility = await page.evaluate(async () => (window as any).axe.run({ include: [".acp-connection-form"] }, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] }));
  assert.deepEqual(accessibility.violations.filter((item: any) => ["serious", "critical"].includes(item.impact)).map((item: any) => item.id), []);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#main-content").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: join(screenshots, "acp-desktop.png"), fullPage: true });
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByRole("button", { name: "Remove Renamed ACP", exact: true }).click();
  await panel.getByRole("button", { name: "Edit Renamed ACP", exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
});

test("settings navigation, search, appearance, and run defaults persist and drive the composer", async () => {
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: "Application menu", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Settings/ }).click();
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
  await page.locator(".composer-options > summary").click();
  await page.locator("details.advanced-controls > summary").click();
  await page.locator("details.settings > summary").filter({ has: page.locator(".st", { hasText: /^Branches and limits$/ }) }).click();
  assert.equal(await page.locator("#maxMinutes").inputValue(), "37");
  assert.equal(await page.locator("#maxSteps").inputValue(), "18");
  assert.match(await page.locator(".taskbox").getByRole("button", { name: "Permissions", exact: true }).innerText(), /Safe/);
  await page.keyboard.press("Control+,");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
});

test("desktop notification preferences are reachable from the app menu and survive reload", async () => {
  await page.context().grantPermissions(["notifications"]);
  await page.goto(`${base}/`);
  await page.reload();
  await page.getByRole("button", { name: "New run", exact: true }).waitFor();
  await page.keyboard.press("Control+,");
  await category("Notifications");
  const toggle = page.getByRole("switch", { name: "Desktop notifications", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.getByRole("button", { name: "Application menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Notifications", exact: true }).click();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
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
  await page.getByRole("button", { name: "SSH connections", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Development VM/ }).click();
  const switcher = page.getByRole("menu", { name: "SSH connections", exact: true });
  await switcher.getByRole("alert").filter({ hasText: "host key verification failed" }).waitFor();
  assert.ok(page.url().endsWith("#/settings/ssh"), "failed switching leaves the current workspace open");
  assert.equal(await switcher.getByLabel("SSH host", { exact: true }).count(), 0);
  await page.keyboard.press("Escape");
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
