import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url)), fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-stream-tabs-")));
const home = join(fixture, "home"), repo = join(fixture, "repo"), token = "qa-stream-tabs", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let base: string, server: ChildProcess, browser: Browser, context: BrowserContext | undefined, project: string, log = "";
const errors: string[] = [], consoleErrors: string[] = [], expectedNetworkErrors: string[] = [];
let disruptingStream = false;
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 20_000): Promise<T> { const end = Date.now() + timeout; for (;;) { const value = await read(); if (accepts(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value).slice(0, 800)); await new Promise(r => setTimeout(r, 60)); } }
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") { const response = await fetch(base + path, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status} ${path}: ${await response.clone().text()}`); return response.json(); }
async function stop() { disruptingStream = true; if (server && server.exitCode === null && server.signalCode === null) { const done = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await done; } }
async function launch() { server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: new URL(base).port, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" }); for (const stream of [server.stdout, server.stderr]) stream?.on("data", value => log += String(value)); await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean); }
async function page(hash = "") { context ??= await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const p = await context.newPage(); p.setDefaultTimeout(12_000); await p.addInitScript(() => localStorage.setItem("sideOpen", "0")); p.on("pageerror", e => errors.push(e.message)); p.on("console", m => { if (m.type() !== "error") return; const expected = disruptingStream && m.location().url.startsWith(base + "/api/") && /^Failed to load resource: net::ERR_(?:INCOMPLETE_CHUNKED_ENCODING|CONNECTION_REFUSED)$/.test(m.text()); (expected ? expectedNetworkErrors : consoleErrors).push(`${m.text()} [${m.location().url}]`); }); await p.goto(`${base}/?token=${token}#/${hash}`); await until(() => p.locator(".connection-status").innerText(), v => v === "Connected"); return p; }
async function shot(p: Page, name: string) { if (evidence) { mkdirSync(evidence, { recursive: true }); await p.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); } }
let tasks = 0;
const completed = async () => { const run = await api("/api/runs", { repo, project, pattern: "solo", roles: { agent: ["claude"] }, task: `Stream QA small change ${++tasks}` }); return until(() => api(`/api/runs/${run.id}`), r => r.status !== "running" && !!r.endedAt); };
before(async () => {
  mkdirSync(home); mkdirSync(repo); const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", ...args], { cwd: repo }); git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Stream QA\n"); git("add", "."); git("commit", "-qm", "base");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  const port = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const n = (s.address() as AddressInfo).port; s.close(() => resolve(n)); }); }); assert.ok(![4317, 4318].includes(port)); base = `http://127.0.0.1:${port}`;
  await launch(); project = (await api("/api/projects", { name: "Stream QA", repos: [repo] })).id; browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async () => { await context?.close(); context = undefined; disruptingStream = false; });
after(async () => { await browser?.close(); await stop(); if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "server.log"), log); writeFileSync(join(evidence, "console.json"), JSON.stringify({ unexpected: consoleErrors, expectedNetworkErrors })); } rmSync(fixture, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.doesNotMatch(log, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/); });

test("two tabs retain unsaved dialogs and one broker across repeated server restarts", async () => {
  const a = await page(), b = await page();
  for (const [p, name] of [[a, "Half typed A"], [b, "Half typed B"]] as const) { await p.evaluate(value => (window as any).__qaMarker = value, name); await p.keyboard.press("p"); await p.getByRole("dialog").getByRole("button", { name: "New project", exact: true }).click(); await p.locator("#project-name").fill(name); }
  for (let round = 0; round < 2; round++) {
    await stop(); await launch();
    await until(() => api("/api/health"), v => v.streams.streams === 1 && v.streams.subscriptions >= 6);
    for (const [p, name] of [[a, "Half typed A"], [b, "Half typed B"]] as const) { assert.equal(await p.evaluate(() => (window as any).__qaMarker), name); assert.equal(await p.locator("#project-name").inputValue(), name); await until(() => p.locator(".connection-status").innerText(), v => v === "Connected"); }
  }
  await shot(a, "restart-dialog-retained"); await a.close(); await until(() => api("/api/health"), v => v.streams.streams === 1 && v.streams.subscriptions >= 3); assert.equal(await b.locator("#project-name").inputValue(), "Half typed B");
});

test("failed and hanging diagnostics do not prevent live updates reconnecting", async () => {
  const p = await page();
  for (const mode of ["error", "hang"]) {
    await p.route("**/api/health", async route => { if (mode === "error") await route.fulfill({ status: 500, json: { error: "Injected diagnostics failure" } }); /* hang deliberately leaves the intercepted request pending */ });
    await stop(); await launch(); await until(() => api("/api/health"), v => v.streams.streams === 1);
    await until(() => p.locator(".connection-status").innerText(), v => v === "Connected"); const run = await completed(); await p.locator(".run-item", { hasText: run.task }).first().waitFor();
    await shot(p, `diagnostics-${mode}`); await p.unroute("**/api/health");
  }
});

