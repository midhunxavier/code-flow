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
      CODEFLOW_REMOTE_PORT: String(REMOTE_PORT),
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
  await page.getByText("Open a folder marked GIT, or type a path").waitFor();
  await path.press("Enter");
  await page.getByText("✓ This folder is a git repository").waitFor();
  await page.unroute(/\/api\/fs\b/);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.locator(".repo-btn .name", { hasText: repo.split("/").pop()! }).waitFor();
  // Detection takes two more requests once the repo shows: wait for it instead of racing it.
  await page.waitForFunction(() => (document.querySelector("#checkCmd") as HTMLInputElement | null)?.value, undefined, { timeout: 5_000 }).catch(() => undefined);
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

  // Back on the run: the comment is in the thread, Claude's follow-up ran, and the check passes now.
  await page.getByText("✓ Finished — the check passes").waitFor({ timeout: 30_000 });
  await page.locator(".fu .msg-you", { hasText: "Implement it properly so npm test passes" }).waitFor();
  await page.locator(".fu-head", { hasText: "check passes" }).waitFor();

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
  await page.locator(".convo textarea").fill("Prefer tabs over spaces");
  await page.locator(".convo textarea").press("Enter");
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
  const { run: id } = await fired.json();

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
  const item = page.locator(".inbox-item", { hasText: "Fix issue #41: E2E sweep: fix the greeting" });
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

  await api("/api/remote", { control: true });
  const signIn = await fetch(`${PHONE}${remote.path}`, { redirect: "manual" });
  assert.equal(signIn.status, 302);
  assert.equal(signIn.headers.get("location"), "/");
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
  await tab.goto(`${PHONE}${remote.path}`);
  await tab.getByRole("heading", { name: "What should the team build?" }).waitFor();
  assert.equal(new URL(tab.url()).pathname, "/");
  await tab.getByRole("button", { name: "Show runs" }).click();
  await tab.locator(".rail.open").waitFor();

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

test("supervisor: the reviewer defaults to a different vendor than the supervisor", async () => {
  await page.goto(BASE);
  await page.getByRole("button", { name: /Supervisor → Workers/ }).click();
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

test("projects: the first run made one; a new project scopes the sidebar and new runs; a run moves back", async () => {
  const projects = () => fetch(`${BASE}/api/projects`, { headers: bearer }).then((r) => r.json() as Promise<{ id: string; name: string; repos: string[] }[]>);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim();
  const [own, ...others] = await projects();
  assert.deepEqual([own!.name, own!.repos, others.length], [root.split("/").pop(), [root], 0], "one project, named after the repo and holding it");

  await page.goto(BASE);
  await page.locator(".project-btn", { hasText: "All projects" }).waitFor();
  await page.keyboard.press("p");
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator("#project-name").fill("E2E side");
  assert.equal(await page.locator(".project-repos .dir").count(), 1, "starts with the repo you're in");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.locator(".project-btn", { hasText: "E2E side" }).waitFor();
  await page.locator(".rail-empty", { hasText: "No runs in E2E side yet" }).waitFor();

  await page.getByRole("button", { name: /Plan → Build → Review/ }).click();
  await page.getByLabel("Task", { exact: true }).fill("E2E: in the side project");
  await page.getByRole("button", { name: /^Start run/ }).click();
  await page.getByText(/✓ Finished|⚠ Finished/).first().waitFor({ timeout: 30_000 });
  await page.locator(".project-chip", { hasText: "E2E side" }).waitFor();
  assert.deepEqual(await page.locator(".rail .run-item .t").allInnerTexts(), ["E2E: in the side project"], "the sidebar shows this project's runs");

  // Move it back to the repo's own project.
  await page.locator(".project-chip").click();
  await page.locator(".move-choice").filter({ has: page.locator(".dn", { hasText: new RegExp(`^${own!.name}`) }) }).locator("input").check();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.locator(".project-chip", { hasText: own!.name }).waitFor();
  await page.locator(".rail-empty", { hasText: "No runs in E2E side yet" }).waitFor();
  const runId = decodeURIComponent(page.url().split("#/run/")[1]!);
  const run = await fetch(`${BASE}/api/runs/${runId}`, { headers: bearer }).then((r) => r.json());
  assert.equal(run.project, own!.id);

  await page.keyboard.press("p");
  await page.locator(".project-row", { hasText: "All projects" }).locator(".pr-main").click();
  assert.ok((await page.locator(".rail .run-item").count()) > 1, "every project's runs again");
});
