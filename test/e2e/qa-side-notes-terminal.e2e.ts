import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request } from "playwright-core";

const qaPorts = await reserveQaPorts(2, process.env.QA_SIDE_NOTES_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url));
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "qa-side-notes-terminal-token";
const home = mkdtempSync(join(tmpdir(), "codeflow-side-notes-terminal-")), data = join(home, "data");
const evidence = join(root, "output/playwright/qa-side-notes-terminal");
let server: ChildProcess, browser: Browser, page: Page;
let alpha: { id: string; repos: string[] }, beta: { id: string; repos: string[] };
let lineMode = false, sleepMs = "20";
const expectedNetwork: string[] = [];
const consoleErrors: string[] = [], pageErrors: string[] = [], serverLog: string[] = [];
type Restart = { started: number; ready?: number; pid: number | undefined };
type NetworkRequest = { page: number; url: string; method: string; started: number; responseAt?: number; failedAt?: number; status?: number; body?: unknown; failure?: string; deliberateOffline?: boolean };
type ConsoleError = { page: number; url: string; at: number; text: string };
const restarts: Restart[] = [], requests: NetworkRequest[] = [], observedConsole: ConsoleError[] = [], exceptions: string[] = [];
const requestRecords = new WeakMap<Request, NetworkRequest>(), responseReads = new Set<Promise<void>>();
let nextPage = 0;
const now = () => performance.now();
const transportError = /^net::ERR_(FAILED|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|INTERNET_DISCONNECTED|SOCKET_NOT_CONNECTED)$/;
function expectedFailure(request: NetworkRequest, windows: Restart[]) {
  const url = new URL(request.url);
  if (url.origin !== base || !url.pathname.startsWith("/api/")) return false;
  if (request.status === undefined && request.deliberateOffline && request.method === "POST" && url.pathname === "/api/notes" && request.failure === "net::ERR_INTERNET_DISCONNECTED") return true;
  const ended = request.responseAt ?? request.failedAt;
  if (!Number.isFinite(request.started) || ended === undefined || !Number.isFinite(ended) || ended < request.started || !windows.some(window => request.started < (window.ready ?? Infinity) && ended >= window.started)) return false;
  if (request.status !== undefined) {
    // Stream subscription updates can race shutdown too; arbitrary writes remain unexpected.
    const readOrStreamUpdate = request.method === "GET" || (request.method === "POST" && /^\/api\/stream\/[a-f0-9]{24}$/.test(url.pathname));
    return readOrStreamUpdate && request.status === 503 && JSON.stringify(request.body) === '{"error":"The backend is stopping"}';
  }
  return !!request.failure && transportError.test(request.failure);
}
function failureOnly(request: NetworkRequest): NetworkRequest {
  // An HTTP response and a subsequent transport failure are separate observations.
  return { ...request, status: undefined, responseAt: undefined, body: undefined };
}
function networkAudit(records: NetworkRequest[], consoles: ConsoleError[], windows: Restart[]) {
  const pages: string[] = [], console: string[] = [], expected: string[] = [];
  for (const request of records) {
    if (request.status !== undefined && request.status >= 500) {
      (expectedFailure(request, windows) ? expected : pages).push(`${request.status} ${request.method} ${request.url}`);
    }
    if (request.failure) {
      // Every observed failure is audited, even when Chrome emits no console message for it.
      // Unknown codes and cancellations without a proven intentional cause remain errors.
      (expectedFailure(failureOnly(request), windows) ? expected : console).push(`${request.failure} ${request.method} ${request.url}`);
    }
  }
  for (const message of consoles) {
    const code = /^Failed to load resource: (net::ERR_[A-Z_]+)$/.exec(message.text)?.[1];
    const status = /^Failed to load resource: the server responded with a status of (\d+) \([^)]*\)$/.exec(message.text)?.[1];
    const matches = records.filter(request => request.page === message.page && request.url === message.url && request.started <= message.at && (code ? request.failure === code : status ? request.status === Number(status) : false));
    const closest = matches.sort((a, b) => Math.abs((a.responseAt ?? a.failedAt ?? Infinity) - message.at) - Math.abs((b.responseAt ?? b.failedAt ?? Infinity) - message.at))[0];
    if (closest && expectedFailure(code ? failureOnly(closest) : closest, windows)) expected.push(`${message.text} [${message.url}]`);
    else console.push(`${message.text} [${message.url}]`);
  }
  return { pageErrors: pages, consoleErrors: console, expectedNetwork: expected };
}
async function finishNetworkAudit() {
  await Promise.all([...responseReads]);
  const audited = networkAudit(requests, observedConsole, restarts);
  pageErrors.splice(0, pageErrors.length, ...exceptions, ...audited.pageErrors);
  consoleErrors.splice(0, consoleErrors.length, ...audited.consoleErrors);
  expectedNetwork.splice(0, expectedNetwork.length, ...audited.expectedNetwork);
}
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
function repository(name: string, files: Record<string, string> = {}) {
  const repo = join(home, name); mkdirSync(repo);
  for (const [path, body] of Object.entries({ "README.md": "Fixture\n", ".codeflow/config.json": JSON.stringify({ prove: false }), ...files })) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), body); }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}
