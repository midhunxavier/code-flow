import { tmpdir } from "node:os";
import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const qaPorts = await reserveQaPorts(2, process.env.QA_SOLO_CHECK_DOCS_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url)), scratch = mkdtempSync(join(realpathSync(tmpdir()), "cf-qa-solo-docs-"));
const data = join(scratch, "data"), records = join(scratch, "records"), shots = join(root, "output/playwright/qa-solo-check-docs"), port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "qa-solo-docs-token";
let server: ChildProcess, browser: Browser, injected = "";
const errors: string[] = [], expected: string[] = [], logs: string[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function api(path: string, body?: unknown) { const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); const value = await r.json(); assert.ok(r.ok, `${r.status} ${JSON.stringify(value)}`); return value; }
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 30000) { const end = Date.now() + timeout; for (;;) { const value = await read(); if (accept(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value)); await pause(100); } }
async function start() {
  await qaPorts.release();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, HOME: join(scratch, "os-home"), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), SHELL: join(scratch, "bash"), BASH_ENV: "", ENV: "", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_RECORD_DIR: records, FAKE_NO_APP_SERVER: "1", CODEFLOW_CODEX_TRANSPORT: "exec" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", value => logs.push(String(value)));
  await until(() => api("/api/health").then(() => true, () => false), Boolean);
}
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; const end = new Promise<void>(resolve => server.once("exit", () => resolve())); const timeout = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM"); await end; clearTimeout(timeout); }
async function page(initial: Record<string, string> = {}, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } }); await context.addInitScript(initial => { if (!sessionStorage.getItem("qa-initialized")) { for (const [k, v] of Object.entries({ sideOpen: "0", ...initial })) localStorage.setItem(k, v); sessionStorage.setItem("qa-initialized", "1"); } }, initial);
  const p = await context.newPage(); p.setDefaultTimeout(15000); p.on("pageerror", error => errors.push(error.message)); p.on("console", message => { if (message.type() !== "error") return; const url = message.location().url, text = message.text(); (injected && url === injected && /status of 503|net::ERR_FAILED/.test(text) ? expected : errors).push(`${text} [${url}]`); }); return p;
}
async function fixture() {
  const repo = mkdtempSync(join(scratch, "repo-")), marker = join(repo, "..", `checks-${readdirSync(scratch).length}.log`); git(repo, "init", "-qb", "main"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ check: "npm test", prove: false })); writeFileSync(join(repo, "README.md"), "Fixture\n"); const scripts = Object.fromEntries(["build", "typecheck", "lint", "test", "test:integration", "test:e2e"].map(name => [name, `node -e "require('fs').appendFileSync('${marker}', '${name}\\n')"`])); writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "qa-fixture", scripts })); git(repo, "add", "."); git(repo, "commit", "-qm", "fixture"); const project = await api("/api/projects", { name: `Docs fixture ${readdirSync(scratch).length}`, repos: [repo] }); return { repo, marker, project };
}
async function composer(p: Page, project: any) { await p.goto(`${base}/?token=${token}#/project/${project.id}/new`); await p.getByRole("textbox", { name: "Task", exact: true }).fill("Document the fixture"); await until(() => p.locator(".task-start").isEnabled(), Boolean); }
async function options(p: Page) { await p.getByRole("button", { name: "Edit run options", exact: true }).click(); const details = p.locator("details.advanced-controls"); if (!await details.evaluate(el => (el as HTMLDetailsElement).open)) await details.locator(":scope > summary").click(); }
async function send(p: Page) { const response = p.waitForResponse(r => r.url().endsWith("/api/runs") && r.request().method() === "POST"); await p.locator(".task-start").click(); const r = await response; assert.equal(r.status(), 201); return r.json(); }
const finished = (id: string) => until(() => api(`/api/runs/${id}`), run => run.status !== "running", 60000);
before(async () => { mkdirSync(shots, { recursive: true }); mkdirSync(records); mkdirSync(join(scratch, "os-home")); writeFileSync(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 }); execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(scratch, "build-home") } }); await start(); browser = await chromium.launch({ channel: "chrome", headless: true }); });
afterEach(async t => { if ((t as { error?: unknown }).error) for (const context of browser.contexts()) for (const p of context.pages()) { const name = t.name.slice(0, 40).replace(/[^a-z0-9]/gi, "-"); await p.screenshot({ path: join(shots, `failed-${name}.png`), fullPage: true }).catch(() => {}); writeFileSync(join(shots, `failed-${name}.txt`), await p.locator("body").innerText()); } for (const context of browser.contexts()) await context.close(); injected = ""; });
after(async () => { await browser?.close(); await stop(); writeFileSync(join(shots, "server.log"), logs.join("")); if (existsSync(join(data, "server.log"))) writeFileSync(join(shots, "application.log"), readFileSync(join(data, "server.log"))); writeFileSync(join(shots, "browser.json"), JSON.stringify({ errors, expected }, null, 2)); rmSync(scratch, { recursive: true, force: true }); });

