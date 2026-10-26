import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, writeFile, mkdir, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer project-navigation-test", "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repoA: string, repoB: string;
let projectA: string, projectB: string;
const errors: string[] = [];
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-project-navigation-")));
  repoA = join(directory, "alpha"); repoB = join(directory, "beta");
  for (const repository of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", "-b", "main", repository]);
    await writeFile(join(repository, "README.md"), "Project fixture\n");
    await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    await mkdir(join(repository, ".codeflow")); await writeFile(join(repository, ".codeflow/config.json"), JSON.stringify({ check: "true", setup: "true", prove: false }));
    execFileSync("git", ["add", "."], { cwd: repository }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repository });
  }
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "data"), CODEFLOW_TOKEN: "project-navigation-test", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then(response => response.ok, () => false)) break; if (attempt === 149) throw new Error("Server did not start"); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base + "/?token=project-navigation-test");
});
after(async () => { await browser?.close(); if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); } if (directory) await rm(directory, { recursive: true, force: true }); });

async function chooseFolder(repository: string) {
  const requests: string[] = [];
  const observe = (request: import("playwright-core").Request) => { if (request.url().includes("/api/fs?")) requests.push(request.url()); };
  page.on("request", observe);
  const field = page.getByLabel("Folder path"); await field.fill(repository); await field.press("Enter");
  await page.getByText("✓ This folder is a git repository", { exact: true }).waitFor({ timeout: 10_000 }).catch(async error => { console.error({ requests, field: await field.inputValue(), expected: repository }, await page.getByRole("dialog", { name: "Open repository", exact: true }).innerText()); throw error; });
  page.off("request", observe);
  await page.getByRole("button", { name: "Open this repository", exact: true }).click();
}
async function projectNewRun(id: string) {
  await page.goto(base + `/#/project/${id}`);
  await page.locator(".page-head-actions").getByRole("button", { name: "New run", exact: true }).click();
  await page.getByLabel("Task", { exact: true }).waitFor({ timeout: 15000 }).catch(async error => { console.error(await page.locator("body").innerText(), errors); throw error; });
}

