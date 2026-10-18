import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, type Page, type Browser } from "playwright-core";
import { buildHost, fixture, pause, port, root } from "../ssh-project-fixture.js";

test("connect from the app, browse a remote folder, run there, reconnect and return to local work", { timeout: 180_000 }, async () => {
  buildHost(); const f = await fixture(); let server: ChildProcess | undefined, browser: Browser | undefined, page: Page | undefined;
  const localPort = await port(), base = `http://localhost:${localPort}`, token = "ssh-e2e-owner";
  try {
    server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(localPort), CODEFLOW_HOME: f.localHome, CODEFLOW_TOKEN: token, PATH: `${f.bin}:${process.env.PATH}` }, stdio: "ignore" });
    for (let i = 0; i < 150; i++) { if (await fetch(base + "/api/health", { headers: { authorization: `Bearer ${token}` } }).then((res) => res.ok, () => false)) break; await pause(200); }
    browser = await chromium.launch({ channel: "chrome", headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/?token=${token}`);
    await page.getByRole("button", { name: /^Settings/ }).click();
    await page.getByRole("link", { name: "SSH connections", exact: true }).click();
    const dialog = page.locator(".settings-content");
    await dialog.getByLabel("SSH host", { exact: true }).fill("fixture");
    await dialog.getByLabel("Display name").fill("Linux development");
    await dialog.getByLabel("SSH port", { exact: true }).fill("2222");
    await dialog.getByLabel("Identity file", { exact: true }).fill("~/.ssh/development");
    await dialog.getByRole("button", { name: "Connect and open" }).click();
    await page.getByRole("button", { name: "SSH connections", exact: true }).filter({ hasText: "SSH · Linux development" }).waitFor({ timeout: 90_000 });
    assert.notEqual(new URL(page.url()).origin, base);
    const picker = page.getByRole("dialog", { name: "Choose a repository", exact: true });
    await picker.getByRole("button", { name: "Open folder project", exact: true }).waitFor();
    assert.equal(await picker.getByLabel("Folder path").inputValue(), f.remoteHome);
    await picker.locator(".dir", { has: page.getByRole("button", { name: "Open folder project", exact: true }) }).getByRole("button", { name: "Use", exact: true }).click();
    // A closing modal still makes the composer inert until its native close runs.
    await picker.waitFor({ state: "hidden" });
    await page.locator(".repo-btn:not(.project-btn) .name", { hasText: "project" }).waitFor();
    await page.getByLabel("Workflow", { exact: true }).selectOption("pipeline");
    await page.getByLabel("Task", { exact: true }).fill("SSH E2E: work on the server");
    await page.getByRole("button", { name: /^Start run/ }).click();
    await page.locator(".runview .run-head h2", { hasText: "SSH E2E: work on the server" }).waitFor();
    const runId = page.url().split("/run/")[1]!;
    await page.getByRole("button", { name: "SSH connections", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.locator(".runview .run-head h2", { hasText: "SSH E2E: work on the server" }).waitFor();
    const run = await page.evaluate(async (id) => (await fetch(`/api/runs/${id}`)).json(), runId);
    assert.ok(run.repo.endsWith("/remote/project"));
    await page.getByRole("button", { name: "SSH connections", exact: true }).click();
    await page.getByRole("link", { name: "Back to this computer" }).click();
    await page.getByRole("button", { name: "SSH connections", exact: true }).filter({ hasText: "This computer" }).waitFor();
    assert.equal(new URL(page.url()).origin, base);
    assert.deepEqual(await page.evaluate(async () => (await fetch("/api/projects")).json()), [], "remote projects never enter local project storage");
    await page.getByRole("button", { name: "SSH connections", exact: true }).click();
    await page.getByRole("button", { name: "Open Linux development", exact: true }).waitFor();
  } catch (error) {
    console.error("SSH browser failure:", (error as Error).message, await page?.locator("body").innerText().catch(() => "page unavailable"));
    await mkdir("output/playwright", { recursive: true }); await page?.screenshot({ path: "output/playwright/ssh-project-failure.png", fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server!.kill("SIGKILL"); resolve(); }, 10000); server!.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
    await f.cleanup();
  }
});
