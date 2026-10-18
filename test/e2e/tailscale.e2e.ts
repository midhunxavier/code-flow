// Real server + Chrome, with only the Tailscale CLI/network adapter simulated.
// The proxy preserves the public URL, cookies, Origin, Host and streaming behavior.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer as netServer, type AddressInfo } from "node:net";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { encode } from "uqr";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "codeflow-tailscale-e2e-"));
const home = join(directory, "home"), statusFile = join(directory, "status.json"), bindLog = join(directory, "bind.log");
const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
let tls = false;
const headers = { authorization: "Bearer tailscale-e2e", "content-type": "application/json" };
const freePort = () => new Promise<number>((resolve) => { const server = netServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
const port = await freePort(), remotePort = await freePort();
const base = `http://127.0.0.1:${port}`;
const connected = (ip = "100.101.102.103") => ({ BackendState: "Running", TUN: true, TailscaleIPs: [ip], Self: { Online: true, DNSName: "codeflow.tail-test.ts.net." } });
let child: ChildProcess, browser: Browser, owner: Page, proxy: Server, proxyUrl: string;
async function api(path = "/api/remote", body?: object) {
  const response = await fetch(`${base}${path}`, { headers, method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function setStatus(value: object) { await writeFile(statusFile, JSON.stringify(value)); }
async function assertNoListener() {
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const socket = connect(remotePort, "127.0.0.1", () => { socket.destroy(); resolve(); });
    socket.on("error", reject);
  }), "disabled or disconnected mode opens no fallback listener");
}
async function start(allowLocal = true) {
  child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/tailscale-network-fixture.mjs", "src/server.ts"], { cwd: root, env: {
    ...process.env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remotePort), CODEFLOW_HOME: home,
    CODEFLOW_TOKEN: "tailscale-e2e", CODEFLOW_LAN_ALLOW_LOCAL: allowLocal ? "1" : "0", CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL: "0",
    CODEFLOW_TLS_CERT: tls ? cert : "", CODEFLOW_TLS_KEY: tls ? key : "", FAKE_TAILSCALE_STATUS: statusFile, FAKE_TAILSCALE_BIND_LOG: bindLog,
    PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
  }, stdio: "pipe" });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let index = 0; index < 200; index++) {
    if (await fetch(`${base}/api/health`, { headers }).then((r) => r.ok, () => false)) return;
    if (child.exitCode !== null || index === 199) throw new Error(output);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await stopped; clearTimeout(timer);
}
async function phone() {
  const context = await browser.newContext({ proxy: { server: proxyUrl }, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return context.newPage();
}
async function responseFrom(page: Page, path: string, body?: object) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { path, body });
}
async function refreshUI() {
  const response = owner.waitForResponse((r) => r.url().includes("/api/remote?refresh=1"));
  await owner.getByRole("button", { name: "Refresh Tailscale" }).click();
  await response;
}

