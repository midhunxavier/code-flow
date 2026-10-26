// Real Chrome and real server lifecycle; all providers and Docker responses are fixture programs.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url)), fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-health-ui-")));
const home = join(fixture, "home"), repo = join(fixture, "repo"), bin = join(fixture, "bin"), modes = join(fixture, "modes.json"), calls = join(fixture, "calls.jsonl");
const token = "qa-health", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let base: string, server: ChildProcess, browser: Browser, page: Page | undefined, project: string, output = "";
const errors: string[] = [], consoleErrors: string[] = [];
const mode = (env: Record<string, string> = {}) => writeFileSync(modes, JSON.stringify(env));
async function until<T>(read: () => Promise<T>, accept: (v: T) => boolean, timeout = 35_000): Promise<T> { const end = Date.now() + timeout; for (;;) { const v = await read(); if (accept(v)) return v; assert.ok(Date.now() < end, JSON.stringify(v).slice(0, 1200)); await new Promise(r => setTimeout(r, 60)); } }
async function api(path: string, body?: unknown) { const r = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(r.ok, `${path}: ${r.status} ${await r.clone().text()}`); return r.json(); }
async function stop() { if (server && server.exitCode === null && server.signalCode === null) { const ended = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await ended; } }
async function launch() { server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: new URL(base).port, PATH: `${bin}:${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_NO_APP_SERVER: "1" }, stdio: "pipe" }); for (const s of [server.stdout, server.stderr]) s?.on("data", v => output += String(v)); await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean); }
async function open(hash = "settings/agents", init: Record<string, string> = {}) { const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.addInitScript(values => { localStorage.setItem("sideOpen", "0"); for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v); }, init); page = await context.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); }); page.on("response", r => { if (r.url().includes("/api/") && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); }); await page.goto(`${base}/?token=${token}#/${hash}`); return page; }
async function shot(name: string) { if (evidence && page) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); } }
const start = (extra: Record<string, unknown> = {}) => api("/api/runs", { repo, project, pattern: "solo", task: "Health QA tiny change", roles: { agent: ["claude"] }, toolApprovals: false, ...extra });
const done = (id: string) => until(() => api(`/api/runs/${id}`), r => r.status !== "running" && !!r.endedAt);
const agyCalls = () => readFileSync(calls, "utf8").trim().split("\n").map(v => JSON.parse(v)).filter(v => v.vendor === "agy" && v.args.includes("models")).length;
before(async () => {
  for (const dir of [home, repo, bin]) mkdirSync(dir); mode(); writeFileSync(calls, "");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", ...args], { cwd: repo }); git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "QA\n"); git("add", "."); git("commit", "-qm", "base");
  writeFileSync(join(bin, "agent.mjs"), `import {readFileSync,appendFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const [vendor,...args]=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify({vendor,args})+'\\n');const env={...process.env,...JSON.parse(readFileSync(${JSON.stringify(modes)},'utf8'))};const result=spawnSync(process.execPath,[${JSON.stringify(join(root, "test/fake-agent.mjs"))},vendor,...args],{env,stdio:'inherit'});process.exit(result.status??1);`);
  for (const vendor of ["claude", "codex", "agy"]) writeFileSync(join(bin, vendor), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, "agent.mjs")}' ${vendor} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "docker"), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({vendor:'docker',args})+'\\n');if(args[0]==='--version'){console.log('Docker version 28.0.0');process.exit(0)}if(args[0]==='rm')process.exit(0);console.error('docker: Error response from daemon: No such image: qa-missing-image:none');process.exit(125);\n`, { mode: 0o755 });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  const port = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const n = (s.address() as AddressInfo).port; s.close(() => resolve(n)); }); }); assert.ok(port !== 4317 && port !== 4318); base = `http://127.0.0.1:${port}`;
  await launch(); project = (await api("/api/projects", { name: "Health QA", repos: [repo] })).id; browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async () => { await page?.context().close(); page = undefined; mode(); });
after(async () => { await browser?.close(); await stop(); if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "server.log"), output); writeFileSync(join(evidence, "console.json"), JSON.stringify(consoleErrors)); } rmSync(fixture, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.doesNotMatch(output, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/); });

