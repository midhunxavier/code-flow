import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { certificateFixture } from "../remote-tls-fixture.js";

const qaPorts = await reserveQaPorts(4, process.env.CODEFLOW_QA_AUTH_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "codeflow-qa-auth-")), repo = join(scratch, "repo");
const evidence = join(root, "output/playwright/qa-auth-session-accounts");
const ownerPort = qaPorts.port;
const a = { port: ownerPort, token: "qa-auth-owner-a", data: join(scratch, "a"), child: undefined as ChildProcess | undefined };
const b = { port: ownerPort + 2, token: "qa-auth-owner-b", data: join(scratch, "b"), child: undefined as ChildProcess | undefined };
type Instance = typeof a;
const base = (instance = a) => `http://127.0.0.1:${instance.port}`;
const hub = `https://hub.qa.test:${ownerPort + 1}`, password = "fixture shared password long enough";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let browser: Browser, projectId: string, leaverId: string, leaverRunner: string, certPath: string;
const logs: string[] = [], pageErrors: string[] = [], consoleErrors: string[] = [], expectedResponses: string[] = [];
let changingPrincipal = false;
const allowedFailures = new Map<string, number[]>();
function watch(page: Page) {
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const url = message.location().url, text = message.text();
    const expected = allowedFailures.get(url)?.some(status => text.includes(`status of ${status}`)) || changingPrincipal && /\/api\/(?:events|stream|team\/events)/.test(url) && text.includes("net::ERR_INCOMPLETE_CHUNKED_ENCODING");
    (expected ? expectedResponses : consoleErrors).push(`${text} [${url}]`);
  });
}
async function context() { const c = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); await c.route("**/qa-cookie-document", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><link rel="icon" href="data:,"><title>Cookie transport fixture</title>' })); c.on("page", watch); return c; }
async function api(path: string, body?: unknown, method = "POST", instance = a, credentials: Record<string, string> = { authorization: `Bearer ${instance.token}` }) {
  const response = await fetch(base(instance) + path, { method: body === undefined ? "GET" : method, headers: { ...credentials, origin: base(instance), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data, headers: response.headers };
}
async function ok(path: string, body?: unknown, method = "POST", instance = a) { const result = await api(path, body, method, instance); assert.ok(result.status < 300, `${path}: ${result.status} ${JSON.stringify(result.body)}`); return result.body; }
async function start(instance: Instance, fixed = true, agentDelay = "10") {
  await qaPorts.release(instance.port - ownerPort, 1);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  instance.child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, PORT: String(instance.port), CODEFLOW_REMOTE_PORT: String(instance.port + 1), CODEFLOW_HOME: instance.data, CODEFLOW_TOKEN: fixed ? instance.token : "", CODEFLOW_LAN_ALLOW_LOCAL: "1", NODE_EXTRA_CA_CERTS: certPath, SHELL: join(scratch, "bash"), BASH_ENV: "", ENV: "", FAKE_GH_STATE: join(scratch, "gh.json"), FAKE_SLEEP_MS: agentDelay, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [instance.child.stdout, instance.child.stderr]) stream?.on("data", chunk => logs.push(`[${instance.port}] ${chunk}`));
  for (let i = 0; i < 200; i++) { if (await api("/api/auth/self", undefined, "GET", instance, {}).then(r => r.status === 200, () => false)) return; await pause(100); }
  throw new Error(logs.join(""));
}
async function stop(instance: Instance) {
  const child = instance.child; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once("exit", () => resolve())); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); child.kill("SIGTERM"); await done; clearTimeout(timer);
}
async function owner(page: Page, instance = a, hash = "") { await page.goto(`${base(instance)}/?token=${instance.token}${hash}`); await page.getByRole("button", { name: "New run", exact: true }).waitFor(); }
async function self(page: Page, instance = a) { await page.goto(base(instance)); return page.evaluate(async () => (await fetch("/api/auth/self")).json()); }
async function login(page: Page, username = "bob", origin = base()) {
  await page.goto(origin); await page.getByLabel("Username", { exact: true }).fill(username); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("tab", { name: "Board", exact: true }).waitFor();
}
// Cookie transport checks switch principals on a document without background app reads.
async function pagePost(page: Page, path: string, body: unknown) { await page.goto(new URL("/qa-cookie-document", page.url()).href); changingPrincipal = true; const result = await page.evaluate(async ({ path, body }) => { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }, { path, body }); await pause(100); changingPrincipal = false; return result; }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
before(async () => {
  mkdirSync(evidence, { recursive: true }); mkdirSync(repo); mkdirSync(join(repo, ".codeflow"));
  writeFileSync(join(repo, "README.md"), "# Scratch app\n"); writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":false}'); git(repo, "init", "-q", "-b", "main"); git(repo, "add", "."); git(repo, "commit", "-qm", "fixture");
  writeFileSync(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 }); writeFileSync(join(scratch, "gh.json"), '{"issues":[],"prs":{}}');
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const cert = await certificateFixture(scratch, "hub.qa.test"); certPath = cert.certPath;
  await start(a); await start(b); projectId = (await ok("/api/projects", { name: "Auth fixture", repos: [repo] })).id;
  const board = await ok("/api/team/board"); await ok(`/api/team/projects/${projectId}/repositories`, { revision: board.revision, repositories: [{ key: "app", label: "App" }] }, "PUT"); await ok("/api/team-link/mappings", { projectId, repository: "app", path: repo }, "PUT");
  for (const [username, role] of [["bob", "contributor"], ["reviewer", "reviewer"], ["leaver", "contributor"]]) { const state = await ok("/api/accounts"); const next = await ok("/api/accounts", { revision: state.revision, username, displayName: username, password, roles: { [projectId]: role } }); if (username === "leaver") leaverId = next.users.find((u: any) => u.username === username).id; }
  await qaPorts.release(1, 1);
  await ok("/api/remote", { enabled: true, lan: true, transport: "lan" }); await ok("/api/remote/tls", { mode: "import", hostname: "hub.qa.test", cert: cert.cert, key: cert.key });
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--host-resolver-rules=MAP hub.qa.test 127.0.0.1", "--no-proxy-server"] });
});
afterEach(async () => { for (const c of browser?.contexts() ?? []) await c.close(); });
after(async () => { await browser?.close(); await stop(a); await stop(b); writeFileSync(join(evidence, "server.log"), logs.join("")); writeFileSync(join(evidence, "browser.json"), JSON.stringify({ pageErrors, consoleErrors, expectedResponses }, null, 2)); rmSync(scratch, { recursive: true, force: true }); });