before(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=codeflow.tail-test.ts.net"], { stdio: "ignore" });
  await setStatus({ BackendState: "Stopped" });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  await start();
  // Only forward this test's synthetic Tailscale address/port; no external network traffic.
  proxy = createServer((req, res) => {
    const target = new URL(req.url!, "http://invalid");
    if (!["100.101.102.103", "100.101.102.104"].includes(target.hostname) || target.port !== String(remotePort)) { res.writeHead(502); res.end(); return; }
    const upstream = request({ hostname: "127.0.0.1", port: remotePort, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host }, agent: false }, (reply) => {
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on("close", () => upstream.destroy()); req.pipe(upstream);
  });
  // Tunnel TLS unchanged; Chrome sees the real HTTPS origin and Secure cookie behavior.
  proxy.on("connect", (req, socket, head) => {
    if (req.url !== `codeflow.tail-test.ts.net:${remotePort}` && req.url !== `100.101.102.104:${remotePort}`) { socket.destroy(); return; }
    const upstream = connect(remotePort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  owner = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await owner.goto(`${base}/?token=tailscale-e2e`);
  await owner.goto(`${base}/#/settings/remote-access`);
});
after(async () => {
  await browser?.close();
  proxy?.closeAllConnections(); proxy?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
});

test("settings detect disconnected Tailscale, then show the actual remote link and matching QR", { timeout: 60_000 }, async () => {
  const section = owner.getByRole("region", { name: "Remote access", exact: true });
  await section.getByRole("checkbox", { name: "Enable remote access", exact: true }).click();
  await section.getByLabel("Remote connection").selectOption("tailscale");
  await section.getByText("Turn on Tailscale on this computer, then refresh.").waitFor();
  assert.equal(await section.locator("svg.qr").count(), 0);
  await assertNoListener();
  await setStatus({ BackendState: "NeedsLogin" }); await refreshUI();
  await section.getByText("Sign in to Tailscale on this computer, then refresh.").waitFor();
  assert.equal(await section.locator("svg.qr").count(), 0);
  await setStatus(connected()); await refreshUI();
  await section.getByText("Tailscale connected", { exact: true }).waitFor();
  const info = await api();
  assert.match(info.tailscaleUrl, new RegExp(`^http://100\\.101\\.102\\.103:${remotePort}/r/[a-f0-9]+$`));
  assert.deepEqual(info.lanUrls, []);
  assert.match(await readFile(bindLog, "utf8"), /100\.101\.102\.103/);
  const qr = section.getByRole("img", { name: `QR code for ${info.tailscaleUrl}`, exact: true });
  await qr.waitFor();
  const encoded = encode(info.tailscaleUrl, { ecc: "M", border: 0 });
  let expected = "";
  encoded.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) expected += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  assert.equal(await qr.locator("path").getAttribute("d"), expected, "QR encodes the same URL as the link");
  // Verify Copy link from the actual UI without modifying the system clipboard.
  await owner.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.copiedRemote = value; } } })");
  await section.getByRole("button", { name: "Copy link", exact: true }).click();
  assert.equal(await owner.evaluate(() => (window as any).copiedRemote), info.tailscaleUrl);
  const readOnly = await phone();
  await readOnly.goto(info.tailscaleUrl);
  await readOnly.getByText("Read-only view of code-flow", { exact: false }).waitFor();
  assert.equal((await responseFrom(readOnly, "/api/runs")).status, 404);
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await section.screenshot({ path: join(root, "output/playwright/tailscale-desktop.png") });
  await owner.setViewportSize({ width: 390, height: 844 });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "settings fit a phone viewport");
  await owner.screenshot({ path: join(root, "output/playwright/tailscale-mobile.png") });
  await section.getByRole("button", { name: "New link", exact: true }).scrollIntoViewIfNeeded();
  await owner.screenshot({ path: join(root, "output/playwright/tailscale-mobile-link.png") });
  await owner.setViewportSize({ width: 1280, height: 1000 });
});

