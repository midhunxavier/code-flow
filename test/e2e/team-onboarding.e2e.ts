import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
import { certificateFixture } from "../remote-tls-fixture.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "codeflow-join-e2e-")), repo = join(directory, "repo");
const freePort = () => new Promise<number>(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
const port = await freePort(), remotePort = await freePort(), runnerPort = await freePort();
const base = `http://127.0.0.1:${port}`, remote = `https://localhost:${remotePort}`, runnerBase = `http://127.0.0.1:${runnerPort}`;
const token = "onboarding-owner-fixture", password = "a teammate chooses this password";
const servers: ChildProcess[] = [], errors: string[] = [];
let browser: Browser, owner: Page, member: Page, runner: Page, projectId: string, privateProject: string, connection: string, inviteLink: string;
const request = async (path: string, body?: object, method = "POST", origin = base) => {
  const response = await fetch(origin + path, { method: body ? method : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`); return data;
};
async function start(localPort: number, networkPort: number, home: string, cert: string) {
  await mkdir(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {}; for (const [key, value] of Object.entries(process.env)) if (!/^(?:CODEFLOW_|FAKE_)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, SHELL: "/bin/sh", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(localPort), CODEFLOW_REMOTE_PORT: String(networkPort), CODEFLOW_LAN_ALLOW_LOCAL: "1", NODE_EXTRA_CA_CERTS: cert });
  const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); servers.push(server);
  let log = ""; for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { log = (log + chunk).slice(-12000); });
  for (let i = 0; i < 200; i++) { if (await fetch(`http://127.0.0.1:${localPort}/api/health`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.ok, () => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(log);
}
async function audit(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open]")].every(dialog => getComputedStyle(dialog).opacity === "1"));
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
  if (result.violations.length) await page.screenshot({ path: join(root, "output/playwright/sharing-audit-failure.png"), fullPage: true });
  assert.deepEqual(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page fits the viewport");
}
before(async () => {
  await mkdir(repo); await writeFile(join(repo, "README.md"), "# Team fixture\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo }); git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "initial");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const cert = await certificateFixture(directory);
  await start(port, remotePort, join(directory, "hub"), cert.certPath); await start(runnerPort, await freePort(), join(directory, "runner"), cert.certPath);
  projectId = (await request("/api/projects", { name: "Shared app", repos: [repo] })).id;
  privateProject = (await request("/api/projects", { name: "Private project", repos: [] })).id;
  const board = await request("/api/team/board");
  await request(`/api/team/projects/${projectId}/repositories`, { revision: board.revision, repositories: [{ key: "app", label: "Application", defaultBranch: "main" }] }, "PUT");
  await request("/api/remote", { enabled: true, lan: true, transport: "lan" });
  await request("/api/remote/tls", { mode: "import", hostname: "localhost", cert: cert.cert, key: cert.key });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const [name, size] of [["owner", { width: 1440, height: 1000 }], ["member", { width: 390, height: 844 }], ["runner", { width: 1440, height: 1000 }]] as const) {
    const context = await browser.newContext({ viewport: size, ignoreHTTPSErrors: true }); const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(`${name}: ${error.message}`));
    if (name === "owner") owner = page; else if (name === "member") member = page; else runner = page;
  }
  await owner.goto(`${base}/?token=${token}`); await owner.getByRole("button", { name: "New run", exact: true }).waitFor();
});
after(async () => { await browser?.close(); for (const child of servers) child.kill("SIGTERM"); await Promise.all(servers.map(child => new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }))); await rm(directory, { recursive: true, force: true }); });

test("purpose-first sharing separates devices, joining and hosting, including phone layout", async () => {
  await owner.goto(`${base}/#/settings/connections/sharing`);
  await owner.getByRole("navigation", { name: "Share access options" }).waitFor();
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await owner.screenshot({ path: join(root, "output/playwright/team-connections.png"), fullPage: true });
  await audit(owner); await owner.setViewportSize({ width: 390, height: 844 }); await audit(owner);
  await owner.getByRole("link", { name: /^Connect my devices/ }).click(); await owner.getByRole("heading", { name: "Remote access", exact: true }).waitFor();
  await owner.getByRole("link", { name: /^Join a team Open/ }).click(); await owner.getByRole("button", { name: "Connect this computer", exact: true }).waitFor();
  assert.equal(await owner.getByRole("checkbox", { name: "Full control from remote devices" }).count(), 0);
  await owner.setViewportSize({ width: 1440, height: 1000 });
});

