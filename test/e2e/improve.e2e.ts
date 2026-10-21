// Composer Improve against a real server, plus deliberately late replies to exercise ownership.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-improve-ui-")));
const repos = [join(fixture, "alpha"), join(fixture, "beta")];
const home = join(fixture, "home");
const token = "improve-ui-token";
const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
const base = `http://localhost:${port}`;
let server: ChildProcess, browser: Browser, startupLog = "";

before(async () => {
  mkdirSync(home);
  for (const repo of repos) {
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "Fixture repository\n");
    git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial");
  }
  writeFileSync(join(home, "projects.json"), JSON.stringify(["Alpha", "Beta"].map((name) => ({ id: name.toLowerCase(), name: `${name} project`, repos, createdAt: Date.now() }))));
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_SLEEP_MS: "300", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk) => { startupLog = (startupLog + chunk.toString()).slice(-16000); });
  let healthy = false;
  for (let retry = 0; retry < 150; retry++) { healthy = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.ok, () => false); if (healthy || server.exitCode !== null) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(healthy, startupLog);
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
  await browser?.close(); server?.kill("SIGTERM");
  await new Promise<void>((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
  rmSync(fixture, { recursive: true, force: true });
});

async function openPage(ignoreAbort = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(({ repo, ignoreAbort }) => {
    localStorage.setItem("repo", repo); localStorage.setItem("project", "alpha"); localStorage.setItem("sideOpen", "0");
    // Simulate a response already in flight when cancellation occurs. Correctness must not rely
    // solely on fetch abort, since a resolved response can race that abort in a real browser.
    if (ignoreAbort) {
      const original = window.fetch.bind(window);
      (window as unknown as { improveSettled: number }).improveSettled = 0;
      window.fetch = (input, init) => {
        if (typeof input !== "string" || input !== "/api/improve-prompt") return original(input, init);
        return original(input, { ...init, signal: undefined }).finally(() => setTimeout(() => { (window as unknown as { improveSettled: number }).improveSettled++; }, 0));
      };
    }
  }, { repo: repos[0]!, ignoreAbort });
  await page.goto(`${base}/?token=${token}`);
  await page.locator(".composer-options > summary").click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Run repository"]')?.value.endsWith("/alpha"));
  await page.waitForFunction(() => !document.querySelector("#checkCmd")?.parentElement?.parentElement?.textContent?.includes("Loading repository configuration"));
  return page;
}

