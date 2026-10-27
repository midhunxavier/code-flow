import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";
const root = fileURLToPath(new URL("..", import.meta.url)), token = "qa-collab-permissions", password = "local QA account password only", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, evidence = process.env.QA_ARTIFACT_DIR;
// Account role changes intentionally terminate the old shared session’s event stream.
// Only its exact transport error during that revocation window is expected.
let revokingBob = false;
let dir: string, repo: string, base: string, project: string, browser: Browser, ownerPage: Page, mia: Page, alice: Page, bob: Page, rita: Page;
let browserServer: BrowserServer | undefined;
const children: ChildProcess[] = [], errors: string[] = [], consoleErrors: string[] = [], requestFailures: string[] = [], logs: string[] = [], ids: Record<string, string> = {};
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = 30_000) { const end = Date.now() + ms; let value: T; do { value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < end); throw new Error(`${what}: ${JSON.stringify(value!)}`); }
async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", origin = base, auth = headers) { const pinnedPath = path.startsWith("/api/team/") ? `${path}${path.includes("?") ? "&" : "?"}teamConnection=local` : path; const response = await fetch(origin + pinnedPath, { method, headers: { ...auth, origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() as any }; }
async function api(path: string, body?: unknown, method?: string, origin?: string) { const r = await request(path, body, method, origin); assert.ok(r.status < 400, JSON.stringify(r)); return r.value; }
async function shared(page: Page, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") { const r = await page.request.fetch(base + path, { method, headers: { "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { data: body }) }); return { status: r.status(), value: await r.json() as any }; }
async function task(id: string) { return api(`/api/team/tasks/${id}`); }
async function create(title: string, owner = "owner") { return api("/api/team/tasks", { projectId: project, repository: "app", title, goal: "Original goal", acceptance: "Original acceptance", owner, baseRef: "main", labels: ["qa"] }); }
async function freePort() { return new Promise<number>(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const value = server.address(); if (!value || typeof value === "string") throw new Error("port"); server.close(() => resolve(value.port)); }); }); }
async function server(port: number, name: string) {
  const home = join(dir, name); await mkdir(home); const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, HOME: home, ZDOTDIR: home, SHELL: "/bin/sh", CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_REMOTE_PORT: String(await freePort()), PATH: `${root}/test/fake-bin:${process.env.PATH}`, FAKE_SLEEP_MS: "10000", FAKE_SLEEP_VENDOR: "codex" }, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  child.stdout?.on("data", c => logs.push(`${name}: ${c}`)); child.stderr?.on("data", c => logs.push(`${name}: ${c}`));
  await until(() => fetch(origin + "/api/health", { headers }).then(r => r.ok, () => false), Boolean, "server startup"); return origin;
}
async function newPage() { const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", e => errors.push(e.message)); page.on("console", message => { if (message.type() !== "error") return; consoleErrors.push(`${page.url()}: ${message.text()}`); if (page === bob && revokingBob && message.text() === "Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING") return; if (!/Failed to load resource: the server responded with a status of (400|403|404|409)/.test(message.text())) errors.push(message.text()); }); page.on("requestfailed", r => requestFailures.push(`${page.url()} ${r.url()}: ${r.failure()?.errorText}`)); page.on("response", r => { if (r.url().includes("/api/") && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); }); return page; }
async function signIn(username: string) { const page = await newPage(); await page.goto(base); await page.getByLabel("Username", { exact: true }).fill(username); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("heading", { name: "Shared project review", exact: true }).waitFor(); return page; }
async function open(page: Page, id: string) { await page.goto(`${base}/?team=local#/team/task/${id}`); await page.getByRole("heading", { name: "Goal and acceptance", exact: true }).waitFor(); }
async function shot(page: Page, name: string) { if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true, animations: "disabled" }); }
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "qa-collab-permissions-ui-"))); repo = join(dir, "repo"); await mkdir(repo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "QA collaboration\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "initial"], { cwd: repo });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); base = await server(process.env.QA_PORT ? Number(process.env.QA_PORT) : await freePort(), "hub");
  project = (await api("/api/projects", { name: "Collaboration permissions QA", repos: [repo] })).id; await api(`/api/team/projects/${project}/repositories`, { revision: 0, repositories: [{ key: "app", label: "QA app", defaultBranch: "main" }] }, "PUT"); await api("/api/team-link/mappings", { projectId: project, repository: "app", path: repo }, "PUT");
  for (const [username, role] of [["alice", "contributor"], ["bob", "contributor"], ["mia", "maintainer"], ["rita", "reviewer"], ["vic", "viewer"]]) { const accounts = await api("/api/accounts"); await api("/api/accounts", { revision: accounts.revision, username, displayName: `${username} QA`, password, roles: { [project]: role } }); }
  for (const u of (await api("/api/accounts")).users) ids[u.username] = u.id;
  // Keep explicit ownership even if creating the first context/page stalls.
  browserServer = await chromium.launchServer({ channel: "chrome", headless: true, timeout: 30_000 });
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 30_000 }); ownerPage = await newPage(); await ownerPage.goto(`${base}/?token=${token}&team=local`); mia = await signIn("mia"); alice = await signIn("alice"); bob = await signIn("bob"); rita = await signIn("rita"); console.log(JSON.stringify({ dir, base, repo, project }));
}, { timeout: 90_000 });
after(async () => {
  try {
    if (browserServer) {
      const ownedChrome = browserServer.process();
      const timer = setTimeout(() => { if (ownedChrome.exitCode === null && ownedChrome.signalCode === null) ownedChrome.kill("SIGKILL"); }, 10_000);
      try { await browserServer.close(); } finally { clearTimeout(timer); }
    }
  } finally {
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
    if (evidence) { await writeFile(join(evidence, "server.log"), logs.join("")); await writeFile(join(evidence, "browser-errors.json"), JSON.stringify({ errors, consoleErrors, requestFailures }, null, 2)); }
  }
  assert.deepEqual(errors, []);
}, { timeout: 30_000 });

