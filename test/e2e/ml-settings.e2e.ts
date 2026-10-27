import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer ml-settings-test", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, home: string, project: string, port: number;
const errors: string[] = [];
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
async function start(flag = "") {
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: "ml-settings-test", CODEFLOW_ML_ENABLED: flag, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let n = 0; n < 150; n++) {
    if (await fetch(base + "/api/ml/settings", { headers }).then(r => r.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start");
}
async function stop() {
  if (server?.exitCode !== null || server?.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.once("exit", () => { clearTimeout(timer); resolve(); }); server.kill("SIGTERM");
  });
}
before(async () => {
  home = await mkdtemp(join(tmpdir(), "codeflow-ml-settings-e2e-"));
  port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const chosen = (probe.address() as AddressInfo).port; probe.close(() => resolve(chosen)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  await start();
  project = (await api("/api/projects", { name: "Optional ML", repos: [] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base + "/?token=ml-settings-test#/settings/general");
});
after(async () => { await browser?.close(); await stop(); if (home) await rm(home, { recursive: true, force: true }); });

test("Settings enables ML on demand, survives reload and restart, and keeps unused projects uncluttered", { timeout: 90000 }, async () => {
  const card = page.getByRole("region", { name: "Model training", exact: true });
  await card.getByText("Disabled · enable when you need it.", { exact: true }).waitFor();
  await page.goto(`${base}/#/project/${project}`);
  await page.getByRole("heading", { name: "Optional ML", exact: true }).waitFor();
  const nav = page.getByRole("navigation", { name: "Project navigation" });
  assert.equal(await nav.getByRole("link", { name: "ML", exact: true }).count(), 0);
  await page.getByRole("button", { name: /^More project tools:/ }).click();
  assert.equal(await page.getByRole("menuitem", { name: "ML", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await page.goto(`${base}/#/settings/general`);
  await card.getByRole("button", { name: "Enable model training", exact: true }).click();
  await card.getByRole("button", { name: "Disable model training", exact: true }).waitFor();
  assert.deepEqual(await api("/api/ml/settings"), { enabled: true, revision: 1 });
  await assert.rejects(stat(join(home, "ml/worker")), { code: "ENOENT" });
  await page.reload();
  await card.getByRole("button", { name: "Disable model training", exact: true }).waitFor();
  await page.goto(`${base}/#/project/${project}`);
  await nav.getByRole("link", { name: "ML", exact: true }).waitFor();
  await nav.getByRole("link", { name: "ML", exact: true }).click();
  await page.getByRole("heading", { name: "Model training Preview", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Add SSH server", exact: true }).isEnabled(), true);
  await page.goto(`${base}/#/settings/general`);

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await card.scrollIntoViewIfNeeded();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => (await (window as any).axe.run('[aria-label="Model training"]')).violations);
    assert.deepEqual(violations, [], `ML settings accessibility at ${viewport.width}px`);
    const box = await card.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1);
    await card.screenshot({ path: join(tmpdir(), `codeflow-ml-settings-${viewport.width}.png`) });
  }
  await card.getByRole("button", { name: "Disable model training", exact: true }).click();
  await card.getByText("Disabled · enable when you need it.", { exact: true }).waitFor();
  assert.deepEqual(await api("/api/ml/settings"), { enabled: false, revision: 2 });
  const rejected = await fetch(base + "/api/ml/experiments", { method: "POST", headers, body: "{}" });
  assert.equal(rejected.status, 409); assert.match(await rejected.text(), /Settings/);
  await page.goto(`${base}/#/project/${project}`);
  await page.getByRole("heading", { name: "Optional ML", exact: true }).waitFor();
  assert.equal(await nav.getByRole("link", { name: "ML", exact: true }).count(), 0);
  await page.goto(`${base}/#/project/${project}/ml`);
  await page.getByRole("link", { name: "Settings → General", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Add SSH server", exact: true }).isDisabled(), true);
  await stop(); await start("true");
  assert.deepEqual(await api("/api/ml/settings"), { enabled: false, revision: 2 });
  await assert.rejects(stat(join(home, "ml/worker")), { code: "ENOENT" });
  assert.deepEqual(errors, []);
});

test("activation API protects owner authority and rejects stale edits", async () => {
  const { revision } = await api("/api/ml/settings");
  await api("/api/ml/settings", { enabled: false, revision });
  for (const method of ["GET", "POST"]) {
    const response = await fetch(base + "/api/ml/settings", { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, revision: revision + 1 }) } : {}) });
    assert.equal(response.status, 401);
  }
  const stale = await fetch(base + "/api/ml/settings", { method: "POST", headers, body: JSON.stringify({ enabled: true, revision }) });
  assert.equal(stale.status, 409);
  const extraPath = await fetch(base + "/api/ml/settings/anything", { headers }); assert.equal(extraPath.status, 404);
  assert.deepEqual(await api("/api/ml/settings"), { enabled: false, revision: revision + 1 });
});