test("two local owner cookies survive sign-in, invitations and logout on the other port", async () => {
  const c = await context(), p = await c.newPage(); await owner(p); await owner(p, b);
  let cookies = await c.cookies(); for (const instance of [a, b]) { const cookie = cookies.find(v => v.name === `codeflow_session_${instance.port}`)!; assert.ok(cookie); assert.equal(cookie.sameSite, "Strict"); assert.equal(cookie.httpOnly, true); assert.ok(cookie.expires > Date.now() / 1000 + 29 * 86400); }
  assert.equal((await self(p)).kind, "owner"); assert.equal((await self(p, b)).kind, "owner");
  await p.goto(base()); assert.equal((await pagePost(p, "/api/auth/login", { username: "bob", password })).status, 200); assert.equal((await self(p)).kind, "shared"); assert.equal((await self(p, b)).kind, "owner");
  const invitation = await ok("/api/accounts/invitations", { projectId, role: "viewer" }); await p.goto(base()); assert.equal((await pagePost(p, "/api/auth/invitations/accept", { token: invitation.token, existing: true, username: "bob", password })).status, 200); assert.equal((await self(p, b)).kind, "owner");
  await p.goto(base()); assert.equal((await pagePost(p, "/api/auth/logout", {})).status, 200);
  // Let the signed-out UI settle before its session-change reload can compete with the other port.
  await p.goto(base()); await p.getByRole("heading", { name: "Sign in to shared projects", exact: true }).waitFor();
  assert.equal((await self(p, b)).kind, "owner");
  await c.close(); const legacyContext = await context(), legacyPage = await legacyContext.newPage(); await legacyContext.addCookies([{ name: "codeflow_session", value: b.token, url: base(), httpOnly: true, sameSite: "Strict" }]); await legacyPage.goto(base()); await pagePost(legacyPage, "/api/auth/login", { username: "bob", password });
  assert.equal((await legacyContext.cookies()).find(v => v.name === "codeflow_session")?.value, b.token, "other instance's legacy owner cookie survives");
  await self(legacyPage, b); cookies = await legacyContext.cookies(); assert.equal(cookies.some(v => v.name === "codeflow_session"), false); assert.equal(cookies.find(v => v.name === `codeflow_session_${b.port}`)?.value, b.token);
  const forged = await api("/api/auth/self", undefined, "GET", a, { cookie: `xcodeflow_session_${a.port}=${a.token}; codeflow_session_${a.port}_shadow=${a.token}` }); assert.notEqual(forged.body.kind, "owner");
  await legacyContext.close();
});

