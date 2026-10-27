import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { certificateFixture } from "../remote-tls-fixture.js";
import { consumeExpectedCount401, type Count401 } from "../phone-pairing-audit.js";

const root = fileURLToPath(new URL("../..", import.meta.url)), fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-pairing-"))), repo = join(fixture, "repo"), token = "qa-phone-owner";
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
interface Instance { home: string; base: string; remote: string; child: ChildProcess; log: string }
let main: Instance, expired: Instance, broken: Instance, browser: Browser, owner: Page, phone: Page, other: Page, project: string, info: any, certificate: Awaited<ReturnType<typeof certificateFixture>>, expiredSession: string;
const instances: Instance[] = [], errors: string[] = [], consoleMessages: string[] = [];
const consoleEvents: { page: Page; text: string }[] = [], countResponses: (Omit<Count401, "page"> & { page: Page })[] = [], responseReads: Promise<void>[] = [];
let revokeStartedAt = 0, revokedAt = 0, revoked = false, rotationStartedAt = 0, rotatedAt = 0, rotated = false;
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 20_000) { const end = Date.now() + timeout; for (;;) { const value = await read(); if (accept(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 75)); } }
async function freePort() { const port = await new Promise<number>(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); }); assert.ok(port !== 4317 && port !== 4318); return port; }
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", instance = main) { const response = await fetch(instance.base + path, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); assert.ok(response.ok, `${response.status} ${path} ${JSON.stringify(data)}`); return data; }
async function start(name: string, mode?: "expired" | "broken") {
  const home = join(fixture, name), port = await freePort(), remotePort = await freePort(); mkdirSync(home);
  if (mode) writeFileSync(join(home, "remote.json"), JSON.stringify({ enabled: true, lan: true, transport: "lan", control: true, token: "a".repeat(48), controlToken: "b".repeat(48), pairingUntil: Date.now() + (mode === "expired" ? -60_000 : 600_000) }));
  if (mode === "expired") { const { PhoneSessions } = await import("../../src/phone-sessions.js"); expiredSession = (await new PhoneSessions(join(home, "phone-devices.json")).pair("Existing phone", "b".repeat(48))).token; }
  if (mode === "broken") writeFileSync(join(home, "phone-devices.json"), "broken");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remotePort), CODEFLOW_TLS_CERT: certificate.certPath, CODEFLOW_TLS_KEY: certificate.keyPath, CODEFLOW_LAN_ALLOW_LOCAL: "1", CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL: "0", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  const instance = { home, base: `http://127.0.0.1:${port}`, remote: `https://127.0.0.1:${remotePort}`, child, log: "" }; instances.push(instance); for (const stream of [child.stdout, child.stderr]) stream?.on("data", value => instance.log += String(value));
  await until(() => fetch(instance.base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean); return instance;
}
function request(instance: Instance, path: string, options: { method?: string; cookie?: string; origin?: string; site?: string; userAgent?: string } = {}) {
  return new Promise<{ status: number; body: string; cookie?: string; type: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpsRequest(new URL(path, instance.remote), { rejectUnauthorized: false, method: options.method ?? "GET", headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.origin ? { origin: options.origin } : {}), ...(options.site ? { "sec-fetch-site": options.site } : {}), "user-agent": options.userAgent ?? iphone } }, response => { let body = ""; response.setEncoding("utf8"); response.on("data", value => body += value); response.on("end", () => resolve({ status: response.statusCode!, body, type: String(response.headers["content-type"]), cookie: response.headers["set-cookie"]?.[0], headers: response.headers })); }); req.on("error", reject); req.end();
  });
}
async function newPage(mobile = true) { const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, isMobile: mobile, hasTouch: mobile, userAgent: mobile ? iphone : undefined, ignoreHTTPSErrors: true }); const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error" || message.type() === "warning") { const text = `${message.text()} ${message.location().url}`; consoleMessages.push(text); consoleEvents.push({ page, text }); } }); page.on("response", response => { if (response.status() !== 401 || new URL(response.url()).pathname !== "/api/projects/counts") return; const receivedAt = performance.now(); const work = response.json().catch(() => undefined).then(body => { countResponses.push({ page, url: response.url(), method: response.request().method(), status: response.status(), body, receivedAt }); }); responseReads.push(work); }); return page; }
async function shot(page: Page, name: string) { if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); } }
before(async () => {
  mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Pairing fixture\n"); const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", ...args], { cwd: repo }); git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "base");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(fixture, "build") } });
  certificate = await certificateFixture(fixture); main = await start("main"); expired = await start("expired", "expired"); broken = await start("broken", "broken");
  browser = await chromium.launch({ channel: "chrome", headless: true }); owner = await newPage(false); phone = await newPage(); other = await newPage();
  project = (await api("/api/projects", { name: "Phone fixture", repos: [repo] })).id;
  await owner.goto(`${main.base}/?token=${token}#/settings/connections/devices`);
  await owner.getByLabel("Enable remote access", { exact: true }).click(); await until(() => api("/api/remote"), value => value.enabled); await owner.getByLabel("Remote connection", { exact: true }).selectOption("lan"); await owner.getByLabel("Full control from remote devices", { exact: true }).click(); await until(() => api("/api/remote"), value => value.control);
  await owner.getByText("Paired devices · 0", { exact: true }).click(); info = await api("/api/remote"); assert.equal(info.control, true);
});
after(async () => {
  await Promise.all(responseReads);
  await browser?.close();
  // The close can deliver final response events after the first snapshot. Drain those body reads too.
  for (let seen = 0; seen < responseReads.length;) { const batch = responseReads.slice(seen); seen += batch.length; await Promise.all(batch); }
  for (const instance of instances) { if (instance.child.exitCode === null && instance.child.signalCode === null) { const ended = new Promise(resolve => instance.child.once("exit", resolve)); instance.child.kill("SIGTERM"); await ended; } if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, instance.home.split("/").at(-1) + ".log"), instance.log); } assert.doesNotMatch(instance.log, /Uncaught exception|uncaughtException|unhandledRejection|ReferenceError|TypeError:/); }
  if (evidence) writeFileSync(join(evidence, "browser-console.json"), JSON.stringify(consoleMessages, null, 2));
  const counts: Count401[] = countResponses.map(event => ({ ...event, page: event.page === phone ? "phone" : event.page === other ? "other" : "unknown" }));
  const transitions = { remote: main?.remote ?? "", revokeStartedAt, revokedAt, revoked, rotationStartedAt, rotatedAt, rotated };
  const diagnostics = evidence ?? fixture; mkdirSync(diagnostics, { recursive: true });
  const diagnosticPath = join(diagnostics, "count-401-evidence.json");
  writeFileSync(diagnosticPath, JSON.stringify({ transitions, responses: counts }, null, 2));
  console.log(JSON.stringify({ phoneAuditDiagnostics: diagnosticPath }));
  const unexpectedCounts = counts.filter(event => !consumeExpectedCount401(event.page, event.url, [event], transitions));
  assert.deepEqual(errors, []); assert.deepEqual(consoleEvents.filter(({ page, text }) => {
    const match = text.match(/^Failed to load resource:.*status of (\d+).* (https?:\/\/\S+)$/); if (!match) return true;
    const status = Number(match[1]), url = match[2]!, path = new URL(url).pathname;
    if (path.startsWith("/r/") && [403, 404, 409, 503].includes(status) || path === "/" && status === 401 || path === "/favicon.ico" && status === 404) return false;
    if (path === "/api/projects/counts" && status === 409) return false; // The deliberate policy update fences concurrent count reads.
    const source = page === phone ? "phone" : page === other ? "other" : "unknown";
    if (status === 401 && consumeExpectedCount401(source, url, counts, transitions)) return false;
    return true;
  }).map(event => event.text), []);
  assert.deepEqual(unexpectedCounts, [], "every observed count 401 must match a proven invalidated phone");
  rmSync(fixture, { recursive: true, force: true });
});

