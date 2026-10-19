import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import axe from "axe-core";

/**
 * The team board in a browser (docs/team-collaboration.md): this computer is its own team server. The owner finds
 * the board under Team, defines a repository key in Settings → Team, creates a task from the board form and works
 * its page (a comment, a decision, blocked and back to planned); a shared contributor signs in on the same server,
 * finds the task under the Team tab and comments, while every execution control stays with the owner's own
 * computer. Then the page's promises under pressure: the rail badge counts the inbox from the first paint and
 * marking items read clears the cards at once; a save that lost to a teammate (409) keeps every draft; an attempt
 * that stopped at its budget stays on the page with its run link and resumes under the same id; shared tabs hold
 * one connection each and ask the server for nothing while idle. axe audits the board, the task page and
 * Settings → Team in light, dark and at phone width.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-team-ui-"))), home = join(fixture, "home"), repo = join(fixture, "repo");
const token = "team-e2e-owner-token", password = "a long local team board password", ownerHeaders = { authorization: `Bearer ${token}` }, jsonHeaders = { ...ownerHeaders, "content-type": "application/json" };
const TITLE = "Rename the greeting", OWNER_COMMENT = "Started reading the README; the greeting is its first line.", CONTRIBUTOR_COMMENT = "@owner I can take the wording once the design review lands.";
/** An OS-assigned loopback port; the user's own server lives on 4317/4318, so those are never used even if the OS hands them out. */
async function freePort(): Promise<number> { for (;;) { const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); }); if (port !== 4317 && port !== 4318) return port; } }
const port = await freePort(), remotePort = await freePort(), base = `http://localhost:${port}`;
let server: ChildProcess, browser: Browser, page: Page, shared: Page, sharedContext: BrowserContext, projectId: string, taskId: string, log = "";
const contexts: BrowserContext[] = [], errors: string[] = [], violations: string[] = [];
const api = async <T = any>(path: string, init: RequestInit = {}): Promise<T> => { const response = await fetch(base + path, { ...init, headers: { ...jsonHeaders, ...init.headers } }), text = await response.text(); assert.ok(response.ok, `${init.method ?? "GET"} ${path} answered ${response.status}: ${text}`); return JSON.parse(text) as T; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
interface AttemptView { id: string; state: string; runId?: string; lastSeq: number; endedAt?: number }
interface TaskView { id: string; title: string; goal: string; status: string; blocker?: string; owner?: { userId: string }; dependsOn: string[]; labels: string[]; revision: number; discussion: { text: string; by: { userId: string; displayName: string } }[]; decisions: { text: string }[]; audit: { action: string }[]; attempts: AttemptView[] }
const task = () => api<TaskView>(`/api/team/tasks/${taskId}`);
/** What a teammate's save does to the page: a newer revision on the server, which the page's next save loses with a 409. */
const teammateSaves = async (patch: Record<string, unknown>) => { const current = await task(); await api(`/api/team/tasks/${taskId}`, { method: "PUT", body: JSON.stringify({ revision: current.revision, ...patch }) }); };

before(async () => {
  mkdirSync(home, { recursive: true }); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "# Fixture app\n\nHello, team.\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo }); git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "base");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  // The fake agents first on PATH and every CODEFLOW_/FAKE_ variable of the parent shell dropped, so a developer's environment cannot change what the server does.
  const env: NodeJS.ProcessEnv = {}; for (const [key, value] of Object.entries(process.env)) if (!/^(?:CODEFLOW_|FAKE_)/.test(key)) env[key] = value;
  Object.assign(env, { PATH: `${join(root, "test/fake-bin")}:${process.env.PATH ?? ""}`, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remotePort), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk) => { log = (log + chunk.toString()).slice(-16000); });
  let healthy = false; for (let n = 0; n < 300 && server.exitCode === null; n++) { healthy = await fetch(`${base}/api/health`, { headers: ownerHeaders }).then((response) => response.ok, () => false); if (healthy) break; await sleep(100); } assert.ok(healthy, `the server did not answer /api/health:\n${log}`);
  projectId = (await api<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Fixture app", repos: [repo] }) })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context); page = await context.newPage(); page.on("pageerror", (error) => errors.push(`owner: ${error.message}`));
  await page.addInitScript((path) => localStorage.setItem("repo", path), repo); // the composer's repository, which "Use current repository" fills in
  await page.goto(`${base}/?token=${token}`); await page.getByRole("button", { name: "New run", exact: true }).waitFor();
});
after(async () => { for (const context of contexts) await context.close().catch(() => undefined); await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); rmSync(fixture, { recursive: true, force: true }); });

