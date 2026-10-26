// The filesystem-restriction gate in the browser: closing the last terminal doesn't open another (so a
// policy can then apply), a first restriction is confirmed and can be removed in one step, and under a
// restriction every paused surface says why (naming the project) instead of loading forever, asking the
// server for terminals, catalogs, browsers or GitHub listings it would refuse. A policy panel left open
// while the policy changed elsewhere still asks the server, so it reports the conflict, not "no changes".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-fs-policy-gate-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repoA: string, repoB: string, projectA: string, projectB: string;
const errors: string[] = [];
const finiteRequests = new Set<import("playwright-core").Request>();
let lastRequestFinished = 0, trackFiniteReads = false;
// Provider discovery and repository reads hold the policy admission guard even
// after navigation cancels their browser request. Let actual responses finish
// before navigating away or applying a policy, instead of racing that guard.
async function waitForApplicationReads() {
  if (!trackFiniteReads) return;
  const deadline = Date.now() + 15000;
  while (finiteRequests.size || Date.now() - lastRequestFinished < 200) {
    assert.ok(Date.now() < deadline, `Application reads did not settle: ${[...finiteRequests].map(request => request.url()).join(", ")}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
const running = async () => ((await api("/api/shell")).body as { status: string }[]).filter((shell) => shell.status === "running");
async function sidePanel(tab: "terminal" | "browser") {
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.locator(`#side-tab-${tab}`).click();
  return page.locator(`#side-pane-${tab}`);
}
/** Close a terminal with its ×; one still starting its shell asks first ("Stop and close terminal?"). */
async function closeTerminal(close: import("playwright-core").Locator) {
  await close.click();
  const confirm = page.locator("dialog.confirmation-dialog").getByRole("button", { name: "Stop and close", exact: true });
  if (await confirm.waitFor({ timeout: 1_000 }).then(() => true, () => false)) await confirm.click();
}
async function newRun(id: string) { await waitForApplicationReads(); await page.goto(`${base}/#/project/${id}/new`); await page.getByLabel("Task", { exact: true }).waitFor({ timeout: 15_000 }); await waitForApplicationReads(); }
async function policyPanel(id: string) {
  await waitForApplicationReads(); await page.goto(`${base}/#/settings/projects`); await page.getByLabel("Project", { exact: true }).selectOption(id);
  const panel = page.getByRole("region", { name: "Project filesystem policy", exact: true });
  await panel.getByText("Saved revision", { exact: false }).waitFor(); await waitForApplicationReads(); return panel;
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-fs-policy-gate-")));
  repoA = join(directory, "alpha"); repoB = join(directory, "beta");
  for (const repository of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", "-b", "main", repository]);
    await mkdir(join(repository, "secrets")); await writeFile(join(repository, "secrets", "config.env"), "TOKEN=fixture\n"); await writeFile(join(repository, "README.md"), "Policy fixture\n");
    execFileSync("git", ["add", "."], { cwd: repository }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repository });
  }
  const port = Number(process.env.QA_FS_PORT) || await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const selected = (probe.address() as AddressInfo).port; probe.close(() => resolve(selected)); }); });
  assert.ok(port !== 4317 && port !== 4318);
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "data"), CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (attempt === 149) throw new Error("Server did not start"); await new Promise((resolve) => setTimeout(resolve, 100)); }
  projectA = (await api("/api/projects", { name: "Policy Alpha", repos: [repoA] })).body.id;
  projectB = (await api("/api/projects", { name: "Policy Beta", repos: [repoB] })).body.id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const finished = (request: import("playwright-core").Request) => { if (finiteRequests.delete(request)) lastRequestFinished = Date.now(); };
  page.on("request", request => { if (trackFiniteReads && new URL(request.url()).pathname.startsWith("/api/")) finiteRequests.add(request); });
  page.on("requestfinished", finished); page.on("requestfailed", finished);
  // Headers arrive after the server has finished its admission-protected work.
  // Waiting for browser body-consumption events can retain cached/streaming reads indefinitely.
  page.on("response", response => finished(response.request()));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?token=${token}`);
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("closing the last terminal opens no other, even after a reload, so a confirmed restriction applies; it can be removed in one step", { timeout: 90_000 }, async () => {
  const shellRequests: string[] = [];
  const observe = (request: import("playwright-core").Request) => { const path = new URL(request.url()).pathname; if (/^\/api\/shell(\/[^/]+)?$/.test(path) && request.method() !== "GET") shellRequests.push(`${request.method()} ${path}`); };
  page.on("request", observe);
  try {
    await newRun(projectA);
    const pane = await sidePanel("terminal"), close = pane.locator("button.sess-x");
    await close.first().waitFor({ timeout: 15_000 });
    // Mounted with the terminal already open: the case that used to open another once it closed.
    await page.reload(); await close.first().waitFor({ timeout: 15_000 });
    assert.equal((await running()).length, 1, "the reload adopts the open terminal");
    const mark = shellRequests.length;
    await closeTerminal(close.first());
    await pane.getByRole("button", { name: "Open a terminal", exact: true }).waitFor();
    await page.waitForTimeout(4_000); // longer than the 3 s poll
    assert.deepEqual(shellRequests.slice(mark).map((entry) => entry.split(" ")[0]), ["DELETE"], "nothing reopens a terminal");
    assert.deepEqual(await running(), []);
    // Back to a scope whose terminals you closed: still none.
    await newRun(projectB); await close.first().waitFor({ timeout: 15_000 });
    await newRun(projectA); await page.waitForTimeout(3_500);
    assert.equal(await close.count(), 0); assert.deepEqual((await running()).length, 1, "only Beta's terminal is open");
    await newRun(projectB); await closeTerminal(close.first()); await pane.getByRole("button", { name: "Open a terminal", exact: true }).waitFor();
    await page.waitForTimeout(3_500); assert.deepEqual(await running(), []);
  } finally { page.off("request", observe); }

  const puts: string[] = []; const observePuts = (request: import("playwright-core").Request) => { if (request.method() === "PUT") puts.push(request.url()); };
  page.on("request", observePuts);
  try {
    const panel = await policyPanel(projectA);
    assert.equal(await panel.getByRole("button", { name: "Remove restrictions", exact: true }).count(), 0, "nothing to remove while unrestricted");
    await panel.getByLabel("Read deny paths", { exact: true }).fill("secrets");
    await panel.getByRole("button", { name: "Apply policy", exact: true }).click();
    const dialog = page.locator("dialog.confirmation-dialog");
    await dialog.waitFor(); assert.match(await dialog.innerText(), /Policy Alpha[\s\S]*every project/);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await dialog.waitFor({ state: "detached" });
    assert.deepEqual(puts, [], "cancelling sends nothing"); assert.equal((await api(`/api/projects/${projectA}/filesystem-policy`)).body.revision, 0);
    for (const deadline = Date.now() + 10_000; ;) {
      await panel.getByRole("button", { name: "Apply policy", exact: true }).click();
      await dialog.getByRole("button", { name: "Apply restriction", exact: true }).click();
      const outcome = await Promise.race([panel.getByRole("status").getByText("Filesystem policy revision 1 applied.", { exact: true }).waitFor().then(() => "applied"), panel.getByRole("alert").waitFor().then(() => panel.getByRole("alert").innerText())]);
      if (outcome === "applied") break;
      // Discovery or repository reads can still hold a policy lease just after boot; never terminals.
      assert.match(outcome, /Wait for active application operations/); assert.ok(Date.now() < deadline, outcome);
    }
    await panel.getByRole("button", { name: "Apply policy", exact: true }).click();
    await panel.getByRole("status").getByText("No changes to apply: revision 1 already has these rules.", { exact: true }).waitFor();
    assert.equal((await api(`/api/projects/${projectA}/filesystem-policy`)).body.revision, 1, "an unchanged save is no new revision");
    await panel.getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await dialog.getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await panel.getByRole("status").getByText("Filesystem policy revision 2 applied.", { exact: true }).waitFor();
    const saved = (await api(`/api/projects/${projectA}/filesystem-policy`)).body;
    assert.deepEqual([saved.read, saved.write], [{ allow: ["."], deny: [] }, { allow: ["."], deny: [] }]);
  } finally { page.off("request", observePuts); }
  assert.deepEqual(errors, []);
});

test("under a restriction in one project, settings, health, the composer, terminals and the browser say it's paused and why, and ask for nothing they'd be refused", { timeout: 90_000 }, async () => {
  // Applied elsewhere (the API), then a fresh load: the app learns of it at boot.
  await page.goto("about:blank");
  let applied = await api(`/api/projects/${projectA}/filesystem-policy`);
  for (let attempt = 0; attempt < 50; attempt++) {
    applied = await api(`/api/projects/${projectA}/filesystem-policy`, { revision: (await api(`/api/projects/${projectA}/filesystem-policy`)).body.revision, read: { allow: ["."], deny: ["secrets"] }, write: { allow: ["."], deny: [] } }, "PUT");
    if (applied.status !== 409 || !/Wait for active application operations/.test(applied.body.error)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const refused: string[] = [], asked: string[] = [];
  page.on("response", (response) => { if (response.url().includes("/api/") && response.status() >= 400) refused.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("request", (request) => { const path = new URL(request.url()).pathname; if (/^\/api\/(shell|serve|browser|model-catalog|models|doctor|workspace-projects|github)/.test(path)) asked.push(`${request.method()} ${path}`); });
  await page.goto(`${base}/#/settings/agents`);
  const notice = page.locator(".policy-pause").first(); await notice.waitFor();
  assert.match(await notice.innerText(), /“Policy Alpha” has a custom filesystem restriction/);
  assert.equal(await notice.getByRole("link", { name: "Review the filesystem policy" }).getAttribute("href"), "#/settings/projects");
  const settings = await page.locator("main").innerText();
  for (const text of ["Checking health…", "Install this CLI", "Not installed"]) assert.equal(settings.includes(text), false, text);
  assert.equal(await page.getByText("Paused by filesystem policy", { exact: true }).count(), 3, "each provider card says it's paused");
  await page.getByRole("button", { name: "Health & usage", exact: true }).click();
  const health = page.locator("dialog.health"); await health.getByText("Provider health checks are paused", { exact: false }).waitFor();
  assert.equal((await health.innerText()).includes("Checking…"), false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Application menu:/ }).click();
  assert.match(await page.getByRole("menu").last().innerText(), /3 providers · paused by filesystem policy/); await page.keyboard.press("Escape");

  await newRun(projectB);
  await page.getByLabel("Task", { exact: true }).fill("A task in an unrestricted project");
  await page.locator(".composer-problem").getByText("Agent runs are paused by a project's filesystem restriction", { exact: true }).waitFor();
  assert.equal(await page.locator(".task-start").isDisabled(), true);
  assert.match(await page.locator(".policy-pause").first().innerText(), /Agent runs are paused: project “Policy Alpha”/);
  // Starting from GitHub lists with `gh` under your login: paused too, said in the picker instead of "Loading from GitHub…".
  await page.locator(".composer .bar").getByRole("button", { name: "GitHub", exact: true }).click();
  const picker = page.locator("dialog.gh-picker"), pickerPause = picker.locator(".policy-pause");
  await pickerPause.waitFor();
  assert.match(await pickerPause.innerText(), /^GitHub issues and pull requests can't be listed: project “Policy Alpha” has a custom filesystem restriction/);
  await picker.getByRole("radio", { name: "Pull requests", exact: true }).click(); await page.waitForTimeout(500);
  assert.equal(await picker.getByText("Loading from GitHub…", { exact: true }).count(), 0);
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await (window as any).axe.run("dialog.gh-picker", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a"] } })).violations.map((violation: { id: string }) => violation.id)), []);
  await pickerPause.getByRole("link", { name: "Review the filesystem policy" }).click();
  await picker.waitFor({ state: "hidden" }); assert.match(page.url(), /#\/settings\/projects$/, "the link closes the picker on its way to the policy");
  await newRun(projectB);

  const terminal = await sidePanel("terminal");
  await terminal.getByText("Terminals are paused", { exact: false }).waitFor();
  await page.reload(); await terminal.getByText("Terminals are paused", { exact: false }).waitFor(); await page.waitForTimeout(3_500);
  const browserPane = await sidePanel("browser");
  await browserPane.getByText("Interactive browsing is paused", { exact: false }).waitFor();
  assert.equal(await browserPane.locator(".live-browser-toolbar [role=status]").innerText(), "Browser unavailable");
  assert.equal(await browserPane.getByRole("button", { name: "Go", exact: true }).isDisabled(), true);
  await page.waitForTimeout(6_000); // past the 5 s serve poll
  assert.deepEqual(asked, [], "no terminal, service, browser, catalog, model, health, connected-project or GitHub request");
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => (await (window as any).axe.run("#side-pane-browser, .composer, .policy-pause", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a"] } })).violations.map((violation: { id: string }) => violation.id));
  assert.deepEqual(violations, []);
  assert.deepEqual(refused.filter((entry) => !/\/api\/(team-rollout|experience)$/.test(entry)), [], "only boot reads of unscoped private data are refused");
  assert.deepEqual(errors, []);
});

test("a policy panel opened before the policy changed elsewhere sends the save and reports the conflict instead of a stale \"no changes\"", { timeout: 60_000 }, async () => {
  const before = (await api(`/api/projects/${projectA}/filesystem-policy`)).body;
  assert.deepEqual(before.read.deny, ["secrets"], "still restricted by the previous test");
  const panel = await policyPanel(projectA);
  await panel.getByText(`Saved revision ${before.revision}`, { exact: false }).waitFor();
  await panel.getByText("This policy restricts file access", { exact: false }).waitFor();
  // Another tab (here the API) removes the restriction; this panel still holds the old revision.
  let cleared = await api(`/api/projects/${projectA}/filesystem-policy`, { revision: before.revision, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } }, "PUT");
  for (let attempt = 0; attempt < 50 && cleared.status === 409 && /Wait for active application operations/.test(cleared.body.error); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    cleared = await api(`/api/projects/${projectA}/filesystem-policy`, { revision: before.revision, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } }, "PUT");
  }
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body)); assert.equal(cleared.body.revision, before.revision + 1);
  const puts: number[] = []; const observe = (response: import("playwright-core").Response) => { if (response.request().method() === "PUT" && response.url().includes("/filesystem-policy")) puts.push(response.status()); };
  page.on("response", observe);
  try {
    // The unchanged draft matches the stale snapshot; only the server knows it is no longer in force.
    await panel.getByRole("button", { name: "Apply policy", exact: true }).click();
    await panel.getByRole("alert").getByText("Filesystem policy changed; reload before saving", { exact: false }).waitFor();
    assert.deepEqual(puts, [409], "the save was sent and refused as stale");
    assert.equal(await panel.getByText("No changes to apply", { exact: false }).count(), 0);
    const now = (await api(`/api/projects/${projectA}/filesystem-policy`)).body;
    assert.deepEqual([now.revision, now.read.deny], [before.revision + 1, []], "nothing was written over the newer revision");
    await panel.getByRole("button", { name: "Reload saved policy and keep draft", exact: true }).click();
    await panel.getByText(`Saved revision ${before.revision + 1}`, { exact: false }).waitFor();
    assert.equal(await panel.getByText("This policy restricts file access", { exact: false }).count(), 0, "the reloaded revision is unrestricted");
    assert.equal(await panel.getByLabel("Read deny paths", { exact: true }).inputValue(), "secrets", "the draft is kept");
  } finally { page.off("response", observe); }
  assert.deepEqual(errors, []);
});

