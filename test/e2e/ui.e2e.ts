// End-to-end: the real UI in Chrome against a real server with fake agents.
// Run with `npm run test:e2e` (needs Google Chrome installed; no browser download).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
// A port the OS says is free — never one a real code-flow (4317) or dev server might be on.
const PORT = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});
const BASE = `http://localhost:${PORT}`;
const TOKEN = "e2e-session-token";
const bearer = { authorization: `Bearer ${TOKEN}` };
let server: ChildProcess;
let browser: Browser;
let page: Page;
let repo: string;
let ghState: string;

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-e2e-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "e2e", private: true, scripts: { test: "node check.mjs" } }));
  // Passes once the fake Claude has written its implementation file.
  writeFileSync(join(repo, "check.mjs"), 'import { readdirSync } from "node:fs"; process.exit(readdirSync(".").some((f) => f.startsWith("claude-")) ? 0 : 1);\n');
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  // A local "GitHub": a bare origin with PR #1, and the fake gh's state.
  const origin = mkdtempSync(join(tmpdir(), "codeflow-e2e-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "feature.txt"), "for (i = 0; i <= n; i++)\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feature");
  git("push", "-q", "origin", "feature", "feature:refs/pull/1/head");
  git("checkout", "-q", "main");
  git("branch", "-q", "-D", "feature");
  ghState = join(mkdtempSync(join(tmpdir(), "codeflow-e2e-gh-")), "state.json");
  writeFileSync(
    ghState,
    JSON.stringify({
      issues: [],
      prs: { 1: { number: 1, title: "Add feature loop", body: "", url: "https://github.com/o/r/pull/1", headRefName: "feature", baseRefName: "main", author: { login: "alice" }, isDraft: false, isCrossRepository: false, state: "OPEN", comments: [] } },
    }),
  );

  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      CODEFLOW_HOME: mkdtempSync(join(tmpdir(), "codeflow-e2e-home-")),
      PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
      FAKE_GH_STATE: ghState,
      CODEFLOW_TOKEN: TOKEN,
    },
    stdio: process.env.E2E_DEBUG ? "inherit" : "ignore",
  });
  for (let i = 0; i < 100; i++) {
    // /api/health with this test's token only answers from the server this test started.
    if (await fetch(`${BASE}/api/health`, { headers: bearer }).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
});

after(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
});

test("pick a repo, run a team, review, send a comment, and merge — all in the UI", async () => {
  await page.goto(BASE);

  // Choose the repository through the folder picker.
  await page.getByRole("button", { name: "Choose repository" }).first().click();
  const path = page.getByLabel("Folder path");
  await path.fill(repo);
  await path.press("Enter");
  await page.getByText("✓ This folder is a git repository").waitFor();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.locator(".repo-btn .name", { hasText: repo.split("/").pop()! }).waitFor();
  assert.equal(await page.locator("#checkCmd").inputValue(), "npm test", "the check is detected from package.json");

  // Describe the task, pick the pipeline, start with the keyboard.
  await page.getByRole("button", { name: /Plan → Build → Review/ }).click();
  await page.getByLabel("Task", { exact: true }).fill("E2E: make the check pass");
  await page.getByLabel("Task", { exact: true }).press("Meta+Enter");

  // The run finishes; the fake Codex can't satisfy the check, so the result says so.
  await page.getByText("⚠ Finished — but the check still fails").waitFor({ timeout: 30_000 });

  // Review: comment on the changed line and send it to Claude.
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.locator("tr.dl.add").first().click();
  await page.getByPlaceholder("What should change here?").fill("Implement it properly so npm test passes");
  await page.getByRole("button", { name: /Add comment/ }).click();
  await page.locator(".review-head select").selectOption("claude");
  await page.getByRole("button", { name: "Send 1 comment" }).click();

  // Back on the run: the follow-up ran and the check passes now.
  await page.getByText("✓ Finished — the check passes").waitFor({ timeout: 30_000 });
  await page.locator(".followup", { hasText: "check passes" }).waitFor();

  // Merge into main from the UI.
  await page.getByRole("button", { name: "Merge…" }).click();
  await page.getByRole("button", { name: "Merge into main" }).click();
  await page.locator(".badge", { hasText: "merged into main" }).waitFor();

  const log = execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: repo }).toString();
  assert.match(log, /^Merge codeflow\/.+\/build into main/);
  assert.ok(execFileSync("git", ["ls-files"], { cwd: repo }).toString().includes("claude-"), "Claude's fix is on main");
});

test("approve the plan from the UI: ask for changes, then approve", async () => {
  await page.goto(BASE);
  await page.getByRole("button", { name: /Plan → Build → Review/ }).click();
  await page.getByText("Let me approve the plan").click();
  await page.getByLabel("Task", { exact: true }).fill("E2E: checkpoint");
  await page.getByRole("button", { name: /^Start run/ }).click();

  await page.locator(".awaiting-card").getByText("Approve the plan").waitFor({ timeout: 30_000 });
  assert.ok(await page.locator(".rail").getByText("Waiting for you").count(), "the sidebar shows it needs you");
  await page.getByPlaceholder(/What should change/).fill("Mention the logger");
  await page.getByRole("button", { name: "Ask for changes" }).click();
  await page.locator(".awaiting-card").getByText("Approve the revised plan (2)").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "✓ Approve" }).click();
  await page.getByText(/✓ Finished|⚠ Finished/).first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".tl-step", { hasText: "Revise the plan (1)" }).count(), 1);
});