test("Agent copy and inactive gates match actual first and follow-up turns", async () => {
  const { repo, marker, project } = await fixture(), p = await page({ [`runDefaults:${repo}`]: JSON.stringify({ verification: "thorough" }) }); const loadedProfile = p.waitForResponse(r => r.url().includes("/api/verification/profile") && r.status() === 200); await composer(p, project); await loadedProfile; await options(p); assert.equal(await p.locator(".task-branch").count(), 1); assert.equal(await p.locator(".composer-options .task-branch").count(), 0); await p.getByLabel("Check command for merge validation", { exact: true }).fill("npm test"); assert.match(await p.locator(".pattern-why").innerText(), /do not run checks automatically/); assert.doesNotMatch(await p.locator(".pattern-why").innerText(), /after every turn/); assert.equal(await p.getByLabel("Verification gates", { exact: true }).isEnabled(), true); await p.getByText(/Verification gates are inactive for Agent conversations/).waitFor(); await p.screenshot({ path: join(shots, "solo-run-options.png"), fullPage: true });
  const created = await send(p), run = await finished(created.id); assert.equal(run.pattern, "solo"); assert.equal(run.loop.check, "npm test"); assert.equal(run.loop.verification?.name, "thorough"); assert.equal(run.steps.some((s: any) => s.kind === "check"), false); assert.equal(existsSync(marker), false);
  await p.getByRole("textbox", { name: "Message agent", exact: true }).fill("Add another line to the fixture"); await p.locator(".convo").getByText(/Continues .*session on its branch/).waitFor({ state: "attached" }); await Promise.all([p.waitForResponse(r => r.url().includes(`/api/runs/${run.id}/followups`) && r.request().method() === "POST"), p.getByRole("textbox", { name: "Message agent", exact: true }).press("Enter")]); const next = await finished(run.id); assert.equal(next.steps.some((s: any) => s.kind === "check"), false); assert.equal(existsSync(marker), false);
});