test("repository picker clears stale feedback, keeps invalid selections open and accepts checkout subfolders", { timeout: 45_000 }, async () => {
  await page.getByRole("button", { name: "Open repository", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Open repository", exact: true });
  const field = picker.getByLabel("Folder path");
  const open = picker.getByRole("button", { name: "Open this repository", exact: true });
  await field.fill(repoA); await field.press("Enter");
  await picker.getByText("✓ This folder is a git repository", { exact: true }).waitFor();
  await field.fill(directory);
  await picker.getByText("Press Enter or Go to check this path", { exact: true }).waitFor();
  assert.equal(await picker.getByText("✓ This folder is a git repository", { exact: true }).count(), 0);
  assert.equal(await open.isEnabled(), false);
  await field.press("Enter");
  await picker.getByText("Open a folder marked Git, or type a path", { exact: true }).waitFor();
  await open.click();
  await picker.getByText(/not a git repository/i).waitFor();
  assert.equal(await picker.isVisible(), true, "invalid folders can be corrected in place");
  await field.fill(join(repoA, ".codeflow")); await field.press("Enter");
  await picker.getByText("Open a folder marked Git, or type a path", { exact: true }).waitFor();
  await open.click();
  const choice = page.getByRole("dialog", { name: "Open repository in a project", exact: true });
  await choice.getByLabel("New project name", { exact: true }).waitFor();
  assert.equal(await choice.getByLabel("New project name", { exact: true }).inputValue(), "alpha");
  await choice.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("first repository creates a project before execution and requires no workspace setup", { timeout: 45_000 }, async () => {
  await page.getByRole("button", { name: "Open repository", exact: true }).click(); await chooseFolder(repoA);
  await page.getByLabel("New project name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("New project name", { exact: true }).inputValue(), "alpha");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByLabel("Task", { exact: true }).fill("Alpha draft");
  const projects = await api("/api/projects"); projectA = projects[0].id;
  assert.equal((await api("/api/runs")).length, 0);
  assert.match(await page.getByLabel("Run configuration summary").innerText(), /Computer.*This computer/);
  projectB = (await api("/api/projects", { name: "Beta", repos: [repoB] })).id;
});

test("project drafts and attachments survive project views, switches and reloads", { timeout: 45_000 }, async () => {
  await page.locator('input[type="file"]').first().setInputFiles({ name: "spec.txt", mimeType: "text/plain", buffer: Buffer.from("Important context") });
  await page.getByRole("button", { name: "Remove spec.txt" }).waitFor();
  await projectNewRun(projectB);
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "");
  await page.getByLabel("Task", { exact: true }).fill("Beta draft");
  await projectNewRun(projectA);
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Alpha draft");
  await page.getByRole("button", { name: "Remove spec.txt" }).waitFor();
  await page.reload(); await page.getByLabel("Task", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Alpha draft");
  await page.getByRole("button", { name: "Remove spec.txt" }).waitFor();
});

test("composer links and browser history restore the destination without changing global filters", { timeout: 45_000 }, async () => {
  await page.goto(base + `/?team=local#/project/${projectA}/new`);
  await page.getByLabel("Task", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Alpha draft");
  await page.evaluate(id => { location.hash = `#/project/${id}/new`; }, projectB);
  await page.locator(".where .project-btn", { hasText: "Beta" }).waitFor();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Beta draft");
  await page.goBack();
  await page.locator(".where .project-btn", { hasText: "alpha" }).waitFor();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Alpha draft");
  await page.goForward();
  await page.locator(".where .project-btn", { hasText: "Beta" }).waitFor();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Beta draft");
});

test("repository tools retain deep-link targets and old bookmarks show project navigation", { timeout: 45_000 }, async () => {
  await page.goto(base + `/#/project/${projectA}/workspace`);
  await page.getByRole("navigation", { name: "Project navigation" }).waitFor();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  assert.ok(page.url().includes(encodeURIComponent(repoA)));
  await page.reload(); await page.getByLabel("File to edit").waitFor();
  assert.equal(await page.getByLabel("Repository or run worktree").inputValue(), repoA);
  await page.goto(base + `/#/project/${projectA}/not-a-section`);
  await page.getByRole("heading", { name: "This link is invalid" }).waitFor();
});

test("explicit membership blocks stale launches and adding a repository is a deliberate action", { timeout: 45_000 }, async () => {
  await projectNewRun(projectA);
  await page.getByRole("button", { name: "Open another repository" }).click(); await chooseFolder(repoB);
  const choice = page.getByRole("dialog", { name: "Open repository in a project" });
  await choice.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Alpha draft");
  assert.deepEqual((await api("/api/projects")).find((project: any) => project.id === projectA).repos, [repoA]);
  await page.getByRole("button", { name: "Open another repository" }).click(); await chooseFolder(repoB);
  await choice.getByRole("button", { name: "Add to alpha", exact: true }).click();
  await page.getByLabel("Run repository").waitFor();
  assert.equal(await page.getByLabel("Run repository").inputValue(), repoB);
  await api(`/api/projects/${projectA}`, { repos: [repoA] });
  const response = await fetch(base + "/api/runs", { method: "POST", headers, body: JSON.stringify({ project: projectA, projectSelection: "explicit", repo: repoB, pattern: "solo", task: "must not launch", roles: { agent: ["claude"] }, loop: { check: "true", setup: "true", prove: false } }) });
  assert.ok(!response.ok); assert.match(await response.text(), /explicit member/);
  assert.equal((await api("/api/runs")).length, 0);
});

test("project composer launches into its recorded project and history supports review", { timeout: 60_000 }, async () => {
  await projectNewRun(projectB);
  assert.equal(await page.getByLabel("Task", { exact: true }).inputValue(), "Beta draft");
  await selectAgentConversation(page);
  const started = page.waitForResponse(response => response.url().endsWith("/api/runs") && response.request().method() === "POST" && response.status() === 201);
  await page.getByRole("button", { name: /^(Start run|Send)$/, exact: true }).click();
  const result = await (await started).json(); assert.equal(result.project, projectB);
  await page.waitForURL(url => url.hash === `#/run/${result.id}`);
  await page.goto(base + `/#/project/${projectB}/runs`);
  await page.getByRole("region", { name: "Run history", exact: true }).getByRole("link", { name: /Beta draft/ }).waitFor();
  await page.getByLabel("Include archived runs").check();
  const launched = await api(`/api/runs/${result.id}`);
  for (const query of [result.id, repoB, launched.pattern, "draft Beta"]) {
    const searched = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/runs" && url.searchParams.get("project") === projectB && url.searchParams.get("q") === query; });
    await page.getByLabel("Search this project's runs").fill(query);
    await searched;
    await page.getByRole("region", { name: "Run history", exact: true }).getByRole("link", { name: /Beta draft/ }).waitFor();
  }
  await page.getByLabel("Search this project's runs").fill("does not exist");
  await page.getByText("No runs match this view.", { exact: true }).waitFor();
});

test("recurring runs retain explicit membership and reject revoked destinations at save and launch", { timeout: 30_000 }, async () => {
  const project = (await api("/api/projects", { name: "Scheduled membership", repos: [repoA] })).id;
  const run = { project, projectSelection: "explicit", repo: repoA, pattern: "solo", task: "Must retain membership", roles: { agent: ["claude"] }, loop: { check: "true" } };
  const saved = await api("/api/automations", { name: "Strict scheduled run", enabled: false, schedule: { every: 60 }, run });
  // Interactive selection markers are not persisted so a deleted project can fall back.
  // The existing project id still authorizes only its current explicit members.
  assert.equal(saved.run.projectSelection, undefined); assert.equal(saved.run.project, project);
  await api(`/api/projects/${project}`, { repos: [] });
  const before = (await api("/api/runs")).length;
  for (const [path, body] of [["/api/automations", { name: "Stale selection", schedule: { every: 60 }, run }], [`/api/automations/${saved.id}`, { run }], [`/api/automations/${saved.id}/run`, {}]] as const) {
    const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 409); assert.match(await response.text(), /explicit member/);
  }
  assert.equal((await api("/api/runs")).length, before);
  assert.deepEqual((await api("/api/projects")).find((item: any) => item.id === project).repos, []);
});

test("a browser that denies IndexedDB can still open, save and reload a project draft", { timeout: 30_000 }, async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: { open() { throw new DOMException("Storage denied", "SecurityError"); } } }); });
    const tab = await context.newPage();
    await tab.goto(base + `/?token=project-navigation-test#/project/${projectB}/new`);
    await tab.getByLabel("Task", { exact: true }).fill("Draft saved through fallback storage");
    await tab.reload();
    await tab.getByLabel("Task", { exact: true }).waitFor();
    assert.equal(await tab.getByLabel("Task", { exact: true }).inputValue(), "Draft saved through fallback storage");
  } finally { await context.close(); }
});

