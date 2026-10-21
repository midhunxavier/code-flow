import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "codeflow-browser-links-"));
const home = join(directory, "home"), repo = join(directory, "repo");
const token = "browser-links-fixture";
let server: ChildProcess, app: Server, browser: Browser, page: Page, base: string, appUrl: string, unregisteredUrl: string;
let unregisteredRequests = 0;
const portOf = (server: Server) => (server.address() as AddressInfo).port;

before(async () => {
  app = createServer((_request, response) => { unregisteredRequests++; response.writeHead(200, { "content-type": "text/html" }).end("<h1>Unrelated local service</h1>"); });
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  unregisteredUrl = `http://127.0.0.1:${portOf(app)}/unsafe`;
  const appProbe = createServer(); await new Promise<void>(resolve => appProbe.listen(0, "127.0.0.1", resolve));
  const appPort = portOf(appProbe); await new Promise<void>(resolve => appProbe.close(() => resolve()));
  appUrl = `http://127.0.0.1:${appPort}/`;
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${portOf(probe)}`; await new Promise<void>(resolve => probe.close(() => resolve()));
  mkdirSync(join(home, "runs"), { recursive: true }); mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "app.mjs"), "import { createServer } from 'node:http'; createServer((_req,res) => res.writeHead(200, {'content-type':'text/html'}).end('<!doctype html><title>Preview fixture</title><h1>Preview is live</h1>')).listen(Number(process.env.PORT), '127.0.0.1');\n");
  writeFileSync(join(repo, "README.md"), "Preview fixture\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-qm", "fixture"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(home, "projects.json"), JSON.stringify([{ id: "project", name: "Preview project", repos: [repo], createdAt: 1 }]));
  const run = { id: "preview-run", project: "project", repo, baseRef: head, pattern: "solo", task: "Start the server", roles: { agent: ["claude"] }, options: {}, status: "done", createdAt: 1, endedAt: 2, worktrees: [{ name: "solo", path: repo, branch: "main" }], usage: { agentSteps: 1, checks: 0 } };
  const step = { id: "s1", kind: "agent", agent: "claude", title: "Start app", role: "agent", mode: "write", status: "done", startedAt: 1, endedAt: 2, finalText: `Unregistered link: ${unregisteredUrl}.\n\nServer running at [${appUrl}](${appUrl}).\n\n[External reference](https://blocked.example/)` };
  writeFileSync(join(home, "runs/preview-run.jsonl"), [JSON.stringify({ seq: 1, ts: 1, runId: run.id, type: "run", run }), JSON.stringify({ seq: 2, ts: 2, runId: run.id, type: "step", step })].join("\n") + "\n");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: new URL(base).port, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) { if (await fetch(base + "/api/health", { headers: { authorization: `Bearer ${token}` } }).then(response => response.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const launch = await fetch(`${base}/api/runs/preview-run/worktrees/solo/serve`, { method: "POST", headers, body: JSON.stringify({ command: `'${process.execPath.replaceAll("'", "'\\''")}' app.mjs`, port: appPort }) });
  assert.equal(launch.status, 200, await launch.clone().text());
  assert.equal((await launch.json()).port, appPort);
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", error => console.error("Browser error:", error.message));
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); if (server?.exitCode === null) await new Promise<void>(resolve => { server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); app?.closeAllConnections(); await new Promise<void>(resolve => app?.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });

test("a reachable app in an agent answer opens automatically, and link clicks reuse its Browser tab", { timeout: 30_000 }, async () => {
  await page.goto(`${base}/?token=${token}#/run/preview-run`);
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor({ timeout: 10000 }).catch(async error => { console.error((await page.locator("body").innerText()).slice(-5000)); throw error; });
  await page.frameLocator('#side-pane-browser iframe[title="Browser"]').getByRole("heading", { name: "Preview is live" }).waitFor({ timeout: 10000 }).catch(async error => { console.error("Preview state:", await page.locator("#side-pane-browser").innerText(), page.frames().map(frame => frame.url())); throw error; });
  assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), appUrl);
  assert.equal(unregisteredRequests, 0, "agent output cannot probe or open an unrelated host service");
  await page.getByRole("button", { name: "Close side panel", exact: true }).click({ timeout: 5000 });
  await page.locator(".turn-body").getByRole("link", { name: appUrl, exact: true }).click({ timeout: 5000 });
  assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), appUrl);
  assert.equal(page.context().pages().length, 1, "ordinary links stay in the workspace");
  assert.equal(await page.locator("#side-pane-browser .sess-list .sess").count(), 1, "canonical URLs reuse the same tab");
});

test("automatic readiness requires the matching run's registered server", async () => {
  const status = async (url: string, runId?: string) => fetch(`${base}/api/preview/status`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url, runId }) }).then(response => response.json());
  assert.deepEqual(await status(appUrl, "preview-run"), { ready: true });
  assert.deepEqual(await status(appUrl, "unknown-run"), { ready: false });
  assert.deepEqual(await status(appUrl), { ready: false });
  assert.deepEqual(await status(unregisteredUrl, "preview-run"), { ready: false });
  assert.equal(unregisteredRequests, 0);
});

test("blocked external embedding falls back to a snapshot with an interactive new-tab link", { timeout: 30_000 }, async () => {
  let snapshots = 0;
  await page.route("https://blocked.example/**", route => route.fulfill({ status: 200, headers: { "x-frame-options": "SAMEORIGIN" }, contentType: "text/html", body: "<h1>External page</h1>" }));
  await page.route("**/api/frame-policy", route => route.fulfill({ json: { blocked: true, reason: "X-Frame-Options: SAMEORIGIN", url: "https://blocked.example/" } }));
  await page.route("**/api/snapshot", route => { snapshots++; return route.fulfill({ json: { image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4m8AAAAASUVORK5CYII=", width: 1, height: 1, title: "External page", url: "https://blocked.example/" } }); });
  await page.locator(".turn-body").getByRole("link", { name: "External reference", exact: true }).click();
  await page.getByRole("img", { name: "Snapshot of https://blocked.example/", exact: true }).waitFor();
  assert.equal(snapshots, 1);
  assert.match(await page.locator("#side-pane-browser").innerText(), /blocks embedded browsing.*SAMEORIGIN/);
  assert.equal(await page.getByRole("link", { name: "Open the interactive site in a new tab", exact: true }).getAttribute("href"), "https://blocked.example/");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#side-pane-browser").evaluate(element => element.scrollWidth <= element.clientWidth), true);
});