test("stale browser links render protected HTML and the local-only handoff handles a real cross-site hop", async () => {
  const c = await context(), p = await c.newPage(); const bad = base() + "/?token=expired"; allowedFailures.set(bad, [403]);
  const denied = await p.goto(bad); assert.equal(denied!.status(), 403); assert.match(denied!.headers()["content-type"]!, /text\/html/); assert.equal(denied!.headers()["x-frame-options"], "DENY"); assert.match(denied!.headers()["cache-control"]!, /no-store/); assert.equal(denied!.headers()["referrer-policy"], "no-referrer"); await p.getByRole("heading", { name: /expired|stale|no longer/i }).waitFor();
  const remote = await ok("/api/remote"); assert.equal(remote.secure, true); assert.equal(remote.lanError, undefined); assert.ok(remote.lanUrls.some((url: string) => url.startsWith(hub + "/")), JSON.stringify(remote));
  await owner(p, b); await login(p, "bob", hub); await p.goto(`${hub}/#/team/project/${projectId}`); await p.getByRole("button", { name: "Set up this computer for coding", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Connect this computer", exact: true }); await dialog.getByLabel("Local Code Flow address", { exact: true }).fill(base(b));
  const navigations: string[] = []; p.on("framenavigated", frame => { if (frame === p.mainFrame()) navigations.push(frame.url()); });
  await dialog.getByRole("button", { name: "Open local Code Flow", exact: true }).click(); await p.getByRole("button", { name: "Connect this computer", exact: true }).waitFor();
  assert.equal(new URL(p.url()).origin, base(b)); assert.equal(new URL(p.url()).pathname, "/"); assert.match(p.url(), /team=local/); assert.equal(await p.getByLabel("Username", { exact: true }).inputValue(), "bob"); assert.match(await p.getByLabel("Team server URL", { exact: true }).inputValue(), /hub\.qa\.test/);
  assert.ok(navigations.some(url => url.includes("/team-handoff#"))); await p.screenshot({ path: join(evidence, "cross-site-handoff.png"), fullPage: true });
  await p.goto(base(b) + "/?token=old"); assert.equal(new URL(p.url()).search, ""); assert.equal((await self(p, b)).kind, "owner");
  allowedFailures.set(hub + "/team-handoff", [404]); await p.goto(hub); const network = await p.evaluate(async () => (await fetch("/team-handoff")).status); assert.equal(network, 404);
  allowedFailures.set(hub + "/?token=old", [403]); const phone = await p.goto(hub + "/?token=old"); assert.equal(phone!.status(), 403); await p.getByRole("heading", { name: "Scan the QR code again", exact: true }).waitFor();
  const invalidApi = await fetch(base() + "/api/accounts?token=old"); assert.equal(invalidApi.status, 401); assert.match(invalidApi.headers.get("content-type")!, /application\/json/);
  await p.goto(base(b) + "/team-handoff?redirect=https://evil.test/#/wrong"); await pause(100); assert.equal(new URL(p.url()).pathname, "/team-handoff");
  const csrf = await fetch(base(b) + "/api/auth/login", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password }) }); assert.equal(csrf.status, 403);
  await c.close();
});

