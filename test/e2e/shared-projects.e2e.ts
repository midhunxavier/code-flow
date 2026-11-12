import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserServer } from "playwright-core";
import axe from "axe-core";
import { SharedAccounts } from "../../src/shared-accounts.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-shared-ui-"))), home = join(fixture, "data");
const owner = "shared-projects-owner-token", password = "a long local review password", ownerHeaders = { authorization: `Bearer ${owner}` };
const port = await new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
const base = `http://localhost:${port}`; let processServer: ChildProcess, browser: Browser, browserServer: BrowserServer, reviewerId: string, head: string;
let viewerCookie: string, reviewerCookie: string;
const jsonHeaders = { "content-type": "application/json", origin: base };
const sharedHeaders = (cookie: string) => ({ ...jsonHeaders, cookie });
async function signIn(username: string) { const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ username, password }) }); assert.equal(response.status, 200, await response.clone().text()); const body = await response.json(); assert.equal("token" in body, false, "raw sessions never appear in JSON"); const cookie = response.headers.getSetCookie().find((cookie) => !cookie.includes("Max-Age=0"))!; assert.ok(cookie?.includes("HttpOnly")); assert.ok(cookie.includes("SameSite=Strict")); return cookie.split(";")[0]!; }
async function auditShared(page: import("playwright-core").Page, screen: string) {
  for (const mode of [{ colorScheme: "light", width: 1280 }, { colorScheme: "dark", width: 1280 }, { colorScheme: "light", width: 390 }, { colorScheme: "dark", width: 390 }] as const) {
    await page.emulateMedia({ colorScheme: mode.colorScheme, reducedMotion: "reduce" }); await page.setViewportSize({ width: mode.width, height: 900 });
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }));
    assert.deepEqual(result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })) })), [], `${screen} ${mode.colorScheme} ${mode.width}`);
  }
  await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 1280, height: 900 });
}
before(async () => {
  mkdirSync(join(home, "runs"), { recursive: true }); const projects = [];
  for (const name of ["one", "two"]) {
    const repo = join(fixture, `repo-${name}`); mkdirSync(join(repo, "src"), { recursive: true }); writeFileSync(join(repo, "src/answer.ts"), "export const answer = 1;\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); git("init", "-q", "-b", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "initial"); const initial = git("rev-parse", "HEAD");
    const id = `shared-${name}`, worktreeDir = join(fixture, "worktrees", id), tree = join(worktreeDir, "result"); mkdirSync(worktreeDir, { recursive: true }); git("worktree", "add", "-q", "-b", `codeflow/${id}/result`, tree, "main"); writeFileSync(join(tree, "src/answer.ts"), "export const answer = 2;\n"); execFileSync("git", ["add", "."], { cwd: tree }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "result"], { cwd: tree }); if (name === "one") head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" }).trim();
    projects.push({ id: `p-${name}`, name: `Project ${name}`, repos: [repo], createdAt: 1, defaults: { pattern: "solo", teams: {}, private: "private-default" } });
    const step = { id: "step", kind: "agent", title: "Build result", role: "agent", agent: "claude", mode: "write", status: "done", startedAt: 1, endedAt: 2, sessionId: "private-agent-session", finalText: "Reviewed implementation result" };
    const run = { id, project: `p-${name}`, task: `Shared project ${name} result`, pattern: "solo", repo, baseRef: initial, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir, roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { setup: "private-setup-command", check: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 1, checks: 0 }, status: "done", createdAt: name === "one" ? 10 : 20, endedAt: 30, seen: true, archived: false, worktrees: [{ name: "result", path: tree, branch: `codeflow/${id}/result` }], steps: [step], notes: [{ id: "private", text: "private-note-sentinel", at: 1, status: "delivered" }], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [], summary: "Implementation ready for human review" };
    writeFileSync(join(home, "runs", `${id}.jsonl`), [JSON.stringify({ seq: 1, ts: 1, runId: id, type: "run", run }), JSON.stringify({ seq: 2, ts: 2, runId: id, type: "step", step }), JSON.stringify({ seq: 3, ts: 3, runId: id, type: "agent", stepId: "step", event: { kind: "text", text: "private-agent-prompt-sentinel" } })].join("\n") + "\n");
    if (name === "one") { const cold = { ...run, id: "cold-deep", task: `Archived task ${"padding ".repeat(1200)} DeepColdNeedle`, archived: true, worktrees: [], steps: [], notes: [], summary: "Archived authorized task" }; writeFileSync(join(home, "runs/cold-deep.jsonl"), JSON.stringify({ seq: 4, ts: 1, runId: cold.id, type: "run", run: cold }) + "\n"); }
  }
  writeFileSync(join(home, "projects.json"), JSON.stringify(projects)); const accounts = new SharedAccounts(join(home, "shared-accounts.json")); await accounts.load();
  await accounts.create({ revision: 0, username: "viewer", displayName: "Project viewer", password, roles: { "p-one": "viewer" } }); const state = await accounts.create({ revision: 1, username: "reviewer", displayName: "Project reviewer", password, roles: { "p-one": "reviewer" } }); reviewerId = state.users.find((user) => user.username === "reviewer")!.id;
  // A comment a shared reviewer recorded while the shared dashboard still had its Results page: the owner must keep seeing it.
  mkdirSync(join(home, "shared-reviews"), { recursive: true }); writeFileSync(join(home, "shared-reviews/shared-one.json"), JSON.stringify({ version: 1, revision: 1, comments: [{ id: randomUUID(), branch: "codeflow/shared-one/result", head, text: "Reviewed the exported answer and its changed commit.", actor: { id: `shared:${reviewerId}`, name: "Project reviewer" }, at: 5 }] }));
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); processServer = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: owner, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  let ready = false; for (let attempt = 0; attempt < 150; attempt++) { ready = await fetch(`${base}/api/health`, { headers: ownerHeaders }).then((response) => response.ok, () => false); if (ready) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.equal(ready, true, "fixture server started");
  viewerCookie = await signIn("viewer"); reviewerCookie = await signIn("reviewer"); browserServer = await chromium.launchServer({ channel: "chrome", headless: true }); browser = await chromium.connect(browserServer.wsEndpoint());
});
after(async () => {
  // These contexts retain live event streams. Terminate our owned Chrome process instead of
  // letting an individual context's graceful close hold the entire browser suite open.
  try { await browserServer?.kill(); }
  finally {
    if (processServer && processServer.exitCode === null && processServer.signalCode === null) {
      const exited = new Promise<void>((resolve) => processServer.once("exit", () => resolve()));
      const timer = setTimeout(() => processServer.kill("SIGKILL"), 5000);
      processServer.kill("SIGTERM");
      try { await exited; } finally { clearTimeout(timer); }
      assert.equal(processServer.exitCode, 0, "fixture server stopped cleanly");
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a shared session reaches the team board and is refused every run, project, catalog and execution route", async () => {
  const ownerSelf = await fetch(`${base}/api/auth/self`, { headers: ownerHeaders }).then((response) => response.json());
  assert.match(ownerSelf.streamSharing.channelKey, /^[a-f0-9]{64}$/); assert.match(ownerSelf.streamSharing.lockId, /^[a-f0-9]{32}$/);
  const refused = async (path: string, cookie: string, init: RequestInit = {}) => { const response = await fetch(base + path, { ...init, headers: sharedHeaders(cookie) }); const text = await response.text(); assert.equal(response.status, 403, `${init.method ?? "GET"} ${path}`); assert.match(text, /This operation requires the Code Flow owner/, path); for (const value of ["Shared project", "Implementation ready", "private-", "repo-one", "repo-two", "worktreeDir", "Project one"]) assert.equal(text.includes(value), false, `${path} leaks ${value}`); };
  const review = { branch: "codeflow/shared-one/result", expectedHead: head, path: "src/answer.ts", reviewed: true }, comment = { branch: "codeflow/shared-one/result", expectedHead: head, text: "Shared comment" };
  for (const prefix of ["/api", "/api/v1"]) {
    for (const cookie of [viewerCookie, reviewerCookie]) {
      const identity = await fetch(`${base}${prefix}/auth/self`, { headers: sharedHeaders(cookie) }).then((response) => response.json());
      assert.equal(identity.kind, "shared"); assert.equal("streamSharing" in identity, false); assert.equal(JSON.stringify(identity).includes(ownerSelf.streamSharing.channelKey), false);
      assert.equal((await fetch(`${base}${prefix}/stream?subs=[]`, { headers: sharedHeaders(cookie) })).status, 403);
      assert.equal((await fetch(`${base}${prefix}/stream/owner-client`, { method: "POST", headers: sharedHeaders(cookie), body: JSON.stringify({ subscribe: [{ id: 1, topic: "runs" }] }) })).status, 403);
      // What a shared member has: the board of the projects where they hold a role.
      const board = await fetch(`${base}${prefix}/team/board`, { headers: sharedHeaders(cookie) }); assert.equal(board.status, 200); assert.deepEqual((await board.json()).projects.map((project: { id: string }) => project.id), ["p-one"]);
      // Runs are the owner's: history, detail, export, diff, coverage, comments and both event streams, in an assigned project (shared-one) as in another (shared-two).
      for (const path of ["/runs", "/runs?limit=1&q=Shared", "/runs?project=p-one&q=DeepColdNeedle", "/events", "/events?limit=50", ...["shared-one", "shared-two", "cold-deep"].flatMap((id) => ["", "/events", "/export", "/export?transcript=1", "/diff?branch=codeflow/shared-one/result", "/review-coverage?branch=codeflow/shared-one/result", "/collaboration"].map((suffix) => `/runs/${id}${suffix}`)), "/projects", "/patterns", "/templates"]) await refused(prefix + path, cookie);
      await refused(`${prefix}/runs/shared-one/review-coverage`, cookie, { method: "POST", body: JSON.stringify(review) }); await refused(`${prefix}/runs/shared-one/collaboration`, cookie, { method: "POST", body: JSON.stringify(comment) });
    }
    for (const path of ["/fs", "/file", "/tree", "/workspace/file", "/workspace/search", "/doctor", "/models", "/agents", "/stats", "/notes", "/approvals", "/remote", "/accounts", "/extensions", "/integrations", "/notifications", "/projects/p-one/conventions", "/runs/shared-one/export/extra"]) assert.equal((await fetch(base + prefix + path, { headers: sharedHeaders(viewerCookie) })).status, 403, path);
    for (const path of ["/runs", "/runs/shared-one/followups", "/runs/shared-one/notes", "/runs/shared-one/answer", "/runs/shared-one/resume", "/runs/shared-one/merge", "/runs/shared-one/validate-merge", "/runs/shared-one/triage", "/runs/shared-one/review-coverage/extra", "/workspace/file", "/readiness", "/shells", "/preview", "/approvals/id"]) assert.equal((await fetch(base + prefix + path, { method: "POST", headers: sharedHeaders(reviewerCookie), body: "{}" })).status, 403, path);
    for (const cookie of [viewerCookie, reviewerCookie]) for (const mode of ["quick", "repo"]) assert.equal((await fetch(base + prefix + "/improve-prompt", { method: "POST", headers: sharedHeaders(cookie), body: JSON.stringify({ text: "Clarify this task", mode, repo: join(fixture, "repo-one"), agent: "claude" }) })).status, 403, `${prefix}/improve-prompt ${mode}: shared roles cannot start provider turns`);
  }
  const coverage = await fetch(`${base}/api/runs/shared-one/review-coverage?branch=codeflow/shared-one/result`, { headers: ownerHeaders }).then((response) => response.json()); assert.deepEqual(coverage.reviewed, [], "a refused shared review records nothing");
  const thread = await fetch(`${base}/api/runs/shared-one/collaboration`, { headers: ownerHeaders }).then((response) => response.json()); assert.equal(thread.comments.length, 1, "a refused shared comment records nothing");
});

test("shared login opens the board with no Results page, and the owner still reads and answers an earlier reviewer comment", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage(); const runRequests: string[] = []; page.on("request", (request) => { const path = new URL(request.url()).pathname; if (/^\/api\/(?:runs|events|projects)(?:\/|$)/.test(path)) runRequests.push(path); }); await page.goto(base);
  await page.getByRole("heading", { name: "Sign in to shared projects", exact: true }).waitFor(); await auditShared(page, "shared login"); const username = page.getByLabel("Username", { exact: true }); await username.fill("reviewer"); await username.focus(); await page.keyboard.press("Tab"); assert.equal(await page.getByLabel("Password", { exact: true }).evaluate((element) => element === document.activeElement), true); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The default address is the board; so are #/, #/team and an address the owner's app would open as a run.
  for (const hash of ["", "#/", "#/team", "#/run/shared-one"]) {
    if (hash) await page.goto(`${base}/${hash}`);
    await page.getByRole("heading", { name: "Board", exact: true }).waitFor(); await page.locator(".connection-status .cs-label").getByText("Connected", { exact: true }).waitFor();
    assert.equal(await page.getByRole("tab").count(), 0, `${hash}: no tabs`); assert.equal(await page.getByRole("tablist").count(), 0);
    for (const gone of ["Shared project review", "Shared project one result", "Export shared result", "Human collaboration comments"]) assert.equal(await page.getByText(gone).count(), 0, `${hash}: ${gone}`);
  }
  await page.getByRole("button", { name: "Sign out Project reviewer", exact: true }).waitFor(); await page.getByRole("button", { name: /^Team inbox/ }).waitFor();
  assert.deepEqual(runRequests, [], "the shared dashboard asks for no runs, run events or project list");
  await auditShared(page, "shared board");
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.locator(".shared-surface").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "the shared board fits a phone");
  if (process.env.CODEFLOW_UI_SCREENSHOTS) { mkdirSync(join(root, "output/playwright"), { recursive: true }); await page.screenshot({ path: join(root, "output/playwright/shared-board-mobile.png") }); }
  const ownerThread = await fetch(`${base}/api/runs/shared-one/collaboration`, { headers: ownerHeaders }); assert.equal(ownerThread.status, 200); assert.deepEqual((await ownerThread.json()).comments[0].actor, { id: `shared:${reviewerId}`, name: "Project reviewer" });
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const ownerPage = await ownerContext.newPage(); await ownerPage.addInitScript(() => { localStorage.setItem("sideOpen", "1"); localStorage.setItem("sideTab", "changes"); }); await ownerPage.goto(`${base}/?token=${owner}#/run/shared-one`); await ownerPage.getByRole("tab", { name: "Changes", exact: true }).click(); const ownerPanel = ownerPage.locator(".collaboration-comments"); await ownerPanel.locator(":scope > summary").click(); await ownerPanel.getByText("Reviewed the exported answer and its changed commit.", { exact: true }).waitFor(); await ownerPanel.getByText("Project reviewer").first().waitFor(); await ownerPanel.getByLabel("Your comment", { exact: true }).fill("Owner acknowledged the reviewer finding."); const ownerReply = ownerPage.waitForResponse((response) => response.url().endsWith("/api/runs/shared-one/collaboration") && response.request().method() === "POST"); await ownerPanel.getByRole("button", { name: "Add comment", exact: true }).click(); assert.equal((await ownerReply).status(), 201); await ownerPanel.getByText("Owner acknowledged the reviewer finding.", { exact: true }).waitFor();
  const replied = await fetch(`${base}/api/runs/shared-one/collaboration`, { headers: ownerHeaders }).then((response) => response.json()); assert.equal(replied.comments.length, 2); assert.equal(replied.comments[1].actor.id, "owner"); assert.equal(replied.comments[1].text, "Owner acknowledged the reviewer finding."); assert.equal(replied.comments[1].head, head);
  await auditShared(ownerPage, "owner collaboration thread");
  const ownerRun = await fetch(`${base}/api/runs/shared-one`, { headers: ownerHeaders }).then((response) => response.json()); assert.equal(ownerRun.notes.length, 1, "human comments do not dispatch agent notes"); assert.equal(ownerRun.steps.length, 1, "human comments launch no agents");
});

