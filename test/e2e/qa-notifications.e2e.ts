import { tmpdir } from "node:os";
import { reserveQaPorts } from "../qa-port-block.js";
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer as createReceiver, type Server as HttpsServer } from "node:https";
import { chromium, type Browser, type Page } from "playwright-core";
const qaPorts = await reserveQaPorts(2, process.env.QA_NOTIFICATIONS_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url)), scratch = mkdtempSync(join(realpathSync(tmpdir()), "cf-qa-notifications-ui-"));
const home = join(scratch, "data"), repo = join(scratch, "repo"), gh = join(scratch, "gh.json"), shots = join(root, "output/playwright/qa-notifications");
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "notifications54-fixture";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
let server: ChildProcess, receiver: HttpsServer, browser: Browser, page: Page, project: string, receiverUrl: string, mode = 200, badState = false, offline = false, damagedStart = 0, damagedEnd = 0;
const requests: { path: string; status: number; payload: any }[] = [], errors: string[] = [], expected: string[] = [], logs: string[] = [], shutdowns: { start: number; end: number }[] = [], restartDiagnostics: unknown[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
async function api(path: string, body?: unknown) { const r = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(r.ok, `${r.status}: ${await r.clone().text()}`); return r.json(); }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 30000) { const end = Date.now() + timeout; for (;;) { const value = await read(); if (ready(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value)); await pause(100); } }
async function start() {
  await qaPorts.release();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  server = spawn(process.execPath, ["--import", "./test/qa-notifications-transport.mjs", "--import", "tsx", "src/server.ts"], { cwd: root, env: { ...inherited, HOME: join(scratch, "os-home"), SHELL: join(scratch, "bash"), BASH_ENV: "", ENV: "", CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_WATCH_INTERVAL_MS: "1000", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_GH_STATE: gh, FAKE_NO_APP_SERVER: "1", CODEFLOW_CODEX_TRANSPORT: "exec", NODE_EXTRA_CA_CERTS: join(scratch, "cert.pem"), CODEFLOW_NOTIFICATIONS_JSON: JSON.stringify(["main", "302", "307", "308"].map(id => ({ id: `fixture-${id}`, name: `Fixture ${id}`, protocol: "webhook", urlEnv: `QA_NOTIFICATION_${id.toUpperCase()}`, secretEnv: "QA_NOTIFICATION_CREDENTIAL" }))), QA_NOTIFICATION_MAIN: receiverUrl + "/main", QA_NOTIFICATION_302: receiverUrl + "/302", QA_NOTIFICATION_307: receiverUrl + "/307", QA_NOTIFICATION_308: receiverUrl + "/308", QA_NOTIFICATION_CREDENTIAL: "private-notification-fixture" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", data => logs.push(String(data))); server.stderr?.on("data", data => logs.push(String(data)));
  await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean);
}
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; const window = { start: Date.now(), end: Infinity }; shutdowns.push(window); const ended = new Promise<void>(resolve => server.once("exit", () => resolve())); const timer = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM"); await ended; window.end = Date.now(); clearTimeout(timer); }
async function open() { await page.goto(`${base}/?token=${token}#/settings/notifications`); }
const panel = () => page.getByRole("region", { name: "Outbound notifications", exact: true });
const target = (id = "main") => page.getByRole("article", { name: `Notification settings for Fixture ${id}`, exact: true });
async function save() { await target().getByRole("button", { name: "Save notification settings", exact: true }).click(); await until(() => target().getByRole("button", { name: "Save notification settings", exact: true }).isEnabled(), Boolean); }
async function newRun(extra: object = {}) { return api("/api/runs", { project, repo, pattern: "solo", task: "Fixture notification task", roles: { agent: ["claude"] }, loop: { prove: false, check: "true", maxMinutes: 1 }, ...extra }); }
async function deliveries() { return api("/api/notifications/deliveries"); }
async function shot(name: string) { await page.screenshot({ animations: "disabled", path: join(shots, name + ".png"), fullPage: true }); }
before(async () => {
  mkdirSync(shots, { recursive: true }); mkdirSync(repo); mkdirSync(join(scratch, "os-home")); writeFileSync(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  git("init", "-qb", "main"); writeFileSync(join(repo, "README.md"), "Fixture\n"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), '{"check":"true","prove":false}'); git("add", "."); git("commit", "-qm", "fixture"); git("clone", "--bare", "-q", repo, join(scratch, "origin.git")); git("remote", "add", "origin", join(scratch, "origin.git")); git("fetch", "origin"); writeFileSync(gh, JSON.stringify({ prs: {}, issues: [] }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(scratch, "key.pem"), "-out", join(scratch, "cert.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-days", "2"], { stdio: "ignore" });
  receiver = createReceiver({ key: readFileSync(join(scratch, "key.pem")), cert: readFileSync(join(scratch, "cert.pem")) }, (req, res) => { let body = ""; req.on("data", data => body += data); req.on("end", () => { const status = req.url === "/main" ? mode : Number(req.url?.slice(1)) || 200; requests.push({ path: req.url!, status, payload: JSON.parse(body || "{}") }); if (req.headers.authorization !== "Bearer private-notification-fixture") { res.writeHead(403); res.end(); return; } res.writeHead(status, status >= 300 && status < 400 ? { location: receiverUrl + "/private-location?key=private-redirect-secret" } : {}); res.end("fixture response"); }); });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve)); receiverUrl = `https://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(scratch, "build-home") } }); await start(); project = (await api("/api/projects", { name: "Notifications fixture", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1366, height: 900 } }); page.setDefaultTimeout(15000); await page.addInitScript(() => { if (/^https?:$/.test(location.protocol)) localStorage.setItem("sideOpen", "0"); });
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() !== "error") return; const url = message.location().url, value = `${message.text()} [${url}]`, notificationUrl = [base + "/api/notifications", base + "/api/notifications/deliveries"].includes(url); const known = notificationUrl && (badState && /status of 503/.test(message.text()) || offline && /net::ERR_FAILED/.test(message.text())); (known ? expected : errors).push(value); });
});
afterEach(async t => { if ((t as { error?: unknown }).error) { await shot(`failed-${t.name.slice(0, 40).replace(/[^a-z0-9]/gi, "-")}`); writeFileSync(join(shots, "failed-page.txt"), await page.locator("body").innerText()); } });
after(async () => { await browser?.close(); await stop(); if (receiver) await new Promise<void>(resolve => receiver.close(() => resolve())); writeFileSync(join(shots, "browser.json"), JSON.stringify({ errors, expected, restartDiagnostics }, null, 2)); writeFileSync(join(shots, "server.log"), logs.join("")); writeFileSync(join(shots, "receiver.json"), JSON.stringify(requests, null, 2)); if (existsSync(join(home, "server.log"))) writeFileSync(join(shots, "application.log"), readFileSync(join(home, "server.log"))); rmSync(scratch, { recursive: true, force: true }); });

test("initial slow and offline notification loads never claim the saved lists are empty", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let held = 0;
  await page.route("**/api/notifications{,/**}", async route => { held++; await gate; await route.continue(); }); await open(); await until(async () => held, n => n >= 2);
  await panel().getByRole("status").filter({ hasText: "Loading notification settings" }).waitFor(); assert.equal(await panel().getByText(/Connect Slack or a webhook|No notifications have been queued/).count(), 0); release(); await target().waitFor(); await page.unrouteAll({ behavior: "wait" });
  offline = true; await page.route("**/api/notifications{,/**}", route => route.abort("failed")); await page.reload(); await panel().getByRole("alert").waitFor(); assert.equal(await panel().getByText(/Connect Slack or a webhook|No notifications have been queued/).count(), 0); await page.unrouteAll({ behavior: "wait" }); await panel().getByRole("button", { name: "Retry loading notifications" }).click(); await target().waitFor(); await panel().getByRole("alert").waitFor({ state: "hidden" }); offline = false;
});

test("approval waits survive graceful restart without false failure deliveries and resume with fresh attention", { timeout: 60000 }, async () => {
  await open(); await target().getByLabel("Enable notifications to this destination").check(); await target().getByLabel("All projects", { exact: true }).check();
  for (const label of ["Run finished", "Run or verification failed", "A decision or answer is needed"]) await target().getByLabel(label, { exact: true }).check(); await save();
  const created = await newRun({ pattern: "pipeline", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, approvals: { plan: true } });
  await until(() => api(`/api/runs/${created.id}`), value => !!value.awaiting); await until(deliveries, items => items.some((item: any) => item.runId === created.id && item.event === "needs-attention" && item.state === "delivered"));
  await page.goto("about:blank"); await stop(); await start(); assert.equal((await api(`/api/runs/${created.id}`)).status, "interrupted"); assert.equal((await deliveries()).filter((item: any) => item.runId === created.id && item.event === "failure").length, 0);
  await page.goto(`${base}/#/run/${created.id}`); await page.getByRole("button", { name: /Resume work|Resume run/ }).first().waitFor(); await shot("paused-approval");
  await api(`/api/runs/${created.id}/resume`, {}); await until(() => api(`/api/runs/${created.id}`), value => !!value.awaiting);
  await until(deliveries, items => items.filter((item: any) => item.runId === created.id && item.event === "needs-attention" && item.state === "delivered").length === 2);
  await page.goto("about:blank"); await stop(); await start(); assert.equal(requests.filter(request => request.payload.runId === created.id && request.payload.event === "failure").length, 0); await open();
});

test("real HTTPS redirects show their status and fail once without following the location", async () => {
  for (const id of ["302", "307", "308"]) {
    await target(id).getByRole("button", { name: "Send test notification", exact: true }).click();
    await until(deliveries, items => items.some((item: any) => item.target === `fixture-${id}` && item.state === "failed" && item.httpStatus === Number(id)));
  }
  await page.reload(); const rows = panel().locator("tbody tr"); await until(() => rows.count(), n => n >= 3);
  for (const id of ["302", "307", "308"]) { const row = rows.filter({ hasText: `Fixture ${id}` }); await row.getByText(/Destination redirected/).waitFor(); assert.equal(await row.getByText(/^Next:/).count(), 0); assert.equal(requests.filter(request => request.path === `/${id}`).length, 1); }
  assert.ok(requests.every(request => !request.path.startsWith("/private-location"))); assert.doesNotMatch(JSON.stringify(await deliveries()), /private-redirect-secret|private-location|private-notification-fixture/); await rows.first().scrollIntoViewIfNeeded(); await shot("redirect-failures");
});

test("scope cancellation clears next-attempt text and explicit retries use the singular label", async () => {
  mode = 500; const created = await newRun(); await until(deliveries, items => items.some((item: any) => item.runId === created.id && item.state === "pending" && item.attempts === 1));
  await open(); await target().getByLabel("Run finished", { exact: true }).uncheck(); await save(); const cancelled = (await deliveries()).find((item: any) => item.runId === created.id); assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.nextAttemptAt, undefined);
  const row = panel().locator("tbody tr").filter({ hasText: created.id }); await row.getByText("Cancelled", { exact: true }).waitFor(); assert.equal(await row.getByText(/^Next:/).count(), 0);
  mode = 403; await target().getByRole("button", { name: "Send test notification", exact: true }).click(); const failed = await until(deliveries, items => items.find((item: any) => item.target === "fixture-main" && item.manual && item.state === "failed")); const delivery = failed.find((item: any) => item.target === "fixture-main" && item.manual && item.state === "failed");
  await page.reload(); const manual = panel().locator("tbody tr").filter({ hasText: "Fixture main" }).filter({ hasText: "Manual test" }); await manual.getByRole("button", { name: "Retry delivery" }).click(); await until(deliveries, items => items.some((item: any) => item.id === delivery.id && item.retryCount === 1 && item.state === "failed")); await page.reload(); await manual.getByText("1 manual retry", { exact: true }).waitFor(); assert.equal(await manual.getByText("1 manual retries", { exact: true }).count(), 0); await manual.scrollIntoViewIfNeeded(); await shot("cancel-and-manual-retry"); mode = 200;
});

