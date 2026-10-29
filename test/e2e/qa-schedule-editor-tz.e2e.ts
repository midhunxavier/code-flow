// QA regressions for editing schedules in the browser, on a server in Europe/Stockholm with fake
// agents: a schedule saved without a zone stays in server local time, two windows can't silently
// undo each other, invalid fields say why once and can't be saved, interval fields can be
// cleared, zones show their current names, the mission form saves the schedule it shows, and
// "Next" has a date and zone. Never ports 4317/4318.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-schedule-editor-tz";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
let directory: string, repo: string, base: string, project: string, child: ChildProcess, browser: Browser;
const run = () => ({ repo, project, pattern: "solo", task: "Schedule editor QA task", roles: { agent: ["claude"] }, loop: { check: "true", maxMinutes: 1, maxSteps: 4 } });
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
const automation = async (id: string) => (await api<any[]>("/api/automations")).find((a) => a.id === id);
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
}
/** A signed-in browser in this time zone; its pages record page errors and failed API calls. */
async function browserIn(timezoneId: string) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, timezoneId });
  context.setDefaultTimeout(10_000);
  const signIn = await context.newPage(); await signIn.goto(`${base}/?token=${token}`); await signIn.close();
  return context;
}
async function open(context: BrowserContext, hash: string): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().includes("/api/") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/${hash}`);
  return { page, errors };
}
/** The automation's row with its schedule editor open. */
async function editor(page: Page, name: string) {
  const row = page.locator(".auto-row", { hasText: name });
  await row.getByText("Schedule and next times", { exact: true }).click();
  return row;
}
/** Load what's saved now, as the 15-second poll would. */
const poll = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-schedule-ui-"))); repo = join(directory, "repo"); await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Schedule editor QA fixture\n"); await writeFile(join(repo, "check.mjs"), "process.exit(0);\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const free = () => new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); });
  const port = await free(); base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOW_")));
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, TZ: "Europe/Stockholm", PORT: String(port), CODEFLOW_REMOTE_PORT: String(await free()), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 400; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (child.exitCode !== null || attempt === 399) throw new Error(`Schedule QA server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  project = (await api("/api/projects", { name: "Schedule QA", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } await rm(directory, { recursive: true, force: true }); });

test("a schedule saved without a zone stays in server local time when edited from another zone", { timeout: 60_000 }, async () => {
  const saved = await api("/api/automations", { name: "Server local QA", enabled: true, run: run(), schedule: { at: "08:00" } });
  const context = await browserIn("America/New_York");
  const { page, errors } = await open(context, "#/settings/automations");
  const row = await editor(page, "Server local QA");
  await row.getByText("every day at 08:00 (server local time)").waitFor();
  assert.match(await row.locator(".ar-meta").nth(1).innerText(), /Next: \w{3}, \w{3} \d{1,2}, .*(EST|EDT)/, "Next has a date and names the browser's zone");
  const zone = row.getByLabel("Time zone", { exact: true });
  assert.equal(await zone.inputValue(), "", "not the browser's zone");
  const preview = row.getByLabel("Next scheduled times", { exact: true });
  await preview.getByText("Next runs in server local time (Europe/Stockholm):").waitFor();
  assert.match(await preview.locator("li").first().innerText(), /08:00 AM GMT\+[12]/, "the times it really runs at");
  const save = row.getByRole("button", { name: "Save schedule", exact: true });
  assert.equal(await save.isDisabled(), true, "nothing to save before an edit");
  await row.getByRole("button", { name: "Use my time zone (America/New_York)", exact: true }).click();
  assert.equal(await zone.inputValue(), "America/New_York");
  await preview.getByText("Next runs in America/New_York:").waitFor();
  assert.equal(await save.isEnabled(), true);
  await zone.fill("");
  assert.equal(await save.isDisabled(), true, "back to what's saved");
  await row.getByLabel("Time", { exact: true }).fill("09:00");
  await save.click();
  const changed = await until(() => automation(saved.id), (a) => a.schedule.at === "09:00");
  assert.deepEqual(changed.schedule, { at: "09:00" }, "still server local time"); assert.match(changed.scheduleText, /server local time/);
  assert.equal(changed.nextAt - saved.nextAt, 3_600_000, "an hour later, not the browser's offset");
  assert.deepEqual(errors, []);
  await context.close();
});