test("a no-op invitation preserves another device's session and explains existing access", async () => {
  const c = await context(), p = await c.newPage(), other = await context(), second = await other.newPage(); await login(p); await login(second);
  const previous = await second.evaluate(async () => (await fetch("/api/auth/self")).json());
  const access = await ok("/api/team-terminals"); await ok("/api/team-terminals/settings", { revision: access.revision, grant: { projectId, enabled: true, userIds: [previous.userId] } }, "PUT"); await second.goto(`${base()}/#/team/project/${projectId}`); await second.getByRole("button", { name: "Open terminal", exact: true }).click(); await second.locator(".team-terminal-screen .xterm-helper-textarea").waitFor(); const terminal = (await ok("/api/team-terminals")).sessions[0]; assert.ok(terminal);
  const invitation = await ok("/api/accounts/invitations", { projectId, role: "viewer" }); await p.goto(`${base()}/#/join/${invitation.token}`); await p.getByLabel("Account option").selectOption("existing"); await p.getByLabel("Username", { exact: true }).fill("bob"); await p.getByLabel("Password", { exact: true }).fill(password); await p.getByRole("button", { name: "Join project", exact: true }).click();
  await p.getByText(/You already have Contributor access/).waitFor(); assert.equal((await self(second)).kind, "shared"); const next = await second.evaluate(async () => (await fetch("/api/auth/self")).json()); assert.equal(next.userId, previous.userId); assert.equal(next.revision, previous.revision); assert.ok((await ok("/api/team-terminals")).sessions.some((s: any) => s.id === terminal.id)); assert.equal((await pagePost(second, `/api/team-terminals/${terminal.id}/input`, { data: "printf NOOP_INVITE_SESSION_OK\r" })).status, 200);
  await p.screenshot({ path: join(evidence, "already-joined.png"), fullPage: true }); await c.close(); await other.close(); await ok(`/api/team-terminals/${terminal.id}`, {}, "DELETE");
});

test("uncommitted solo results explain blocked review until the owner commits", async () => {
  const made = await ok("/api/runs", { repo, project: projectId, pattern: "solo", checkpointOnFinish: false, task: "QA uncommitted result", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } }); let run: any;
  for (let i = 0; i < 300; i++) { run = await ok(`/api/runs/${made.id}`); if (run.status !== "running") break; await pause(100); } assert.equal(run.status, "done", run.error); assert.ok(run.worktrees.length);
  const tree = run.worktrees[0], coverage = await ok(`/api/runs/${run.id}/review-coverage?branch=${encodeURIComponent(tree.branch)}`); assert.equal(coverage.workingChanges, true);
  const c = await context(), p = await c.newPage(); await login(p, "reviewer"); await p.getByRole("tab", { name: "Results", exact: true }).click(); await p.getByRole("button", { name: /QA uncommitted result/ }).click(); await p.getByText(/These are uncommitted working changes/).waitFor(); assert.equal(await p.getByRole("checkbox", { name: /^Reviewed / }).count(), 0); assert.equal(await p.getByLabel("Comment on this result commit", { exact: true }).count(), 0); await p.screenshot({ path: join(evidence, "uncommitted-review.png"), fullPage: true });
  const files = (await ok(`/api/runs/${run.id}/diff?branch=${encodeURIComponent(tree.branch)}`)).map((file: any) => file.path); assert.ok(files.length); assert.equal((await api(`/api/runs/${run.id}/review-coverage`, { branch: tree.branch, expectedHead: coverage.head, path: files[0], reviewed: true })).status, 409);
  git(tree.path, "add", "."); git(tree.path, "commit", "-qm", "Owner commits reviewable result"); await p.getByRole("button", { name: "Refresh result evidence", exact: true }).click(); const reviewed = p.getByRole("checkbox", { name: `Reviewed ${files[0]}`, exact: true }); await reviewed.waitFor(); await reviewed.check(); await p.getByText(/1 of .* visible files reviewed/).waitFor(); await p.getByLabel("Comment on this result commit", { exact: true }).fill("Reviewed after owner commit"); await p.getByRole("button", { name: "Record human comment", exact: true }).click(); await p.getByText("Reviewed after owner commit", { exact: true }).waitFor(); await c.close();
});

