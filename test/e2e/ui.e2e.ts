// End-to-end: the real UI in Chrome against a real server with fake agents.
// Run with `npm run test:e2e` (needs Google Chrome installed; no browser download).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
      CODEFLOW_LAN_ALLOW_LOCAL: "1",
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
  await page.getByRole("button", { name: /^Plan → Build → Review/ }).click();
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
  await page.getByRole("button", { name: /^Plan → Build → Review/ }).click();
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
  await page.getByRole("button", { name: /^Plan → Build → Review/ }).click();
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

  await page.goto(`${BASE}/#/automations`);
  const item = page.locator(".inbox-item", { hasText: "E2E: automated chore" });
  await item.waitFor({ timeout: 30_000 });
  assert.match(await page.locator(".auto-nav .count").innerText(), /^\d+$/, "the inbox count shows in the sidebar");
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

  await page.goto(`${BASE}/#/automations`);
  const item = page.locator(".inbox-item", { hasText: "E2E: check can't run" });
  await item.waitFor({ timeout: 30_000 });
  await item.locator(".cant-run", { hasText: "nosuchtool-e2e" }).waitFor();
  assert.match(await item.locator(".ih .help").innerText(), /check couldn't run/);

  await item.locator("a.t").click();
  await page.getByText("⚠ Finished — but the check couldn't run, so nothing was tested").waitFor();
  await page.locator(".result .cant-run", { hasText: ".codeflow/config.json" }).waitFor();
  assert.equal(await page.locator(".run-head .status-pill").textContent(), "Done · check can't run");

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
  await page.getByRole("button", { name: /Fix open issues/ }).click();
  const dialog = page.locator("dialog.sweep-dialog");
  await dialog.locator(".sweep-item", { hasText: "fix the greeting" }).waitFor();
  assert.equal(await dialog.getByRole("checkbox", { name: /how do I run it/ }).isChecked(), false, "a question starts unpicked");
  await dialog.getByRole("checkbox", { name: /tidy the readme/ }).uncheck();
  await dialog.getByRole("button", { name: "Start 1 run" }).click();

  await page.waitForURL(/#\/automations/);
  const item = page.locator(".inbox-item", { hasText: "E2E sweep: fix the greeting" });
  await item.waitFor({ timeout: 30_000 });
  await item.getByRole("button", { name: "✓ Approve" }).click();
  await item.waitFor({ state: "detached" });

  // The next sweep knows #41 has a run.
  await page.goto(BASE);
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
  await page.goto(`${BASE}/#/insights`);
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
  await page.getByRole("button", { name: /^Supervisor → Workers/ }).click();
  const role = (label: string) => page.locator(".role").filter({ has: page.locator(".rl", { hasText: new RegExp(`^${label}`) }) });
  const pressed = async (label: string) =>
    (await role(label).locator(".pill[aria-pressed=true]").allInnerTexts()).map((t) => t.trim());
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

  await page.getByRole("button", { name: /^Plan → Build → Review/ }).click();
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
  await side.locator(".to select").first().selectOption("claude");
  await side.getByLabel("Message").fill("E2E: what does check.mjs do?");
  await side.getByLabel("Message").press("Enter");
  await side.getByText("Implemented changes as claude.").waitFor({ timeout: 30_000 });
  assert.match(await side.locator(".chat-meta code").innerText(), /\/solo$/, "the chat works on its own branch");
  assert.equal(await page.locator(".rail .run-item", { hasText: "E2E: what does check.mjs do?" }).count(), 1, "a chat is a run like any other");

  // Files: a file opens in the viewer.
  await side.getByRole("tab", { name: "Files" }).click();
  await side.locator(".node", { hasText: "package.json" }).click();
  await side.locator(".file-view").getByText(/"name":"e2e"/).waitFor();
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
  await side.getByRole("button", { name: "Change", exact: true }).click();
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
  await page.goto(`${BASE}/#/insights`);
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

  await page.goto(`${BASE}/#/automations`);
  await page.locator(".project-btn").click(); // start from every project, whichever one earlier tests left selected
  await page.locator(".project-row", { hasText: "All projects" }).locator(".pr-main").click();
  await page.locator(".inbox-item", { hasText: "E2E: side chore" }).waitFor({ timeout: 30_000 });
  const pending = (await api("/api/runs")).filter((r: { triage?: { state: string }; archived?: boolean }) => r.triage?.state === "pending" && !r.archived).length;
  const total = (await api("/api/automations")).length;
  assert.ok(pending > 1 && total > 1, "earlier tests left results and automations in the repo's own project");

  await page.locator(".project-btn").click();
  await page.locator(".project-row", { hasText: "E2E scoped" }).locator(".pr-main").click();
  await page.locator(".project-btn", { hasText: "E2E scoped" }).waitFor();
  assert.deepEqual(await page.locator(".inbox-item a.t").allInnerTexts(), ["E2E: side chore"], "only this project's results");
  assert.deepEqual(await page.locator(".auto-row b").allInnerTexts(), ["E2E side hook"], "only this project's automations");
  await page.locator(".automations .rail-hint", { hasText: `${pending - 1} in other projects need${pending === 2 ? "s" : ""} you` }).waitFor();
  await page.locator(".automations .rail-hint", { hasText: `${total - 1} more in other projects` }).waitFor();
  assert.equal(await page.locator(".auto-nav .count").innerText(), String(pending), "the sidebar still counts every project's results");

  // The read-only phone view lists each project's runs under its name.
  const remote = await api("/api/remote", { enabled: true });
  const sections = (await (await fetch(`${BASE}${remote.path}`)).text()).split("<section>").slice(1);
  const under = (name: string) => sections.find((s) => s.startsWith(`<h2 class="project">${name}</h2>`)) ?? "";
  assert.match(under("E2E scoped"), /E2E: side chore/);
  assert.doesNotMatch(under(own.name), /E2E: side chore/);
  assert.match(under(own.name), /E2E: check can&#39;t run/);
  await api("/api/remote", { enabled: false });

  // "Show all" goes back to every project, as the sidebar's does.
  await page.locator(".automations .rail-hint", { hasText: "more in other projects" }).getByRole("button", { name: "Show all" }).click();
  await page.locator(".project-btn", { hasText: "All projects" }).waitFor();
  assert.equal(await page.locator(".auto-row").count(), total);
  assert.equal(await page.locator(".inbox-item").count(), pending);
});