test("two windows: an untouched editor follows the saved schedule; a stale edit is refused and kept", { timeout: 90_000 }, async () => {
  const saved = await api("/api/automations", { name: "Two windows QA", enabled: false, run: run(), schedule: { at: "03:00", timezone: "Europe/Stockholm" } });
  const context = await browserIn("Europe/Stockholm");
  const a = await open(context, "#/settings/automations"), b = await open(context, "#/settings/automations");
  const rowA = await editor(a.page, "Two windows QA"), rowB = await editor(b.page, "Two windows QA");
  await rowA.getByLabel("Time", { exact: true }).fill("04:00");
  await rowA.getByRole("button", { name: "Save schedule", exact: true }).click();
  await until(() => automation(saved.id), (t) => t.schedule.at === "04:00");
  // Window B still shows 03:00 and changes only the zone: refused, nothing lost on either side.
  await rowB.getByLabel("Time zone", { exact: true }).fill("UTC");
  await rowB.getByRole("button", { name: "Save schedule", exact: true }).click();
  await rowB.getByRole("alert").filter({ hasText: "changed in another window" }).waitFor();
  assert.deepEqual((await automation(saved.id)).schedule, { at: "04:00", timezone: "Europe/Stockholm" });
  assert.equal(await rowB.getByLabel("Time zone", { exact: true }).inputValue(), "UTC", "the edit is still there");
  await rowB.getByRole("button", { name: "Use saved schedule", exact: true }).click();
  assert.equal(await rowB.getByLabel("Time", { exact: true }).inputValue(), "04:00");
  assert.equal(await rowB.getByLabel("Time zone", { exact: true }).inputValue(), "Europe/Stockholm");
  // A saves again; B, untouched, shows it once it loads what's saved.
  await rowA.getByLabel("Time", { exact: true }).fill("05:00");
  await rowA.getByRole("button", { name: "Save schedule", exact: true }).click();
  await until(() => automation(saved.id), (t) => t.schedule.at === "05:00");
  await poll(b.page);
  await until(() => rowB.getByLabel("Time", { exact: true }).inputValue(), (value) => value === "05:00");
  // An edit in progress isn't replaced by another window's save: B is told, and can keep its own.
  await rowB.getByLabel("Time zone", { exact: true }).fill("UTC");
  await rowA.getByLabel("Time", { exact: true }).fill("06:00");
  await rowA.getByRole("button", { name: "Save schedule", exact: true }).click();
  await until(() => automation(saved.id), (t) => t.schedule.at === "06:00");
  await poll(b.page);
  await rowB.getByRole("alert").filter({ hasText: "changed in another window" }).waitFor();
  assert.equal(await rowB.getByLabel("Time", { exact: true }).inputValue(), "05:00");
  await rowB.getByRole("button", { name: "Save mine over it", exact: true }).click();
  await until(() => automation(saved.id), (t) => t.schedule.at === "05:00" && t.schedule.timezone === "UTC");
  await poll(a.page);
  await until(() => rowA.getByLabel("Time zone", { exact: true }).inputValue(), (value) => value === "UTC");
  assert.equal(await rowB.getByRole("alert").count(), 0);
  // Switched on elsewhere, schedule untouched: B's save isn't a conflict, it's saved on the newer revision.
  await api(`/api/automations/${saved.id}`, { enabled: true });
  await rowB.getByLabel("Time", { exact: true }).fill("07:00");
  await rowB.getByRole("button", { name: "Save schedule", exact: true }).click();
  const retried = await until(() => automation(saved.id), (t) => t.schedule.at === "07:00");
  assert.deepEqual(retried.schedule, { at: "07:00", timezone: "UTC" }); assert.equal(retried.enabled, true, "only the schedule was sent");
  await until(() => rowB.getByRole("alert").count(), (count) => count === 0);
  assert.deepEqual([...a.errors, ...b.errors], []);
  await context.close();
});

