// Original attention/notifications/collapsed rail scenarios against an isolated server and scratch repository.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";
const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "attention-qa", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let fixture: string, home: string, repo: string, base: string, server: ChildProcess, browser: Browser, page: Page;
const errors: string[] = []; let output = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json(); }
async function until<T>(get: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 30_000; for (;;) { const value = await get(); if (accepts(value)) return value; assert.ok(Date.now() < deadline, `Timed out: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 100)); } }
const shot = async (name: string) => { if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" }); } };
async function hello(path: string) { const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000); try { const response = await fetch(base + path, { headers, signal: abort.signal }); const reader = response.body!.getReader(); let text = ""; for (;;) { const chunk = await reader.read(); text += new TextDecoder().decode(chunk.value); const frames = text.split("\n\n"); for (const frame of frames.slice(0, -1)) { const data = frame.split("\n").find(line => line.startsWith("data:")); if (data) { const value = JSON.parse(data.slice(5)); if (value.type === "hello" || value.s === 1 && value.d?.type === "hello") { await reader.cancel(); return value.d ?? value; } } } if (chunk.done) throw Error(text); } } finally { clearTimeout(timer); abort.abort(); } }
before(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-attention-ui-"))); home = join(fixture, "data"); repo = join(fixture, "repo"); await mkdir(repo); await mkdir(join(home, "runs"), { recursive: true }); await mkdir(join(fixture, "records"));
  git("init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "Attention fixture\n"); git("add", "."); git("-c", "user.name=QA", "-c", "user.email=qa@test", "commit", "-qm", "base"); const commit = git("rev-parse", "HEAD"), now = Date.now();
  const seed = async (id: string, createdAt: number, extra: Partial<Run> = {}) => { const run = { id, task: `Attention fixture ${id}`, pattern: "solo", repo, baseRef: commit, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(fixture, "worktrees", id), roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "safe", loop: { check: "", setup: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt, endedAt: createdAt + 1, seen: false, archived: false, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [], ...extra }; await writeFile(join(home, "runs", id + ".jsonl"), JSON.stringify({ seq: 1, ts: now, runId: id, type: "run", run }) + "\n"); };
  for (let i = 0; i < 106; i++) await seed(`recent-${String(i).padStart(3, "0")}`, now - 1000 - i);
  for (let i = 0; i < 100; i++) await seed(`failed-${String(i).padStart(3, "0")}`, now - 172800000 - i, { status: "failed" });
  await seed("old-approval", now - 200000000, { status: "stopped", awaiting: { kind: "plan", title: "Approve old plan", content: "Already waiting before boot", at: now - 199000000 } });
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_RECORD_DIR: join(fixture, "records"), FAKE_NOOP_VENDOR: "codex", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" }); server.stdout?.on("data", chunk => output += String(chunk)); server.stderr?.on("data", chunk => output += String(chunk)); await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), Boolean);
  browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 30_000 }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(`localStorage.setItem("sideOpen", "0"); localStorage.removeItem("project"); localStorage.removeItem("repo"); window.__qaNotices = []; class Notice { static permission = "granted"; constructor(title) { window.__qaNotices.push(title); } close() {} } Object.defineProperty(window, "Notification", { configurable: true, value: Notice });`);
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); if (server && server.exitCode === null && server.signalCode === null) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, "server.log"), output); } await rm(fixture, { recursive: true, force: true }); });

test("both real feed hellos select older failures and questions outside a full recent page", async () => {
  const recent = await api("/api/runs?limit=100"); assert.equal(recent.total, 207); assert.equal(recent.runs.length, 100);
  for (const path of ["/api/events?limit=100", "/api/stream?subs=" + encodeURIComponent(JSON.stringify([{ id: 1, topic: "runs" }]))]) {
    const snapshot = await hello(path); assert.equal(snapshot.total, 207); assert.equal(snapshot.attentionTotal, 207); assert.equal(snapshot.attentionTruncated, true); assert.equal(snapshot.runs.length, 200); assert.equal(snapshot.runs.filter((run: Run) => run.id.startsWith("failed-")).length, 99); assert.ok(snapshot.runs.some((run: Run) => run.id === "old-approval")); assert.equal(snapshot.attentionNextCursor, undefined);
  }
});

test("fresh loads and reloads never notify an already-waiting old approval", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${base}/?token=${token}#/inbox`); await page.getByRole("heading", { name: /Review inbox/ }).waitFor(); await page.getByText("Attention fixture old-approval", { exact: true }).last().waitFor();
    assert.equal(await page.evaluate(() => Notification.permission), "granted"); assert.deepEqual(await page.evaluate(() => (window as any).__qaNotices), []); assert.equal(await page.locator(".sr-only[role=status][aria-live=polite]").innerText(), ""); await shot(`snapshot-silent-${attempt}`);
  }
});