test("streamed teammate edits cannot overwrite goal, acceptance, title or blocker drafts", { timeout: 90_000 }, async () => {
  const t = await create("Concurrent editing QA"); await open(ownerPage, t.id); await open(mia, t.id);
  for (const [field, label] of [["goal", "goal"], ["acceptance", "acceptance criteria"]]) {
    await ownerPage.locator(`#tt-${field}`).fill(`OWNER ${field}`); await mia.locator(`#tt-${field}`).fill(`MIA ${field}`); await mia.getByRole("button", { name: `Save ${label}`, exact: true }).click();
    const conflict = ownerPage.getByRole("alert").filter({ hasText: `MIA ${field}` }); await conflict.waitFor(); assert.equal(await ownerPage.locator(`#tt-${field}`).inputValue(), `OWNER ${field}`); assert.equal(await ownerPage.getByRole("button", { name: `Save ${label}`, exact: true }).isDisabled(), true); assert.equal((await task(t.id))[field!], `MIA ${field}`); await shot(ownerPage, `01-${field}-conflict`);
    if (field === "goal") { await conflict.getByRole("button", { name: "Replace saved goal", exact: true }).click(); await ownerPage.getByRole("dialog", { name: "Replace teammate’s text?", exact: true }).getByRole("button", { name: "Replace saved text", exact: true }).click(); await until(() => task(t.id), v => v.goal === "OWNER goal", "explicit replace"); await until(() => mia.locator("#tt-goal").inputValue(), v => v === "OWNER goal", "teammate observes replacement"); }
    else { await conflict.getByRole("button", { name: "Use saved acceptance criteria", exact: true }).click(); assert.equal(await ownerPage.locator("#tt-acceptance").inputValue(), "MIA acceptance"); }
  }
  await ownerPage.getByRole("button", { name: "Edit the title", exact: true }).click(); await ownerPage.locator("#tt-title").fill("OWNER title"); await mia.getByRole("button", { name: "Edit the title", exact: true }).click(); await mia.locator("#tt-title").fill("MIA title"); await mia.locator(".team-title-edit").getByRole("button", { name: "Save", exact: true }).click(); await ownerPage.getByRole("alert").filter({ hasText: "MIA title" }).waitFor(); assert.equal(await ownerPage.locator(".team-title-edit").getByRole("button", { name: "Save", exact: true }).isDisabled(), true); await ownerPage.getByRole("button", { name: "Use saved title", exact: true }).click(); await ownerPage.locator(".team-title-edit").getByRole("button", { name: "Cancel", exact: true }).click();
  await ownerPage.getByRole("combobox", { name: /^Status\b/ }).selectOption("blocked"); await ownerPage.locator("#tt-blocker").fill("OWNER blocker"); await mia.getByRole("combobox", { name: /^Status\b/ }).selectOption("blocked"); await mia.locator("#tt-blocker").fill("MIA blocker"); await mia.getByRole("button", { name: "Mark blocked", exact: true }).click(); await ownerPage.getByRole("alert").filter({ hasText: "MIA blocker" }).waitFor(); assert.equal(await ownerPage.getByRole("button", { name: "Mark blocked", exact: true }).isDisabled(), true); await shot(ownerPage, "02-title-blocker-conflict"); await ownerPage.setViewportSize({ width: 390, height: 844 }); assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot(ownerPage, "02b-phone-conflicts"); await ownerPage.setViewportSize({ width: 1440, height: 1000 });
});