test("a real signed-out PR watch is quiet after its first needs-attention delivery", { timeout: 65000 }, async () => {
  const created = await newRun({ pattern: "fix-review", roles: { builder: ["claude"], reviewer: ["codex"] } }); const run = await until(() => api(`/api/runs/${created.id}`), value => value.status === "done"); const branch = run.artifacts[0].branch;
  await api(`/api/runs/${run.id}/pr`, { branch, into: "main" }); await api(`/api/runs/${run.id}/watch`, { branch, agent: "claude" });
  await until(() => api(`/api/runs/${run.id}`), value => value.watches[branch]?.state === "green"); const state = JSON.parse(readFileSync(gh, "utf8")); state.signedOut = true; writeFileSync(gh, JSON.stringify(state));
  await until(() => api(`/api/runs/${run.id}`), value => value.watches[branch]?.pollFailures >= 5, 60000); await until(deliveries, items => items.some((item: any) => item.runId === run.id && item.event === "needs-attention" && item.state === "delivered"));
  assert.equal(requests.filter(request => request.payload.runId === run.id && request.payload.event === "needs-attention").length, 1); await open(); const rows = panel().locator("tbody tr").filter({ hasText: run.id }); await rows.first().waitFor(); assert.equal(await rows.count(), 1); await rows.first().scrollIntoViewIfNeeded(); await shot("watch-attention-once"); await api(`/api/runs/${run.id}/watch`, { branch, stop: true }); delete state.signedOut; writeFileSync(gh, JSON.stringify(state));
});

