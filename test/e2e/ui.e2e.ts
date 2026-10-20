// End-to-end: the real UI in Chrome against a real server with fake agents.
// Run with `npm run test:e2e` (needs Google Chrome installed; no browser download).
import { prioritizedReviewRuns } from "../../src/review-inbox.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
// Ports the OS says are free — never one a real code-flow (4317) or dev server might be on.
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
const PORT = await freePort();
const REMOTE_PORT = await freePort(); // the phone's (Wi-Fi) listener
const BASE = `http://localhost:${PORT}`;
const TOKEN = "e2e-session-token";
const bearer = { authorization: `Bearer ${TOKEN}` };

/** A webhook is answered before its run starts: the run it started, once there is one. */
async function startedRun(automationId: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    const list: { id: string; lastRunId?: string }[] = await fetch(`${BASE}/api/automations`, { headers: bearer }).then((r) => r.json());
    const runId = list.find((a) => a.id === automationId)?.lastRunId;
    if (runId) return runId;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`automation ${automationId} didn't start a run`);
}
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

  // The terminals' login shell is bash with a home of its own: nobody's dotfiles (a question at
  // start-up, like oh-my-zsh's update prompt, would take the typed command as its answer), nothing
  // added to their shell history, a known prompt. Only the shell's home: the server keeps yours,
  // whose git identity the merge into main uses.
  const shellHome = mkdtempSync(join(tmpdir(), "codeflow-e2e-user-"));
  const loginShell = join(shellHome, "e2e-shell");
  writeFileSync(
    loginShell,
    `#!/bin/bash\nexport HOME='${shellHome}' HISTFILE='${join(shellHome, ".bash_history")}' BASH_SILENCE_DEPRECATION_WARNING=1 PS1='e2e$ '\nexec /bin/bash --noprofile --norc -i\n`,
    { mode: 0o755 },
  );

  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      SHELL: loginShell,
      PORT: String(PORT),
      CODEFLOW_REMOTE_PORT: String(REMOTE_PORT),
      CODEFLOW_HOME: mkdtempSync(join(tmpdir(), "codeflow-e2e-home-")),
      PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
      FAKE_GH_STATE: ghState,
      CODEFLOW_TOKEN: TOKEN,
      // The phone test reaches the Wi-Fi listener from this machine, which it otherwise refuses.
      CODEFLOW_LAN_ALLOW_LOCAL: "1", CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL: "1",
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

  // Choose the repository through the folder picker. The picker's opening listing (your home
  // folder) is held back until the path has been typed, then lands before Enter: it must not
  // replace what you typed.
  let releaseHome!: () => void;
  const homeHeld = new Promise<void>((resolve) => (releaseHome = resolve));
  await page.route(/\/api\/fs\b/, async (route) => {
    if (!new URL(route.request().url()).searchParams.has("path")) await homeHeld;
    await route.continue();
  });
  await page.getByRole("button", { name: "Choose repository" }).first().click();
  const path = page.getByLabel("Folder path");
  await path.fill(repo);
  releaseHome();
  await page.getByText("Open a folder marked Git, or type a path").waitFor();
  await path.press("Enter");
  await page.getByText("✓ This folder is a git repository").waitFor();
  await page.unroute(/\/api\/fs\b/);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.locator(".repo-btn:not(.project-btn) .name", { hasText: repo.split("/").pop()! }).waitFor();
  // The check is detected after the repo is chosen (two more requests): wait for it, don't race it.
  await page
    .waitForFunction(() => (document.querySelector("#checkCmd") as HTMLInputElement | null)?.value === "npm test", undefined, { timeout: 10_000 })
    .catch(() => undefined);
  assert.equal(await page.locator("#checkCmd").inputValue(), "npm test", "the check is detected from package.json");

  // Describe the task, pick the pipeline, start with the keyboard.
  await page.getByLabel("Workflow", { exact: true }).selectOption("pipeline");
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

  // Back on the run: the comment is in the thread, Claude's follow-up ran, and the check passes now.
  await page.getByText("✓ Finished — the check passes").waitFor({ timeout: 30_000 });
  await page.locator(".fu .msg-you", { hasText: "Implement it properly so npm test passes" }).waitFor();
  await page.locator(".fu-head", { hasText: "check passes" }).waitFor();

  // Merge into main from the UI.
  await page.getByRole("button", { name: "Merge…" }).click();
  await page.getByRole("button", { name: "Merge into main" }).click();
  await page.locator(".badge", { hasText: "Merged into main" }).waitFor();

  const log = execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: repo }).toString();
  assert.match(log, /^Merge codeflow\/.+\/build into main/);
  assert.ok(execFileSync("git", ["ls-files"], { cwd: repo }).toString().includes("claude-"), "Claude's fix is on main");
});

