import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import axe from "axe-core";
import { SharedAccounts } from "../../src/shared-accounts.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-shared-ui-"))), home = join(fixture, "data");
const owner = "shared-projects-owner-token", password = "a long local review password", ownerHeaders = { authorization: `Bearer ${owner}` };
const port = await new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
const base = `http://localhost:${port}`; let processServer: ChildProcess, browser: Browser, reviewerId: string, head: string;
let viewerCookie: string, reviewerCookie: string; const contexts: BrowserContext[] = [];
const jsonHeaders = { "content-type": "application/json", origin: base };
const sharedHeaders = (cookie: string) => ({ ...jsonHeaders, cookie });
async function signIn(username: string) { const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ username, password }) }); assert.equal(response.status, 200, await response.clone().text()); const body = await response.json(); assert.equal("token" in body, false, "raw sessions never appear in JSON"); const cookie = response.headers.getSetCookie().find((cookie) => !cookie.includes("Max-Age=0"))!; assert.ok(cookie?.includes("HttpOnly")); assert.ok(cookie.includes("SameSite=Strict")); return cookie.split(";")[0]!; }
async function auditShared(page: import("playwright-core").Page, screen: string) {
  for (const mode of [{ colorScheme: "light", width: 1280 }, { colorScheme: "dark", width: 1280 }, { colorScheme: "light", width: 390 }, { colorScheme: "dark", width: 390 }] as const) {
    await page.emulateMedia({ colorScheme: mode.colorScheme, reducedMotion: "reduce" }); await page.setViewportSize({ width: mode.width, height: 900 });
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
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
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); processServer = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: owner, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  let ready = false; for (let attempt = 0; attempt < 150; attempt++) { ready = await fetch(`${base}/api/health`, { headers: ownerHeaders }).then((response) => response.ok, () => false); if (ready) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.equal(ready, true, "fixture server started");
  viewerCookie = await signIn("viewer"); reviewerCookie = await signIn("reviewer"); browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { for (const context of contexts) await context.close(); await browser?.close(); processServer?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (!processServer || processServer.exitCode !== null) return resolve(); processServer.once("exit", resolve); setTimeout(resolve, 5000).unref(); }); rmSync(fixture, { recursive: true, force: true }); });