test("owner account changes revoke shared sessions immediately and stale account edits fail CAS", async () => {
  const state = await fetch(`${base}/api/accounts`, { headers: ownerHeaders }).then((response) => response.json()); const response = await fetch(`${base}/api/accounts/${reviewerId}`, { method: "PUT", headers: { ...ownerHeaders, ...jsonHeaders }, body: JSON.stringify({ revision: state.revision, roles: { "p-one": "viewer" } }) }); assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/api/team/board`, { headers: sharedHeaders(reviewerCookie) })).status, 401);
  assert.equal((await fetch(`${base}/api/accounts/${reviewerId}`, { method: "PUT", headers: { ...ownerHeaders, ...jsonHeaders }, body: JSON.stringify({ revision: state.revision, enabled: false }) })).status, 409);
  reviewerCookie = await signIn("reviewer"); const board = await fetch(`${base}/api/team/board`, { headers: sharedHeaders(reviewerCookie) }).then((response) => response.json()); assert.deepEqual(board.me.roles, { "p-one": "viewer" }, "the new session carries the changed role");
  const raw = readFileSync(join(home, "shared-accounts.json"), "utf8"); assert.equal(raw.includes(password), false); assert.equal(raw.includes(reviewerCookie.split("=")[1]!), false);
});

test("owner account management creates scoped accounts, keeps conflicting drafts and revokes sessions through the UI", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage(); await page.goto(`${base}/?token=${owner}`); await page.goto(`${base}/#/settings/connections/manage`);
  const panel = page.getByRole("region", { name: "Shared project accounts", exact: true }); await panel.getByLabel("Account username", { exact: true }).fill("browser-viewer"); await panel.getByLabel("Display name", { exact: true }).fill("Browser viewer"); await panel.getByLabel("Initial password", { exact: true }).fill(password); await panel.getByLabel("Project two", { exact: true }).selectOption("viewer"); await panel.getByRole("button", { name: "Create account", exact: true }).click(); await panel.getByRole("status").getByText(/Account saved/).waitFor();
  assert.equal(await panel.getByLabel("Replace password (leave empty to keep)", { exact: true }).inputValue(), "", "successful account administration clears passwords");
  const id = await panel.getByLabel("Account", { exact: true }).inputValue(); const state = await fetch(`${base}/api/accounts`, { headers: ownerHeaders }).then((response) => response.json());
  const external = await fetch(`${base}/api/accounts/${id}`, { method: "PUT", headers: { ...ownerHeaders, ...jsonHeaders }, body: JSON.stringify({ revision: state.revision, displayName: "Concurrent display name" }) }); assert.equal(external.status, 200);
  await panel.getByLabel("Display name", { exact: true }).fill("Preserved browser draft"); await panel.getByRole("button", { name: "Save account changes", exact: true }).click(); await panel.getByRole("alert").getByText(/Accounts changed/).waitFor(); assert.equal(await panel.getByLabel("Display name", { exact: true }).inputValue(), "Preserved browser draft");
  await panel.getByRole("button", { name: "Reload accounts", exact: true }).click(); await panel.getByRole("button", { name: "Save account changes", exact: true }).click(); await panel.getByRole("status").getByText(/Account saved/).waitFor();
  const cookie = await signIn("browser-viewer"); const assigned = await fetch(`${base}/api/team/board`, { headers: sharedHeaders(cookie) }).then((response) => response.json()); assert.deepEqual(assigned.projects.map((project: { id: string }) => project.id), ["p-two"]);
  await panel.getByRole("button", { name: "Sign out all sessions", exact: true }).click(); await panel.getByRole("status").getByText(/were revoked/).waitFor(); assert.equal((await fetch(`${base}/api/team/board`, { headers: sharedHeaders(cookie) })).status, 401);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
});