interface Held { route: Route; body: { text: string; repo: string; mode: string; execution: string; context: string[] } }
async function holdReplies(page: Page) {
  const queue: Held[] = [], waiting: ((held: Held) => void)[] = [];
  await page.route("**/api/improve-prompt", (route) => {
    const held = { route, body: route.request().postDataJSON() } as Held;
    const next = waiting.shift(); if (next) next(held); else queue.push(held);
  });
  return {
    next: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Held>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Improve request was not sent")), 8000);
      waiting.push((held) => { clearTimeout(timer); resolve(held); });
    }),
    answer: async (held: Held, prompt: string, settled: number, status = 200) => {
      await held.route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { prompt, summary: "Clarified the task.", agent: "claude" } : { error: prompt }) });
      await page.waitForFunction((count) => (window as unknown as { improveSettled: number }).improveSettled >= count, settled);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    },
  };
}
async function chooseRepo(page: Page, path: string) {
  await page.getByRole("button", { name: "Open another repository", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open repository", exact: true });
  await dialog.waitFor();
  await dialog.locator(".ps").filter({ hasNotText: "Loading…" }).filter({ hasText: /git repository|Open a folder/ }).waitFor();
  // Wait for this navigation, not a repository status retained from the prior opening.
  const listing = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/fs" && url.searchParams.get("path") === path;
  });
  await page.getByLabel("Folder path").fill(path); await page.getByLabel("Folder path").press("Enter");
  assert.equal((await listing).status(), 200);
  await dialog.getByText("✓ This folder is a git repository").waitFor();
  await page.getByRole("button", { name: "Open this repository", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(path => document.querySelector<HTMLSelectElement>('[aria-label="Run repository"]')?.value === path, path);
  await page.waitForFunction(() => !document.querySelector("#checkCmd")?.parentElement?.parentElement?.textContent?.includes("Loading repository configuration"));
}
async function chooseProject(page: Page, name: string) {
  await page.locator(".composer .project-btn").click();
  await page.getByRole("dialog", { name: "Projects", exact: true }).getByRole("button", { name: new RegExp(`^${name} project`) }).click();
  await page.locator(".composer .project-btn .name", { hasText: `${name} project` }).waitFor().catch(async error => { throw new Error(`${error.message}\n${page.url()}\n${(await page.locator("body").innerText()).slice(-10000)}`); });
}

test("Improve and Undo preserve criteria and attachments; modes support keyboard focus and a real local provider", async () => {
  const page = await openPage();
  try {
    const area = page.getByRole("textbox", { name: "Task", exact: true });
    const original = "Add a helpful empty state";
    await area.fill(original);
    await page.locator(".acceptance-editor > summary").click();
    await page.getByLabel("One requirement per line", { exact: true }).fill("Keep keyboard navigation working");
    await page.locator('.taskbox input[type="file"]').setInputFiles({ name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("Useful sample") });
    await page.getByRole("button", { name: "Remove sample.txt", exact: true }).waitFor();
    const response = page.waitForResponse("**/api/improve-prompt");
    await page.getByRole("button", { name: "Improve", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
    assert.equal(await area.inputValue(), `Goal: ${original}\n\nDone when: the tests pass.`);
    assert.equal(await page.getByLabel("One requirement per line", { exact: true }).inputValue(), "Keep keyboard navigation working");
    assert.equal(await page.getByRole("button", { name: "Remove sample.txt", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Undo", exact: true }).click(); assert.equal(await area.inputValue(), original);

    const menu = page.getByRole("button", { name: "How Improve works", exact: true });
    await menu.focus(); await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByRole("menuitemradio", { name: /^Quick rewrite/ }).evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("menuitemradio", { name: /^Use the repository/ }).evaluate((element) => element === document.activeElement), true);
    assert.match(await page.getByRole("menuitemradio", { name: /^Use the repository/ }).innerText(), /committed repository snapshot.*Skips local edits/s);
    await page.keyboard.press("Escape"); assert.equal(await menu.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("ArrowUp");
    const request = page.waitForRequest("**/api/improve-prompt"); await page.keyboard.press("Enter");
    assert.deepEqual((await request).postDataJSON(), { text: original, repo: repos[0], mode: "repo", execution: "local", settings: { agent: "auto", defaultMode: "quick", providers: {} }, context: ["sample.txt"] });
    assert.equal(await page.locator(".improve > .btn").evaluate((element) => element === document.activeElement), true, "mode selection leaves focus on the Improve/Stop action");
    await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
    assert.match(await page.locator(".taskbox [role=status]").innerText(), /repo/);
    await area.fill("A newer task I wrote myself");
    assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0, "Undo cannot replace a newer manual draft");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repos[0] }).toString(), "", "Improve did not change the source repository");
  } finally { await page.close(); }
});

test("Stop discards a late reply and an older completion cannot clear a newer Improve operation", async () => {
  const page = await openPage(true);
  try {
    const replies = await holdReplies(page), area = page.getByRole("textbox", { name: "Task", exact: true });
    await area.fill("Original task");
    await page.getByRole("button", { name: "Improve", exact: true }).click(); const first = await replies.next();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    assert.equal(await area.inputValue(), "Original task");
    await page.getByRole("button", { name: "Improve", exact: true }).click(); const second = await replies.next();
    await replies.answer(first, "Obsolete first rewrite", 1);
    assert.equal(await area.inputValue(), "Original task");
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 1, "first finally must leave the second operation busy");
    await replies.answer(second, "Current second rewrite", 2);
    await page.getByRole("button", { name: "Undo", exact: true }).waitFor(); assert.equal(await area.inputValue(), "Current second rewrite");
    await page.getByRole("button", { name: "Undo", exact: true }).click(); assert.equal(await area.inputValue(), "Original task");
  } finally { await page.close(); }
});

test("newer text, repository, project and context transitions invalidate late Improve results and errors", async () => {
  const page = await openPage(true);
  try {
    const replies = await holdReplies(page), area = page.getByRole("textbox", { name: "Task", exact: true });
    await area.fill("Keep this task");
    await page.getByRole("button", { name: "Improve", exact: true }).click(); const edited = await replies.next();
    await area.fill("Newer draft"); await area.fill("Keep this task");
    await replies.answer(edited, "Old rewrite after text round trip", 1); assert.equal(await area.inputValue(), "Keep this task");
    assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0);

    await page.getByRole("button", { name: "Improve", exact: true }).click(); const moved = await replies.next();
    await chooseRepo(page, repos[1]!); await chooseRepo(page, repos[0]!);
    await replies.answer(moved, "Old rewrite after repository round trip", 2); assert.equal(await area.inputValue(), "Keep this task");
    assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0);

    await page.getByRole("button", { name: "Improve", exact: true }).click(); const project = await replies.next();
    await chooseProject(page, "Beta");
    await replies.answer(project, "A failure from the previous project", 3, 500);
    await page.locator(".composer-options > summary").click();
    assert.equal(await area.inputValue(), ""); await area.fill("Keep this task"); assert.equal(await page.getByText("A failure from the previous project", { exact: true }).count(), 0);

    await page.getByRole("button", { name: "Improve", exact: true }).click(); const context = await replies.next();
    await page.locator('.taskbox input[type="file"]').setInputFiles({ name: "new-context.txt", mimeType: "text/plain", buffer: Buffer.from("New input") });
    await page.getByRole("button", { name: "Remove new-context.txt", exact: true }).waitFor();
    await replies.answer(context, "Rewrite made without the new context", 4); assert.equal(await area.inputValue(), "Keep this task");
    assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0);

    await page.getByRole("button", { name: "Improve", exact: true }).click(); const isolation = await replies.next();
    await page.getByText("Agent isolation", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image", exact: true }).check();
    await replies.answer(isolation, "Local rewrite after Docker was selected", 5); assert.equal(await area.inputValue(), "Keep this task");
    assert.equal(await page.getByRole("button", { name: "Improve", exact: true }).isDisabled(), true);
    await page.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image", exact: true }).uncheck();
    await page.getByRole("button", { name: "Improve", exact: true }).click(); const completed = await replies.next();
    await replies.answer(completed, "Valid rewrite for Beta project", 6);
    await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
    await chooseProject(page, "Alpha");
    assert.equal(await page.getByRole("button", { name: "Undo", exact: true }).count(), 0, "a completed rewrite cannot restore an earlier project's draft");
    assert.equal(await area.inputValue(), "Keep this task", "Alpha retains its own draft");
  } finally { await page.close(); }
});

