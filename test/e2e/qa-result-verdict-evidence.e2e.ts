// QA regressions in the browser: a pass that relies on a deleted test is flagged where the result
// is summarised (not only in collapsed details), a race shows its winner first with each
// candidate's own check, an AI team's verified result reads as verified in the chat, and a
// requested comparison and its preview survive a reload. Fake agents; never ports 4317/4318.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-verdict-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string;
const errors: string[] = [];
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value).slice(0, 1500)}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
}
const finished = (id: string) => until(() => api(`/api/runs/${id}`), run => run.status !== "running");
async function fixture(name: string, files: Record<string, string>) {
  const repo = join(directory, name);
  await mkdir(join(repo, ".codeflow"), { recursive: true });
  for (const [path, text] of Object.entries({ "README.md": "Quick check fixture\n", ".codeflow/config.json": JSON.stringify({ prove: false }), ...files })) await writeFile(join(repo, path), text);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  return repo;
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-verdict-e2e-")));
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  assert.ok(port !== 4317 && port !== 4318);
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  // FAKE_TAMPER: a builder working where failing.test.mjs exists deletes it instead of fixing the code.
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: token, FAKE_TAMPER: "1", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.url().startsWith(base + "/api/") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(base + "/?token=" + token);
  await page.addInitScript(() => { localStorage.setItem("sideOpen", "0"); });
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});
afterEach(async context => { if ((context as unknown as { error?: unknown }).error && page) { console.error("Browser errors", errors); console.error((await page.locator("body").innerText()).slice(0, 5000)); } });

test("a pass that deletes the failing test is flagged on the result card and the review page (t07-2)", { timeout: 120_000 }, async () => {
  const repo = await fixture("tamper", {
    "failing.test.mjs": 'import { test } from "node:test"; import assert from "node:assert"; test("broken", () => assert.ok(false));\n',
    "ok.test.mjs": 'import { test } from "node:test"; import assert from "node:assert"; test("fine", () => assert.ok(true));\n',
  });
  const started = await api("/api/runs", { repo, pattern: "fix-review", task: "Make the tests pass", roles: { builder: ["codex"], reviewer: ["claude"] }, loop: { check: "node --test *.test.mjs" } });
  const run = await finished(started.id);
  assert.equal(run.status, "done", run.error);
  const branch = run.artifacts[0].branch;
  assert.equal(run.integrity?.[branch]?.[0]?.kind, "deleted-test");
  await page.goto(base + `/#/run/${run.id}`);
  const studio = page.locator("section.result-studio");
  await studio.waitFor();
  assert.equal(await page.locator("details.result-details").evaluate(element => (element as HTMLDetailsElement).open), false, "details stay collapsed");
  const note = studio.locator(".integrity");
  await note.getByText("Changes to tests to check before merging").waitFor();
  assert.ok(await note.isVisible()); assert.match(await note.innerText(), /failing\.test\.mjs/);
  await studio.getByRole("heading", { name: "Check the test changes before merging", exact: true }).waitFor();
  assert.match(await studio.locator(".result-primary .help").first().innerText(), /Checks: Passed · tests changed/);
  await studio.getByRole("button", { name: "Review changes", exact: true }).click();
  const overview = page.locator(".review-overview");
  await overview.locator(".integrity").waitFor();
  assert.ok(await overview.locator(".integrity").isVisible(), "visible without opening Publish changes");
  const checks = overview.locator(".run-evidence div").filter({ hasText: "Checks" }).locator("dd");
  assert.equal(await checks.innerText(), "Passed · tests changed");
  assert.match(await checks.getAttribute("class") ?? "", /evidence-warn/);
  assert.doesNotMatch(await checks.getAttribute("class") ?? "", /evidence-ok/);
  assert.deepEqual(errors, []);
});

test("a race shows its winner first, and each candidate with its own check (t07-5)", { timeout: 120_000 }, async () => {
  const repo = await fixture("race", {});
  // Both candidates pass; the fake judge picks B.
  const started = await api("/api/runs", { repo, pattern: "race", task: "Race me", roles: { contestants: ["claude", "codex"], judge: ["claude"] }, loop: { check: "true" } });
  const run = await finished(started.id);
  assert.equal(run.status, "done", run.error);
  const b = run.worktrees.find((tree: any) => tree.name === "candidate-b").branch;
  assert.equal(run.artifacts[0].branch, b);
  await page.goto(base + `/#/run/${run.id}`);
  const studio = page.locator("section.result-studio");
  const select = studio.getByLabel("Result branch");
  await select.waitFor();
  assert.equal(await select.inputValue(), "candidate-b", "the winner is shown by default");
  assert.match(await studio.locator(".result-primary .help").first().innerText(), /Checks: Passed · Review: Not recorded$/);
  await select.selectOption("candidate-a");
  await studio.locator(".result-primary .help").filter({ hasText: "Checks: Passed" }).waitFor();
  assert.doesNotMatch(await studio.locator(".result-primary .help").first().innerText(), /Not verified for this branch/);
  await select.selectOption("candidate-b");
  await studio.getByRole("button", { name: "Review changes", exact: true }).click();
  const checks = page.locator(".review-overview .run-evidence div").filter({ hasText: "Checks" }).locator("dd");
  await checks.waitFor();
  assert.equal(await checks.innerText(), "Passed", "the winner's own check, on the Review page too");
  assert.deepEqual(errors, []);
});