test("owner deletes a disabled account, revoking runners and all execution grants with CAS", async () => {
  await stop(a); await start(a, true, "30000");
  const login = await api("/api/auth/login", { username: "leaver", password }, "POST", a, {}), cookie = login.headers.getSetCookie().find(v => v.startsWith("codeflow_shared_"))!.split(";")[0]!;
  const linked = await api("/api/team/runners/connect", { username: "leaver", password, name: "Scratch leaver runner" }, "POST", a, {}); assert.equal(linked.status, 201); leaverRunner = linked.body.token;
  let state = await ok("/api/team-terminals"); await ok("/api/team-terminals/settings", { revision: state.revision, grant: { projectId, enabled: true, userIds: [leaverId] } }, "PUT");
  state = await ok("/api/host-execution"); await ok("/api/host-execution/settings", { revision: state.revision, policy: { projectId, enabled: true, userIds: [leaverId], agent: "claude", trust: "safe", maxMinutes: 5, maxSteps: 5 } }, "PUT");
  const shell = await api("/api/team-terminals", { projectId, repository: "app", cols: 80, rows: 24 }, "POST", a, { cookie }); assert.equal(shell.status, 201);
  const tasks = []; for (const title of ["Delete active account work", "Delete queued account work"]) { const task = await ok("/api/team/tasks", { projectId, repository: "app", title, goal: "Scratch task", owner: leaverId }); tasks.push(task); assert.equal((await api(`/api/host-execution/tasks/${task.id}`, { revision: task.revision }, "POST", a, { cookie })).status, 202); }
  let jobs: any[] = []; for (let i = 0; i < 150; i++) { jobs = (await ok("/api/host-execution")).jobs; if (jobs.some(j => j.state === "running") && jobs.some(j => j.state === "queued")) break; await pause(100); } assert.ok(jobs.some(j => j.state === "running")); assert.ok(jobs.some(j => j.state === "queued"));
  state = await ok("/api/accounts"); assert.equal((await api(`/api/accounts/${leaverId}`, { revision: state.revision }, "DELETE")).status, 409);
  for (const credentials of [{ cookie }, { authorization: `Bearer ${leaverRunner}` }, {}] as Array<Record<string, string>>) assert.ok([401, 403].includes((await api(`/api/accounts/${leaverId}`, { revision: state.revision }, "DELETE", a, credentials)).status));
  const c = await context(), p = await c.newPage(); await owner(p, a, "#/settings/connections/manage"); const panel = p.getByRole("region", { name: "Shared project accounts", exact: true }); await panel.getByLabel("Account", { exact: true }).selectOption(leaverId); assert.equal(await panel.getByRole("button", { name: "Delete account", exact: true }).isEnabled(), false); await panel.getByRole("checkbox", { name: "Account enabled", exact: true }).uncheck(); await panel.getByRole("button", { name: "Save account changes", exact: true }).click(); await panel.getByText(/Account saved/).waitFor();
  assert.equal((await api(`/api/accounts/${leaverId}`, { revision: state.revision }, "DELETE")).status, 409);
  await panel.getByRole("button", { name: "Delete account", exact: true }).click(); await p.getByRole("dialog", { name: "Delete shared account?", exact: true }).getByRole("button", { name: "Delete account", exact: true }).click(); await panel.getByText(/Account deleted/).waitFor();
  for (let i = 0; i < 150; i++) { jobs = (await ok("/api/host-execution")).jobs; if (jobs.every(j => ["cancelled", "failed", "interrupted"].includes(j.state))) break; await pause(100); } assert.ok(jobs.every(j => ["cancelled", "failed", "interrupted"].includes(j.state))); assert.ok(jobs.every(j => j.userId === leaverId)); assert.equal((await ok("/api/team-terminals")).sessions.length, 0); assert.equal((await ok(`/api/team/tasks/${tasks[0].id}`)).owner.userId, leaverId);
  assert.equal((await ok("/api/accounts")).users.some((u: any) => u.id === leaverId), false); assert.ok((await ok("/api/team/runners")).find((r: any) => r.id === linked.body.runner.id).revokedAt);
  assert.equal(JSON.stringify((await ok("/api/team-terminals")).grants).includes(leaverId), false); assert.equal(JSON.stringify((await ok("/api/host-execution")).policies).includes(leaverId), false);
  assert.equal((await api("/api/team/board", undefined, "GET", a, { authorization: `Bearer ${leaverRunner}` })).status, 401); assert.notEqual((await api("/api/auth/self", undefined, "GET", a, { cookie })).body.kind, "shared");
  state = await ok("/api/accounts"); const next = await ok("/api/accounts", { revision: state.revision, username: "leaver", displayName: "Replacement", password, roles: {} }); assert.notEqual(next.users.find((u: any) => u.username === "leaver").id, leaverId); await p.screenshot({ path: join(evidence, "account-deleted.png"), fullPage: true }); await c.close();
});

