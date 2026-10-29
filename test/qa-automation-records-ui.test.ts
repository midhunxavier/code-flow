import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, readFile, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("..", import.meta.url)), token = "qa-automation-records", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidence = process.env.QA_ARTIFACT_DIR ?? join(root, "output/playwright/qa-automation-records");
let dir: string, home: string, repo: string, project: string, base: string, port: number, child: ChildProcess, browser: Browser, page: Page, logs = "";
const errors: string[] = [], expected: string[] = [];
const run = () => ({ repo, project, pattern: "solo", task: "Automation records fixture", roles: { agent: ["claude"] }, loop: { check: "true", maxSteps: 4, maxMinutes: 1 } });
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = 30_000) { const end = Date.now() + ms; let value: T; do { value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < end); throw new Error(`${what}: ${JSON.stringify(value!)}`); }
async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") { const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() as any }; }
async function api(path: string, body?: unknown, method?: string) { const result = await request(path, body, method); assert.ok(result.status < 400, JSON.stringify(result)); return result.value; }
const record = async (id: string) => (await api("/api/automations")).find((a: any) => a.id === id);
async function start() {
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, HOME: join(dir, "user"), ZDOTDIR: join(dir, "user"), SHELL: "/bin/sh", CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port === 4355 ? 4357 : port + 1), PATH: `${root}/test/fake-bin:${process.env.PATH}`, FAKE_GH_STATE: join(dir, "gh.json") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", c => logs += c); child.stderr?.on("data", c => logs += c);
  await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean, "server health");
}
async function stop() { if (page && !page.isClosed()) await page.goto("about:blank"); if (child?.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); } }
async function open(hash = "#/automations/repeat") { await page.goto(`${base}/?token=${token}${hash}`); }
async function shot(name: string) { if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" }); }
async function saveDialog(task: string) {
  await open(`#/project/${project}/new`); await page.getByRole("textbox", { name: "Task", exact: true }).fill(task);
  await page.locator("#main-content").getByRole("button", { name: "Run actions", exact: true }).click(); await page.getByRole("menuitem", { name: "Schedule…" }).click();
  await page.getByRole("dialog", { name: "Schedule work" }).getByRole("button", { name: /^Repeat/ }).click();
  const dialog = page.getByRole("dialog", { name: "Save as automation" }); await dialog.getByRole("radio", { name: "Only from a webhook", exact: true }).click(); return dialog;
}
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "qa-automation-records-ui-"))); home = join(dir, "data"); repo = join(dir, "repo"); await mkdir(repo); await mkdir(join(dir, "user"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "Record QA\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "initial"], { cwd: repo });
  await writeFile(join(dir, "gh.json"), JSON.stringify({ issues: [], prs: {} }));
  port = process.env.QA_PORT ? Number(process.env.QA_PORT) : await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); if (!address || typeof address === "string") throw new Error("No address"); probe.close(() => resolve(address.port)); }); });
  assert.ok(![4317, 4318].includes(port)); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start();
  project = (await api("/api/projects", { name: "Records QA", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") { if (/Failed to load resource.*503/.test(message.text())) expected.push(message.text()); else errors.push(message.text()); } });
  page.on("response", r => { if (r.url().includes("/api/") && r.status() >= 500) (r.status() === 503 && r.url().endsWith("/api/automations") ? expected : errors).push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  console.log(JSON.stringify({ dir, base, repo, evidence }));
});
afterEach(async t => { if ((t as { error?: unknown }).error) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, "failed.png"), fullPage: true }); const body = await page.locator("body").innerText(); await writeFile(join(evidence, "failed-page.txt"), body); console.error("Automation failure page", body); } });
after(async () => { await stop(); await browser?.close(); if (evidence) { await writeFile(join(evidence, "server.log"), logs); await writeFile(join(evidence, "browser-errors.json"), JSON.stringify({ errors, expected }, null, 2)); } assert.deepEqual(errors, []); });

test("global automation routes reject bad purposes and extra path segments; valid and legacy routes work", { timeout: 60_000 }, async () => {
  for (const suffix of ["bogus", "Once", "repeat/extra", "repeat/"]) { await open(`#/automations/${suffix}`); await page.getByRole("heading", { name: "This link is invalid" }).waitFor(); }
  await shot("01-invalid-route");
  for (const kind of ["once", "repeat", "backlog", "missions"]) { await open(`#/automations/${kind}`); assert.equal(await page.getByRole("navigation", { name: "Scheduling purpose" }).locator('[aria-current="page"]').getAttribute("href"), `#/automations/${kind}`); }
  await open("#/settings/automations/bogus"); await page.getByRole("heading", { name: "Repeating tasks and webhooks" }).waitFor();
});