test("pair through Tailscale, mutate and stream, revoke a device and rotate links", { timeout: 60_000 }, async () => {
  const section = owner.getByRole("region", { name: "Remote access", exact: true });
  assert.equal(await section.getByRole("checkbox", { name: "Full control from remote devices", exact: true }).isDisabled(), true);
  const rejected = await fetch(`${base}/api/remote`, { method: "POST", headers, body: JSON.stringify({ control: true }) });
  assert.equal(rejected.status, 400, "Tailscale alone cannot protect cookies from other HTTP services on the same host");
  await stop(); tls = true; await start(); await owner.reload();
  const saved = owner.waitForResponse((r) => r.url().endsWith("/api/remote") && r.request().method() === "POST");
  await section.getByRole("checkbox", { name: "Full control from remote devices", exact: true }).click();
  await saved;
  const info = await api();
  assert.equal(info.control, true);
  assert.equal(info.secure, true);
  assert.match(info.tailscaleUrl, /^https:\/\/codeflow\.tail-test\.ts\.net:/);
  const tab = await phone();
  await tab.goto(info.tailscaleUrl);
  await tab.waitForURL(`https://codeflow.tail-test.ts.net:${remotePort}/`);
  const session = (await tab.context().cookies()).find((cookie) => cookie.name.startsWith("codeflow_phone_"));
  assert.ok(session?.secure && session.httpOnly, "full-control sessions require Secure HttpOnly cookies");
  assert.equal((await tab.context().cookies(`http://codeflow.tail-test.ts.net:${remotePort + 1}/`)).length, 0, "another HTTP service cannot receive the full-control cookie");
  assert.equal((await responseFrom(tab, "/api/runs")).status, 200);
  const remoteSettings = await responseFrom(tab, "/api/remote", { enabled: true });
  assert.equal(remoteSettings.status, 200, "same-origin POST works through the tailnet address");
  const stream = await tab.evaluate(async () => {
    const controller = new AbortController();
    try {
      const response = await fetch("/api/events", { signal: controller.signal });
      const { value } = await response.body!.getReader().read();
      return { status: response.status, text: new TextDecoder().decode(value) };
    } finally { controller.abort(); }
  });
  assert.equal(stream.status, 200); assert.match(stream.text, /hello/);
  // A real run travels from the remote browser through the owner API to a fake agent.
  const repo = join(directory, "repository");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Remote run fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const started = await responseFrom(tab, "/api/runs", { repo, pattern: "solo", task: "Tailscale remote run", roles: { agent: ["codex"] }, loop: { check: "", maxSteps: 3 } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  let run = (await responseFrom(tab, `/api/runs/${started.body.id}`)).body;
  for (let attempt = 0; attempt < 150 && run.status === "running"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    run = (await responseFrom(tab, `/api/runs/${started.body.id}`)).body;
  }
  assert.equal(run.status, "done", run.error);
  const crossSite = await tab.request.post(`https://codeflow.tail-test.ts.net:${remotePort}/api/remote`, { headers: { origin: "http://evil.example" }, data: {} });
  assert.equal(crossSite.status(), 403);
  const devices = await api("/api/remote/devices");
  assert.equal(devices.length, 1);
  assert.equal((await fetch(`${base}/api/remote/devices/${devices[0].id}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await tab.request.get(`https://codeflow.tail-test.ts.net:${remotePort}/api/runs`)).status(), 401);
  const second = await phone(); await second.goto(info.tailscaleUrl);
  assert.equal((await responseFrom(second, "/api/runs")).status, 200);
  owner.once("dialog", (dialog) => dialog.accept());
  const rotated = owner.waitForResponse((r) => r.url().endsWith("/api/remote") && r.request().method() === "POST");
  await section.getByRole("button", { name: "New link", exact: true }).click();
  await rotated;
  const changed = await api();
  assert.notEqual(changed.phonePath, info.phonePath);
  assert.equal((await second.request.get(`https://codeflow.tail-test.ts.net:${remotePort}/api/runs`)).status(), 401);
  const old = await phone(); const expired = await old.goto(info.tailscaleUrl);
  assert.equal(expired!.status(), 404);
});

test("disconnect, reconnect and address changes never fall back to Wi-Fi; restart retains settings", { timeout: 60_000 }, async () => {
  const before = await api();
  await setStatus({ ...connected(), BackendState: "Stopped" });
  const stopped = await api("/api/remote?refresh=1");
  assert.equal(stopped.tailscaleUrl, undefined); assert.deepEqual(stopped.lanUrls, []);
  await assertNoListener();
  await setStatus({ ...connected("100.101.102.104"), Self: { Online: true } });
  const changed = await api("/api/remote?refresh=1");
  assert.match(changed.tailscaleUrl, /^https:\/\/100\.101\.102\.104:/);
  assert.equal(changed.phonePath, before.phonePath);
  const paired = await phone(); await paired.goto(changed.tailscaleUrl);
  assert.equal((await responseFrom(paired, "/api/runs")).status, 200);
  await stop();
  const saved = JSON.parse(await readFile(join(home, "remote.json"), "utf8"));
  saved.pairingUntil = Date.now() - 1000;
  await writeFile(join(home, "remote.json"), JSON.stringify(saved));
  await start();
  const restarted = await api("/api/remote?refresh=1");
  assert.equal(restarted.transport, "tailscale"); assert.equal(restarted.tailscaleUrl, changed.tailscaleUrl);
  assert.equal((await responseFrom(paired, "/api/runs")).status, 200, "paired devices survive restarts");
  const unpaired = await phone();
  assert.equal((await unpaired.goto(restarted.tailscaleUrl))!.status(), 403, "expired links cannot pair new devices");
  await owner.reload();
  await owner.getByText("Pairing link expired. Choose New link to pair another device.").waitFor();
  assert.equal(await owner.getByRole("region", { name: "Remote access", exact: true }).locator("svg.qr").count(), 0);
  const wifi = await api("/api/remote", { transport: "lan" });
  assert.equal(wifi.control, true, "HTTPS keeps full control available across transports");
  assert.notEqual(wifi.phonePath, restarted.phonePath);
  assert.equal(wifi.tailscaleUrl, undefined);
  await api("/api/remote", { enabled: false });
  await assertNoListener();
  await stop(); tls = false; await start();
  assert.equal((await api()).control, false, "removing TLS disables persisted full control");
});

test("bind failure hides links and production settings refuse connections from this computer", { timeout: 60_000 }, async () => {
  // This address is deliberately not mapped by the fixture, so the real bind fails.
  await setStatus(connected("100.101.102.105")); await api("/api/remote?refresh=1");
  const failed = await api("/api/remote", { enabled: true, lan: true, transport: "tailscale", control: false });
  assert.equal(failed.tailscaleUrl, undefined); assert.deepEqual(failed.lanUrls, []); assert.match(failed.lanError, /couldn't listen on Tailscale/);
  await assertNoListener();
  await setStatus(connected()); await api("/api/remote?refresh=1");
  await stop(); await start(false);
  const info = await api("/api/remote?refresh=1");
  assert.ok(info.tailscaleUrl);
  await assert.rejects(fetch(`http://127.0.0.1:${remotePort}${info.phonePath}`), "local agent processes cannot use remote pairing");
});