async function start() {
  await qaPorts.release();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOW_")));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, SHELL: join(home, "bash"), BASH_ENV: "", ENV: "", CODEFLOW_PYTHON: lineMode ? "/nonexistent" : "/usr/bin/python3", FAKE_SLEEP_MS: sleepMs, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, FAKE_GH_STATE: join(home, "gh.json"), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", chunk => serverLog.push(String(chunk))); server.stderr?.on("data", chunk => serverLog.push(String(chunk)));
  for (let i = 0; i < 150; i++) { if (await api("/api/health").then(r => r.status === 200, () => false)) { const window = restarts.at(-1); if (window && window.ready === undefined) window.ready = now(); return; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(serverLog.join(""));
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  restarts.push({ started: now(), pid: server.pid });
  const exited = new Promise<void>(resolve => server.once("exit", () => resolve()));
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM"); await exited; clearTimeout(timer);
}
async function open(hash: string) { await page.goto(`${base}/?token=${token}${hash}`); }
async function settled(id: string) {
  for (let i = 0; i < 300; i++) { const result = (await api(`/api/runs/${id}`)).body; if (result.status !== "running") return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Run did not finish: ${id}`);
}
function watch(p: Page) {
  const pageId = ++nextPage;
  p.on("request", request => {
    if (!request.url().startsWith(base + "/api/")) return;
    const record = { page: pageId, url: request.url(), method: request.method(), started: now() };
    requestRecords.set(request, record); requests.push(record);
  });
  p.on("requestfailed", request => {
    const record = requestRecords.get(request);
    if (record) { record.failedAt = now(); record.failure = request.failure()?.errorText || "Unknown request failure"; }
  });
  p.on("pageerror", e => exceptions.push(e.message));
  p.on("console", message => {
    if (message.type() === "error") observedConsole.push({ page: pageId, at: now(), text: message.text(), url: message.location().url });
  });
  p.on("response", response => {
    if (!response.url().includes("/api/") || response.status() < 500) return;
    const record = requestRecords.get(response.request()) ?? { page: pageId, url: response.url(), method: response.request().method(), started: Infinity };
    if (!requests.includes(record)) requests.push(record);
    record.responseAt = now(); record.status = response.status();
    // Without the exact shutdown body the response remains an unexpected error.
    let timer: ReturnType<typeof setTimeout>;
    const read = Promise.race([response.json(), new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 2000); })])
      .then(body => { record.body = body; }, () => {}).finally(() => { clearTimeout(timer); responseReads.delete(read); });
    responseReads.add(read);
  });
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => Promise<boolean>, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
async function panel(project = alpha, tab = "Notes") {
  await open(`#/project/${project.id}`);
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.getByRole("tab", { name: tab, exact: true }).click();
  if (tab === "Notes") {
    const repo = page.getByRole("group", { name: "Which notes" }).getByRole("button", { name: project.repos[0]!.split("/").pop()!, exact: true });
    await repo.click(); await until(() => page.getByRole("textbox", { name: "Notes", exact: true }).isEnabled(), "notes loaded");
  }
}
const currentNote = async (key = alpha.repos[0]!) => (await api(`/api/notes?key=${encodeURIComponent(key)}`)).body;
const noteEquals = async (text: string, key = alpha.repos[0]!) => until(async () => (await currentNote(key)).text === text, `saved ${text}`);
before(async () => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(home, "gh.json"), '{"issues":[],"prs":{}}');
  writeFileSync(join(home, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start();
  alpha = (await api("/api/projects", { name: "Side Alpha", repos: [repository("alpha", { "sub/.keep": "" })] })).body;
  beta = (await api("/api/projects", { name: "Side Beta", repos: [repository("beta")] })).body;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: "light" }); page = await context.newPage(); watch(page);
});
after(async () => {
  try { await browser?.close(); } finally {
    await stop(); await finishNetworkAudit(); writeFileSync(join(evidence, "server.log"), serverLog.join(""));
    writeFileSync(join(evidence, "browser.json"), JSON.stringify({ pageErrors, consoleErrors, expectedNetwork, restarts, requests, observedConsole }, null, 2));
    rmSync(home, { recursive: true, force: true });
  }
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
});

