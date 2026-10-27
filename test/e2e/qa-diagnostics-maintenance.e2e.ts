import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url)), token = "qa-diagnostics-only", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let directory: string, home: string, repo: string, base: string, project: string, server: ChildProcess, browser: Browser, page: Page;
let output = "", expectedFailure = false, removedWorkspace = "";
const errors: string[] = [], expectedErrors: string[] = [], evidence = join(root, "output/playwright/qa-diagnostics-maintenance");
const fake = "FAKE_QA_DIAGNOSTICS_SECRET", contextToken = "sk-ant-api03-QAFAKEabcdefghijklmnop";
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const deadline = Date.now() + 15000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Diagnostics fixture timed out: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 50)); } }
async function open(hash: string) { await page.goto(`${base}/?token=${token}#/${hash}`); await page.getByRole("navigation", { name: "Runs", exact: true }).waitFor(); }
const shot = (name: string) => page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" });
function cli(...args: string[]) { try { return { code: 0, out: execFileSync(process.execPath, ["--import", "tsx", "scripts/maintenance.ts", ...args, "--home", home], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_BACKUP_PASSWORD: "scratch backup password" }, encoding: "utf8", stdio: "pipe" }), err: "" }; } catch (error) { const failure = error as { status: number; stdout: Buffer; stderr: Buffer }; return { code: failure.status, out: String(failure.stdout), err: String(failure.stderr) }; } }
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-diagnostics-"))); home = join(directory, "home"); repo = join(directory, "repo"); await mkdir(home); await mkdir(repo); await mkdir(evidence, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "Scratch diagnostics repo\n"); await writeFile(join(repo, ".gitignore"), ".worktrees/\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=qa", "-c", "user.email=qa@test", "commit", "-qm", "initial"], { cwd: repo });
  await writeFile(join(repo, "qa-secret.txt"), `api_key = "${contextToken}"\npassword="${fake} with spaces"\n`);
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  server.stdout?.on("data", chunk => output += chunk); server.stderr?.on("data", chunk => output += chunk);
  await until(() => fetch(base + "/api/health", { headers }).then(response => response.ok, () => false), Boolean);
  project = (await api("/api/projects", { name: "Diagnostics QA", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message)); page.on("response", response => { if (response.status() >= 500 && !(expectedFailure && new URL(response.url()).pathname === "/api/diagnostics")) errors.push(`Unexpected ${response.status()}: ${response.url()}`); });
  page.on("console", message => { if (message.type() === "error") { const location = message.location().url;
    const removedFileList = removedWorkspace && location.startsWith(base + "/api/fs?") && new URL(location).searchParams.get("path") === removedWorkspace && /404 \(Not Found\)/.test(message.text());
    if (removedFileList || expectedFailure && /500 \(Internal Server Error\)/.test(message.text())) expectedErrors.push(`${message.text()} at ${location}`); else errors.push(`${message.text()} at ${message.location().url}`); } });
  await page.addInitScript(({ repo, project }) => { localStorage.setItem("repo", repo); localStorage.setItem("composerProject", project); localStorage.setItem("sideOpen", "0"); }, { repo, project });
});
after(async () => { await browser?.close(); await stop(); await writeFile(join(evidence, "server.log"), output); await writeFile(join(evidence, "browser-errors.json"), JSON.stringify({ errors, expectedErrors }, null, 2)); await rm(directory, { recursive: true, force: true }); });

test("context inspector renders one intact redaction for token-shaped and quoted secrets", async () => {
  await open(`project/${project}`); await page.locator(".project-page").getByRole("button", { name: "New run", exact: true }).click();
  await page.locator(".taskbox").getByRole("button", { name: "Files", exact: true }).click(); await page.getByRole("button", { name: "Add qa-secret.txt to the task", exact: true }).click();
  if (await page.locator(".composer-options").getAttribute("open") === null) await page.locator(".composer-options > summary").click(); await page.locator(".context-inspector > summary").click(); await page.getByRole("button", { name: "Preview selected context", exact: true }).click();
  const result = page.locator(".context-inspection-results"); await result.getByText(/qa-secret.txt ·/).click(); const text = await result.innerText(); assert.ok(text.includes('api_key = "[REDACTED]"')); assert.ok(!text.includes(contextToken)); assert.ok(!text.includes(fake)); assert.ok(!text.includes("[REDACTED] TOKEN]")); await shot("context-redaction");
});

test("diagnostics export redacts JSON bodies and all authorization schemes from actual log records", async () => {
  const messages = [`Request failed: ${JSON.stringify({ api_key: fake, password: fake + " with spaces" })}`, `Authorization: token ${fake}`, `Authorization: Digest username="${fake}", realm="${fake}"`, `Cookie: session="${fake}"; csrf="${fake}"`, JSON.stringify({ password: { nested: [fake] } }), "Authorization: Basic dXNlcjpwYXNzd29yZA==", `secret=${fake} AWS_SECRET_ACCESS_KEY=${fake} xoxb-1234567890-0987654321`];
  await appendFile(join(home, "server.log"), messages.map(error => JSON.stringify({ level: "error", error })).join("\n") + "\n");
  await open("settings/advanced"); await page.getByRole("button", { name: "Collect diagnostics", exact: true }).click(); const ready = page.waitForEvent("download"); await page.getByRole("button", { name: "Export diagnostics", exact: true }).click(); const download = await ready; const path = join(directory, "diagnostics.json"); await download.saveAs(path); const text = await readFile(path, "utf8"); assert.ok(!text.includes(fake)); assert.ok(!text.includes("dXNlcjpwYXNzd29yZA==")); assert.ok(!text.includes("xoxb-1234567890-0987654321")); assert.ok(text.includes("[REDACTED]")); await page.getByText("Collected diagnostics", { exact: true }).click(); await shot("diagnostics-redacted");
});