test("folder picker ignores a prior opening's delayed native close event while preserving explicit navigation", async () => {
  const page = await openPage();
  try {
    await page.evaluate(() => {
      const native = HTMLDialogElement.prototype.close;
      let delayed = false;
      HTMLDialogElement.prototype.close = function (value?: string) {
        if (!delayed && this.getAttribute("aria-labelledby") === "folder-picker-title") {
          delayed = true;
          this.addEventListener("close", (event) => {
            event.stopImmediatePropagation();
            const dialog = this;
            (window as unknown as { releasePickerClose?: () => void }).releasePickerClose = () => {
              delete (window as unknown as { releasePickerClose?: () => void }).releasePickerClose;
              dialog.dispatchEvent(new Event("close"));
            };
          }, { once: true, capture: true });
        }
        native.call(this, value);
      };
    });
    await chooseRepo(page, repos[1]!);
    await page.waitForFunction(() => typeof (window as unknown as { releasePickerClose?: unknown }).releasePickerClose === "function");
    let take!: (route: Route) => void;
    const requested = new Promise<Route>((resolve) => { take = resolve; });
    await page.route("**/api/fs?**", (route) => {
      if (new URL(route.request().url()).searchParams.get("path") === repos[0]) take(route);
      else void route.continue();
    });
    await page.getByRole("button", { name: "Open another repository", exact: true }).click();
    await page.getByLabel("Folder path").fill(repos[0]!); await page.getByLabel("Folder path").press("Enter");
    const listing = await requested;
    await page.evaluate(() => (window as unknown as { releasePickerClose: () => void }).releasePickerClose());
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.getByRole("dialog", { name: "Open repository", exact: true }).isVisible(), true, "a prior controlled close cannot dismiss the new opening");
    await listing.continue();
    await page.getByText("✓ This folder is a git repository").waitFor();
    await page.getByRole("button", { name: "Open this repository", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Run repository"]')?.value.endsWith("/alpha"));
    await page.unroute("**/api/fs?**");
    await page.getByRole("button", { name: "Open another repository", exact: true }).click();
    await page.getByRole("dialog", { name: "Open repository", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Open repository", exact: true }).waitFor({ state: "hidden" });
  } finally { await page.close(); }
});

test("Improve respects SSH and Docker selection and its mode menu remains accessible on a phone", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.addInitScript((repo) => { localStorage.setItem("repo", repo); localStorage.setItem("project", "alpha"); localStorage.setItem("sideOpen", "0"); }, repos[0]!);
    await page.route("**/api/remote-workers", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: "ssh", name: "Fixture worker", repoMappings: ["project"], protocol: 1 }]) }));
    await page.route("**/api/remote-workers/ssh/probe", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ capabilities: { providers: [{ id: "claude", available: true }], repoMappings: ["project"] } }) }));
    await page.goto(`${base}/?token=${token}`); await page.getByRole("textbox", { name: "Task", exact: true }).fill("A mobile task");
    await page.locator(".composer-options > summary").click(); await page.locator(".advanced-controls > summary").click(); await page.getByLabel("Agent execution", { exact: true }).selectOption("ssh");
    assert.equal(await page.getByRole("button", { name: "Improve", exact: true }).isDisabled(), true);
    await page.getByText("Improve uses a local provider. Choose This computer to rewrite this task.", { exact: true }).waitFor();
    await page.getByLabel("Agent execution", { exact: true }).selectOption("");
    await page.getByText("Agent isolation", { exact: true }).click(); await page.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image", exact: true }).check();
    assert.equal(await page.getByRole("button", { name: "Improve", exact: true }).isDisabled(), true);
    await page.getByText("Improve uses a local provider. Turn off Docker isolation to rewrite this task.", { exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "Run agents in a prebuilt Docker image", exact: true }).uncheck();
    const trigger = page.getByRole("button", { name: "How Improve works", exact: true });
    for (const colorScheme of ["light", "dark"] as const) {
      // Start each theme with a fresh document, as a normal page navigation does. Auditing
      // during a browser media-query repaint can mix old foregrounds with new backgrounds.
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" }); await page.reload();
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Run repository"]')?.value.endsWith("/alpha"));
      await page.getByRole("textbox", { name: "Task", exact: true }).fill("A mobile task");
      await trigger.focus(); await page.keyboard.press("ArrowDown"); await page.getByRole("menu", { name: "Improve mode" }).waitFor();
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
      assert.deepEqual(result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) })), [], `${colorScheme} mobile Improve menu`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.getByRole("menuitemradio", { name: /^Use the repository/ }).locator(".pi-sub").evaluate((element) => element.scrollWidth <= element.clientWidth), true, "the snapshot scope must wrap instead of truncating the local-edits exclusion");
      for (const button of [trigger, page.getByRole("button", { name: "Improve", exact: true })]) { const box = await button.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44); }
      const screenshots = process.env.CODEFLOW_UI_SCREENSHOTS;
      if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, `improve-mobile-${colorScheme}.png`), fullPage: true }); }
      await page.keyboard.press("Escape"); assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    }
  } finally { await page.close(); }
});

