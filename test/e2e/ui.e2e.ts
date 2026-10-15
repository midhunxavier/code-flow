// End-to-end: the real UI in Chrome against a real server with fake agents.
// Run with `npm run test:e2e` (needs Google Chrome installed; no browser download).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 4300 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;
let browser: Browser;
let page: Page;
let repo: string;

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-e2e-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "e2e", private: true, scripts: { test: "node check.mjs" } }));
  // Passes once the fake Claude has written its implementation file.
  writeFileSync(join(repo, "check.mjs"), 'import { readdirSync } from "node:fs"; process.exit(readdirSync(".").some((f) => f.startsWith("claude-")) ? 0 : 1);\n');
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      CODEFLOW_HOME: mkdtempSync(join(tmpdir(), "codeflow-e2e-home-")),
      PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/agents`).then((r) => r.ok, () => false)) break;
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