test("deleting the selected repository still permits diagnostics, and failed collection cannot export stale data", async () => {
  await rename(repo, repo + "-away");
  try { await page.getByRole("button", { name: "Collect diagnostics", exact: true }).click(); await until(async () => page.locator(".settings-card").filter({ hasText: "Collect versions" }).textContent().then(text => text ?? ""), text => text.includes('"repository": "missing"')); assert.equal(await page.getByRole("button", { name: "Export diagnostics", exact: true }).count(), 1); await shot("missing-repository"); }
  finally { await rename(repo + "-away", repo); }
  expectedFailure = true; await page.route("**/api/diagnostics?**", route => route.fulfill({ status: 500, json: { error: "Fixture diagnostics failure" } }));
  await page.getByRole("button", { name: "Collect diagnostics", exact: true }).click(); await page.getByRole("alert").filter({ hasText: "Fixture diagnostics failure" }).waitFor(); assert.equal(await page.getByRole("button", { name: "Export diagnostics", exact: true }).count(), 0); await page.unroute("**/api/diagnostics?**"); expectedFailure = false;
});

test("archive cleanup and retention preview omit removed workspaces; CLI settings obey the real server lock", async () => {
  const started = await api("/api/runs", { repo, project, pattern: "fix-review", task: "Create a tiny scratch note", roles: { builder: ["claude"], reviewer: ["claude"] }, options: {}, loop: { check: "true" } });
  const run = await until(() => api(`/api/runs/${started.id}`), run => run.status !== "running"); assert.ok(run.worktrees.length > 0);
  await open(`run/${run.id}`); await page.getByRole("button", { name: "More run actions", exact: true }).click(); await page.getByRole("menuitem", { name: "Archive…", exact: true }).click(); removedWorkspace = run.worktrees[0].path; const dialog = page.getByRole("dialog", { name: "Archive this run", exact: true }); await dialog.getByRole("checkbox", { name: /Also delete its branches/ }).check(); await dialog.getByRole("button", { name: "Archive", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); await until(() => api(`/api/runs/${run.id}`), value => value.archived);
  await assert.rejects(access(run.worktreeDir), /ENOENT/);
  await open("settings/data"); const panel = page.getByRole("region", { name: "Data retention", exact: true }); await panel.getByLabel("Retention days attachments", { exact: true }).fill("7"); await panel.getByLabel("Retention days worktrees", { exact: true }).fill("7"); await panel.getByRole("button", { name: "Save retention settings", exact: true }).click(); await panel.getByRole("status").getByText("Retention settings saved. No data was deleted.", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Preview saved retention policy", exact: true }).click(); const preview = panel.getByRole("region", { name: "Retention preview", exact: true }); await preview.getByText(/Protected data and scan limits ·/).click(); assert.doesNotMatch(await preview.innerText(), /ENOENT|lstat|no such file/); assert.equal(await preview.locator("li").filter({ hasText: new RegExp(`^(?:attachments|worktrees) · ${run.id}:`) }).count(), 0, await preview.innerText()); await shot("retention-cleaned-workspace");
  const input = join(directory, "settings.json"), before = await readFile(join(home, "retention-policy.json"), "utf8"); await writeFile(input, before); const blocked = cli("retention-settings", "--input", input); assert.equal(blocked.code, 1); assert.match(blocked.err, /Another code-flow server/); assert.equal(await readFile(join(home, "retention-policy.json"), "utf8"), before); assert.deepEqual(errors, []);
});

test("offline CLI rejects existing backup and plan outputs and missing runs with friendly errors", async () => {
  await stop(); const backup = join(directory, "backup.cfb"), plan = join(directory, "plan.json"); assert.equal(cli("backup", "--output", backup).code, 0); const before = await readFile(backup); const duplicate = cli("backup", "--output", backup); assert.equal(duplicate.code, 1); assert.match(duplicate.err, /Backup file already exists/); assert.doesNotMatch(duplicate.err, /EEXIST|\.tmp/); assert.deepEqual(await readFile(backup), before);
  assert.equal(cli("retention-policy", "--output", plan).code, 0); const duplicatePlan = cli("retention-policy", "--output", plan); assert.equal(duplicatePlan.code, 1); assert.match(duplicatePlan.err, /Plan file already exists/); const missing = cli("compact", "--id", "nope-123"); assert.equal(missing.code, 1); assert.match(missing.err, /Run nope-123 not found/); assert.doesNotMatch(missing.err, /ENOENT|lstat/);
});
