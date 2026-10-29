import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import type { Run, Step } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "team-reply-test", headers = { authorization: `Bearer ${token}` };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq9sAAAAASUVORK5CYII=", "base64");
const proposal = '<div align="center">\n\n# Proposed README\n\n[![Package version](https://images.example.test/badge.png)](https://example.test/package)\n\n</div>\n\n![Repository screenshot](docs/assets/screenshot.png)\n\n![Unavailable badge](https://images.example.test/missing.png)\n\n<details>\n<summary><b>Client setup</b></summary>\n\nRun **the client\nwith this setting**.\n\n</details>\n\n<!-- Generated marker -->\n\n' + "Install the project and configure its connection.\n\n".repeat(350) + "## License\n\nThe final proposal line is preserved.";
const summary = "The team submitted a proposal. Independent review still requests changes.";
let directory: string, base: string, server: ChildProcess, browser: Browser, logs = "";
const errors: string[] = [];
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-team-reply-")));
  const home = join(directory, "home"), repo = join(directory, "repo");
  await mkdir(join(home, "runs"), { recursive: true }); await mkdir(repo);
  await mkdir(join(repo, "docs/assets"), { recursive: true }); await writeFile(join(repo, "docs/assets/screenshot.png"), png);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "Fixture\n"); git("add", "."); git("-c", "user.name=QA", "-c", "user.email=qa@test", "commit", "-qm", "Fixture");
  const head = git("rev-parse", "HEAD"), now = Date.now() - 60_000;
  const run = (id: string, extra: Partial<Run> = {}) => ({ id, task: "Propose a README without editing files", pattern: "solo", repo, baseRef: head, baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(directory, id), roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { check: "", setup: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: now, endedAt: now + 1000, seen: true, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [], ...extra } as Run);
  const step = (id: string, finalText: string, extra: Partial<Step> = {}): Step => ({ id, kind: "agent", title: "Your task", role: "agent", agent: "claude", mode: "read", worktree: "solo", status: "done", startedAt: now + 1, endedAt: now + 2, finalText, ...extra });
  const key = "agent|claude|solo|Your task#1";
  const child = run("proposal-worker", { pattern: "auto-team", status: "stopped", taskExecution: { taskId: "proposal-chat", chatId: "proposal-chat", key }, steps: [
    step("old", JSON.stringify({ taskId: "readme", findings: [{ title: "Old draft", body: "Superseded proposal" }] })),
    step("latest", JSON.stringify({ taskId: "readme", checkpoint: "Private reasoning must not appear", findings: [{ title: "Evidence", body: "Supporting evidence, not the actual proposal." }] })),
  ] });
  const turn: NonNullable<Run["teamTurns"]>[number] = { key, executionId: child.id, baseline: head, result: head, state: "preserved", report: "Review requested changes", executionStatus: "stopped" };
  const main = run("proposal-chat", { teamTurns: [turn], steps: [step("s1", summary, { teamResponseFor: key })] });
  const complete = run("complete-chat", { teamTurns: [turn], steps: [step("s1", summary + "\n\n" + proposal, { teamResponseFor: key })] });
  for (const value of [child, main, complete]) {
    const events: object[] = value.id === child.id ? [
      ...Array.from({ length: 600 }, (_, i) => ({ type: "agent", stepId: "latest", event: { kind: "text", messageId: "answer", delta: true, text: `fragment-${i}` } })),
      { type: "agent", stepId: "latest", event: { kind: "text", messageId: "answer", text: proposal } },
      { type: "agent", stepId: "latest", event: { kind: "text", text: child.steps[1]!.finalText } },
    ] : [];
    events.push({ type: "run", run: value });
    events.push(...value.steps.map(step => ({ type: "step", step })));
    await writeFile(join(home, "runs", `${value.id}.jsonl`), events.map((event, i) => JSON.stringify({ seq: i + 1, ts: now, runId: value.id, ...event })).join("\n") + "\n");
  }
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  server.stdout?.on("data", chunk => { logs += chunk; }); server.stderr?.on("data", chunk => { logs += chunk; });
  for (let i = 0; ; i++) { if (await fetch(base + "/api/health", { headers }).then(r => r.ok, () => false)) break; assert.ok(i < 150, logs); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise(resolve => server.once("exit", resolve)); }
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(errors, []); assert.doesNotMatch(logs, /UnhandledPromiseRejection|uncaught exception/i);
});