/** One axe pass over the whole document; violations accumulate so a failing test lists every screen at once. */
async function audit(target: Page, screen: string) {
  // The reduced-motion rule gives every element an `all .01ms` transition, so a theme or viewport change settles only on the next frame; axe caches styles per node and would mix old and new colors.
  await target.evaluate(async () => { for (;;) { document.documentElement.getBoundingClientRect(); const running = document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().endTime !== Infinity); if (!running.length) break; await Promise.all(running.map((animation) => animation.finished.catch(() => undefined))); } });
  await target.addScriptTag({ content: axe.source });
  const result = await target.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
  for (const violation of result.violations) violations.push(`${screen}: ${violation.id} (${violation.impact}) ${violation.nodes.map((node) => `${node.target.join(" ")} — ${(node.failureSummary ?? "").replace(/\s+/g, " ")}`).join("; ")}`);
}
const fits = (target: Page) => target.evaluate(() => { const main = document.getElementById("main-content") ?? document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!main || main.scrollWidth <= main.clientWidth + 1); });

test("the Team entry opens a board with five columns and the not-connected callout", async () => {
  await page.getByRole("button", { name: "Application menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Team", exact: true }).click();
  await page.waitForURL(/#\/team$/);
  await page.getByRole("heading", { level: 1, name: "Team", exact: true }).waitFor();
  const columns = page.locator("section.team-column"); await columns.first().waitFor();
  assert.deepEqual(await columns.evaluateAll((sections) => sections.map((section) => section.querySelector("h2")?.firstChild?.textContent)), ["Planned", "Working", "Blocked", "In review", "Done"]);
  assert.equal(await page.locator("section.team-column .team-column-empty").count(), 5, "an empty board says so in every column");
  await page.getByText("Not connected to a team server", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: /Open Settings → Team/ }).getAttribute("href"), "#/settings/team");
  await page.getByRole("heading", { name: /^Inbox/ }).waitFor(); await page.getByText("Nothing yet.", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
});