test("Prompt improvement settings persist, select the configured provider and default mode, and keep Undo", async () => {
  const page = await openPage();
  try {
    await page.goto(`${base}/#/settings/agents`);
    const panel = page.getByRole("region", { name: "Prompt improvement", exact: true });
    await panel.getByLabel("Prompt improvement agent", { exact: true }).selectOption("claude");
    await panel.getByLabel("Quick model · Claude Code", { exact: true }).fill("haiku");
    assert.equal(await panel.getByLabel("Quick effort · Claude Code", { exact: true }).isDisabled(), true);
    await panel.getByLabel("Prompt improvement agent", { exact: true }).selectOption("codex");
    await panel.getByLabel("Default improvement mode", { exact: true }).selectOption("repo");
    await panel.getByLabel("Quick model · Codex", { exact: true }).fill("quick-model");
    await panel.getByLabel("Repo model · Codex", { exact: true }).fill("repo-model");
    await panel.getByLabel("Repo effort · Codex", { exact: true }).selectOption("high");
    await panel.getByLabel("Prompt improvement agent", { exact: true }).selectOption("claude");
    assert.equal(await panel.getByLabel("Quick model · Claude Code", { exact: true }).inputValue(), "haiku");
    await panel.getByLabel("Prompt improvement agent", { exact: true }).selectOption("codex");
    await page.reload();
    assert.equal(await panel.getByLabel("Prompt improvement agent", { exact: true }).inputValue(), "codex");
    assert.equal(await panel.getByLabel("Default improvement mode", { exact: true }).inputValue(), "repo");
    assert.equal(await panel.getByLabel("Repo model · Codex", { exact: true }).inputValue(), "repo-model");
    assert.equal(await panel.getByLabel("Repo effort · Codex", { exact: true }).inputValue(), "high");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.addScriptTag({ content: axe.source });
    const audit = await page.evaluate(async () => (window as any).axe.run('section[aria-label="Prompt improvement"]', { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
    assert.deepEqual(audit.violations.map((item: any) => ({ id: item.id, nodes: item.nodes.map((node: any) => node.target) })), []);
    mkdirSync(join(root, "output/playwright"), { recursive: true });
    await panel.screenshot({ path: join(root, "output/playwright/improve-settings-mobile.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.screenshot({ path: join(root, "output/playwright/improve-settings.png") });
    await page.goto(`${base}/#/new`);
    const area = page.getByRole("textbox", { name: "Task", exact: true });
    await area.fill("Clarify the login task");
    assert.match(await page.getByRole("button", { name: "Improve", exact: true }).innerText(), /Codex/);
    const response = page.waitForResponse("**/api/improve-prompt");
    await page.getByRole("button", { name: "Improve", exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    assert.equal((await result.json()).agent, "codex");
    await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
    assert.match(await page.locator(".taskbox [role=status]").innerText(), /Codex:/);
    const sent = result.request().postDataJSON();
    assert.equal(sent.mode, "repo"); assert.equal(sent.settings.agent, "codex");
    assert.deepEqual(sent.settings.providers.codex, { quick: { model: "quick-model" }, repo: { model: "repo-model", effort: "high" } });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    assert.equal(await area.inputValue(), "Clarify the login task");
    await page.goto(`${base}/#/settings/agents`);
    assert.equal(await panel.getByLabel("Default improvement mode", { exact: true }).inputValue(), "repo");
    await panel.getByRole("button", { name: "Reset Improve defaults", exact: true }).click();
    assert.equal(await panel.getByLabel("Prompt improvement agent", { exact: true }).inputValue(), "auto");
    assert.equal(await panel.getByLabel("Default improvement mode", { exact: true }).inputValue(), "quick");
  } finally { await page.close(); }
});