test("row editing preserves identity and requires a trigger; concurrent edits keep the draft", { timeout: 60_000 }, async () => {
  const a = await api("/api/automations", { name: "Editable record", run: run(), schedule: { every: 60 }, webhook: false });
  const fired = await api(`/api/automations/${a.id}/run`, {}); await until(() => api(`/api/runs/${fired.id}`), value => value.status !== "running", "original event completes");
  const original = await record(a.id); assert.ok(original.eventHistory.length);
  await open(); const row = page.locator(".auto-row", { hasText: "Editable record" }); await row.getByText("Schedule and next times", { exact: true }).click();
  assert.equal(await row.locator('option[value="off"]').evaluate(option => (option as HTMLOptionElement).disabled), true);
  const before = await record(a.id); const invalid = await request(`/api/automations/${a.id}`, { schedule: null }); assert.equal(invalid.status, 400); assert.deepEqual(await record(a.id), before);
  await row.getByText("Execution and webhook settings", { exact: true }).click(); await row.getByLabel("Enable webhook", { exact: true }).check(); await row.getByLabel("Run checks and setup in a Docker container", { exact: true }).check(); await row.getByLabel("Docker image", { exact: true }).fill("node:22-slim");
  await row.getByRole("button", { name: "Save execution settings" }).click(); await until(() => record(a.id), v => v.isolate && v.webhook, "saved execution settings");
  await page.reload(); await row.getByText("checks in node:22-slim", { exact: false }).waitFor();
  let saved = await record(a.id); for (const key of ["id", "token", "hookPath", "createdAt"]) assert.equal(saved[key], a[key]); assert.deepEqual(saved.eventHistory, original.eventHistory);
  await row.getByText("Schedule and next times", { exact: true }).click(); await row.getByLabel("Schedule for Editable record", { exact: true }).selectOption("off"); await row.getByRole("button", { name: "Save schedule", exact: true }).click(); await until(() => record(a.id), v => !v.schedule, "schedule removed with webhook");
  await row.getByText("Execution and webhook settings", { exact: true }).click(); await row.getByLabel("Enable webhook", { exact: true }).uncheck(); assert.equal(await row.getByRole("button", { name: "Save execution settings" }).isDisabled(), true); await row.getByLabel("Enable webhook", { exact: true }).check();
  await row.getByLabel("Docker image", { exact: true }).fill("node:24"); saved = await record(a.id); await api(`/api/automations/${a.id}`, { name: "Editable record", revision: saved.revision });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await row.getByText(/This automation changed in another window/).waitFor(); assert.equal(await row.getByLabel("Docker image", { exact: true }).inputValue(), "node:24");
  await shot("02-execution-conflict"); await row.getByRole("button", { name: "Use saved settings" }).click(); await row.getByLabel("Run checks and setup in a Docker container", { exact: true }).uncheck(); await row.getByRole("button", { name: "Save execution settings" }).click(); await until(() => record(a.id), v => !v.isolate, "isolation disabled");
});

