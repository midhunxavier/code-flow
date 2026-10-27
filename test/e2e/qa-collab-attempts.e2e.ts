import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/**
 * Team board attempts in a browser, from the QA pass (docs/team-collaboration.md): the recipient of a hand-over accepts
 * it from their own computer; a refusal the server explains (deleting the checkpoint of an offered hand-over, removing a
 * repository key a task still uses) is shown in its words instead of "changed; reloading"; a "Connection lost" attempt
 * offers Recover attempt… as soon as its runner is silent for 90 s, a recovery the runner outran says so in the dialog,
 * and an unknown attempt reads "Status unknown" with its reason; Resume is not offered once the run is gone from this
 * computer. This computer is its own team server with fake agents, as in test/e2e/team.e2e.ts.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-collab-attempts-"))), home = join(fixture, "home"), repo = join(fixture, "repo");
const token = "qa-collab-attempts-owner-token", password = "a long local team board password", ownerHeaders = { authorization: `Bearer ${token}` }, jsonHeaders = { ...ownerHeaders, "content-type": "application/json" };
/** An OS-assigned loopback port; the user's own server lives on 4317/4318, so those are never used even if the OS hands them out. */
async function freePort(): Promise<number> { for (;;) { const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); }); if (port !== 4317 && port !== 4318) return port; } }
const port = Number(process.env.QA_COLLAB_PORT) || await freePort(), remotePort = process.env.QA_COLLAB_PORT ? port + 1 : await freePort(), base = `http://127.0.0.1:${port}`;
let server: ChildProcess, browser: Browser, projectId: string, bobId: string, head: string, log = "";
const contexts: BrowserContext[] = [], errors: string[] = [];
function watch(page: Page): void {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource: the server responded with a status of (?:400|404|409)/.test(message.text())) errors.push(`console: ${message.text()}`); });
  page.on("response", response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
}
const api = async <T = any>(path: string, init: RequestInit = {}): Promise<T> => { const response = await fetch(base + path, { ...init, headers: { ...jsonHeaders, ...init.headers } }), text = await response.text(); assert.ok(response.ok, `${init.method ?? "GET"} ${path} answered ${response.status}: ${text}`); return JSON.parse(text) as T; };
const send = (path: string, method: string, body: unknown) => api(path, { method, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
interface TaskView { id: string; revision: number; owner?: { userId: string }; attempts: { id: string; state: string; runId?: string; reason?: string }[]; checkpoints: { id: string; bundle: string }[]; handoff?: { id: string; state: string }; handoffs: { state: string; note: string }[]; audit: { action: string }[] }
const task = (id: string) => api<TaskView>(`/api/team/tasks/${id}`);
async function until(id: string, ok: (task: TaskView) => boolean, what: string): Promise<TaskView> { const deadline = Date.now() + 90_000; for (;;) { const current = await task(id); if (ok(current)) return current; assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(current.attempts)}\n${log.slice(-3000)}`); await sleep(300); } }
const newTask = (title: string, owner = "owner") => api<TaskView>("/api/team/tasks", { method: "POST", body: JSON.stringify({ projectId, repository: "app", title, owner }) });
/** An attempt the hub owner claims in-process under a runner name, reported running once: the runner then goes silent. */
async function claimRunning(id: string, runnerName: string): Promise<string> { const current = await task(id), attemptId = randomBytes(16).toString("hex"); await send(`/api/team/tasks/${id}/attempts`, "POST", { attemptId, runnerId: "local", runnerName, baseCommit: head, revision: current.revision }); await send(`/api/team/attempts/${attemptId}/progress`, "POST", { seq: 1, runStatus: "running" }); return attemptId; }
async function owner(clock?: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }); contexts.push(context); const page = await context.newPage(); watch(page);
  if (clock !== undefined) await page.clock.install({ time: clock });
  await page.goto(`${base}/?token=${token}`); await page.getByRole("button", { name: "New run", exact: true }).waitFor(); return page;
}
const evidence = async (page: Page, name: string) => { if (process.env.QA_ARTIFACT_DIR) { mkdirSync(process.env.QA_ARTIFACT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.QA_ARTIFACT_DIR, `${name}.png`), fullPage: true }); } };
const openTask = async (page: Page, id: string, title: string) => { await page.goto(`${base}/#/team/task/${id}`); await page.getByRole("heading", { level: 1, name: new RegExp(`^${title}`) }).waitFor(); return page.locator("section.team-section", { has: page.locator("#tt-exec") }); };

before(async () => {
  mkdirSync(home, { recursive: true }); mkdirSync(join(repo, ".codeflow"), { recursive: true }); writeFileSync(join(repo, "README.md"), "# Fixture app\n\nHello, team.\n"); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }); git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "base"); head = git("rev-parse", "HEAD").trim();
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const env: NodeJS.ProcessEnv = {}; for (const [key, value] of Object.entries(process.env)) if (!/^(?:CODEFLOW_|FAKE_)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, SHELL: "/bin/sh", ENV: "/dev/null", HISTFILE: "/dev/null", ZDOTDIR: home, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH ?? ""}`, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remotePort), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_GH_STATE: join(home, "fake-gh.json"), FAKE_SLEEP_VENDOR: "codex", FAKE_SLEEP_MS: "30000" });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk) => { log = (log + chunk.toString()).slice(-16000); });
  let healthy = false; for (let n = 0; n < 300 && server.exitCode === null; n++) { healthy = await fetch(`${base}/api/health`, { headers: ownerHeaders }).then((response) => response.ok, () => false); if (healthy) break; await sleep(100); } assert.ok(healthy, `the server did not answer /api/health:\n${log}`);
  projectId = (await api<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Fixture app", repos: [repo] }) })).id;
  const accounts = await api<{ revision: number }>("/api/accounts"); await send("/api/accounts", "POST", { revision: accounts.revision, username: "bob", displayName: "Bob Contributor", password, roles: { [projectId]: "contributor" } });
  const board = await api<{ revision: number; projects: { id: string; members: { userId: string; username: string }[] }[] }>("/api/team/board"); bobId = board.projects.find((project) => project.id === projectId)!.members.find((member) => member.username === "bob")!.userId;
  await send(`/api/team/projects/${projectId}/repositories`, "PUT", { repositories: [{ key: "app", label: "Fixture app" }], revision: board.revision });
  await send("/api/team-link/mappings", "PUT", { projectId, repository: "app", path: repo });
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { for (const context of contexts) await context.close().catch(() => undefined); await browser?.close(); server?.kill("SIGTERM"); await new Promise<void>((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); assert.doesNotMatch(log, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/); assert.deepEqual(errors, []); rmSync(fixture, { recursive: true, force: true }); });

let silent: { id: string; attemptId: string; since: number } | undefined;
const SILENT_TITLE = "Recover a silent laptop";

test("a Connection lost attempt offers Recover attempt…, and a recovery the runner outran stays in the dialog with the server's reason", async () => {
  const created = await newTask(SILENT_TITLE); silent = { id: created.id, attemptId: await claimRunning(created.id, "Offline laptop"), since: Date.now() };
  // The hub heard from the runner just now; this browser's clock runs two minutes ahead, so the page reads the attempt as silent and the hub does not.
  const page = await owner(Date.now() + 120_000), execution = await openTask(page, created.id, SILENT_TITLE);
  await execution.locator(".status-pill").filter({ hasText: "Connection lost" }).waitFor();
  await execution.getByText("Connection lost: Offline laptop has not reported for over 90 seconds", { exact: false }).waitFor();
  assert.equal(await execution.getByText("Recover it only after", { exact: false }).count(), 0);
  await page.getByText("Recover the attempt on Offline laptop, whose runner lost contact, before changing the owner", { exact: true }).waitFor();
  await execution.getByRole("button", { name: "Recover attempt…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Recover attempt", exact: true }); await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "How did you confirm execution stopped?" }).fill("The laptop is shut down.");
  await dialog.getByRole("checkbox", { name: "I confirmed the original agent has stopped." }).check();
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/team/attempts/${silent!.attemptId}/recover` && response.status() === 409);
  await dialog.getByRole("button", { name: "Release task", exact: true }).click(); await refused;
  await dialog.getByRole("alert").filter({ hasText: "Runner Offline laptop is connected and reports this attempt as running" }).waitFor();
  await evidence(page, "recovery-refusal");
  await sleep(500); assert.equal(await dialog.isVisible(), true, "the refusal is read in the dialog, not unmounted with it");
  assert.equal((await task(created.id)).attempts[0]!.state, "running", "the hub kept the attempt");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("the recipient of a hand-over accepts and downloads it on their own computer, and refusals the server explains are shown in its words", async () => {
  const title = "Hand the greeting over", created = await newTask(title);
  await send(`/api/team-link/tasks/${created.id}/start`, "POST", { pattern: "solo", roles: { agent: ["claude"] }, trust: "safe", loop: { check: "true", maxSteps: 4, maxMinutes: 2 } });
  let current = await until(created.id, (t) => t.attempts[0]?.state === "finished" && t.checkpoints[0]?.bundle === "available", "the attempt did not finish with a checkpoint");
  // The hub owner, a maintainer, gives the task to Bob and then offers it back to themselves: they are the recipient, not the owner.
  current = await send(`/api/team/tasks/${created.id}`, "PUT", { revision: current.revision, owner: bobId }) as TaskView;
  await send(`/api/team/tasks/${created.id}/handoff`, "POST", { to: "owner", checkpointId: current.checkpoints[0]!.id, note: "Please take the greeting back", revision: current.revision });
  const page = await owner(), execution = await openTask(page, created.id, title);
  const accept = execution.getByRole("button", { name: "Accept and download", exact: true }); await accept.waitFor();
  await execution.getByRole("button", { name: "Decline", exact: true }).waitFor(); assert.equal(await execution.getByRole("button", { name: "Decline hand-over", exact: true }).count(), 0, "this computer can accept, so it offers Accept and Decline");
  assert.equal(await execution.getByRole("button", { name: "Build with agents", exact: true }).count(), 0, "the task is not yet yours to run");
  // Deleting the offered checkpoint is refused for a reason, which the page shows instead of "Task changed; reloading".
  await page.locator("section.team-section", { has: page.locator("#tt-checkpoints") }).getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete bundle", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Cancel the offered hand-over before deleting its checkpoint" }).waitFor();
  assert.equal(await page.getByRole("status").filter({ hasText: "Task changed; reloading" }).count(), 0);
  // Accepting downloads the checkpoint into the mapped clone before the task becomes this owner's.
  await accept.click(); const dialog = page.getByRole("dialog", { name: "Accept and download", exact: true }); await dialog.waitFor();
  assert.equal(await dialog.getByLabel("Repository path", { exact: true }).inputValue(), repo, "the mapped clone is prefilled");
  await dialog.getByRole("button", { name: "Accept and download", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Hand-over accepted" }).waitFor(); await dialog.waitFor({ state: "hidden" });
  current = await until(created.id, (t) => t.owner?.userId === "owner", "the hand-over was not accepted");
  assert.equal(current.handoffs.at(-1)!.state, "accepted"); assert.equal(current.handoff, undefined);
  await page.locator(".team-task-meta").filter({ hasText: "(you)" }).first().waitFor();
  await page.locator("section.team-section", { has: page.locator("#tt-checkpoints") }).getByText(/^Hand-over note from .+ \(you\): Please take the greeting back$/).waitFor();
  await execution.getByRole("button", { name: "Build with agents", exact: true }).waitFor();
  // A repository key the task still uses cannot be removed: the editor keeps the draft and says why.
  await page.goto(`${base}/#/settings/team`); const keys = page.getByRole("group", { name: /^Repositories · Fixture app/ }); await keys.waitFor();
  await keys.getByRole("button", { name: "Remove repository key app", exact: true }).click(); await keys.getByRole("button", { name: "Add repository", exact: true }).click(); await keys.getByLabel("Repository name", { exact: true }).fill("Docs site");
  await keys.getByRole("button", { name: "Save repositories", exact: true }).click();
  await keys.getByRole("alert").filter({ hasText: "still uses repository app; move it to another repository before removing that key" }).waitFor();
  assert.equal(await page.getByRole("status").filter({ hasText: "Board changed; reloading" }).count(), 0); await keys.getByRole("button", { name: "Discard", exact: true }).waitFor();
  await keys.getByRole("button", { name: "Discard", exact: true }).click();
  assert.deepEqual(errors, []);
});

test("a linked recipient accepts a hand-over into their clone before continuing from its checkpoint", async () => {
  const linkedHome = join(fixture, "linked-home"), clone = join(fixture, "bob-clone");
  mkdirSync(linkedHome, { recursive: true });
  execFileSync("git", ["clone", "-q", "--no-hardlinks", repo, clone], { cwd: fixture });
  const linkedPort = process.env.QA_COLLAB_PORT ? port + 2 : await freePort(), linkedRemotePort = process.env.QA_COLLAB_PORT ? port + 3 : await freePort();
  const linkedBase = `http://127.0.0.1:${linkedPort}`, linkedToken = "qa-linked-bob-owner-token";
  const env: NodeJS.ProcessEnv = {}; for (const [key, value] of Object.entries(process.env)) if (!/^(?:CODEFLOW_|FAKE_)/.test(key)) env[key] = value;
  Object.assign(env, { HOME: linkedHome, SHELL: "/bin/sh", ENV: "/dev/null", HISTFILE: "/dev/null", ZDOTDIR: linkedHome, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH ?? ""}`, PORT: String(linkedPort), CODEFLOW_REMOTE_PORT: String(linkedRemotePort), CODEFLOW_HOME: linkedHome, CODEFLOW_TOKEN: linkedToken, FAKE_GH_STATE: join(linkedHome, "fake-gh.json") });
  const linkedServer = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let linkedLog = ""; for (const stream of [linkedServer.stdout, linkedServer.stderr]) stream?.on("data", chunk => { linkedLog = (linkedLog + chunk.toString()).slice(-16000); });
  const linkedApi = async (path: string, body?: object, method = "POST") => {
    const response = await fetch(linkedBase + path, { method, headers: { authorization: `Bearer ${linkedToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); assert.ok(response.ok, `${path}: ${response.status} ${text}`); return JSON.parse(text);
  };
  let linkedContext: BrowserContext | undefined;
  try {
    let healthy = false; for (let n = 0; n < 300 && linkedServer.exitCode === null; n++) { healthy = await fetch(`${linkedBase}/api/health`, { headers: { authorization: `Bearer ${linkedToken}` } }).then(response => response.ok, () => false); if (healthy) break; await sleep(100); }
    assert.ok(healthy, linkedLog);
    const connection = await linkedApi("/api/team-link/connect", { url: base, username: "bob", password, name: "Bob linked laptop" });
    await linkedApi("/api/team-link/mappings", { projectId, repository: "app", path: clone }, "PUT");
    const title = "A hand-over on Bob's computer", created = await newTask(title);
    await send(`/api/team-link/tasks/${created.id}/start`, "POST", { pattern: "solo", roles: { agent: ["claude"] }, trust: "safe", loop: { check: "true", maxSteps: 4, maxMinutes: 2 } });
    const finished = await until(created.id, value => value.attempts[0]?.state === "finished" && value.checkpoints[0]?.bundle === "available", "the owner's checkpoint");
    await send(`/api/team/tasks/${created.id}/handoff`, "POST", { to: bobId, checkpointId: finished.checkpoints[0]!.id, note: "Document the device wildcard edge case", revision: finished.revision });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }); linkedContext = context; contexts.push(context); const page = await context.newPage(); watch(page);
    await page.goto(`${linkedBase}/?token=${linkedToken}&team=${connection.id}#/team/task/${created.id}`);
    await page.getByRole("heading", { level: 1, name: new RegExp(title) }).waitFor();
    const execution = page.locator("section.team-section", { has: page.locator("#tt-exec") });
    await execution.getByRole("button", { name: "Accept and download", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Accept and download", exact: true });
    assert.equal(await dialog.getByLabel("Repository path", { exact: true }).inputValue(), clone);
    await dialog.getByRole("button", { name: "Accept and download", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Hand-over accepted" }).waitFor(); await dialog.waitFor({ state: "hidden" });
    const accepted = await until(created.id, value => value.owner?.userId === bobId, "Bob to own the accepted hand-over");
    assert.equal(accepted.handoffs.at(-1)!.state, "accepted");
    await page.getByText(/Hand-over note from .+: Document the device wildcard edge case/).waitFor();
    const checkpoint = (await linkedApi(`/api/team/tasks/${created.id}`, undefined, "GET")).checkpoints[0];
    execFileSync("git", ["cat-file", "-e", `${checkpoint.commit}^{commit}`], { cwd: clone });
    await execution.getByRole("button", { name: "Build with agents", exact: true }).click();
    const build = page.getByRole("dialog", { name: "Build with agents", exact: true });
    await build.getByLabel("Workflow", { exact: true }).selectOption("solo"); await build.getByRole("combobox", { name: "Agent", exact: true }).selectOption("claude");
    await build.getByLabel("Check command", { exact: true }).fill("true");
    await build.getByRole("button", { name: "Build with agents", exact: true }).click();
    const continued = await until(created.id, value => value.attempts[1]?.state === "finished", "Bob's continuation to finish");
    const latest = continued.attempts[1] as typeof continued.attempts[number] & { fromCheckpointId?: string };
    assert.equal(latest.fromCheckpointId, checkpoint.id);
    await evidence(page, "linked-recipient-continuation");
    assert.deepEqual(errors, []);
  } finally {
    await linkedContext?.close();
    linkedServer.kill("SIGTERM"); await new Promise<void>(resolve => { if (linkedServer.exitCode !== null) return resolve(); linkedServer.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
    assert.doesNotMatch(linkedLog, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/);
  }
});

test("an unknown attempt reads Status unknown with its reason, and Resume is not offered once the run is gone from this computer", async () => {
  const unknownTitle = "A run that went missing", lost = await newTask(unknownTitle), attemptId = await claimRunning(lost.id, "Alice laptop");
  await send(`/api/team/attempts/${attemptId}/finish`, "POST", { state: "unknown", reason: "Run 2610252143-b1fe4939 is missing from this computer" });
  const page = await owner(); let execution = await openTask(page, lost.id, unknownTitle);
  await execution.locator(".status-pill").filter({ hasText: "Status unknown" }).waitFor();
  await execution.getByText("Execution status unknown: Run 2610252143-b1fe4939 is missing from this computer.", { exact: false }).waitFor();
  assert.equal(await execution.getByText("Connection lost", { exact: false }).count(), 0, "the runner reported; this is not a lost connection");
  assert.equal(await execution.getByText("Last heard", { exact: false }).count(), 0, "no 'heard just now' beside an unknown status");
  await execution.getByRole("button", { name: "Recover attempt…", exact: true }).waitFor();
  // A run stopped at its budget on this computer, then deleted from its history: the attempt cannot be resumed here any more.
  const gone = "A run deleted from history", stopped = await newTask(gone);
  const started = await send(`/api/team-link/tasks/${stopped.id}/start`, "POST", { pattern: "loop", roles: { workers: ["claude"] }, trust: "safe", loop: { check: "false", maxSteps: 1, maxMinutes: 2 } }) as { runId: string };
  await until(stopped.id, (t) => t.attempts[0]?.state === "stopped", "the attempt did not stop at its budget");
  execution = await openTask(page, stopped.id, gone); await execution.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await api(`/api/runs/${started.runId}`, { method: "DELETE" });
  await page.reload(); execution = await openTask(page, stopped.id, gone); await execution.locator(".status-pill").filter({ hasText: "Stopped at a limit" }).waitFor();
  await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/team-link/attempts").catch(() => undefined); await sleep(500);
  assert.equal(await execution.getByRole("button", { name: "Resume", exact: true }).count(), 0, "the run is gone, so there is nothing to resume");
  assert.equal(await execution.getByRole("link", { name: "Open run", exact: true }).count(), 0);
  await execution.getByRole("button", { name: "Build with agents", exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("a newer finished attempt replaces paused work in the task and board, and reassignment explains the supersession", async () => {
  const title = "Show the latest attempt", created = await newTask(title), page = await owner();
  await send(`/api/team-link/tasks/${created.id}/start`, "POST", { pattern: "solo", roles: { agent: ["codex"] }, trust: "safe", loop: { check: "true", maxSteps: 4, maxMinutes: 2 } });
  await until(created.id, value => value.attempts[0]?.state === "running", "the slow attempt to start");
  let execution = await openTask(page, created.id, title);
  await execution.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop attempt", exact: true }).click();
  await until(created.id, value => value.attempts[0]?.state === "paused", "the first attempt to pause");
  await execution.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await execution.getByRole("button", { name: "Build with agents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Build with agents", exact: true });
  await dialog.getByLabel("Workflow", { exact: true }).selectOption("solo");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("claude");
  await dialog.getByLabel("Check command", { exact: true }).fill("true");
  await dialog.getByRole("button", { name: "Build with agents", exact: true }).click();
  const finished = await until(created.id, value => value.attempts[1]?.state === "finished", "the second attempt to finish");
  assert.equal(finished.attempts[0]!.state, "superseded");
  await page.reload(); execution = await openTask(page, created.id, title);
  await execution.locator(".status-pill").filter({ hasText: "Finished" }).waitFor();
  assert.equal(await execution.getByRole("button", { name: "Resume", exact: true }).count(), 0);
  await page.goto(`${base}/#/team`);
  const card = page.getByRole("button", { name: new RegExp(title) }); await card.waitFor();
  assert.doesNotMatch(await card.innerText(), /Paused/);
  const second = await newTask("Explain reassigned work");
  await send(`/api/team-link/tasks/${second.id}/start`, "POST", { pattern: "loop", roles: { workers: ["claude"] }, trust: "safe", loop: { check: "false", maxSteps: 1, maxMinutes: 2 } });
  const stopped = await until(second.id, value => value.attempts[0]?.state === "stopped", "the bounded attempt to stop");
  await send(`/api/team/tasks/${second.id}`, "PUT", { owner: bobId, revision: stopped.revision });
  execution = await openTask(page, second.id, "Explain reassigned work");
  await execution.getByText("Superseded when the task passed to Bob Contributor; work continues from the task's latest checkpoint", { exact: true }).waitFor();
  assert.doesNotMatch(await execution.innerText(), /resume it from here/);
  await evidence(page, "reassigned-supersession");
  assert.deepEqual(errors, []);
});

test("reviewers and collaborators receive attempt outcomes and instruction proposers see decisions in their inbox", async () => {
  const accounts = await api<{ revision: number }>("/api/accounts");
  await send("/api/accounts", "POST", { revision: accounts.revision, username: "rita", displayName: "Rita Reviewer", password, roles: { [projectId]: "reviewer" } });
  const members = (await api("/api/team/board")).projects.find((project: any) => project.id === projectId).members;
  const ritaId = members.find((member: any) => member.username === "rita").userId;
  const created = await api<TaskView>("/api/team/tasks", { method: "POST", body: JSON.stringify({ projectId, repository: "app", title: "Notify the team", owner: "owner", reviewer: ritaId, collaborators: [bobId] }) });
  await send(`/api/team-link/tasks/${created.id}/start`, "POST", { pattern: "solo", roles: { agent: ["claude"] }, trust: "safe", loop: { check: "true", maxSteps: 4, maxMinutes: 2 } });
  await until(created.id, value => value.attempts[0]?.state === "finished", "the reviewable attempt to finish");
  const signIn = async (username: string) => {
    const context = await browser.newContext(); contexts.push(context); const page = await context.newPage();
    watch(page);
    await page.goto(base); await page.getByLabel("Username", { exact: true }).fill(username); await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    return page;
  };
  const reviewer = await signIn("rita");
  await reviewer.getByText(/New checkpoint .+ of “Notify the team” is ready for your review/).waitFor();
  await evidence(reviewer, "reviewer-inbox");
  const collaborator = await signIn("bob");
  await collaborator.getByText(/The attempt on .+ finished with checkpoint/).waitFor();
  await collaborator.goto(`${base}/#/team/task/${created.id}`);
  await collaborator.getByLabel("Comment", { exact: true }).fill("Please document the wildcard case");
  await collaborator.getByRole("switch", { name: "Send to agent", exact: true }).check();
  await collaborator.getByRole("button", { name: "Send to agent", exact: true }).click();
  const ownerPage = await owner(); await openTask(ownerPage, created.id, "Notify the team");
  await ownerPage.locator(".team-comment").filter({ hasText: "Please document the wildcard case" }).getByRole("button", { name: "Decline", exact: true }).click();
  await collaborator.goto(`${base}/#/team`);
  await collaborator.getByText(/declined your instruction for the agent on “Notify the team”/).waitFor();
  await evidence(collaborator, "collaborator-inbox");
  await ownerPage.getByRole("heading", { level: 1, name: /Notify the team/ }).waitFor();
  assert.deepEqual(errors, []);
});

test("once the runner has been silent for 90 seconds the hub releases the task through Recover attempt…", async () => {
  assert.ok(silent, "the first test claimed the silent attempt");
  const wait = silent.since + 92_000 - Date.now(); if (wait > 0) await sleep(wait);
  const page = await owner(), execution = await openTask(page, silent.id, SILENT_TITLE);
  await execution.locator(".status-pill").filter({ hasText: "Connection lost" }).waitFor();
  await execution.getByRole("button", { name: "Recover attempt…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Recover attempt", exact: true }); await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "How did you confirm execution stopped?" }).fill("The laptop is shut down; no agent runs.");
  await dialog.getByRole("checkbox", { name: "I confirmed the original agent has stopped." }).check();
  await dialog.getByRole("button", { name: "Release task", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  await page.getByRole("status").filter({ hasText: "Attempt recovered" }).waitFor();
  await execution.getByRole("button", { name: "Build with agents", exact: true }).waitFor();
  await evidence(page, "recovered-attempt");
  const recovered = await task(silent.id); assert.equal(recovered.attempts[0]!.state, "superseded"); assert.equal(recovered.attempts[0]!.reason, "The laptop is shut down; no agent runs."); assert.equal(recovered.audit.at(-1)!.action, "attempt-recovered");
  assert.deepEqual(errors, []);
});
