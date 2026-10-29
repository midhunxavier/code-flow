import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-history-counts", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let directory: string, repo: string, other: string, home: string, base: string, server: ChildProcess, browser: Browser, page: Page;
const historyReads: { url: string; status: number; total?: number; nextCursor?: string | null; error?: string }[] = [];
const errors: string[] = [], expected: string[] = []; let output = "", injectingFailure = false, injectingDeleteConflict = false;
const evidence = join(root, "output/playwright/qa-history-paging-counts");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const deadline = Date.now() + 15000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`History fixture timed out: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 50)); } }
async function fresh(hash: string, filter?: unknown) {
  await page?.context().close(); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (new URL(response.url()).pathname !== "/api/runs") return;
    const record = { url: response.url(), status: response.status() }; historyReads.push(record);
    void response.json().then(body => Object.assign(record, { total: body.total, nextCursor: body.nextCursor ?? null, error: body.error })).catch(() => {});
  });
  page.on("response", response => { if (response.status() >= 500) { const url = new URL(response.url()); const fixture = injectingFailure && (url.pathname === "/api/runs" && !!url.searchParams.get("cursor") || url.pathname === "/api/runs/bulk-6/archive"); if (!fixture) errors.push(`Unexpected ${response.status()}: ${url.pathname}${url.search}`); } });
  page.on("console", message => { if (message.type() === "error") { if (injectingFailure && /500 \(Internal Server Error\)/.test(message.text()) || injectingDeleteConflict && /409/.test(message.text())) expected.push(message.text()); else errors.push(message.text()); } });
  await page.addInitScript(({ repo, filter }) => { localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); if (filter) localStorage.setItem("runFilter", JSON.stringify(filter)); }, { repo, filter });
  await page.goto(`${base}/?token=${token}#/${hash}`); await page.getByRole("navigation", { name: "Runs", exact: true }).waitFor();
}
const shot = (name: string) => page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" });
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-history-counts-"))); repo = join(directory, "repo"); other = join(directory, "other"); home = join(directory, "home"); await mkdir(join(home, "runs"), { recursive: true }); await mkdir(evidence, { recursive: true });
  for (const folder of [repo, other]) { await mkdir(folder); git(folder, "init", "-q", "-b", "main"); await writeFile(join(folder, "README.md"), "History QA fixture\n"); git(folder, "add", "."); git(folder, "-c", "user.name=qa", "-c", "user.email=qa@test", "commit", "-qm", "initial"); }
  const now = Date.now() - 60000, head = git(repo, "rev-parse", "HEAD");
  await writeFile(join(home, "projects.json"), JSON.stringify([
    { id: "p-big", name: "Big history", repos: [repo], createdAt: now }, { id: "p-old", name: "Old history", repos: [other], createdAt: now },
    { id: "p-one", name: "One run", repos: [], createdAt: now }, { id: "p-bulk", name: "Bulk history", repos: [], createdAt: now }, { id: "p-empty", name: "Empty history", repos: [], createdAt: now },
  ]));
  let seq = 0;
  const seed = async (id: string, project: string, createdAt: number, archived = false, task = id, pattern = "solo") => {
    const run = { id, project, task, pattern, repo: project === "p-old" ? other : repo, baseRef: head, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(directory, "worktrees", id), roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { check: "", setup: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt, endedAt: createdAt + 1, seen: true, archived, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [] };
    await writeFile(join(home, "runs", `${id}.jsonl`), JSON.stringify({ seq: ++seq, ts: createdAt, runId: id, type: "run", run }) + "\n");
  };
  for (let i = 0; i < 130; i++) await seed(`big-${String(i).padStart(3, "0")}`, "p-big", now + i, i < 6 || i >= 124, i < 6 || i >= 124 ? `Archived needle ${i}` : i === 6 ? "Ancient hidden loop" : `Big history task ${i}`, i === 6 ? "loop" : "solo");
  for (let i = 0; i < 6; i++) await seed(`old-${i}`, "p-old", now - 1000 + i, false, `Old project task ${i}`);
  for (let i = 0; i < 7; i++) await seed(`bulk-${i}`, "p-bulk", now + 1000 + i, false, `Bulk item ${i}`);
  await seed("one", "p-one", now + 1100, false, "Single run"); await seed("orphan", "p-deleted", now - 2000, false, "Unassigned history");
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  server.stdout?.on("data", chunk => { output += chunk; }); server.stderr?.on("data", chunk => { output += chunk; });
  await until(() => fetch(base + "/api/health", { headers }).then(response => response.ok, () => false), Boolean);
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async t => {
  if (!(t as { error?: unknown }).error || !page || page.isClosed()) return;
  await page.screenshot({ path: join(evidence, "failed.png"), fullPage: true });
  await writeFile(join(evidence, "failed-page.txt"), await page.locator("body").innerText());
  await writeFile(join(evidence, "failed-history-reads.json"), JSON.stringify(historyReads, null, 2));
  console.error("History failure responses", JSON.stringify(historyReads.slice(-12)));
});
after(async () => { await browser?.close(); if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); } await writeFile(join(evidence, "server.log"), output); await writeFile(join(evidence, "browser-errors.json"), JSON.stringify({ errors, expected }, null, 2)); await rm(directory, { recursive: true, force: true }); });

