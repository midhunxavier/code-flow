// Unrestricted Antigravity is a visible one-run opt-in, the fork dialog shows and applies the new chat's
// permissions, and isolated Antigravity that can't start here is explained before Send. Fake CLIs only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium, type Browser, type Page, type Locator } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = await new Promise<number>(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const p = (server.address() as { port: number }).port; server.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`, token = "qa-agy-unrestricted-e2e";
const home = mkdtempSync(join(tmpdir(), "cf-qa-agy-ui-")), repo = join(home, "repo");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, project: string;
const errors: string[] = [];
async function api(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
async function done(id: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const run = await api(`/api/runs/${id}`); if (run.status !== "running") { assert.equal(run.status, "done", run.error); return run; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Run ${id} did not finish`);
}
const permission = async (scope: Locator) => {
  const label = (await scope.locator(".chat-permissions > button").innerText()).trim();
  assert.match(label, /^Permissions:\s+/);
  return label.replace(/^Permissions:\s+/, "");
};
const optIn = () => page.getByRole("checkbox", { name: "Use unrestricted Antigravity with my existing login" });
async function showOptIn() {
  if (await optIn().isVisible()) return;
  if (!await page.locator(".composer-options").evaluate(details => (details as HTMLDetailsElement).open)) await page.getByRole("button", { name: "Edit run options", exact: true }).click();
  if (!await optIn().isVisible()) await page.locator(".advanced-controls > summary").click();
}

before(async () => {
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Unrestricted Antigravity fixture\n"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "Fixture");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(home, "state"), CODEFLOW_TOKEN: token, PATH: `${root}/test/fake-bin:${process.env.PATH}` }, stdio: "ignore" });
  for (let n = 0; n < 150; n++) { if (await fetch(`${base}/api/health`, { headers }).then(r => r.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  project = (await api("/api/projects", { name: "Antigravity fixture", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { if (localStorage.getItem("sideOpen") === null) localStorage.setItem("sideOpen", "0"); });
  await page.goto(`${base}/?token=${token}`);
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); rmSync(home, { recursive: true, force: true }); });

test("unrestricted Antigravity applies only to the run it was ticked for and is visible while it's on", { timeout: 90000 }, async () => {
  const bodies: any[] = [];
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/runs") bodies.push(request.postDataJSON()); });
  await page.goto(`${base}/#/project/${project}/new`);
  const task = page.getByRole("textbox", { name: "Task", exact: true });
  await task.waitFor();
  const composer = page.locator(".composer"), summary = page.locator(".composer-summary");
  const send = composer.getByRole("button", { name: "Send", exact: true });
  await composer.getByRole("button", { name: /^Provider:/ }).click();
  await page.getByRole("menuitem", { name: "Antigravity CLI", exact: true }).click();
  await task.fill("First Antigravity run");
  // The fake agy (1.3.6) can't run isolated: Send explains it instead of failing after the POST.
  assert.equal(await send.isDisabled(), true);
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".composer button[title*='Use unrestricted Antigravity']")?.disabled === true);
  assert.match(await send.getAttribute("title") ?? "", /can't run isolated.*Use unrestricted Antigravity/);
  assert.equal(await permission(composer), "Approve for me");

  await showOptIn();
  assert.equal(await optIn().isChecked(), false);
  await optIn().check();
  await page.getByRole("button", { name: "Edit run options", exact: true }).click();
  assert.match(await summary.innerText(), /Unrestricted Antigravity · no Code Flow sandbox/);
  assert.equal(await permission(composer), "Unrestricted", "the permission control never reads Approve for me while Antigravity runs unrestricted");
  assert.equal(await send.isDisabled(), false);
  await send.click();
  await page.waitForURL(/#\/run\//);
  const first = await done(page.url().split("#/run/")[1]!);
  assert.equal(bodies.at(-1).antigravityExecution, "native");
  assert.equal(first.permissions.antigravityExecution, "native");
  assert.equal(await page.locator(".run-head .run-unrestricted").innerText(), "Unrestricted Antigravity");
  assert.equal(await permission(page.locator(".convo")), "Unrestricted");

  await page.getByRole("button", { name: "New run", exact: true }).click();
  await task.waitFor();
  assert.doesNotMatch(await summary.innerText(), /Unrestricted/);
  assert.equal(await permission(composer), "Approve for me");
  await showOptIn();
  assert.equal(await optIn().isChecked(), false, "the next run starts isolated");
  await composer.getByRole("button", { name: /^Provider:/ }).click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  await task.fill("Second run without touching Advanced");
  await send.click();
  await page.waitForURL(url => url.hash.startsWith("#/run/") && !url.hash.includes(first.id));
  const second = await done(page.url().split("#/run/")[1]!);
  assert.equal(bodies.at(-1).antigravityExecution, "isolated");
  assert.equal(second.permissions.antigravityExecution, "isolated");
  assert.equal(await page.locator(".run-unrestricted").count(), 0);

  await page.reload();
  await page.getByRole("button", { name: "New run", exact: true }).click();
  await task.waitFor();
  await showOptIn();
  assert.equal(await optIn().isChecked(), false, "the saved project draft isn't unrestricted either");
  assert.deepEqual(errors, []);
});

test("Fork chat shows the new chat's permissions, lowers them, and refuses more than the source has", { timeout: 90000 }, async () => {
  const source = await api("/api/runs", { repo, project, pattern: "solo", task: "Fork source", roles: { agent: ["codex"] }, options: {}, trust: "standard", approvals: { tools: false } });
  await done(source.id);
  await api(`/api/runs/${source.id}/followups`, { kind: "reply", worktree: "solo", agent: "codex", message: "Widen once", trust: "full", tools: false });
  assert.equal((await done(source.id)).trust, "full");
  await page.goto(`${base}/#/run/${source.id}`);
  const convo = page.locator(".convo"), dialog = page.getByRole("dialog", { name: "Fork chat", exact: true });
  await page.getByRole("textbox", { name: "Message agent", exact: true }).waitFor();
  await convo.getByRole("button", { name: /^Provider:/ }).click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  await dialog.waitFor();
  assert.equal(await permission(dialog), "Full access", "the escalated level is shown before forking");
  await dialog.locator(".full-warn").waitFor();
  await dialog.locator(".chat-permissions > button").click();
  await page.getByRole("menuitem", { name: /^Approve for me/ }).click();
  assert.equal(await dialog.locator(".full-warn").count(), 0);
  await dialog.getByPlaceholder("What should the new chat do?").fill("Fork with less access");
  const forked = page.waitForResponse(r => r.url().endsWith(`/api/runs/${source.id}/provider-chat`) && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  const response = await forked;
  assert.deepEqual([response.request().postDataJSON().trust, response.request().postDataJSON().tools], ["standard", false]);
  const lowered = await done((await response.json()).id);
  assert.equal(lowered.trust, "standard");
  assert.equal(lowered.steps.find((step: any) => step.kind === "agent").permissions.trust, "standard");

  // The reply box's visible choice carries into the dialog.
  await page.goto(`${base}/#/run/${source.id}`);
  await page.getByRole("textbox", { name: "Message agent", exact: true }).waitFor();
  await convo.locator(".chat-permissions > button").click();
  await page.getByRole("menuitem", { name: /^Approve for me/ }).click();
  await convo.getByRole("button", { name: /^Provider:/ }).click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  assert.equal(await permission(dialog), "Approve for me");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // From a standard chat, Full access is refused before sending, and by the API.
  await page.goto(`${base}/#/run/${lowered.id}`);
  await page.getByRole("textbox", { name: "Message agent", exact: true }).waitFor();
  await convo.getByRole("button", { name: /^Provider:/ }).click();
  await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await dialog.locator(".chat-permissions > button").click();
  await page.getByRole("menuitem", { name: /^Full access/ }).click();
  await dialog.getByPlaceholder("What should the new chat do?").fill("Escalate");
  assert.match(await dialog.locator(".msg.warn").innerText(), /can't have more access/);
  assert.equal(await dialog.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const refused = await fetch(`${base}/api/runs/${lowered.id}/provider-chat`, { method: "POST", headers, body: JSON.stringify({ agent: "codex", message: "Escalate", trust: "full" }) });
  assert.equal(refused.status, 400);
  assert.deepEqual(errors, []);
});

test("Check this computer marks Antigravity that can't run isolated", { timeout: 60000 }, async () => {
  await page.goto(`${base}/#/settings/agents`);
  await page.getByText("Check this computer", { exact: true }).first().click();
  await page.getByRole("button", { name: "Check all dependencies", exact: true }).click();
  const row = page.locator(".dependency-results li", { hasText: "Antigravity CLI" });
  await row.waitFor({ timeout: 30000 });
  assert.equal(await row.locator(".badge").innerText(), "Unrestricted only");
  assert.match(await row.innerText(), /isolated Antigravity by default, which isn't available here/);
  assert.deepEqual(errors, []);
});

test("the Antigravity settings card and Health & usage say it can't run isolated, beside its login state", { timeout: 60000 }, async () => {
  await page.goto(`${base}/#/settings/agents`);
  const card = page.locator(".settings-card", { has: page.getByRole("heading", { name: "Antigravity CLI", exact: true }) });
  await card.locator(".settings-provider-status .badge.ok").filter({ hasText: "Signed in" }).waitFor();
  assert.equal(await card.locator(".settings-provider-status .badge.warn").innerText(), "Unrestricted only");
  assert.match(await card.locator(".msg.warn").first().innerText(), /isolated Antigravity by default, which isn't available here.*Use unrestricted Antigravity/s);
  // Providers that can run isolated get neither.
  const claude = page.locator(".settings-card", { has: page.getByRole("heading", { name: "Claude Code", exact: true }) });
  await claude.locator(".settings-provider-status .badge.ok").waitFor();
  assert.equal(await claude.getByText("Unrestricted only", { exact: true }).count(), 0);
  assert.equal(await claude.getByText(/isolated Antigravity/).count(), 0);

  await page.getByRole("button", { name: "Health & usage", exact: true }).click();
  const health = page.locator(".health-row", { has: page.locator(".agent.agy") });
  await health.waitFor();
  assert.match(await health.innerText(), /isolated Antigravity by default, which isn't available here/);
  assert.deepEqual(errors, []);
});


test("isolated Antigravity waits for compatibility discovery before enabling Send", { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  const pending = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await pending.route("**/api/doctor", async route => { await gate; await route.continue(); });
  await pending.addInitScript(() => localStorage.setItem("sideOpen", "0"));
  try {
    await pending.goto(`${base}/?token=${token}#/project/${project}/new`);
    const composer = pending.locator(".composer");
    await composer.getByRole("button", { name: /^Provider:/ }).click();
    await pending.getByRole("menuitem", { name: "Antigravity CLI", exact: true }).click();
    await pending.getByRole("textbox", { name: "Task", exact: true }).fill("Check compatibility before starting");
    const send = composer.getByRole("button", { name: "Send", exact: true });
    await pending.waitForFunction(() => document.querySelector<HTMLButtonElement>(".composer button[title='Checking whether Antigravity can run isolated…']")?.disabled === true);
    assert.equal(await send.isDisabled(), true);
    release();
    await pending.waitForFunction(() => document.querySelector<HTMLButtonElement>(".composer button[title*='Use unrestricted Antigravity']")?.disabled === true);
    assert.match(await send.getAttribute("title") ?? "", /can't run isolated/);
  } finally { release(); await context.close(); }
});

test("a composer opt-in stays visible for templates and never permits an isolated sweep", { timeout: 60000 }, async () => {
  await page.goto(`${base}/#/project/${project}/new`);
  await page.getByRole("textbox", { name: "Task", exact: true }).fill("Configure Antigravity permissions");
  await showOptIn();
  await optIn().check();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).selectOption("fix-review");
  // A mixed-provider template must also expose the unrestricted Antigravity choice.
  await page.getByRole("group", { name: "Builder providers", exact: true }).getByRole("button", { name: /Antigravity CLI/ }).click();
  assert.equal(await permission(page.locator(".composer")), "Unrestricted");
  await page.route("**/api/github/sweep?*", route => route.fulfill({ json: { kind: "issues", notices: [], items: [
    { key: "issue#7", ref: "#7", title: "Scratch issue", detail: "bug", selected: true, task: "Fix scratch issue", source: { kind: "issue", number: 7 } },
  ] } }));
  let requests = 0;
  await page.route("**/api/sweeps", async route => { requests++; await route.fulfill({ json: { started: [], skipped: [], failed: [] } }); });
  try {
    await page.goto(`${base}/#/project/${project}/automation/backlog`);
    await page.getByRole("button", { name: "Fix open issues", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Fix open issues", exact: true });
    await dialog.getByRole("combobox", { name: "Run with", exact: true }).selectOption("solo");
    await dialog.locator(".sweep-config > summary").click();
    await dialog.locator("#sweep-role-agent select").selectOption("agy");
    await page.waitForFunction(() => document.querySelector("#sweep-start-status")?.textContent?.includes("can't run isolated"));
    assert.equal(await dialog.getByRole("button", { name: "Start 1 run", exact: true }).isDisabled(), true);
    assert.equal(requests, 0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(errors, []);
  } finally { await page.unroute("**/api/github/sweep?*"); await page.unroute("**/api/sweeps"); }
});