test("offline notes recover against their original revision and both conflict choices work", async () => {
  await panel(); const field = page.getByRole("textbox", { name: "Notes", exact: true });
  await field.fill("laptop base"); await noteEquals("laptop base"); const original = await currentNote();
  const context = page.context(); await context.route("**/api/notes", route => {
    if (route.request().method() !== "POST") return route.continue();
    const record = requestRecords.get(route.request()); assert.ok(record, "offline request was observed"); record.deliberateOffline = true;
    return route.abort("internetdisconnected");
  });
  await field.fill("offline laptop draft"); await page.getByText(/Couldn't save:/).waitFor();
  assert.match(await page.locator(".notes-foot").innerText(), /running\? Your draft/); assert.doesNotMatch(await page.locator(".notes-foot").innerText(), /\?\./);
  await page.close(); await context.unroute("**/api/notes");
  assert.equal((await api("/api/notes", { key: alpha.repos[0], text: "PHONE EDIT", expectedRevision: original.revision })).status, 200);
  page = await context.newPage(); watch(page); await panel();
  await page.getByRole("alert").filter({ hasText: "This note changed" }).waitFor();
  await pause(850); assert.equal((await currentNote()).text, "PHONE EDIT"); assert.equal(await page.getByRole("textbox", { name: "Notes", exact: true }).inputValue(), "offline laptop draft");
  await page.screenshot({ path: join(evidence, "offline-conflict.png"), fullPage: true });
  await page.getByRole("button", { name: "Use saved version", exact: true }).click(); assert.equal(await page.getByRole("textbox", { name: "Notes", exact: true }).inputValue(), "PHONE EDIT");
  await page.evaluate(key => localStorage.setItem(`notes-draft:${key}`, "legacy text from older browser"), alpha.repos[0]!);
  await panel(); await page.getByRole("button", { name: "Save my draft over this version", exact: true }).click(); await noteEquals("legacy text from older browser");
  assert.equal(await page.locator(".notes-conflict").count(), 0);
});

test("scope changes flush within debounce and delayed acknowledgements preserve a newer draft", async () => {
  await panel(); const field = page.getByRole("textbox", { name: "Notes", exact: true });
  const general = await currentNote("general"); await field.fill("fast scope switch");
  await page.getByRole("group", { name: "Which notes" }).getByRole("button", { name: "General", exact: true }).click(); await noteEquals("fast scope switch"); assert.deepEqual(await currentNote("general"), general);
  await panel(); await field.fill("fast project switch"); await page.evaluate(id => { location.hash = `#/project/${id}`; }, beta.id); await noteEquals("fast project switch");
  await panel(); let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => release = resolve), caught = new Promise<void>(resolve => started = resolve);
  await page.route("**/api/notes", async route => { if (route.request().method() === "POST") { started(); await held; } await route.continue(); });
  await field.fill("in flight"); await caught; await field.fill("newer while saving"); release();
  await noteEquals("newer while saving"); await page.unroute("**/api/notes"); await panel();
  assert.equal(await field.inputValue(), "newer while saving"); assert.equal(await page.locator(".notes-conflict").count(), 0);
  // Reverting to the old saved text while a different write is in flight is still a new edit.
  let releaseRevert!: () => void, startedRevert!: () => void;
  const waitRevert = new Promise<void>(resolve => releaseRevert = resolve), caughtRevert = new Promise<void>(resolve => startedRevert = resolve);
  await page.route("**/api/notes", async route => { if (route.request().method() === "POST") { startedRevert(); await waitRevert; } await route.continue(); });
  await field.fill("temporary in flight"); await caughtRevert; await field.fill("newer while saving"); releaseRevert();
  await page.getByText("Saved just now", { exact: true }).waitFor(); await page.unroute("**/api/notes"); await pause(800); assert.equal((await currentNote()).text, "newer while saving");
});

