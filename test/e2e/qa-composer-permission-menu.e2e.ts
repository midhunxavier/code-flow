// QA regressions for the composer's Permissions control in the browser: what it shows, Run details and
// the start request agree for a repository's Trusted default, Safe/Trusted picks, a fresh Claude
// conversation, Docker isolation and Antigravity roles. Fake agents; never 4317/4318.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-permission-menu";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
let directory: string, home: string, base: string, port: number, child: ChildProcess, browser: Browser;
const projects: Record<"plain" | "trusted", string> = { plain: "", trusted: "" };
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function repository(name: string, config: Record<string, string>) {
  const repo = join(directory, name); await mkdir(join(repo, ".codeflow"), { recursive: true });
  await writeFile(join(repo, "README.md"), `${name}\n`); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify(config));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  return (await api("/api/projects", { name, repos: [repo] })).id as string;
}
/** A fresh, signed-in browser on a project's new-run page; `errors` records page errors and failed API calls. */
async function composer(project: string, storage: Record<string, string> = {}): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(10_000);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().includes("/api/") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/?token=${token}`);
  await page.evaluate((values) => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, storage);
  await page.goto(`${base}/#/project/${encodeURIComponent(project)}/new`);
  await page.getByRole("textbox", { name: "Task", exact: true }).waitFor();
  await page.waitForFunction(() => !/Loading|Checking|Restoring/.test(document.querySelector(".task-start")?.getAttribute("title") ?? ""));
  return { page, errors, close: () => context.close() };
}
const permissions = (page: Page) => page.locator(".taskbox").getByRole("button", { name: /^Permissions:/ });
async function choose(page: Page, name: string) { await permissions(page).click(); await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click(); }
async function checked(page: Page) {
  await permissions(page).click();
  const items = await page.getByRole("menuitem").evaluateAll((elements) => elements.filter((element) => element.querySelector(".chat-choice-check")).map((element) => element.firstElementChild?.firstChild?.textContent ?? ""));
  await page.keyboard.press("Escape"); return items;
}
async function runOptions(page: Page) { if (!await page.locator("details.composer-options").evaluate((element) => (element as HTMLDetailsElement).open)) await page.getByRole("button", { name: "Edit run options" }).click(); }
async function runDetails(page: Page, label: string) {
  await runOptions(page);
  const details = page.locator("details.effective-settings");
  if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) await details.locator("summary").click();
  return (await details.locator("tr").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) }).locator("td").allInnerTexts()).join(" | ");
}
async function send(page: Page, task: string) {
  await page.getByRole("textbox", { name: "Task", exact: true }).fill(task);
  const posted = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.request().method() === "POST");
  await page.locator(".task-start").click();
  const response = await posted;
  return { status: response.status(), body: JSON.parse(response.request().postData()!), result: await response.json() };
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-permission-menu-"))); home = join(directory, "home");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  port = await new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 400; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (child.exitCode !== null || attempt === 399) throw new Error(`Permission menu QA server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  projects.plain = await repository("plain", { check: "true" });
  projects.trusted = await repository("trusted", { trust: "trusted", check: "true" });
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } await rm(directory, { recursive: true, force: true }); });

test("a repository's Trusted default is what the control shows, Run details lists and the run gets", { timeout: 60_000 }, async () => {
  const { page, errors, close } = await composer(projects.trusted);
  assert.equal(await permissions(page).innerText(), "Permissions:\nTrusted", "never Ask for approval over trusted shell access");
  assert.deepEqual(await checked(page), ["Trusted"]);
  assert.equal(await runDetails(page, "Permissions"), "trusted | .codeflow/config.json");
  assert.match(await runDetails(page, "Tool permissions"), /^Decline requests requiring interaction/);
  const { status, body, result } = await send(page, "Trusted default fixture");
  assert.equal(status, 201, JSON.stringify(result));
  assert.equal(body.trust, "trusted"); assert.equal(body.approvals.tools, false);
  const run = await api(`/api/runs/${result.id}`);
  assert.deepEqual([run.permissions.trust, run.permissions.toolApprovals], ["trusted", false]);
  assert.deepEqual(errors, []); await close();
});

test("Safe and Trusted stay in the menu so a level can be chosen again", { timeout: 60_000 }, async () => {
  const { page, errors, close } = await composer(projects.trusted, { interactiveApprovals: "0" });
  await choose(page, "Approve for me");
  assert.equal(await permissions(page).innerText(), "Permissions:\nApprove for me");
  await choose(page, "Trusted");
  assert.equal(await permissions(page).innerText(), "Permissions:\nTrusted");
  assert.deepEqual(await checked(page), ["Trusted"]);
  await choose(page, "Safe");
  assert.equal(await permissions(page).innerText(), "Permissions:\nSafe");
  assert.deepEqual(await checked(page), ["Safe"]);
  assert.equal(await page.evaluate(() => localStorage.getItem("trust")), "safe");
  assert.match(await runDetails(page, "Tool permissions"), /^Decline requests requiring interaction \| Safe permissions/);
  assert.deepEqual(errors, []); await close();
});

