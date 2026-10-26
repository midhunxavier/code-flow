import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildHost, fixture, pause, port, root } from "../ssh-project-fixture.js";
let f: Awaited<ReturnType<typeof fixture>>, server: ChildProcess, browser: Browser, page: Page, base: string, host: string, log = "";
const token = "qa-ssh-clients", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, errors: string[] = [], consoleErrors: string[] = [];
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
async function api(path: string, body?: any, method = body ? "POST" : "GET") { const r = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await r.json(); assert.ok(r.ok, JSON.stringify(value)); return value; }
async function until(read: () => Promise<any>, accepts: (v: any) => boolean) { for (let n = 0; n < 150; n++) { const v = await read(); if (accepts(v)) return v; await pause(100); } assert.fail("Timed out waiting for fixture state"); }
async function shot(name: string) { if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); } }
before(async () => {
  buildHost(); f = await fixture(); const p = await port(); assert.ok(![4317, 4318].includes(p)); base = `http://127.0.0.1:${p}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(p), CODEFLOW_REMOTE_PORT: String(await port()), CODEFLOW_HOME: f.localHome, CODEFLOW_TOKEN: token, PATH: `${f.bin}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", v => log += v);
  await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean);
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`${base}/?token=${token}#/settings/connections/workspace`); await page.getByLabel("SSH host", { exact: true }).waitFor();
});
after(async () => { await browser?.close(); if (server && server.exitCode === null && server.signalCode === null) { const done = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await done; } await f?.cleanup(); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.doesNotMatch(log, /uncaughtException|unhandledRejection/); });

test("saved SSH removal confirms, cancel retains definition and confirmation gives feedback", async () => {
  await page.getByLabel("SSH host", { exact: true }).fill("qa-save.invalid"); await page.getByLabel("Display name").fill("   "); await page.getByRole("button", { name: "Save connection", exact: true }).click();
  const row = page.locator(".ssh-connections article", { hasText: "qa-save.invalid" }); await row.waitFor();
  await row.getByRole("button", { name: "Remove", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Remove SSH connection?" }); await dialog.waitFor(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal((await api("/api/ssh-hosts")).hosts.length, 1);
  await row.getByRole("button", { name: "Remove", exact: true }).click(); await dialog.getByRole("button", { name: "Remove connection", exact: true }).click(); await row.waitFor({ state: "hidden" }); assert.equal((await api("/api/ssh-hosts")).hosts.length, 0); await page.getByText("Removed qa-save.invalid", { exact: true }).waitFor();
});

test("SSH backend crash makes settings, switcher and sidebar agree and reopening restores work", { timeout: 120_000 }, async () => {
  await page.getByLabel("SSH host", { exact: true }).fill("fixture"); await page.getByLabel("Display name").fill("Crash QA"); await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await page.getByRole("button", { name: "Open Crash QA", exact: true }).waitFor(); host = (await api("/api/ssh-hosts")).hosts[0].id;
  await page.getByRole("button", { name: "Open Crash QA", exact: true }).click(); await page.waitForURL(url => url.pathname === `/computer/${host}/`);
  await page.goto(`${base}/#/settings/connections/workspace`); const row = page.locator(".ssh-connections article", { hasText: "Crash QA" }); await row.waitFor();
  const runtimeFile = join(f.remoteHome, ".codeflow/ssh-host/runtime.json"), before = JSON.parse(await readFile(runtimeFile, "utf8")); process.kill(before.pid, "SIGKILL");
  await until(() => row.innerText(), v => v.includes("unavailable")); assert.equal((await api("/api/ssh-hosts")).hosts[0].state, "unavailable"); assert.equal((await api(`/computer/${host}/api/ssh-context`)).connected, false);
  await row.getByText(/Connection interrupted/).waitFor(); assert.equal(await row.getByRole("button", { name: "Stop backend", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: /^SSH connections:/ }).click(); await page.getByRole("menuitem", { name: /Crash QA.*unavailable/ }).waitFor(); await page.keyboard.press("Escape"); await page.getByRole("group", { name: "Crash QA projects", exact: true }).getByText("Connection unavailable", { exact: true }).waitFor({ timeout: 30_000 }); await shot("ssh-backend-unavailable");
  await row.getByRole("button", { name: "Open Crash QA", exact: true }).click(); await page.waitForURL(url => url.pathname === `/computer/${host}/`); await page.getByRole("button", { name: /^SSH connections:/ }).filter({ hasText: "Crash QA" }).waitFor();
  const next = JSON.parse(await readFile(runtimeFile, "utf8")); assert.notEqual(next.pid, before.pid); assert.equal((await api("/api/ssh-hosts")).hosts[0].state, "connected");
  await page.goto(`${base}/#/settings/connections/workspace`); await row.waitFor(); await row.getByRole("button", { name: "Remove", exact: true }).click(); await page.getByRole("dialog", { name: "Remove SSH connection?" }).getByRole("button", { name: "Remove connection", exact: true }).click(); await row.waitFor({ state: "hidden" }); assert.doesNotThrow(() => process.kill(next.pid, 0), "removing connection preserves remote work");
});

test("Manage connections has a visible and accessible selected state", async () => {
  await page.goto(`${base}/#/settings/connections/manage`); const link = page.getByRole("link", { name: "Manage existing connections and access", exact: true }); await link.waitFor(); assert.equal(await link.getAttribute("aria-current"), "page"); await page.getByRole("heading", { name: "Manage existing connections and access", exact: true }).waitFor(); await shot("manage-selected");
  await page.goto(`${base}/#/settings/connections/devices`); await link.waitFor(); assert.equal(await link.getAttribute("aria-current"), null);
});