test("project pages fit narrow screens, expose accessible navigation and have no runtime errors", { timeout: 45_000 }, async () => {
  await page.goto(base + `/#/project/${projectA}`);
  await page.getByRole("heading", { name: "alpha", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".page-head-actions .primary")?.disabled);
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await page.screenshot({ path: join(root, "output/playwright/project-overview.png"), fullPage: true });
  await page.addScriptTag({ content: axe.source });
  const audit = await page.evaluate(async () => (window as any).axe.run(".project-page", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a"] } }));
  assert.deepEqual(audit.violations.map((violation: any) => violation.id), []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("navigation", { name: "Runs", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator(".project-page").evaluate(element => element.getBoundingClientRect().right <= innerWidth), true, "project page fits the viewport");
  assert.equal(await page.locator(".project-start").evaluate(element => element.scrollWidth <= element.clientWidth), true, "task entry content is not clipped");
  await page.screenshot({ path: join(root, "output/playwright/project-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
});

test("project Board and People use the owning server despite colliding linked project IDs", { timeout: 60_000 }, async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let localBoard = await api("/api/team/board?teamConnection=local");
  const keys = await fetch(base + `/api/team/projects/${projectA}/repositories?teamConnection=local`, { method: "PUT", headers, body: JSON.stringify({ revision: localBoard.revision, repositories: [{ key: "app", label: "App" }] }) });
  assert.ok(keys.ok, await keys.text());
  await page.goto(base + `/#/project/${projectA}`);
  await page.getByRole("navigation", { name: "Project navigation" }).getByRole("link", { name: "Board", exact: true }).waitFor(); // repository keys alone configure collaboration
  const localTask = await api("/api/team/tasks?teamConnection=local", { projectId: projectA, repository: "app", title: "Local board task", owner: "owner" });
  localBoard = await api("/api/team/board?teamConnection=local");
  const remote = "c-1111111111111111";
  const remoteBoard = { ...localBoard, projects: localBoard.projects.map((p: any) => ({ ...p, name: `Remote ${p.name}` })), tasks: localBoard.tasks.map((t: any) => ({ ...t, title: "Remote colliding task" })) };
  const calls: string[] = [];
  await page.route(url => url.pathname === "/api/team/board", async request => {
    const source = new URL(request.request().url()).searchParams.get("teamConnection"); calls.push(source ?? "unset");
    if (source === remote) await request.fulfill({ json: remoteBoard }); else await request.continue();
  });
  try {
    await page.goto(base + `/?team=${remote}#/team/project/${projectA}`);
    await page.getByRole("button", { name: /Remote colliding task/ }).waitFor();
    await page.goto(base + `/?team=${remote}#/project/${projectA}`);
    await page.getByRole("button", { name: /^More project tools:/ }).click();
    await page.getByRole("menuitem", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: /Local board task/ }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("team"), "local");
    assert.equal(await page.getByRole("button", { name: /Remote colliding task/ }).count(), 0);
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page.getByText("Advanced administration", { exact: true }).click();
    await page.getByRole("region", { name: "Shared project accounts", exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, `#/project/${projectA}/people`);
    assert.equal(await page.locator(`#shared-role-${projectB}`).count(), 0, "roles form is project scoped");
    await page.getByRole("button", { name: "Open Board", exact: true }).click();
    await page.getByRole("button", { name: /Local board task/ }).click();
    await page.getByRole("heading", { name: /^Local board task/ }).waitFor();
    // The server refuses a formerly visible task: a stream refresh must discard its old content.
    await page.route(url => url.pathname === `/api/team/tasks/${localTask.id}`, request => request.fulfill({ status: 403, json: { error: "Project access revoked" } }));
    await api("/api/team/tasks?teamConnection=local", { projectId: projectA, repository: "app", title: "Wake board subscription" });
    await page.getByRole("alert").filter({ hasText: "Project access revoked" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: /^Local board task/ }).count(), 0);
    assert.ok(calls.includes(remote) && calls.includes("local"));
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});

test("project Automation ignores global filters and preserves saved schedules and backlog destinations", { timeout: 60_000 }, async () => {
  const create = (project: string, repo: string, name: string) => api("/api/automations", { name, enabled: false, schedule: { every: 60 }, run: { repo, project, projectSelection: "explicit", task: name, pattern: "solo", roles: { agent: ["claude"] }, loop: { check: "true", setup: "true" } } });
  await create(projectA, repoA, "Alpha scheduled task"); await create(projectB, repoB, "Beta scheduled task");
  await page.evaluate(() => { localStorage.setItem("peopleEnabled", "0"); localStorage.setItem("project", "all"); });
  await page.goto(base + `/#/project/${projectA}/automation/repeat`);
  await page.getByText("Alpha scheduled task", { exact: true }).waitFor();
  assert.equal(await page.getByText("Beta scheduled task", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Automation repository").inputValue(), repoA);
  await page.getByRole("link", { name: "Process a backlog", exact: true }).click();
  const requests: string[] = [];
  await page.route("**/api/github/sweep?*", async request => { requests.push(request.request().url()); await request.fulfill({ json: { items: [], notices: [] } }); });
  try {
    await page.locator(".chip-tpl.sweep").first().click();
    await page.getByText("Nothing open — all clear.", { exact: true }).waitFor();
    assert.equal(new URL(requests[0]!).searchParams.get("repo"), repoA);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  } finally { await page.unroute("**/api/github/sweep?*"); }
  await page.goto(base + `/#/project/${projectA}`);
  await page.getByRole("navigation", { name: "Project navigation" }).getByRole("link", { name: "Board", exact: true }).waitFor();
  await page.getByRole("navigation", { name: "Project navigation" }).getByRole("link", { name: "Automation", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Open command palette/ }).click();
  await page.getByRole("combobox", { name: "Find a command, project or run" }).fill("alpha people");
  await page.getByRole("option", { name: /alpha · People/ }).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("new project destinations support narrow screens, themes and keyboard navigation", { timeout: 90_000 }, async () => {
  for (const section of ["people", "automation/repeat", "board"]) {
    await page.goto(base + `/#/project/${projectA}/${section}`);
    await page.locator(".project-page").waitFor();
    if (section === "people") { await page.getByText("Advanced administration", { exact: true }).click(); await page.getByRole("region", { name: "Shared project accounts", exact: true }).waitFor(); }
    if (section === "board") await page.getByRole("button", { name: /Local board task/ }).waitFor();
    if (section.startsWith("automation")) await page.getByText("Alpha scheduled task", { exact: true }).waitFor();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" }); await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".rail").waitFor({ state: "hidden", timeout: 10_000 });
      // Flush style changes before enumerating transitions; otherwise axe can
      // sample the previous theme before reduced-motion transitions start.
      await page.waitForFunction(() => { document.documentElement.getBoundingClientRect(); return document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getComputedTiming().endTime === Infinity); }, undefined, { timeout: 10_000 });
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(async () => (await (window as any).axe.run(".project-page", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations);
      assert.deepEqual(result.map((v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(" "))}`), [], `${section}, ${colorScheme}`);
      assert.equal(await page.locator(".project-page").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, section);
      await page.screenshot({ path: join(root, `output/playwright/project-${section.replace("/", "-")}-${colorScheme}.png`), fullPage: true });
    }
    const more = page.getByRole("button", { name: /^More project tools:/ }); await more.focus(); await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "People", exact: true }).waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem", undefined, { timeout: 10_000 }); await page.keyboard.press("Escape");
    await page.getByRole("menu", { name: "More project tools", exact: true }).waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(await more.evaluate(element => document.activeElement === element), true);
  }
  assert.deepEqual(errors, []);
});

async function selectAgentConversation(page: import("playwright-core").Page) {
  const options = page.locator(".composer-options");
  if (await options.getAttribute("open") === null) await options.locator(":scope > summary").click();
  const advanced = page.locator(".advanced-controls");
  if (await advanced.getAttribute("open") === null) await advanced.locator(":scope > summary").click();
  await page.getByLabel("Workflow", {exact:true}).selectOption("solo");
}