test("authoritative badges and Inbox disclose partial history and stop claiming pagination when complete", async () => {
  await page.getByRole("link", { name: /^Inbox (?:99\+ · )?101 need attention$/ }).waitFor(); assert.match(await page.title(), /^\(207\)/);
  await page.getByRole("status").filter({ hasText: "Showing 100 of 101 review items" }).waitFor(); assert.match(await page.getByRole("region", { name: "Needs you", exact: true }).innerText(), /Needs you\s+207/); await shot("partial-inbox-authoritative-counts");
  await page.getByRole("button", { name: /^Application menu:/ }).click(); const menu = page.getByRole("menu"); assert.match(await menu.getByRole("menuitem", { name: /Inbox/ }).innerText(), /Inbox\s+101/); assert.equal(await menu.getByRole("menuitem", { name: "Scheduling", exact: true }).locator(".count").count(), 0); await page.keyboard.press("Escape");
  await page.getByRole("searchbox", { name: "Search runs (press / to focus)", exact: true }).fill("no-such-attention-fixture");
  await page.getByRole("button", { name: "Clear sidebar filters to load older items", exact: true }).click(); await page.getByRole("button", { name: "Load older review items", exact: true }).waitFor();
  for (let i = 0; i < 4 && await page.getByRole("button", { name: "Load older runs", exact: true }).count(); i++) { await page.getByRole("button", { name: "Load older runs", exact: true }).click(); await page.getByRole("navigation", { name: "Runs", exact: true }).getByRole("button", { name: "Loading…", exact: true }).waitFor({ state: "hidden" }); }
  assert.equal(await page.getByText(/Older attention is paged/).count(), 0); assert.equal(await page.getByText(/Showing 100 of 101/).count(), 0); assert.equal(await page.getByRole("heading", { name: /Review inbox 101/ }).count(), 1); await shot("complete-inbox-pagination-cleared");
});

test("collapsed badges remain visible, search peek preserves storage and mobile labels remain readable", async () => {
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click(); const inbox = page.getByRole("link", { name: /^Inbox (?:99\+ · )?101 need attention$/ }); assert.ok(await inbox.locator(".count").isVisible()); const railBox = await page.getByRole("navigation", { name: "Runs", exact: true }).boundingBox(), badgeBox = await inbox.locator(".count").boundingBox(); assert.ok(badgeBox && railBox && badgeBox.x >= railBox.x && badgeBox.x + badgeBox.width <= railBox.x + railBox.width); await shot("collapsed-inbox-badge");
  await page.keyboard.press("/"); const search = page.getByRole("searchbox", { name: "Search runs (press / to focus)", exact: true }); await search.waitFor(); assert.equal(await search.evaluate(el => document.activeElement === el), true); assert.equal(await page.evaluate(() => localStorage.getItem("railCollapsed")), "1"); await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
  await page.getByRole("button", { name: "Search runs", exact: true }).click(); await search.waitFor(); await page.keyboard.press("Escape"); await page.reload(); await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor(); assert.equal(await page.evaluate(() => localStorage.getItem("railCollapsed")), "1");
  await page.getByRole("button", { name: /^Application menu:/ }).click(); await page.getByRole("menuitem", { name: "View and filter runs", exact: true }).click(); await page.locator("#rail-filters").waitFor(); assert.equal(await page.evaluate(() => localStorage.getItem("railCollapsed")), "1"); await page.getByRole("heading", { name: "Inbox", exact: true }).click(); await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "Show runs", exact: true }).click(); await until(() => inbox.locator(".nav-label").boundingBox(), box => !!box && box.x >= 0 && box.x + box.width < 390); assert.ok(await inbox.locator(".nav-label").isVisible()); assert.ok(await page.getByRole("link", { name: "Scheduling", exact: true }).locator(".nav-label").isVisible()); assert.equal(await page.evaluate(() => localStorage.getItem("railCollapsed")), "1"); await shot("mobile-destination-labels"); await page.setViewportSize({ width: 1440, height: 1000 });
});

test("Settings search and legacy scheduling route still open the standalone destination", async () => {
  await page.goto(`${base}/#/settings`); await page.getByRole("searchbox", { name: "Search settings", exact: true }).fill("Scheduling"); await page.getByRole("button", { name: /Scheduling/ }).click(); await page.waitForURL(/#\/automations$/); await page.goto(`${base}/#/settings/automations`); await page.waitForURL(/#\/automations$/); assert.equal(await page.locator(".settings-tools").count(), 0);
});

test("default solo uncommitted work appears in Inbox and live approvals still notify", async () => {
  const changed = await api<Run>("/api/runs", { repo, pattern: "solo", task: "QA attention writes uncommitted work", roles: { agent: ["claude"] } }); const result = await until(() => api<Run>(`/api/runs/${changed.id}`), run => run.status !== "running"); assert.equal(result.status, "done", result.error); assert.match(result.artifacts[0]!.stat!, /new untracked file/); assert.equal(git("rev-parse", result.artifacts[0]!.branch), git("rev-parse", "HEAD"), "default solo changes remain uncommitted");
  const noop = await api<Run>("/api/runs", { repo, pattern: "solo", task: "QA attention no-op", roles: { agent: ["codex"] } }); const clean = await until(() => api<Run>(`/api/runs/${noop.id}`), run => run.status !== "running"); assert.deepEqual(clean.artifacts, []);
  await page.goto(`${base}/#/inbox`); await page.getByText(result.task, { exact: true }).last().waitFor(); assert.equal(await page.locator(".inbox-group").getByText(clean.task, { exact: true }).count(), 0);
  await page.getByText("Connected", { exact: true }).waitFor(); assert.equal(await page.evaluate(() => Notification.permission), "granted"); assert.deepEqual(errors, []);
  const approval = await api<Run>("/api/runs", { repo, pattern: "pipeline", task: "QA new approval after boot", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, approvals: { plan: true } }); await until(() => api<Run>(`/api/runs/${approval.id}`), run => !!run.awaiting); await until(() => page.evaluate(() => (window as any).__qaNotices as string[]), notices => notices.some(title => /approve/.test(title))); assert.match(await page.locator(".sr-only[role=status][aria-live=polite]").innerText(), /approve.*QA new approval after boot/i); await shot("live-approval-notification"); await api(`/api/runs/${approval.id}/cancel`, {}); assert.deepEqual(errors, []);
});
