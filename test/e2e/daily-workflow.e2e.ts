import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer daily-workflow-e2e", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string, ghState: string;
const errors: string[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
async function api<T = Run>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const finished = (id: string) => until(() => api(`/api/runs/${id}`), run => run.status !== "running");

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-daily-e2e-")));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test subject.test.mjs" } }));
  await writeFile(join(repo, "subject.txt"), "Original subject\n");
  await writeFile(join(repo, "subject.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('baseline', () => assert.equal(1 + 1, 2));\n");
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  const origin = join(directory, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git("remote", "add", "origin", origin); git("push", "-q", "origin", "main");
  ghState = join(directory, "github.json");
  await writeFile(ghState, JSON.stringify({ issues: [], prs: {} }));
  const history = join(directory, "home", "runs");
  await mkdir(history, { recursive: true });
  for (const [id, loop] of [
    ["retry-remote", { remoteWorker: { workerId: "missing-worker", repoMapping: "original-repository" } }],
    ["retry-container", { agentContainer: { image: "prepared-agent:v1", authVolume: "original-login", network: false, memoryMb: 512, cpus: 2 } }],
    ["retry-untrusted", {}],
  ] as const) {
    const timestamp = Date.now() - 1000;
    const run = { id, repo, pattern: "solo", task: `Restore ${id}`, baseRef: git("rev-parse", "HEAD"), baseLabel: "main", branchPrefix: `codeflow/${id}`, worktreeDir: join(directory, id), roles: { agent: ["claude"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "safe", loop: { ...loop, check: "", setup: "", maxSteps: 4, maxMinutes: 1, checkTimeoutMin: 1 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: timestamp, endedAt: timestamp + 100, seen: true, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [] };
    const source = id === "retry-untrusted" ? {
      lockdown: "Imported issue is untrusted external context", lockdownOnHost: true,
      externalSource: { id: "original-import", integration: "fixture", provider: "linear", kind: "issue", key: "CF-1", title: "Imported issue", body: "Keep the imported request attributable.", importedAt: timestamp, expiresAt: timestamp + 3600000, trusted: false, untrusted: true },
    } : {};
    await writeFile(join(history, `${id}.jsonl`), JSON.stringify({ seq: 1, ts: timestamp, runId: id, type: "run", run: { ...run, ...source } }) + "\n");
  }
  const port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "daily-workflow-e2e", FAKE_GH_STATE: ghState, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` },
    stdio: "pipe",
  });
  let output = "";
  server.stdout?.on("data", chunk => { output += chunk; }); server.stderr?.on("data", chunk => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then(response => response.ok, () => false)) break;
    if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(path => {
    localStorage.setItem("repo", path);
    localStorage.setItem("pattern", "solo");
    localStorage.setItem("sideOpen", "0");
  }, repo);
  await page.goto(base + "/?token=daily-workflow-e2e");
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

let result: Run;
test("repository readiness is reachable before launch and validates the selected setup and check", { timeout: 45_000 }, async () => {
  await page.locator(".composer-summary").getByText("Checks", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit run options", exact: true }).click();
  await page.getByLabel("Worktree setup command", { exact: true }).fill('node -e "process.exit(0)"');
  await page.locator(".readiness > summary").click();
  const readiness = page.locator(".readiness");
  await readiness.getByRole("button", { name: "Inspect readiness", exact: true }).click();
  await readiness.getByText("Repository and base", { exact: true }).waitFor();
  await readiness.getByRole("button", { name: "Validate commands", exact: true }).click();
  await readiness.getByText(/Commands validated/).waitFor();
  const check = readiness.locator("li", { hasText: "Check execution" });
  assert.match(await check.innerText(), /Passed/);
  assert.match(await readiness.locator("li", { hasText: "Setup execution" }).innerText(), /Passed/);
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await readiness.screenshot({ path: join(root, "output/playwright/daily-readiness.png") });
  await page.getByRole("button", { name: "Edit run options", exact: true }).click();
});

test("a successful launch opens its run while the history refresh is stalled", { timeout: 45_000 }, async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let heldRequests = 0;
  const intercept = async (route: import("playwright-core").Route) => {
    if (route.request().method() === "GET") { heldRequests++; await held; }
    await route.continue();
  };
  await page.route("**/api/runs?*", intercept);
  try {
    await page.locator(".taskbox textarea").fill("Improve the subject for the daily workflow");
    const started = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Start run", exact: true }).click();
    const response = await started;
    assert.equal(response.status(), 201);
    const { id } = await response.json();
    await page.waitForURL(url => url.hash === `#/run/${id}`, { timeout: 10000 });
    await until(async () => heldRequests, value => value > 0);
    result = await finished(id);
    assert.equal(result.status, "done", result.error);
    assert.equal(result.loop.setup, 'node -e "process.exit(0)"');
    assert.equal((await api<Run[]>("/api/runs")).filter(run => run.task === result.task).length, 1);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("needs-work feedback opens branch review, survives a rejected send, and leads to a checked revision and PR", { timeout: 60_000 }, async () => {
  const studio = page.getByRole("region", { name: "Try and assess the result" });
  await studio.getByRole("button", { name: "Needs more work", exact: true }).click();
  const branch = result.artifacts[0]!.branch;
  await page.waitForURL(url => url.hash === `#/review/${result.id}/${branch}`);
  await page.locator(".review-diff .diff-file-head").waitFor();
  const message = "Please improve the explanation and handle the empty case.";
  await page.getByLabel("Overall comment", { exact: true }).fill(message);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const sendBounds = await page.getByRole("button", { name: "Send comments", exact: true }).boundingBox();
    assert.ok(sendBounds && sendBounds.x >= 0 && sendBounds.x + sendBounds.width <= width + 1, `Revision action must fit at ${width}px: ${JSON.stringify(sendBounds)}`);
    await page.screenshot({ path: join(root, `output/playwright/daily-revision-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const rejectOnce = async (route: import("playwright-core").Route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary provider outage" }) });
  await page.route(`**/api/runs/${result.id}/followups`, rejectOnce, { times: 1 });
  await page.getByRole("button", { name: "Send comments", exact: true }).click();
  await page.getByText("Temporary provider outage", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Overall comment", { exact: true }).inputValue(), message);
  await page.reload();
  assert.equal(await page.getByLabel("Overall comment", { exact: true }).inputValue(), message);
  await page.getByRole("button", { name: "Send comments", exact: true }).click();
  await page.waitForURL(url => url.hash === `#/run/${result.id}`);
  result = await finished(result.id);
  assert.equal(result.followUps.length, 1);
  assert.equal(result.followUps[0]!.status, "done", result.followUps[0]!.result);
  assert.match(result.followUps[0]!.message, /handle the empty case/);
  assert.equal(result.verdict, "passed");
  await page.getByRole("region", { name: "Try and assess the result" }).getByRole("button", { name: "Inspect changes", exact: true }).click();
  assert.equal(await page.getByLabel("Overall comment", { exact: true }).inputValue(), "");
  await page.getByText("Publish changes", { exact: true }).click();
  await page.getByRole("button", { name: "Open PR…", exact: true }).click();
  await page.getByRole("button", { name: "Push & open PR", exact: true }).click();
  const published = await until(() => api(`/api/runs/${result.id}`), run => !!run.prs[branch]);
  const github = JSON.parse(await readFile(ghState, "utf8"));
  assert.equal(Object.keys(github.prs).length, 1);
  assert.equal(github.prs[1].baseRefName, "main");
  assert.equal(github.prs[1].headRefName, branch);
  assert.equal(published.prs[branch], github.prs[1].url);
  assert.equal(git("rev-parse", `refs/remotes/origin/${branch}`), git("rev-parse", `refs/heads/${branch}`));
});

test("edit and run again preserves pinned inputs, provider settings, permissions, limits and custom verification", { timeout: 60_000 }, async () => {
  const original = await api("/api/runs", {
    repo, pattern: "solo", intent: "bug", task: "Repeat an explicitly configured task", roles: { agent: ["claude"] },
    trust: "safe", approvals: { plan: false, tools: false },
    agentSettings: { claude: { model: "sonnet", effort: "high" } }, roleSettings: { agent: { claude: { model: "haiku", effort: "low" } } },
    context: { paths: [{ path: "subject.txt" }] },
    loop: {
      check: "node --test subject.test.mjs", setup: "node -e \"process.exit(0)\"", maxSteps: 7, maxInvocations: 6, maxMinutes: 2,
      maxTokens: 25000, maxCostUsd: 5, checkTimeoutMin: 1, contextBudget: { maxPromptBytes: 100000, policy: "warn" },
      verification: { name: "Daily custom checks", checks: [{ id: "unit", kind: "unit", command: "node --test subject.test.mjs", required: true, timeoutMs: 10000 }] },
    },
  });
  const saved = await finished(original.id);
  assert.equal(saved.status, "done", saved.error);
  git("checkout", "-qb", "different-base");
  await writeFile(join(repo, "different.txt"), "This commit must not become the retry base.\n");
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "different base");
  await page.goto(base + `/#/run/${original.id}`);
  await page.getByRole("button", { name: "More run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).click();
  await page.waitForURL(url => url.hash === "#/");
  await page.locator(".composer-summary").getByText(saved.baseRef, { exact: false }).waitFor();
  await page.getByRole("button", { name: "Edit run options", exact: true }).click();
  await page.locator(".advanced-controls > summary").click();
  assert.equal(await page.getByLabel("Verification gates", { exact: true }).inputValue(), "restored");
  const started = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  const response = await started;
  assert.equal(response.status(), 201, await response.text());
  const retried = await finished((await response.json()).id);
  assert.equal(retried.status, "done", retried.error);
  for (const field of ["baseRef", "task", "intent", "trust", "roles", "roleSettings", "approvals"] as const) assert.deepEqual(retried[field], saved[field], field);
  // The solo composer sends its effective model, including the per-role override.
  assert.deepEqual(retried.agentSettings.claude, { ...saved.agentSettings.claude, ...saved.roleSettings.agent?.claude });
  for (const field of ["check", "setup", "maxSteps", "maxInvocations", "maxMinutes", "maxTokens", "maxCostUsd", "checkTimeoutMin", "contextBudget", "verification"] as const) assert.deepEqual(retried.loop[field], saved.loop[field], field);
  assert.deepEqual(retried.context.paths, saved.context.paths);
  assert.equal(retried.parentRunId, saved.id);
  assert.notEqual(retried.branchPrefix, saved.branchPrefix);
  assert.deepEqual(errors, []);
});

test("retry retains container isolation and never falls back from an unavailable remote worker", { timeout: 45_000 }, async () => {
  const edit = async (id: string) => {
    await page.goto(base + `/#/run/${id}`);
    await page.getByRole("button", { name: "More run actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).click();
    await page.waitForURL(url => url.hash === "#/");
    await page.getByRole("button", { name: "Edit run options", exact: true }).click();
  };
  await edit("retry-container");
  await page.locator(".agent-isolation > summary").click();
  assert.equal(await page.getByLabel("Run agents in a prebuilt Docker image").isChecked(), true);
  assert.equal(await page.getByLabel("Image", { exact: true }).inputValue(), "prepared-agent:v1");
  assert.equal(await page.getByLabel("Authentication volume", { exact: true }).inputValue(), "original-login");
  let request: any;
  await page.route("**/api/runs", async route => {
    if (route.request().method() !== "POST") return route.continue();
    request = route.request().postDataJSON();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Container launch inspected without executing" }) });
  }, { times: 1 });
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await page.getByText("Container launch inspected without executing", { exact: true }).waitFor();
  assert.deepEqual(request.loop.agentContainer, { image: "prepared-agent:v1", authVolume: "original-login", network: false, memoryMb: 512, cpus: 2 });
  assert.equal(request.parentRunId, "retry-container");
  await edit("retry-remote");
  if (!await page.getByLabel("Agent execution", { exact: true }).isVisible()) await page.locator(".advanced-controls > summary").click();
  assert.equal(await page.getByLabel("Agent execution", { exact: true }).inputValue(), "missing-worker");
  await until(() => page.getByRole("button", { name: "Start run", exact: true }).isDisabled(), value => value);
  assert.match(await page.locator(".composer-summary").innerText(), /worker/i);
  assert.deepEqual(errors, []);
});

test("retry preserves imported context and its source restrictions through the original run", { timeout: 45_000 }, async () => {
  await page.goto(base + "/#/run/retry-untrusted");
  await page.getByRole("button", { name: "More run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).click();
  await page.waitForURL(url => url.hash === "#/");
  const started = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  const response = await started;
  assert.equal(response.status(), 201, await response.text());
  const retried = await finished((await response.json()).id);
  assert.equal(retried.status, "done", retried.error);
  assert.equal(retried.parentRunId, "retry-untrusted");
  assert.equal(retried.externalSource?.id, "original-import");
  assert.equal(retried.externalSource?.trusted, false);
  assert.match(retried.lockdown ?? "", /Continued from locked-down run retry-untrusted/);
  assert.equal(retried.trust, "safe");
  assert.equal(retried.loop.copy, undefined);
  assert.deepEqual(errors, []);
});

test("review waits for the actual writer before enabling an automatic revision recipient", { timeout: 45_000 }, async () => {
  const started = await api("/api/runs", { repo, pattern: "solo", task: "Review a Codex result", roles: { agent: ["codex"] }, loop: { check: "true", maxMinutes: 1, maxSteps: 4 } });
  const saved = await finished(started.id);
  assert.equal(saved.status, "done", saved.error);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/runs/${saved.id}`, async route => { await held; await route.continue(); });
  try {
    await page.goto(base + `/#/review/${saved.id}/${saved.artifacts[0]!.branch}`);
    await page.getByLabel("Overall comment", { exact: true }).fill("Revise the original writer's result.");
    await page.getByText("Loading recipient…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send comments", exact: true }).isDisabled(), true);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  const send = page.getByRole("button", { name: "Send comments", exact: true });
  await until(() => send.isEnabled(), value => value);
  await send.click();
  await page.waitForURL(url => url.hash === `#/run/${saved.id}`);
  const revised = await finished(saved.id);
  assert.equal(revised.followUps[0]!.agent, "codex");
  assert.equal(revised.followUps[0]!.status, "done", revised.followUps[0]!.result);
  assert.deepEqual(errors, []);
});

test("deleting the original run while editing a retry cannot discard imported-source restrictions", { timeout: 45_000 }, async () => {
  await page.goto(base + "/#/run/retry-untrusted");
  await page.getByRole("button", { name: "More run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).click();
  await page.waitForURL(url => url.hash === "#/");
  const removed = await fetch(base + "/api/runs/retry-untrusted", { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  const started = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  assert.equal((await started).status(), 409);
  await page.getByText(/The original run is no longer available/).waitFor();
  assert.equal(await page.locator(".taskbox textarea").inputValue(), "Restore retry-untrusted");
  assert.equal(new URL(page.url()).hash, "#/");
  assert.deepEqual(errors, []);
});

test("readiness follows provider assignments and discards an older in-flight report", { timeout: 45_000 }, async () => {
  const isolated = await browser.newContext();
  await isolated.addInitScript(repository => {
    localStorage.setItem("repo", repository);
    localStorage.setItem("pattern", "pipeline");
    localStorage.setItem("roleSel", JSON.stringify({ pipeline: { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] } }));
  }, repo);
  const draft = await isolated.newPage();
  let release!: () => void;
  try {
    await draft.goto(base + "/?token=daily-workflow-e2e");
    await draft.getByRole("button", { name: "Edit run options", exact: true }).click();
    await draft.locator(".readiness > summary").click();
    const readiness = draft.locator(".readiness");
    const inspect = readiness.getByRole("button", { name: "Inspect readiness", exact: true });
    const response = draft.waitForResponse(response => new URL(response.url()).pathname === "/api/readiness");
    await inspect.click();
    const checked = await response;
    assert.equal(checked.request().postDataJSON().pattern, "pipeline");
    assert.deepEqual(checked.request().postDataJSON().roles.planner, ["claude"]);
    await readiness.getByText("Repository and base", { exact: true }).waitFor();
    await draft.locator(".advanced-controls > summary").click();
    const planner = draft.getByRole("group", { name: "Planner providers", exact: true });
    await planner.getByRole("button", { name: "Codex", exact: true }).click();
    await until(() => readiness.locator(".readiness-results").count(), count => count === 0);
    let held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await draft.route("**/api/readiness", async route => {
      const response = await route.fetch(); held = true; await gate; await route.fulfill({ response });
    }, { times: 1 });
    await inspect.click();
    await until(async () => held, value => value);
    await planner.getByRole("button", { name: "Antigravity CLI", exact: true }).click();
    release();
    await draft.unrouteAll({ behavior: "wait" });
    assert.equal(await readiness.locator(".readiness-results").count(), 0);
    await inspect.click();
    await readiness.getByText("Repository and base", { exact: true }).waitFor();
    assert.match(await readiness.locator("li", { hasText: "Claude Code" }).innerText(), /Skipped/);
  } finally { release?.(); await isolated.close(); }
});
