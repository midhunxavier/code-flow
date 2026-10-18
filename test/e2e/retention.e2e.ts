import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { RetentionPolicy, RetentionPreview } from "../../src/retention-policy.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "retention-browser-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let directory: string, home: string, repo: string, base: string, server: ChildProcess, browser: Browser, page: Page;
const browserErrors: string[] = [];
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>;
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); });
}
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-retention-e2e-"))); home = join(directory, "data"); repo = join(directory, "repo");
  await mkdir(join(home, "runs"), { recursive: true }); await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "Retention browser fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), old = new Date(Date.now() - 100 * 86400000);
  for (const id of ["retire-old", "protected-by-policy", "unarchived"]) {
    const run = { id, task: `Retention fixture ${id}`, pattern: "solo", repo, baseRef: commit, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(repo, ".worktrees", id), roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "safe", loop: { check: "", setup: "", copy: [], maxSteps: 5, maxMinutes: 5 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: +old, endedAt: +old, seen: true, archived: id !== "unarchived", worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [] };
    const file = join(home, "runs", `${id}.jsonl`); await writeFile(file, JSON.stringify({ seq: 1, ts: +old, runId: id, type: "run", run }) + "\n"); await utimes(file, old, old);
  }
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += String(chunk); }); server.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; ; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (server.exitCode !== null || attempt >= 100) throw new Error(`Retention server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(7000); page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => { await browser?.close(); await stop(); await rm(directory, { recursive: true, force: true }); });

test("reachable Settings retention controls preserve conflicting drafts and download an exact plan for offline apply", { timeout: 40_000 }, async () => {
  assert.equal((await fetch(base + "/api/maintenance/retention")).status, 401);
  assert.equal((await fetch(base + "/api/maintenance/retention/apply", { method: "POST", headers, body: "{}" })).status, 404, "the online API cannot delete retention targets");
  await page.goto(base + "/?token=" + token + "#/settings/data");
  const panel = page.getByRole("region", { name: "Data retention", exact: true }), field = panel.getByLabel("Retention days archivedRuns", { exact: true }); await field.waitFor();
  assert.equal(await field.inputValue(), "");
  const initial = await api<RetentionPolicy>("/api/maintenance/retention"); assert.deepEqual(Object.values(initial.days), [null, null, null, null]);
  await api("/api/maintenance/retention", { ...initial, expectedRevision: 0, days: { ...initial.days, archivedRuns: 31 } });
  await field.fill("30"); await panel.getByRole("button", { name: "Save retention settings", exact: true }).click();
  await panel.getByRole("alert").getByText(/Retention settings changed/).waitFor(); assert.equal(await field.inputValue(), "30", "concurrent save preserves the browser draft");
  await panel.getByRole("button", { name: "Reload saved settings", exact: true }).click(); await page.waitForFunction(() => (document.querySelector('[aria-label="Retention days archivedRuns"]') as HTMLInputElement)?.value === "31");
  await field.fill("30"); await panel.getByLabel("Retention protected run IDs", { exact: true }).fill("protected-by-policy");
  await panel.getByRole("button", { name: "Save retention settings", exact: true }).click(); await panel.getByRole("status").getByText("Retention settings saved. No data was deleted.", { exact: true }).waitFor();
  const policy = await api<RetentionPolicy>("/api/maintenance/retention"); assert.equal(policy.revision, 2); assert.equal(policy.days.archivedRuns, 30); assert.deepEqual(policy.keepRunIds, ["protected-by-policy"]);
  await page.reload(); await field.waitFor(); assert.equal(await field.inputValue(), "30");
  await panel.getByRole("button", { name: "Preview saved retention policy", exact: true }).click();
  const preview = panel.getByRole("region", { name: "Retention preview", exact: true }); await preview.waitFor();
  await preview.getByText("Exact selected targets · 1", { exact: true }).click(); assert.match(await preview.innerText(), /retire-old/);
  await preview.getByText(/Protected data and scan limits ·/).click(); assert.match(await preview.innerText(), /protected-by-policy.*Kept by the saved retention policy/); assert.match(await preview.innerText(), /unarchived/);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "target paths and fingerprints fit a phone viewport");
  const downloadReady = page.waitForEvent("download"); await preview.getByRole("button", { name: "Download reviewed retention plan", exact: true }).click(); const download = await downloadReady;
  const planFile = join(directory, "downloaded-plan.json"); await download.saveAs(planFile); const plan = JSON.parse(await readFile(planFile, "utf8")) as RetentionPreview;
  assert.equal(plan.policyRevision, 2); assert.equal(plan.summary.archivedRuns, 1); assert.equal(plan.truncated, false); assert.equal(plan.targets[0]!.runId, "retire-old");
  const command = ["--import", "tsx", "scripts/maintenance.ts", "retention-policy", "--plan", planFile, "--apply", "--home", home];
  assert.throws(() => execFileSync(process.execPath, command, { cwd: root, env: { ...process.env, CODEFLOW_HOME: home }, stdio: "pipe" }), /Another code-flow server/);
  await access(join(home, "runs/retire-old.jsonl")); await stop();
  const result = JSON.parse(execFileSync(process.execPath, command, { cwd: root, env: { ...process.env, CODEFLOW_HOME: home }, encoding: "utf8" })); assert.deepEqual(result.failed, []); assert.equal(result.applied.length, 1);
  await assert.rejects(access(join(home, "runs/retire-old.jsonl")), /ENOENT/); await access(join(home, "runs/protected-by-policy.jsonl")); await access(join(home, "runs/unarchived.jsonl"));
  assert.deepEqual(browserErrors, []);
});