test("an existing summary-only chat displays the complete latest proposal directly in its reply, including after reload", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", error => errors.push(error.message));
  const remoteRequests: string[] = [];
  await page.route("https://images.example.test/**", route => { remoteRequests.push(route.request().url()); return route.fulfill(route.request().url().endsWith("missing.png") ? { status: 404, body: "" } : { status: 200, contentType: "image/png", body: png }); });
  await page.goto(`${base}/?token=${token}#/run/proposal-chat`);
  for (const reload of [false, true]) {
    const requestsBefore = remoteRequests.length;
    if (reload) await page.reload();
    const reply = page.locator('[data-agent-turn="s1"] .turn-body');
    const heading = reply.getByRole("heading", { name: "Proposed README", exact: true });
    await heading.waitFor();
    assert.equal(await heading.evaluate(node => !!node.closest("details")), false, "the proposal is not behind a disclosure");
    await reply.getByRole("heading", { name: "Client setup", exact: true }).waitFor();
    const screenshot = reply.getByRole("img", { name: "Repository screenshot", exact: true });
    await screenshot.waitFor();
    assert.equal(remoteRequests.length, requestsBefore, "opening or reloading a proposal does not contact remote image hosts");
    assert.equal(await reply.getByRole("img").count(), 1, "only the repository image loads automatically");
    await reply.getByRole("button", { name: "Load image: Package version from images.example.test", exact: true }).click();
    await reply.getByRole("button", { name: "Load image: Unavailable badge from images.example.test", exact: true }).click();
    await reply.locator('.md-image-fallback[title="Image unavailable"]').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".team-reply img")].length === 2 && [...document.querySelectorAll<HTMLImageElement>(".team-reply img")].every(image => image.complete && image.naturalWidth > 0));
    assert.match((await screenshot.getAttribute("src"))!, /^data:image\/png;base64,/);
    assert.equal(await reply.getByRole("link", { name: "Package version", exact: true }).getAttribute("href"), "https://example.test/package");
    assert.equal(await reply.getByRole("img", { name: "Package version", exact: true }).getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(await reply.getByText("Unavailable badge", { exact: true }).getAttribute("title"), "Image unavailable");
    await reply.getByText("The final proposal line is preserved.", { exact: true }).waitFor();
    assert.match(await reply.innerText(), /Independent review still requests changes/);
    assert.doesNotMatch(await reply.innerText(), /Superseded|Private reasoning|Supporting evidence|fragment-|<div|<details|<summary|<b>|Generated marker|!\[|\]\(|\*\*/);
    assert.equal(await page.getByRole("button", { name: "Read team responses" }).count(), 0);
  }
  await page.close();
});

test("a proposal already in the lead's reply is not duplicated", async () => {
  const page = await browser.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.route("https://images.example.test/**", route => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.goto(`${base}/?token=${token}#/run/complete-chat`);
  await page.getByRole("heading", { name: "Proposed README", exact: true }).waitFor();
  await page.getByText("Loading saved response…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("heading", { name: "Proposed README", exact: true }).count(), 1);
  assert.equal(await page.locator(".team-reply").count(), 0);
  await page.close();
});

test("a failed automatic load offers an inline retry without hiding the recorded reply", async () => {
  const page = await browser.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.route("https://images.example.test/**", route => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.route("**/api/runs/proposal-worker", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Unavailable"}' }));
  await page.goto(`${base}/?token=${token}#/run/proposal-chat`);
  await page.getByRole("button", { name: "Retry loading response" }).waitFor();
  assert.match(await page.locator(".turn-body").innerText(), /Independent review still requests changes/);
  await page.unroute("**/api/runs/proposal-worker");
  await page.getByRole("button", { name: "Retry loading response" }).click();
  await page.locator(".turn-body").getByRole("heading", { name: "Proposed README", exact: true }).waitFor();
  await page.close();
});