test("actual outage retains a recoverable notes draft, and same-base recovery saves automatically", async () => {
  await panel(); await stop();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("outage draft"); await page.getByText(/Couldn't save:/).waitFor();
  await start(); await panel(); await noteEquals("outage draft"); assert.equal(await page.locator(".notes-conflict").count(), 0);
  await pause(600);
});

test("legacy popped routes report missing scopes and return to the app in the same tab", async () => {
  const count = page.context().pages().length;
  for (const scope of ["run:deleted-run", "project:deleted-project"]) {
    await open(`#/side/files/${scope}`); await page.getByText(scope.startsWith("run") ? "This run no longer exists." : "Project not found.", { exact: true }).waitFor();
    assert.equal(await page.locator(".side-body").getByText("Choose a repository first.", { exact: true }).count(), 0);
    await page.getByRole("link", { name: "Open code-flow", exact: true }).click(); await page.locator(".rail").waitFor(); assert.equal(page.context().pages().length, count);
  }
  await open(`#/side/files/project:${alpha.id}`); await page.locator(".side-scope").getByText("Side Alpha", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Open code-flow", exact: true }).click(); await page.locator(".rail").waitFor();
  await panel(alpha, "Files"); await page.getByRole("button", { name: "Expand side panel", exact: true }).click(); await page.getByRole("button", { name: "Restore side panel", exact: true }).waitFor(); await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Expand side panel", exact: true }).waitFor();
});

test("interactive terminal follows theme and survives restart visibly until explicit Restart", async () => {
  await panel(alpha, "Terminal"); const pane = page.locator("#side-pane-terminal");
  await pane.locator(".xterm").waitFor(); await pane.locator(".xterm").click(); await page.keyboard.type("cd sub; echo BEFORE_RESTART; pwd"); await page.keyboard.press("Enter");
  await until(async () => /BEFORE_RESTART/.test(await pane.locator(".xterm-rows").innerText()), "terminal output");
  for (let i = 0; i < 3; i++) {
    await page.locator('header.topbar button[aria-label^="Use the"]').click();
    await until(() => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement), terminal = document.querySelector(".xterm-rows");
      const probe = document.createElement("span"); probe.style.color = root.getPropertyValue("--text"); document.body.append(probe);
      const matches = !!terminal && getComputedStyle(terminal).color === getComputedStyle(probe).color; probe.remove(); return matches;
    }), "terminal theme matches stylesheet");
  }
  await page.evaluate(() => localStorage.removeItem("theme")); await page.reload(); await pane.locator(".xterm-rows").waitFor();
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await until(() => page.evaluate(() => {
      const probe = document.createElement("span"); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--text"); document.body.append(probe);
      const terminal = document.querySelector(".xterm-rows"), matches = !!terminal && getComputedStyle(terminal).color === getComputedStyle(probe).color; probe.remove(); return matches;
    }), "system terminal theme");
  }
  await stop(); await start();
  await until(async () => /This terminal is gone/.test(await pane.innerText()), "gone restart notice", 25000);
  assert.match(await pane.innerText(), /BEFORE_RESTART/); assert.equal((await api("/api/shell")).body.length, 0);
  await page.screenshot({ path: join(evidence, "terminal-gone.png"), fullPage: true });
  await pane.getByRole("button", { name: "Restart", exact: true }).click(); await until(async () => (await api("/api/shell")).body.length === 1, "explicit restart");
  await until(async () => !/This terminal is gone/.test(await pane.innerText()), "new terminal connected");
  // Keep the document mounted too: the shell poll must not unmount scrollback ahead of the stream.
  await pane.locator(".xterm").click(); await page.keyboard.type("echo BEFORE_NO_RELOAD"); await page.keyboard.press("Enter");
  await until(async () => /BEFORE_NO_RELOAD/.test(await pane.innerText()), "second terminal marker");
  const self = (await api("/api/auth/self")).body;
  await page.route("**/api/auth/self", route => route.fulfill({ json: self }));
  let navigations = 0; const navigated = () => { navigations++; }; page.on("framenavigated", navigated);
  await stop(); await start(); await until(async () => /This terminal is gone/.test(await pane.innerText()), "gone without reload"); await pause(8000);
  assert.equal(navigations, 0); assert.match(await pane.innerText(), /BEFORE_NO_RELOAD/); assert.equal((await api("/api/shell")).body.length, 0);
  page.off("framenavigated", navigated); await page.unroute("**/api/auth/self");
  await page.reload(); await pane.getByRole("button", { name: "Restart", exact: true }).waitFor(); await pause(500);
});