test("fixed-token owner sessions survive browser and server restart; random-token sessions stay transient", async () => {
  const profile = join(scratch, "profile"); let c = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true }); c.on("page", watch); let p = await c.newPage(); await owner(p, b); await p.goto("about:blank"); await c.close();
  await stop(b); await start(b); c = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true }); c.on("page", watch); p = await c.newPage(); assert.equal((await self(p, b)).kind, "owner"); await p.goto("about:blank"); await c.close();
  await stop(b); await start(b, false); const transient = await context(), q = await transient.newPage(); await q.goto(base(b)); const cookie = (await transient.cookies()).find(v => v.name === `codeflow_session_${b.port}`); assert.equal(cookie?.expires, -1); await transient.close();
});

test("corrupt account storage fails closed, gives generic visitor errors and owner-only repair detail", async () => {
  await stop(a); const file = join(a.data, "shared-accounts.json"), saved = readFileSync(file, "utf8"), broken = JSON.parse(saved); assert.ok(broken.sessions.length); broken.sessions[0].lastSeenAt = broken.sessions[0].createdAt - 1; const raw = JSON.stringify(broken); writeFileSync(file, raw); await start(a);
  const c = await context(), p = await c.newPage(); allowedFailures.set(base() + "/", [503]); const response = await p.goto(base()); assert.equal(response!.status(), 503); await p.getByRole("heading", { name: /temporarily unavailable/i }).waitFor(); assert.equal((await p.locator("body").innerText()).includes(a.data), false);
  for (const [path, body, credentials] of [["/api/auth/login", { username: "bob", password }, {}], ["/api/team/runners/connect", { username: "bob", password, name: "Retry" }, {}], ["/api/team/board", undefined, { authorization: `Bearer ${leaverRunner}` }]] as const) { const r = await api(path, body, "POST", a, credentials); assert.equal(r.status, 503); assert.match(r.body.error, /temporarily unavailable/); assert.equal(JSON.stringify(r.body).includes(a.data), false); }
  allowedFailures.set(base() + "/api/accounts", [503]); await owner(p, a, "#/settings/connections/manage"); const panel = p.getByRole("region", { name: "Shared project accounts", exact: true }); await panel.getByRole("alert").filter({ hasText: "Invalid shared account session" }).waitFor(); assert.ok((await panel.innerText()).includes(file)); assert.equal(await panel.getByLabel("Account username", { exact: true }).count(), 0); assert.equal((await panel.innerText()).includes("draft has been kept"), false); assert.equal(readFileSync(file, "utf8"), raw); await panel.scrollIntoViewIfNeeded(); await p.screenshot({ path: join(evidence, "storage-recovery.png"), fullPage: true }); await c.close();
  await stop(a); writeFileSync(file, saved); await start(a); assert.equal((await api("/api/auth/login", { username: "bob", password }, "POST", a, {})).status, 200);
});
test("all browser application and console errors are accounted for", () => { assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); });
