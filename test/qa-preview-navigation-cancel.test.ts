import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request } from "playwright-core";
import { build } from "esbuild";
import { reserveQaPorts } from "./qa-port-block.js";
const root = fileURLToPath(new URL("..", import.meta.url)), ports = await reserveQaPorts(2, process.env.QA_PREVIEW_NAV_PORT);
const dir = mkdtempSync(join(tmpdir(), "qa-preview-navigation-")), home = join(dir, "home"), repo = join(dir, "repo"), base = `http://127.0.0.1:${ports.port}`, token = "qa-preview-navigation";
const evidence = process.env.QA_ARTIFACT_DIR ?? dir, headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
let server: ChildProcess, browser: Browser, output = "", stateBundle = "";
const errors: string[] = [], resourceErrors: {
    url: string;
    status: number;
}[] = [], expectedErrors = new Set<Request>(), responseReads: Promise<void>[] = [], observedErrors: {
    url: string;
    status: number;
    intentional: boolean;
    method: string;
    request?: unknown;
    error?: string;
    at: string;
}[] = [], pages: Page[] = [];
const barrier = () => { let release!: () => void; const wait = new Promise<void>(r => release = r); return { wait, release }; };
async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, label: string, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) {
    const v = await read();
    if (check(v))
        return v;
    await new Promise(r => setTimeout(r, 50));
} throw new Error(label); }
async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") { const r = await fetch(base + path, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await r.json() as any; assert.ok(r.ok, JSON.stringify({ path, status: r.status, value })); return value; }
const endpoint = (run: any) => `/api/runs/${run.id}/worktrees/solo/serve`;
async function newRun() { const r = await request("/api/runs", { repo, task: "Improve the scratch heading", pattern: "solo", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } }); return until(() => request(`/api/runs/${r.id}`), r => r.status !== "running", "run completion"); }
async function pageFor(run: any) { const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(); pages.push(page); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message)); page.on("response", response => { if (response.status() >= 400 && response.url().includes("/api/")) {
    const body = response.request().postDataJSON(), record = { url: response.url(), status: response.status(), intentional: expectedErrors.has(response.request()), method: response.request().method(), request: body ? { action: body.action, url: body.url } : undefined, at: new Date().toISOString(), error: undefined as string | undefined };
    observedErrors.push(record);
    responseReads.push(response.json().then(body => { record.error = body.error; }, () => { }));
} }); page.on("console", message => { if (message.type() !== "error")
    return; const status = /^Failed to load resource: the server responded with a status of (\d+) \([^)]*\)$/.exec(message.text()); if (status)
    resourceErrors.push({ url: message.location().url, status: Number(status[1]) });
else
    errors.push(message.text()); }); await page.goto(`${base}/?token=${token}&team=local#/run/${run.id}`); await page.getByRole("region", { name: "Try and assess the result", exact: true }).waitFor(); return page; }
async function openBrowser(page: Page) { const toggle = page.getByRole("button", { name: "Side panel", exact: true }); if (await toggle.getAttribute("aria-pressed") !== "true")
    await toggle.click(); await page.getByRole("tab", { name: "Browser", exact: true }).click(); }
async function start(page: Page, run: any) { const studio = page.locator(".result-compact"), more = studio.locator(".result-more"), settings = more.locator("details").filter({ has: page.getByText("Preview settings", { exact: true }) }); if (await more.getAttribute("open") === null)
    await more.locator(":scope > summary").click(); if (await settings.getAttribute("open") === null)
    await settings.locator(":scope > summary").click(); await studio.getByRole("textbox", { name: "App command", exact: true }).fill("node app.cjs"); await studio.getByRole("button", { name: "Start preview", exact: true }).click(); await studio.getByRole("button", { name: "Stop preview", exact: true }).waitFor(); await until(() => studio.getByRole("button", { name: "Stop preview", exact: true }).isEnabled(), Boolean, "preview preparation acknowledged"); return request(endpoint(run)); }
async function stop(page: Page, run: any) { await page.getByRole("button", { name: "Stop preview", exact: true }).click(); await until(() => request(endpoint(run)), v => v === null, "preview stopped"); }
async function close(page: Page, run: any) { await page.context().close(); const app = await request(endpoint(run)); if (app)
    await request(endpoint(run) + `?startedAt=${app.startedAt}`, undefined, "DELETE"); }
