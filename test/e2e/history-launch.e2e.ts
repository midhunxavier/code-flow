// Actual paginated feeds and explicit multi-service startup, with local fixture data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-history-launch-ui-")));
const repo = join(fixture, "repo"); const home = join(fixture, "data"); const worktree = join(fixture, "worktrees", "history-125", "preview");
const token = "history-launch-ui-token"; const headers = { authorization: `Bearer ${token}` };
const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
const base = `http://localhost:${port}`;
let server: ChildProcess; let browser: Browser; let page: Page;
before(async () => {
  mkdirSync(join(repo, ".codeflow"), { recursive: true }); mkdirSync(join(home, "runs"), { recursive: true });
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' service.mjs`;
  for (const id of ["api", "web"]) {
    mkdirSync(join(repo, id));
    writeFileSync(join(repo, id, "service.mjs"), `import {createServer} from 'node:http';\nif(process.env.SERVICE_NAME==='web') { const dependency=await fetch(process.env.API_URL+'/health'); if(!dependency.ok) process.exit(8); }\ncreateServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:process.env.SERVICE_NAME,api:process.env.API_URL}));}).listen(Number(process.env.PORT),process.env.HOST,()=>console.log('ready '+process.env.SERVICE_NAME));\n`);
  }
  writeFileSync(join(repo, ".codeflow", "launch.json"), JSON.stringify({ version: 1, profiles: [{ id: "development", name: "API and web", services: [{ id: "api", command, cwd: "api", health: { path: "/health", timeoutMs: 5000 } }, { id: "web", command, cwd: "web", dependsOn: ["api"], health: { path: "/health", timeoutMs: 5000 } }] }] }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); git("add", "."); git("add", "-f", ".codeflow/launch.json"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  mkdirSync(join(fixture, "worktrees", "history-125"), { recursive: true }); git("worktree", "add", "-q", "--detach", worktree, "main");
  const commit = git("rev-parse", "HEAD").toString().trim(); const timestamp = Date.now() - 60000;
  for (let index = 0; index < 126; index++) {
    const id = `history-${String(index).padStart(3, "0")}`;
    const run = { id, task: index === 0 ? "Ancient needle task outside the initial history page" : index === 125 ? "Services fixture result" : `Historical fixture ${index}`, pattern: "solo", repo, baseRef: commit, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(fixture, "worktrees", id), roles: { worker: ["codex"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { check: "", setup: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: index < 2 ? timestamp - 1000 : timestamp, endedAt: timestamp + 100, seen: index !== 1, archived: false, worktrees: index === 125 ? [{ name: "preview", path: worktree, branch: "" }] : [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [] };
    writeFileSync(join(home, "runs", `${id}.jsonl`), JSON.stringify({ seq: index + 1, ts: timestamp, runId: id, type: "run", run }) + "\n");
  }
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.E2E_DEBUG ? "inherit" : "ignore" });
  let healthy = false; for (let retry = 0; retry < 150; retry++) { healthy = await fetch(`${base}/api/health`, { headers }).then((response) => response.ok, () => false); if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.ok(healthy, "fixture server started");
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => {
  await browser?.close(); server?.kill("SIGTERM");
  await new Promise<void>((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
  rmSync(fixture, { recursive: true, force: true });
});

test("HTTP cursor pages preserve timestamp ties and bounded SSE keeps older attention visible", async () => {
  const first = await fetch(`${base}/api/runs?limit=100`, { headers }).then((response) => response.json());
  assert.equal(first.runs.length, 100); assert.equal(first.total, 126); assert.ok(first.nextCursor);
  const second = await fetch(`${base}/api/runs?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`, { headers }).then((response) => response.json());
  assert.equal(second.runs.length, 26); assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.runs, ...second.runs].map((run) => run.id)).size, 126, "cursor ties neither skip nor repeat runs");
  assert.equal((await fetch(`${base}/api/runs?limit=100&cursor=bad-cursor`, { headers })).status, 400);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await fetch(`${base}/api/events?limit=100`, { headers, signal: abort.signal }); const reader = response.body!.getReader(); let source = "";
    while (!source.includes("\n\n")) { const part = await reader.read(); if (part.done) break; source += new TextDecoder().decode(part.value); }
    await reader.cancel();
    const hello = JSON.parse(source.split("\n\n")[0]!.split("\n").find((line) => line.startsWith("data:"))!.slice(5)) as { type: string; total: number; nextCursor: string; runs: { id: string }[] };
    assert.equal(hello.type, "hello"); assert.equal(hello.total, 126); assert.ok(hello.nextCursor);
    assert.equal(hello.runs.length, 101); assert.ok(hello.runs.some((run) => run.id === "history-001"), "older unseen result is in attention");
    assert.equal(hello.runs.some((run) => run.id === "history-000"), false, "older ordinary history remains paginated");
  } finally { clearTimeout(timer); abort.abort(); }
});

test("sidebar searches beyond loaded pages and loads older history without discarding visible results", async () => {
  await page.goto(base);
  const history = page.getByRole("region", { name: "Run history pages" });
  await history.getByText("101 of 126 runs loaded", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Ancient needle task/ }).count(), 0);
  const search = page.getByRole("searchbox", { name: "Search runs (press / to focus)" });
  const remoteSearch = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && new URL(response.url()).searchParams.get("q") === "Ancient needle");
  await search.fill("Ancient needle"); assert.equal((await remoteSearch).status(), 200);
  await page.getByRole("button", { name: /Ancient needle task/ }).waitFor();
  await history.getByText("1 loaded matches · 1 in history", { exact: true }).waitFor();
  await search.fill("");
  await page.getByRole("button", { name: "Load older runs", exact: true }).click();
  await history.getByText("126 of 126 runs loaded", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Load older runs", exact: true }).count(), 0);
});

test("workspace starts, inspects and stops a real two-service launch profile", async () => {
  await page.goto(`${base}/#/workspace`);
  await page.getByLabel("Repository or run worktree", { exact: true }).selectOption(worktree);
  await page.getByRole("button", { name: "Services", exact: true }).click();
  const panel = page.getByRole("region", { name: "Multi-service launch profiles" });
  const idle = await fetch(`${base}/api/runs/history-125/launch-profiles?worktree=preview`, { headers }).then((response) => response.json());
  assert.equal(idle.profiles?.length, 1, JSON.stringify(idle));
  await panel.getByLabel("Launch profile", { exact: true }).waitFor();
  assert.equal(idle.session, null, "viewing the profile executes no commands");
  await panel.getByText("Review 2 service commands", { exact: true }).click();
  assert.match(await panel.innerText(), /Starts after api/);
  await panel.getByRole("button", { name: "Start launch profile", exact: true }).click();
  await panel.getByText("Stack: ready", { exact: true }).waitFor({ timeout: 15000 });
  const webUrl = await panel.getByRole("link", { name: "Open web", exact: true }).getAttribute("href");
  const apiUrl = await panel.getByRole("link", { name: "Open api", exact: true }).getAttribute("href");
  assert.notEqual(webUrl, apiUrl);
  const response = await fetch(webUrl!).then((result) => result.json()); assert.equal(response.api, apiUrl);
  await panel.getByRole("article", { name: "web service" }).getByText(/Logs \(/).click();
  await panel.getByText("ready web", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Stop services", exact: true }).click();
  await panel.getByText("Stack: stopped", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("link", { name: "Open web", exact: true }).count(), 0);
});