test("the row editor refuses fields it can't save with one reason, and shows what was saved", { timeout: 60_000 }, async () => {
  const saved = await api("/api/automations", { name: "Fields QA", enabled: true, run: run(), schedule: { at: "03:00", timezone: "Europe/Stockholm" } });
  const context = await browserIn("Europe/Stockholm");
  const { page, errors } = await open(context, "#/settings/automations");
  const row = await editor(page, "Fields QA");
  const preview = row.getByLabel("Next scheduled times", { exact: true }), save = row.getByRole("button", { name: "Save schedule", exact: true });
  const zone = row.getByLabel("Time zone", { exact: true });
  await zone.fill("Mars/Olympus");
  await preview.getByRole("alert").filter({ hasText: "Choose a valid IANA time zone" }).waitFor();
  assert.equal(await preview.getByText("Calculating…").count(), 0); assert.equal(await save.isDisabled(), true);
  assert.equal(await row.getByRole("alert").count(), 1, "said once");
  // A zone typed in any case, or by an old name, is saved and shown by its current name.
  await zone.fill("asia/kolkata");
  await save.click();
  await until(() => automation(saved.id), (a) => a.schedule.timezone === "Asia/Kolkata");
  await until(() => zone.inputValue(), (value) => value === "Asia/Kolkata");
  await row.getByText("every day at 03:00 (Asia/Kolkata)").waitFor();
  assert.match(await row.locator(".ar-meta").nth(1).innerText(), /Next: \w{3}, \w{3} \d{1,2}, 03:00 AM GMT\+5:30/, "Next reads in the schedule's own zone");
  for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) await row.getByRole("checkbox", { name: day, exact: true }).uncheck();
  await preview.getByRole("alert").filter({ hasText: "Choose at least one valid day of the week" }).waitFor();
  assert.equal(await preview.getByText("Calculating…").count(), 0); assert.equal(await save.isDisabled(), true);
  await row.getByRole("checkbox", { name: "Mon", exact: true }).check();
  // Intervals: past the maximum is refused (not clamped), and the field can be emptied and retyped.
  await row.getByLabel("Schedule for Fields QA", { exact: true }).selectOption("every");
  const minutes = row.getByLabel("Minutes", { exact: true });
  await minutes.fill("20000");
  await preview.getByRole("alert").filter({ hasText: "at most 10080 minutes" }).waitFor();
  assert.equal(await save.isDisabled(), true); assert.equal(await preview.getByText("Calculating…").count(), 0);
  await minutes.fill("3");
  await preview.getByRole("alert").filter({ hasText: "at least 5 minutes apart" }).waitFor();
  await minutes.fill("60"); await minutes.press("End"); await minutes.press("Backspace"); await minutes.press("Backspace");
  assert.equal(await minutes.inputValue(), "", "an emptied field stays empty");
  await preview.getByRole("alert").filter({ hasText: "Enter the minutes between runs" }).waitFor();
  await minutes.pressSequentially("15");
  assert.equal(await minutes.inputValue(), "15");
  await preview.locator("li").first().waitFor();
  await save.click();
  await until(() => automation(saved.id), (a) => "every" in a.schedule && a.schedule.every === 15);
  assert.deepEqual(errors, []);
  await context.close();
});

