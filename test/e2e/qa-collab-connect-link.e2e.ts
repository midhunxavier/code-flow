import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { certificateFixture } from "../remote-tls-fixture.js";

const root = fileURLToPath(new URL("../..", import.meta.url)), fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-connect-ui-"))), repo = join(fixture, "repo");
const token = "qa-connect-owner", password = "qa-only-account-password", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
interface Instance { base: string; home: string; child: ChildProcess; log: string }
const instances: Instance[] = [], errors: string[] = [], consoleMessages: { text: string; url: string }[] = [];
let hub: Instance, computer: Instance, broken: Instance, browser: Browser, page: Page | undefined, project: string, localProject: string, localTask: string, linked: string;
async function until<T>(get: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> { const end = Date.now() + 30_000; for (;;) { const value = await get(); if (accepts(value)) return value; assert.ok(Date.now() < end, JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 50)); } }
async function api(instance: Instance, path: string, body?: unknown, method = "POST") { const response = await fetch(instance.base + path, { headers, method: body === undefined ? "GET" : method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`); return data; }
async function freePort() {
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  assert.ok(port !== 4317 && port !== 4318); return port;
}
async function start(name: string): Promise<Instance> {
  const home = join(fixture, name); mkdirSync(home, { recursive: true });
  const port = await freePort(), remotePort = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remotePort), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  const instance = { home, base: `http://127.0.0.1:${port}`, child, log: "" }; instances.push(instance);
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", value => instance.log += String(value));
  await until(() => fetch(instance.base + "/api/health", { headers }).then(response => response.ok, () => false), Boolean); return instance;
}
async function open(instance: Instance, hash: string, owner = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.addInitScript(() => localStorage.setItem("sideOpen", "0"));
  page = await context.newPage(); page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") consoleMessages.push({ text: message.text(), url: message.location().url }); });
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 500 && !response.url().startsWith(broken.base)) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${instance.base}/${owner ? `?token=${token}&team=local` : ""}${hash}`); return page;
}
async function shot(name: string) { if (evidence && page) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); } }
before(async () => {
  mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Team setup fixture\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", ...args], { cwd: repo }); git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "base");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(fixture, "build") } });
  hub = await start("hub"); computer = await start("computer");
  const conflict = { version: 1, url: "http://127.0.0.1:9", runnerId: "r-" + "a".repeat(16), token: "tr-" + "a".repeat(43), user: { userId: "u-alice", username: "alice", displayName: "Alice" }, machineName: "fixture", mappings: {} };
  mkdirSync(join(fixture, "broken/team-connections"), { recursive: true }); for (const name of ["team-link.json", "team-connections/legacy.json"]) writeFileSync(join(fixture, "broken", name), JSON.stringify(conflict), { mode: 0o600 }); broken = await start("broken");
  project = (await api(hub, "/api/projects", { name: "Shared fixture", repos: [repo] })).id;
  let board = await api(hub, "/api/team/board?teamConnection=local"); await api(hub, `/api/team/projects/${project}/repositories?teamConnection=local`, { revision: board.revision, repositories: [{ key: "app", label: "App" }] }, "PUT");
  const accounts = await api(hub, "/api/accounts"); await api(hub, "/api/accounts", { revision: accounts.revision, username: "alice", displayName: "Alice", password, roles: { [project]: "contributor" } });
  localProject = (await api(computer, "/api/projects", { name: "Local work", repos: [repo] })).id;
  board = await api(computer, "/api/team/board?teamConnection=local"); await api(computer, `/api/team/projects/${localProject}/repositories?teamConnection=local`, { revision: board.revision, repositories: [{ key: "app", label: "App" }] }, "PUT");
  localTask = (await api(computer, "/api/team/tasks?teamConnection=local", { projectId: localProject, repository: "app", title: "Local task kept", goal: "Keep local work", acceptance: "Task remains available", owner: "owner" })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async () => { await shot("last-case"); await page?.context().close(); page = undefined; });
after(async () => {
  await browser?.close();
  for (const instance of instances) { if (instance.child.exitCode === null && instance.child.signalCode === null) { const ended = new Promise(resolve => instance.child.once("exit", resolve)); instance.child.kill("SIGTERM"); await ended; } if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, instance.home.split("/").at(-1) + ".log"), instance.log); } assert.doesNotMatch(instance.log, /uncaughtException|Uncaught exception|unhandledRejection|ReferenceError|TypeError:/); }
  if (evidence) writeFileSync(join(evidence, "browser-console.json"), JSON.stringify(consoleMessages, null, 2));
  const unexpected = consoleMessages.filter(message => !(/Failed to load resource.*(?:401|409)/.test(message.text) || message.url.startsWith(broken.base) && /Failed to load resource.*503/.test(message.text)));
  rmSync(fixture, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});

test("a shared contributor sees the installed local port without navigating to the live listener", async () => {
  const p = await open(hub, `#/team/project/${project}`, false);
  await p.getByLabel("Username", { exact: true }).fill("alice"); await p.getByLabel("Password", { exact: true }).fill(password); await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await p.getByRole("button", { name: "Set up this computer for coding", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Connect this computer", exact: true });
  assert.equal(await dialog.getByLabel("Local Code Flow address", { exact: true }).inputValue(), "http://localhost:4317");
  assert.ok(await dialog.locator(".dialog-body").evaluate(element => parseFloat(getComputedStyle(element).paddingLeft)) > 0); await shot("default-local-address");
  await dialog.getByLabel("Local Code Flow address", { exact: true }).fill(computer.base); await dialog.getByRole("button", { name: "Open local Code Flow", exact: true }).click(); await p.waitForURL(url => url.origin === computer.base);
  assert.doesNotMatch(p.url(), /password|token=/);
});

test("connecting with local tasks succeeds, aliases are refused before enrollment, and handoff selects the saved team", async () => {
  const p = await open(computer, "#/settings/connections/join");
  await p.getByLabel("Team server URL", { exact: true }).fill(hub.base); await p.getByLabel("Username", { exact: true }).fill("alice"); await p.getByLabel("Password", { exact: true }).fill(password); await p.getByRole("button", { name: "Connect this computer", exact: true }).click();
  await p.getByRole("heading", { name: "Your team projects", exact: true }).waitFor();
  const connections = (await api(computer, "/api/team-link/connections")).connections; linked = connections.find((entry: any) => entry.linked).id;
  assert.equal((await api(computer, `/api/team/tasks/${localTask}?teamConnection=local`)).title, "Local task kept");
  const count = (await api(hub, "/api/team/runners?teamConnection=local")).length;
  await p.getByRole("button", { name: "Add team connection", exact: true }).click(); await p.getByLabel("Team server URL", { exact: true }).fill(hub.base.replace("127.0.0.1", "localhost")); await p.getByLabel("Username", { exact: true }).fill("alice"); await p.getByLabel("Password", { exact: true }).fill(password); await p.getByRole("button", { name: "Connect this computer", exact: true }).click();
  await p.getByRole("alert").filter({ hasText: /already saved/ }).waitFor(); assert.equal((await api(hub, "/api/team/runners?teamConnection=local")).length, count);
  const hint = `${hub.base.replace("127.0.0.1", "localhost")}/#/connect?username=alice&project=${project}`;
  await p.goto(`${computer.base}/?team=local#/settings/connections/join?connection=${encodeURIComponent(hint)}`);
  await p.waitForURL(url => url.searchParams.get("team") === linked); await p.getByRole("heading", { name: "Your team projects", exact: true }).waitFor();
  assert.equal(await p.getByLabel("Password", { exact: true }).count(), 0); await shot("existing-handoff-selected");
});

test("hosting setup restores its project and remembers the selected clone for agent drafting", async () => {
  const p = await open(hub, "#/settings/connections/host"), wizard = p.getByRole("region", { name: "Team server setup", exact: true });
  await wizard.getByLabel("Project", { exact: true }).selectOption(""); await wizard.getByLabel("Project name", { exact: true }).fill("Remembered setup"); await wizard.getByLabel("Local repository folder (optional)", { exact: true }).fill(repo); await wizard.getByRole("button", { name: "Save and continue", exact: true }).click();
  await wizard.getByLabel("Existing repository 1", { exact: true }).selectOption(repo); await wizard.getByRole("button", { name: "Save repositories and continue", exact: true }).click();
  await wizard.getByRole("heading", { name: "Step 3 of 5: Secure access", exact: true }).waitFor();
  const created = (await api(hub, "/api/projects")).find((entry: any) => entry.name === "Remembered setup"), b = await api(hub, "/api/team/board?teamConnection=local"), key = b.projects.find((entry: any) => entry.id === created.id).repositories[0].key;
  assert.equal((await api(hub, "/api/team-link?teamConnection=local")).mappings[created.id][key], repo);
  await wizard.getByRole("button", { name: "Close setup", exact: true }).click(); await p.goto(`${hub.base}/#/settings/connections/host`);
  await wizard.getByLabel("Project", { exact: true }).waitFor(); assert.equal(await wizard.getByLabel("Project", { exact: true }).inputValue(), created.id); await p.reload(); await wizard.getByLabel("Project", { exact: true }).waitFor(); assert.equal(await wizard.getByLabel("Project", { exact: true }).inputValue(), created.id); await shot("wizard-resumed-project");
  await p.goto(`${hub.base}/?team=local#/team/project/${created.id}`); await p.getByRole("button", { name: "Draft with agent", exact: true }).click();
  await p.getByRole("region", { name: "Draft with agent", exact: true }).waitFor(); assert.equal(await p.getByLabel("Repository folder", { exact: true }).inputValue(), repo); await shot("draft-prefilled");
  const task = await api(hub, "/api/team/tasks?teamConnection=local", { projectId: created.id, repository: key, title: "Mapped build", goal: "Add a short note", acceptance: "A note exists", owner: "owner" });
  await p.goto(`${hub.base}/?team=local#/team/task/${task.id}`); await p.getByRole("button", { name: "Build with agents", exact: true }).click();
  const build = p.getByRole("dialog", { name: "Build with agents", exact: true }); assert.equal(await build.locator("#tt-start-repo").inputValue(), repo);
  await build.getByLabel("Workflow", { exact: true }).selectOption("solo"); await build.getByLabel("Agent", { exact: true }).selectOption("claude"); await build.getByLabel("Check command", { exact: true }).fill("true"); await build.getByRole("button", { name: "Build with agents", exact: true }).click();
  await until(() => api(hub, `/api/team/tasks/${task.id}?teamConnection=local`), value => value.checkpoints?.length > 0);
  await p.getByRole("button", { name: "Fetch to this computer…", exact: true }).first().click(); const fetchDialog = p.getByRole("dialog", { name: "Fetch to this computer", exact: true });
  assert.equal(await fetchDialog.getByLabel("Repository path", { exact: true }).inputValue(), repo); await shot("fetch-prefilled");
});

test("conflicting legacy files keep core APIs healthy and show repair paths without overwriting credentials", async () => {
  const first = join(broken.home, "team-link.json"), second = join(broken.home, "team-connections/legacy.json"), bytes = [readFileSync(first, "utf8"), readFileSync(second, "utf8")];
  assert.ok(await api(broken, "/api/health")); assert.ok(await api(broken, "/api/runs")); await api(broken, "/api/projects", { name: "Core remains available", repos: [repo] });
  const response = await fetch(broken.base + "/api/team-link/connections", { headers }); assert.equal(response.status, 503); const body = await response.json(); assert.ok(body.error.includes(first) && body.error.includes(second));
  const p = await open(broken, "#/settings/connections/join"); await p.getByRole("alert").filter({ hasText: /Both .*team-link.json.*legacy.json/ }).first().waitFor(); await shot("legacy-conflict-recovery");
  assert.deepEqual([readFileSync(first, "utf8"), readFileSync(second, "utf8")], bytes);
});


test("first project sharing remembers its known clone without exposing its path", async () => {
  const cert = await certificateFixture(fixture);
  await api(hub, "/api/remote", { enabled: true, lan: true, transport: "lan" });
  await api(hub, "/api/remote/tls", { mode: "import", hostname: "localhost", cert: cert.cert, key: cert.key });
  const created = await api(hub, "/api/projects", { name: "Shared known clone", repos: [repo] });
  const p = await open(hub, `#/project/${created.id}`); await p.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Share Shared known clone", exact: true });
  await dialog.getByRole("button", { name: "Create invitation", exact: true }).click(); await dialog.getByLabel("Invitation link", { exact: true }).waitFor();
  const board = await api(hub, "/api/team/board?teamConnection=local"), repository = board.projects.find((entry: any) => entry.id === created.id).repositories[0];
  assert.equal((await api(hub, "/api/team-link?teamConnection=local")).mappings[created.id][repository.key], repo);
  assert.ok(!JSON.stringify(board).includes(repo), "local mapping remains private");
  await shot("share-known-clone"); await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await p.goto(`${hub.base}/?team=local#/team/project/${created.id}`); await p.getByRole("button", { name: "Draft with agent", exact: true }).click();
  assert.equal(await p.getByLabel("Repository folder", { exact: true }).inputValue(), repo);
});