test("link previews create no sessions, repeat scans reuse a session, and paired devices refresh with friendly labels", async () => {
  for (let n = 0; n < 4; n++) { const preview = await request(main, info.phonePath, { userAgent: "Slackbot-LinkExpanding" }); assert.equal(preview.status, 200); assert.equal(preview.cookie, undefined); }
  assert.equal((await api("/api/remote/devices")).length, 0);
  await phone.goto(main.remote + info.phonePath); await phone.waitForURL(main.remote + "/"); await phone.getByRole("heading", { name: "What would you like to work on?", exact: true }).waitFor();
  const cookie = (await phone.context().cookies()).find(c => c.name.startsWith("codeflow_phone_"))!.value;
  for (let n = 0; n < 3; n++) { await phone.goto(main.remote + info.phonePath); await phone.waitForURL(main.remote + "/"); }
  assert.equal((await phone.context().cookies()).find(c => c.name.startsWith("codeflow_phone_"))!.value, cookie);
  assert.equal((await api("/api/remote/devices")).length, 1);
  await owner.getByText("Paired devices · 1", { exact: true }).waitFor(); await owner.locator(".pd-name", { hasText: "iPhone · Safari" }).waitFor(); assert.match(await owner.locator(".pd-when").innerText(), /Paired .*expires/); await shot(owner, "device-auto-refresh");
  await phone.route("http://qr-scanner.example/", route => route.fulfill({ contentType: "text/html", body: `<a href="${main.remote}${info.phonePath}">Open link</a>` }));
  await phone.goto("http://qr-scanner.example/"); await phone.getByRole("link", { name: "Open link", exact: true }).click(); await phone.waitForURL(main.remote + "/"); assert.equal((await api("/api/remote/devices")).length, 1, "cross-site reopen also reuses its Strict cookie at POST");
});

