// QA regressions for the check runner in the browser: an invalid package.json explains itself
// instead of blocking project defaults, and repository verification shows, edits and reports a
// gate's time limit, with progress and a way to cancel. Fake agents; never 4317/4318.
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
const token = "qa-check-runner-ui";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
let directory: string, broken: string, slow: string, base: string, brokenProject: string;
let child: ChildProcess, browser: Browser;

async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function repository(name: string, files: Record<string, string>): Promise<string> {
  const repo = join(directory, name); await mkdir(repo);
  for (const [path, body] of Object.entries({ "README.md": `${name}\n`, ...files })) await writeFile(join(repo, path), body);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  return repo;
}
/** A signed-in tab in a fresh browser profile that records page errors and failed API calls. */
async function open(path: string, storage: Record<string, string> = {}): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(15_000);
  await context.addInitScript((items) => { for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value); }, { sideOpen: "0", ...storage });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().includes("/api/") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/?token=${token}#/${path}`); return { page, errors };
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-check-runner-ui-")));
  broken = await repository("broken", { "package.json": "{ not json" });
  slow = await repository("slow", { "package.json": JSON.stringify({ name: "slow", scripts: { test: "sleep 20" } }) });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const port = await new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 400; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (child.exitCode !== null || attempt === 399) throw new Error(`Check runner QA server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  brokenProject = (await api("/api/projects", { name: "Broken package", repos: [broken] })).id;
  await api("/api/projects", { name: "Slow suite", repos: [slow] });
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser?.close(); if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } await rm(directory, { recursive: true, force: true }); });

test("an invalid package.json leaves project defaults saveable and says why nothing was detected", { timeout: 60_000 }, async () => {
  const { page, errors } = await open("settings/projects", { project: brokenProject });
  await page.getByLabel("Project", { exact: true }).selectOption(brokenProject);
  await page.waitForFunction(() => !(document.querySelector('[aria-label="Default check command"]') as HTMLInputElement)?.disabled);
  await page.getByRole("status").getByText("Detection: package.json is not valid JSON, so its test script was skipped.", { exact: true }).waitFor();
  assert.equal(await page.getByText(/Could not load repository defaults/).count(), 0);
  const save = page.getByRole("button", { name: "Save project defaults", exact: true });
  assert.equal(await save.isEnabled(), true);
  await page.getByLabel("Default check command", { exact: true }).fill("node -e 1");
  await save.click();
  await page.getByRole("status").getByText("Project defaults saved.").waitFor();
  await page.reload();
  await page.getByLabel("Project", { exact: true }).selectOption(brokenProject);
  await page.waitForFunction(() => (document.querySelector('[aria-label="Default check command"]') as HTMLInputElement)?.value === "node -e 1");
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("the composer explains an empty Done when for an invalid package.json", { timeout: 60_000 }, async () => {
  const { page, errors } = await open(`project/${encodeURIComponent(brokenProject)}/new`, { project: brokenProject, repo: broken });
  await page.locator(".composer-options > summary").click();
  const warning = page.locator("#checkCmd-warning");
  await warning.waitFor();
  assert.equal(await warning.textContent(), "Detection: package.json is not valid JSON, so its test script was skipped.");
  assert.equal(await page.locator("#checkCmd").inputValue(), "");
  assert.equal(await page.locator("#checkCmd").getAttribute("aria-describedby"), "checkCmd-warning");
  await page.locator("#checkCmd").fill("node -e 1");
  await warning.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("verification shows and edits each gate's timeout, reports a timeout as one, and can be cancelled", { timeout: 90_000 }, async () => {
  const { page, errors } = await open("settings/workspace", { repo: slow });
  await page.getByRole("heading", { name: "Inspect, verify, and recover" }).waitFor();
  await page.waitForFunction(() => !!(document.querySelector("#wb-folder") as HTMLSelectElement)?.value);
  await page.locator(".wb-card label", { hasText: /^Profile/ }).locator("select").selectOption("lightweight");
  await page.getByRole("button", { name: "Detect checks", exact: true }).click();
  const timeout = page.getByLabel("Timeout for unit in minutes", { exact: true });
  assert.equal(await timeout.inputValue(), "10", "a run's check timeout, not a fixed five minutes");
  await timeout.fill("0.02"); await timeout.press("Tab");
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/verification") && request.method() === "POST");
  await page.getByRole("button", { name: "Run verification", exact: true }).click();
  assert.equal((await sent).postDataJSON().profile.checks[0].timeoutMs, 1_200);
  await page.getByRole("heading", { name: "Result: needs-changes", exact: true }).waitFor({ timeout: 30_000 });
  const row = page.getByRole("row").filter({ hasText: "unit" });
  await row.getByText("Timed out", { exact: true }).waitFor();
  await row.getByText(/^Timed out after 1 s before the check finished\. If it's only slow, raise this gate's timeout/).waitFor();
  // A slow gate shows it's still running, for how long, and stops when asked.
  await timeout.fill("0.5"); await timeout.press("Tab");
  await page.getByRole("button", { name: "Run verification", exact: true }).click();
  const progress = page.getByRole("status").filter({ hasText: /Running verification · \d+ s so far/ });
  await progress.waitFor();
  await page.getByRole("button", { name: "Cancel verification", exact: true }).click();
  await page.getByText("Verification cancelled", { exact: true }).waitFor();
  await progress.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("heading", { name: /^Result:/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Run verification", exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  await page.context().close();
});