test("line terminals isolate project history and split panes keep each other's commands", async () => {
  await page.goto("about:blank"); await stop(); lineMode = true; await start();
  await panel(alpha, "Terminal"); const pane = page.locator("#side-pane-terminal");
  const old = (await api("/api/shell")).body; assert.equal(old.length, 0);
  await pane.getByRole("button", { name: "Restart", exact: true }).click(); await pane.getByRole("textbox", { name: "Command", exact: true }).waitFor();
  const command = pane.getByRole("textbox", { name: "Command", exact: true });
  await command.fill("echo ALPHA_ONLY"); await command.press("Enter"); await until(async () => /ALPHA_ONLY/.test(await pane.innerText()), "alpha command");
  await command.fill("cd sub; echo LINE_RESTART"); await command.press("Enter"); await until(async () => (await pane.locator(".prompt").getAttribute("title"))?.endsWith("/sub") ?? false, "line shell folder");
  await stop(); await start(); await until(async () => /This terminal is gone/.test(await pane.innerText()), "line gone notice", 25000);
  assert.match(await pane.innerText(), /LINE_RESTART/); await pane.getByRole("button", { name: "Restart", exact: true }).click();
  await until(async () => (await api("/api/shell")).body.some((shell: any) => shell.cwd === alpha.repos[0] + "/sub"), "restart in remembered current folder"); await pause(500);
  await panel(beta, "Terminal"); const betaCommand = pane.getByRole("textbox", { name: "Command", exact: true }); await betaCommand.press("ArrowUp"); assert.equal(await betaCommand.inputValue(), "");
  await pane.getByRole("button", { name: "Split", exact: true }).click(); const commands = pane.getByRole("textbox", { name: "Command", exact: true }); await commands.nth(1).waitFor();
  await commands.nth(0).fill("echo TOP_COMMAND"); await commands.nth(0).press("Enter"); await commands.nth(1).press("ArrowUp"); assert.equal(await commands.nth(1).inputValue(), "echo TOP_COMMAND");
  await commands.nth(1).fill("echo BOTTOM_COMMAND"); await commands.nth(1).press("Enter"); await commands.nth(0).press("ArrowUp"); assert.equal(await commands.nth(0).inputValue(), "echo BOTTOM_COMMAND");
  await page.reload(); await commands.nth(0).waitFor(); await commands.nth(0).press("ArrowUp"); assert.equal(await commands.nth(0).inputValue(), "echo BOTTOM_COMMAND");
  await page.screenshot({ path: join(evidence, "split-history.png"), fullPage: true });
});

test("side chat has an immediate Stop and Resume, and Ask names retained changes in the conversation", async () => {
  await page.goto("about:blank"); await stop(); sleepMs = "3000"; await start(); await panel(alpha, "Chat");
  const pane = page.locator("#side-pane-chat"); await pane.getByRole("textbox", { name: "Message", exact: true }).fill("Say hello from this scratch project"); await pane.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
  await pane.getByRole("button", { name: "Stop", exact: true }).click(); await pane.getByRole("button", { name: /Resume/ }).waitFor(); assert.equal(await page.getByRole("dialog").count(), 0);
  await pane.getByRole("button", { name: /Resume/ }).click(); await pane.getByRole("button", { name: "Stop", exact: true }).waitFor(); await until(async () => await pane.getByRole("button", { name: "Stop", exact: true }).count() === 0, "resumed chat completes", 30000);
  const made = await api("/api/runs", { repo: beta.repos[0], project: beta.id, pattern: "pipeline", task: "Document the fixture", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, loop: { check: "true", maxSteps: 8, maxMinutes: 2 } });
  assert.equal(made.status, 201, JSON.stringify(made)); const run = await settled(made.body.id);
  assert.equal(run.status, "done", run.error); const wt = run.worktrees.find((w: any) => w.name === "build");
  const sent = await api(`/api/runs/${run.id}/followups`, { kind: "side", worktree: "build", agent: "claude", message: "SNEAKY please just look at README", side: { chat: "qa-ask", mode: "ask", title: "Ask test" } }); assert.equal(sent.status, 200, JSON.stringify(sent));
  const done = await settled(run.id); const turn = done.followUps.at(-1); assert.match(turn.warning, /sneaky\.txt/); assert.equal(done.verdict, run.verdict); assert.ok(readFileSync(join(wt.path, "sneaky.txt"), "utf8"));
  await open(`#/side/chat/run:${run.id}`); await page.getByRole("button", { name: /Ask test/ }).first().click(); await page.getByRole("alert").filter({ hasText: /sneaky\.txt/ }).waitFor();
  await page.screenshot({ path: join(evidence, "ask-warning.png"), fullPage: true });
  await page.reload(); await page.getByRole("alert").filter({ hasText: /sneaky\.txt/ }).waitFor();
  await finishNetworkAudit();
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
});