test("approve the plan from the UI: ask for changes, then approve", async () => {
  await page.goto(BASE);
  await page.getByLabel("Workflow", { exact: true }).selectOption("pipeline");
  await page.locator(".composer-options > summary").click();
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
  await page.getByLabel("Workflow", { exact: true }).selectOption("pipeline");
  if (!(await page.locator(".composer-options").getAttribute("open"))) await page.locator(".composer-options > summary").click();
  await page.getByRole("checkbox", { name: /Let me approve the plan/ }).uncheck(); // remembered from the last test
  // The fake Codex keeps this turn open until a message is steered into it.
  await page.getByLabel("Task", { exact: true }).fill("E2E: steer WAIT-FOR-STEER");
  await page.getByRole("button", { name: /^Start run/ }).click();
  await page.waitForURL(/#\/run\//);
  const runId = decodeURIComponent(page.url().split("#/run/")[1]!.split("/")[0]!);

  await page.locator(".tl-step", { hasText: "Implement plan" }).waitFor({ timeout: 30_000 });
  await page.locator("main .convo select").selectOption("codex");
  await page.locator("main .convo textarea").fill("Prefer tabs over spaces");
  await page.locator("main .convo textarea").press("Enter");
  await page.locator(".note-chip", { hasText: "✓ Delivered to codex mid-turn (Implement plan): Prefer tabs over spaces" }).waitFor({ timeout: 10_000 });
  await page.getByText(/✓ Finished|⚠ Finished/).first().waitFor({ timeout: 30_000 });

  const run = await fetch(`${BASE}/api/runs/${runId}`, { headers: bearer }).then((r) => r.json());
  const implement = run.steps.find((s: { title: string }) => s.title === "Implement plan");
  assert.deepEqual(run.notes.map((n: { deliveredTo: unknown }) => n.deliveredTo), [{ stepId: implement.id, agent: "codex", midTurn: true }]);
  assert.equal(implement.status, "done");
});

test("start from a PR with a template: the council's findings are ranked, and posting takes your click", async () => {
  await page.goto(BASE);
  await page.locator(".task-starters > summary").click();
  await page.getByRole("button", { name: "Template library", exact: true }).click();
  await page.getByRole("button", { name: /Review a PR as a council/ }).click();
  await page.locator(".gh-item", { hasText: "Add feature loop" }).click();
  assert.match(await page.getByLabel("Task", { exact: true }).inputValue(), /^Review pull request #1\./);
  await page.locator(".chip-ctx.source", { hasText: "PR #1" }).waitFor();
  await page.getByRole("button", { name: /^Start run/ }).click();

  await page.locator(".council .badge", { hasText: "Changes requested" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".findings li").count(), 3);
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
  const run = await startedRun(automation.id);

  await page.goto(`${BASE}/#/inbox`);
  const item = page.locator(".inbox-item", { hasText: "E2E: automated chore" });
  await item.waitFor({ timeout: 30_000 });
  assert.match(await page.locator(".rail-menu-count").innerText(), /^\d+$/, "the inbox count shows in the sidebar");
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

test("a check that can't run here: the result is still reviewed, and the inbox and the run say why", async () => {
  const api = (path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const automation = await api("/api/automations", {
    name: "E2E no env",
    webhook: true,
    run: { repo, pattern: "pipeline", task: "E2E: check can't run", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, loop: { check: "nosuchtool-e2e --run" } },
  });
  assert.ok(automation.token, automation.error);
  const fired = await fetch(`${BASE}/hooks/${automation.id}`, { method: "POST", headers: { authorization: `Bearer ${automation.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(fired.status, 202);
  const id = await startedRun(automation.id);

  await page.goto(`${BASE}/#/inbox`);
  const item = page.locator(".inbox-item", { hasText: "E2E: check can't run" });
  await item.waitFor({ timeout: 30_000 });
  await item.locator(".cant-run", { hasText: "nosuchtool-e2e" }).waitFor();
  assert.match(await item.locator(".ih .help").innerText(), /check couldn't run/);

  await item.locator("a.t").click();
  await page.getByText("⚠ Finished — but the check couldn't run, so nothing was tested").waitFor();
  await page.locator(".result .cant-run", { hasText: ".codeflow/config.json" }).waitFor();
  assert.equal(await page.locator(".run-head .status-pill").textContent(), "Finished");

  const run = await api(`/api/runs/${id}`);
  assert.equal(run.verdict, undefined, "unknown, not failing");
  const titles: string[] = run.steps.map((s: { title: string }) => s.title);
  assert.ok(titles.includes("Review (round 1)"), "the change is reviewed");
  assert.ok(!titles.some((t) => t.startsWith("Fix failing check")), "no fix rounds spent");
});

test("sweep: pick open issues, start one run each, and approve the results in the inbox", async () => {
  const s = JSON.parse(readFileSync(ghState, "utf8"));
  s.issues = [
    { number: 41, title: "E2E sweep: fix the greeting", body: "Hello is misspelled.", url: "https://github.com/o/r/issues/41", labels: [{ name: "bug" }] },
    { number: 42, title: "E2E sweep: how do I run it?", body: "A question.", url: "https://github.com/o/r/issues/42", labels: [{ name: "question" }] },
    { number: 43, title: "E2E sweep: tidy the readme", body: "", url: "https://github.com/o/r/issues/43", labels: [] },
  ];
  writeFileSync(ghState, JSON.stringify(s));

  await page.goto(BASE);
  await page.locator(".task-starters > summary").click();
  await page.getByRole("button", { name: /Fix open issues/ }).click();
  const dialog = page.locator("dialog.sweep-dialog");
  await dialog.locator(".sweep-item", { hasText: "fix the greeting" }).waitFor();
  assert.equal(await dialog.getByRole("checkbox", { name: /how do I run it/ }).isChecked(), false, "a question starts unpicked");
  await dialog.getByRole("checkbox", { name: /tidy the readme/ }).uncheck();
  await dialog.getByRole("button", { name: "Start 1 run" }).click();

  await page.waitForURL(/#\/inbox/);
  const item = page.locator(".inbox-item", { hasText: "E2E sweep: fix the greeting" });
  await item.waitFor({ timeout: 30_000 });
  await item.getByRole("button", { name: "✓ Approve" }).click();
  await item.waitFor({ state: "detached" });

  // The next sweep knows #41 has a run.
  await page.goto(BASE);
  await page.locator(".task-starters > summary").click();
  await page.getByRole("button", { name: /Fix open issues/ }).click();
  await dialog.locator(".sweep-item", { hasText: "fix the greeting" }).getByText("Already has a run").waitFor();
  assert.equal(await dialog.getByRole("checkbox", { name: /fix the greeting/ }).isChecked(), false);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("phone: with full control, the phone link signs a phone in to the whole app", async () => {
  const api = (path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const PHONE = `http://127.0.0.1:${REMOTE_PORT}`; // the Wi-Fi listener, reached the way a phone would
  const remote = await api("/api/remote", { enabled: true, lan: true, control: false });
  for (let i = 0; i < 50 && !(await fetch(`${PHONE}${remote.path}`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));

  // Without full control the link is the read-only view, and the app's API isn't served.
  assert.doesNotMatch(await (await fetch(`${PHONE}${remote.path}`)).text(), /<button|<form/);
  assert.equal((await fetch(`${PHONE}/api/runs`)).status, 404);

  // Full control has a link of its own: the read-only one never becomes a full-control link.
  const { phonePath } = await api("/api/remote", { control: true });
  assert.notEqual(phonePath, remote.path);
  const signIn = await fetch(`${PHONE}${phonePath}`, { redirect: "manual" });
  assert.equal(signIn.status, 200);
  assert.match(await signIn.text(), /location\.replace\("\/"\)/);
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(cookie, new RegExp(`^codeflow_phone_${REMOTE_PORT}=`));
  assert.equal((await fetch(`${PHONE}/api/runs`, { headers: { cookie } })).status, 200, "the phone's cookie opens the API");
  assert.equal((await fetch(`${PHONE}/api/runs`)).status, 401);
  assert.equal((await fetch(`${PHONE}/api/runs`, { headers: bearer })).status, 401, "the computer's token isn't a phone sign-in");
  assert.equal((await fetch(`${PHONE}/?token=${TOKEN}`, { redirect: "manual" })).status, 403, "the network listener must never issue a local owner cookie");
  assert.equal((await fetch(`${BASE}/api/runs`, { headers: { cookie } })).status, 401, "nor is the phone's cookie a sign-in on the computer's listener");
  const crossSite = await fetch(`${PHONE}/api/remote`, { method: "POST", headers: { cookie, origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(crossSite.status, 403);

  // A phone-sized browser: scanning the QR code lands in the app, ready to start a run.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const tab = await phone.newPage();
  await tab.goto(`${PHONE}${phonePath}`);
  await tab.getByRole("heading", { name: "What should the team build?" }).waitFor();
  assert.equal(new URL(tab.url()).pathname, "/");
  await tab.getByRole("button", { name: "Show runs" }).click();
  await tab.locator(".rail.open").waitFor();

  // A QR scanner hands the link over from another app, which the browser counts as cross-site:
  // a SameSite=Strict cookie set on a redirect wouldn't go along, and the phone would land on
  // "Scan the QR code again". Played here by a link on another site, in a phone not yet signed in.
  const scanner = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const scanned = await scanner.newPage();
  await scanned.route("http://qr-scanner.example/", (route) => route.fulfill({ contentType: "text/html", body: `<a href="${PHONE}${phonePath}">Open link</a>` }));
  await scanned.goto("http://qr-scanner.example/");
  await scanned.getByRole("link", { name: "Open link" }).click();
  await scanned.getByRole("heading", { name: "What should the team build?" }).waitFor();
  assert.equal(new URL(scanned.url()).pathname, "/");
  await scanner.close();

  // A new link signs phones out.
  await api("/api/remote", { rotate: true });
  await new Promise((r) => setTimeout(r, 200)); // phones' open connections are dropped just after the reply
  assert.equal((await fetch(`${PHONE}/api/runs`, { headers: { cookie } })).status, 401);
  await tab.reload();
  await tab.getByText("Scan the QR code again").waitFor();
  await phone.close();
  await api("/api/remote", { enabled: false, lan: false, control: false });
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
  await other.getByRole("button", { name: "New run", exact: true }).waitFor();
  await stranger.close();
});

test("insights and run search", async () => {
  await page.goto(`${BASE}/#/settings/insights`);
  await page.getByRole("heading", { name: "Insights" }).waitFor();
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  assert.ok(await page.getByRole("table").first().isVisible());
  await page.keyboard.press("/");
  await page.keyboard.type("automated chore");
  await page.getByText(/1 of \d+ runs/).waitFor();
  assert.equal(await page.locator(".rail .run-item").count(), 1);
});

test("supervisor: the reviewer defaults to a different vendor than the supervisor", async () => {
  await page.goto(BASE);
  await page.getByLabel("Workflow", { exact: true }).selectOption("supervisor");
  if (!(await page.locator(".composer-options").getAttribute("open"))) await page.locator(".composer-options > summary").click();
  if (!(await page.locator(".advanced-controls").getAttribute("open"))) await page.locator(".advanced-controls > summary").click();
  const role = (label: string) => page.locator(".role").filter({ has: page.locator(".rl", { hasText: new RegExp(`^${label}`) }) });
  const pressed = async (label: string) =>
    (await role(label).locator(".pill[aria-pressed=true]").allInnerTexts()).map((t) => t.replace(/^✓\s*/, "").trim());
  assert.deepEqual(await pressed("Reviewer"), ["Codex"], "the pattern's default when it isn't the supervisor");
  await role("Supervisor").getByRole("button", { name: "Codex", exact: true }).click();
  assert.deepEqual(await pressed("Supervisor"), ["Codex"]);
  assert.deepEqual(await pressed("Reviewer"), ["Claude Code"], "moves off the supervisor's vendor");
  // Your own choice stands, even to let the supervisor review itself.
  await role("Reviewer").getByRole("button", { name: "Skip" }).click();
  assert.deepEqual(await pressed("Reviewer"), ["Skip"]);
});

test("projects: the first run made one; the sidebar lists runs under their projects; a run moves back", async () => {
  const projects = () => fetch(`${BASE}/api/projects`, { headers: bearer }).then((r) => r.json() as Promise<{ id: string; name: string; repos: string[] }[]>);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim();
  const [own, ...others] = await projects();
  assert.deepEqual([own!.name, own!.repos, others.length], [root.split("/").pop(), [root], 0], "one project, named after the repo and holding it");

  await page.goto(BASE);
  const rail = page.locator(".rail");
  const group = (name: string) => rail.getByRole("group", { name, exact: true });
  await group(own!.name).locator(".run-item").first().waitFor(); // earlier runs, under the repo's project
  // The repo you last used comes back after the page loads: a new project starts with it.
  await page.locator(".where .repo-btn:not(.project-btn) .name", { hasText: own!.name }).waitFor();
  await rail.getByRole("button", { name: "New project" }).click();
  await page.locator("#project-name").fill("E2E side");
  assert.equal(await page.locator(".project-repos .dir").count(), 1, "starts with the repo you're in");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.locator(".where .project-btn", { hasText: "E2E side" }).waitFor(); // new runs start in it

  await page.getByLabel("Workflow", { exact: true }).selectOption("pipeline");
  if (!(await page.locator(".composer-options").getAttribute("open"))) await page.locator(".composer-options > summary").click();
  await page.getByRole("checkbox", { name: /Let me approve the plan/ }).uncheck(); // remembered from earlier tests: the run mustn't wait for approval
  await page.getByLabel("Task", { exact: true }).fill("E2E: in the side project");
  await page.getByRole("button", { name: /^Start run/ }).click();
  await page.getByText(/✓ Finished|⚠ Finished/).first().waitFor({ timeout: 30_000 });
  await page.locator(".project-chip", { hasText: "E2E side" }).waitFor();
  await page.locator(".crumbs-bar .crumb", { hasText: "E2E side" }).waitFor();
  await group("E2E side").locator(".run-item", { hasText: "E2E: in the side project" }).waitFor(); // seen once you look at it: under its project, not "Needs you"
  assert.deepEqual(await group("E2E side").locator(".run-item .t").allInnerTexts(), ["E2E: in the side project"], "the project lists its runs");
  assert.ok(await group(own!.name).locator(".run-item").count(), "and the other project's runs stay in view");

  // Move it back to the repo's own project.
  await page.locator(".project-chip").click();
  await page.locator(".move-choice").filter({ has: page.locator(".dn", { hasText: new RegExp(`^${own!.name}`) }) }).locator("input").check();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.locator(".project-chip", { hasText: own!.name }).waitFor();
  await group(own!.name).locator(".run-item", { hasText: "E2E: in the side project" }).waitFor();
  const runId = decodeURIComponent(page.url().split("#/run/")[1]!);
  const run = await fetch(`${BASE}/api/runs/${runId}`, { headers: bearer }).then((r) => r.json());
  assert.equal(run.project, own!.id);

  // E2E side has nothing to list now: it folds into "more projects", and its menu edits it.
  await rail.getByRole("button", { name: /^\d+ more projects?$/ }).click();
  await group("E2E side").getByRole("button", { name: "Edit E2E side" }).click();
  await page.getByRole("heading", { name: "Edit E2E side" }).waitFor();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.locator("dialog[open]").waitFor({ state: "detached" });

  // Back to every project for the tests that follow: new runs go in their repo's project.
  await page.goto(BASE);
  await page.locator(".where .project-btn").click();
  await page.locator(".project-row", { hasText: "All projects" }).locator(".pr-main").click();
});

test("side panel: chat with one agent, read a file, run a command, keep a note", async () => {
  await page.goto(BASE);
  await page.locator(".repo-btn:not(.project-btn) .name", { hasText: repo.split("/").pop()! }).waitFor(); // the remembered repo is loaded after the page
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const side = page.getByRole("complementary", { name: "Side panel" });

  // Chat: a question to Claude starts a Single-agent run; its answer shows in the panel.
  await side.getByRole("tab", { name: "Chat" }).click();
  await side.getByRole("button", { name: "Provider", exact: true }).click();
  await side.getByRole("menuitem", { name: /^Claude Code/ }).click();
  await side.getByRole("button", { name: "Model", exact: true }).click();
  await side.getByRole("option", { name: /^Sonnet/ }).click();
  await side.getByRole("button", { name: "Effort", exact: true }).click();
  await side.getByRole("menuitem", { name: "high", exact: true }).click();
  await side.getByLabel("Message").fill("E2E: what does check.mjs do?");
  await side.getByLabel("Message").press("Enter");
  await side.getByText("Implemented changes as claude.").waitFor({ timeout: 30_000 });
  assert.match(await side.locator(".chat-meta code").innerText(), /\/solo$/, "the chat works on its own branch");
  assert.equal(await page.locator(".rail .run-item", { hasText: "E2E: what does check.mjs do?" }).count(), 1, "a chat is a run like any other");

  // Files: a file opens in the shared editor.
  await side.getByRole("tab", { name: "Files" }).click();
  await side.locator(".node", { hasText: "package.json" }).click();
  await side.getByRole("textbox", { name: "File contents", exact: true }).waitFor();
  assert.match(await side.getByRole("textbox", { name: "File contents", exact: true }).inputValue(), /"name":"e2e"/);
  await side.getByRole("button", { name: "Back to the files" }).click();
  await side.locator(".node", { hasText: "check.mjs" }).waitFor();

  // Terminal: a real terminal (python3 is there); keystrokes reach the shell, which keeps its folder between commands.
  await side.getByRole("tab", { name: "Terminal" }).click();
  const screen = side.locator("#side-pane-terminal .term-x .xterm-rows");
  await screen.waitFor();
  await side.locator("#side-pane-terminal .term-x .xterm").click();
  await page.keyboard.type("mkdir -p sub && cd sub && echo side-$((20+22))");
  await page.keyboard.press("Enter");
  await screen.getByText("side-42").waitFor({ timeout: 15_000 });
  await page.keyboard.type("basename \"$PWD\"; false; echo code-$?");
  await page.keyboard.press("Enter");
  await screen.getByText("code-1").waitFor({ timeout: 10_000 });
  assert.match(await screen.innerText(), /(^|\n)sub\s*\n/, "`cd` held for the next command");

  // Notes: saved as you type, on the server.
  await side.getByRole("tab", { name: "Notes" }).click();
  await side.getByRole("textbox", { name: "Notes" }).fill("remember the loop bound");
  await side.getByText("Saved just now").waitFor({ timeout: 5_000 });
  const note = await fetch(`${BASE}/api/notes?key=${encodeURIComponent(realpathSync(repo))}`, { headers: bearer }).then((r) => r.json());
  assert.equal(note.text, "remember the loop bound");

  // The chat went in the repo's project, and didn't replace the team the composer remembers there.
  const projects: { id: string; repos: string[]; defaults?: { pattern: string } }[] = await fetch(`${BASE}/api/projects`, { headers: bearer }).then((r) => r.json());
  const chat = (await fetch(`${BASE}/api/runs`, { headers: bearer }).then((r) => r.json())).find((r: { task: string }) => r.task === "E2E: what does check.mjs do?");
  const own = projects.find((p) => p.repos.includes(realpathSync(repo)))!;
  assert.equal(chat.project, own.id);
  assert.deepEqual(chat.agentSettings.claude, { model: "sonnet", effort: "high" }, "chat starts with the model and effort selected beside the message");
  assert.notEqual(own.defaults?.pattern, chat.pattern, "a chat isn't the composer's choice of team");
});

test("side panel: follows the run you open, side chats in its worktree, its changes, terminals, and the pin", async () => {
  const api = (path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const created = await api("/api/runs", { repo, task: "E2E: a run for the panel", pattern: "pipeline", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {} });
  assert.ok(created.id, created.error);
  let run = await api(`/api/runs/${created.id}`);
  for (let i = 0; i < 150 && run.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 200));
    run = await api(`/api/runs/${created.id}`);
  }
  assert.equal(run.status, "done");
  const result = run.artifacts[0];
  assert.ok(result, "the run has a result");

  // No repository picked in the composer: the panel works in the run's anyway.
  await page.goto(`${BASE}/?token=${TOKEN}`); // signed in even when this test runs on its own
  const remembered = await page.evaluate(() => localStorage.getItem("repo"));
  await page.evaluate(() => localStorage.removeItem("repo"));
  // A new page, not a hash change: a hash-only goto can return on the old page's own history push,
  // and a reload then reloads that instead.
  await page.goto(`${BASE}/?token=${TOKEN}#/run/${created.id}`);
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const side = page.getByRole("complementary", { name: "Side panel" });
  const scope = side.locator(".side-scope");
  const chats = side.locator("#side-pane-chat .sess");
  await scope.getByText("E2E: a run for the panel").waitFor();
  assert.match(await scope.locator(".scope-state").innerText(), /following/i);

  // Files and Terminal open on the run's result.
  await side.getByRole("tab", { name: "Files" }).click();
  assert.equal(await side.getByLabel("Folder").inputValue(), result.path);
  await side.getByRole("tab", { name: "Terminal" }).click();
  await side.locator("#side-pane-terminal .sess.on").waitFor();
  assert.equal(await side.locator("#side-pane-terminal .sess.on .sess-pick").getAttribute("title"), result.path);
  // A second terminal in the repository, and both at once.
  await side.getByRole("button", { name: "New terminal" }).click();
  await side.locator(".pop-item", { hasText: "repository" }).click();
  await side.locator("#side-pane-terminal .sess").nth(1).waitFor();
  await side.getByRole("button", { name: "Split" }).click();
  await side.locator("#side-pane-terminal .term-pane").nth(1).waitFor();
  assert.equal(await side.locator("#side-pane-terminal .term-pane").count(), 2);

  // A side chat asks in the run's worktree; nothing is committed and the run's thread stays the team's.
  await side.getByRole("tab", { name: "Chat" }).click();
  await side.getByText("Chat about this run").waitFor();
  await side.getByLabel("Message").fill("E2E: what did this run change?");
  await side.getByLabel("Message").press("Enter");
  await side.locator("#side-pane-chat .fu-answer.done").first().waitFor({ timeout: 30_000 });
  assert.equal(await side.getByText("Choose a repository first.").count(), 0);
  run = await api(`/api/runs/${created.id}`);
  const ask = run.followUps.find((f: { message: string }) => f.message === "E2E: what did this run change?");
  assert.deepEqual([ask.kind, ask.side.mode, ask.worktree], ["side", "ask", run.worktrees.find((w: { path: string }) => w.path === result.path).name]);
  assert.equal(await page.locator(".runview").getByText("E2E: what did this run change?").count(), 0, "a side chat isn't in the run's thread");
  assert.match(await chats.first().innerText(), /E2E: what did this run change\?/);

  // Change: committed on the run's branch; the run's thread gets a line about it.
  await side.getByRole("button", { name: "Chat mode", exact: true }).click();
  await side.getByRole("menuitem", { name: /^Change/ }).click();
  await side.getByLabel("Message").fill("E2E: add a note");
  await side.getByLabel("Message").press("Enter");
  await page.locator(".runview .side-note").waitFor({ timeout: 30_000 });
  const branch = execFileSync("git", ["log", "-1", "--format=%s", result.branch], { cwd: repo }).toString().trim();
  assert.match(branch, /side chat · E2E: what did this run change\?/);

  // Changes: the run's files; the last step is the side chat's commit only.
  const diff = (last: boolean) => api(`/api/runs/${created.id}/diff?branch=${encodeURIComponent(result.branch)}${last ? "&last=1" : ""}`);
  const [all, lastStep] = [await diff(false), await diff(true)];
  assert.ok(lastStep.length > 0 && lastStep.length < all.length, `the side chat's commit is the last step: ${lastStep.length} of ${all.length}`);
  await side.getByRole("tab", { name: "Changes" }).click();
  await side.locator(".changes-sum", { hasText: new RegExp(`^${all.length} files? ·`) }).waitFor();
  await side.getByRole("button", { name: "Last step" }).click();
  await side.locator(".changes-sum", { hasText: new RegExp(`^${lastStep.length} files? ·.*in the last step`) }).waitFor();
  assert.deepEqual(await side.locator(".changes .rf .fp").allInnerTexts(), lastStep.map((f: { path: string }) => f.path));

  // Pinned, the panel stays on the run while you look at something else.
  await side.getByRole("button", { name: "Pin the panel to this run" }).click();
  await page.goto(`${BASE}/#/settings/insights`);
  await scope.getByText("Pinned").waitFor();
  await side.getByRole("tab", { name: "Chat" }).click();
  assert.match(await side.locator("#side-pane-chat .sess.on").innerText(), /E2E: what did this run change\?/, "still the run's side chat");
  await scope.getByRole("button", { name: "Follow" }).click();
  await scope.getByText("Following").waitFor();
  assert.equal(await scope.getByText("E2E: a run for the panel").count(), 0);
  assert.equal(await side.locator("#side-pane-chat .sess", { hasText: "E2E: what did this run change?" }).count(), 0, "elsewhere, the panel has its own chats");

  // Back on the run: its side chat again.
  await page.goto(`${BASE}/#/run/${created.id}`);
  await scope.getByText("E2E: a run for the panel").waitFor();
  await side.getByRole("tab", { name: "Chat" }).click();
  assert.match(await side.locator("#side-pane-chat .sess.on").innerText(), /E2E: what did this run change\?/);

  // The project's name in the sidebar opens its page, and the panel follows the project.
  const project = (await api("/api/projects")).find((p: { id: string }) => p.id === run.project);
  await page.locator(".rail .proj-toggle", { hasText: project.name }).first().click();
  await page.locator(".project-page h1", { hasText: project.name }).waitFor();
  assert.match(page.url(), new RegExp(`#/project/${project.id}$`));
  await scope.locator(".sc-where", { hasText: project.name }).waitFor();
  assert.equal(await side.getByRole("tab", { name: "Changes" }).count(), 0, "changes belong to runs");

  if (remembered) await page.evaluate((r) => localStorage.setItem("repo", r), remembered);
  await page.reload();
});

test("side panel browser: a run's app through the preview, annotated, sent to the main chat; a panel in its own window", async () => {
  const api = (path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const created = await api("/api/runs", { repo, task: "E2E: a run with an app", pattern: "pipeline", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {} });
  let run = await api(`/api/runs/${created.id}`);
  for (let i = 0; i < 150 && run.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 200));
    run = await api(`/api/runs/${created.id}`);
  }
  assert.equal(run.status, "done");
  const wt = run.worktrees.find((w: { path: string }) => w.path === run.artifacts[0].path);
  const appFile = join(mkdtempSync(join(tmpdir(), "codeflow-e2e-app-")), "app.cjs");
  writeFileSync(
    appFile,
    `require("http").createServer((q, r) => { if (q.url.startsWith("/api")) { r.writeHead(500); return r.end(); } r.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" }); r.end('<html><head><title>E2E app</title></head><body><header><button class="theme-toggle">Theme</button></header><script>console.error("E2E boom"); fetch("/api/x")</script></body></html>'); }).listen(process.env.PORT, "127.0.0.1");`,
  );
  const app = await api(`/api/runs/${created.id}/worktrees/${wt.name}/serve`, { command: `node ${JSON.stringify(appFile)}` });
  assert.equal(app.status, "running", JSON.stringify(app));

  await page.goto(`${BASE}/?token=${TOKEN}#/run/${created.id}`);
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const side = page.getByRole("complementary", { name: "Side panel" });
  await side.getByRole("tab", { name: "Browser" }).click();
  const frame = side.locator("#side-pane-browser iframe");
  await frame.waitFor();
  const src = new URL((await frame.getAttribute("src"))!);
  assert.equal(src.hostname, new URL(BASE).hostname, "the preview uses the host name code-flow was opened with");
  assert.notEqual(src.port, new URL(app.url).port, "the app is shown through the preview, on a port of its own");
  await side.getByRole("button", { name: /^Console · 2$/ }).waitFor({ timeout: 15_000 });

  // Pick the button, say what's wrong, and put it in the run's main chat.
  await side.getByRole("button", { name: "Pick", exact: true }).click();
  await side.frameLocator("#side-pane-browser iframe").locator("button.theme-toggle").click();
  await side.locator(".pins-tray .pin-row").waitFor({ timeout: 15_000 });
  await side.getByLabel("What about pin 1?").fill("E2E: the toggle is hard to see");
  await side.getByRole("button", { name: "Add to main chat" }).click();
  const box = page.locator(".runview .chatbox textarea");
  await page.locator(".runview .draft-img").waitFor();
  const text = await box.inputValue();
  assert.match(text, /header > button\.theme-toggle`?: E2E: the toggle is hard to see/);
  await page.locator(".runview .chatbox .send").click();
  for (let i = 0; i < 150; i++) {
    run = await api(`/api/runs/${created.id}`);
    if (run.followUps.at(-1)?.status === "done") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const reply = run.followUps.at(-1);
  assert.equal(reply.kind, "reply");
  assert.equal(reply.files.length, 1, "the snapshot went with the reply");

  // Snapshot: the page in a headless Chrome of the server's own, a box drawn on the picture, and the
  // picture (boxes numbered) and the box's close-up in the main chat.
  await side.getByRole("button", { name: "Snapshot", exact: true }).click();
  const stage = side.locator(".snap-stage");
  await stage.locator("img").waitFor({ timeout: 30_000 });
  assert.match(await side.locator(".snap-what").innerText(), /^Snapshot · \d+×\d+$/);
  const at = (await stage.boundingBox())!;
  await page.mouse.move(at.x + 10, at.y + 10);
  await page.mouse.down();
  await page.mouse.move(at.x + 90, at.y + 60, { steps: 5 });
  await page.mouse.up();
  await side.locator(".snap-box:not(.drawing)").waitFor();
  await side.getByLabel(/^What about pin \d+\?$/).fill("E2E: the header is too tall");
  await side.getByRole("button", { name: "Add to main chat" }).click();
  await page.locator(".runview .draft-img").nth(1).waitFor();
  const snapText = await box.inputValue();
  assert.match(snapText, /From a snapshot of http:\/\/(localhost|127\.0\.0\.1):\d+\/ \(\d+px wide, as a signed-out visitor sees it\); the boxes are numbered on snapshot-[\w-]+\.png:/);
  assert.match(snapText, /on the snapshot \(box \d+ on snapshot-[\w-]+\.png\): E2E: the header is too tall/);
  await page.locator(".runview .chatbox .send").click();
  for (let i = 0; i < 150; i++) {
    run = await api(`/api/runs/${created.id}`);
    if (run.followUps.length > 2 && run.followUps.at(-1)?.status === "done") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const names = run.followUps.at(-1).files.map((f: string) => f.split("/").pop());
  assert.equal(names.length, 2, JSON.stringify(names));
  assert.ok(names.some((n: string) => /-snapshot-[\w-]+\.png$/.test(n)) && names.some((n: string) => /-pin-[\w-]+-\d+\.png$/.test(n)), JSON.stringify(names));
  await fetch(`${BASE}/api/runs/${created.id}/worktrees/${wt.name}/serve`, { method: "DELETE", headers: bearer });

  // The panel in a window of its own, for this run.
  const popped = await browser.newPage({ viewport: { width: 560, height: 860 } });
  await popped.goto(`${BASE}/?token=${TOKEN}#/side/chat/${encodeURIComponent(`run:${created.id}`)}`);
  await popped.locator(".side-scope", { hasText: "E2E: a run with an app" }).waitFor();
  assert.match(await popped.locator(".scope-state").innerText(), /own window/i);
  assert.equal(await popped.locator(".rail").count(), 0, "just the panel");
  await popped.close();
});

test("projects: the Automations page and its inbox follow the project you're in; the phone view lists runs by project", async () => {
  const api = (path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim();
  const side = await api("/api/projects", { name: "E2E scoped", repos: [root] });
  assert.ok(side.id, side.error);
  const projects: { id: string; name: string; repos: string[] }[] = await api("/api/projects");
  const own = projects.find((p) => p.repos.includes(root))!; // the repo's first project: earlier runs and automations are in it
  assert.notEqual(own.id, side.id);
  const automation = await api("/api/automations", {
    name: "E2E side hook",
    webhook: true,
    run: { repo, project: side.id, pattern: "pipeline", task: "E2E: side chore", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, loop: { check: "" } },
  });
  assert.ok(automation.token, automation.error);
  const fired = await fetch(`${BASE}/hooks/${automation.id}`, { method: "POST", headers: { authorization: `Bearer ${automation.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(fired.status, 202);

  await page.goto(`${BASE}/#/inbox`);
  await page.locator(".project-btn").click(); // start from every project, whichever one earlier tests left selected
  await page.locator(".project-row", { hasText: "All projects" }).locator(".pr-main").click();
  await page.locator(".inbox-item", { hasText: "E2E: side chore" }).waitFor({ timeout: 30_000 });
  const pending = prioritizedReviewRuns(await api("/api/runs")).length;
  const total = (await api("/api/automations")).length;
  assert.ok(pending > 1 && total > 1, "earlier tests left results and automations in the repo's own project");

  await page.locator(".project-btn").click();
  await page.locator(".project-row", { hasText: "E2E scoped" }).locator(".pr-main").click();
  await page.locator(".project-btn", { hasText: "E2E scoped" }).waitFor();
  assert.deepEqual(await page.locator(".inbox-item a.t").allInnerTexts(), ["E2E: side chore"], "only this project's results");
  await page.locator(".automations .rail-hint", { hasText: `${pending - 1} in other projects need${pending === 2 ? "s" : ""} you` }).waitFor();
  assert.equal(await page.locator(".rail-menu-count").innerText(), String(pending), "the sidebar still counts every project's results");

  // The read-only phone view lists each project's runs under its name.
  const remote = await api("/api/remote", { enabled: true });
  const sections = (await (await fetch(`${BASE}${remote.path}`)).text()).split("<section>").slice(1);
  const under = (name: string) => sections.find((s) => s.startsWith(`<h2 class="project">${name}</h2>`)) ?? "";
  assert.match(under("E2E scoped"), /E2E: side chore/);
  assert.doesNotMatch(under(own.name), /E2E: side chore/);
  assert.match(under(own.name), /E2E: check can&#39;t run/);
  await api("/api/remote", { enabled: false });

  // Schedules are a separate destination but keep the same project scope.
  await page.goto(`${BASE}/#/automations`);
  await page.locator(".auto-row b", { hasText: "E2E side hook" }).waitFor();
  assert.deepEqual(await page.locator(".auto-row b").allInnerTexts(), ["E2E side hook"]);
  // "Show all" goes back to every project, as the sidebar's does.
  await page.locator(".automations .rail-hint", { hasText: "more in other projects" }).getByRole("button", { name: "Show all" }).click();
  await page.locator(".project-btn", { hasText: "All projects" }).waitFor();
  assert.equal(await page.locator(".auto-row").count(), total);
  await page.goto(`${BASE}/#/inbox`);
  await page.locator(".inbox-item").first().waitFor();
  assert.equal(await page.locator(".inbox-item").count(), pending);
});

test("simple composer supports reusable teams, parameterized tasks, readiness and keyboard navigation", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const fresh = await context.newPage();
  try {
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    await fresh.getByLabel("Workflow", { exact: true }).waitFor();
    assert.equal(await fresh.locator(".advanced-controls").getAttribute("open"), null, "advanced controls start collapsed");
    assert.equal(await fresh.getByRole("button", { name: "Side panel", exact: true }).getAttribute("aria-pressed"), "false", "first run leaves room for the task");
    if (process.env.CODEFLOW_UI_SCREENSHOTS) {
      mkdirSync(join(root, "output/playwright"), { recursive: true });
      await fresh.screenshot({ path: join(root, "output/playwright/composer-desktop.png") });
    }

    await fresh.goto(`${BASE}/#/run/%`);
    await fresh.getByRole("heading", { name: "This link is invalid" }).waitFor();
    await fresh.getByRole("button", { name: "Open new run", exact: true }).click();
    await fresh.keyboard.press("Meta+k");
    const commands = fresh.getByRole("combobox", { name: "Find a command, project or run" });
    await commands.fill("choose repository");
    const listedPaths: string[] = [];
    fresh.on("request", (request) => { const url = new URL(request.url()); if (url.pathname === "/api/fs") listedPaths.push(url.searchParams.get("path") ?? ""); });
    await commands.press("Enter");
    // Pasting and pressing Enter may happen before Preact commits its input state.
    await fresh.getByLabel("Folder path").evaluate((element, path) => {
      const input = element as HTMLInputElement;
      input.value = path;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, repo);
    await fresh.getByText("✓ This folder is a git repository").waitFor();
    assert.equal(listedPaths.at(-1), repo, "a delayed default listing cannot supersede same-tick explicit navigation");
    await fresh.getByRole("button", { name: "Use this folder", exact: true }).click();
    await fresh.waitForFunction(() => (document.querySelector("#checkCmd") as HTMLInputElement | null)?.value === "npm test");
    await fresh.getByLabel("Workflow", { exact: true }).selectOption("pipeline");
    await fresh.getByLabel("Task", { exact: true }).fill("E2E: improve {{component}} in {{package}}");
    // A slower earlier preset must not overwrite the user's newer choice. Starting while a
    // profile is being resolved would silently omit its gates, so execution stays disabled.
    let releaseLight!: () => void; let lightSeen!: () => void;
    const holdLight = new Promise<void>((resolve) => { releaseLight = resolve; });
    const lightRequested = new Promise<void>((resolve) => { lightSeen = resolve; });
    await fresh.route(/\/api\/verification\/profile\?/, async (route) => {
      const response = await route.fetch();
      if (new URL(route.request().url()).searchParams.get("preset") === "lightweight") { lightSeen(); await holdLight; }
      await route.fulfill({ response });
    });
    try {
      await fresh.locator(".composer-options > summary").click();
      await fresh.locator(".advanced-controls > summary").click();
      const profile = fresh.getByLabel("Verification gates", { exact: true });
      const lightResponse = fresh.waitForResponse((response) => new URL(response.url()).pathname === "/api/verification/profile" && new URL(response.url()).searchParams.get("preset") === "lightweight");
      await profile.selectOption("lightweight"); await lightRequested;
      assert.equal(await fresh.getByRole("button", { name: /^Start run/ }).isDisabled(), true, "pending verification gates cannot be omitted from a run");
      await profile.selectOption("thorough");
      await fresh.locator(".effective-settings > summary").click();
      const gates = fresh.locator(".effective-settings tr", { has: fresh.getByRole("rowheader", { name: "Verification gates", exact: true }) });
      await gates.getByText(/^thorough:/).waitFor();
      releaseLight(); await lightResponse;
      await fresh.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.match(await gates.innerText(), /thorough:/, "late earlier profile response cannot replace the current gates");
      assert.match(await fresh.locator(".effective-settings tr", { has: fresh.getByRole("rowheader", { name: "Agent container", exact: true }) }).innerText(), /Host CLI execution/);
      await profile.selectOption("");
      await fresh.locator(".effective-settings > summary").click();
      await fresh.locator(".advanced-controls > summary").click();
    } finally { releaseLight(); await fresh.unroute(/\/api\/verification\/profile\?/); }
    await fresh.locator(".acceptance-editor > summary").click();
    await fresh.getByLabel("One requirement per line").fill("{{component}} has automated tests.\nExisting behavior is preserved.");
    const openLibrary = async () => {
      await fresh.evaluate(() => { location.hash = "/settings/projects"; });
      await fresh.getByRole("region", { name: "Project run defaults" }).waitFor();
      if (await fresh.getByLabel("Library scope").count()) await fresh.getByLabel("Library scope").selectOption("personal");
      await fresh.locator(".composer-library > summary").click();
    };
    await openLibrary();
    await fresh.getByLabel("Workflow name", { exact: true }).fill("E2E saved team");
    await fresh.getByRole("button", { name: "Save current workflow", exact: true }).click();
    await fresh.getByLabel("Revision to apply").waitFor();
    await fresh.evaluate(() => { location.hash = "/"; });
    await fresh.getByRole("button", { name: "Agent workflow mode", exact: true }).click();
    await openLibrary();
    await fresh.getByLabel("Saved workflow", { exact: true }).selectOption({ label: "E2E saved team · r1" });
    await fresh.getByRole("button", { name: "Save new revision", exact: true }).click();
    await fresh.getByLabel("Revision to apply").selectOption("1");
    await fresh.getByRole("button", { name: "Apply workflow", exact: true }).click();
    await fresh.getByLabel("Template name", { exact: true }).fill("E2E parameterized task");
    await fresh.getByRole("button", { name: "Save current task as template", exact: true }).click();
    await fresh.evaluate(() => { location.hash = "/"; });
    assert.equal(await fresh.getByLabel("Workflow", { exact: true }).inputValue(), "pipeline", "a previous team revision restores the original workflow");
    await fresh.getByLabel("Task", { exact: true }).fill("temporary draft");
    await fresh.locator(".composer-options > summary").click();
    await fresh.locator(".taskbox").getByRole("button", { name: "Run actions", exact: true }).click();
    await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click();
    const templateDialog = fresh.getByRole("dialog", { name: "Template library", exact: true });
    await templateDialog.getByLabel("Library", { exact: true }).selectOption("personal");
    await templateDialog.getByLabel("Template", { exact: true }).selectOption({ label: "E2E parameterized task" });
    await fresh.getByLabel("component", { exact: true }).fill("login form");
    await fresh.getByLabel("package", { exact: true }).fill("frontend");
    await fresh.getByRole("button", { name: "Use template", exact: true }).click();
    assert.equal(await fresh.getByLabel("Task", { exact: true }).inputValue(), "E2E: improve login form in frontend");
    await fresh.locator(".acceptance-editor > summary").click();
    assert.match(await fresh.getByLabel("One requirement per line").inputValue(), /^login form has automated tests/);
    await fresh.evaluate(() => { location.hash = "/settings/projects"; });
    await fresh.locator(".readiness > summary").click();
    await fresh.getByRole("button", { name: "Inspect readiness", exact: true }).click();
    await fresh.locator(".readiness-results").getByText("Repository and base", { exact: true }).waitFor({ timeout: 30_000 });
    await fresh.evaluate(() => { location.hash = "/"; });
    await fresh.getByLabel("Task", { exact: true }).press("Meta+Enter");
    await fresh.waitForURL(/#\/run\//);
    const id = decodeURIComponent(fresh.url().split("#/run/")[1]!);
    const created = await fetch(`${BASE}/api/runs/${id}`, { headers: bearer }).then((res) => res.json());
    assert.match(created.task, /Acceptance criteria:\n1\. login form has automated tests\.\n2\. Existing behavior is preserved\./);

    await fresh.keyboard.press("Meta+k");
    await commands.fill("new run");
    await commands.press("Enter");
    await fresh.getByLabel("Workflow", { exact: true }).waitFor();
    await fresh.setViewportSize({ width: 390, height: 844 });
    const start = await fresh.getByRole("button", { name: /^Start run/ }).boundingBox();
    assert.ok(start && start.y >= 0 && start.y + start.height <= 844, "primary action is visible on a phone without scrolling");
    if (process.env.CODEFLOW_UI_SCREENSHOTS) await fresh.screenshot({ path: join(root, "output/playwright/composer-mobile.png") });
  } finally { await context.close(); }
});

test("chat menus apply model, effort and permissions to the next reply and survive reload", async () => {
  const api = (path: string, body?: unknown) => fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
  const created = await api("/api/runs", { repo, task: "Chat options fixture", pattern: "solo", roles: { agent: ["codex"] }, options: {}, trust: "standard" });
  const completed = async () => {
    for (let n = 0; n < 150; n++) {
      const run = await api(`/api/runs/${created.id}`);
      if (run.status !== "running") { assert.equal(run.status, "done", run.error); return run; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("chat did not finish");
  };
  await completed();
  const catalog = (await api("/api/models")).codex;
  const model = catalog.models.find((entry: { efforts?: string[] }) => entry.efforts?.includes("high"));
  assert.ok(model);
  await page.goto(`${BASE}/?token=${TOKEN}#/run/${created.id}`);
  const main = page.getByRole("main");
  await main.locator(".chat-provider-fixed", { hasText: "Codex" }).waitFor();
  assert.equal(await main.getByRole("button", { name: "Provider", exact: true }).count(), 0, "a started single-agent chat cannot change provider");
  await main.getByRole("button", { name: "Model", exact: true }).click();
  await main.getByRole("option", { name: model.label, exact: true }).click();
  await main.getByRole("button", { name: "Effort", exact: true }).click();
  await main.getByRole("menuitem", { name: "high", exact: true }).click();
  await main.getByRole("button", { name: "Permissions", exact: true }).click();
  await main.getByRole("menuitem", { name: /^Ask for approval/ }).click();
  await main.getByRole("textbox", { name: "Reply", exact: true }).fill("Use the chosen settings");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await main.getByText("Use the chosen settings", { exact: true }).waitFor();
  let run = await completed();
  assert.deepEqual(run.followUps.at(-1).settings, { model: model.id, effort: "high" });
  assert.equal(run.followUps.at(-1).tools, true);
  assert.equal(run.followUps.at(-1).trust, "standard");
  await page.reload();
  await main.getByRole("button", { name: "Permissions", exact: true }).waitFor();
  assert.match(await main.getByRole("button", { name: "Permissions", exact: true }).innerText(), /Ask for approval/);
  assert.match(await main.getByRole("button", { name: "Effort", exact: true }).innerText(), /high/);
  await main.getByRole("button", { name: "Model", exact: true }).click();
  await main.getByRole("option", { name: /^Default model/ }).click();
  await main.getByRole("button", { name: "Effort", exact: true }).click();
  await main.getByRole("menuitem", { name: /^Default effort/ }).click();
  await main.getByRole("button", { name: "Permissions", exact: true }).click();
  await main.getByRole("menuitem", { name: /^Full access/ }).click();
  await main.getByRole("textbox", { name: "Reply", exact: true }).fill("Use defaults for this reply");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await main.getByText("Use defaults for this reply", { exact: true }).waitFor();
  run = await completed();
  assert.deepEqual(run.followUps.at(-1).settings, {});
  assert.equal(run.followUps.at(-1).tools, false);
  assert.equal(run.followUps.at(-1).trust, "full");
});


test("chat menu starts another provider with carried-over context", async () => {
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const source = await api("/api/runs", { repo, task: "Portable context fixture", pattern: "solo", roles: { agent: ["codex"] }, options: {}, trust: "standard" });
  for (let n = 0; n < 150; n++) {
    const run = await api(`/api/runs/${source.id}`);
    if (run.status !== "running") { assert.equal(run.status, "done", run.error); break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.goto(`${BASE}/?token=${TOKEN}#/run/${source.id}`);
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Chat actions", exact: true }).click();
  const actions = main.getByRole("menu", { name: "Chat actions", exact: true });
  const menuBox = await actions.boundingBox();
  const chatBox = await main.locator(".chatbox").boundingBox();
  assert.ok(menuBox && chatBox && menuBox.x >= chatBox.x && menuBox.x + menuBox.width <= chatBox.x + chatBox.width, "the menu stays inside the chat column instead of overlapping the side panel");
  assert.equal(await actions.locator(".pi-main").evaluate((element) => getComputedStyle(element).whiteSpace), "normal", "the complete action label can wrap");
  await main.getByRole("menuitem", { name: /^Start new chat with another provider/ }).click();
  const dialog = page.getByRole("dialog", { name: "New chat with another provider" });
  await dialog.getByRole("button", { name: "Provider", exact: true }).click();
  assert.equal(await dialog.getByRole("menuitem", { name: "Codex", exact: true }).count(), 0);
  await dialog.getByRole("menuitem", { name: /Claude Code/ }).click();
  await dialog.getByPlaceholder("What should the new chat do?").fill("Review the previous answer");
  const response = page.waitForResponse((response) => response.url().endsWith(`/api/runs/${source.id}/provider-chat`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start new chat", exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 201, await result.text());
  const childId = (await result.json()).id;
  await page.waitForURL(url => url.hash === `#/run/${childId}`);
  const child = await api(`/api/runs/${childId}`);
  assert.deepEqual(child.roles.agent, ["claude"]);
  assert.equal(child.parentRunId, source.id);
  assert.equal(child.repo, realpathSync(repo));
  assert.match(child.task, /^Review the previous answer/);
  assert.ok(child.context.attachments.some((file: { name: string }) => file.name === `chat-handoff-${source.id}.md`));
  assert.deepEqual((await api(`/api/runs/${source.id}`)).roles.agent, ["codex"]);
});


test("single-agent setup is inline and completed replies show running checks clearly", async () => {
  const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await fresh.addInitScript((repo) => {
      localStorage.setItem("repo", repo); localStorage.setItem("pattern", "solo");
      localStorage.setItem("roleSel", JSON.stringify({ solo: { agent: ["claude"] } }));
      localStorage.setItem("roleModels", JSON.stringify({ solo: { agent: { claude: { model: "opus", effort: "low" } } } }));
    }, repo);
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    const box = fresh.locator(".taskbox");
    await box.getByRole("button", { name: "Model", exact: true }).waitFor();
    assert.equal(await fresh.locator(".composer-options").getAttribute("open"), null);
    assert.match(await box.getByRole("button", { name: "Model", exact: true }).innerText(), /opus/i);
    await box.getByRole("button", { name: "Model", exact: true }).click();
    await box.getByRole("option", { name: /^Haiku/ }).click();
    await box.getByRole("button", { name: "Effort", exact: true }).click();
    await box.getByRole("menuitem", { name: "high", exact: true }).click();
    assert.equal(await fresh.evaluate(() => JSON.parse(localStorage.getItem("agentSettings") || "{}").claude?.model), undefined, "run model choices do not change the provider default in Settings");
    assert.equal(await fresh.getByLabel("Workflow", { exact: true }).count(), 0);
    await box.getByRole("button", { name: "Agent workflow mode", exact: true }).click();
    await box.getByLabel("Workflow", { exact: true }).selectOption("supervisor");
    assert.equal(await box.locator(".chat-controls").count(), 0);
    await fresh.getByRole("button", { name: "Agent workflow mode", exact: true }).click();
    assert.match(await box.getByRole("button", { name: "Model", exact: true }).innerText(), /Haiku/);
    await box.getByRole("button", { name: "Agent workflow mode", exact: true }).click();
    assert.equal(await box.getByLabel("Workflow", { exact: true }).inputValue(), "supervisor", "team toggle remembers the last workflow");
    await box.getByRole("button", { name: "Agent workflow mode", exact: true }).click();
    await fresh.locator(".composer-options > summary").click();
    await fresh.getByLabel("Done when this passes", { exact: true }).fill('node -e "setTimeout(() => {}, 4000)"');
    await fresh.locator(".composer-options > summary").click();
    await fresh.getByRole("textbox", { name: "Task", exact: true }).fill("Inline single-agent fixture");
    await box.getByRole("button", { name: "Start run", exact: true }).click();
    await fresh.locator(".chat-check").waitFor();
    await fresh.getByRole("button", { name: "Stop checks", exact: true }).waitFor();
    assert.match(await fresh.locator(".chat-check").innerText(), /The agent has finished/);
    assert.match(await fresh.locator(".chat-check code").innerText(), /setTimeout/);
    await fresh.getByRole("button", { name: "More run actions", exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await fresh.getByRole("button", { name: "Stop run", exact: true }).count(), 0);
    const id = fresh.url().split("/run/")[1];
    const run = await fetch(`${BASE}/api/runs/${id}`, { headers: bearer }).then((response) => response.json());
    assert.deepEqual(run.roles.agent, ["claude"]);
    assert.deepEqual(run.agentSettings.claude, { model: "haiku", effort: "high" });
    assert.deepEqual(run.roleSettings.agent.claude, { model: "haiku", effort: "high" });
  } finally { await fresh.close(); }
});

test("project defaults stay repository-scoped and a run creates its worktree from the selected branch", async () => {
  const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const project = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ name: "Composer defaults", repos: [repo] }) }).then((response) => response.json());
  assert.ok(project.id);
  try {
    await fresh.addInitScript(({ repository, projectId }) => { localStorage.setItem("repo", repository); localStorage.setItem("pattern", "solo"); localStorage.setItem("sideOpen", "0"); localStorage.setItem("project", projectId); }, { repository: repo, projectId: project.id });
    await fresh.goto(`${BASE}/?token=${TOKEN}#/settings/projects`);
    await fresh.getByLabel("Project", { exact: true }).selectOption(project.id);
    await fresh.waitForFunction(() => !(document.querySelector('[aria-label="Default check command"]') as HTMLInputElement)?.disabled);
    await fresh.getByLabel("Default check command", { exact: true }).fill("node -e \"process.exit(0)\"");
    await fresh.getByLabel("Worktree setup command", { exact: true }).fill("node -e \"process.exit(0)\"");
    await fresh.getByLabel("Default verification profile", { exact: true }).selectOption("standard");
    await fresh.getByRole("checkbox", { name: "Use Docker isolation by default" }).check();
    await fresh.getByLabel("Default container image", { exact: true }).fill("fixture-image:latest");
    await fresh.getByRole("button", { name: "Save project defaults", exact: true }).click();
    await fresh.getByRole("status").getByText("Project defaults saved.").waitFor();
    await fresh.reload();
    await fresh.getByLabel("Project", { exact: true }).selectOption(project.id);
    assert.equal(await fresh.getByLabel("Default verification profile").inputValue(), "standard");
    assert.equal(await fresh.getByLabel("Default container image").inputValue(), "fixture-image:latest");
    await fresh.evaluate(() => { location.hash = "/"; });
    await fresh.getByRole("button", { name: "Agent workflow mode", exact: true }).waitFor();
    assert.equal(await fresh.locator(".composer-options").getAttribute("open"), null);
    assert.equal(await fresh.locator(".readiness, .composer-library, #setupCmd").count(), 0, "project setup and library management are absent from the run view");
    await fresh.locator(".taskbox").getByLabel("Start from branch", { exact: true }).selectOption("origin/feature");
    await fresh.locator(".composer-options > summary").click();
    await fresh.locator(".advanced-controls > summary").click();
    assert.equal(await fresh.getByLabel("Verification gates", { exact: true }).inputValue(), "standard");
    await fresh.getByLabel("Verification gates", { exact: true }).selectOption("");
    await fresh.locator(".agent-isolation > summary").click();
    assert.equal(await fresh.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image" }).isChecked(), true);
    await fresh.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image" }).uncheck();
    await fresh.getByLabel("Done when this passes", { exact: true }).fill("node -e \"process.exit(0); /* run override */\"");
    assert.equal(await fresh.evaluate((path) => localStorage.getItem(`check:${path}`), realpathSync(repo)), "node -e \"process.exit(0)\"", "run overrides do not overwrite the project default");
    await fresh.getByLabel("Task", { exact: true }).fill("Verify selected branch and project defaults");
    await fresh.locator(".taskbox").getByRole("button", { name: "Run actions", exact: true }).click();
    await fresh.getByRole("menuitem", { name: "Schedule…", exact: true }).click();
    await fresh.getByRole("dialog", { name: "Schedule work" }).getByRole("button", { name: /Run once later/ }).click();
    await fresh.getByRole("dialog", { name: "Start later", exact: true }).waitFor();
    await fresh.getByRole("dialog", { name: "Start later", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await fresh.getByRole("button", { name: "Start run", exact: true }).click();
    await fresh.waitForURL(/#\/run\//);
    const id = fresh.url().split("/run/")[1];
    const run = await fetch(`${BASE}/api/runs/${id}`, { headers: bearer }).then((response) => response.json());
    const branchCommit = execFileSync("git", ["rev-parse", "origin/feature"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(run.baseRef, branchCommit);
    assert.equal(run.baseLabel, "origin/feature");
    assert.match(run.loop.check, /run override/);
    assert.equal(run.loop.setup, "node -e \"process.exit(0)\"");
    assert.equal(run.loop.agentContainer, undefined);
    assert.ok(!run.loop.verification);
    await fresh.getByRole("button", { name: "More run actions", exact: true }).waitFor({ timeout: 30000 });
  } finally { await fresh.close(); }
});

test("chatbox saves templates to the chosen library and makes them immediately reusable", async () => {
  const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const project = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ name: "Quick templates", repos: [repo] }) }).then((response) => response.json());
  try {
    await fresh.addInitScript(({ repository, id }) => { localStorage.setItem("repo", repository); localStorage.setItem("project", id); localStorage.setItem("pattern", "solo"); localStorage.setItem("sideOpen", "0"); }, { repository: repo, id: project.id });
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    const menu = fresh.locator(".taskbox").getByRole("button", { name: "Run actions", exact: true });
    await menu.click();
    assert.equal(await fresh.getByRole("menuitem", { name: "Save as template…", exact: true }).isDisabled(), true);
    await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click();
    const useDialog = fresh.getByRole("dialog", { name: "Template library", exact: true });
    await useDialog.getByLabel("Template", { exact: true }).waitFor();
    assert.equal(await useDialog.locator('optgroup[label="Saved templates"] option').count(), 0);
    assert.equal(await useDialog.getByRole("button", { name: "Use template", exact: true }).isDisabled(), true);
    await useDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await fresh.getByLabel("Task", { exact: true }).fill("Review {{component}} for regressions.");
    await fresh.locator(".composer-options > summary").click();
    await fresh.locator(".acceptance-editor > summary").click();
    await fresh.getByLabel("One requirement per line").fill("Cover {{component}} with tests.");
    const saveTemplate = async (scope: string, name: string) => {
      await menu.click(); await fresh.getByRole("menuitem", { name: "Save as template…", exact: true }).click();
      const dialog = fresh.getByRole("dialog", { name: "Save as template", exact: true });
      assert.equal(await dialog.getByRole("button", { name: "Save template", exact: true }).isDisabled(), true);
      await dialog.getByLabel("Template name", { exact: true }).fill(name);
      await dialog.getByLabel("Save to", { exact: true }).selectOption(scope);
      await dialog.getByLabel("Template name", { exact: true }).press("Enter");
      await dialog.waitFor({ state: "hidden" });
      assert.ok(!fresh.url().includes("settings"), "saving keeps the composer open");
      await menu.click(); await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click();
      assert.equal(await useDialog.getByLabel("Library", { exact: true }).inputValue(), scope);
      await useDialog.getByLabel("Template", { exact: true }).getByRole("option", { name, exact: true }).waitFor({ state: "attached" });
      await useDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    };
    await saveTemplate("project", "Project review");
    await saveTemplate("personal", "Personal review");
    const libraries = await fresh.evaluate((id) => [JSON.parse(localStorage.getItem(`composerLibrary:${id}`)!), JSON.parse(localStorage.getItem("composerLibrary")!)], project.id);
    assert.deepEqual(libraries.map((library) => library.templates.map((template: any) => template.name)), [["Project review"], ["Personal review"]]);
    assert.equal(libraries[0].templates[0].pattern, "solo");
    assert.deepEqual(libraries[0].templates[0].criteria, ["Cover {{component}} with tests."]);
    await fresh.getByLabel("Task", { exact: true }).fill("Temporary draft");
    await fresh.locator(".composer-options > summary").click();
    await menu.click(); await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click();
    await useDialog.getByLabel("Template", { exact: true }).selectOption({ label: "Personal review" });
    await useDialog.getByLabel("component", { exact: true }).fill("discard");
    await useDialog.getByLabel("Library", { exact: true }).selectOption("project");
    assert.equal(await useDialog.getByLabel("Template", { exact: true }).inputValue(), "");
    await useDialog.getByLabel("Template", { exact: true }).selectOption({ label: "Project review" });
    assert.equal(await useDialog.getByLabel("component", { exact: true }).inputValue(), "");
    await useDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await fresh.getByLabel("Task", { exact: true }).inputValue(), "Temporary draft", "cancel preserves the current task");
    await fresh.setViewportSize({ width: 390, height: 844 });
    await menu.click(); await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click();
    await useDialog.getByLabel("Template", { exact: true }).selectOption({ label: "Personal review" });
    assert.equal(await useDialog.getByRole("button", { name: "Use template", exact: true }).isDisabled(), true);
    await useDialog.getByLabel("component", { exact: true }).fill("login");
    assert.equal(await useDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "template picker fits a phone viewport");
    await useDialog.getByRole("button", { name: "Use template", exact: true }).click();
    assert.equal(await fresh.locator(".composer-options").getAttribute("open"), null, "templates can be used without opening run options");
    assert.equal(await fresh.getByLabel("Task", { exact: true }).inputValue(), "Review login for regressions.");
    assert.equal(await fresh.getByLabel("One requirement per line").inputValue(), "Cover login with tests.");
    await fresh.reload();
    await fresh.locator(".composer-options > summary").click();
    assert.equal(await fresh.getByLabel("Run template library").count(), 0);
    assert.equal(await fresh.getByLabel("Use saved team or template").count(), 0);
    await menu.click(); await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click();
    await useDialog.getByLabel("Template", { exact: true }).getByRole("option", { name: "Project review", exact: true }).waitFor({ state: "attached" });
    await useDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await fresh.getByText("Settings and more", { exact: true }).count(), 0);
  } finally { await fresh.close(); }
});

test("template picker edits and deletes within its library without changing the current draft", async () => {
  const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const project = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ name: "Manage templates", repos: [repo] }) }).then((response) => response.json());
  try {
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    await fresh.evaluate(({ repository, id }) => {
      localStorage.setItem("repo", repository); localStorage.setItem("project", id); localStorage.setItem("pattern", "solo"); localStorage.setItem("sideOpen", "0");
      const library = { schemaVersion: 1, presets: [], templates: [{ id: "template-one", name: "Review", pattern: "solo", task: "Review {{component}}", criteria: ["Test {{component}}"] }] };
      localStorage.setItem(`composerLibrary:${id}`, JSON.stringify(library)); localStorage.setItem("composerLibrary", JSON.stringify(library));
    }, { repository: repo, id: project.id });
    await fresh.reload();
    await fresh.getByLabel("Task", { exact: true }).fill("Keep my draft");
    const open = async () => { await fresh.locator(".taskbox").getByRole("button", { name: "Run actions", exact: true }).click(); await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click(); };
    const dialog = fresh.getByRole("dialog", { name: "Template library", exact: true });
    await open(); await dialog.getByLabel("Template", { exact: true }).selectOption("saved:template-one");
    await dialog.getByRole("button", { name: "Edit template", exact: true }).click();
    await dialog.getByLabel("Template name", { exact: true }).fill("Discarded edit");
    await dialog.getByRole("button", { name: "Cancel editing", exact: true }).click();
    assert.equal(await dialog.getByLabel("Template", { exact: true }).locator("option:checked").innerText(), "Review");
    await dialog.getByRole("button", { name: "Edit template", exact: true }).click();
    await dialog.getByLabel("Template name", { exact: true }).fill("Updated review");
    await dialog.getByLabel("Workflow", { exact: true }).selectOption("pipeline");
    await dialog.getByLabel("Template task", { exact: true }).fill("Inspect {{module}} carefully");
    await dialog.getByLabel("Acceptance criteria", { exact: true }).fill("Test {{module}}\nKeep compatibility");
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.getByLabel("module", { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel("component", { exact: true }).count(), 0, "edited placeholders replace the previous inputs");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await fresh.getByLabel("Task", { exact: true }).inputValue(), "Keep my draft");
    let releaseProjects!: () => void;
    const projectsGate = new Promise<void>(resolve => { releaseProjects = resolve; });
    await fresh.route("**/api/projects", async route => { await projectsGate; await route.continue(); });
    try {
      await fresh.reload();
      await fresh.locator(".taskbox").getByRole("button", { name: "Run actions", exact: true }).click();
      assert.equal(await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).isDisabled(), true, "the picker waits for project libraries before choosing its scope");
    } finally { releaseProjects(); }
    await fresh.getByRole("menuitem", { name: "Use template…", exact: true }).click();
    await fresh.unroute("**/api/projects");
    await dialog.getByLabel("Template", { exact: true }).selectOption({ label: "Updated review" });
    const saved = await fresh.evaluate((id) => JSON.parse(localStorage.getItem(`composerLibrary:${id}`)!).templates[0], project.id);
    assert.deepEqual(saved, { id: "template-one", name: "Updated review", pattern: "pipeline", task: "Inspect {{module}} carefully", criteria: ["Test {{module}}", "Keep compatibility"] });
    await dialog.getByRole("button", { name: "Delete template…", exact: true }).click();
    await dialog.getByRole("button", { name: "Keep template", exact: true }).click();
    assert.equal(await dialog.getByLabel("Template", { exact: true }).inputValue(), "saved:template-one");
    await dialog.getByRole("button", { name: "Delete template…", exact: true }).click();
    await dialog.getByRole("button", { name: "Delete template", exact: true }).click();
    assert.equal(await dialog.getByLabel("Template", { exact: true }).getByRole("option", { name: "Updated review", exact: true }).count(), 0);
    await dialog.getByLabel("Library", { exact: true }).selectOption("personal");
    await dialog.getByLabel("Template", { exact: true }).selectOption({ label: "Review" });
    await dialog.getByLabel("component", { exact: true }).fill("login");
    await dialog.getByRole("button", { name: "Use template", exact: true }).click();
    assert.equal(await fresh.getByLabel("Task", { exact: true }).inputValue(), "Review login", "the personal template with the same ID is unchanged");
    assert.deepEqual(await fresh.evaluate((id) => JSON.parse(localStorage.getItem(`composerLibrary:${id}`)!).templates, project.id), []);
  } finally { await fresh.close(); }
});


test("sidebar archives, hides and deletes runs with confirmation across tabs", async () => {
  const task = "Sidebar history management fixture";
  const created = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ repo, task, pattern: "solo", roles: { agent: ["claude"] }, options: {} }) }).then(r => r.json());
  assert.ok(created.id);
  for (let i = 0; i < 150; i++) {
    const run = await fetch(`${BASE}/api/runs/${created.id}`, { headers: bearer }).then(r => r.json());
    if (run.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Opening an unread completed run moves its row out of Needs you. Settle that
  // unrelated transition before exercising the row's archive/delete menu.
  assert.equal((await fetch(`${BASE}/api/runs/${created.id}/seen`, { method: "POST", headers: bearer })).ok, true);
  const fresh = await browser.newPage({ viewport: { width: 1267, height: 1042 } });
  const other = await browser.newPage();
  try {
    await fresh.goto(`${BASE}/?token=${TOKEN}#/run/${created.id}`);
    await other.goto(`${BASE}/?token=${TOKEN}#/run/${created.id}`);
    const rail = fresh.getByRole("navigation", { name: "Runs", exact: true });
    const row = rail.locator(".rail-run-row").filter({ has: fresh.locator(".run-item", { hasText: task }) }).first();
    await row.hover();
    await row.getByRole("button", { name: "Run actions", exact: true }).click();
    await row.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await row.waitFor({ state: "detached" });
    const search = rail.getByRole("searchbox");
    await search.fill(task);
    assert.equal(await row.count(), 0, "search respects hidden archives");
    await rail.getByRole("button", { name: "Show archived runs", exact: true }).click();
    await row.waitFor();
    await row.hover();
    await row.getByRole("button", { name: "Run actions", exact: true }).click();
    await row.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
    await fresh.getByRole("main").getByRole("button", { name: "More run actions", exact: true }).waitFor();
    await row.hover();
    await row.getByRole("button", { name: "Run actions", exact: true }).click();
    await row.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    const dialog = fresh.getByRole("dialog", { name: "Delete this run?", exact: true });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await fetch(`${BASE}/api/runs/${created.id}`, { headers: bearer })).status, 200);
    await fresh.getByRole("main").getByRole("button", { name: "More run actions", exact: true }).click();
    await fresh.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    const runUrl = `${BASE}/api/runs/${created.id}`;
    await fresh.route(runUrl, async route => {
      if (route.request().method() === "DELETE") await route.fulfill({ status: 404, json: { error: "Not found" } });
      else await route.continue();
    });
    await dialog.getByRole("button", { name: "Delete run", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "hasn't loaded the delete update" }).waitFor();
    assert.equal(await row.count(), 1, "a missing DELETE route does not hide an existing run");
    await fresh.unroute(runUrl);
    await dialog.getByRole("button", { name: "Delete run", exact: true }).click();
    await row.waitFor({ state: "detached" });
    await other.waitForURL(url => !url.hash.includes(created.id));
    assert.equal((await fetch(`${BASE}/api/runs/${created.id}`, { headers: bearer })).status, 404);
    await fresh.reload();
    assert.equal(await rail.locator(".run-item", { hasText: task }).count(), 0);
  } finally { await fresh.close(); await other.close(); }
});

test("bulk run selection archives and deletes with partial failure recovery", async () => {
  const ids: string[] = [];
  for (const task of ["Bulk history fixture one", "Bulk history fixture two"]) {
    const created = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ repo, task, pattern: "solo", roles: { agent: ["claude"] }, options: {} }) }).then(r => r.json());
    assert.ok(created.id); ids.push(created.id);
  }
  for (const id of ids) for (let i = 0; i < 150; i++) {
    const run = await fetch(`${BASE}/api/runs/${id}`, { headers: bearer }).then(r => r.json());
    if (run.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const fresh = await browser.newPage({ viewport: { width: 1267, height: 1042 } });
  try {
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    const rail = fresh.getByRole("navigation", { name: "Runs", exact: true });
    await rail.getByRole("searchbox").fill("Bulk history fixture");
    await rail.locator(".rail-run-row").filter({ hasText: "Bulk history fixture two" }).waitFor();
    await rail.getByRole("button", { name: "Select runs", exact: true }).click();
    await rail.getByRole("button", { name: "Select loaded", exact: true }).click();
    await rail.getByRole("status").filter({ hasText: /^2 selected$/ }).waitFor();
    await rail.getByRole("button", { name: "Archive", exact: true }).click();
    await rail.getByRole("status").filter({ hasText: /^0 selected$/ }).waitFor();
    assert.equal(await rail.locator(".rail-run-row").count(), 0);
    await rail.getByRole("button", { name: "Show archived runs", exact: true }).click();
    await rail.getByRole("button", { name: "Select loaded", exact: true }).click();
    await rail.getByRole("button", { name: "Delete…", exact: true }).click();
    const dialog = fresh.getByRole("dialog", { name: "Delete 2 runs?", exact: true });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await fetch(`${BASE}/api/runs/${ids[0]}`, { headers: bearer })).status, 200);
    await rail.getByRole("button", { name: "Delete…", exact: true }).click();
    const failedUrl = `${BASE}/api/runs/${ids[1]}`;
    await fresh.route(failedUrl, async route => {
      if (route.request().method() === "DELETE") await route.fulfill({ status: 409, json: { error: "Run is busy" } });
      else await route.continue();
    });
    await dialog.getByRole("button", { name: "Delete 2 runs", exact: true }).click();
    const retry = fresh.getByRole("dialog", { name: "Delete 1 run?", exact: true });
    await retry.getByRole("alert").filter({ hasText: "Run is busy" }).waitFor();
    assert.equal((await fetch(`${BASE}/api/runs/${ids[0]}`, { headers: bearer })).status, 404);
    assert.equal((await fetch(failedUrl, { headers: bearer })).status, 200);
    await rail.getByRole("status").filter({ hasText: /^1 selected$/ }).waitFor();
    await fresh.unroute(failedUrl);
    await retry.getByRole("button", { name: "Delete 1 run", exact: true }).click();
    await retry.waitFor({ state: "detached" });
    assert.equal((await fetch(failedUrl, { headers: bearer })).status, 404);
    await rail.getByRole("status").filter({ hasText: /^0 selected$/ }).waitFor();
  } finally { await fresh.close(); }
});

test("searchable model picker filters names and IDs, supports keyboard, resets and fits mobile", async () => {
  const fresh = await browser.newPage({ viewport: { width: 1039, height: 1042 }, colorScheme: "dark" });
  try {
    await fresh.addInitScript(repository => {
      localStorage.setItem("repo", repository); localStorage.setItem("pattern", "solo"); localStorage.setItem("sideOpen", "0"); localStorage.setItem("theme", "dark");
      localStorage.setItem("roleSel", JSON.stringify({ solo: { agent: ["claude"] } }));
    }, repo);
    await fresh.route("**/api/models", async route => {
      const response = await route.fetch(); const catalogs = await response.json();
      catalogs.claude.models = [
        { id: "vendor/special-free", label: "Special (free)" },
        ...Array.from({ length: 80 }, (_, i) => ({ id: `vendor/model-${i}`, label: `Model ${i}` })),
      ];
      await route.fulfill({ response, json: catalogs });
    });
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    const trigger = fresh.locator(".taskbox").getByRole("button", { name: "Model", exact: true });
    await trigger.click();
    const search = fresh.getByRole("combobox", { name: "Search Model", exact: true });
    const options = fresh.getByRole("listbox", { name: "Model", exact: true }).getByRole("option");
    const freeOnly = fresh.getByRole("button", { name: "Free only", exact: true });
    await options.locator(".model-free-badge").first().waitFor();
    assert.equal(await options.locator(".model-free-badge").count(), 1, "free badge appears with the filter off; paid and default options have none");
    await search.press("Shift+Tab");
    assert.equal(await freeOnly.evaluate(element => element === document.activeElement), true, "free filter is keyboard reachable");
    await freeOnly.press("Space");
    assert.equal(await freeOnly.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await options.locator(".model-option-name").allTextContents(), ["Special (free)"]);
    assert.match(await trigger.textContent() ?? "", /Default model/, "filtering does not change the selected model");
    await search.fill("model-79");
    assert.equal(await options.count(), 0);
    await fresh.getByRole("status").filter({ hasText: "No free models found" }).waitFor();
    await search.fill("special");
    await search.press("Escape");
    await trigger.click();
    assert.equal(await freeOnly.getAttribute("aria-pressed"), "true", "picker remembers the filter when reopened");
    await freeOnly.click();
    assert.ok(await options.count() > 80, "disabling the filter restores all models and default");
    await search.fill("VENDOR special");
    assert.equal(await options.count(), 1);
    assert.match(await options.first().textContent() ?? "", /Special/);
    await search.fill("no-such-model");
    await fresh.getByRole("status").filter({ hasText: "No models found" }).waitFor();
    await search.press("Enter");
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    await search.fill("model-79");
    await search.press("Enter");
    assert.match(await trigger.textContent() ?? "", /Model 79/);
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await trigger.click();
    assert.equal(await search.inputValue(), "");
    await search.fill("model-7");
    await search.press("ArrowDown");
    await search.press("Enter");
    assert.match(await trigger.textContent() ?? "", /Model 70/);
    await trigger.click();
    await search.fill("special");
    await search.press("Escape");
    assert.match(await trigger.textContent() ?? "", /Model 70/);
    await fresh.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await fresh.setViewportSize({ width: 390, height: 844 });
    await trigger.click();
    await freeOnly.click();
    await search.fill("special");
    const bounds = await fresh.locator(".model-select-popup").boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844);
    await fresh.screenshot({ path: join(root, "output/free-model-filter-mobile.png"), animations: "disabled" });
    await fresh.getByRole("textbox", { name: "Task", exact: true }).click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  } finally { await fresh.close(); }
});

test("free model ordering, multiple provider models and dark team selectors", async () => {
  const fresh = await browser.newPage({ viewport: { width: 1039, height: 1042 }, colorScheme: "dark" });
  try {
    await fresh.addInitScript((repository) => {
      localStorage.setItem("repo", repository); localStorage.setItem("pattern", "council"); localStorage.setItem("sideOpen", "0"); localStorage.setItem("theme", "dark");
      localStorage.setItem("roleSel", JSON.stringify({ council: { reviewers: ["claude"], chair: ["codex"] } }));
    }, repo);
    await fresh.route("**/api/models", async route => {
      const response = await route.fetch(); const catalogs = await response.json();
      catalogs.claude.models = [{ id: "paid", label: "Paid model" }, { id: "first-free", label: "First (free)" }, { id: "second-free", label: "Second (free)" }];
      await route.fulfill({ response, json: catalogs });
    });
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    await fresh.locator(".composer-options > summary").click();
    await fresh.locator(".advanced-controls > summary").click();
    const role = fresh.locator(".role").filter({ has: fresh.locator(".rl", { hasText: /^Reviewers/ }) });
    const model = role.getByLabel("Claude Code model for the reviewers", { exact: true });
    await model.click();
    assert.deepEqual(await fresh.getByRole("listbox").locator(".model-option-name").allTextContents(), ["Default model", "First (free)", "Second (free)", "Paid model"]);
    await fresh.getByRole("combobox", { name: /^Search / }).press("Escape");
    await role.getByRole("button", { name: "Select all free", exact: true }).click();
    assert.equal((await model.textContent())?.trim(), "First (free)");
    assert.equal((await role.getByLabel("Claude Code additional model 1 for the reviewers", { exact: true }).textContent())?.trim(), "Second (free)");
    await role.getByText("2 agents · each model runs separately", { exact: true }).waitFor();
    const colors = await model.evaluate(element => { const css = getComputedStyle(element); return [css.color, css.backgroundColor]; });
    assert.notEqual(colors[0], colors[1]); assert.notEqual(colors[1], "rgba(0, 0, 0, 0)");
    const modelBox = await model.boundingBox();
    const effortBox = await role.getByLabel("Claude Code effort for the reviewers", { exact: true }).boundingBox();
    assert.ok(modelBox && effortBox && Math.abs(modelBox.y - effortBox.y) < 2, "desktop model and effort controls share a row");
    await fresh.screenshot({ path: join(root, "output/team-free-models-dark.png") });
    await fresh.getByRole("button", { name: "Use the light theme", exact: true }).click();
    await fresh.screenshot({ path: join(root, "output/team-models-light.png") });
    await fresh.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await fresh.setViewportSize({ width: 390, height: 844 });
    await role.scrollIntoViewIfNeeded();
    await fresh.screenshot({ path: join(root, "output/team-models-mobile.png"), animations: "disabled" });
    assert.ok(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await role.getByRole("button", { name: "Remove Claude Code model second-free", exact: true }).click();
    await role.getByLabel("Add Claude Code model for the reviewers", { exact: true }).click();
    await fresh.getByRole("combobox", { name: /^Search / }).fill("PAID");
    await fresh.getByRole("option", { name: "Paid model", exact: true }).click();
    assert.equal((await role.getByLabel("Claude Code additional model 1 for the reviewers", { exact: true }).textContent())?.trim(), "Paid model");
    const saved = await fresh.evaluate(() => JSON.parse(localStorage.getItem("roleModels")!).council.reviewers.claude);
    assert.deepEqual(saved.variants, [{ model: "paid" }]);
  } finally { await fresh.close(); }
});

test("Auto team selects all free models into a persistent bounded model pool", async () => {
  const fresh = await browser.newPage({ viewport: { width: 1039, height: 1042 }, colorScheme: "dark" });
  try {
    await fresh.addInitScript((repository) => {
      localStorage.setItem("repo", repository); localStorage.setItem("pattern", "auto-team"); localStorage.setItem("sideOpen", "0"); localStorage.setItem("theme", "dark");
      localStorage.setItem("roleSel", JSON.stringify({ "auto-team": { pool: ["claude"], coordinator: ["codex"] } }));
    }, repo);
    await fresh.route("**/api/models", async route => {
      const response = await route.fetch(); const catalogs = await response.json();
      catalogs.claude.models = [{ id: "paid", label: "Paid model" }, { id: "first-free", label: "First (free)" }, { id: "second-free", label: "Second (free)" }];
      await route.fulfill({ response, json: catalogs });
    });
    await fresh.goto(`${BASE}/?token=${TOKEN}`);
    await fresh.locator(".composer-options > summary").click();
    await fresh.locator(".advanced-controls > summary").click();
    const role = fresh.locator(".role").filter({ has: fresh.locator(".rl", { hasText: /^Available providers/ }) });
    const model = role.getByLabel("Claude Code model for the available providers", { exact: true });
    await model.click();
    assert.deepEqual(await fresh.getByRole("listbox").locator(".model-option-name").allTextContents(), ["Default model", "First (free)", "Second (free)", "Paid model"]);
    await fresh.getByRole("combobox", { name: /^Search / }).press("Escape");
    await role.getByRole("button", { name: "Select all free", exact: true }).click();
    assert.equal((await model.textContent())?.trim(), "First (free)");
    assert.equal((await role.getByLabel("Claude Code additional model 1 for the available providers", { exact: true }).textContent())?.trim(), "Second (free)");
    await role.getByText("2 model choices · coordinator selects within the member limit", { exact: true }).waitFor();
    assert.equal(await fresh.locator(".role").filter({ has: fresh.locator(".rl", { hasText: /^Coordinator/ }) }).getByRole("button", { name: "Codex", exact: true }).getAttribute("aria-pressed"), "true", "pool choices preserve the coordinator");
    const colors = await model.evaluate(element => { const css = getComputedStyle(element); return [css.color, css.backgroundColor]; });
    assert.notEqual(colors[0], colors[1]); assert.notEqual(colors[1], "rgba(0, 0, 0, 0)");
    await fresh.screenshot({ path: join(root, "output/auto-team-model-pool-test.png") });
    await fresh.setViewportSize({ width: 390, height: 844 });
    assert.ok(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await role.getByRole("button", { name: "Remove Claude Code model second-free", exact: true }).click();
    await role.getByLabel("Add Claude Code model for the available providers", { exact: true }).click();
    await fresh.getByRole("combobox", { name: /^Search / }).fill("PAID");
    await fresh.getByRole("option", { name: "Paid model", exact: true }).click();
    assert.equal((await role.getByLabel("Claude Code additional model 1 for the available providers", { exact: true }).textContent())?.trim(), "Paid model");
    const saved = await fresh.evaluate(() => JSON.parse(localStorage.getItem("roleModels")!)["auto-team"].pool.claude);
    assert.deepEqual(saved.variants, [{ model: "paid" }]);
  } finally { await fresh.close(); }
});