test("project picker and editor count unloaded history, and singular delete wording agrees", async () => {
  await fresh("project/p-big"); await page.keyboard.press("p"); const dialog = page.locator("dialog.projects-dialog");
  await dialog.getByText(/118 runs \(\+12 archived\)/).first().waitFor();
  assert.match(await dialog.getByRole("listitem").filter({ hasText: "Old history" }).innerText(), /6 runs/);
  assert.match(await dialog.getByRole("listitem").filter({ hasText: "Without a project" }).innerText(), /1 run/);
  await dialog.getByRole("button", { name: "Edit Big history", exact: true }).click(); await dialog.getByText("130 runs in this project.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Delete project", exact: true }).click(); const confirm = page.getByRole("dialog", { name: "Delete this project?", exact: true });
  assert.match(await confirm.innerText(), /All 130 runs.*will be permanently deleted/); await shot("project-counts"); await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove repo", exact: true }).click(); await dialog.getByText(/Runs already in this project from repo stay in it/).waitFor(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit One run", exact: true }).click(); await dialog.getByRole("button", { name: "Delete project", exact: true }).click(); assert.match(await confirm.innerText(), /Its 1 run.*will be permanently deleted/); await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(errors, []);
});

test("the composer draft row has no history counts or attention badge", async () => {
  await fresh("new"); await page.keyboard.press("p"); const row = page.locator("dialog.projects-dialog").getByRole("listitem").filter({ hasText: "Unassigned draft" }); await row.waitFor();
  assert.equal(await row.locator(".count").count(), 0); assert.doesNotMatch(await row.innerText(), /\d+ runs?/); await shot("unassigned-draft");
});

test("project history uses server archive scope and totals, including archived-only search hints", async () => {
  assert.equal((await fetch(base + "/api/runs?limit=100&archived=invalid", { headers })).status, 400);
  await fresh("project/p-big/runs"); const history = page.getByRole("region", { name: "Project run history", exact: true });
  await until(() => history.locator(".pp-count").innerText(), text => text === "118");
  assert.match(await history.innerText(), /loaded of 118 matching runs/);
  await history.getByLabel("Search this project's runs", { exact: true }).fill("Archived needle");
  await history.getByText("12 archived runs match. Include archived runs to see them.", { exact: true }).waitFor();
  await history.getByLabel("Include archived runs", { exact: true }).check(); await until(() => history.locator(".pp-count").innerText(), text => text === "12"); assert.equal(await history.locator(".pp-row").count(), 12); await shot("archived-search");
});

test("archived totals cover unloaded pages and Retry history repeats its failed cursor", async () => {
  await fresh("project/p-big"); const rail = page.getByRole("navigation", { name: "Runs", exact: true });
  await until(() => rail.getByRole("button", { name: /^Show archived runs(?: \d+)?$/ }).innerText(), text => /12$/.test(text));
  const cursors: string[] = []; let fail = true;
  await page.route("**/api/runs?**", async route => { const cursor = new URL(route.request().url()).searchParams.get("cursor"); if (cursor) { cursors.push(cursor); if (fail) { fail = false; injectingFailure = true; await route.fulfill({ status: 500, json: { error: "Fixture older page failure" } }); return; } } await route.continue(); });
  await rail.getByRole("button", { name: "Load older runs", exact: true }).click(); await rail.getByText("Fixture older page failure", { exact: false }).waitFor();
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" && new URL(response.url()).searchParams.get("cursor") === cursors[0], { timeout: 15000 });
  await rail.getByRole("button", { name: "Retry history", exact: true }).click();
  const response = await retried; assert.equal(response.status(), 200); assert.equal((await response.json()).nextCursor ?? null, null, "the retry reaches the end of this fixture's history");
  await until(async () => rail.getByRole("button", { name: "Load older runs", exact: true }).count(), count => count === 0);
  injectingFailure = false; assert.equal(cursors.length, 2); assert.equal(cursors[0], cursors[1]); await shot("retry-older-page");
});