test("restart audit rejects normal-operation errors and keeps exact shutdown boundaries", () => {
  const windows = [{ started: 10, ready: 20, pid: 1 }];
  const shutdown: NetworkRequest = { page: 1, url: base + "/api/project-teams?project=fixture", method: "GET", started: 9, responseAt: 11, status: 503, body: { error: "The backend is stopping" } };
  assert.equal(expectedFailure(shutdown, windows), true);
  for (const request of [
    { ...shutdown, started: 1, responseAt: 9 },
    { ...shutdown, started: 20, responseAt: 22 },
    { ...shutdown, started: 21, responseAt: 22 },
    { ...shutdown, started: Infinity },
    { ...shutdown, body: { error: "Storage is unavailable" } },
    { ...shutdown, body: undefined },
    { ...shutdown, status: 500 },
    { ...shutdown, method: "POST" },
    { ...shutdown, url: "https://unrelated.test/api/project-teams" },
  ]) {
    assert.equal(expectedFailure(request, windows), false);
    assert.throws(() => assert.deepEqual(networkAudit([request], [], windows).pageErrors, []), "unexpected HTTP errors must still fail the actual audit");
  }
  const update = { ...shutdown, method: "POST", url: base + "/api/stream/0123456789abcdef01234567" };
  assert.equal(expectedFailure(update, windows), true);
  for (const request of [{ ...update, started: 21, responseAt: 22 }, { ...update, body: { error: "Stream update failed" } }, { ...update, url: base + "/api/stream/not-a-client" }]) {
    assert.equal(expectedFailure(request, windows), false);
    assert.throws(() => assert.deepEqual(networkAudit([request], [], windows).pageErrors, []));
  }
  const failed: NetworkRequest = { page: 1, url: base + "/api/serve", method: "GET", started: 9, failedAt: 11, failure: "net::ERR_SOCKET_NOT_CONNECTED" };
  const late = { ...failed, started: 21, failedAt: 22 };
  assert.equal(expectedFailure(failed, windows), true); assert.equal(expectedFailure(late, windows), false);
  const message = { page: 1, url: failed.url, at: 22, text: "Failed to load resource: net::ERR_SOCKET_NOT_CONNECTED" };
  assert.throws(() => assert.deepEqual(networkAudit([failed, late], [message], windows).consoleErrors, []), "a later same-URL failure cannot borrow the earlier restart");
  assert.equal(networkAudit([], [message], windows).consoleErrors.length, 1, "console errors without a matching observed request stay unexpected");
  for (const failure of ["net::ERR_TIMED_OUT", "net::ERR_NAME_NOT_RESOLVED", "net::ERR_ABORTED", "Unknown request failure"]) {
    const unknown = { ...failed, failure };
    assert.equal(expectedFailure(unknown, windows), false);
    assert.throws(() => assert.deepEqual(networkAudit([unknown], [], windows).consoleErrors, []), "an unclassified failure without console output must fail the actual audit");
    assert.throws(() => assert.deepEqual(networkAudit([{ ...shutdown, failedAt: 12, failure }], [], windows).consoleErrors, []), "an expected shutdown response cannot hide a later unknown transport failure");
  }
  assert.equal(expectedFailure({ ...late, url: base + "/api/notes", method: "POST", failure: "net::ERR_INTERNET_DISCONNECTED", deliberateOffline: true }, []), true);
  assert.equal(expectedFailure({ ...late, url: base + "/api/notes", method: "POST", failure: "net::ERR_INTERNET_DISCONNECTED" }, []), false);
});