test("a chat that applied a verified AI team result reads as verified (t10-7, t11-4)", { timeout: 150_000 }, async () => {
  const repo = await fixture("team", {});
  const started = await api("/api/runs", { repo, pattern: "solo", task: "AUTO-MINIMAL implement the requested result", roles: { agent: ["claude"] }, loop: { check: "test -f claude-alpha.txt" }, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 16, maxMinutes: 5, approvePlan: false } });
  const chat = await until(() => api(`/api/runs/${started.id}`), run => run.status !== "running" && !!run.teamTurns?.[0]?.report, 120_000);
  assert.equal(chat.status, "done", chat.error);
  const execution = await api(`/api/runs/${chat.teamTurns[0].executionId}`);
  assert.equal(execution.team.verification.approved, true, JSON.stringify(execution.team.verification));
  assert.equal(chat.teamTurns[0].teamEvidence?.check?.ok, true);
  await page.goto(base + `/#/run/${chat.id}`);
  await page.locator(".result-compact .result-primary").filter({ hasText: "Checks: Passed · Review: Approved" }).waitFor();
  await page.locator(".result-compact").getByRole("heading", { name: "Ready to review", exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("a requested comparison stays requested after a reload, and its running preview comes back (t07-18)", { timeout: 150_000 }, async () => {
  const appHtml = "<html lang=\"en\"><head><title>Alternative fixture</title></head><body><main>Alternative fixture</main></body></html>";
  const repo = await fixture("alternatives", { "app.cjs": `require('http').createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(${JSON.stringify(appHtml)})).listen(Number(process.env.PORT), '127.0.0.1');` });
  const started = await api("/api/runs", { repo, pattern: "solo", checkpointOnFinish: true, task: "Prepare the layout", roles: { agent: ["claude"] }, loop: { check: "true", maxSteps: 8, maxMinutes: 2 } });
  const result = await finished(started.id);
  assert.equal(result.status, "done", result.error);
  await page.goto(base + `/#/run/${result.id}`);
  const open = async () => { await page.locator(".result-more > summary").click(); await page.locator(".alternatives > summary").click(); };
  await open();
  await page.getByLabel("Alternative A", { exact: true }).fill("Use compact spacing.");
  await page.getByLabel("Alternative B", { exact: true }).fill("Use spacious spacing.");
  await page.getByRole("button", { name: "Build both alternatives", exact: true }).click();
  const children = await until(() => api<any[]>("/api/runs"), values => values.filter(value => value.parentRunId === result.id && value.group).length === 2);
  const group = children.find(value => value.parentRunId === result.id && value.group).group.id;
  await until(() => api<any[]>("/api/runs"), values => values.filter(value => value.group?.id === group).every(value => value.status !== "running"));
  const first = page.locator(".alternative-preview").first();
  await first.getByRole("link", { name: "Choose and continue" }).waitFor();
  await first.getByLabel("Preview command").fill("node app.cjs");
  await first.getByRole("button", { name: "Preview alternative" }).click();
  await page.locator(".alternative-preview iframe").waitFor();

  await page.reload();
  await open();
  await page.locator(".alternatives").getByText(/^Comparison requested/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Build both alternatives", exact: true }).count(), 0, "a second comparison is not one click away");
  await page.locator(".alternative-preview iframe").waitFor();
  assert.equal(await page.locator(".alternative-preview").first().getByLabel("Preview command").inputValue(), "node app.cjs");
  assert.equal((await api<any[]>("/api/runs")).filter(value => value.parentRunId === result.id && value.group).length, 2);
  // Another pair is a deliberate choice, starting from the instructions already used.
  await page.getByRole("button", { name: "Try another pair…", exact: true }).click();
  await page.waitForFunction(() => document.activeElement === document.querySelector(".alternatives textarea"));
  assert.equal(await page.getByLabel("Alternative A", { exact: true }).evaluate(element => element === document.activeElement), true, "the form opens in its first field");
  assert.equal(await page.getByLabel("Alternative A", { exact: true }).inputValue(), "Use compact spacing.");
  assert.equal(await page.getByLabel("Alternative B", { exact: true }).inputValue(), "Use spacious spacing.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".alternatives").getByText(/^Comparison requested/).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "Try another pair…");
  for (const child of children.filter(value => value.parentRunId === result.id && value.group)) for (const tree of child.worktrees) await fetch(base + `/api/runs/${child.id}/worktrees/${tree.name}/serve`, { method: "DELETE", headers });
  assert.deepEqual(errors, []);
});