test("damaged saved state replaces settings and history with repair guidance in both screens", async () => {
  await page.goto("about:blank"); await stop(); const file = join(home, "notifications.json"), healthy = readFileSync(file); writeFileSync(file, "{damaged fixture bytes"); badState = true; damagedStart = Date.now(); await start();
  for (const route of ["notifications", "integrations"]) { await page.goto(`${base}/#/settings/${route}`); await panel().getByRole("alert").filter({ hasText: /saved state could not be loaded/ }).waitFor(); assert.match(await panel().innerText(), /server log.*repair.*restart/i); assert.equal(await panel().getByText(/Connect Slack or a webhook|No notifications have been queued/).count(), 0); assert.equal(await panel().getByRole("button", { name: /Save notification settings|Send test notification|Retry delivery/ }).count(), 0); await panel().scrollIntoViewIfNeeded(); await shot(`damaged-state-${route}`); }
  assert.equal(readFileSync(file, "utf8"), "{damaged fixture bytes"); await shot("damaged-state"); await page.goto("about:blank"); await stop(); damagedEnd = Date.now(); writeFileSync(file, healthy); await start(); badState = false; await open(); await target().waitFor(); assert.ok((await deliveries()).length > 0); assert.equal(await panel().getByRole("alert").count(), 0);
});