test("dependency discovery has one visible heading", async () => {
  const p = await open(); await p.locator("details.settings > summary", { hasText: "Check this computer" }).click();
  assert.equal(await p.getByText("Check this computer", { exact: true }).count(), 1); assert.equal(await p.getByRole("region", { name: "Guided dependency discovery" }).getByRole("heading", { name: "Check this computer" }).count(), 0); await shot("dependency-discovery");
});

test("health busy feedback and a single request survive repeated close/reopen", async () => {
  const p = await open(); await p.getByRole("button", { name: "Refresh providers", exact: true }).waitFor(); await until(() => p.locator(".settings-provider-status").allTextContents(), v => v.length >= 3 && v.every(s => !s.includes("Checking")));
  let probes = 0, release!: () => void; const gate = new Promise<void>(r => release = r);
  await p.route("**/api/doctor", async route => { probes++; const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await p.getByRole("button", { name: "Health & usage", exact: true }).click(); await p.getByRole("dialog").getByRole("status").waitFor();
  assert.equal(await p.getByRole("dialog").getByRole("button", { name: "Checking…", exact: true }).isEnabled(), false);
  await p.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await p.getByText("Check this computer", { exact: true }).click();
  await p.getByRole("button", { name: "Health & usage", exact: true }).click(); await p.getByRole("dialog").getByRole("status").waitFor();
  assert.equal(probes, 1); await shot("health-checking"); release(); await p.getByRole("dialog").getByRole("button", { name: "Check again", exact: true }).waitFor(); await p.unroute("**/api/doctor");
});

test("explicit refresh bypasses warm model cache and detects provider sign-out", async () => {
  const p = await open(); await p.getByRole("button", { name: "Refresh providers", exact: true }).waitFor(); await until(() => api("/api/models"), v => !!v.agy?.models); const before = agyCalls();
  mode({ FAKE_AGY_MODELS_FAIL: "signed-out" }); await p.getByRole("button", { name: "Refresh providers", exact: true }).click();
  await until(() => p.locator(".settings-provider-status").allTextContents(), values => values.some(v => v.includes("Signed out")));
  assert.ok(agyCalls() > before); assert.match((await api("/api/models")).agy.error, /not signed in/); await shot("provider-signed-out");
  mode(); await p.getByRole("button", { name: "Health & usage", exact: true }).click(); await p.getByRole("dialog").getByRole("button", { name: "Check again", exact: true }).click();
  await until(() => p.getByRole("dialog").locator(".health-row", { hasText: "Antigravity" }).innerText(), text => text.includes("Signed in"));
});

test("never-discovered catalogs remain unknown after repeated failed refreshes", async () => {
  mode({ FAKE_AGY_MODELS_FAIL: "network" }); const p = await open("", { repo, composerAdvanced: "1", pattern: "auto-team" });
  // Both live catalog API entry points expose the same unknown state on a first failed discovery.
  const first = await api("/api/model-catalog?antigravityExecution=native"), second = await api("/api/model-catalog", { antigravityExecution: "native" });
  for (const result of [first, second]) { const catalog = result.providers.find((v: any) => v.provider === "agy").catalog; assert.equal(catalog.state, "unknown"); assert.equal(catalog.discoveredAt, 0); }
  await p.locator("details.composer-options > summary").click(); const models = p.getByRole("region", { name: "Automatic worker models" }); await models.getByText("agy · unknown · 0 models", { exact: true }).waitFor(); await models.getByRole("button", { name: "Refresh model catalog", exact: true }).click(); await models.getByRole("button", { name: "Refresh model catalog", exact: true }).waitFor(); assert.equal(await models.getByText("agy · unknown · 0 models", { exact: true }).count(), 1); await shot("catalog-unknown");
});

test("missing Docker image explains local recovery and never pulls or falls back", async () => {
  const p = await open(`project/${project}/new`, { repo, pattern: "solo", roleSel: JSON.stringify({ solo: { agent: ["claude"] } }) });
  await p.getByRole("textbox", { name: "Task", exact: true }).fill("Health QA container failure");
  if (!await p.locator("details.composer-options").evaluate(e => (e as HTMLDetailsElement).open)) await p.getByRole("button", { name: "Edit run options", exact: true }).click();
  await p.locator("details.agent-isolation > summary").click(); await p.getByLabel("Run agents in a prebuilt Docker image", { exact: true }).check(); await p.getByLabel("Image", { exact: true }).fill("qa-missing-image:none");
  await p.locator(".taskbox").getByRole("button", { name: /^Permissions:/ }).click(); await p.getByRole("menuitem", { name: /^Approve for me/ }).click();
  const posted = p.waitForResponse(r => r.url().endsWith("/api/runs") && r.request().method() === "POST"); await p.locator(".task-start").click(); const response = await posted; assert.equal(response.status(), 201); const run = await done((await response.json()).id); assert.match(run.error, /not available locally.*never pulls.*build or load/);
  await p.getByText(/Docker image qa-missing-image:none is not available locally/).first().waitFor(); assert.equal(await p.getByText(/Docker image qa-missing-image:none is not available locally/).count(), 1); await shot("missing-image");
  const docker = readFileSync(calls, "utf8").trim().split("\n").map(v => JSON.parse(v)).filter(v => v.vendor === "docker"); assert.ok(docker.some(v => v.args.includes("--pull=never"))); assert.ok(docker.every(v => ["run", "rm", "--version", "version", "info"].includes(v.args[0])));
});

test("shutdown is explained in the saved turn and remains correct after Resume", async () => {
  mode({ FAKE_SLEEP_MS: "25000", FAKE_SLEEP_VENDOR: "claude" }); const run = await start(); await until(() => api(`/api/runs/${run.id}`), r => r.steps.some((s: any) => s.status === "running" && s.kind === "agent")); await stop(); mode(); await launch();
  const interrupted = await api(`/api/runs/${run.id}`); assert.equal(interrupted.status, "interrupted"); assert.match(interrupted.steps.find((s: any) => s.status === "interrupted").error, /shut down/); assert.doesNotMatch(readFileSync(join(home, "runs", run.id + ".jsonl"), "utf8"), /was cancelled/);
  const p = await open(`run/${run.id}`); await p.getByRole("button", { name: "Resume", exact: true }).waitFor(); assert.doesNotMatch(await p.locator("main").innerText(), /was cancelled/); assert.equal(await p.getByText(/Code Flow shut down while this turn was running/).count(), 1); await shot("shutdown-interrupted"); await p.getByRole("button", { name: "Resume", exact: true }).click(); await done(run.id); await p.reload(); await p.getByText(/Code Flow shut down while this turn was running/).first().waitFor(); assert.doesNotMatch(await p.locator("main").innerText(), /was cancelled/); await shot("shutdown-resumed");
});

test("a running provider preserves the shutdown reason in its transcript", async () => {
  mode({ FAKE_SLEEP_MS: "25000", FAKE_SLEEP_VENDOR: "claude" }); const offset = readFileSync(calls, "utf8").length; const run = await start();
  await until(async () => readFileSync(calls, "utf8").slice(offset), log => log.split("\n").some(line => line && JSON.parse(line).vendor === "claude" && JSON.parse(line).args.includes("-p"))); await new Promise(r => setTimeout(r, 200)); await stop(); mode(); await launch();
  const saved = await api(`/api/runs/${run.id}`); assert.equal(saved.status, "interrupted"); const log = readFileSync(join(home, "runs", run.id + ".jsonl"), "utf8"); assert.doesNotMatch(log, /was cancelled|Run cancelled/); assert.match(log, /Code Flow shut down/);
  const p = await open(`run/${run.id}`); await p.getByText(/Code Flow shut down while this turn was running/).first().waitFor(); assert.equal(await p.getByText(/Code Flow shut down while this turn was running/).count(), 1); await shot("running-shutdown");
});

test("an actual usage rejection shows a limit and reset without an invented percentage", async () => {
  mode({ FAKE_CLAUDE_FAIL: "rejected", FAKE_CLAUDE_RESETS_AT: String(Math.floor(Date.now() / 1000) + 3600), FAKE_NOOP_VENDOR: "claude" }); const run = await done((await start()).id); assert.equal(run.status, "stopped");
  const p = await open(); await p.getByRole("button", { name: "Health & usage", exact: true }).click(); const row = p.getByRole("dialog").locator(".health-row", { hasText: "Claude Code" }); await row.getByText("Usage limit", { exact: true }).waitFor();
  assert.match(await row.innerText(), /Hit its usage limit.*Resets/s); assert.match(await row.innerText(), /Utilization not reported/); assert.doesNotMatch(await row.innerText(), /\? used/); assert.equal(await row.locator(".bar").count(), 0); await shot("usage-limited");
});
