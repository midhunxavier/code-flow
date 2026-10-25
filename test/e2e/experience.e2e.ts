import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer experience-e2e", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string;
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-experience-e2e-")));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test subject.test.mjs" } }));
  await writeFile(join(repo, "subject.txt"), "original subject\n");
  await writeFile(join(repo, "subject.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('fixture', () => assert.equal(1 + 1, 2));\n");
  await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ run: { command: "node app.cjs" } }));
  const fixtureHtml = "<html lang=\"en\"><head><title>Greeting fixture</title></head><body><style>label{position:absolute;top:20px;left:20px}label+label{top:70px}button{position:absolute;top:120px;left:20px}#result{position:absolute;top:170px;left:20px}</style><main><label>Name<input id=\"name\"></label><label>Password<input id=\"password\" type=\"password\"></label><button id=\"go\" onclick=\"document.querySelector('#result').innerText='Hello ' + document.querySelector('#name').value\">Greet</button><div id=\"result\">Waiting</div></main></body></html>";
  await writeFile(join(repo, "app.cjs"), `require('http').createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(${JSON.stringify(fixtureHtml)})).listen(Number(process.env.PORT), '127.0.0.1');`);
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "experience-e2e", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base + "/?token=experience-e2e");
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); localStorage.setItem("sideTab", "changes"); }, repo);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