test("shared route enforcement scopes aliases, search counts, exports and SSE while denying all execution surfaces", async () => {
  for (const prefix of ["/api", "/api/v1"]) {
    const projects = await fetch(base + prefix + "/projects", { headers: sharedHeaders(viewerCookie) }).then((response) => response.json()); assert.deepEqual(projects.map((project: { id: string }) => project.id), ["p-one"]); assert.equal(JSON.stringify(projects).includes("private-default"), false); assert.equal(JSON.stringify(projects).includes("repo-one"), false);
    const runs = await fetch(base + prefix + "/runs?limit=1&q=Shared", { headers: sharedHeaders(viewerCookie) }).then((response) => response.json()); assert.equal(runs.total, 1); assert.deepEqual(runs.runs.map((run: { id: string }) => run.id), ["shared-one"]); assert.equal(runs.nextCursor, undefined);
    const deep = await fetch(base + prefix + "/runs?project=p-one&q=DeepColdNeedle", { headers: sharedHeaders(viewerCookie) }).then((response) => response.json()); assert.equal(deep.total, 1); assert.equal(deep.runs[0].id, "cold-deep"); assert.equal(deep.runs[0].cold, true); assert.equal(deep.runs[0].detailAvailable, true); assert.equal(deep.runs[0].task.includes("DeepColdNeedle"), false, "query reads the full authorized cold task while the list remains a bounded preview");
    for (const path of ["/runs/shared-two", "/runs/shared-two/events", "/runs/shared-two/diff", "/runs/shared-two/export", "/runs/shared-two/review-coverage", "/runs/shared-two/collaboration"]) assert.equal((await fetch(base + prefix + path, { headers: sharedHeaders(viewerCookie) })).status, 404, path);
    for (const path of ["/fs", "/file", "/tree", "/workspace/file", "/workspace/search", "/doctor", "/models", "/agents", "/stats", "/notes", "/approvals", "/remote", "/accounts", "/filtered-tasks", "/remote-workers", "/code-hosts", "/coordinated-changes", "/extensions", "/integrations", "/notifications", "/projects/p-one/conventions"]) assert.equal((await fetch(base + prefix + path, { headers: sharedHeaders(viewerCookie) })).status, 403, path);
    for (const path of ["/runs", "/runs/shared-one/followups", "/runs/shared-one/notes", "/runs/shared-one/answer", "/runs/shared-one/resume", "/runs/shared-one/merge", "/runs/shared-one/validate-merge", "/runs/shared-one/triage", "/runs/shared-one/launch-profiles", "/workspace/file", "/readiness", "/shells", "/preview", "/filtered-tasks", "/filtered-tasks/id/import", "/approvals/id"]) assert.equal((await fetch(base + prefix + path, { method: "POST", headers: sharedHeaders(reviewerCookie), body: "{}" })).status, 403, path);
    for (const cookie of [viewerCookie, reviewerCookie]) for (const mode of ["quick", "repo"]) assert.equal((await fetch(base + prefix + "/improve-prompt", { method: "POST", headers: sharedHeaders(cookie), body: JSON.stringify({ text: "Clarify this task", mode, repo: join(fixture, "repo-one"), agent: "claude" }) })).status, 403, `${prefix}/improve-prompt ${mode}: shared roles cannot start provider turns`);
  }
  const exported = await fetch(`${base}/api/runs/shared-one/export?transcript=1`, { headers: sharedHeaders(viewerCookie) }).then((response) => response.text()); for (const value of ["shared-two", "private-note-sentinel", "private-agent-session", "private-agent-prompt-sentinel", "private-setup-command", "repo-one", "worktreeDir"]) assert.equal(exported.includes(value), false, value);
  const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 5000);
  try { const response = await fetch(`${base}/api/events?limit=50`, { headers: sharedHeaders(viewerCookie), signal: abort.signal }); const reader = response.body!.getReader(); let source = ""; while (!source.includes("\n\n")) { const part = await reader.read(); if (part.done) break; source += new TextDecoder().decode(part.value); } await reader.cancel(); assert.match(source, /shared-one/); assert.equal(source.includes("shared-two"), false); assert.equal(source.includes("private-note"), false); assert.equal(source.includes('"total":3'), false); }
  finally { clearTimeout(timeout); abort.abort(); }
  const review = { branch: "codeflow/shared-one/result", expectedHead: head, path: "src/answer.ts", reviewed: true };
  assert.equal((await fetch(`${base}/api/runs/shared-one/review-coverage`, { method: "POST", headers: sharedHeaders(viewerCookie), body: JSON.stringify(review) })).status, 403);
  assert.equal((await fetch(`${base}/api/runs/shared-one/review-coverage/extra`, { method: "POST", headers: sharedHeaders(reviewerCookie), body: JSON.stringify(review) })).status, 403);
  assert.equal((await fetch(`${base}/api/runs/shared-one/export/extra`, { headers: sharedHeaders(viewerCookie) })).status, 403);
});