test("another tab's deletion preserves the unsent text and image and replaces the stale route", async () => {
  const run = await completed(), a = await page(`run/${run.id}`), b = await page(`run/${run.id}`);
  const reply = b.getByRole("textbox", { name: "Message agent", exact: true }); await reply.fill("Keep this half-written follow-up");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  // Seed an already-captured browser image; cluster43 separately exercises making the real pin.
  await b.evaluate(async ({ id, data, size }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("codeflow-project-drafts", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("drafts", "readwrite"); tx.objectStore("drafts").put({ text: "Keep this half-written follow-up", images: [{ name: "draft.png", data, size }] }, `message-draft-v1:main:${id}`); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  }, { id: run.id, data: png.toString("base64"), size: png.length });
  await b.reload(); await b.locator('.draft-images img[alt="draft.png"]').waitFor();
  const historyBefore = await b.evaluate(() => history.length);
  const row = a.locator(".rail-run-row", { has: a.locator(".run-item", { hasText: run.task }) }).first(); await row.hover(); await row.getByRole("button", { name: "Run actions", exact: true }).click(); await row.getByRole("menuitem", { name: "Delete…", exact: true }).click(); await a.getByRole("dialog").getByRole("button", { name: "Delete run", exact: true }).click();
  const notice = b.getByRole("alert", { name: "Deleted run", exact: true }); await notice.getByText("This run was deleted in another window or by another user", { exact: true }).waitFor();
  assert.equal(await notice.getByLabel("Unsent reply", { exact: true }).inputValue(), "Keep this half-written follow-up"); assert.match((await notice.getByRole("link", { name: "Save draft.png", exact: true }).getAttribute("href"))!, /^data:image\/png;base64,/); assert.equal(new URL(b.url()).hash, "#/");
  assert.equal(await b.evaluate(() => history.length), historyBefore, "deletion replaces the stale route instead of adding a Back destination");
  assert.equal(await a.getByRole("alert", { name: "Deleted run", exact: true }).count(), 0); await shot(b, "remote-deletion-recovery");
  await b.goto(`${base}/#/run/${run.id}`); await b.getByRole("alert", { name: "Deleted run", exact: true }).waitFor(); assert.equal(await b.getByRole("textbox", { name: "Message agent", exact: true }).count(), 0); assert.equal(await b.getByLabel("Unsent reply", { exact: true }).inputValue(), "Keep this half-written follow-up");
});

test("a fresh page for a deleted run recovers its saved draft without showing cached actions", async () => {
  const run = await completed(), a = await page(`run/${run.id}`); await a.getByRole("textbox", { name: "Message agent", exact: true }).fill("Keep after a fresh page too");
  await api(`/api/runs/${run.id}`, undefined, "DELETE"); await a.getByRole("alert", { name: "Deleted run", exact: true }).waitFor(); await a.goto(`${base}/#/run/${run.id}`); await a.reload();
  await a.getByRole("alert", { name: "Deleted run", exact: true }).waitFor(); assert.equal(await a.getByLabel("Unsent reply", { exact: true }).inputValue(), "Keep after a fresh page too"); assert.equal(await a.getByRole("textbox", { name: "Message agent", exact: true }).count(), 0); await shot(a, "deleted-deep-link");
});

test("HTTP observers retain the same event-loop stall", async () => {
  try { server.kill("SIGSTOP"); await new Promise(r => setTimeout(r, 350)); } finally { server.kill("SIGCONT"); }
  await new Promise(r => setTimeout(r, 60)); const a = (await api("/api/health")).performance.eventLoop, b = (await api("/api/health")).performance.eventLoop;
  assert.ok(a.maxMs >= 300); assert.equal(b.maxMs, a.maxMs); assert.ok(b.samples > 0); assert.equal(b.window, "since-start");
});

test("sign-out rotates identity and closes streams even when its nonce cannot be saved", async () => {
  const p = await page(), before = (await api("/api/auth/self")).streamSharing;
  rmSync(join(home, "stream-sharing.json")); mkdirSync(join(home, "stream-sharing.json"));
  disruptingStream = true;
  const status = await p.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status); assert.equal(status, 200);
  assert.notDeepEqual((await api("/api/auth/self")).streamSharing, before); await until(() => api("/api/health"), value => value.streams.streams === 0);
  assert.equal(await p.evaluate(async () => (await (await fetch("/api/auth/self")).json()).kind), "anonymous");
});