test("browser, server and receiver logs contain only the deliberate failures", () => {
  assert.deepEqual(errors, []); assert.doesNotMatch(logs.join(""), /UnhandledPromiseRejection|uncaughtException|ReferenceError|TypeError:/);
  const entries = readFileSync(join(home, "server.log"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const damaged = entries.filter(entry => entry.level === "error" && entry.message === "Notifications disabled: delivery state cannot be read" && /Notification state is damaged/.test(entry.error)); assert.equal(damaged.length, 1);
  const refused = entries.filter(entry => entry.level === "error" && ["GET /api/notifications failed", "GET /api/notifications/deliveries failed"].includes(entry.message) && entry.error === "Notification settings and delivery history are unavailable because saved state could not be loaded. The file was preserved. Check the server log, repair the state, then restart the server." && Date.parse(entry.at) >= damagedStart && Date.parse(entry.at) <= damagedEnd);
  assert.equal(refused.length, 4);
  const restart = entries.filter(entry => entry.level === "error" && entry.message === "GET /api/health failed" && entry.error === "The backend is stopping" && shutdowns.some(window => Date.parse(entry.at) >= window.start && Date.parse(entry.at) <= window.end)); restartDiagnostics.push(...restart);
  assert.deepEqual(entries.filter(entry => entry.level === "error" && !damaged.includes(entry) && !refused.includes(entry) && !restart.includes(entry)), []); assert.ok(requests.every(request => !request.path.startsWith("/private-location")));
});