test("closing terminals through the policy panel keeps them closed after restrictions are removed and the page reloads", { timeout: 90000 }, async () => {
  trackFiniteReads = true;
  const current = (await api(`/api/projects/${projectA}/filesystem-policy`)).body;
  await api(`/api/projects/${projectA}/filesystem-policy`, { revision: current.revision, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } }, "PUT");
  await newRun(projectA);
  const pane = await sidePanel("terminal");
  const open = pane.getByRole("button", { name: "Open a terminal", exact: true });
  if (await open.isVisible()) await open.click();
  await pane.locator("button.sess-x").first().waitFor();
  const panel = await policyPanel(projectA);
  await panel.getByLabel("Read deny paths", { exact: true }).fill("secrets");
  await panel.getByRole("button", { name: "Apply policy", exact: true }).click();
  await page.getByRole("dialog", { name: "Pause execution in every project?", exact: true }).getByRole("button", { name: "Apply restriction", exact: true }).click();
  await panel.getByRole("button", { name: "Close the open terminal and apply", exact: true }).click();
  const stop = page.getByRole("dialog", { name: "Stop and close terminals?", exact: true });
  if (await stop.waitFor({ timeout: 1000 }).then(() => true, () => false)) await stop.getByRole("button", { name: "Stop and close", exact: true }).click();
  await panel.getByText(/Filesystem policy revision .* applied\./).waitFor();
  await pane.getByText(/Terminals are paused/).waitFor();
  const reopened: string[] = [];
  const observe = (request: import("playwright-core").Request) => { if (new URL(request.url()).pathname === "/api/shell" && request.method() === "POST") reopened.push(request.url()); };
  page.on("request", observe);
  await panel.getByRole("button", { name: "Remove restrictions", exact: true }).click();
  await page.getByRole("dialog", { name: "Remove restrictions?", exact: true }).getByRole("button", { name: "Remove restrictions", exact: true }).click();
  await panel.getByText(/Filesystem policy revision .* applied\./).waitFor();
  await newRun(projectA);
  await page.reload();
  await sidePanel("terminal");
  await page.waitForTimeout(3500);
  assert.deepEqual(await running(), [], "closing from policy settings must not create a new terminal after reload");
  await pane.getByText(/This terminal is gone/).waitFor();
  await pane.getByRole("button", { name: "Restart", exact: true }).waitFor();
  assert.deepEqual(reopened, [], "lifting policy and reloading must never automatically POST a shell");
  page.off("request", observe);
});