before(async () => { mkdirSync(home); mkdirSync(repo); mkdirSync(evidence, { recursive: true }); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, "README.md"), "Fixture\n"); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false, check: "true", run: { command: "node app.cjs" } })); writeFileSync(join(repo, "app.cjs"), `require('http').createServer((q,s)=>s.end('<title>Navigation fixture</title><h1>Ready</h1>')).listen(Number(process.env.PORT),'127.0.0.1');`); for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]])
    execFileSync("git", args, { cwd: repo }); execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); stateBundle = (await build({ stdin: { contents: 'import * as state from "./ui/state.ts"; window.qaState=state;', resolveDir: root }, bundle: true, write: false, format: "esm", platform: "browser" })).outputFiles[0]!.text; await ports.release(); server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, HOME: home, ZDOTDIR: home, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(ports.port), CODEFLOW_REMOTE_PORT: String(ports.port + 1), PATH: `${root}/test/fake-bin:${process.env.PATH}` }, stdio: "pipe" }); server.stdout?.on("data", c => output += c); server.stderr?.on("data", c => output += c); await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean, "server ready"); await request("/api/projects", { name: "Preview cancellation QA", repos: [repo] }); browser = await chromium.launch({ executablePath: process.env.CODEFLOW_CHROME, headless: true }); });