test("Settings → Team defines a repository key and maps it; the board form creates a task that lands in Planned", async () => {
  await page.goto(`${base}/#/settings/team`);
  await page.getByRole("heading", { level: 2, name: "Team", exact: true }).waitFor();
  await page.getByRole("button", { name: "Connect this computer", exact: true }).waitFor(); // not linked: the connect form, named as the docs and the server's hints name it, with this computer's name prefilled
  const machine = page.getByLabel("Machine name"); await page.waitForFunction((input) => (input as HTMLInputElement).value !== "", await machine.elementHandle()); assert.notEqual(await machine.inputValue(), "");
  await page.getByText("No repository keys yet.", { exact: false }).waitFor();
  await page.getByRole("link", { name: /Turn on remote access over Tailscale/ }).waitFor(); // no remote access: no address to hand out (and never the phone link's secret path)
  const keys = page.getByRole("group", { name: /^Repository keys · Fixture app/ }); await keys.waitFor();
  await keys.getByRole("button", { name: "Add repository", exact: true }).click();
  await keys.getByLabel("Key", { exact: true }).fill("app"); await keys.getByLabel("Label", { exact: true }).fill("Fixture app"); await keys.getByLabel("Default branch", { exact: true }).fill("main");
  await keys.getByRole("button", { name: "Save repository keys", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Repository keys saved" }).waitFor();
  const mapping = page.locator(".team-mapping").filter({ hasText: "Fixture app" }); await mapping.getByText("Not mapped on this computer.", { exact: true }).waitFor();
  await mapping.getByRole("button", { name: "Use current repository", exact: true }).click(); await mapping.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Repository mapped" }).waitFor();
  const link = await api<{ linked: boolean; mappings: Record<string, Record<string, string>> }>("/api/team-link"); assert.equal(link.linked, false); assert.deepEqual(link.mappings, { [projectId]: { app: repo } });
  const board = await api<{ projects: { id: string; repositories: unknown[] }[] }>("/api/team/board"); assert.deepEqual(board.projects.find((project) => project.id === projectId)?.repositories, [{ key: "app", label: "Fixture app", defaultBranch: "main" }]);

  await page.goto(`${base}/#/team`);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const form = page.getByRole("form", { name: "New task", exact: true }); await form.waitFor();
  await form.getByLabel("Title").fill(TITLE);
  assert.equal(await form.getByLabel("Repository").inputValue(), "app", "the project's only repository key is preselected");
  await form.getByLabel("Owner").selectOption("owner");
  await form.getByLabel("Goal").fill("README.md greets the team by name instead of saying hello.");
  await form.getByLabel("Acceptance criteria").fill("The first line of README.md names the team; nothing else changes.");
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Task created" }).waitFor();
  const planned = page.getByRole("region", { name: /^Planned/ }); const card = planned.getByRole("button", { name: new RegExp(TITLE) }); await card.waitFor();
  await planned.getByRole("button", { name: /\(you\)/ }).waitFor(); // the owner, shown as "<name> (you)"
  assert.equal(await card.locator("code").textContent(), "app");
  await page.getByText("Not connected to a team server").waitFor({ state: "hidden" }); // the callout stops once the board holds a task
  assert.equal(await page.getByRole("status").filter({ hasText: /^1 of 1 tasks/ }).count(), 1);
  await card.click();
  await page.waitForURL(/#\/team\/task\/(t-[a-f0-9]{16})$/); taskId = /#\/team\/task\/(t-[a-f0-9]{16})$/.exec(page.url())![1]!;
  assert.deepEqual(errors, []);
});

test("the task page takes a comment, a decision and a blocker, and comes back to Planned", async () => {
  await page.getByRole("heading", { level: 1, name: new RegExp(`^${TITLE}`) }).waitFor();
  await page.getByText("No attempt yet.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Build with agents", exact: true }).waitFor(); // the owner owns the task and this computer can run it
  await page.getByLabel("Comment", { exact: true }).fill(OWNER_COMMENT);
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await page.locator(".team-comment-text").filter({ hasText: OWNER_COMMENT }).waitFor();
  assert.equal(await page.getByLabel("Comment", { exact: true }).inputValue(), "", "a posted comment clears the composer");
  await page.getByLabel("Add a decision").fill("Keep the greeting in English only.");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".team-list.decisions li").filter({ hasText: "Keep the greeting in English only." }).waitFor();
  const status = page.getByRole("combobox", { name: /^Status\b/ }), pill = page.locator(".team-task-head .status-pill");
  assert.equal(await pill.textContent(), "Planned");
  await status.selectOption("blocked");
  assert.equal(await status.inputValue(), "planned", "choosing Blocked asks for the blocker before anything is saved");
  await page.getByLabel("What blocks the task?").fill("Waiting for the design review of the new wording.");
  await page.getByRole("button", { name: "Mark blocked", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Waiting for the design review of the new wording." }).waitFor();
  assert.equal(await pill.textContent(), "Blocked");
  await status.selectOption("planned");
  await page.getByRole("status").filter({ hasText: "Waiting for the design review" }).waitFor({ state: "hidden" });
  assert.equal(await pill.textContent(), "Planned");
  const current = await task();
  assert.equal(current.status, "planned"); assert.equal(current.blocker, undefined); assert.equal(current.owner?.userId, "owner");
  assert.deepEqual(current.discussion.map((comment) => [comment.by.userId, comment.text]), [["owner", OWNER_COMMENT]]); assert.deepEqual(current.decisions.map((decision) => decision.text), ["Keep the greeting in English only."]);
  assert.ok(current.audit.length >= 4, `every change is in the history: ${current.audit.map((entry) => entry.action).join(", ")}`);
  await page.locator("details.team-history > summary").click(); assert.ok((await page.locator("details.team-history li").count()) >= 4);
  assert.deepEqual(errors, []);
});

test("the board, the task page and Settings → Team pass axe in light, dark and phone layouts", async () => {
  const screens: [string, string, () => Promise<void>][] = [
    ["/team", "board", () => page.getByRole("region", { name: /^Planned/ }).getByRole("button", { name: new RegExp(TITLE) }).waitFor()],
    [`/team/task/${taskId}`, "task", () => page.locator(".team-comment-text").filter({ hasText: OWNER_COMMENT }).waitFor()],
    ["/settings/team", "settings team", () => page.getByRole("button", { name: "Save repository keys", exact: true }).waitFor()],
  ];
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const [route, name, ready] of screens) {
      await page.goto(`${base}/#${route}`); await ready();
      for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await audit(page, `${colorScheme} ${name} ${width}`); if (width === 390) assert.equal(await fits(page), true, `${colorScheme} ${name} overflows at 390 px`); }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  assert.deepEqual(violations, []);
  assert.deepEqual(errors, []);
});

test("a shared contributor signs in, finds the task under Team and comments, with no execution controls", async () => {
  const accounts = await api<{ revision: number }>("/api/accounts");
  await api("/api/accounts", { method: "POST", body: JSON.stringify({ revision: accounts.revision, username: "casey", displayName: "Casey Contributor", password, roles: { [projectId]: "contributor" } }) });
  sharedContext = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(sharedContext); shared = await sharedContext.newPage(); shared.on("pageerror", (error) => errors.push(`shared: ${error.message}`));
  await shared.goto(base);
  await shared.getByRole("heading", { name: "Sign in to shared projects", exact: true }).waitFor();
  await shared.getByLabel("Username", { exact: true }).fill("casey"); await shared.getByLabel("Password", { exact: true }).fill(password); await shared.getByRole("button", { name: "Sign in", exact: true }).click();
  await shared.getByRole("heading", { name: "Shared project review", exact: true }).waitFor();
  await shared.getByRole("tab", { name: "Team", exact: true }).click();
  await shared.waitForURL(/#\/team$/); await shared.getByRole("tab", { name: "Team", exact: true, selected: true }).waitFor();
  const card = shared.getByRole("region", { name: /^Planned/ }).getByRole("button", { name: new RegExp(TITLE) }); await card.waitFor();
  assert.equal(await shared.getByText("Not connected to a team server").count(), 0, "the shared dashboard never talks about this computer's link");
  await card.click();
  await shared.waitForURL(new RegExp(`#/team/task/${taskId}$`));
  await shared.locator(".team-comment-text").filter({ hasText: OWNER_COMMENT }).waitFor();
  for (const name of ["Build with agents", "Stop", "Hand over…", "Accept and download", "Resume", "Take this task", "Delete task"]) assert.equal(await shared.getByRole("button", { name, exact: true }).count(), 0, `a shared contributor sees no "${name}" control`);
  assert.equal(await shared.getByRole("link", { name: "Open run", exact: true }).count(), 0);
  assert.equal(await shared.getByText("Run this task from your own code-flow", { exact: false }).count(), 0, "the hint to run it yourself is for the task's owner");
  await shared.getByLabel("Comment", { exact: true }).fill(CONTRIBUTOR_COMMENT);
  await shared.getByRole("button", { name: "Post comment", exact: true }).click();
  await shared.locator(".team-comment-text").filter({ hasText: CONTRIBUTOR_COMMENT }).waitFor();
  await shared.locator(".team-comment").filter({ hasText: CONTRIBUTOR_COMMENT }).getByText("Casey Contributor (you)", { exact: true }).waitFor();
  assert.equal(await shared.locator(".team-comment").filter({ hasText: CONTRIBUTOR_COMMENT }).locator("strong.team-mention").textContent(), "@owner", "the mention of the owner is rendered as one");
  const current = await task();
  assert.deepEqual(current.discussion.map((comment) => comment.text), [OWNER_COMMENT, CONTRIBUTOR_COMMENT]); assert.equal(current.discussion[1]!.by.displayName, "Casey Contributor");
  // The mention lands in the owner's inbox; the owner window learns it over the team stream (or its 15 s poll).
  await page.locator(".rail-menu-count", { hasText: "1" }).waitFor({ timeout: 20_000 });
  await shared.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" }); await audit(shared, "shared task light 1280");
  await shared.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" }); await shared.setViewportSize({ width: 390, height: 844 }); await audit(shared, "shared task dark 390"); assert.equal(await fits(shared), true, "the shared task page fits a phone");
  await shared.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" }); await shared.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(violations, []);
  if (process.env.CODEFLOW_UI_SCREENSHOTS) { mkdirSync(join(root, "output/playwright"), { recursive: true }); await shared.screenshot({ path: join(root, "output/playwright/team-task-shared-mobile.png"), fullPage: true }); }
  assert.deepEqual(errors, []);
});

test("the rail's Team badge counts the inbox from the first paint, and marking items read clears the cards' Needs-you badges at once", async () => {
  // A fresh load lands on the composer: the badge must not wait for a Team page to load the board.
  await page.goto(`${base}/#/`); await page.reload(); await page.getByRole("button", { name: "New run", exact: true }).waitFor();
  await page.locator(".rail-menu-count", { hasText: "1" }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Application menu", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Team 1 unread$/ }).click(); await page.waitForURL(/#\/team$/);
  const card = page.getByRole("region", { name: /^Planned/ }).getByRole("button", { name: new RegExp(TITLE) }); await card.waitFor();
  await page.locator(".team-card.needs-you").filter({ hasText: TITLE }).waitFor(); await card.getByText("Needs you", { exact: true }).waitFor();
  await page.getByRole("heading", { name: /^Inbox/ }).getByText("1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Mark all read", exact: true }).click();
  await page.locator(".team-card.needs-you").waitFor({ state: "hidden", timeout: 3_000 }); // the board reloads with the inbox, not on the next 15 s poll
  assert.equal(await card.getByText("Needs you", { exact: true }).count(), 0);
  await page.locator(".rail-menu-count").waitFor({ state: "hidden" }); // the badge is gone from the rail
  assert.equal((await api<{ unread: number }>("/api/team/inbox")).unread, 0);
  assert.deepEqual(errors, []);
});

test("a save that lost to a teammate keeps every draft: the title and blocker editors stay open, goal text stays marked unsaved, and a refused dependency snaps back", async () => {
  const second = await api<{ id: string }>("/api/team/tasks", { method: "POST", body: JSON.stringify({ projectId, repository: "app", title: "Translate the greeting", goal: "A second task, for the dependency list.", acceptance: "" }) });
  await page.goto(`${base}/#/team/task/${taskId}`); await page.getByRole("heading", { level: 1, name: new RegExp(`^${TITLE}`) }).waitFor();
  // While `holding`, the page cannot reload the task (the stream tells it about the teammate's save within a second), so its save is stale for sure; the held reloads go through afterwards and the drafts must survive them.
  const held: Route[] = []; let holding = false;
  const isTask = (url: string, method: string, request: { url(): string; method(): string }) => new URL(request.url()).pathname === url && request.method() === method;
  await page.route(`**/api/team/tasks/${taskId}`, (route) => { if (holding && route.request().method() === "GET") held.push(route); else void route.continue(); });
  /** Submits through `submit` and waits for the server's 409 to reach the page. */
  const refused = async (submit: () => Promise<unknown>) => { const response = page.waitForResponse((response) => isTask(`/api/team/tasks/${taskId}`, "PUT", response.request()) && response.status() === 409); await submit(); await response; await page.getByRole("status").filter({ hasText: "Task changed; reloading" }).waitFor(); await sleep(200); };
  /** Lets the held reloads through and waits until the page has the task they carry. */
  const release = async () => { assert.ok(held.length, "the teammate's save made the page ask for the task"); const reloaded = page.waitForResponse((response) => isTask(`/api/team/tasks/${taskId}`, "GET", response.request())); holding = false; for (const route of held.splice(0)) await route.continue(); await reloaded; await sleep(300); };
  try {
    // The title.
    await page.getByRole("button", { name: "Edit the title", exact: true }).click(); const title = page.locator("#tt-title"); await title.fill("My draft title");
    holding = true; await teammateSaves({ labels: ["wording"] });
    await refused(() => page.getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(await title.inputValue(), "My draft title", "the title editor stays open with the draft after the 409");
    await release(); await page.locator(".team-task-meta .badge").filter({ hasText: "wording" }).waitFor();
    assert.equal(await title.inputValue(), "My draft title", "the reload keeps the draft"); assert.equal((await task()).title, TITLE);
    await page.getByRole("button", { name: "Save", exact: true }).click(); await page.getByRole("heading", { level: 1, name: /^My draft title/ }).waitFor(); assert.equal((await task()).title, "My draft title", "the next save, on the current revision, goes through");
    await teammateSaves({ title: TITLE }); await page.getByRole("heading", { level: 1, name: new RegExp(`^${TITLE}`) }).waitFor();
    // The goal: the teammate changed the very field, so the page shows the draft against their text until the owner saves or discards.
    const goal = page.locator("#tt-goal"), saveGoal = page.getByRole("button", { name: "Save goal", exact: true }), unsaved = page.getByText("Unsaved changes", { exact: true });
    await goal.fill("My draft goal that I typed for a while"); await saveGoal.waitFor(); await unsaved.waitFor();
    holding = true; await teammateSaves({ goal: "Goal changed by a teammate" });
    await refused(() => saveGoal.click());
    assert.equal(await goal.inputValue(), "My draft goal that I typed for a while"); assert.equal(await saveGoal.count(), 1, "Save goal stays after the 409"); assert.equal(await unsaved.count(), 1);
    await release();
    assert.equal(await goal.inputValue(), "My draft goal that I typed for a while", "the reload keeps the draft"); assert.equal(await saveGoal.count(), 1, "unsaved text never looks saved"); assert.equal(await unsaved.count(), 1);
    assert.equal((await task()).goal, "Goal changed by a teammate", "nothing was saved over the teammate's text");
    await page.getByRole("button", { name: "Discard", exact: true }).click(); assert.equal(await goal.inputValue(), "Goal changed by a teammate"); await saveGoal.waitFor({ state: "hidden" });
    // The blocker.
    const status = page.getByRole("combobox", { name: /^Status\b/ }), pill = page.locator(".team-task-head .status-pill"), blocker = page.getByLabel("What blocks the task?");
    await status.selectOption("blocked"); await blocker.fill("Waiting for the translated wording.");
    holding = true; await teammateSaves({ labels: ["wording", "i18n"] });
    await refused(() => page.getByRole("button", { name: "Mark blocked", exact: true }).click());
    assert.equal(await blocker.inputValue(), "Waiting for the translated wording.", "the blocker form stays open with the draft after the 409"); assert.equal(await pill.textContent(), "Planned");
    await release(); await page.locator(".team-task-meta .badge").filter({ hasText: "i18n" }).waitFor();
    assert.equal(await blocker.inputValue(), "Waiting for the translated wording.");
    await page.getByRole("button", { name: "Mark blocked", exact: true }).click(); await page.getByRole("status").filter({ hasText: "Waiting for the translated wording." }).waitFor(); assert.equal(await pill.textContent(), "Blocked");
    await status.selectOption("planned"); await page.getByRole("status").filter({ hasText: "Waiting for the translated wording." }).waitFor({ state: "hidden" });
    // The dependencies: a refused save leaves nothing selected that the task does not have (the page reloads the task first, then snaps the select back to it).
    const depends = page.getByLabel("Depends on"); await depends.waitFor();
    holding = true; await teammateSaves({ labels: ["wording"] });
    await refused(() => depends.selectOption(second.id));
    await release(); assert.deepEqual((await task()).dependsOn, []);
    assert.deepEqual(await depends.evaluate((select: HTMLSelectElement) => [...select.selectedOptions].map((option) => option.value)), [], "the clicked option snaps back after the 409");
    await depends.selectOption(second.id); await page.locator(".team-kv").filter({ hasText: "Depends on" }).getByText("Translate the greeting").waitFor(); assert.deepEqual((await task()).dependsOn, [second.id]);
  } finally { holding = false; for (const route of held.splice(0)) await route.continue().catch(() => undefined); await page.unroute(`**/api/team/tasks/${taskId}`); }
  assert.deepEqual(errors, []);
});

test("an attempt that stopped at its budget stays on the page with its run link and a Resume that continues the same attempt", async () => {
  // The loop pattern asks the agent again after a failing check, so a step budget of one ends the run at the limit: attempt state "stopped".
  const started = await api<{ attemptId: string; runId: string }>(`/api/team-link/tasks/${taskId}/start`, { method: "POST", body: JSON.stringify({ pattern: "loop", roles: { workers: ["claude"] }, trust: "safe", loop: { check: "false", maxSteps: 1, maxMinutes: 2 } }) });
  const ended = ["paused", "finished", "failed", "stopped", "unknown", "superseded"];
  const attemptWhen = async (until: (attempt: AttemptView) => boolean, what: string): Promise<AttemptView> => { const deadline = Date.now() + 90_000; for (;;) { const current = await task(), attempt = current.attempts.find((entry) => entry.id === started.attemptId); if (attempt && until(attempt)) return attempt; assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(current.attempts)}\n${log.slice(-3000)}`); await sleep(300); } };
  const stopped = await attemptWhen((attempt) => ended.includes(attempt.state), "the attempt did not end in time"); assert.equal(stopped.state, "stopped");
  await page.goto(`${base}/#/team/task/${taskId}`); await page.getByRole("heading", { level: 1, name: new RegExp(`^${TITLE}`) }).waitFor();
  const execution = page.locator("section.team-section", { has: page.locator("#tt-exec") });
  await execution.locator(".status-pill").filter({ hasText: "Stopped at a limit" }).waitFor();
  assert.equal(await execution.getByText("No attempt yet.", { exact: false }).count(), 0, "an ended attempt is still an attempt");
  const openRun = page.getByRole("link", { name: "Open run", exact: true }); await openRun.waitFor(); assert.equal(await openRun.getAttribute("href"), `#/run/${started.runId}`);
  const resume = page.getByRole("button", { name: "Resume", exact: true }); await resume.waitFor();
  await page.getByRole("button", { name: "Build with agents", exact: true }).waitFor(); // a new attempt stays an explicit choice
  // The run page knows its task.
  await openRun.click(); await page.waitForURL(new RegExp(`#/run/${started.runId}$`)); const back = page.getByRole("link", { name: "Team task", exact: true }); await back.waitFor(); assert.equal(await back.getAttribute("href"), `#/team/task/${taskId}`);
  await back.click(); await page.waitForURL(new RegExp(`#/team/task/${taskId}$`)); await resume.waitFor();
  await resume.click(); await page.getByRole("status").filter({ hasText: "Attempt resumed" }).waitFor();
  // The resumed run reports under the same attempt: its sequence moves on, and it ends again at the same budget.
  const again = await attemptWhen((attempt) => (attempt.lastSeq > stopped.lastSeq || (attempt.endedAt ?? 0) > (stopped.endedAt ?? 0)) && ended.includes(attempt.state), "the resumed attempt did not report and end again");
  assert.ok((again.endedAt ?? 0) > (stopped.endedAt ?? 0), `the attempt ended a second time: ${JSON.stringify([stopped, again])}`);
  const current = await task(); assert.equal(current.attempts.length, 1, "Resume continued the attempt instead of claiming another"); assert.equal(current.attempts[0]!.id, started.attemptId);
  await execution.locator(".status-pill").filter({ hasText: /Stopped at a limit|Finished|Failed|Paused/ }).waitFor();
  assert.deepEqual(errors, []);
});

test("an unknown execution blocks Start until the owner confirms it stopped and records a recovery reason", async () => {
  const recoveryTask = await api<TaskView>("/api/team/tasks", { method: "POST", body: JSON.stringify({ projectId, repository: "app", title: "Recover disconnected execution", owner: "owner" }) });
  const id = "9".repeat(32), head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await api(`/api/team/tasks/${recoveryTask.id}/attempts`, { method: "POST", body: JSON.stringify({ attemptId: id, runnerId: "local", runnerName: "Offline laptop", baseCommit: head, revision: recoveryTask.revision }) });
  await api(`/api/team/attempts/${id}/finish`, { method: "POST", body: JSON.stringify({ state: "unknown", reason: "Lost contact" }) });
  await page.goto(`${base}/#/team/task/${recoveryTask.id}`);
  await page.getByRole("button", { name: "Recover attempt…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Recover attempt", exact: true }); await dialog.waitFor();
  assert.equal(await page.getByRole("button", { name: "Build with agents", exact: true }).count(), 0);
  const release = dialog.getByRole("button", { name: "Release task", exact: true }); assert.equal(await release.isDisabled(), true);
  await dialog.getByRole("textbox", { name: "How did you confirm execution stopped?" }).fill("Stopped the agent on the laptop and verified no process is running.");
  assert.equal(await release.isDisabled(), true, "a reason alone is not confirmation");
  await dialog.getByRole("checkbox", { name: "I confirmed the original agent has stopped." }).check();
  await audit(page, "recover unknown attempt"); assert.deepEqual(violations, []);
  await release.click(); await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Build with agents", exact: true }).waitFor();
  const recovered = await api<TaskView>(`/api/team/tasks/${recoveryTask.id}`);
  assert.equal(recovered.attempts[0]!.state, "superseded"); assert.equal(recovered.audit.at(-1)!.action, "attempt-recovered");
  assert.deepEqual(errors, []);
});

test("three shared tabs on Team hold one connection each, so a request from the first still goes through", async () => {
  const extra: Page[] = [];
  try {
    for (let n = 0; n < 2; n++) { const tab = await sharedContext.newPage(); extra.push(tab); await tab.goto(`${base}/#/team`); await tab.getByRole("tab", { name: "Team", exact: true, selected: true }).waitFor(); await tab.getByRole("heading", { level: 1, name: "Team", exact: true }).waitFor(); }
    await shared.getByRole("tab", { name: "Team", exact: true, selected: true }).waitFor(); // the first tab is still on the task page
    // A browser gives one server six connections for all its tabs; with two streams per tab the third tab exhausted them and this fetch never returned.
    const result = await shared.evaluate(async () => { const started = performance.now(), control = new AbortController(), timer = setTimeout(() => control.abort(), 6_000); try { const response = await fetch("/api/team/inbox", { signal: control.signal }); return { status: response.status, ms: Math.round(performance.now() - started) }; } catch (error) { return { status: 0, ms: Math.round(performance.now() - started), error: String(error) }; } finally { clearTimeout(timer); } });
    assert.equal(result.status, 200, `the request from the first Team tab stalled: ${JSON.stringify(result)}`);
  } finally { for (const tab of extra) await tab.close().catch(() => undefined); }
  assert.deepEqual(errors, []);
});

test("a shared dashboard left open asks the server for nothing: no board, task or inbox polls in five minutes on either tab", async () => {
  // The clock is faked before the page loads, so every timer the dashboard sets runs on it; the event streams are real.
  const tab = await sharedContext.newPage(); tab.on("pageerror", (error) => errors.push(`shared idle: ${error.message}`));
  const polls: string[] = []; tab.on("request", (request) => { const path = new URL(request.url()).pathname; if (/^\/api\/team\/(?:board|inbox|tasks\/)/.test(path)) polls.push(`${request.method()} ${path}`); });
  try {
    await tab.clock.install();
    await tab.goto(`${base}/#/team`); await tab.getByRole("tab", { name: "Team", exact: true, selected: true }).waitFor(); await tab.getByRole("region", { name: /^Working|^Planned/ }).first().waitFor(); await tab.getByRole("heading", { name: /^Inbox/ }).waitFor();
    await tab.clock.runFor(2_000); await sleep(500); polls.length = 0; // the first loads and the reload the stream's hello asks for are done
    await tab.clock.runFor(5 * 60_000); await sleep(500);
    assert.deepEqual(polls, [], "the Team tab reloads on events only; a timer would keep an idle shared session alive for ever");
    await tab.goto(`${base}/#/`); await tab.getByRole("tab", { name: "Results", exact: true, selected: true }).waitFor(); await tab.getByRole("heading", { name: "Shared project review", exact: true }).waitFor();
    await tab.clock.runFor(2_000); await sleep(500); polls.length = 0;
    await tab.clock.runFor(5 * 60_000); await sleep(500);
    assert.deepEqual(polls, [], "the Results tab never asks for the inbox on a timer");
  } finally { await tab.close().catch(() => undefined); }
  assert.deepEqual(errors, []);
});

test("Draft with agent prepares editable fields without creating a task; Build with agents uses the existing attempt flow", async () => {
  const before = (await api<{ tasks: unknown[] }>("/api/team/board")).tasks.length;
  await page.goto(`${base}/#/team`);
  await page.getByRole("button", { name: "Draft with agent", exact: true }).click();
  const form = page.getByRole("form", { name: "New task", exact: true });
  const draft = form.getByRole("region", { name: "Draft with agent", exact: true });
  await draft.getByLabel("Idea", { exact: true }).fill("Make the README greeting clearer for teammates.");
  assert.equal(await draft.getByLabel("Repository folder").inputValue(), repo);
  await draft.getByLabel("Drafting agent").selectOption("claude");
  await audit(page, "task drafting form");
  // A launch error preserves the user's idea and permits correction without creating a task.
  await form.getByLabel("Base branch").fill("missing-draft-branch");
  await draft.getByRole("button", { name: "Generate draft", exact: true }).click();
  await draft.getByRole("alert").filter({ hasText: /not found/ }).waitFor();
  assert.equal(await draft.getByLabel("Idea", { exact: true }).inputValue(), "Make the README greeting clearer for teammates.");
  await form.getByLabel("Base branch").fill("main");
  await draft.getByRole("button", { name: "Generate draft", exact: true }).click();
  await draft.getByRole("button", { name: "Use draft in form", exact: true }).waitFor({ timeout: 40000 });
  assert.equal((await api<{ tasks: unknown[] }>("/api/team/board")).tasks.length, before);
  assert.equal(await form.getByLabel("Title", { exact: true }).inputValue(), "");
  await audit(page, "task draft preview");
  await draft.getByRole("button", { name: "Use draft in form", exact: true }).click();
  assert.equal(await form.getByLabel("Title", { exact: true }).inputValue(), "Improve the team greeting");
  assert.match(await form.getByLabel("Goal", { exact: true }).inputValue(), /Proposed implementation plan/);
  await form.getByLabel("Title", { exact: true }).fill("Reviewed agent draft");
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("button", { name: "Build with agents", exact: true }).waitFor();
  const id = /#\/team\/task\/([^/]+)$/.exec(page.url())![1]!;
  const saved = await api<TaskView>(`/api/team/tasks/${id}`);
  assert.equal(saved.title, "Reviewed agent draft"); assert.equal(saved.owner?.userId, "owner"); assert.equal(saved.attempts.length, 0);
  await page.getByRole("button", { name: "Build with agents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Build with agents", exact: true });
  await dialog.getByLabel("Workflow", { exact: true }).selectOption("auto-team");
  const pool = dialog.getByRole("group", { name: "Available providers", exact: true });
  assert.ok(await pool.getByRole("checkbox").count() >= 2);
  assert.ok(await pool.locator("input:checked").count() >= 2, "Auto team preserves multiple selected providers");
  await audit(page, "build with auto team");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await fits(page), true); await audit(page, "build with agents phone");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByLabel("Workflow", { exact: true }).selectOption("solo");
  await dialog.getByLabel("Agent", { exact: true }).selectOption("claude");
  await dialog.getByLabel("Agent permissions").selectOption("safe");
  await dialog.getByLabel("Check command").fill("true");
  await dialog.getByLabel("Time budget (minutes)").fill("3");
  await dialog.getByLabel("Agent call budget").fill("4");
  const request = page.waitForRequest((request) => request.url().endsWith(`/api/team-link/tasks/${id}/start`) && request.method() === "POST");
  await dialog.getByRole("button", { name: "Build with agents", exact: true }).click();
  const body = (await request).postDataJSON();
  assert.deepEqual(body.roles, { agent: ["claude"] }); assert.deepEqual(body.loop, { check: "true", maxMinutes: 3, maxSteps: 4 });
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("link", { name: "Open run", exact: true }).waitFor();
  const built = await api<TaskView>(`/api/team/tasks/${id}`); assert.equal(built.attempts.length, 1);
  assert.deepEqual(violations, []); assert.deepEqual(errors, []);
});