test("saved repository filters load immediately after hello and do not follow composer changes", async () => {
  await fresh("project/p-big", { thisRepo: true }); const rail = page.getByRole("navigation", { name: "Runs", exact: true });
  await until(() => rail.getByRole("region", { name: "Run history pages", exact: true }).innerText(), text => /matching tasks? loaded/.test(text));
  await rail.getByRole("button", { name: /^Application menu:/ }).click(); await page.getByRole("menuitem", { name: /View and filter runs/ }).click();
  assert.equal(await rail.getByLabel("Repository", { exact: true }).inputValue(), repo);
  await page.evaluate(() => { location.hash = "#/project/p-old"; });
  await page.locator(".project-page").getByRole("button", { name: "New run", exact: true }).click();
  assert.equal(await rail.getByLabel("Repository", { exact: true }).inputValue(), repo);
  await rail.getByLabel("Repository", { exact: true }).selectOption(other); await until(() => rail.getByRole("region", { name: "Run history pages", exact: true }).innerText(), text => /6 matching tasks loaded/.test(text)); await shot("independent-filter");
});

test("old non-solo deep links restore breadcrumbs and side scope, and destination labels match pages", async () => {
  await fresh("run/big-006"); const crumbs = page.getByRole("navigation", { name: "Where you are", exact: true });
  await crumbs.getByText("Big history", { exact: true }).waitFor(); await crumbs.getByText("Ancient hidden loop", { exact: true }).waitFor(); await shot("deep-link-crumbs");
  await page.goto(base + "/#/settings"); await crumbs.getByText("General", { exact: true }).waitFor();
  await page.goto(base + "/#/workspace"); await crumbs.getByText("Repository tools", { exact: true }).waitFor();
});

test("bulk selection discloses hidden rows and clears obsolete action errors", async () => {
  await fresh("project/p-bulk"); const rail = page.getByRole("navigation", { name: "Runs", exact: true }), group = rail.getByRole("group", { name: "Bulk history", exact: true });
  await group.getByRole("button", { name: "Show 2 more", exact: true }).waitFor();
  await rail.getByRole("button", { name: "Select runs", exact: true }).click(); await rail.getByRole("button", { name: "Select loaded", exact: true }).click();
  assert.match(await rail.locator(".rail-selection-head [role=status]").innerText(), /selected · \d+ not shown/); await group.getByRole("button", { name: "Show 2 more (2 selected)", exact: true }).waitFor();
  await rail.getByRole("button", { name: "Clear selection", exact: true }).click(); await group.getByRole("checkbox", { name: "Select Bulk item 6", exact: true }).check();
  injectingFailure = true; await page.route("**/api/runs/bulk-6/archive", route => route.fulfill({ status: 500, json: { error: "Fixture archive failure" } }));
  await rail.getByRole("button", { name: "Archive", exact: true }).click(); await rail.getByRole("alert").filter({ hasText: "Fixture archive failure" }).waitFor();
  await group.getByRole("checkbox", { name: "Select Bulk item 6", exact: true }).uncheck(); assert.equal(await rail.getByRole("alert").filter({ hasText: "Fixture archive failure" }).count(), 0);
  await page.unroute("**/api/runs/bulk-6/archive"); injectingFailure = false; await group.getByRole("checkbox", { name: "Select Bulk item 6", exact: true }).check(); await rail.getByRole("button", { name: "Archive", exact: true }).click();
  await until(() => api("/api/runs/bulk-6"), run => run.archived); assert.equal(await rail.locator(".rail-selection [role=alert]").count(), 0); await shot("bulk-hidden-selection"); assert.deepEqual(errors, []);
});