after(async () => { await browser?.close(); if (server?.exitCode === null) {
    const exited = new Promise<void>(r => server.once("exit", () => r()));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>(r => setTimeout(() => { server.kill("SIGKILL"); r(); }, 5000))]);
} await ports.release(); await Promise.all(responseReads); writeFileSync(join(evidence, "server.log"), output); writeFileSync(join(evidence, "browser-audit.json"), JSON.stringify({ errors, observedErrors, resourceErrors }, null, 2)); assert.deepEqual(errors, []); assert.deepEqual(observedErrors.filter(e => !e.intentional), []); assert.deepEqual(resourceErrors.map(e => JSON.stringify(e)).sort(), observedErrors.map(({ url, status }) => JSON.stringify({ url, status })).sort()); });
test("Stop skips queued automatic navigation and reload does not resurrect the stopped target", { timeout: 60000 }, async () => { const run = await newRun(), page = await pageFor(run), held = barrier(), entered = barrier(); let first = true, resizes = 0; const navigations: string[] = []; page.on("response", r => { if (r.url().includes("/api/browser?") && r.request().postDataJSON()?.action === "resize")
    resizes++; }); await page.route("**/api/browser?**", async (route) => { const body = route.request().postDataJSON(); if (body?.action === "navigate")
    navigations.push(body.url); if (body?.action === "resize" && first) {
    first = false;
    entered.release();
    await held.wait;
} await route.continue(); }); try {
    await openBrowser(page);
    await entered.wait;
    const app = await start(page, run);
    await stop(page, run);
    held.release();
    await page.getByLabel("Browser viewport").selectOption("tablet");
    await until(async () => resizes, n => n >= 2, "queue drained through resize");
    assert.ok(!navigations.includes(app.url), JSON.stringify(navigations));
    assert.equal(await page.locator(".interactive-browser [role=alert]").count(), 0);
    assert.ok(await page.evaluate(url => Object.keys(localStorage).filter(key => key === "sideMemory" || key.endsWith(":sideMemory")).some(key => localStorage.getItem(key)?.includes(url)), app.url), "history retained");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.reload();
    await openBrowser(page);
    await until(() => request(`/api/browser?scope=run:${run.id}`, { action: "state" }), s => s.tabs.some((t: any) => t.id === s.selected && t.url === "about:blank"), "blank browser after reload");
    await page.getByLabel("Browser viewport").selectOption("phone");
    await until(async () => resizes, n => n >= 3, "reload queue drained");
    assert.ok(!navigations.includes(app.url), JSON.stringify(navigations));
    await page.screenshot({ path: join(evidence, "stopped-queued-preview.png") });
}
finally {
    held.release();
    await close(page, run);
} });
test("obsolete automatic failure cannot replace manual navigation feedback", { timeout: 60000 }, async () => { const run = await newRun(), page = await pageFor(run), held = barrier(), entered = barrier(); let automatic = ""; await page.route("**/api/browser?**", async (route) => { const body = route.request().postDataJSON(); if (body?.action !== "navigate")
    return route.continue(); expectedErrors.add(route.request()); if (!automatic) {
    automatic = body.url;
    entered.release();
    await held.wait;
    return route.fulfill({ status: 400, json: { error: "obsolete automatic failure" } });
} return route.fulfill({ status: 400, json: { error: "manual navigation failure" } }); }); try {
    await start(page, run);
    await entered.wait;
    await page.getByRole("textbox", { name: "Address", exact: true }).fill("https://manual.invalid/");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    held.release();
    const alert = page.locator(".interactive-browser [role=alert]");
    await alert.filter({ hasText: "manual navigation failure" }).waitFor();
    assert.doesNotMatch(await alert.innerText(), /obsolete automatic/);
    await page.screenshot({ path: join(evidence, "manual-error-retained.png") });
}
finally {
    held.release();
    await close(page, run);
} });
test("a canceled success cannot clear a newer control error, while active automatic failures remain visible", { timeout: 60000 }, async () => { const run = await newRun(), page = await pageFor(run), held = barrier(), entered = barrier(); let hold = true; await page.route("**/api/browser?**", async (route) => { if (route.request().postDataJSON()?.action !== "navigate")
    return route.continue(); if (hold) {
    hold = false;
    entered.release();
    await held.wait;
    return route.fulfill({ json: {} });
} expectedErrors.add(route.request()); return route.fulfill({ status: 400, json: { error: "active automatic failure" } }); }); await page.route("**/api/browser/control?**", async (route) => { if (route.request().method() !== "POST")
    return route.continue(); expectedErrors.add(route.request()); return route.fulfill({ status: 400, json: { error: "current control failure" } }); }); try {
    await start(page, run);
    await entered.wait;
    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await page.locator(".interactive-browser [role=alert]").filter({ hasText: "current control failure" }).waitFor();
    await stop(page, run);
    held.release();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.locator(".interactive-browser [role=alert]").filter({ hasText: "current control failure" }).waitFor();
    await start(page, run);
    await page.locator(".interactive-browser [role=alert]").filter({ hasText: "active automatic failure" }).waitFor();
}
finally {
    held.release();
    await close(page, run);
} });
test("preview cancellation keeps other scopes, replacement identities and page history intact", { timeout: 30000 }, async () => { const page = await browser.newPage(); await page.route(base + "/qa-state", r => r.fulfill({ contentType: "text/html", body: '<script type="module" src="/qa-state.mjs"></script>' })); await page.route(base + "/qa-state.mjs", r => r.fulfill({ contentType: "text/javascript", body: stateBundle })); await page.goto(base + "/qa-state"); await page.waitForFunction(() => !!(window as any).qaState); const result = await page.evaluate(() => { const s = (window as any).qaState; const newest = { id: "new", url: "http://localhost:8123/", previewStartedAt: 2 }; const pages = [{ id: "keep", url: "https://manual.example/" }]; s.sideMemory.value = { "run:a": { browserRequest: newest, pages }, "run:b": { browserRequest: { id: "other", url: newest.url, previewStartedAt: 2 } } }; s.cancelPreviewBrowserPage(newest.url, 1, "a"); const stalePreserved = !s.sideMemory.value["run:a"].browserRequest.cancelled; s.cancelPreviewBrowserPage("http://localhost:9999", 2, "a"); const urlPreserved = !s.sideMemory.value["run:a"].browserRequest.cancelled; s.cancelPreviewBrowserPage("http://localhost:8123", 2, "a"); return { stalePreserved, urlPreserved, cancelled: s.sideMemory.value["run:a"].browserRequest.cancelled, otherPreserved: !s.sideMemory.value["run:b"].browserRequest.cancelled, pages: s.sideMemory.value["run:a"].pages }; }); assert.deepEqual(result, { stalePreserved: true, urlPreserved: true, cancelled: "stopped", otherPreserved: true, pages: [{ id: "keep", url: "https://manual.example/" }] }); await page.close(); });
test("failed stale Stop preserves replacement and a late old failure cannot overwrite its successful navigation", { timeout: 60000 }, async () => { const run = await newRun(), page = await pageFor(run), held = barrier(), entered = barrier(); let oldUrl = ""; await page.route("**/api/browser?**", async (route) => { const body = route.request().postDataJSON(); if (body?.action !== "navigate")
    return route.continue(); if (!oldUrl) {
    oldUrl = body.url;
    entered.release();
    await held.wait;
    expectedErrors.add(route.request());
    return route.fulfill({ status: 400, json: { error: "old replacement navigation failed" } });
} return route.continue(); }); try {
    const old = await start(page, run);
    await entered.wait;
    const servePattern = `**${endpoint(run)}**`;
    await page.route(servePattern, async (route) => { if (route.request().method() === "GET" && new URL(route.request().url()).pathname.endsWith("/serve"))
        return route.fulfill({ json: old }); if (route.request().method() === "DELETE")
        expectedErrors.add(route.request()); return route.continue(); });
    const fresh = await request(endpoint(run), { command: "node app.cjs" });
    assert.notEqual(fresh.startedAt, old.startedAt);
    await page.getByRole("button", { name: "Stop preview", exact: true }).click();
    await page.locator(".result-compact [role=alert]").waitFor();
    assert.equal((await request(endpoint(run))).startedAt, fresh.startedAt, "stale Stop cannot kill replacement");
    await page.unroute(servePattern);
    await start(page, run);
    const navigated = page.waitForResponse(r => r.url().includes("/api/browser?") && r.request().postDataJSON()?.action === "navigate" && new URL(r.request().postDataJSON()?.url ?? "about:blank").href === new URL(fresh.url).href && r.status() === 200);
    held.release();
    await navigated;
    await until(() => request(`/api/browser?scope=run:${run.id}`, { action: "state" }), s => s.tabs.some((t: any) => t.id === s.selected && new URL(t.url).href === new URL(fresh.url).href), "replacement navigated");
    await page.locator('.live-browser-surface canvas[data-ready="true"]').waitFor();
    assert.doesNotMatch(await page.locator(".interactive-browser").innerText(), /old replacement navigation failed/);
}
finally {
    held.release();
    await close(page, run);
} });
test("a successful explicit manual choice of the canceled URL can restore after reload", { timeout: 60000 }, async () => { const run = await newRun(), page = await pageFor(run), held = barrier(), entered = barrier(); let first = true, obsolete: Request | undefined; await page.route("**/api/browser?**", async (route) => { const body = route.request().postDataJSON(); if (body?.action === "navigate" && first) {
    first = false;
    obsolete = route.request();
    entered.release();
    await held.wait;
    return route.fulfill({ json: {} });
} return route.continue(); }); try {
    const app = await start(page, run);
    await entered.wait;
    const pattern = `**${endpoint(run)}?startedAt=*`;
    await page.route(pattern, route => { expectedErrors.add(route.request()); return route.fulfill({ status: 409, json: { error: "Controlled Stop refusal" } }); });
    await page.getByRole("button", { name: "Stop preview", exact: true }).click();
    await page.locator(".result-compact [role=alert]").filter({ hasText: "Controlled Stop refusal" }).waitFor();
    await page.unroute(pattern);
    assert.equal((await request(endpoint(run))).startedAt, app.startedAt);
    await page.getByRole("textbox", { name: "Address", exact: true }).fill(app.url);
    const manuallyOpened = page.waitForResponse(r => r.request() !== obsolete && r.url().includes("/api/browser?") && r.request().postDataJSON()?.action === "navigate" && new URL(r.request().postDataJSON()?.url ?? "about:blank").href === new URL(app.url).href && r.status() === 200);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    held.release();
    await manuallyOpened;
    await until(() => request(`/api/browser?scope=run:${run.id}`, { action: "state" }), s => s.tabs.some((t: any) => t.id === s.selected && new URL(t.url).href === new URL(app.url).href), "manual same-URL navigation");
    await page.locator('.live-browser-surface canvas[data-ready="true"]').waitFor();
    await request(`/api/browser?scope=run:${run.id}`, { action: "tabs", operation: "new" });
    await page.getByRole("heading", { name: "No website open", exact: true }).waitFor();
    const restored = page.waitForResponse(r => r.url().includes("/api/browser?") && r.request().postDataJSON()?.action === "navigate" && new URL(r.request().postDataJSON()?.url ?? "about:blank").href === new URL(app.url).href && r.status() === 200);
    await page.reload();
    await openBrowser(page);
    await restored;
    await until(() => request(`/api/browser?scope=run:${run.id}`, { action: "state" }), s => s.tabs.some((t: any) => t.id === s.selected && new URL(t.url).href === new URL(app.url).href), "manual same-URL restoration");
}
finally {
    held.release();
    await close(page, run);
} });