test("a fresh Claude conversation asks, and Run details and a saved template say so", { timeout: 60_000 }, async () => {
  const { page, errors, close } = await composer(projects.plain);
  assert.equal(await permissions(page).innerText(), "Permissions:\nAsk for approval");
  assert.equal(await runDetails(page, "Tool permissions"), "Ask for supported native requests | Default for Claude and Codex conversations");
  await page.getByRole("textbox", { name: "Task", exact: true }).fill("Template fixture");
  await page.locator(".taskbox").getByRole("button", { name: "Run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save as template…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as template" });
  await dialog.getByLabel("Template name").fill("Fresh");
  await dialog.getByRole("button", { name: "Save template", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const saved = await page.evaluate((project) => JSON.parse(localStorage.getItem(`composerLibrary:${project}`)!).templates[0].config.toolApprovals, projects.plain);
  assert.equal(saved, true, "the template records what the run would get");
  const { status, body, result } = await send(page, "Fresh conversation fixture");
  assert.equal(status, 201, JSON.stringify(result)); assert.equal(body.approvals.tools, true);
  await page.goto(`${base}/#/project/${encodeURIComponent(projects.plain)}/new`);
  await choose(page, "Approve for me");
  assert.equal(await runDetails(page, "Tool permissions"), "Decline requests requiring interaction | Explicit choice");
  assert.deepEqual(errors, []); await close();
});

test("Docker isolation starts with the permission the control shows and keeps the preference", { timeout: 60_000 }, async () => {
  const { page, errors, close } = await composer(projects.plain);
  await runOptions(page);
  const isolation = page.locator("details.agent-isolation");
  await isolation.locator("summary").click();
  const box = isolation.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image" });
  await box.check();
  assert.equal(await permissions(page).innerText(), "Permissions:\nApprove for me");
  assert.equal(await runDetails(page, "Tool permissions"), "Decline requests requiring interaction | Unavailable with Docker isolation");
  await box.uncheck();
  assert.equal(await permissions(page).innerText(), "Permissions:\nAsk for approval", "turning isolation off restores the choice");
  await box.check();
  await isolation.getByRole("textbox", { name: "Image" }).fill("qa-agents:local");
  const { status, body, result } = await send(page, "Docker fixture");
  assert.equal(status, 201, JSON.stringify(result));
  assert.equal(body.approvals.tools, false); assert.equal(body.loop.agentContainer.image, "qa-agents:local");
  assert.deepEqual(errors, []); await close();
});

test("Antigravity is left out of default checking roles after Ask for approval, and an explicit pick is explained before Start", { timeout: 60_000 }, async () => {
  const { page, errors, close } = await composer(projects.plain, { interactiveApprovals: "1" });
  // As on a Mac with a verified Antigravity login; the start request is read, never sent.
  await page.route("**/api/doctor", async (route) => { const response = await route.fetch(); await route.fulfill({ response, json: (await response.json()).map((entry: { id: string }) => entry.id === "agy" ? { ...entry, managedCompatible: true } : entry) }); });
  const bodies: any[] = [];
  await page.route("**/api/runs", async (route) => { if (route.request().method() !== "POST") return route.continue(); bodies.push(JSON.parse(route.request().postData()!)); await route.fulfill({ status: 400, json: { error: "Intercepted" } }); });
  await page.reload(); await page.getByRole("textbox", { name: "Task", exact: true }).fill("Antigravity fixture");
  await runOptions(page);
  await page.locator("details.advanced-controls > summary").click();
  const start = page.locator(".task-start");
  for (const [workflow, role] of [["pipeline", "reviews"], ["race", "picks the best"], ["debate", "writes the final plan"]] as const) {
    await page.locator("#workflow-select").selectOption(workflow);
    assert.doesNotMatch(await page.locator(".pattern-why").innerText(), new RegExp(`Antigravity CLI ${role}`), workflow);
    assert.equal(await start.isDisabled(), false);
  }
  await page.locator("#workflow-select").selectOption("fix-review");
  await page.getByRole("group", { name: "Reviewer providers" }).getByRole("button", { name: /Antigravity/ }).click();
  assert.equal(await permissions(page).innerText(), "Permissions:\nAsk for approval");
  assert.equal(await start.isDisabled(), true);
  assert.match(await start.getAttribute("title") ?? "", /^Antigravity can't ask for approval\..*Claude or Codex for Reviewer\.$/);
  await page.getByRole("group", { name: "Builder providers" }).getByRole("button", { name: /Antigravity/ }).click();
  assert.equal(await permissions(page).innerText(), "Permissions:\nApprove for me", "nothing in this run can ask");
  assert.equal(await start.isDisabled(), false);
  await start.click();
  await page.getByText("Intercepted").waitFor();
  assert.equal(bodies.at(-1).approvals.tools, false); assert.deepEqual(bodies.at(-1).roles, { builder: ["agy"], reviewer: ["agy"] });
  await page.getByRole("group", { name: "Builder providers" }).getByRole("button", { name: /Codex/ }).click();
  assert.equal(await permissions(page).innerText(), "Permissions:\nAsk for approval", "the choice comes back with a provider that asks");
  assert.deepEqual(errors, []); await close();
});
