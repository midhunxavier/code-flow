// A fork explains its inherited approval limit even with an approval-capable local provider.
// Exercise the source boundary through the actual dialog and POST; fake CLIs and scratch state only.
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
const base = `http://127.0.0.1:${port}`, token = "qa-composer-fork-permissions-e2e";
const home = mkdtempSync(join(tmpdir(), "cf-qa-fork-permission-ui-")), repo = join(home, "repo");
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
before(async () => {
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Fork permission fixture\n"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "Fixture");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(home, "state"), CODEFLOW_TOKEN: token, PATH: `${root}/test/fake-bin:${process.env.PATH}` }, stdio: "ignore" });
  for (let n = 0; n < 150; n++) { if (await fetch(`${base}/api/health`, { headers }).then(r => r.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  project = (await api("/api/projects", { name: "Fork fixture", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { if (localStorage.getItem("sideOpen") === null) localStorage.setItem("sideOpen", "0"); });
  await page.goto(`${base}/?token=${token}`);
});
after(async () => { await browser?.close(); if (server?.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill("SIGTERM"); await exited; } rmSync(home, { recursive: true, force: true }); assert.deepEqual(errors, []); });


async function forkSource(tools: boolean) {
  const source = await api("/api/runs", { repo, project, pattern: "solo", task: `Source approvals ${tools}`, roles: { agent: ["codex"] }, options: {}, trust: "standard", approvals: { tools } });
  await done(source.id);
  await page.goto(`${base}/#/run/${source.id}`);
  await page.getByRole("textbox", { name: "Message agent", exact: true }).waitFor();
  await page.locator(".convo").getByRole("button", { name: /^Provider:/ }).click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fork chat", exact: true });
  await dialog.waitFor();
  return { source, dialog };
}

test("a fork names its source approval limit instead of blaming a supported provider", { timeout: 60_000 }, async () => {
  const { source, dialog } = await forkSource(false);
  for (const provider of ["Claude Code", "Codex"]) {
    if (provider === "Codex") {
      await dialog.getByRole("button", { name: /^Provider:/ }).click();
      await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
    }
    await dialog.getByRole("button", { name: /^Permissions:/ }).click();
    const ask = page.getByRole("menuitem", { name: /^Ask for approval/ });
    assert.equal(await ask.isDisabled(), true, provider);
    assert.match(await ask.innerText(), /source chat doesn't ask for approval/, provider);
    assert.doesNotMatch(await ask.innerText(), /Requires a local/, provider);
    await page.keyboard.press("Escape");
  }
  await dialog.getByPlaceholder("What should the new chat do?").fill("Keep source approval policy");
  const response = page.waitForResponse(r => r.url().endsWith(`/api/runs/${source.id}/provider-chat`) && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  const posted = await response;
  assert.equal(posted.ok(), true);
  assert.equal(posted.request().postDataJSON().tools, false);
  assert.equal((await done((await posted.json()).id)).approvals.tools, false);
});

test("a source that asks allows its supported local fork to ask", { timeout: 60_000 }, async () => {
  const { source, dialog } = await forkSource(true);
  await dialog.getByRole("button", { name: /^Permissions:/ }).click();
  const ask = page.getByRole("menuitem", { name: /^Ask for approval/ });
  assert.equal(await ask.isEnabled(), true);
  assert.match(await ask.innerText(), /Show supported tool requests/);
  await ask.click();
  assert.equal(await permission(dialog), "Ask for approval");
  await dialog.getByPlaceholder("What should the new chat do?").fill("Keep source approvals enabled");
  const response = page.waitForResponse(r => r.url().endsWith(`/api/runs/${source.id}/provider-chat`) && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  const posted = await response;
  assert.equal(posted.ok(), true);
  assert.equal(posted.request().postDataJSON().tools, true);
  assert.equal((await done((await posted.json()).id)).approvals.tools, true);
});
