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
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
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
  await owner.goto(`${base}/?team=local#/project/${projectId}/people`);
  const invites = owner.getByRole("region", { name: "Project invitations" });
  await invites.getByRole("button", { name: "Create invitation", exact: true }).click();
  inviteLink = await invites.getByLabel("Invitation link", { exact: true }).inputValue();
  assert.ok(inviteLink.startsWith(`${remote}/#/join/`)); assert.ok(!inviteLink.includes("/r/"));
  await member.goto(inviteLink); await member.getByRole("heading", { name: "Join Shared app", exact: true }).waitFor();
  await member.screenshot({ path: join(root, "output/playwright/team-join-mobile.png"), fullPage: true });
  await audit(member);
  await member.getByLabel("Your name", { exact: true }).fill("Alice"); await member.getByLabel("Username", { exact: true }).fill("alice"); await member.getByLabel("Password", { exact: true }).fill(password);
  await member.getByRole("button", { name: "Join project", exact: true }).click(); await member.getByRole("heading", { name: "You’re in Shared app", exact: true }).waitFor();
  assert.ok(!member.url().includes("/join/"), "accepted secret leaves the address bar");
  connection = await member.getByLabel("Your connection link", { exact: true }).inputValue(); assert.ok(!connection.includes(password));
  await audit(member);
  await member.getByRole("link", { name: "Open project board", exact: true }).click(); await member.getByRole("heading", { name: "Your board is ready for its first task", exact: true }).waitFor();
  const visible = await member.evaluate(async () => (await fetch("/api/projects")).json()); assert.deepEqual(visible.map((entry: { id: string }) => entry.id), [projectId]);
  for (const path of ["/api/accounts/invitations", "/api/remote", `/api/team/board?project=${privateProject}`]) {
    const status = await member.evaluate(async path => (await fetch(path)).status, path); assert.ok([403, 404].includes(status), `${path} cannot expose owner/private data`);
  }
});

test("joined teammate connects a separate CodeFlow computer, maps a repository and collaborates", async () => {
  await runner.goto(`${runnerBase}/?token=${token}#/settings/connections/join`);
  await runner.getByLabel("Team server URL", { exact: true }).fill(connection);
  assert.equal(await runner.getByLabel("Username", { exact: true }).inputValue(), "alice");
  await runner.getByLabel("Password", { exact: true }).fill(password); await runner.getByLabel("Machine name", { exact: true }).fill("Alice laptop");
  await runner.getByRole("button", { name: "Connect this computer", exact: true }).click();
  await runner.getByRole("heading", { name: "Your team projects", exact: true }).waitFor();
  const mapping = runner.locator(".team-mapping").filter({ hasText: "Application" });
  await mapping.locator("input").fill(repo); await mapping.getByRole("button", { name: "Save", exact: true }).click();
  await runner.getByText("Contributor · Repositories connected", { exact: true }).waitFor();
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
  assert.deepEqual(errors, []);
});

test("used and revoked links recover clearly; anonymous and member callers cannot issue invitations", async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const stranger = await context.newPage();
  await stranger.goto(inviteLink); await stranger.getByRole("alert").filter({ hasText: "expired, was used, or was revoked" }).waitFor();
  assert.equal(await stranger.getByRole("button", { name: "Join project", exact: true }).count(), 0);
  const denied = await stranger.evaluate(async projectId => (await fetch("/api/accounts/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, role: "maintainer" }) })).status, projectId); assert.ok([401, 404].includes(denied));
  const memberDenied = await member.evaluate(async projectId => (await fetch("/api/accounts/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, role: "maintainer" }) })).status, projectId); assert.equal(memberDenied, 403);
  const created = await request("/api/accounts/invitations", { projectId, role: "reviewer" });
  const revoke = await fetch(`${base}/api/accounts/invitations/${created.invitation.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }); assert.equal(revoke.status, 200);
  await stranger.goto(`${remote}/#/join/${created.token}`); await stranger.getByRole("alert").filter({ hasText: "revoked" }).waitFor();
  const plaintext = await fetch(`${base}/api/auth/invitations/preview`, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-forwarded-for": "192.0.2.1" }, body: JSON.stringify({ token: created.token }) }); assert.equal(plaintext.status, 403);
  await context.close(); assert.deepEqual(errors, []);
});


test("an existing account joins a second project without sharing passwords or losing its first membership", async () => {
  const invite = await request("/api/accounts/invitations", { projectId: privateProject, role: "reviewer" });
  await member.goto(`${remote}/#/join/${invite.token}`); await member.getByLabel("Account option").selectOption("existing");
  await member.getByLabel("Username", { exact: true }).fill("alice"); await member.getByLabel("Password", { exact: true }).fill(password);
  await member.getByRole("button", { name: "Join project", exact: true }).click(); await member.getByRole("heading", { name: "You’re in Private project", exact: true }).waitFor();
  assert.equal(await member.getByLabel("Your connection link", { exact: true }).count(), 0, "review-only project does not suggest running tasks");
  const identity = await member.evaluate(async () => (await fetch("/api/auth/self")).json());
  assert.deepEqual(identity.roles, { [projectId]: "contributor", [privateProject]: "reviewer" });
  assert.deepEqual(errors, []);
});