test("the save-automation dialog keeps an emptied interval empty and blocks what it can't save", { timeout: 60_000 }, async () => {
  const context = await browserIn("Europe/Stockholm");
  const { page, errors } = await open(context, `#/project/${encodeURIComponent(project)}/new`);
  await page.getByRole("textbox", { name: "Task", exact: true }).fill("Repeat dialog QA");
  await page.getByRole("button", { name: "Run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Schedule…" }).click();
  await page.getByRole("dialog", { name: "Schedule work" }).getByRole("button", { name: /^Repeat/ }).click();
  const dialog = page.getByRole("dialog", { name: "Save as automation" });
  const saveButton = dialog.getByRole("button", { name: "Save automation", exact: true });
  await dialog.getByLabel("Automation time zone", { exact: true }).fill("Mars/Olympus");
  await dialog.getByRole("alert").filter({ hasText: "Choose a valid IANA time zone" }).waitFor();
  assert.equal(await dialog.getByText("Calculating…").count(), 0); assert.equal(await saveButton.isDisabled(), true);
  await dialog.getByLabel("Automation time zone", { exact: true }).fill("Europe/Stockholm");
  await dialog.getByRole("radio", { name: "Repeatedly", exact: true }).click();
  const minutes = dialog.getByLabel("Minutes between runs", { exact: true });
  await minutes.press("End"); await minutes.press("Backspace"); await minutes.press("Backspace");
  assert.equal(await minutes.inputValue(), "", "no snapping back to 60");
  await minutes.pressSequentially("15");
  assert.equal(await minutes.inputValue(), "15", "not 6015");
  await minutes.fill("3");
  await dialog.getByRole("alert").filter({ hasText: "at least 5 minutes apart" }).waitFor();
  assert.equal(await saveButton.isDisabled(), true); assert.equal(await dialog.locator(".msg.err").count(), 1, "the reason is said once");
  await minutes.fill("20000");
  await dialog.getByRole("alert").filter({ hasText: "at most 10080 minutes" }).waitFor();
  assert.equal(await saveButton.isDisabled(), true);
  assert.equal(await minutes.evaluate((input) => input.scrollWidth <= input.clientWidth), true, "five digits fit");
  await minutes.fill("15");
  await dialog.getByLabel("Next scheduled times", { exact: true }).locator("li").first().waitFor();
  await saveButton.click();
  await dialog.waitFor({ state: "detached" });
  const created = await until(() => api<any[]>("/api/automations"), (all) => all.some((a) => a.name === "Repeat dialog QA"));
  assert.deepEqual(created.find((a) => a.name === "Repeat dialog QA").schedule, { every: 15 });
  assert.deepEqual(errors, []);
  await context.close();
});

test("the mission form saves the schedule it shows, without a separate schedule save", { timeout: 90_000 }, async () => {
  await api("/api/project-teams/settings", { enabled: true, revision: 0 });
  const context = await browserIn("Europe/Stockholm");
  const { page, errors } = await open(context, `#/project/${encodeURIComponent(project)}/automation/missions`);
  await page.getByRole("button", { name: "Create a mission", exact: true }).click();
  const form = page.locator("form.pt-form");
  await form.getByRole("button", { name: "Configure manually", exact: true }).click();
  await form.getByLabel("Mission", { exact: true }).fill("Keep the schedule editor honest");
  await form.getByLabel("Intended users").fill("Developers");
  await form.getByLabel("Verification command").fill("node check.mjs");
  await form.getByText("Schedule, budget and scope limits", { exact: true }).click();
  await form.getByText("Schedule and next times", { exact: true }).click();
  assert.equal(await form.getByRole("button", { name: "Save schedule", exact: true }).count(), 0, "the form's own Save saves it");
  await form.getByLabel("Time", { exact: true }).fill("14:30");
  await form.getByRole("checkbox", { name: "Wed", exact: true }).check();
  await form.getByRole("button", { name: "Save draft mission", exact: true }).click();
  await form.waitFor({ state: "detached" });
  const [team] = (await api(`/api/project-teams?project=${encodeURIComponent(project)}`)).teams;
  assert.deepEqual(team.mission.schedule, { at: "14:30", days: [1, 3], timezone: "Europe/Stockholm" });
  await page.getByRole("button", { name: "Edit mission", exact: true }).click();
  await form.getByText("Schedule, budget and scope limits", { exact: true }).click();
  await form.getByText("Schedule and next times", { exact: true }).click();
  await form.getByLabel("Time", { exact: true }).fill("17:45");
  await form.getByRole("button", { name: "Save mission", exact: true }).click();
  await form.waitFor({ state: "detached" });
  const edited = (await api(`/api/project-teams/${team.id}`)).team;
  assert.equal((edited.schedule ?? edited.mission.schedule).at, "17:45");
  assert.deepEqual(errors, []);
  await context.close();
});