test("live archive and delete reconcile project rows and totals without discarding loaded pages", async () => {
  await fresh("project/p-big/runs"); const history = page.getByRole("region", { name: "Project run history", exact: true });
  await until(async () => { const more = history.getByRole("button", { name: "Load older runs", exact: true }); if (await more.isVisible() && await more.isEnabled()) await more.click(); return history.locator(".pp-row").count(); }, count => count === 118);
  await api("/api/runs/big-006/archive", { archived: true, cleanup: false });
  await until(() => history.innerText(), text => /117 loaded of 117 matching runs/.test(text));
  assert.equal(await history.getByRole("link", { name: /Ancient hidden loop/ }).count(), 0);
  assert.equal((await fetch(base + "/api/runs/big-006", { method: "DELETE", headers })).status, 200);
  await history.getByLabel("Include archived runs", { exact: true }).check();
  await history.getByRole("button", { name: "Load older runs", exact: true }).click();
  await until(() => history.innerText(), text => /129 loaded of 129 matching runs/.test(text));
  assert.equal(await history.getByRole("link", { name: /Ancient hidden loop/ }).count(), 0);
  await api("/api/runs/big-007/archive", { archived: true, cleanup: false });
  assert.equal((await fetch(base + "/api/runs/big-007", { method: "DELETE", headers })).status, 200);
  await until(() => history.innerText(), text => /128 loaded of 128 matching runs/.test(text));
  assert.equal(await history.getByRole("link", { name: /Big history task 7 ·/ }).count(), 0); await shot("live-history-reconciled"); assert.deepEqual(errors, []);
});

