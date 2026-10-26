import { tmpdir } from "node:os";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";

const ports = await reserveQaPorts(2), root = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "codeflow-final-approval-")), home = join(scratch, "data"), repo = join(scratch, "repo");
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR ?? join(root, "output/playwright/qa-final-approval-attention");
const token = "qa-final-approval", base = `http://127.0.0.1:${ports.port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
let server: ChildProcess, browser: Browser, page: Page, project: string, logs = "";
const errors: string[] = [], receipts: unknown[] = [];
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(base + path, { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`); return value;
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) { const value = await read(); if (done(value)) return value; assert.ok(Date.now() < deadline, JSON.stringify(value)); await new Promise(r => setTimeout(r, 100)); }
}
const finished = (id: string) => until(() => api(`/api/runs/${id}`), run => run.status !== "running");
const input = (task: string) => ({ project, repo, pattern: "solo", task, roles: { agent: ["codex"] }, trust: "standard", loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } });
const seen = (id: string) => api(`/api/runs/${id}/seen`, {});
const pending = (id: string) => until(() => api(`/api/approvals?run=${id}`), records => records.some((record: any) => record.status === "pending"));
async function waiting(id: string) {
  await seen(id);
  const counts = await api("/api/projects/counts"), history = await api("/api/runs?limit=1&status=attention"), section = await api("/api/runs?limit=1&section=waiting");
  assert.equal(counts[""].attentionTasks, 1); assert.equal(counts[""].waiting, 1);
  assert.equal(counts[project].attentionTasks, 1); assert.equal(history.total, 1); assert.equal(section.total, 1);
  assert.equal(history.runs[0].id, id); assert.equal(history.runs[0].approvalPending, true);
  await until(() => page.getByRole("region", { name: "Needs you", exact: true }).locator(".rail-title .count").textContent(), text => text === "1");
  receipts.push({ id, counts, history, section });
}
async function settled(id: string) {
  await finished(id); await seen(id);
  await until(() => api("/api/projects/counts"), counts => counts[""].attentionTasks === 0);
  assert.equal((await api("/api/runs?limit=1&status=attention")).total, 0);
  await until(() => page.getByRole("region", { name: "Needs you", exact: true }).count(), count => count === 0);
}
before(async () => {
  for (const path of [repo, home, evidence, join(scratch, "os-home")]) mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-qb", "main"); writeFileSync(join(repo, "README.md"), "Approval fixture\n"); git("add", "."); git("commit", "-qm", "base");
  const shell = join(scratch, "bash"); writeFileSync(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o755 });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(scratch, "build-home") } });
  await ports.release();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...inherited, HOME: join(scratch, "os-home"), SHELL: shell, ENV: "", BASH_ENV: "", CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(ports.port), CODEFLOW_REMOTE_PORT: String(ports.port + 1), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  server.stdout?.on("data", data => logs += data); server.stderr?.on("data", data => logs += data);
  await until(() => fetch(base + "/api/health", { headers }).then(response => response.ok, () => false), Boolean);
  project = (await api("/api/projects", { name: "Approval attention", repos: [repo] })).id;
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(({ project, repo }) => { localStorage.setItem("project", project); localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); }, { project, repo });
});
after(async () => {
  if (page) { await page.screenshot({ path: join(evidence, "final.png"), fullPage: true }).catch(() => {}); writeFileSync(join(evidence, "page.txt"), await page.locator("body").innerText().catch(() => "unavailable")); }
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) { const done = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill("SIGTERM"); await done; }
  await ports.release(); writeFileSync(join(evidence, "server.log"), logs); writeFileSync(join(evidence, "browser.json"), JSON.stringify(errors, null, 2)); writeFileSync(join(evidence, "receipts.json"), JSON.stringify(receipts, null, 2)); rmSync(scratch, { recursive: true, force: true });
});

test("seen root, fork and side questions agree across the live badge, authoritative counts and filtered history", { timeout: 120_000 }, async () => {
  const rootRun = await api("/api/runs", input("Seen approval family")); await finished(rootRun.id); await seen(rootRun.id);
  await page.goto(`${base}/?token=${token}#/run/${rootRun.id}`); await page.locator(".run-head").waitFor();
  const fork = await api(`/api/runs/${rootRun.id}/provider-chat`, { agent: "codex", kind: "tab", message: "ASK-QUESTION choose the fork badge" });
  await pending(fork.id); await waiting(fork.id);
  await page.getByRole("region", { name: "Needs you", exact: true }).locator(`button.run-item[data-task="${rootRun.id}"]`).click();
  await until(async () => page.url(), url => url.endsWith(`/run/${fork.id}`));
  const card = page.getByRole("alert", { name: "Agent question" }); await card.getByRole("button", { name: "Blue", exact: true }).click(); await card.getByRole("button", { name: "Send answer", exact: true }).click();
  await until(() => api(`/api/approvals?run=${fork.id}`), records => records.some((record: any) => record.status === "approved")); await settled(fork.id);
  const side = await api(`/api/runs/${rootRun.id}/provider-chat`, { agent: "codex", kind: "side", message: "ASK-QUESTION choose the side badge" });
  await pending(side.id); await waiting(side.id);
  await page.getByRole("region", { name: "Needs you", exact: true }).locator(`button.run-item[data-task="${rootRun.id}"]`).click();
  await page.getByRole("complementary", { name: "Side panel", exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "seen-side-waiting.png"), fullPage: true });
  await api(`/api/runs/${side.id}/cancel`, {}); await settled(side.id);
  await api(`/api/runs/${rootRun.id}/followups`, { kind: "reply", worktree: "solo", agent: "codex", message: "ASK-QUESTION choose the root badge" });
  await pending(rootRun.id); await waiting(rootRun.id); await page.reload(); await waiting(rootRun.id);
  await page.screenshot({ path: join(evidence, "seen-root-after-reload.png"), fullPage: true });
  await api(`/api/runs/${rootRun.id}/cancel`, {}); await settled(rootRun.id);
  assert.deepEqual(errors, []);
});