test("a message sent while Codex is working reaches its running turn", async () => {
  await page.goto(BASE);
  await page.getByRole("button", { name: /Plan → Build → Review/ }).click();
  await page.getByRole("checkbox", { name: /Let me approve the plan/ }).uncheck(); // remembered from the last test
  // The fake Codex keeps this turn open until a message is steered into it.
  await page.getByLabel("Task", { exact: true }).fill("E2E: steer WAIT-FOR-STEER");
  await page.getByRole("button", { name: /^Start run/ }).click();
  await page.waitForURL(/#\/run\//);
  const runId = decodeURIComponent(page.url().split("#/run/")[1]!.split("/")[0]!);

  await page.locator(".tl-step", { hasText: "Implement plan" }).waitFor({ timeout: 30_000 });
  await page.locator(".convo select").selectOption("codex");
  await page.locator(".convo input.field").fill("Prefer tabs over spaces");
  await page.locator(".convo input.field").press("Enter");
  await page.locator(".note-chip", { hasText: "✓ delivered to codex mid-turn (Implement plan): Prefer tabs over spaces" }).waitFor({ timeout: 10_000 });
  await page.getByText(/✓ Finished|⚠ Finished/).first().waitFor({ timeout: 30_000 });

  const run = await fetch(`${BASE}/api/runs/${runId}`, { headers: bearer }).then((r) => r.json());
  const implement = run.steps.find((s: { title: string }) => s.title === "Implement plan");
  assert.deepEqual(run.notes.map((n: { deliveredTo: unknown }) => n.deliveredTo), [{ stepId: implement.id, agent: "codex", midTurn: true }]);
  assert.equal(implement.status, "done");
});

test("start from a PR with a template: the council's findings are ranked, and posting takes your click", async () => {
  await page.goto(BASE);
  await page.getByRole("button", { name: /Review a PR as a council/ }).click();
  await page.locator(".gh-item", { hasText: "Add feature loop" }).click();
  assert.match(await page.getByLabel("Task", { exact: true }).inputValue(), /^Review pull request #1: Add feature loop/);
  await page.locator(".chip-ctx.source", { hasText: "PR #1" }).waitFor();
  await page.getByRole("button", { name: /^Start run/ }).click();

  await page.locator(".council .badge", { hasText: "Changes requested" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".findings li").count(), 2);
  assert.match(await page.locator(".findings li").first().innerText(), /2 reviewers agree/);
  assert.equal(JSON.parse(readFileSync(ghState, "utf8")).prs[1].comments.length, 0, "nothing posted yet");

  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Post to PR #1" }).click();
  await page.getByText("Posted to PR #1").waitFor();
  assert.match(JSON.parse(readFileSync(ghState, "utf8")).prs[1].comments.at(-1).body, /Off-by-one in the loop/);
});

test("automations: a webhook starts a run, it waits in the inbox, you approve it; the phone view is opt-in", async () => {
  const api = (path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const automation = await api("/api/automations", {
    name: "E2E hook",
    webhook: true,
    run: { repo, pattern: "pipeline", task: "E2E: automated chore", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, loop: { check: "" } },
  });
  assert.ok(automation.token, automation.error);

  const hook = (token: string) =>
    fetch(`${BASE}/hooks/${automation.id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "tunnel.example" }, body: "{}" });
  assert.equal((await hook("wrong")).status, 401);
  const fired = await hook(automation.token);
  assert.equal(fired.status, 202);
  const { run } = await fired.json();

  await page.goto(`${BASE}/#/automations`);
  const item = page.locator(".inbox-item", { hasText: "E2E: automated chore" });
  await item.waitFor({ timeout: 30_000 });
  assert.match(await page.locator(".auto-btn .count").innerText(), /^\d+$/, "the inbox count shows in the top bar");
  await item.getByRole("button", { name: "✓ Approve" }).click();
  await item.waitFor({ state: "detached" });
  assert.equal((await api(`/api/runs/${run}`)).triage.state, "approved");

  const remote = await api("/api/remote");
  assert.equal((await fetch(`${BASE}${remote.path}`)).status, 404, "off until you turn it on");
  await api("/api/remote", { enabled: true });
  const html = await (await fetch(`${BASE}${remote.path}`)).text();
  assert.match(html, /E2E: automated chore/);
  assert.doesNotMatch(html, /<button|<form/);
  assert.equal((await fetch(`${BASE}/r/not-the-token`)).status, 404);
});

test("sign-in: the first browser claims code-flow; once agents have run, others need the link", async () => {
  // Agents have run by now (earlier tests), so nothing new can claim the session.
  assert.equal((await fetch(`${BASE}/api/runs`)).status, 401, "the API needs the browser's session");
  assert.equal((await fetch(`${BASE}/api/runs`, { headers: { cookie: "codeflow_session=guess" } })).status, 401);
  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  await other.goto(BASE);
  await other.getByText("Open code-flow from its link").waitFor();
  await other.goto(`${BASE}/?token=${TOKEN}`);
  await other.waitForURL(`${BASE}/`);
  await other.getByRole("button", { name: /New run/ }).waitFor();
  await stranger.close();
});

test("insights and run search", async () => {
  await page.goto(`${BASE}/#/insights`);
  await page.getByRole("heading", { name: "Insights" }).waitFor();
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  assert.ok(await page.getByRole("table").first().isVisible());
  await page.keyboard.press("/");
  await page.keyboard.type("automated chore");
  await page.getByText(/1 of \d+ runs/).waitFor();
  assert.equal(await page.locator(".rail .run-item").count(), 1);
});