test("owner invites one project; a phone recipient chooses a password and reaches the shared board", async () => {
  await owner.goto(`${base}/?team=local#/project/${projectId}`);
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const share = owner.getByRole("dialog", { name: "Share Shared app", exact: true });
  const invites = share.getByRole("region", { name: "Project invitations" });
  assert.equal(await share.getByLabel("Account", { exact: true }).count(), 0);
  await audit(owner);
  await owner.screenshot({ path: join(root, "output/playwright/project-share.png"), fullPage: true });
  await invites.getByRole("button", { name: "Create invitation", exact: true }).click();
  inviteLink = await invites.getByLabel("Invitation link", { exact: true }).inputValue();
  assert.ok(inviteLink.startsWith(`${remote}/#/join/`)); assert.ok(!inviteLink.includes("/r/"));
  await member.goto(inviteLink); await member.getByRole("heading", { name: "Join Shared app", exact: true }).waitFor();
  await member.screenshot({ path: join(root, "output/playwright/team-join-mobile.png"), fullPage: true });
  await audit(member);
  await member.getByLabel("Your name", { exact: true }).fill("Alice"); await member.getByLabel("Username", { exact: true }).fill("alice"); await member.getByLabel("Password", { exact: true }).fill(password);
  await member.getByRole("button", { name: "Join project", exact: true }).click(); await member.getByText("You’re in Shared app", { exact: true }).waitFor();
  assert.ok(!member.url().includes("/join/"), "accepted secret leaves the address bar");
  await audit(member); await member.getByRole("heading", { name: "Your board is ready for its first task", exact: true }).waitFor();
  const visible = await member.evaluate(async () => (await fetch("/api/projects")).json()); assert.deepEqual(visible.map((entry: { id: string }) => entry.id), [projectId]);
  for (const path of ["/api/accounts/invitations", "/api/remote", `/api/team/board?project=${privateProject}`]) {
    const status = await member.evaluate(async path => (await fetch(path)).status, path); assert.ok([403, 404].includes(status), `${path} cannot expose owner/private data`);
  }
});