test("a missed stream still gets 409 then shows saved text; a second click cannot silently overwrite", { timeout: 60_000 }, async () => {
  const t = await create("Missed stream QA"); await open(ownerPage, t.id); await ownerPage.locator("#tt-goal").fill("Unsent owner draft");
  let hold = true; const pending: (() => void)[] = []; await ownerPage.route(`**/api/team/tasks/${t.id}*`, async route => { if (route.request().method() === "GET" && hold) await new Promise<void>(resolve => pending.push(resolve)); await route.continue(); });
  await api(`/api/team/tasks/${t.id}`, { revision: t.revision, goal: "Saved teammate version" }, "PUT"); const response = ownerPage.waitForResponse(r => r.url().includes(`/api/team/tasks/${t.id}`) && r.request().method() === "PUT"); await ownerPage.getByRole("button", { name: "Save goal", exact: true }).click(); assert.equal((await response).status(), 409); hold = false; pending.splice(0).forEach(resolve => resolve()); await ownerPage.unrouteAll({ behavior: "wait" });
  await ownerPage.getByRole("alert").filter({ hasText: "Saved teammate version" }).waitFor(); assert.equal(await ownerPage.getByRole("button", { name: "Save goal", exact: true }).isDisabled(), true); assert.equal((await task(t.id)).goal, "Saved teammate version"); await shot(ownerPage, "03-cas-conflict");
});

test("viewer/reviewer details are read-only and demotion removes instruction and runner authority", { timeout: 60_000 }, async () => {
  const t = await create("Demoted owner QA", ids.bob); const connected = await request("/api/team/runners/connect", { username: "bob", password, name: "Bob scratch runner" }, "POST", base, { "content-type": "application/json" } as any); assert.equal(connected.status, 201); const runner = connected.value, runnerHeaders = { "content-type": "application/json", authorization: `Bearer ${runner.token}` };
  const attemptId = randomBytes(16).toString("hex"), head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(); const claimed = await request(`/api/team/tasks/${t.id}/attempts`, { attemptId, runnerId: runner.runner.id, runnerName: "Bob scratch runner", baseCommit: head, revision: t.revision }, "POST", base, runnerHeaders); assert.equal(claimed.status, 201);
  const instruction = await api(`/api/team/tasks/${t.id}/instructions`, { text: "Teammate instruction" }); const iid = instruction.instructions.at(-1).id;
  let accounts = await api("/api/accounts"); revokingBob = true; await api(`/api/accounts/${ids.bob}`, { revision: accounts.revision, roles: { [project]: "viewer" } }, "PUT");
  // Session revocation reloads this page; let that transition finish before closing its context.
  await bob.getByRole("heading", { name: "Sign in to shared projects", exact: true }).waitFor();
  await bob.context().close(); revokingBob = false; bob = await signIn("bob"); await open(bob, t.id);
  const details = bob.getByRole("region", { name: "Details", exact: true }); assert.equal(await details.locator("select,input,textarea").count(), 0); await details.getByText(/Read only/).waitFor(); assert.equal(await bob.getByRole("combobox", { name: "Status", exact: true }).count(), 0); assert.equal(await bob.getByRole("button", { name: /^(Approve|Decline)$/ }).count(), 0); await shot(bob, "04-viewer-details-light"); await bob.emulateMedia({ colorScheme: "dark" }); await shot(bob, "05-viewer-details-dark");
  for (const action of ["approve", "decline"]) assert.equal((await shared(bob, `/api/team/tasks/${t.id}/instructions/${iid}`, { action })).status, 403);
  assert.equal((await request(`/api/team/attempts/${attemptId}/heartbeat`, {}, "POST", base, runnerHeaders)).status, 403);
  const manifest = { commit: head, baseCommit: head, branch: "team/qa/checkpoint", size: 1, sha256: createHash("sha256").update("x").digest("hex"), note: "", requirements: "QA", decisions: [], remaining: "", changedFiles: [] };
  assert.equal((await request(`/api/team/attempts/${attemptId}/checkpoints`, manifest, "POST", base, runnerHeaders)).status, 403); assert.equal((await shared(mia, `/api/team/tasks/${t.id}/instructions/${iid}`, { action: "approve" })).status, 200);
  await open(rita, t.id); assert.equal(await rita.getByRole("region", { name: "Details", exact: true }).locator("select,input,textarea").count(), 0);
});

