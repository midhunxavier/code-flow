import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveQaPorts } from "../qa-port-block.js";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-memory-ml-ui-"))), home = join(dir, "home"), repo = join(dir, "repo"), token = "qa-memory-ml";
const appRoot = join(dir, "app"), qaPorts = await reserveQaPorts(2);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let server: ChildProcess, browser: Browser, page: Page | undefined, base: string, project: string, logs = "";
const errors: string[] = [], responses: string[] = [], consoleErrors: string[] = [];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function api(path: string, body?: unknown, method = "POST"): Promise<any> { const r = await fetch(base + path, { headers, ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) }); assert.ok(r.ok, `${r.status}: ${await r.clone().text()}`); return r.json(); }
async function until<T>(get: () => Promise<T>, good: (x: T) => boolean, ms = 30000): Promise<T> { const end = Date.now() + ms; for (;;) { const value = await get(); if (good(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value).slice(0, 500)); await pause(100); } }
async function open(hash: string) { const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); }); page.on("response", r => { if (r.status() >= 400) responses.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); }); await page.addInitScript(() => localStorage.setItem("sideOpen", "0")); await page.goto(`${base}/?token=${token}${hash}`); await page.locator("#main-content").waitFor(); return page; }
const endpoint = () => `/api/projects/${project}/memory`;
async function memory(p: Page) { await p.getByLabel("Project", { exact: true }).selectOption(project); const panel = p.locator("details.project-memory"); await panel.locator("summary").first().click(); await panel.getByRole("button", { name: "Add project knowledge", exact: true }).waitFor(); return panel; }
async function createMemory(p: Page, title: string, body: string, paths = "") { const panel = p.locator("details.project-memory"); await panel.getByRole("button", { name: "Add project knowledge", exact: true }).click(); await panel.getByLabel("Memory title", { exact: true }).fill(title); await panel.getByLabel("Memory knowledge", { exact: true }).fill(body); if (paths) await panel.getByLabel(/paths/i).fill(paths); await panel.getByRole("button", { name: "Save knowledge", exact: true }).click(); await panel.getByRole("button", { name: "Add project knowledge", exact: true }).waitFor(); await panel.getByText(title, { exact: true }).first().waitFor(); }
before(async () => {
  // A private app copy keeps mutable bundles/assets away from other parallel suites.
  mkdirSync(appRoot);
  for (const folder of ["src", "bin", "ui", "scripts", "docs", "public"]) cpSync(join(root, folder), join(appRoot, folder), { recursive: true });
  cpSync(join(root, "tsconfig.json"), join(appRoot, "tsconfig.json"));
  cpSync(join(root, "package.json"), join(appRoot, "package.json"));
  symlinkSync(join(root, "node_modules"), join(appRoot, "node_modules"), "dir");
  mkdirSync(home, { recursive: true }); mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "Memory ML QA\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", "commit", "-qm", "fixture"], { cwd: repo });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: appRoot });
  const port = qaPorts.port; base = `http://127.0.0.1:${port}`; await qaPorts.release();
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: appRoot, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_SLEEP_MS: "20" }, stdio: "pipe" }); server.stdout?.on("data", d => logs += d); server.stderr?.on("data", d => logs += d); await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean);
  project = (await api("/api/projects", { name: "Memory ML fixture", repos: [repo] })).id; browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async t => { if (page) { if (evidence) { mkdirSync(evidence, { recursive: true }); const name = t.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 100); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); writeFileSync(join(evidence, name + ".txt"), await page.locator("body").innerText()); } await page.context().close(); page = undefined; } });
after(async () => { await qaPorts.release(); await browser?.close(); if (server && server.exitCode === null && server.signalCode === null) { const done = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await done; } if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "server.log"), logs); writeFileSync(join(evidence, "page-errors.json"), JSON.stringify(errors)); writeFileSync(join(evidence, "console-errors.json"), JSON.stringify(consoleErrors)); writeFileSync(join(evidence, "error-responses.json"), JSON.stringify(responses)); } rmSync(dir, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors.filter(e => !e.startsWith("Failed to load resource:")), []); });