test("Run now suppresses a same-tick double click while retaining server duplicate protection", { timeout: 60_000 }, async () => {
  const a = await api("/api/automations", { name: "Double click record", run: run(), webhook: true });
  await open(); const row = page.locator(".auto-row", { hasText: a.name }); let count = 0, release!: () => void;
  const held = new Promise<void>(resolve => release = resolve); await page.route(`**/api/automations/${a.id}/run`, async route => { count++; await held; await route.continue(); });
  await row.getByRole("button", { name: "Run now", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await until(async () => count, v => v === 1, "one pending Run now request"); assert.equal(await row.getByRole("button", { name: "Starting…", exact: true }).isDisabled(), true); await shot("03-run-now-pending"); release();
  await until(() => record(a.id), v => !!v.lastRunId, "started run"); await page.unroute(`**/api/automations/${a.id}/run`); assert.equal(count, 1);
  const stored = await record(a.id); await until(() => api(`/api/runs/${stored.lastRunId}`), v => v.status !== "running", "fake run completes");
  const b = await api("/api/automations", { name: "Parallel API record", run: run(), webhook: true }); const simultaneous = await Promise.all([request(`/api/automations/${b.id}/run`, {}), request(`/api/automations/${b.id}/run`, {})]); assert.deepEqual(simultaneous.map(r => r.status).sort(), [201, 409]);
  const latest = await record(b.id); await until(() => api(`/api/runs/${latest.lastRunId}`), v => v.status !== "running", "second fake run completes");
});

test("a no-project automation is discoverable without any orphan runs, and elsewhere copy is truthful", { timeout: 60_000 }, async () => {
  const counts = await api("/api/projects/counts"); assert.equal(counts.none.live + counts.none.archived, 0, "no orphan run unlocks this choice");
  // An ambiguous legacy record has no project even though its repository appears in two projects.
  await api("/api/projects", { name: "Second repo owner", repos: [repo] }); const a = await api("/api/automations", { name: "Ambiguous record", run: { ...run(), project: undefined }, webhook: true });
  let releaseHealth!: () => void;
  const heldHealth = new Promise<void>(resolve => releaseHealth = resolve);
  await page.route("**/api/health", async route => { await heldHealth; await route.continue(); });
  let picker = page.getByRole("dialog", { name: "Projects", exact: true });
  try {
    await open(); await page.getByTitle("Filter projects", { exact: true }).click();
    await picker.getByRole("button", { name: /^Records QA/ }).click();
  } finally { releaseHealth(); await page.unrouteAll({ behavior: "wait" }); }
  await page.getByRole("button", { name: "Show without a project", exact: true }).waitFor(); await shot("05-without-project-hint"); await page.getByTitle("Filter projects", { exact: true }).click(); picker = page.getByRole("dialog", { name: "Projects", exact: true }); await picker.getByRole("button", { name: /^Without a project/ }).click(); await page.locator(".auto-row", { hasText: a.name }).waitFor(); await shot("06-without-project-list");
});

test("composer saved automation survives project deletion and warns about future placement", { timeout: 90_000 }, async () => {
  const originalProject = project; project = (await api("/api/projects", { name: "Delete records QA", repos: [repo] })).id;
  const dialog = await saveDialog("Composer deletion record"); await dialog.getByRole("button", { name: "Save automation", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  const a = (await api("/api/automations")).find((v: any) => v.name === "Composer deletion record"); assert.ok(a); assert.equal(a.run.projectSelection, undefined); assert.equal(a.image, undefined);
  const first = await api(`/api/automations/${a.id}/run`, {}); await until(() => api(`/api/runs/${first.id}`), v => v.status !== "running", "original project run");
  await open(); await page.getByTitle("Filter projects", { exact: true }).click(); const picker = page.getByRole("dialog", { name: "Projects", exact: true }); await picker.getByRole("button", { name: "Edit Delete records QA", exact: true }).click(); await page.locator(".projects-dialog").getByRole("button", { name: "Delete project", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete this project?", exact: true }); await confirmation.getByText(/1 run stays/).waitFor(); await confirmation.getByText(/Future runs fall back to the repository's project/).waitFor(); await shot("04-project-delete-warning"); await confirmation.getByRole("button", { name: "Delete project", exact: true }).click(); await until(() => api("/api/projects"), v => !v.some((p: any) => p.id === project), "project deleted");
  const interactive = await request("/api/runs", { ...run(), projectSelection: "explicit" }); assert.equal(interactive.status, 409);
  const again = await api(`/api/automations/${a.id}/run`, {}); const result = await until(() => api(`/api/runs/${again.id}`), v => v.status !== "running", "fallback manual run"); assert.equal(result.project, originalProject);
  const hook = await fetch(`${base}${a.hookPath}`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: JSON.stringify({ details: "QA event after project deletion" }) }); assert.equal(hook.status, 202);
  await until(() => record(a.id), v => v.lastRunId !== again.id && !v.lastError, "fallback webhook run"); const latest = await record(a.id); const hooked = await until(() => api(`/api/runs/${latest.lastRunId}`), v => v.status !== "running", "webhook completes"); assert.equal(hooked.project, originalProject);
  project = originalProject;
});


test("legacy load warnings clear after schedule repair; mission guards return 409 with no mutation", { timeout: 60_000 }, async () => {
  await stop(); const file = join(home, "triggers.json"), list = JSON.parse(await readFile(file, "utf8"));
  list.push({ id: "t-bad-schedule", name: "Repair schedule record", enabled: true, revision: 1, run: run(), schedule: { every: -1 }, webhook: false, isolate: false, token: "q".repeat(48), createdAt: Date.now() });
  list.push({ id: "t-legacy-explicit", name: "Legacy explicit record", enabled: true, revision: 1, run: { ...run(), project: "p-deleted-fixture", projectSelection: "explicit" }, webhook: true, isolate: false, token: "l".repeat(48), createdAt: Date.now() });
  list.push({ id: "t-managed", target: { kind: "project-team", teamId: "pt-" + "a".repeat(24) }, name: "Managed record", enabled: false, revision: 1, run: run(), schedule: { every: 60 }, webhook: false, isolate: false, token: "m".repeat(48), createdAt: Date.now() });
  await writeFile(file, JSON.stringify(list)); await start(); await open(); await page.getByTitle("Filter projects", { exact: true }).click(); await page.getByRole("dialog", { name: "Projects", exact: true }).getByRole("button", { name: /^All projects/ }).click();
  const row = page.locator(".auto-row", { hasText: "Repair schedule record" }); await row.getByText(/Turned off: its schedule couldn't be read/).waitFor(); assert.doesNotMatch(await row.innerText(), /couldn.t start:.*Turned off/i);
  await row.getByText("Schedule and next times", { exact: true }).click(); await row.getByLabel("Schedule for Repair schedule record", { exact: true }).selectOption("every"); await row.getByLabel("Minutes", { exact: true }).fill("30"); await row.getByRole("button", { name: "Save schedule", exact: true }).click(); await until(() => record("t-bad-schedule"), v => !v.lastError && v.schedule?.every === 30, "schedule repair"); await row.getByRole("switch", { name: "Repair schedule record: on", exact: true }).check(); await until(() => record("t-bad-schedule"), v => v.enabled, "re-enable repaired record"); await page.reload(); await row.getByText(/Next:/).waitFor(); assert.doesNotMatch(await row.innerText(), /Turned off/); await shot("07-repaired-schedule");
  const legacy = await api("/api/automations/t-legacy-explicit/run", {}); const legacyRun = await until(() => api(`/api/runs/${legacy.id}`), v => v.status !== "running", "legacy explicit marker fallback"); assert.equal(legacyRun.project, project);
  const before = await record("t-managed"); for (const [method, body] of [["POST", { name: "Bad edit" }], ["DELETE", undefined]] as const) { const result = await request("/api/automations/t-managed", body, method); assert.equal(result.status, 409); assert.match(result.value.error, /project mission/); } assert.deepEqual(await record("t-managed"), before);
});

test("a mission created in the UI keeps ownership of its projected automation", { timeout: 60_000 }, async () => {
  const settings = await api("/api/project-teams/settings"); await api("/api/project-teams/settings", { enabled: true, revision: settings.revision });
  await open(`#/project/${project}/automation/missions`); await page.getByRole("button", { name: "Create a mission", exact: true }).click(); const form = page.locator("form.pt-form");
  await form.getByRole("button", { name: "Configure manually", exact: true }).click();
  await form.getByLabel("Mission", { exact: true }).fill("Record ownership QA"); await form.getByLabel("Intended users").fill("Developers"); await form.getByLabel("Verification command").fill("true"); await form.getByRole("button", { name: "Save draft mission", exact: true }).click(); await form.waitFor({ state: "detached" });
  const teams = await api(`/api/project-teams?project=${project}`), team = teams.teams.find((t: any) => t.mission.objective === "Record ownership QA" || t.mission.goal === "Record ownership QA") ?? teams.teams.at(-1);
  const a = (await api("/api/automations")).find((a: any) => a.target?.teamId === team.id); assert.ok(a, "mission projection exists");
  for (const [method, body] of [["POST", { enabled: true }], ["DELETE", undefined]] as const) { const result = await request(`/api/automations/${a.id}`, body, method); assert.equal(result.status, 409); assert.match(result.value.error, /project mission/); }
  assert.deepEqual(await record(a.id), a); await shot("11-managed-mission");
});

test("corrupt and unreadable storage show recovery status, retain originals and return an actionable 503", { timeout: 90_000 }, async () => {
  await stop(); const file = join(home, "triggers.json"); const corrupted = '{"token":"fixture-secret-do-not-display",'; await writeFile(file, corrupted); await start(); await open(); await page.getByText(/Automation storage was recovered/).waitFor(); const status = await api("/api/automations/storage"); assert.equal(status.state, "recovered"); assert.equal(await readFile(join(home, status.backup), "utf8"), corrupted); assert.doesNotMatch(await page.locator("body").innerText(), /fixture-secret-do-not-display/); await shot("08-corrupt-recovery");
  const a = await api("/api/automations", { name: "Preserved storage record", run: run(), webhook: true }); await stop(); const original = await readFile(file, "utf8"); await chmod(file, 0); await start(); await open(); await page.getByRole("alert").filter({ hasText: "Automation storage is unavailable" }).waitFor(); assert.equal((await api("/api/automations/storage")).state, "unavailable"); assert.doesNotMatch(await page.locator(".auto-card").innerText(), /None.*yet/); await shot("09-storage-unavailable");
  const dialog = await saveDialog("Cannot overwrite unreadable records"); const response = page.waitForResponse(r => r.url().endsWith("/api/automations") && r.request().method() === "POST"); await dialog.getByRole("button", { name: "Save automation", exact: true }).click(); assert.equal((await response).status(), 503); await dialog.getByText(/storage is unavailable/).waitFor(); await shot("10-storage-save-error");
  await stop(); await chmod(file, 0o600); assert.equal(await readFile(file, "utf8"), original); await start(); assert.equal((await record(a.id)).token, a.token); assert.equal((await api("/api/automations/storage")).state, "ready"); assert.ok((await readdir(home)).includes(status.backup));
});