test("a real fake-agent checkpoint requires a teammate review and self is absent from reviewer pickers", { timeout: 90_000 }, async () => {
  const t = await create("Independent review QA"); await open(ownerPage, t.id); await ownerPage.getByRole("button", { name: "Build with agents", exact: true }).click(); const dialog = ownerPage.getByRole("dialog", { name: "Build with agents", exact: true }); await dialog.getByLabel("Workflow", { exact: true }).selectOption("solo"); await dialog.getByLabel("Agent", { exact: true }).selectOption("claude"); await dialog.getByLabel("Check command", { exact: true }).fill("true"); await dialog.getByRole("button", { name: "Build with agents", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  const completed = await until(() => task(t.id), value => value.checkpoints.some((c: any) => c.bundle === "available") && value.attempts.some((a: any) => a.state === "finished"), "finished fake-agent checkpoint"); const checkpoint = completed.checkpoints.at(-1);
  const reviews = ownerPage.getByRole("region", { name: /^Reviews/ }); await reviews.getByText(/Your own task or checkpoint needs a teammate/).waitFor(); assert.equal(await reviews.getByRole("button", { name: "Record review", exact: true }).count(), 0); await ownerPage.getByRole("combobox", { name: "Request a review from", exact: true }).waitFor(); await ownerPage.getByRole("combobox", { name: "Reviewer", exact: true }).waitFor(); assert.equal(await ownerPage.getByRole("combobox", { name: "Request a review from", exact: true }).locator('option[value="owner"]').count(), 0); assert.equal(await ownerPage.getByRole("combobox", { name: "Reviewer", exact: true }).locator('option[value="owner"]').count(), 0);
  assert.equal((await request(`/api/team/tasks/${t.id}/review-request`, { reviewer: "owner", revision: completed.revision })).status, 400); assert.equal((await request(`/api/team/tasks/${t.id}/reviews`, { checkpointId: checkpoint.id, verdict: "approve", text: "Self", revision: completed.revision })).status, 403); await shot(ownerPage, "06-self-review-excluded");
  await open(rita, t.id); await rita.getByLabel("Review notes", { exact: true }).fill("Independent teammate inspected the checkpoint"); await rita.getByRole("button", { name: "Record review", exact: true }).click(); await until(() => task(t.id), value => value.reviews.some((r: any) => r.by.userId === ids.rita), "independent review"); await rita.getByRole("region", { name: /^Reviews/ }).getByText("Approved", { exact: true }).first().waitFor(); await shot(rita, "07-independent-approval");
  await ownerPage.goto(`${base}/?team=local#/team`); await ownerPage.getByRole("button", { name: "New task", exact: true }).click(); const form = ownerPage.getByRole("form", { name: "New task", exact: true }); await form.waitFor();
  await form.getByRole("combobox", { name: "Reviewer", exact: true }).selectOption("owner"); await form.getByRole("combobox", { name: "Owner", exact: true }).selectOption("owner"); assert.equal(await form.getByRole("combobox", { name: "Reviewer", exact: true }).inputValue(), ""); assert.equal(await form.getByRole("combobox", { name: "Reviewer", exact: true }).locator('option[value="owner"]').count(), 0);
});

test("the decision limit is explained before submission and the API preserves all 100 records", { timeout: 60_000 }, async () => {
  const t = await create("Decision limit QA"); for (let i = 0; i < 100; i++) await api(`/api/team/tasks/${t.id}/decisions`, { text: `Permanent decision ${i}` }); await open(ownerPage, t.id); const section = ownerPage.getByRole("region", { name: /^Decisions/ }); await section.getByText(/permanent; start a follow-up task/).waitFor(); assert.equal(await section.getByRole("button", { name: "Add", exact: true }).count(), 0); const denied = await request(`/api/team/tasks/${t.id}/decisions`, { text: "Overflow" }); assert.equal(denied.status, 400); assert.doesNotMatch(denied.value.error, /remove some/); assert.equal((await task(t.id)).decisions.length, 100); await shot(ownerPage, "08-decision-limit");
});

test("host queue ownership is actionable and repeated started requests return the same job", { timeout: 60_000 }, async () => {
  const settings = await api("/api/host-execution"); await api("/api/host-execution/settings", { revision: settings.revision, policy: { projectId: project, enabled: true, userIds: [ids.alice, ids.mia], agent: "codex", trust: "standard", maxMinutes: 2, maxSteps: 4 } }, "PUT"); const t = await create("Host idempotency QA", ids.alice);
  const denied = await shared(mia, `/api/host-execution/tasks/${t.id}`, { revision: t.revision }); assert.equal(denied.status, 409); assert.match(denied.value.error, /task owner/); assert.doesNotMatch(denied.value.error, /while queued/);
  await open(alice, t.id); await alice.getByRole("button", { name: "Run on team server", exact: true }).click(); const jobs = await until(() => api("/api/host-execution"), value => value.jobs.some((j: any) => j.taskId === t.id && j.state === "running"), "host starts"); const job = jobs.jobs.find((j: any) => j.taskId === t.id), current = await task(t.id);
  for (const revision of [t.revision, current.revision]) { const repeated = await shared(alice, `/api/host-execution/tasks/${t.id}`, { revision }); assert.equal(repeated.status, 202); assert.equal(repeated.value.id, job.id); }
  assert.equal((await task(t.id)).attempts.length, 1); await shot(alice, "09-host-running"); await until(() => api("/api/host-execution"), value => value.jobs.find((j: any) => j.id === job.id)?.state === "finished", "fake host job completes", 45_000);
});

test("a remote pin explains where this computer's host settings live and links back to them", { timeout: 60_000 }, async () => {
  const remote = await server(process.env.QA_PORT ? 4357 : await freePort(), "remote"), rp = (await api("/api/projects", { name: "Remote QA board", repos: [] }, "POST", remote)).id;
  await api("/api/accounts", { revision: (await api("/api/accounts", undefined, "GET", remote)).revision, username: "linked", displayName: "Linked QA", password, roles: { [rp]: "contributor" } }, "POST", remote);
  const linked = await api("/api/team-link/connect", { url: remote, username: "linked", password, name: "QA linked computer" });
  const connections = await api("/api/team-link/connections"), connection = connections.connections.find((c: any) => c.linked && c.url === remote) ?? connections.connections.find((c: any) => c.id !== "local"); assert.ok(connection, JSON.stringify(linked));
  await ownerPage.goto(`${base}/?team=${connection.id}#/settings/connections/manage`); const notice = ownerPage.getByRole("region", { name: "Local host administration", exact: true }); await notice.getByText(/Host execution, the host queue and teammate terminals belong/).waitFor(); await shot(ownerPage, "10-linked-host-explanation"); await notice.getByRole("button", { name: "Manage this computer’s own board", exact: true }).click(); await ownerPage.waitForURL(/team=local/); await ownerPage.getByRole("heading", { name: "Run teammates’ tasks on this computer", exact: true }).waitFor();
});


test("an edit during explicit replacement confirmation is still protected by compare-and-swap", { timeout: 60_000 }, async () => {
  const t = await create("Replacement race QA"); await open(ownerPage, t.id); await ownerPage.locator("#tt-goal").fill("Owner replacement");
  const first = await api(`/api/team/tasks/${t.id}`, { revision: t.revision, goal: "First teammate text" }, "PUT");
  await ownerPage.getByRole("alert").filter({ hasText: "First teammate text" }).getByRole("button", { name: "Replace saved goal", exact: true }).click();
  const dialog = ownerPage.getByRole("dialog", { name: "Replace teammate’s text?", exact: true }); await dialog.waitFor();
  await api(`/api/team/tasks/${t.id}`, { revision: first.revision, goal: "Newer teammate text" }, "PUT");
  await ownerPage.getByRole("alert").filter({ hasText: "Newer teammate text" }).waitFor();
  const refused = ownerPage.waitForResponse(r => r.request().method() === "PUT" && r.url().includes(`/api/team/tasks/${t.id}`));
  await dialog.getByRole("button", { name: "Replace saved text", exact: true }).click(); assert.equal((await refused).status(), 409);
  assert.equal((await task(t.id)).goal, "Newer teammate text"); assert.equal(await ownerPage.locator("#tt-goal").inputValue(), "Owner replacement");
  await ownerPage.getByRole("alert").filter({ hasText: "Newer teammate text" }).waitFor(); await shot(ownerPage, "11-replacement-race");
});