test("memory conflict preserves draft without raw ID or duplicate alert and singular count", async () => {
  const p = await open("#/settings/projects"); const panel = await memory(p); await createMemory(p, "Original title", "Original instruction"); await panel.getByText("Project memory · 1 entry", { exact: true }).waitFor();
  const card = panel.locator(".memory-card"); await card.getByRole("button", { name: "Edit", exact: true }).click(); await card.getByLabel("Memory knowledge", { exact: true }).fill("My local draft");
  const entry = (await api(endpoint()))[0]; await api(endpoint() + "/commands", { op: "update", id: entry.id, expectedRevision: entry.revision, body: "Other tab revision" });
  await card.getByRole("button", { name: "Save knowledge", exact: true }).click(); await card.getByLabel("Resolve memory revision conflict", { exact: true }).waitFor(); assert.equal(await card.getByRole("alert").count(), 0); assert.equal(await card.getByLabel("Memory knowledge", { exact: true }).inputValue(), "My local draft"); assert.doesNotMatch(await card.innerText(), /Memory revision conflict: m-/);
});
test("curated onboarding original contradictory policies and duplicate text are excluded before save", async () => {
  const p = await open("#/settings/projects"); const panel = await memory(p);
  for (const [title, body] of [["Guest policy A", "Always permit guest requests"], ["Guest policy B", "Never allow guest requests"], ["Dup one", "Use the broker fixture from conftest for every integration test."], ["Dup two", "Use the broker fixture from conftest for every integration test."]]) await createMemory(p, title!, body!);
  await panel.getByText("Advanced memory tools", { exact: true }).click(); await panel.getByText("Curated project onboarding", { exact: true }).click(); const curated = panel.locator("details").filter({ has: p.locator("summary", { hasText: /^Curated project onboarding$/ }) });
  const markdown = await curated.locator(".md").innerText(); assert.doesNotMatch(markdown, /guest requests/); assert.equal(markdown.match(/Use the broker fixture/g)?.length, 1);
  await curated.getByRole("button", { name: "Save onboarding as project knowledge", exact: true }).click(); await until(() => api(endpoint()), entries => entries.some((e: any) => e.tags.includes("onboarding-summary"))); const saved = (await api(endpoint())).find((e: any) => e.tags.includes("onboarding-summary")); assert.doesNotMatch(saved.body, /guest requests/); assert.equal(saved.body.match(/Use the broker fixture/g)?.length, 1);
});
test("run memory manifest displays one titled entry after planning omission then worker inclusion", { timeout: 60000 }, async () => {
  const entry = await api(endpoint() + "/commands", { op: "create", repo, title: "Readme guidance", body: "Use README for project notes.", paths: ["README.md"] });
  const run = await api("/api/runs", { repo, project, pattern: "auto-team", task: "Add README notes", roles: { coordinator: ["claude"], builder: ["codex"], reviewer: ["claude"] }, loop: { check: "true", maxSteps: 25, maxMinutes: 5 }, trust: "standard" });
  let current = await until(() => api(`/api/runs/${run.id}`), r => r.awaiting?.kind === "plan" || r.status !== "running"); assert.equal(current.awaiting?.kind, "plan", JSON.stringify(current));
  const p = await open(`#/run/${run.id}`); await p.getByRole("button", { name: "✓ Approve", exact: true }).click(); current = await until(() => api(`/api/runs/${run.id}`), r => r.status !== "running", 40000);
  assert.ok(current.memoryManifest.included.some((r: any) => r.id === entry.id)); assert.equal(current.memoryManifest.omitted.some((r: any) => r.id === entry.id), false);
  await p.locator(".team-details > summary").click(); await p.getByText("Why project memory was selected", { exact: true }).click(); const panel = p.locator("details").filter({ has: p.locator("summary", { hasText: /^Why project memory was selected$/ }) }); await panel.getByText(/Readme guidance/).waitFor(); assert.equal(await panel.locator("li").filter({ hasText: "Readme guidance" }).count(), 1); await panel.getByText(/at least one turn/).waitFor();
});
test("workflow advice orders 0 of 4 before 0 of 3 using real fake-provider runs", { timeout: 60000 }, async () => {
  for (const pattern of ["solo", "solo", "solo", "fix-review", "fix-review", "fix-review", "fix-review"]) { const run = await api("/api/runs", { repo, project, pattern, task: "Check the README", roles: { agent: ["claude"], builder: ["codex"], reviewer: ["claude"] }, loop: { maxSteps: 4, maxMinutes: 2 }, trust: "standard" }); await until(() => api(`/api/runs/${run.id}`), r => r.status !== "running"); }
  const p = await open(`#/project/${project}/new`); await p.getByText("Workflow advice from this repository", { exact: true }).click(); const text = await p.locator("details").filter({ has: p.locator("summary", { hasText: /^Workflow advice from this repository$/ }) }).innerText(); assert.ok(text.indexOf("Fix & review") < text.indexOf("Agent"), text);
});
test("policy errors are complete sentences and stale restore describes restore without draft warning", async () => {
  const p = await open("#/settings/projects"); await p.getByLabel("Project", { exact: true }).selectOption(project);
  for (const invalid of ["/etc", "src/*", "../outside"]) { await p.getByLabel("Read deny paths", { exact: true }).fill(invalid); await p.getByRole("button", { name: "Apply policy", exact: true }).click(); await p.getByRole("button", { name: "Apply restriction", exact: true }).click(); await p.getByRole("alert").getByText(/\. Your draft is kept\./).waitFor(); assert.equal(await p.getByLabel("Read deny paths", { exact: true }).inputValue(), invalid); }
  const conventions = p.getByRole("region", { name: "Versioned project conventions" });
  await conventions.getByLabel("Private conventions draft").fill("Revision one"); await conventions.getByRole("button", { name: "Save private revision", exact: true }).click(); await conventions.getByText(/Saved revision 1 ·/).waitFor();
  await conventions.getByLabel("Private conventions draft").fill("Revision two"); await conventions.getByRole("button", { name: "Save private revision", exact: true }).click(); await conventions.getByText(/Saved revision 2 ·/).waitFor();
  await conventions.getByText("Revision history (2)", { exact: true }).click(); await conventions.getByLabel("Saved conventions version", { exact: true }).selectOption("1"); await conventions.getByRole("button", { name: "Preview saved revision", exact: true }).click(); await conventions.getByRole("button", { name: "Restore as new revision", exact: true }).waitFor();
  await api(`/api/projects/${project}/conventions`, { revision: 2, text: "Other tab revision three" }, "PUT"); await conventions.getByRole("button", { name: "Restore as new revision", exact: true }).click(); await conventions.getByRole("alert").getByText(/Nothing was restored; preview the revision again/).waitFor(); assert.doesNotMatch(await conventions.innerText(), /Your draft was not saved|Your draft is preserved/); assert.equal(await conventions.getByRole("button", { name: "Restore as new revision", exact: true }).count(), 0);
});
test("silent failed verification shows one attempt and exports exit evidence without empty fences", async () => {
  const p = await open(`#/project/${project}/repositories`); await p.locator(".project-repository").first().click(); await p.getByRole("button", { name: "Verification", exact: true }).click(); await p.getByRole("button", { name: "Detect checks", exact: true }).click(); await p.getByRole("button", { name: "Add custom gate", exact: true }).click(); await p.getByLabel("Command for custom-1", { exact: true }).fill("test -f NO-SUCH-FILE.md"); await p.getByRole("button", { name: "Run verification", exact: true }).click(); await p.getByText("1 attempt", { exact: true }).waitFor();
  const downloading = p.waitForEvent("download"); await p.getByRole("button", { name: "Export report", exact: true }).click(); const download = await downloading; const file = await download.path(); assert.ok(file); const text = readFileSync(file, "utf8"); assert.match(text, /Exit 1; no output/); assert.doesNotMatch(text, /```\n\n```/); if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "verification.md"), text); }
});
