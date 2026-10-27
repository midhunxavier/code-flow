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
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "codeflow-final-routing-")), home = join(scratch, "data"), repo = join(scratch, "repo");
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR ?? join(root, "output/playwright/qa-final-pending-routing");
const token = "qa-final-routing", base = `http://127.0.0.1:${ports.port}`;
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

test("rail routes pending side, fork and root summaries before the approval payload arrives", { timeout: 90_000 }, async () => {
  const installDeliveryGate = () => {
    const Native = window.EventSource, held = new Map<EventSource, string>();
    const state = { hold: true, blocked: 0, summaries: {} as Record<string, boolean>, release: () => {} };
    (window as any).qaApprovalDelivery = state;
    state.release = () => { state.hold = false; for (const [source, data] of held) source.dispatchEvent(new MessageEvent('message', { data })); held.clear(); };
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('message', event => {
          const data = JSON.parse(event.data).d;
          if (data?.run) state.summaries[data.run.id] = data.run.approvalPending === true;
          for (const run of data?.runs ?? []) state.summaries[run.id] = run.approvalPending === true;
          // Only the approval topic uses snapshot.records. Keep run/history delivery live.
          if (state.hold && data?.type === 'snapshot' && Array.isArray(data.records)) {
            state.blocked++; held.set(this, event.data); event.stopImmediatePropagation();
          }
        });
      }
    };
  };
  // tsx's name-preserving transform can reference __name inside serialized classes.
  await page.addInitScript({ content: `window.__name = fn => fn; (${installDeliveryGate.toString()})();` });
  const rootRun = await api('/api/runs', input('Routing signal family')); await finished(rootRun.id); await seen(rootRun.id);
  const fork = await api(`/api/runs/${rootRun.id}/provider-chat`, { agent: 'codex', kind: 'tab', message: 'Remember this provider tab' });
  await finished(fork.id); await seen(fork.id);
  const side = await api(`/api/runs/${rootRun.id}/provider-chat`, { agent: 'codex', kind: 'side', message: 'ASK-QUESTION delayed side payload' });
  await pending(side.id); await seen(side.id);
  await page.goto(`${base}/?token=${token}#/run/${fork.id}`); await page.locator('.run-head').waitFor();
  await page.waitForFunction(id => (window as any).qaApprovalDelivery.summaries[id] === true && (window as any).qaApprovalDelivery.blocked > 0, side.id);
  assert.equal(await page.getByRole('alert', { name: 'Agent question' }).count(), 0);
  await page.goto(`${base}/#/inbox`);
  await page.waitForFunction(id => (window as any).qaApprovalDelivery.summaries[id] === true, side.id);
  receipts.push({ stage: 'before-side-click', root: rootRun.id, side: side.id, state: await page.evaluate(() => (window as any).qaApprovalDelivery), counts: await api('/api/projects/counts') });
  await page.locator(`button.run-item[data-task="${rootRun.id}"]`).click();
  const panel = page.getByRole('complementary', { name: 'Side panel', exact: true });
  await panel.waitFor(); await panel.getByText('ASK-QUESTION delayed side payload', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('alert', { name: 'Agent question' }).count(), 0, 'routing does not require the approval inbox payload');
  receipts.push({ stage: 'side-before-payload', state: await page.evaluate(() => (window as any).qaApprovalDelivery) });
  await page.screenshot({ path: join(evidence, 'side-before-payload.png'), fullPage: true });
  await page.evaluate(() => (window as any).qaApprovalDelivery.release());
  await page.getByRole('alert', { name: 'Agent question' }).waitFor();
  await api(`/api/runs/${side.id}/cancel`, {}); await finished(side.id); await seen(side.id);
  await page.getByRole('alert', { name: 'Agent question' }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Close side panel', exact: true }).click();
  await page.evaluate(() => { (window as any).qaApprovalDelivery.hold = true; });

  await api(`/api/runs/${fork.id}/followups`, { kind: 'reply', worktree: 'solo', agent: 'codex', message: 'ASK-QUESTION delayed fork payload' });
  await pending(fork.id); await seen(fork.id);
  await page.goto(`${base}/#/run/${rootRun.id}`); await page.locator('.run-head').waitFor();
  await page.waitForFunction(id => (window as any).qaApprovalDelivery.summaries[id] === true, fork.id);
  await page.locator(`button.run-item[data-task="${rootRun.id}"]`).click();
  await page.waitForURL(new RegExp(`#/run/${fork.id}$`));
  assert.equal(await page.getByRole('alert', { name: 'Agent question' }).count(), 0);
  await api(`/api/runs/${fork.id}/cancel`, {}); await finished(fork.id); await seen(fork.id);

  await api(`/api/runs/${rootRun.id}/followups`, { kind: 'reply', worktree: 'solo', agent: 'codex', message: 'ASK-QUESTION delayed root payload' });
  await pending(rootRun.id); await seen(rootRun.id);
  await page.goto(`${base}/#/run/${fork.id}`); await page.locator('.run-head').waitFor();
  await page.waitForFunction(id => (window as any).qaApprovalDelivery.summaries[id] === true, rootRun.id);
  await page.locator(`button.run-item[data-task="${rootRun.id}"]`).click();
  await page.waitForURL(new RegExp(`#/run/${rootRun.id}$`));
  await api(`/api/runs/${rootRun.id}/cancel`, {}); await finished(rootRun.id); await seen(rootRun.id);
  const unrelated = await api('/api/runs', input('ASK-QUESTION another family'));
  await pending(unrelated.id);
  await page.goto(`${base}/#/run/${fork.id}`); await page.locator('.run-head').waitFor();
  await page.goto(`${base}/#/inbox`); await page.locator(`button.run-item[data-task="${rootRun.id}"]`).click();
  await page.waitForURL(new RegExp(`#/run/${fork.id}$`));
  assert.equal(await panel.count(), 0, 'cancelled side summary does not reopen its panel');
  await api(`/api/runs/${unrelated.id}/cancel`, {}); await finished(unrelated.id);
  assert.deepEqual(errors, []);
});