let result: any, journey: any;
const errors: string[] = [];
afterEach(async context => { if ((context as unknown as { error?: unknown }).error && page) { console.error("Browser errors", errors); console.error((await page.locator("body").innerText()).slice(0, 7000)); await mkdir(join(root, "output/playwright"), { recursive: true }); await page.screenshot({ path: join(root, "output/playwright/experience-failure.png"), fullPage: true }); } });
for (const mode of ["agent", "team", "adaptive"] as const) test(`Preview in ${mode} mode configures an unknown app and opens a persistent server without command entry`, { timeout: 60000 }, async () => {
  const original = await readFile(join(repo, ".codeflow/config.json"), "utf8");
  await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ check: "true", prove: false }));
  await writeFile(join(repo, "preview-setup-fixture.txt"), "Use the existing app.cjs fixture.\n");
  execFileSync("git", ["add", ".codeflow/config.json", "preview-setup-fixture.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "preview requires agent setup"], { cwd: repo });
  try {
    const started = await api("/api/runs", { repo, pattern: mode === "adaptive" ? "auto-team" : "solo", checkpointOnFinish: mode === "agent", task: "Prepare the preview fixture result", roles: mode === "adaptive" ? { coordinator: ["claude"], pool: ["claude", "codex"] } : { agent: ["claude"] }, options: { maxMembers: 3 }, approvals: { plan: false }, loop: { check: "true", prove: false, maxSteps: 16, maxMinutes: 1 } });
    const run = await until(() => api(`/api/runs/${started.id}`), value => value.status !== "running");
    if (mode === "team") await api(`/api/runs/${run.id}/task-team`, { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 16, maxMinutes: 2, approvePlan: false });
    const tree = run.worktrees.find((tree: any) => tree.branch === run.artifacts[0].branch), endpoint = `/api/runs/${run.id}/worktrees/${tree.name}/serve`;
    assert.equal(await api(endpoint + "/config"), null);
    await page.goto(base + `/#/run/${run.id}`);
    const studio = page.locator(".result-compact");
    await studio.getByRole("button", { name: "Preview", exact: true }).click();
    await until(() => api(`/api/runs/${run.id}`), value => value.followUps.length === 1 && value.status !== "running");
    const server = await until(() => api(endpoint), value => !!value?.url);
    await until(() => api(endpoint + "/ready"), value => value.ready);
    await page.getByRole("img", { name: "Live browser page", exact: true }).waitFor();
    assert.match(await (await fetch(server.url)).text(), /Greeting fixture/);
    const configured = JSON.parse(await readFile(join(tree.path, ".codeflow/config.json"), "utf8"));
    assert.equal(configured.check, "true"); assert.equal(configured.prove, false); assert.equal(configured.run.command, "node app.cjs");
    await page.reload();
    await page.locator(".result-compact").getByRole("button", { name: "Open preview", exact: true }).click();
    assert.equal((await api(endpoint)).startedAt, server.startedAt, "opening again keeps the existing server");
    assert.equal((await api(`/api/runs/${run.id}`)).followUps.length, 1, "page reload does not repeat the agent request");
    if (mode === "team") {
      const current = await api(`/api/runs/${run.id}`), turn = current.teamTurns[0];
      assert.equal(turn.state, "applied");
      const child = await api(`/api/runs/${turn.executionId}`);
      assert.equal(child.lastCheck.ok, true); assert.equal(child.team.verification.approved, true);
      assert.ok(child.steps.some((step: any) => step.agent === "codex"), "the independent provider reviewed the setup");
    }
    if (mode === "adaptive") {
      const current = await api(`/api/runs/${run.id}`);
      assert.equal(current.followUps[0].agent, "claude", "the lead handles the combined result");
      assert.equal(current.followUps[0].worktree, "integration");
      assert.equal(current.followUps[0].checkPassed, true);
      assert.equal(current.team.verification.reviewed, false, "preview configuration does not inherit approval of earlier code");
    }
    await page.getByText("Set up a preview of this result.", { exact: true }).waitFor();
    assert.equal(await page.locator(".preview-request-details").getAttribute("open"), null);
    await page.waitForFunction(() => Number(document.querySelector<HTMLCanvasElement>(".live-browser-surface canvas")?.dataset.frames) > 1);
    await mkdir(join(root, "output/playwright"), { recursive: true });
    await page.screenshot({ path: join(root, `output/playwright/chat-preview-${mode}-ready.png`), fullPage: true });
    if (mode === "team") {
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree.path }).toString().trim();
      await studio.getByRole("button", { name: "Review changes", exact: true }).click();
      await page.locator(".review-files-heading", { hasText: "Working changes" }).waitFor();
      await page.locator(".review-files .rf", { hasText: "config.json" }).click();
      await page.locator(".review-diff").getByText(/node app.cjs/).waitFor();
      await page.locator(".review-delivery > summary").click();
      await page.getByText("Ask the agent in chat to commit these changes before publishing. Your working files are shown below.", { exact: true }).waitFor();
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree.path }).toString().trim(), headBefore);
      const coverage = await api(`/api/runs/${run.id}/review-coverage?branch=${encodeURIComponent(tree.branch)}`);
      assert.equal(coverage.workingChanges, true);
      const assessment = await fetch(base + `/api/runs/${run.id}/outcome`, { method: "POST", headers, body: JSON.stringify({ branch: tree.branch, expectedHead: headBefore, decision: "accepted" }) });
      assert.equal(assessment.status, 409, "working changes cannot be approved against an older commit");
    }
  } finally {
    await writeFile(join(repo, ".codeflow/config.json"), original);
    await rm(join(repo, "preview-setup-fixture.txt"), { force: true });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "restore configured fixture"], { cwd: repo });
  }
});
test("result-first review records commit-scoped feedback and rejects a stale decision", { timeout: 45_000 }, async () => {
  page.on("pageerror", error => errors.push(error.message));
  const started = await api("/api/runs", { repo, pattern: "solo", checkpointOnFinish: true, intent: "bug", task: "Improve a greeting", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } });
  result = await until(() => api(`/api/runs/${started.id}`), value => value.status !== "running");
  assert.equal(result.status, "done", result.error);
  await page.goto(base + `/#/run/${result.id}`);
  const studio = page.getByRole("region", { name: "Try and assess the result" });
  await studio.getByText("More options", { exact: true }).click();
  await studio.getByText("Record your assessment", { exact: true }).click();
  await studio.getByRole("button", { name: "Accept result", exact: true }).click();
  await until(() => api(`/api/runs/${result.id}`), value => value.outcome?.decision === "accepted");
  const response = await fetch(base + `/api/runs/${result.id}/outcome`, { method: "POST", headers, body: JSON.stringify({ decision: "needs-work", branch: result.artifacts[0].branch, expectedHead: "0".repeat(40) }) });
  assert.equal(response.status, 409);
  const metrics = await api(`/api/experience?repo=${encodeURIComponent(repo)}&intent=bug`);
  assert.equal(metrics.metrics.accepted, 1); assert.equal(metrics.recommendations[0].completed, 1);
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await page.locator(".run-scroll").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(root, "output/playwright/experience-result.png"), fullPage: true });
});
test("browser recording excludes passwords, saves a regression scenario and survives reload", { timeout: 60_000 }, async () => {
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const recorder = page.getByRole("region", { name: "Record a browser scenario" });
  await recorder.getByRole("button", { name: "Record a bug", exact: true }).click();
  await recorder.getByRole("button", { name: "Stop recording", exact: true }).click({trial:true});
  const surface=page.getByRole("img",{name:"Live browser page",exact:true});
  await page.waitForFunction(()=>{const canvas=document.querySelector<HTMLCanvasElement>(".live-browser-surface canvas");return canvas?.dataset.ready==="true"&&Math.abs(canvas.width-canvas.getBoundingClientRect().width)<2&&Math.abs(canvas.height-Math.max(200,canvas.getBoundingClientRect().height))<2;});
  await surface.click({position:{x:100,y:30}});await page.keyboard.type("Ada");
  await surface.click({position:{x:140,y:80}});await page.keyboard.type("DO-NOT-SAVE-THIS");
  await surface.click({position:{x:35,y:130}});
  await recorder.getByRole("button", { name: "Stop recording", exact: true }).click();
  await recorder.getByText("fill #name = Ada",{exact:true}).waitFor();
  await recorder.getByLabel("Scenario title", { exact: true }).fill("Greeting scenario");
  await recorder.getByLabel("Expected element (CSS selector)", { exact: true }).fill("#result");
  await recorder.getByLabel("Expected visible text", { exact: true }).fill("Hello Ada");
  await recorder.getByRole("button", { name: "Save scenario", exact: true }).click();
  await recorder.getByRole("button", { name: "Scenario saved", exact: true }).waitFor();
  [journey] = await api(`/api/journeys?repo=${encodeURIComponent(repo)}`);
  assert.ok(journey.actions.some((action: any) => action.kind === "fill" && action.value === "Ada"));
  assert.doesNotMatch(JSON.stringify(journey), /DO-NOT-SAVE|#password/);
  await recorder.getByRole("button", { name: "Replay original scenario", exact: true }).click();
  await recorder.getByText("Expected text appeared", { exact: true }).waitFor({ timeout: 30_000 });
  const evidence = await api(`/api/journeys/${journey.id}`);
  assert.equal(evidence.replays[0].status, "passed"); assert.ok(evidence.replays[0].frames.length > 1);
  await recorder.getByRole("button", { name: "Prepare verified fix", exact: true }).click();
  await page.waitForURL(url => url.hash === `#/project/${result.project}/new`);
  assert.match(await page.locator(".taskbox textarea").inputValue(), /Greeting scenario/);
  await page.getByText(/Recorded scenario: Greeting scenario/).waitFor();
  await page.goto(base + `/#/project/${result.project}/settings`);
  await page.locator(".scenario-library > summary").click();
  await page.getByRole("heading", { name: "Greeting scenario", exact: true }).waitFor();
  await page.reload(); await page.locator(".scenario-library > summary").click();
  await page.getByRole("heading", { name: "Greeting scenario", exact: true }).waitFor();
});
test("scenario replay binds to a finished result preview and rejects invalid targets", { timeout: 45_000 }, async () => {
  const started = await api("/api/runs", { repo, pattern: "solo", checkpointOnFinish: true, intent: "bug", journeyId: journey.id, task: "Verify the recorded greeting", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } });
  const fixed = await until(() => api(`/api/runs/${started.id}`), value => value.status !== "running");
  assert.equal(fixed.journeyId, journey.id);
  const tree = fixed.worktrees.find((tree: any) => tree.branch === fixed.artifacts[0].branch);
  const preview = await api(`/api/runs/${fixed.id}/worktrees/${tree.name}/serve`, { command: "node app.cjs" });
  await until(() => api(`/api/runs/${fixed.id}/worktrees/${tree.name}/serve/ready`), value => value.ready);
  for (const body of [{ url: base }, { runId: "missing", branch: tree.branch }, { runId: fixed.id, branch: "missing" }, { runId: fixed.id, branch: tree.branch, url: journey.url }]) {
    const response = await fetch(base + `/api/journeys/${journey.id}/replay`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400, await response.text());
  }
  const responses = await Promise.all(Array.from({ length: 2 }, () => fetch(base + `/api/journeys/${journey.id}/replay`, { method: "POST", headers, body: JSON.stringify({ runId: fixed.id, branch: tree.branch, url: preview.url }) })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const replay = await responses.find(response => response.status === 201)!.json() as any;
  assert.equal(replay.status, "passed"); assert.equal(replay.runId, fixed.id); assert.equal(replay.branch, tree.branch); assert.match(replay.head, /^[a-f0-9]{40}$/);
});
test("alternative runs keep a pinned base and distinct instructions; comparison and briefing fit mobile", { timeout: 90_000 }, async () => {
  await page.goto(base + `/#/run/${result.id}`);
  await page.locator(".result-more > summary").click();
  await page.locator(".alternatives > summary").click();
  await page.getByLabel("Alternative A", { exact: true }).fill("Use compact spacing.");
  await page.getByLabel("Alternative B", { exact: true }).fill("Use spacious spacing.");
  await page.getByRole("button", { name: "Build both alternatives", exact: true }).click();
  const children = await until(() => api<any[]>("/api/runs"), values => values.filter(value => value.parentRunId === result.id && value.group).length === 2);
  const pair = children.filter(value => value.parentRunId === result.id && value.group);
  assert.equal(pair[0].baseRef, pair[1].baseRef); assert.equal(pair[0].group.id, pair[1].group.id);
  assert.ok(pair.some(value => value.task.includes("compact spacing"))); assert.ok(pair.some(value => value.task.includes("spacious spacing")));
  await until(() => api<any[]>("/api/runs"), values => values.filter(value => value.group?.id === pair[0].group.id).every(value => value.status !== "running"));
  await page.locator(".alternative-preview").first().getByRole("link", { name: "Choose and continue" }).waitFor();
  await page.locator(".alternative-preview").first().getByRole("button", { name: "Preview alternative" }).click();
  await page.locator(".alternative-preview iframe").waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, colorScheme);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.addScriptTag({ content: axe.source });
      const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations);
      assert.deepEqual(violations.map((v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(" ")).join(", ")}`), [], `${width}, ${colorScheme}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  await page.screenshot({ path: join(root, "output/playwright/experience-alternatives-mobile.png"), fullPage: true });
  await page.goto(base + `/#/project/${result.project}/settings`);
  await page.getByRole("region", { name: "Useful outcomes", exact: true }).waitFor();
  await page.getByRole("link", { name: "Manage project missions", exact: true }).click();
  await page.getByRole("region", { name: "Project briefing", exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
