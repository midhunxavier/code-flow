import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "cf-accessibility-")), repo = join(directory, "repo"); mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }); git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Accessible fixture"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
const port = await new Promise<number>((resolve) => { const listener = createServer().listen(0, "127.0.0.1", () => { const port = (listener.address() as AddressInfo).port; listener.close(() => resolve(port)); }); });
const base = `http://localhost:${port}`, bearer = { authorization: "Bearer accessibility-fixture" };
let server: ChildProcess, browser: Browser, page: Page, runId: string, startupLog = "";
before(async () => {
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "accessibility-fixture", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk) => { startupLog = (startupLog + chunk.toString()).slice(-16000); });
  let healthy = false; for (let n = 0; n < 150; n++) { healthy = await fetch(`${base}/api/health`, { headers: bearer }).then((response) => response.ok, () => false); if (healthy) break; if (server.exitCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.ok(healthy, startupLog);
  const response = await fetch(`${base}/api/runs`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ repo, task: "Accessibility result fixture", pattern: "solo", roles: { agent: ["claude"] }, loop: { check: "true", setup: "", copy: [] }, trust: "safe" }) }); assert.equal(response.status, 201); runId = (await response.json()).id;
  for (let n = 0; n < 200; n++) { const run = await fetch(`${base}/api/runs/${runId}`, { headers: bearer }).then((response) => response.json()); if (run.status !== "running") break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await page.addInitScript((repo) => localStorage.setItem("repo", repo), repo); await page.goto(`${base}/?token=accessibility-fixture`); await page.getByRole("button", { name: "New run", exact: true }).waitFor();
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (server?.exitCode !== null) return resolve(); server?.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(directory, { recursive: true, force: true }); });
const findings: { screen: string; violations: any[]; incomplete: any[] }[] = [];
async function audit(screen: string) {
  // The reduced-motion rule gives every element an `all .01ms` transition, so a theme switch or state change settles only on the next frame; axe caches styles per node and would mix old and new colors.
  await page.evaluate(async () => { for (;;) { document.documentElement.getBoundingClientRect(); const running = document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().endTime !== Infinity); if (!running.length) break; await Promise.all(running.map((animation) => animation.finished.catch(() => undefined))); } });
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
  const compact = (values: typeof result.violations) => values.map((item) => ({ id: item.id, impact: item.impact, help: item.help, nodes: item.nodes.map((node) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary })) }));
  findings.push({ screen, violations: compact(result.violations), incomplete: compact(result.incomplete) });
  mkdirSync(join(root, "output/playwright"), { recursive: true }); writeFileSync(join(root, "output/playwright/accessibility.json"), JSON.stringify(findings, null, 2));
}
test("main screens, workspace tools and dialogs pass automatic accessibility checks in light/dark and mobile layouts", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const [route, name] of [["", "composer"], ["/insights", "insights"], ["/automations", "automations"], [`/run/${runId}`, "run result"], ["/workspace", "workspace"]]) { await page.goto(`${base}/#${route}`); await page.locator("main").waitFor(); await page.waitForFunction(() => document.querySelector("main")!.textContent!.trim().length > 10); await audit(`${colorScheme} ${name}`); }
    const tabs = ["Code", "Dependencies", "Context", "History", "Conventions", "Deferred runs", "Retention", "Shared accounts", "Filesystem policy", "Code hosts", "SSH workers", "Coordinated changes", "Extensions", "Diagnostics", "Sources", "Notifications"];
    for (const tab of tabs) { await page.getByRole("navigation", { name: "Workspace tools" }).getByRole("button", { name: tab, exact: true }).click(); await audit(`${colorScheme} workspace ${tab}`); }
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    for (const tab of ["Files", "Notes", "Chat"]) { await page.getByRole("tab", { name: tab, exact: true }).click(); await page.getByRole("tabpanel").waitFor(); await audit(`${colorScheme} side panel ${tab}`); }
    await page.getByRole("button", { name: "Close side panel", exact: true }).click();
    await page.getByRole("button", { name: "Open command palette", exact: true }).click(); await page.getByRole("dialog").waitFor(); await audit(`${colorScheme} command palette`); await page.keyboard.press("Escape");
    await page.goto(`${base}/#/`); await page.locator(".repo-btn:not(.project-btn)").click(); await page.getByRole("dialog").waitFor(); await audit(`${colorScheme} folder picker`); await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/#/`); await page.locator("main").waitFor(); await audit("mobile composer"); await page.goto(`${base}/#/workspace`); await page.getByRole("heading", { name: "Inspect, verify, and recover" }).waitFor(); await audit("mobile workspace");
  await page.getByLabel("Workspace tool", { exact: true }).selectOption("dependencies"); await page.getByRole("heading", { name: "Architecture and dependencies" }).waitFor(); await audit("mobile architecture tool"); await page.getByLabel("Workspace tool", { exact: true }).selectOption("verification");
  await page.screenshot({ path: join(root, "output/playwright/accessibility-mobile.png"), fullPage: true });
  const failures = findings.filter((item) => item.violations.length); assert.deepEqual(failures, [], JSON.stringify(failures.map((item) => ({ screen: item.screen, violations: item.violations })), null, 2));
});
test("keyboard users can skip navigation, operate the command palette and recover focus after Escape", async () => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`${base}/#/`); await page.locator("main").waitFor();
  const skip = page.getByRole("link", { name: "Skip to main content" });
  for (let n = 0; n < 40 && !await skip.evaluate((element) => element === document.activeElement); n++) await page.keyboard.press("Shift+Tab");
  assert.equal(await skip.evaluate((element) => element === document.activeElement), true); await page.keyboard.press("Enter"); assert.equal(await page.evaluate(() => document.activeElement?.id), "main-content");
  const trigger = page.getByRole("button", { name: "Open command palette", exact: true }); await trigger.focus(); await page.keyboard.press("Enter"); const input = page.getByRole("combobox", { name: "Find a command, project or run" }); await input.fill("Repository workspace"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await page.getByRole("heading", { name: "Inspect, verify, and recover" }).waitFor();
  await trigger.focus(); await page.keyboard.press("Enter"); await input.waitFor(); await page.keyboard.press("Escape"); assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  await page.getByRole("button", { name: "Side panel", exact: true }).click(); const resize = page.getByRole("separator", { name: "Resize the side panel" }); await resize.focus(); await page.keyboard.press("Home"); assert.equal(await resize.getAttribute("aria-valuenow"), "300"); await page.keyboard.press("ArrowLeft"); assert.equal(await resize.getAttribute("aria-valuenow"), "324"); await page.keyboard.press("End"); assert.equal(await resize.getAttribute("aria-valuenow"), "900");
});