test("shared login and reviewer dashboard record human review and commit-anchored comments with keyboard and phone layout", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context); const page = await context.newPage(); await page.goto(base);
  await page.getByRole("heading", { name: "Sign in to shared projects", exact: true }).waitFor(); await auditShared(page, "shared login"); const username = page.getByLabel("Username", { exact: true }); await username.fill("reviewer"); await username.focus(); await page.keyboard.press("Tab"); assert.equal(await page.getByLabel("Password", { exact: true }).evaluate((element) => element === document.activeElement), true); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Shared project review", exact: true }).waitFor(); await page.getByRole("button", { name: /Shared project one result/ }).click();
  await page.getByRole("heading", { name: "Shared project one result", exact: true }).waitFor();
  let releaseHistory!: () => void, historyStarted!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; }), historyPending = new Promise<void>((resolve) => { historyStarted = resolve; });
  // Review writes emit an SSE event. Hold its background history refresh so a read cannot
  // disable or silently consume the next explicit human comment action.
  await page.route(/\/api\/runs\?/, async (route) => { historyStarted(); await historyGate; await route.continue(); });
  try {
    const written = page.waitForResponse((response) => response.url().endsWith("/api/runs/shared-one/review-coverage") && response.request().method() === "POST");
    const file = page.getByRole("checkbox", { name: "Reviewed src/answer.ts", exact: true }); await file.check(); await page.getByText(/1 of 1 visible files reviewed/).waitFor();
    let deadline: ReturnType<typeof setTimeout>;
    try { await Promise.all([written, Promise.race([historyPending, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Review SSE history refresh did not start")), 10_000); })])]); }
    finally { clearTimeout(deadline!); }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.getByLabel("Comment on this result commit", { exact: true }).fill("Reviewed the exported answer and its changed commit.");
    assert.equal(await page.getByRole("button", { name: "Record human comment", exact: true }).isEnabled(), true, "background history refresh cannot block a human review mutation");
    await page.getByRole("button", { name: "Record human comment", exact: true }).click(); await page.getByText("Reviewed the exported answer and its changed commit.", { exact: true }).waitFor();
  } finally { releaseHistory(); await page.unrouteAll({ behavior: "wait" }); }
  await auditShared(page, "shared review dashboard");
  const comments = await fetch(`${base}/api/runs/shared-one/collaboration`, { headers: sharedHeaders(viewerCookie) }).then((response) => response.json()); assert.equal(comments.comments.length, 1); assert.deepEqual(comments.comments[0].actor, { id: `shared:${reviewerId}`, name: "Project reviewer" }); assert.equal(comments.comments[0].head, head);
  const ownerThread = await fetch(`${base}/api/runs/shared-one/collaboration`, { headers: ownerHeaders }); assert.equal(ownerThread.status, 200); assert.equal((await ownerThread.json()).comments[0].actor.id, `shared:${reviewerId}`);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(ownerContext); const ownerPage = await ownerContext.newPage(); await ownerPage.addInitScript(() => { localStorage.setItem("sideOpen", "1"); localStorage.setItem("sideTab", "changes"); }); await ownerPage.goto(`${base}/?token=${owner}#/run/shared-one`); await ownerPage.getByRole("tab", { name: "Changes", exact: true }).click(); const ownerPanel = ownerPage.locator(".collaboration-comments"); await ownerPanel.locator(":scope > summary").click(); await ownerPanel.getByText("Reviewed the exported answer and its changed commit.", { exact: true }).waitFor(); await ownerPanel.getByLabel("Owner comment on this result commit", { exact: true }).fill("Owner acknowledged the reviewer finding."); const ownerReply = ownerPage.waitForResponse((response) => response.url().endsWith("/api/runs/shared-one/collaboration") && response.request().method() === "POST"); await ownerPanel.getByRole("button", { name: "Record owner comment", exact: true }).click(); assert.equal((await ownerReply).status(), 201); await ownerPanel.getByText("Owner acknowledged the reviewer finding.", { exact: true }).waitFor();
  const sharedReply = await fetch(`${base}/api/runs/shared-one/collaboration`, { headers: sharedHeaders(viewerCookie) }).then((response) => response.json()); assert.equal(sharedReply.comments.length, 2); assert.equal(sharedReply.comments[1].actor.id, "owner"); assert.equal(sharedReply.comments[1].text, "Owner acknowledged the reviewer finding."); assert.equal(sharedReply.comments[1].head, head);
  await auditShared(ownerPage, "owner collaboration thread");
  await page.getByRole("button", { name: "Refresh result evidence", exact: true }).click(); await page.getByText("Owner acknowledged the reviewer finding.", { exact: true }).waitFor();
  const ownerRun = await fetch(`${base}/api/runs/shared-one`, { headers: ownerHeaders }).then((response) => response.json()); assert.equal(ownerRun.notes.length, 1, "human comments do not dispatch agent notes"); assert.equal(ownerRun.steps.length, 1, "human comments launch no agents");
  const link = page.getByRole("link", { name: "Export shared result", exact: true }); assert.equal(await link.getAttribute("target"), "_blank"); assert.match(await link.getAttribute("rel") ?? "", /noopener/);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.locator(".shared-surface").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "review dashboard fits a phone");
  if (process.env.CODEFLOW_UI_SCREENSHOTS) { mkdirSync(join(root, "output/playwright"), { recursive: true }); await page.screenshot({ path: join(root, "output/playwright/shared-review-mobile.png") }); }
});

test("owner account changes revoke shared sessions immediately and stale account edits fail CAS", async () => {
  const state = await fetch(`${base}/api/accounts`, { headers: ownerHeaders }).then((response) => response.json()); const response = await fetch(`${base}/api/accounts/${reviewerId}`, { method: "PUT", headers: { ...ownerHeaders, ...jsonHeaders }, body: JSON.stringify({ revision: state.revision, roles: { "p-one": "viewer" } }) }); assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/api/runs/shared-one`, { headers: sharedHeaders(reviewerCookie) })).status, 401);
  assert.equal((await fetch(`${base}/api/accounts/${reviewerId}`, { method: "PUT", headers: { ...ownerHeaders, ...jsonHeaders }, body: JSON.stringify({ revision: state.revision, enabled: false }) })).status, 409);
  reviewerCookie = await signIn("reviewer"); const denied = await fetch(`${base}/api/runs/shared-one/collaboration`, { method: "POST", headers: sharedHeaders(reviewerCookie), body: JSON.stringify({ branch: "codeflow/shared-one/result", expectedHead: head, text: "Role changed" }) }); assert.equal(denied.status, 403);
  const raw = readFileSync(join(home, "shared-accounts.json"), "utf8"); assert.equal(raw.includes(password), false); assert.equal(raw.includes(reviewerCookie.split("=")[1]!), false);
});

test("owner account management creates scoped accounts, keeps conflicting drafts and revokes sessions through the UI", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context); const page = await context.newPage(); await page.goto(`${base}/?token=${owner}`); await page.goto(`${base}/#/workspace`); await page.getByRole("button", { name: "Shared accounts", exact: true }).click();
  const panel = page.getByRole("region", { name: "Shared project accounts", exact: true }); await panel.getByLabel("Account username", { exact: true }).fill("browser-viewer"); await panel.getByLabel("Display name", { exact: true }).fill("Browser viewer"); await panel.getByLabel("Initial password", { exact: true }).fill(password); await panel.getByLabel("Project two", { exact: true }).selectOption("viewer"); await panel.getByRole("button", { name: "Create account", exact: true }).click(); await panel.getByRole("status").getByText(/Account saved/).waitFor();
  assert.equal(await panel.getByLabel("Replace password (leave empty to keep)", { exact: true }).inputValue(), "", "successful account administration clears passwords");
  const id = await panel.getByLabel("Account", { exact: true }).inputValue(); const state = await fetch(`${base}/api/accounts`, { headers: ownerHeaders }).then((response) => response.json());
  const external = await fetch(`${base}/api/accounts/${id}`, { method: "PUT", headers: { ...ownerHeaders, ...jsonHeaders }, body: JSON.stringify({ revision: state.revision, displayName: "Concurrent display name" }) }); assert.equal(external.status, 200);
  await panel.getByLabel("Display name", { exact: true }).fill("Preserved browser draft"); await panel.getByRole("button", { name: "Save account changes", exact: true }).click(); await panel.getByRole("alert").getByText(/Accounts changed/).waitFor(); assert.equal(await panel.getByLabel("Display name", { exact: true }).inputValue(), "Preserved browser draft");
  await panel.getByRole("button", { name: "Reload accounts", exact: true }).click(); await panel.getByRole("button", { name: "Save account changes", exact: true }).click(); await panel.getByRole("status").getByText(/Account saved/).waitFor();
  const cookie = await signIn("browser-viewer"); const assigned = await fetch(`${base}/api/projects`, { headers: sharedHeaders(cookie) }).then((response) => response.json()); assert.deepEqual(assigned.map((project: { id: string }) => project.id), ["p-two"]);
  await panel.getByRole("button", { name: "Sign out all sessions", exact: true }).click(); await panel.getByRole("status").getByText(/were revoked/).waitFor(); assert.equal((await fetch(`${base}/api/runs/shared-two`, { headers: sharedHeaders(cookie) })).status, 401);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
});

test("shared sign-in clears owner browser privileges and checks mutation origin and request type", async () => {
  const context = await browser.newContext(); contexts.push(context); const page = await context.newPage(); await page.goto(`${base}/?token=${owner}`);
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

test("shared stream admission is bounded and project removal immediately revokes an existing run feed", async () => {
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [], controllers: AbortController[] = [];
  try {
    for (let count = 0; count < 4; count++) { const abort = new AbortController(); controllers.push(abort); const response = await fetch(`${base}/api/events`, { headers: sharedHeaders(viewerCookie), signal: abort.signal }); assert.equal(response.status, 200); const reader = response.body!.getReader(); readers.push(reader); await reader.read(); }
    const refused = await fetch(`${base}/api/events`, { headers: sharedHeaders(viewerCookie) }); assert.equal(refused.status, 429, "a session cannot create unbounded event subscriptions");
  } finally { for (const reader of readers) await reader.cancel().catch(() => {}); for (const abort of controllers) abort.abort(); }
  const abort = new AbortController(); const response = await fetch(`${base}/api/runs/shared-one/events`, { headers: sharedHeaders(viewerCookie), signal: abort.signal }); assert.equal(response.status, 200); const reader = response.body!.getReader(); await reader.read();
  const removal = await fetch(`${base}/api/projects/p-one`, { method: "POST", headers: { ...ownerHeaders, ...jsonHeaders }, body: JSON.stringify({ repos: [] }) }); assert.equal(removal.status, 200);
  let ended = false;
  const drained = (async () => { while (true) { const part = await reader.read(); if (part.done) { ended = true; return; } } })();
  const timer = setTimeout(() => abort.abort(), 2000);
  try { await drained.catch((error) => { if (!abort.signal.aborted && error instanceof TypeError && error.message === "terminated") ended = true; else throw error; }); assert.equal(ended, true, "project membership changes close a previously authorized stream immediately"); }
  finally { clearTimeout(timer); abort.abort(); }
  assert.equal((await fetch(`${base}/api/runs/shared-one`, { headers: sharedHeaders(viewerCookie) })).status, 404);
});