test("shared sign-in clears owner browser privileges and checks mutation origin and request type", async () => {
  const context = await browser.newContext(); const page = await context.newPage(); await page.goto(`${base}/?token=${owner}`);
  const signed = await page.evaluate(async ({ password }) => { const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "viewer", password }) }); return response.status; }, { password }); assert.equal(signed, 200);
  assert.equal(await page.evaluate(async () => (await fetch("/api/accounts")).status), 403, "old owner cookie cannot override the active shared identity");
  assert.equal((await fetch(`${base}/api/accounts`, { headers: { ...sharedHeaders(viewerCookie), ...ownerHeaders } })).status, 200, "an explicit local owner bearer can recover despite an active shared cookie");
  assert.equal((await fetch(`${base}/api/accounts`, { headers: { ...ownerHeaders, cookie: `codeflow_shared_${port}=revoked-cookie` } })).status, 200, "explicit local recovery also overrides a revoked shared cookie");
  assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { ...sharedHeaders(viewerCookie), origin: "https://attacker.invalid" }, body: "{}" })).status, 403);
  const form = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: viewerCookie, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "value=anything" }); assert.ok([400, 403, 415].includes(form.status), `form mutation was refused: ${form.status}`);
  await page.evaluate(async () => { await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); });
  assert.equal(await page.evaluate(async () => (await fetch("/api/accounts")).status), 401, "shared logout does not fall back to a stale owner cookie");
  await page.goto(`${base}/?token=${owner}`); assert.equal(await page.evaluate(async () => (await fetch("/api/accounts")).status), 200, "explicit owner recovery link remains usable");
});

test("shared stream admission is bounded on the team stream, the only one a shared session can open", async () => {
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [], controllers: AbortController[] = [];
  try {
    for (let count = 0; count < 4; count++) { const abort = new AbortController(); controllers.push(abort); const response = await fetch(`${base}/api/team/events`, { headers: sharedHeaders(viewerCookie), signal: abort.signal }); assert.equal(response.status, 200); const reader = response.body!.getReader(); readers.push(reader); await reader.read(); }
    const refused = await fetch(`${base}/api/team/events`, { headers: sharedHeaders(viewerCookie) }); assert.equal(refused.status, 429, "a session cannot create unbounded event subscriptions");
    for (const path of ["/api/events", "/api/runs/shared-one/events"]) assert.equal((await fetch(base + path, { headers: sharedHeaders(viewerCookie) })).status, 403, path);
  } finally { for (const reader of readers) await reader.cancel().catch(() => {}); for (const abort of controllers) abort.abort(); }
});
