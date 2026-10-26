import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const qaPorts = await reserveQaPorts(2, process.env.QA_CHECKS_SCHEDULES_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url));
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "qa-checks-schedules-independent-token";
const home = mkdtempSync(join(tmpdir(), "codeflow-checks-schedules-independent-")), data = join(home, "data");
const evidence = join(root, "output/playwright/qa-checks-schedules-independent");
let server: ChildProcess, browser: Browser, page: Page;
let slow: { id: string; repos: string[] }, normal: { id: string; repos: string[] }, long: { id: string; repos: string[] };
const consoleErrors: string[] = [], pageErrors: string[] = [], serverLog: string[] = [];
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
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, TZ: "America/Los_Angeles", PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, CODEFLOW_SCHEDULER_TICK_MS: "30000", CODEFLOW_MAX_AGENTS: "2.5", CODEFLOW_MAX_CHECKS: "0", FAKE_DOCKER_DOWN: "1", FAKE_GH_STATE: join(home, "gh.json"), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", chunk => serverLog.push(String(chunk))); server.stderr?.on("data", chunk => serverLog.push(String(chunk)));
  for (let i = 0; i < 150; i++) { if (await api("/api/health").then(r => r.status === 200, () => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(serverLog.join(""));
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>(resolve => server.once("exit", () => resolve()));
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM"); await exited; clearTimeout(timer);
}
async function open(hash: string) { await page.goto(`${base}/?token=${token}${hash}`); }
async function settled(id: string) {
  for (let i = 0; i < 300; i++) { const result = (await api(`/api/runs/${id}`)).body; if (result.status !== "running") return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Run did not finish: ${id}`);
}
before(async () => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(home, "gh.json"), JSON.stringify({ issues: [{ number: 41, title: "Improve fixture docs", body: "Document this local fixture", url: "https://github.com/example/fixture/issues/41", labels: [], author: { login: "owner" }, authorAssociation: "OWNER" }], prs: {} }));
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start();
  slow = (await api("/api/projects", { name: "Slow check", repos: [repository("slow", { "package.json": JSON.stringify({ scripts: { test: "sleep 3" } }) })] })).body;
  normal = (await api("/api/projects", { name: "Independent QA", repos: [repository("normal")] })).body;
  const origin = join(home, "origin.git"); execFileSync("git", ["clone", "--bare", "-q", normal.repos[0]!, origin]); execFileSync("git", ["remote", "add", "origin", origin], { cwd: normal.repos[0] });
  long = (await api("/api/projects", { name: "Long readiness", repos: [repository("long", { ".codeflow/config.json": JSON.stringify({ check: "sleep 125; echo readiness-complete", limits: { checkTimeoutMin: 3 }, prove: false }) })] })).body;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: "Europe/Stockholm" });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 500) pageErrors.push(`${response.status()} ${response.url()}`); });
});
after(async () => {
  try { await browser?.close(); } finally { await stop(); writeFileSync(join(evidence, "server.log"), serverLog.join("")); writeFileSync(join(evidence, "browser.json"), JSON.stringify({ pageErrors, consoleErrors }, null, 2)); rmSync(home, { recursive: true, force: true }); }
});

test("the verification timeout field shows the exact fractional limit it will send", async () => {
  await page.addInitScript(({ repo, origin }) => { if (location.origin === origin) localStorage.setItem("repo", repo); }, { repo: slow.repos[0]!, origin: base });
  await open("#/settings/workspace");
  await page.locator("#wb-folder").selectOption(slow.repos[0]!);
  await page.locator(".wb-card label", { hasText: /^Profile/ }).locator("select").selectOption("lightweight");
  await page.getByRole("button", { name: "Detect checks", exact: true }).click();
  const field = page.getByLabel("Timeout for unit in minutes", { exact: true }); await field.fill("0.025"); await field.press("Tab");
  assert.equal(await field.inputValue(), "0.025", "1.5 seconds must not be displayed as zero minutes");
  const request = page.waitForRequest(r => r.url().endsWith("/api/verification") && r.method() === "POST");
  await page.getByRole("button", { name: "Run verification", exact: true }).click();
  assert.equal((await request).postDataJSON().profile.checks[0].timeoutMs, 1500);
  await page.getByRole("heading", { name: "Result: needs-changes", exact: true }).waitFor();
  await page.getByText("Timed out", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "timeout.png"), fullPage: true });
});

test("missing gate runners stay blocked and stopped Docker refuses before creating a run", async () => {
  const input = { repo: normal.repos[0], project: normal.id, pattern: "fix-review", task: "Document fixture behavior", roles: { builder: ["codex"], reviewer: ["claude"] }, loop: { check: "missing-qa-runner", verification: { name: "missing runner", checks: [{ id: "unit", kind: "custom", command: "missing-qa-runner", required: true, timeoutMs: 1500 }] } } };
  const created = await api("/api/runs", input); assert.equal(created.status, 201, JSON.stringify(created));
  const run = await settled(created.body.id); assert.equal(run.status, "done", run.error); assert.match(run.checkCantRun.reason, /not found/);
  assert.equal(run.steps.filter((step: any) => /Fix failing check/.test(step.title)).length, 0);
  await open(`#/run/${run.id}`); await page.getByText("Verification needs attention", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "blocked-gate.png"), fullPage: true });
  const before = (await api("/api/runs")).body.length;
  const refused = await api("/api/runs", { ...input, loop: { check: "true", container: { image: "alpine:3" } } });
  assert.equal(refused.status, 400); assert.match(refused.body.error, /Docker isn't running/); assert.equal((await api("/api/runs")).body.length, before);
  assert.match(serverLog.join(""), /ignoring CODEFLOW_MAX_AGENTS="2.5"/); assert.match(serverLog.join(""), /ignoring CODEFLOW_MAX_CHECKS="0"/);
});

test("daily sweep uses the browser zone while preview and DST keep exact scheduled instants", async () => {
  await open(`#/project/${normal.id}/automation/backlog`); await page.getByRole("button", { name: "Fix open issues", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("checkbox", { name: /Also check every day/ }).check();
  await dialog.getByLabel("Time of day", { exact: true }).fill("09:00");
  assert.match(await dialog.innerText(), /Europe\/Stockholm/);
  await dialog.locator("summary").filter({ hasText: "Configure agents and checks" }).click();
  await dialog.getByRole("textbox", { name: "Done when", exact: true }).fill("true");
  const sent = page.waitForRequest(r => r.url().endsWith("/api/sweeps") && r.method() === "POST");
  await dialog.getByRole("button", { name: "Start 1 run", exact: true }).click();
  assert.deepEqual((await sent).postDataJSON().schedule, { at: "09:00", timezone: "Europe/Stockholm" });
  await dialog.waitFor({ state: "detached" });
  const automation = (await api("/api/automations")).body.find((a: any) => a.sweep && a.run.project === normal.id);
  assert.deepEqual(automation.schedule, { at: "09:00", timezone: "Europe/Stockholm" });
  assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" }).format(automation.nextAt), "09:00");
  const spring = (await api("/api/automations/schedule-preview", { schedule: { at: "02:30", timezone: "Europe/Stockholm" }, after: Date.parse("2026-03-28T23:00:00Z"), count: 2 })).body;
  assert.deepEqual(spring.times.map((t: number) => new Date(t).toISOString()), ["2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]);
  const fall = (await api("/api/automations/schedule-preview", { schedule: { at: "02:30", timezone: "Europe/Stockholm" }, after: Date.parse("2026-10-24T22:00:00Z"), count: 2 })).body;
  assert.deepEqual(fall.times.map((t: number) => new Date(t).toISOString()), ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
});

test("startup catch-up fires the retained occurrence past one hour and skipped runs are visible", { timeout: 60000 }, async () => {
  const run = { repo: normal.repos[0], project: normal.id, pattern: "solo", task: "Document the fixture", roles: { agent: ["claude"] }, loop: { check: "true", maxSteps: 4, maxMinutes: 1 } };
  const edge = (await api("/api/automations", { name: "Grace edge", enabled: true, run, schedule: { every: 1440 } })).body;
  const missed = (await api("/api/automations", { name: "Missed schedule", enabled: true, run, schedule: { every: 1440 } })).body;
  await page.goto("about:blank"); await stop();
  const file = join(data, "triggers.json"), triggers = JSON.parse(readFileSync(file, "utf8")), due = Date.now() - 3590000;
  triggers.find((t: any) => t.id === edge.id).nextAt = due; triggers.find((t: any) => t.id === missed.id).nextAt = Date.now() - 7200000; writeFileSync(file, JSON.stringify(triggers));
  await start(); await open("#/settings/automations");
  const row = page.locator(".auto-row", { hasText: "Missed schedule" }); await row.getByRole("button", { name: "Preview and events", exact: true }).click();
  await row.getByText(/Missed the .*code-flow was closed or the computer asleep/).waitFor();
  for (let i = 0; i < 400; i++) { const events = (await api(`/api/automations/${edge.id}/events`)).body; if (events.some((e: any) => e.state === "started")) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(Date.now() - due > 3600000); const events = (await api(`/api/automations/${edge.id}/events`)).body;
  assert.equal(events.filter((event: any) => event.state === "started").length, 1);
  await page.screenshot({ path: join(evidence, "missed-schedule.png"), fullPage: true });
});

test("readiness validates a real command lasting longer than the old 120-second cap", { timeout: 180000 }, async () => {
  await open(`#/project/${long.id}/new`); await page.locator(".composer-options > summary").click();
  await page.getByText("Repository readiness", { exact: true }).click();
  const response = page.waitForResponse(r => r.url().endsWith("/api/readiness") && r.request().method() === "POST", { timeout: 160000 });
  const started = Date.now(); await page.getByRole("button", { name: "Validate commands", exact: true }).click();
  const result = await response; assert.equal(result.status(), 200); const body = await result.json();
  assert.ok(Date.now() - started >= 125000); assert.equal(body.executed, true); assert.equal(body.checkTimeoutMin, 3);
  assert.equal(body.items.find((item: any) => item.id === "check-run").status, "passed");
  await page.getByText("Commands validated · ready", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "long-readiness.png"), fullPage: true });
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
});
