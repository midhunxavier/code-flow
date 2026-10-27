import { reserveQaPorts } from "../qa-port-block.js";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
const qaPorts = await reserveQaPorts(2, process.env.QA_GITHUB_PR_WATCH_PORT);
after(() => qaPorts.release());
const root = fileURLToPath(new URL("../..", import.meta.url)), scratch = mkdtempSync(join(tmpdir(), "cf-qa-watch-ui-"));
const data = join(scratch, "data"), records = join(scratch, "records"), gh = join(scratch, "gh.json"), shots = join(root, "output/playwright/qa-github-pr-watch");
const port = qaPorts.port, base = `http://127.0.0.1:${port}`, token = "qa-github-pr-watch-token";
let server: ChildProcess, browser: Browser, restart = false;
const logs: string[] = [], errors: string[] = [], expected: string[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const state = () => JSON.parse(readFileSync(gh, "utf8"));
const change = (fn: (s: any) => void) => { const s = state(); fn(s); writeFileSync(gh, JSON.stringify(s)); };
async function api(path: string, body?: unknown) { const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() }; }
async function ok(path: string, body?: unknown) { const r = await api(path, body); assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; }
async function until<T>(get: () => Promise<T>, valid: (value: T) => boolean, timeout = 20000) { const end = Date.now() + timeout; let value: T; do { value = await get(); if (valid(value)) return value; await pause(100); } while (Date.now() < end); throw new Error(`Timed out: ${JSON.stringify(value)}`); }
const done = (id: string) => until(() => ok(`/api/runs/${id}`), r => r.status !== "running");
async function start() {
  await qaPorts.release();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(port + 1), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, CODEFLOW_WATCH_INTERVAL_MS: "1000", SHELL: join(scratch, "bash"), BASH_ENV: "", ENV: "", FAKE_GH_STATE: gh, FAKE_CI_TAMPER: "workflow", FAKE_RECORD_DIR: records, FAKE_NO_APP_SERVER: "1", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", value => logs.push(String(value)));
  for (let n = 0; n < 200; n++) { if (await api("/api/health").then(r => r.status === 200, () => false)) return; await pause(100); } throw new Error(logs.join(""));
}
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; const ended = new Promise<void>(resolve => server.once("exit", () => resolve())); const timer = setTimeout(() => server.kill("SIGKILL"), 5000); server.kill("SIGTERM"); await ended; clearTimeout(timer); }
async function page(hash: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.addInitScript(() => localStorage.setItem("sideOpen", "0"));
  const p = await context.newPage(); p.setDefaultTimeout(15000); p.on("pageerror", error => errors.push(error.message));
  p.on("console", message => { if (message.type() !== "error") return; const url = message.location().url, text = message.text(); const isRestart = restart && url.startsWith(base + "/api/") && /net::ERR_(?:CONNECTION_REFUSED|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING)/.test(text); (isRestart ? expected : errors).push(`${text} [${url}]`); });
  await p.goto(`${base}/?token=${token}${hash}`); return p;
}
async function publishPanel(p: Page, run: any) { await p.goto(`${base}/#/review/${run.id}/${run.artifacts[0].branch}`); await p.locator("details.review-delivery > summary").click(); await p.locator(".watch").waitFor(); }
async function fixture(publish = true) {
  const dir = mkdtempSync(join(scratch, "fixture-")), repo = join(dir, "repo"), origin = join(dir, "origin.git"); mkdirSync(repo); mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main"); git(repo, "init", "-q", "-b", "main"); mkdirSync(join(repo, ".github/workflows"), { recursive: true }); mkdirSync(join(repo, ".codeflow"));
  writeFileSync(join(repo, "README.md"), "# QA scratch fixture\n"); writeFileSync(join(repo, ".github/workflows/ci.yml"), "jobs:\n  test:\n    runs-on: ubuntu-latest\n"); writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":false}');
  git(repo, "add", "."); git(repo, "commit", "-qm", "fixture"); git(repo, "remote", "add", "origin", origin); git(repo, "push", "-q", "origin", "main");
  await ok("/api/projects", { name: `PR watch ${readdirSync(scratch).length}`, repos: [repo] });
  let run = await ok("/api/runs", { pattern: "pipeline", repo, task: "Document the scratch fixture", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {}, trust: "standard" }); run = await done(run.id); assert.equal(run.status, "done", run.error);
  const branch = run.artifacts[0].branch; let number = 0;
  if (publish) { const opened = await ok(`/api/runs/${run.id}/pr`, { branch, into: "main" }); number = Number(opened.url.split("/").at(-1)); run = await ok(`/api/runs/${run.id}`); }
  return { run, repo, origin, branch, number, tree: run.worktrees.find((t: any) => t.branch === branch) };
}
const watched = (id: string, branch: string, predicate: (w: any) => boolean) => until(() => ok(`/api/runs/${id}`), r => predicate(r.watches[branch]));
before(async () => {
  mkdirSync(shots, { recursive: true }); mkdirSync(records); writeFileSync(gh, '{"prs":{},"issues":[]}'); writeFileSync(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start(); browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async () => { for (const context of browser.contexts()) await context.close(); change(s => { delete s.failAll; delete s.commentError; }); const runs = await ok("/api/runs"); for (const run of Array.isArray(runs) ? runs : runs.runs) for (const branch of Object.keys(run.watches ?? {})) await ok(`/api/runs/${run.id}/watch`, { branch, stop: true }); });
after(async () => { await browser?.close(); await stop(); writeFileSync(join(shots, "server.log"), logs.join("")); writeFileSync(join(shots, "browser.json"), JSON.stringify({ errors, expectedRestartErrors: expected }, null, 2)); rmSync(scratch, { recursive: true, force: true }); });

test("Most fixes preserves invalid input and refuses invalid API values; closed PR can be reopened", async () => {
  const { run, branch, number } = await fixture(), p = await page(`#/run/${run.id}`); await publishPanel(p, run);
  for (const value of ["0", "", "2.5", "25", "-1"]) { await p.getByLabel("Most fixes").fill(value); assert.equal(await p.getByLabel("Most fixes").inputValue(), value); assert.equal(await p.getByRole("button", { name: "Watch PR", exact: true }).isDisabled(), true); await p.getByRole("alert").filter({ hasText: /integer from 1 to 10/ }).waitFor(); }
  for (const maxFixes of [0, "", null, 25, -1, 2.5, "2"]) { const invalid = await api(`/api/runs/${run.id}/watch`, { branch, agent: "claude", maxFixes }); assert.equal(invalid.status, 400, JSON.stringify(invalid)); }
  await p.screenshot({ path: join(shots, "invalid-watch-limit.png"), fullPage: true }); await p.getByLabel("Most fixes").fill("1"); await p.getByRole("button", { name: "Watch PR", exact: true }).click(); await watched(run.id, branch, w => w?.state === "green");
  change(s => s.prs[number].state = "CLOSED"); await watched(run.id, branch, w => w?.state === "closed"); await p.getByRole("button", { name: "Watch again", exact: true }).waitFor();
  change(s => s.prs[number].state = "OPEN"); await p.getByRole("button", { name: "Watch again", exact: true }).click(); await watched(run.id, branch, w => w?.state === "green");
  change(s => s.prs[number].state = "MERGED"); const merged = await watched(run.id, branch, w => w?.state === "closed"); assert.equal(merged.merges.filter((m: any) => m.pr === run.prs[branch]).length, 1); await p.getByText("PR merged into main", { exact: true }).waitFor(); assert.equal(await p.getByRole("button", { name: "Watch again", exact: true }).count(), 0);
  assert.equal((await api(`/api/runs/${run.id}/watch`, { branch, agent: "claude" })).status, 409); await p.screenshot({ path: join(shots, "external-merge.png"), fullPage: true });
});

test("three offline polls survive server restart and recover in the open browser", async () => {
  const { run, branch } = await fixture(), p = await page(`#/run/${run.id}`); await publishPanel(p, run); await p.getByRole("button", { name: "Watch PR", exact: true }).click(); await watched(run.id, branch, w => w?.state === "green");
  change(s => s.failAll = "network offline fixture"); await watched(run.id, branch, w => w?.pollFailures >= 3); await p.locator(".watch .detail").filter({ hasText: /Couldn't check the PR 3 times/ }).waitFor(); await p.screenshot({ path: join(shots, "offline-needs-you.png"), fullPage: true });
  restart = true; await stop(); change(s => delete s.failAll); await start(); await watched(run.id, branch, w => w?.state === "green" && w.pollFailures === undefined); await p.reload(); await p.locator("details.review-delivery > summary").click(); await p.locator(".watch .detail").filter({ hasText: "All checks pass" }).waitFor(); restart = false; await p.screenshot({ path: join(shots, "recovered-after-restart.png"), fullPage: true });
});

test("blocked CI tampering stays unpublished after Watch again, new comments and restart", async () => {
  const { run, branch, origin, number } = await fixture(), beforeHead = git(origin, "rev-parse", branch), p = await page(`#/run/${run.id}`); change(s => s.prs[number].failOn = "all"); await publishPanel(p, run); await p.getByRole("button", { name: "Watch PR", exact: true }).click();
  const blocked = await watched(run.id, branch, w => w?.state === "needs-you"); assert.match(blocked.watches[branch].detail, /not pushed/); assert.equal(git(origin, "rev-parse", branch), beforeHead); assert.equal(blocked.followUps.length, 1);
  change(s => { s.prs[number].failOn = []; s.prs[number].comments.push({ id: "honest-after-tamper", author: { login: "me" }, body: "Update README only", createdAt: new Date().toISOString() }); });
  await p.getByRole("button", { name: "Watch again", exact: true }).click(); const still = await watched(run.id, branch, w => w?.state === "needs-you" && w.detail.includes("Unpublished commits")); assert.equal(still.followUps.length, 1); assert.equal(git(origin, "rev-parse", branch), beforeHead);
  restart = true; await stop(); await start(); await p.reload(); await p.locator("details.review-delivery > summary").click(); await p.getByRole("button", { name: "Watch again", exact: true }).click(); const resumed = await watched(run.id, branch, w => w?.state === "needs-you"); restart = false; assert.equal(resumed.followUps.length, 1); assert.equal(git(origin, "rev-parse", branch), beforeHead); await p.screenshot({ path: join(shots, "blocked-after-rearm-restart.png"), fullPage: true });
});

test("allowed inline review reaches the agent with location while strangers are ignored", async () => {
  const { run, branch, number } = await fixture(), p = await page(`#/run/${run.id}`); await publishPanel(p, run); await p.getByLabel("Other GitHub users whose comments the agent acts on").fill("@bob"); await p.getByRole("button", { name: "Watch PR", exact: true }).click(); await watched(run.id, branch, w => w?.state === "green");
  change(s => s.prs[number].inlineComments = ["bob", "mallory"].map((login, i) => ({ id: 9001 + i, user: { login }, body: `INLINE-${login}-location`, created_at: new Date().toISOString(), path: "README.md", line: 3, side: "RIGHT" })));
  const updated = await until(() => ok(`/api/runs/${run.id}`), r => r.followUps.some((f: any) => f.pushed)); const follow = updated.followUps.at(-1); assert.match(follow.message, /File: README.md:3 \(right side\)/); assert.match(follow.message, /Thread: review-thread:9001/); assert.doesNotMatch(follow.message, /INLINE-mallory/);
  const prompts = readdirSync(records).map(name => JSON.parse(readFileSync(join(records, name), "utf8"))); assert.ok(prompts.some(item => item.prompt.includes("INLINE-bob-location") && item.prompt.includes("Thread: review-thread:9001")));
  const exported = await ok(`/api/runs/${run.id}/export?transcript=1`); const log = JSON.stringify(exported); assert.match(log, /inline review comments reach the agent/); assert.doesNotMatch(log, /aren't read yet/); await p.screenshot({ path: join(shots, "inline-follow-through.png"), fullPage: true });
});

test("two stale council confirmation dialogs post exactly one review", async () => {
  const { repo, branch, number } = await fixture(); git(repo, "push", "-q", "origin", `${branch}:refs/pull/${number}/head`);
  let run = await ok("/api/runs", { repo, pattern: "council", task: "Review fixture PR", source: { kind: "pr", number }, roles: { reviewers: ["claude", "codex"], chair: ["claude"] }, options: {}, trust: "standard" }); run = await done(run.id); assert.ok(run.review);
  const first = await page(`#/run/${run.id}`), second = await page(`#/run/${run.id}`);
  for (const p of [first, second]) { await p.locator("details.result-details > summary").click(); await p.getByRole("button", { name: `Post to PR #${number}`, exact: true }).click(); await p.getByRole("dialog", { name: "Post review to GitHub?", exact: true }).waitFor(); }
  const count = state().prs[number].comments.length;
  await first.getByRole("dialog").getByRole("button", { name: "Post review", exact: true }).click(); await first.getByText(`Posted to PR #${number}`, { exact: true }).waitFor();
  await second.getByRole("dialog").getByRole("button", { name: "Post review", exact: true }).click(); await second.getByText(`Posted to PR #${number}`, { exact: true }).waitFor(); await ok(`/api/runs/${run.id}/post-review`, {}); assert.equal(state().prs[number].comments.length, count + 1); await second.screenshot({ path: join(shots, "council-two-tabs.png"), fullPage: true });
});

test("actual captured evidence is not reposted for unrelated commits but refreshed evidence is", async () => {
  const { run, branch, tree } = await fixture(false), p = await page(`#/run/${run.id}`), dir = join(tree.path, ".codeflow/evidence"); mkdirSync(dir, { recursive: true }); await p.locator("section.result-studio").waitFor(); await p.screenshot({ path: join(dir, "flow.png") }); writeFileSync(join(dir, "README.md"), "Real Chrome screenshot of the completed scratch run.\n");
  const commit = (message: string) => { git(tree.path, "add", "."); git(tree.path, "commit", "-qm", message); };
  commit("captured evidence"); const opened = await ok(`/api/runs/${run.id}/pr`, { branch, into: "main" }), number = Number(opened.url.split("/").at(-1)); assert.match(state().prs[number].body, /Visual evidence/);
  writeFileSync(join(tree.path, "README.md"), "Unrelated documentation\n"); commit("unrelated"); await ok(`/api/runs/${run.id}/pr`, { branch, into: "main" }); assert.equal(state().prs[number].comments.length, 0);
  await p.reload(); await p.locator("section.result-studio").waitFor(); await p.screenshot({ path: join(dir, "flow.png") }); writeFileSync(join(dir, "README.md"), "Refreshed capture after publishing.\n"); commit("refreshed evidence"); await ok(`/api/runs/${run.id}/pr`, { branch, into: "main" }); assert.equal(state().prs[number].comments.length, 1);
  await ok(`/api/runs/${run.id}/pr`, { branch, into: "main" }); assert.equal(state().prs[number].comments.length, 1); assert.match(state().prs[number].comments[0].body, /\/blob\/[a-f0-9]{40}\//); await p.screenshot({ path: join(shots, "evidence-published.png"), fullPage: true });
});

test("no unexpected browser exceptions or console errors", () => { assert.deepEqual(errors, []); });