test("project selection chooses its repository, remembers the draft, and shows every sidebar project", async () => {
  await fresh("project/p-big/new");
  await until(() => page.locator(".composer-summary").innerText(), text => text.includes("Big history") && text.includes("Repository repo"));
  const rail = page.getByRole("navigation", { name: "Runs", exact: true });
  await rail.getByRole("button", { name: "Empty history", exact: true }).waitFor();
  const group = rail.getByRole("group", { name: "Big history", exact: true });
  await group.getByRole("button", { name: "Hide the runs in Big history", exact: true }).click();
  await page.reload();
  await group.getByRole("button", { name: "Show the runs in Big history", exact: true }).click();
  await group.getByRole("button", { name: /^Show \d+ more$/ }).click();
  await until(() => group.locator(".run-item").count(), count => count > 5);
  await page.reload();
  await until(() => group.locator(".run-item").count(), count => count > 5);
  await rail.getByRole("button", { name: /^Show archived runs/ }).click();
  await rail.getByRole("region", { name: "Archived runs", exact: true }).waitFor();
  assert.equal(await group.locator(".run-item.archived").count(), 0);
  await page.getByRole("textbox", { name: "Task", exact: true }).fill("Keep my project task");
  await page.reload();
  await until(() => page.getByRole("textbox", { name: "Task", exact: true }).inputValue(), value => value === "Keep my project task");
  assert.doesNotMatch(await page.locator(".composer-summary").innerText(), /Choose project/);
  await page.goto(`${base}/#/projects`);
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.getByRole("navigation", { name: "Runs", exact: true }).getByRole("button", { name: "New run", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Task", exact: true }).inputValue(), "Keep my project task");
});

test("an older deleted project draft is removed on startup, including unreadable stored bytes", async () => {
  await fresh("projects");
  await page.evaluate(() => {
    localStorage.setItem("projectDraftVersion", "1"); localStorage.setItem("composerProject", "p-deleted");
    localStorage.setItem("project-draft-v1:p-deleted", "unreadable old draft"); localStorage.setItem("draftTask", "old deleted text");
  });
  await page.goto(`${base}/#/project/p-deleted/new`); await page.reload();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  assert.equal(await page.getByText(/project is unavailable/).count(), 0);
  await until(() => page.evaluate(() => localStorage.getItem("project-draft-v1:p-deleted")), value => value === null);
});

test("mission repair presents an action and keeps diagnostic paths behind technical details", async () => {
  await fresh("project/p-big");
  await page.route("**/api/project-teams?project=p-big", route => route.fulfill({ json: { enabled: true, revision: 1, autoTeamEnabled: true, source: "saved", teams: [], providers: [], faults: { held: "Repository metadata was replaced" }, faultDetails: { held: { kind: "ownership", name: "Documentation", projectId: "p-big", repo, file: "/saved/missions/held.json" } } } }));
  await page.goto(`${base}/#/project/p-big/automation/missions`);
  const repair = page.locator(".mission-repair");
  await repair.getByText(/needs a repository review/).waitFor();
  const technical = repair.getByText(/Its history is kept in/);
  assert.equal(await technical.isVisible(), false);
  await repair.getByText("Review repair", { exact: true }).click();
  await repair.getByRole("link", { name: "Review repository", exact: true }).waitFor();
  assert.equal(await technical.isVisible(), false);
  await repair.getByText("Technical details", { exact: true }).click();
  assert.match(await technical.innerText(), /\/saved\/missions\/held.json/);
  await shot("mission-repair-disclosure");
});

test("deleting a project removes its history and draft across tabs, but failed deletion retains the draft", async () => {
  await fresh("project/p-big/new");
  await page.getByRole("textbox", { name: "Task", exact: true }).fill("Delete this project draft too");
  await page.locator('input[type="file"]').setInputFiles({ name: "draft-spec.txt", mimeType: "text/plain", buffer: Buffer.from("Delete the draft attachment too") });
  const mirror = await page.context().newPage();
  await mirror.goto(`${base}/#/project/p-big/new`);
  await until(() => mirror.getByRole("textbox", { name: "Task", exact: true }).inputValue(), value => value === "Delete this project draft too");
  const runTab = await page.context().newPage(); await runTab.goto(`${base}/#/run/big-050`);
  await runTab.getByRole("heading", { name: "Big history task 50", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Task", exact: true }).blur();
  await page.keyboard.press("p");
  const editor = page.locator("dialog.projects-dialog");
  await editor.getByRole("button", { name: "Edit Big history", exact: true }).click();
  await editor.getByRole("button", { name: "Delete project", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this project?", exact: true });
  assert.match(await confirm.innerText(), /All 128 runs.*will be permanently deleted/);
  assert.match(await confirm.innerText(), /saved draft and draft attachments will also be deleted/);
  injectingDeleteConflict = true;
  await page.route("**/api/projects/p-big", async route => route.request().method() === "DELETE" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Stop active runs before deleting" }) }) : route.continue());
  await confirm.getByRole("button", { name: "Delete project", exact: true }).click();
  await editor.getByText("Stop active runs before deleting", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Task", exact: true }).inputValue(), "Delete this project draft too");
  assert.equal(await mirror.getByRole("textbox", { name: "Task", exact: true }).inputValue(), "Delete this project draft too");
  await page.unroute("**/api/projects/p-big"); injectingDeleteConflict = false;
  await editor.getByRole("button", { name: "Delete project", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete project", exact: true }).click();
  await until(() => api("/api/projects"), list => !list.some((project: any) => project.id === "p-big"));
  for (const id of ["big-000", "big-129", "big-050"]) assert.equal((await fetch(`${base}/api/runs/${id}`, { headers })).status, 404);
  assert.equal((await api("/api/projects/counts"))["p-big"], undefined);
  assert.equal((await api("/api/runs/one")).id, "one");
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  assert.equal(await editor.count(), 0);
  for (const tab of [page, mirror, runTab]) {
    await tab.getByRole("heading", { name: "Projects", exact: true }).waitFor();
    await tab.goto(`${base}/#/new/unassigned`);
    await until(() => tab.getByRole("textbox", { name: "Task", exact: true }).inputValue(), value => value === "");
    assert.equal(await tab.getByText(/project is unavailable/).count(), 0);
    assert.equal(await tab.getByText("draft-spec.txt", { exact: true }).count(), 0);
    await tab.reload();
    await tab.getByRole("textbox", { name: "Task", exact: true }).waitFor();
    assert.equal(await tab.getByText(/project is unavailable/).count(), 0);
    assert.equal(await tab.getByRole("textbox", { name: "Task", exact: true }).inputValue(), "");
  }
  assert.equal(await page.evaluate(async () => {
    const request = indexedDB.open("codeflow-project-drafts", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise((resolve, reject) => { const read = db.transaction("drafts", "readonly").objectStore("drafts").get("project-draft-v1:p-big"); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); }
    finally { db.close(); }
  }), undefined);
  await mirror.close();
  await runTab.close();
  assert.deepEqual(errors, []);
  await shot("project-deleted-with-history");
});