test("managed workflow gates and explicit checkpointed Agent runs still execute checks", async () => {
  const { repo, marker, project } = await fixture(), p = await page(); await composer(p, project); await options(p); await p.getByLabel("Workflow", { exact: true }).selectOption("fix-review"); await p.getByLabel("Verification gates", { exact: true }).selectOption("thorough"); await until(() => p.locator(".task-start").isEnabled(), Boolean); await p.getByText(/Each gate appears in the run's evidence/).waitFor(); const created = await send(p), run = await finished(created.id); assert.equal(run.status, "done", run.error); assert.ok(run.steps.some((s: any) => s.kind === "check")); for (const gate of ["build", "typecheck", "lint", "test:integration", "test:e2e"]) assert.ok(readFileSync(marker, "utf8").includes(gate));
  const managed = await api("/api/runs", { repo, project: project.id, task: "Document another note", pattern: "solo", roles: { agent: ["claude"] }, checkpointOnFinish: true, loop: { check: "npm test", prove: false } }); const checked = await finished(managed.id); assert.equal(checked.status, "done", checked.error); assert.ok(checked.steps.some((s: any) => s.kind === "check"));
});

test("inactive saved gate failures do not block Agent and become active for a team", async () => {
  const { repo, project } = await fixture(), p = await page({ [`runDefaults:${repo}`]: JSON.stringify({ verification: "thorough" }) }); let requests = 0; p.on("request", request => { if (request.url().includes("/api/verification/profile")) requests++; }); injected = base + `/api/verification/profile?repo=${encodeURIComponent(repo)}&preset=thorough`; await p.route(injected, route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Fixture profile offline"}' })); await composer(p, project); await options(p); await until(async () => requests, n => n > 0); assert.equal(await p.getByRole("alert").filter({ hasText: "Fixture profile offline" }).count(), 0); assert.equal(await p.getByLabel("Verification gates", { exact: true }).inputValue(), "thorough"); await p.reload(); await p.getByRole("textbox", { name: "Task", exact: true }).waitFor(); await until(() => p.locator(".task-start").isEnabled(), Boolean); await options(p); await p.getByRole("switch", { name: "AI team", exact: true }).click(); await p.getByRole("alert").filter({ hasText: "Fixture profile offline" }).waitFor(); assert.equal(await p.locator(".task-start").isDisabled(), true); await p.getByRole("switch", { name: "AI team", exact: true }).click(); await until(() => p.locator(".task-start").isEnabled(), Boolean); assert.equal(await p.getByRole("alert").filter({ hasText: "Fixture profile offline" }).count(), 0);
});

test("chat approval defaults and saved choices match the published workflow guide", async () => {
  const { project } = await fixture(), p = await page(); await composer(p, project); await p.getByRole("switch", { name: "AI team", exact: true }).click(); await p.getByRole("button", { name: "Advanced", exact: true }).click(); const dialog = p.getByRole("dialog", { name: "AI team setup" }); await dialog.getByText("Limits and approval", { exact: true }).click(); const approval = dialog.getByRole("checkbox", { name: "Let me approve the plan before teammates start" }); assert.equal(await approval.isChecked(), false); await approval.check(); await dialog.getByRole("button", { name: "Apply team settings", exact: true }).click(); await p.reload(); await p.getByRole("button", { name: "Advanced", exact: true }).click(); await dialog.getByText("Limits and approval", { exact: true }).click(); assert.equal(await approval.isChecked(), true); await p.goto(base + "/docs/auto-team.html"); await p.locator("#content").getByText(/For the chat AI-team toggle, plan approval starts off/).waitFor(); await p.goto(base + "/docs/patterns.html"); await p.locator("#content").getByText("Fix & review", { exact: true }).waitFor(); assert.match(await p.locator("#content").innerText(), /240 minutes and 200 agent steps/);
});

test("public docs use neutral access guidance and recover after sign-in and restart", async () => {
  const p = await page(); const owner = await p.context().newPage(); await owner.goto(`${base}/?token=${token}`); await owner.close(); await p.context().clearCookies(); let helpRequests = 0; p.on("request", request => { if (request.url() === base + "/api/docs-help") helpRequests++; }); await p.goto(base + "/docs/"); await p.locator("#help-status").getByText(/available to the app owner/).waitFor(); assert.equal(helpRequests, 0); assert.equal(await p.locator("#help-form").isVisible(), false); await p.goto(base + "/docs/help.html"); await p.locator("#retry-help").getByText("Check again", { exact: true }).waitFor(); assert.equal(helpRequests, 0);
  injected = base + "/api/auth/self"; await p.route(injected, route => route.abort("failed")); await p.locator("#retry-help").click(); await p.locator("#help-status").getByText(/Can't reach Code Flow/).waitFor(); await p.unroute(injected); injected = ""; await p.locator("#retry-help").click(); await p.locator("#help-status").getByText(/available to the app owner/).waitFor();
  const signIn = await p.context().newPage(); await signIn.goto(`${base}/?token=${token}`); await signIn.close(); await p.locator("#retry-help").click(); await p.locator("#help-form").waitFor(); assert.equal(helpRequests, 1); await p.locator("#question").fill("Keep this documentation draft"); await stop(); await start(); await p.reload(); await p.locator("#help-form").waitFor(); assert.equal(await p.locator("#question").inputValue(), "Keep this documentation draft"); assert.equal(helpRequests, 2); await p.context().clearCookies(); await p.reload(); await p.locator("#help-status").getByText(/available to the app owner/).waitFor(); assert.equal(helpRequests, 2); await p.screenshot({ path: join(shots, "public-docs-owner-hint.png"), fullPage: true });
  const mobile = await page({}, true); await mobile.goto(base + "/docs/"); assert.equal(await mobile.locator("#help-panel").isVisible(), false); await mobile.locator("#open-help").click(); await mobile.locator("#help-status").getByText(/available to the app owner/).waitFor(); assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test("real docs companion sends the matching instruction to the fake CLI for original and follow-up questions", async () => {
  const p = await page(); await p.goto(`${base}/?token=${token}`); await p.goto(base + "/docs/runs.html"); await p.locator("#help-form").waitFor(); await p.locator("#help-agent").selectOption("codex");
  for (const question of ["How do I move a run to another project?", "How do I move a run to another project? Answer in two sentences.", "What does the side panel show?", "How do I move a run to another project?"]) {
    const old = new Set(readdirSync(records)); await p.locator("#question").fill(question); const response = p.waitForResponse(r => r.url() === base + "/api/docs-help" && r.request().method() === "POST"); await p.locator("#send-help").click(); assert.equal((await response).status(), 200); await until(() => p.locator("#help-panel").getAttribute("aria-busy"), value => value === null);
    const call = readdirSync(records).filter(name => !old.has(name)).map(name => JSON.parse(readFileSync(join(records, name), "utf8"))).find(call => call.prompt.includes('"guides"')); assert.ok(call); if (question.includes("move a run")) { const payload = JSON.parse(call.prompt.slice(call.prompt.indexOf('{"guides":'))); assert.ok(payload.guides.some((g: any) => /Moving a run/.test(g.content) && /project chip/.test(g.content))); } assert.notEqual(call.cwd, root);
  }
  await p.screenshot({ path: join(shots, "help-retrieval.png"), fullPage: true });
});

test("opening Files cannot erase a search entered before the first listing completes", async () => {
  const { project } = await fixture(), p = await page(); await composer(p, project);
  await p.evaluate(() => {
    const observer = new MutationObserver(() => {
      const input = document.querySelector<HTMLInputElement>('[role="tabpanel"] input[aria-label="Search files"]');
      if (!input) return;
      observer.disconnect(); input.value = "README"; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await p.getByRole("button", { name: "Side panel", exact: true }).click();
  await p.getByRole("tab", { name: "Files", exact: true }).click();
  const panel = p.getByRole("tabpanel", { name: "Files", exact: true });
  await panel.getByRole("tree", { name: "Matching files", exact: true }).waitFor();
  assert.equal(await panel.getByLabel("Search files", { exact: true }).inputValue(), "README");
  await panel.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await panel.getByLabel("File contents").waitFor();
});

test("browser and server logs contain no unexpected failures", () => { assert.deepEqual(errors, []); assert.doesNotMatch(logs.join(""), /UnhandledPromiseRejection|uncaughtException|ReferenceError|TypeError:/); const entries = readFileSync(join(data, "server.log"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); assert.deepEqual(entries.filter(entry => entry.level === "error"), []); });