test("joined teammate connects a separate CodeFlow computer, maps a repository and collaborates", async () => {
  await member.getByRole("button", { name: "Set up this computer for coding", exact: true }).click();
  const setup = member.getByRole("dialog", { name: "Connect this computer", exact: true });
  await setup.waitFor();
  await audit(member);
  await setup.getByLabel("Local Code Flow address", { exact: true }).fill(runnerBase);
  await setup.getByRole("button", { name: "Open local Code Flow", exact: true }).click();
  await member.waitForURL(url => url.origin === runnerBase);
  const handoff = new URL(member.url());
  connection = new URLSearchParams(handoff.hash.split("?")[1]).get("connection")!;
  assert.ok(connection.includes(encodeURIComponent(projectId)));
  assert.ok(!connection.includes(password));
  await runner.goto(`${runnerBase}/?token=${token}` + handoff.hash);
  await member.goto(`${remote}/#/team/project/${projectId}`);
  assert.equal(await runner.getByLabel("Team server URL", { exact: true }).inputValue(), connection);
  assert.equal(await runner.getByLabel("Username", { exact: true }).inputValue(), "alice");
  await runner.getByLabel("Password", { exact: true }).fill(password); await runner.getByLabel("Machine name", { exact: true }).fill("Alice laptop");
  await runner.getByRole("button", { name: "Connect this computer", exact: true }).click();
  await runner.getByRole("heading", { name: "Your team projects", exact: true }).waitFor();
  const mapping = runner.locator(".team-mapping").filter({ hasText: "Application" });
  await mapping.locator("input").fill(repo); await mapping.getByRole("button", { name: "Save", exact: true }).click();
  await runner.getByText("Contributor · Repository selected", { exact: true }).waitFor();
  await runner.getByRole("link", { name: "Open project board", exact: true }).click(); await runner.getByRole("button", { name: "New task", exact: true }).click();
  const form = runner.getByRole("form", { name: "New task", exact: true });
  await form.getByLabel("Title", { exact: true }).fill("Our first shared task"); await form.getByLabel("Goal", { exact: true }).fill("Improve our greeting"); await form.getByLabel("Acceptance criteria", { exact: true }).fill("The greeting is clear"); await form.getByRole("button", { name: "Create task", exact: true }).click();
  await runner.getByRole("button", { name: /Our first shared task/ }).click();
  await runner.getByLabel("Comment", { exact: true }).fill("I am connected from my laptop."); await runner.getByRole("button", { name: "Post comment", exact: true }).click();
  const taskHash = new URL(runner.url()).hash; await member.goto(remote + "/" + taskHash);
  await member.locator(".team-comment-text").filter({ hasText: "I am connected from my laptop." }).waitFor();
  assert.equal(await member.getByRole("button", { name: "Build with agents", exact: true }).count(), 0, "browser membership does not grant host execution");
  await runner.getByRole("button", { name: "Take this task", exact: true }).click();
  await runner.getByRole("button", { name: "Build with agents", exact: true }).click();
  const build = runner.getByRole("dialog", { name: "Build with agents", exact: true });
  await build.getByLabel("Workflow", { exact: true }).selectOption("solo"); await build.getByLabel("Agent", { exact: true }).selectOption("claude");
  await build.getByLabel("Check command").fill("true");
  await build.getByRole("button", { name: "Build with agents", exact: true }).click(); await build.waitFor({ state: "hidden" });
  await runner.getByRole("link", { name: "Open run", exact: true }).waitFor();
  const taskId = taskHash.split("/").at(-1);
  let task: { attempts: { endedAt?: number; runId?: string }[] } | undefined;
  for (let i = 0; i < 150; i++) { task = await request(`/api/team/tasks/${taskId}`); if (task?.attempts[0]?.endedAt) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.ok(task); assert.equal(task.attempts.length, 1); const attempt = task.attempts[0]!; assert.ok(attempt.endedAt, "the connected computer publishes its completed attempt");
  const runnerRuns = await request("/api/runs", undefined, "GET", runnerBase); assert.ok(runnerRuns.some((run: { id: string }) => run.id === attempt.runId), "execution lives on the teammate computer");
  await owner.getByRole("button", { name: "Done", exact: true }).click();
  await owner.goto(`${base}/?team=local#/project/${projectId}/people`);
  const alice = owner.getByRole("row").filter({ hasText: "Alice" });
  await alice.getByText("1 computer connected", { exact: true }).waitFor();
  await alice.getByRole("button", { name: "Alice", exact: true }).click();
  await alice.getByText("Team server execution not granted", { exact: true }).waitFor();
  await alice.getByText("Alice laptop", { exact: false }).waitFor();
  assert.equal(await owner.getByLabel("Initial password", { exact: true }).isVisible().catch(() => false), false);
  await owner.screenshot({ path: join(root, "output/playwright/project-people.png"), fullPage: true });
  await audit(owner);
  assert.deepEqual(errors, []);
});

test("used and revoked links recover clearly; anonymous and member callers cannot issue invitations", async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const stranger = await context.newPage();
  await stranger.goto(inviteLink); await stranger.getByRole("alert").filter({ hasText: "expired, was used, or was revoked" }).waitFor();
  assert.equal(await stranger.getByRole("button", { name: "Join project", exact: true }).count(), 0);
  const denied = await stranger.evaluate(async projectId => (await fetch("/api/accounts/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, role: "maintainer" }) })).status, projectId); assert.ok([401, 404].includes(denied));
  const memberDenied = await member.evaluate(async projectId => (await fetch("/api/accounts/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, role: "maintainer" }) })).status, projectId); assert.equal(memberDenied, 403);
  for (const [method, path] of [["GET", "/api/integration-connections"], ["POST", "/api/integration-connections/test"], ["POST", "/api/integration-connections/connect"], ["GET", `/api/integration-connections/projects/${projectId}`], ["DELETE", "/api/integration-connections/any"]]) {
    const status = await member.evaluate(async ({ method, path }) => (await fetch(path, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) })).status, { method: method!, path: path! });
    assert.equal(status, 403, `shared members cannot manage owner credentials: ${method} ${path}`);
  }
  const created = await request("/api/accounts/invitations", { projectId, role: "reviewer" });
  const revoke = await fetch(`${base}/api/accounts/invitations/${created.invitation.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }); assert.equal(revoke.status, 200);
  await stranger.goto(`${remote}/#/join/${created.token}`); await stranger.getByRole("alert").filter({ hasText: "revoked" }).waitFor();
  const plaintext = await fetch(`${base}/api/auth/invitations/preview`, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-forwarded-for": "192.0.2.1" }, body: JSON.stringify({ token: created.token }) }); assert.equal(plaintext.status, 403);
  await context.close(); assert.deepEqual(errors, []);
});

test("People revokes only the selected pending invitation, refreshes both lists, and keeps failed requests retryable", async () => {
  const keep = await request("/api/accounts/invitations", { projectId, role: "viewer" });
  await owner.goto(`${base}/?team=local#/project/${projectId}/people`);
  const invites = owner.getByRole("region", { name: "Project invitations" });
  await invites.getByLabel("Invitation role", { exact: true }).selectOption("reviewer");
  await invites.getByRole("button", { name: "Create invitation", exact: true }).click();
  const link = await invites.getByLabel("Invitation link", { exact: true }).inputValue();
  const pending = (await request("/api/accounts/invitations")).invitations.filter((invite: { projectId: string; role: string; acceptedAt?: number; revokedAt?: number }) => invite.projectId === projectId && invite.role === "reviewer" && !invite.acceptedAt && !invite.revokedAt);
  assert.equal(pending.length, 1);
  const id = pending[0].id;
  const row = owner.getByRole("row").filter({ hasText: "Invitation pending" }).filter({ has: owner.getByRole("cell", { name: "Reviewer", exact: true }) });
  const revoke = row.getByRole("button", { name: "Revoke invitation", exact: true });
  await revoke.waitFor();
  assert.equal(await owner.getByRole("row").filter({ hasText: "Alice" }).getByRole("button", { name: "Revoke invitation", exact: true }).count(), 0, "joined members are not invitation targets");
  await owner.setViewportSize({ width: 884, height: 785 }); await audit(owner);
  await owner.screenshot({ path: join(root, "output/playwright/people-revoke.png"), fullPage: true });
  await owner.setViewportSize({ width: 390, height: 844 }); await audit(owner);
  await owner.screenshot({ path: join(root, "output/playwright/people-revoke-mobile.png"), fullPage: true });

  const endpoint = new RegExp(`/api/accounts/invitations/${id}(?:\\?|$)`);
  await owner.route(endpoint, route => route.request().method() === "DELETE" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) }) : route.continue());
  await revoke.click();
  await owner.getByRole("alert").filter({ hasText: "Could not revoke invitation: Temporarily unavailable" }).waitFor();
  assert.equal(await revoke.isEnabled(), true, "a failed revoke can be retried");
  assert.equal((await request("/api/accounts/invitations")).invitations.find((invite: { id: string }) => invite.id === id).revokedAt, undefined);
  await owner.unroute(endpoint);

  await revoke.click(); await row.waitFor({ state: "hidden" });
  await invites.getByLabel("Invitation link", { exact: true }).waitFor({ state: "hidden" });
  await invites.getByText("Pending invitations (1)", { exact: true }).waitFor();
  const remaining = (await request("/api/accounts/invitations")).invitations;
  assert.ok(remaining.find((invite: { id: string }) => invite.id === id).revokedAt);
  assert.equal(remaining.find((invite: { id: string }) => invite.id === keep.invitation.id).revokedAt, undefined, "the other link remains usable");
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const recipient = await context.newPage();
  await recipient.goto(link); await recipient.getByRole("alert").filter({ hasText: "revoked" }).waitFor();
  assert.equal(await recipient.getByRole("button", { name: "Join project", exact: true }).count(), 0);
  await context.close();
  await owner.getByRole("row").filter({ hasText: "Invitation pending" }).getByRole("button", { name: "Revoke invitation", exact: true }).click();
  await owner.getByText("Invitation pending", { exact: true }).waitFor({ state: "hidden" });
  await owner.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(errors, []);
});


test("an existing account joins a second project without sharing passwords or losing its first membership", async () => {
  const invite = await request("/api/accounts/invitations", { projectId: privateProject, role: "reviewer" });
  await member.goto(`${remote}/#/join/${invite.token}`); await member.getByLabel("Account option").selectOption("existing");
  await member.getByLabel("Username", { exact: true }).fill("alice"); await member.getByLabel("Password", { exact: true }).fill(password);
  await member.getByRole("button", { name: "Join project", exact: true }).click(); await member.getByText("You’re in Private project", { exact: true }).waitFor();
  assert.equal(await member.getByRole("button", { name: "Set up this computer for coding", exact: true }).count(), 0, "review-only project does not suggest running tasks");
  await member.getByText(/No computer setup needed/).waitFor();
  const identity = await member.evaluate(async () => (await fetch("/api/auth/self")).json());
  assert.deepEqual(identity.roles, { [projectId]: "contributor", [privateProject]: "reviewer" });
  assert.deepEqual(errors, []);
});


test("a reviewer joins and is ready without registering a computer; owner sees pending and joined states", async () => {
  const invites = owner.getByRole("region", { name: "Project invitations" });
  await invites.getByLabel("Invitation role", { exact: true }).selectOption("reviewer");
  await invites.getByRole("button", { name: "Create invitation", exact: true }).click();
  const link = await invites.getByLabel("Invitation link", { exact: true }).inputValue();
  await owner.reload();
  await owner.getByText("Invitation pending", { exact: true }).waitFor();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const reviewer = await context.newPage();
  await reviewer.goto(link);
  await reviewer.getByLabel("Your name", { exact: true }).fill("Sam");
  await reviewer.getByLabel("Username", { exact: true }).fill("sam");
  await reviewer.getByLabel("Password", { exact: true }).fill(password);
  await reviewer.getByRole("button", { name: "Join project", exact: true }).click();
  await reviewer.getByText("You’re in Shared app", { exact: true }).waitFor();
  assert.equal(await reviewer.getByRole("button", { name: "Set up this computer for coding", exact: true }).count(), 0);
  await reviewer.getByRole("button", { name: "People", exact: true }).click();
  await reviewer.getByRole("row").filter({ hasText: "Sam" }).getByText("Ready to review", { exact: true }).waitFor();
  await audit(reviewer);
  await owner.reload();
  await owner.getByRole("row").filter({ hasText: "Sam" }).getByText("Ready to review", { exact: true }).waitFor();
  assert.equal(await owner.getByText("Invitation pending", { exact: true }).count(), 0);
  await context.close();
  assert.deepEqual(errors, []);
});


test("Share completes only missing secure access and returns to the selected invitation role", async () => {
  await request("/api/remote", { enabled: false, lan: false });
  await owner.goto(`${base}/?team=local#/project/${privateProject}`);
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const share = owner.getByRole("dialog", { name: "Share Private project", exact: true });
  await share.getByLabel("Invitation role", { exact: true }).selectOption("reviewer");
  await share.getByRole("button", { name: "Set up secure access", exact: true }).click();
  assert.equal(await share.getByLabel("Project name", { exact: true }).count(), 0);
  await share.getByLabel("Connection method", { exact: true }).selectOption("lan");
  await share.getByRole("button", { name: "Enable team access", exact: true }).click();
  await share.getByRole("button", { name: "Create invitation", exact: true }).click();
  assert.equal(await share.getByLabel("Invitation role", { exact: true }).inputValue(), "reviewer");
  const link = await share.getByLabel("Invitation link", { exact: true }).inputValue();
  assert.ok(link.startsWith(remote));
  await owner.setViewportSize({ width: 390, height: 844 });
  await audit(owner);
  await owner.screenshot({ path: join(root, "output/playwright/project-share-mobile.png"), fullPage: true });
  await owner.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(errors, []);
});


test("first project sharing detects repository names without publishing local paths or granting server execution", async () => {
  const created = await request("/api/projects", { name: "Detected repository", repos: [repo] });
  await owner.goto(`${base}/?team=local#/project/${created.id}`);
  await owner.reload();
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const share = owner.getByRole("dialog", { name: "Share Detected repository", exact: true });
  await share.getByRole("button", { name: "Create invitation", exact: true }).click();
  await share.getByLabel("Invitation link", { exact: true }).waitFor();
  const b = await request("/api/team/board");
  assert.deepEqual(b.projects.find((p: { id: string }) => p.id === created.id).repositories, [{ key: "repo", label: "repo" }]);
  assert.ok(!JSON.stringify(b).includes(repo), "shared board never exposes source folders");
  const queue = await request("/api/host-execution");
  assert.equal(queue.policies.some((p: { projectId: string; enabled: boolean }) => p.projectId === created.id && p.enabled), false);
  await share.getByRole("button", { name: "Done", exact: true }).click();
  await owner.goto(`${base}/?team=local#/project/${projectId}`);
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Create invitation", exact: true }).click();
  await owner.getByRole("dialog").getByLabel("Invitation link", { exact: true }).waitFor();
  const existing = await request("/api/team/board");
  assert.deepEqual(existing.projects.find((p: { id: string }) => p.id === projectId).repositories, [{ key: "app", label: "Application", defaultBranch: "main" }]);
});

test("an unreachable server explains recovery and preserves existing computer connections", async () => {
  await runner.goto(`${runnerBase}/#/settings/connections/join`);
  await runner.getByRole("button", { name: "Add team connection", exact: true }).click();
  await runner.getByLabel("Team server URL", { exact: true }).fill(`http://127.0.0.1:${await freePort()}`);
  await runner.getByLabel("Username", { exact: true }).fill("alice");
  await runner.getByLabel("Password", { exact: true }).fill(password);
  await runner.getByRole("button", { name: "Connect this computer", exact: true }).click();
  await runner.getByRole("alert").waitFor();
  await runner.getByText(/If the server cannot be reached, start it/).waitFor();
  const links = await request("/api/team-link/connections", undefined, "GET", runnerBase);
  assert.equal(links.connections.filter((c: { linked: boolean }) => c.linked).length, 1);
  assert.equal(await runner.getByLabel("Password", { exact: true }).inputValue(), "");
  assert.deepEqual(errors, []);
});
