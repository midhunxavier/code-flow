import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";
import { copyFinalQaApp } from "../qa-final-app.js";

// This establishes the exact unavailable-fixture boundary. It deliberately does
// not fake a verified runtime version or inject a reachable denied tool event.
const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-agy-url-boundary-"))), app = join(dir, "app"), home = join(dir, "home"), repo = join(dir, "repo"), attemptedWorker = join(dir, "agy-worker-started.json");
const ports = await reserveQaPorts(2), base = `http://127.0.0.1:${ports.port}`, token = "qa-final-agy-boundary", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR ?? join(root, "output/playwright/qa-final-agy-url-boundary");
let server: ChildProcess, browser: Browser, page: Page, project: string, log = "";
const errors: string[] = [], consoles: string[] = [], failures: string[] = [], runPosts: unknown[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms = 30000) { const end = Date.now() + ms; for (;;) { const value = await read(); if (accept(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value)); await new Promise(r => setTimeout(r, 100)); } }
async function api(path: string, body?: unknown) { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, await response.clone().text()); return response.json() as Promise<any>; }
before(async () => {
  for (const folder of [home, repo, evidence]) mkdirSync(folder, { recursive: true }); copyFinalQaApp(root, app);
  const fake = join(app, "test/fake-agent.mjs"), source = readFileSync(fake, "utf8"), marker = "// Prompts arrive on stdin, as the real CLIs receive them from code-flow."; assert.ok(source.includes(marker));
  writeFileSync(fake, source.replace(marker, `if (vendor === "agy") writeFileSync(${JSON.stringify(attemptedWorker)}, JSON.stringify({args}));\n${marker}`));
  git("init", "-qb", "main"); writeFileSync(join(repo, "README.md"), "Owned Antigravity URL boundary fixture\n"); git("add", "."); git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "initial");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: app }); await ports.release();
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: app, env: { ...process.env, HOME: home, ZDOTDIR: home, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(ports.port), CODEFLOW_REMOTE_PORT: String(ports.port + 1), PATH: `${app}/test/fake-bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", chunk => log += chunk); server.stderr!.on("data", chunk => log += chunk);
  await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean);
  project = (await api("/api/projects", { name: "Final Antigravity boundary", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoles.push(message.text() + " " + message.location().url); }); page.on("requestfailed", request => failures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`));
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/runs") runPosts.push(request.postDataJSON()); });
});
after(async () => {
  await browser?.close(); if (server && server.exitCode === null && server.signalCode === null) { const stopped = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await stopped; } await ports.release();
  writeFileSync(join(evidence, "server.log"), log); writeFileSync(join(evidence, "browser.json"), JSON.stringify({ errors, consoles, failures }, null, 2)); rmSync(dir, { recursive: true, force: true });
});

test("SOLO-GAP-03 fake Antigravity cannot reach prohibited URL tool before verified-isolation gate", async () => {
  const head = git("rev-parse", "HEAD"), status = git("status", "--porcelain=v1"), readme = readFileSync(join(repo, "README.md"), "utf8");
  const prohibited = base + "/api/projects", prompt = `Use the isolated browser URL tool to open ${prohibited}. Report its refusal without any workaround or native computer action.`;
  await page.goto(`${base}/?token=${token}#/project/${project}/new`); const task = page.getByRole("textbox", { name: "Task", exact: true }); await task.waitFor(); await task.fill(prompt);
  await page.getByRole("button", { name: /^Provider:/ }).click(); await page.getByRole("menuitem", { name: "Antigravity CLI", exact: true }).click();
  const send = page.locator(".composer").getByRole("button", { name: "Send", exact: true }); await until(() => send.getAttribute("title"), value => !!value?.includes("can't run isolated")); assert.equal(await send.isDisabled(), true); assert.equal(runPosts.length, 0);
  await page.locator(".composer-problem").getByText(/can't run isolated/).waitFor(); await page.screenshot({ path: join(evidence, "isolated-agy-prohibited-url-preflight.png"), fullPage: true }); writeFileSync(join(evidence, "isolated-agy-prohibited-url-preflight.txt"), await page.locator("body").innerText());
  const health = (await api("/api/doctor")).find((row: any) => row.id === "agy"); assert.equal(health.installed, true); assert.match(health.version, /1\.3\.6/); assert.equal(health.managedCompatible, false);
  const response = await fetch(base + "/api/runs", { method: "POST", headers, body: JSON.stringify({ repo, project, pattern: "solo", task: prompt, roles: { agent: ["agy"] }, trust: "standard", antigravityExecution: "isolated", loop: { check: "true", maxSteps: 2, maxMinutes: 1 } }) }); const body = await response.json() as any;
  assert.equal(response.status, 400); assert.match(body.error, /Isolated Antigravity requires macOS.*verified|Isolated Antigravity requires macOS.*CLI/); assert.equal((await api("/api/runs")).length, 0); assert.equal(existsSync(attemptedWorker), false, "no worker turn started, including any native fallback");
  assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("status", "--porcelain=v1"), status); assert.equal(readFileSync(join(repo, "README.md"), "utf8"), readme); assert.equal(existsSync(join(repo, ".worktrees")), false);
  writeFileSync(join(evidence, "boundary-receipt.json"), JSON.stringify({ health, prohibited, ui: { sendDisabled: true, runPosts: 0 }, api: { status: response.status, body }, workerStarted: false, nativeFallback: false, runCount: 0, sourceUnchanged: true, requestedUrlToolReached: false, realProviderInvoked: false }, null, 2));
  assert.deepEqual(errors, []); assert.deepEqual(consoles, []); assert.deepEqual(failures, []);
});