test("same-model devices are distinguishable and revoking one leaves the other signed in", async () => {
  await other.goto(main.remote + info.phonePath); await other.waitForURL(main.remote + "/");
  await owner.getByText("Paired devices · 2", { exact: true }).waitFor(); const devices = await api("/api/remote/devices");
  assert.equal(await owner.locator(".pd-name").allTextContents().then(values => new Set(values).size), 2);
  revokeStartedAt = performance.now();
  await owner.getByRole("button", { name: `Revoke iPhone · Safari ${devices[0].id.slice(0, 6)}`, exact: true }).click(); const remaining = await until(() => api("/api/remote/devices"), value => value.length === 1); assert.ok(!remaining.some((device: any) => device.id === devices[0].id)); revokedAt = performance.now(); revoked = true; await phone.reload(); await phone.getByRole("heading", { name: "Scan the QR code again", exact: true }).waitFor();
  assert.match(await phone.locator("body").innerText(), /Settings → Connections → Share access → Connect my devices/); assert.doesNotMatch(await phone.locator("body").innerText(), /Automations/); await shot(phone, "revoked-phone");
  await other.reload(); await other.getByRole("heading", { name: "What would you like to work on?", exact: true }).waitFor();
});

test("pairing limits return an actionable HTML 409 without logging the pairing secret", async () => {
  for (let n = (await api("/api/remote/devices")).length; n < 32; n++) assert.equal((await request(main, info.phonePath + "/pair", { method: "POST", origin: main.remote })).status, 200);
  const capped = await request(main, info.phonePath + "/pair", { method: "POST", origin: main.remote }); assert.equal(capped.status, 409); assert.match(capped.type, /text\/html/); assert.equal(capped.cookie, undefined); assert.match(capped.body, /revoke an unused device/);
  const page = await newPage(); await page.goto(main.remote + info.phonePath); await page.getByRole("heading", { name: "Device limit reached", exact: true }).waitFor(); await shot(page, "device-limit"); await page.context().close();
  assert.ok(!main.log.includes(info.phonePath)); const log = join(main.home, "server.log"); try { assert.ok(!readFileSync(log, "utf8").includes(info.phonePath)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const options of [{ origin: "https://evil.example" }, { origin: "null", site: "cross-site" }, {}]) assert.equal((await request(main, info.phonePath + "/pair", { method: "POST", ...options })).status, 403);
});

test("expired, unavailable and damaged-storage phone links render readable pages", async () => {
  for (const [instance, path, status, heading] of [
    [expired, "/r/" + "b".repeat(48), 403, "This pairing link expired"],
    [main, "/r/rotated-link", 404, "This link is no longer available"],
    [main, info.path + "/run/missing", 404, "This link is no longer available"],
  ] as const) { const response = await request(instance, path); assert.equal(response.status, status); assert.match(response.type, /text\/html/); assert.equal(response.cookie, undefined); assert.equal(response.headers["cache-control"], "no-store"); const p = await newPage(); await p.goto(instance.remote + path); if (instance === expired) await p.waitForURL(url => url.pathname.endsWith("/pair")); await p.getByRole("heading", { name: heading, exact: true }).waitFor(); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await shot(p, heading.split(" ").join("-")); await p.context().close(); }
  const page = await newPage(); await page.goto(broken.remote + "/r/" + "b".repeat(48)); await page.getByRole("heading", { name: "Pairing is temporarily unavailable", exact: true }).waitFor(); await shot(page, "storage-unavailable"); await page.context().close(); assert.equal(readFileSync(join(broken.home, "phone-devices.json"), "utf8"), "broken");
});

test("finished read-only pages explain manual refresh and restrictions and rotation remain readable", async () => {
  const started = await api("/api/runs", { repo, pattern: "solo", task: "Add a tiny note", roles: { agent: ["claude"] }, loop: { check: "true", maxSteps: 4 } });
  const run = await until(() => api(`/api/runs/${started.id}`), value => value.status !== "running"); assert.equal(run.status, "done", run.error);
  const page = await newPage(); await page.goto(main.base + info.path); assert.equal(await page.locator('meta[http-equiv="refresh"]').count(), 1);
  await page.goto(main.base + info.path + "/run/" + run.id); assert.equal(await page.locator('meta[http-equiv="refresh"]').count(), 0); assert.match(await page.locator(".foot").innerText(), /refresh this page for updates/); await shot(page, "finished-read-only");
  const policy = await api(`/api/projects/${project}/filesystem-policy`); await api(`/api/projects/${project}/filesystem-policy`, { revision: policy.revision, read: { allow: ["."], deny: ["secrets"] }, write: { allow: ["."], deny: [] } }, "PUT");
  await page.reload(); await page.getByRole("heading", { name: "Phone view is paused", exact: true }).waitFor(); await shot(page, "restricted-phone");
  const saved = await api(`/api/projects/${project}/filesystem-policy`); await api(`/api/projects/${project}/filesystem-policy`, { revision: saved.revision, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } }, "PUT");
  rotationStartedAt = performance.now(); const rotation = await api("/api/remote", { rotate: true }); assert.notEqual(rotation.phonePath, info.phonePath); rotatedAt = performance.now(); rotated = true; await page.reload(); await page.getByRole("heading", { name: "This link is no longer available", exact: true }).waitFor();
  // These paired-phone replays are complete. Close their active app sessions before
  // deliberately removing the listener, so a background auth reload is not orphaned.
  await Promise.all([phone.context().close(), other.context().close()]);
  await api("/api/remote", { enabled: false }); await page.reload(); await page.getByRole("heading", { name: "This link is no longer available", exact: true }).waitFor(); await page.context().close();
});


test("an already paired phone can reopen an expired QR deep link from another site", async () => {
  const page = await newPage(), port = new URL(expired.remote).port;
  await page.context().addCookies([{ name: `codeflow_phone_${port}`, value: expiredSession, domain: "127.0.0.1", path: "/", secure: true, httpOnly: true, sameSite: "Strict" }]);
  await page.route("http://qr-scanner.example/", route => route.fulfill({ contentType: "text/html", body: `<a href="${expired.remote}/r/${"b".repeat(48)}/run/qa-existing">Open saved run</a>` }));
  await page.goto("http://qr-scanner.example/"); await page.getByRole("link", { name: "Open saved run", exact: true }).click();
  await page.waitForURL(`${expired.remote}/#/run/qa-existing`);
  const cookies = await page.context().cookies(); assert.equal(cookies.find(cookie => cookie.name === `codeflow_phone_${port}`)?.value, expiredSession);
  assert.equal((await api("/api/remote/devices", undefined, "GET", expired)).length, 1);
  assert.equal((await request(expired, "/api/runs", { cookie: `codeflow_phone_${port}=${expiredSession}` })).status, 200);
  await page.context().close();
});
