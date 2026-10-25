import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "codeflow-browser-links-"));
const home = join(directory, "home"), repo = join(directory, "repo");
const token = "browser-links-fixture";
let server: ChildProcess, app: Server, browser: Browser, page: Page, base: string, appUrl: string, unregisteredUrl: string;
let unregisteredRequests = 0;
const portOf = (server: Server) => (server.address() as AddressInfo).port;

before(async () => {
  app = createServer((_request, response) => { unregisteredRequests++; response.writeHead(200, { "content-type": "text/html", "x-frame-options":"DENY", "content-security-policy":"frame-ancestors 'none'" }).end("<title>Frame-blocked site</title><h1>Unrelated local service</h1>"); });
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  unregisteredUrl = `http://127.0.0.1:${portOf(app)}/unsafe`;
  const appProbe = createServer(); await new Promise<void>(resolve => appProbe.listen(0, "127.0.0.1", resolve));
  const appPort = portOf(appProbe); await new Promise<void>(resolve => appProbe.close(() => resolve()));
  appUrl = `http://127.0.0.1:${appPort}/`;
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${portOf(probe)}`; await new Promise<void>(resolve => probe.close(() => resolve()));
  mkdirSync(join(home, "runs"), { recursive: true }); mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "app.mjs"), "import { createServer } from 'node:http'; createServer((_req,res) => res.writeHead(200, {'content-type':'text/html'}).end('<!doctype html><title>Preview fixture</title><h1>Preview is live</h1>')).listen(Number(process.env.PORT), '127.0.0.1');\n");
  writeFileSync(join(repo, "README.md"), "Preview fixture\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-qm", "fixture"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(home, "projects.json"), JSON.stringify([{ id: "project", name: "Preview project", repos: [repo], createdAt: 1 }]));
  const run = { id: "preview-run", project: "project", repo, baseRef: head, pattern: "solo", task: "Start the server", roles: { agent: ["claude"] }, options: {}, status: "done", createdAt: 1, endedAt: 2, worktrees: [{ name: "solo", path: repo, branch: "main" }], usage: { agentSteps: 1, checks: 0 } };
  const step = { id: "s1", kind: "agent", agent: "claude", title: "Start app", role: "agent", mode: "write", status: "done", startedAt: 1, endedAt: 2, finalText: `Unregistered link: ${unregisteredUrl}.\n\nServer running at [${appUrl}](${appUrl}).\n\n[External reference](${unregisteredUrl})` };
  writeFileSync(join(home, "runs/preview-run.jsonl"), [JSON.stringify({ seq: 1, ts: 1, runId: run.id, type: "run", run }), JSON.stringify({ seq: 2, ts: 2, runId: run.id, type: "step", step })].join("\n") + "\n");
  const otherRun = { ...run, id: "other-run", task: "Check dependencies", worktrees: [{ name: "solo", path: join(directory, "other-worktree"), branch: "main" }] };
  writeFileSync(join(home, "runs/other-run.jsonl"), JSON.stringify({ seq: 3, ts: 3, runId: otherRun.id, type: "run", run: otherRun }) + "\n");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: new URL(base).port, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) { if (await fetch(base + "/api/health", { headers: { authorization: `Bearer ${token}` } }).then(response => response.ok, () => false)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const launch = await fetch(`${base}/api/runs/preview-run/worktrees/solo/serve`, { method: "POST", headers, body: JSON.stringify({ command: `'${process.execPath.replaceAll("'", "'\\''")}' app.mjs`, port: appPort }) });
  assert.equal(launch.status, 200, await launch.clone().text());
  assert.equal((await launch.json()).port, appPort);
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", error => console.error("Browser error:", error.message));
});
after(async () => { await browser?.close(); server?.kill("SIGTERM"); if (server?.exitCode === null) await new Promise<void>(resolve => { server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); }); app?.closeAllConnections(); await new Promise<void>(resolve => app?.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });

test("a reachable app in an agent answer opens automatically, and link clicks reuse its Browser tab", { timeout: 30_000 }, async () => {
  await page.goto(`${base}/?token=${token}#/run/preview-run`);
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor({ timeout: 10000 }).catch(async error => { console.error((await page.locator("body").innerText()).slice(-5000)); throw error; });
  await page.locator("#side-pane-browser").getByRole("button", {name:"Preview fixture",exact:true}).waitFor({timeout:15000});
  await page.locator('canvas[data-ready="true"]').waitFor();
  assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), appUrl);
  assert.equal(unregisteredRequests, 0, "agent output cannot probe or open an unrelated host service");
  await page.getByRole("button", { name: "Close side panel", exact: true }).click({ timeout: 5000 });
  await page.locator(".turn-body").getByRole("link", { name: appUrl, exact: true }).click({ timeout: 5000 });
  assert.equal(await page.getByLabel("Address", { exact: true }).inputValue(), appUrl);
  assert.equal(page.context().pages().length, 1, "ordinary links stay in the workspace");
  assert.equal(await page.locator("#side-pane-browser .sess-list .sess").count(), 1, "canonical URLs reuse the same tab");
});

test("automatic readiness requires the matching run's registered server", async () => {
  const status = async (url: string, runId?: string) => fetch(`${base}/api/preview/status`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url, runId }) }).then(response => response.json());
  assert.deepEqual(await status(appUrl, "preview-run"), { ready: true });
  assert.deepEqual(await status(appUrl, "unknown-run"), { ready: false });
  assert.deepEqual(await status(appUrl), { ready: false });
  assert.deepEqual(await status(unregisteredUrl, "preview-run"), { ready: false });
  assert.equal(unregisteredRequests, 0);
});

test("workspace panel docks, drags beside the conversation, expands in place and preserves the live browser", async () => {
  await page.setViewportSize({width:1104,height:785});
  const panel = page.getByRole("complementary", {name:"Side panel",exact:true});
  const main = page.locator(".main-col");
  const divider = page.getByRole("separator", {name:"Resize the side panel",exact:true});
  const livePage = panel.getByRole("button", {name:"Preview fixture",exact:true});
  await livePage.waitFor();
  const state = async () => fetch(`${base}/api/browser?scope=run:preview-run`, {method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({action:"state"})}).then(response=>response.json());
  const target = (await state()).selected;
  assert.ok(target);
  const assertDocked = async () => {
    await main.waitFor({state:"visible"});
    await page.waitForFunction(() => {
      const rail = document.querySelector(".rail")!.getBoundingClientRect();
      const panel = document.querySelector("aside.side")!.getBoundingClientRect();
      const limit = Math.max(300, Math.min(900, innerWidth - rail.width - 360));
      return Math.abs(panel.width - Math.min(Number(localStorage.getItem("sideWidth")) || 420, limit)) <= 1;
    });
    const {p,m,controlsRight} = await page.evaluate(() => {
      const panel = document.querySelector("aside.side")!.getBoundingClientRect();
      const main = document.querySelector(".main-col")!.getBoundingClientRect();
      return {p:{x:panel.x,width:panel.width},m:{x:main.x,width:main.width},controlsRight:document.querySelector(".topbar .side-btn")!.getBoundingClientRect().right};
    });
    assert.ok(Math.abs(m.x + m.width - p.x) <= 1, "the panel is beside the chat, without overlap");
    assert.ok(controlsRight <= p.x, "the chat header controls stay inside their column");
    assert.ok(Math.abs(p.x + p.width - page.viewportSize()!.width) <= 1);
    assert.equal(await panel.evaluate(element => getComputedStyle(element).position), "relative");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    return {p,m};
  };
  const original = await assertDocked();
  const grip = (await divider.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 80, grip.y + grip.height / 2, {steps:8});
  await page.mouse.up();
  const resized = await assertDocked();
  assert.ok(resized.p.width > original.p.width + 50);
  assert.ok(resized.m.width < original.m.width - 50);
  assert.equal(await divider.getAttribute("aria-valuenow"), String(Math.round(resized.p.width)));
  const savedWidth = await page.evaluate(() => localStorage.getItem("sideWidth"));
  await panel.getByRole("button", {name:"Expand side panel",exact:true}).click();
  assert.equal(await main.isVisible(), false);
  const full = (await panel.boundingBox())!;
  assert.equal(full.x, 0); assert.equal(full.width, 1104); assert.equal(full.height, 785);
  assert.equal(page.context().pages().length, 1, "expanding uses the current window");
  assert.equal((await state()).selected,target,"resizing retains the same Chrome target");
  mkdirSync(join(root,"output/playwright"),{recursive:true});
  await page.screenshot({path:join(root,"output/playwright/panel-expanded.png")});
  await panel.getByRole("button", {name:"Restore side panel",exact:true}).click();
  assert.equal((await assertDocked()).p.width, resized.p.width);
  await panel.getByRole("button", {name:"Expand side panel",exact:true}).click();
  await page.keyboard.press("Escape");
  await assertDocked();
  assert.equal((await state()).selected,target,"resizing retains the same Chrome target");
  await page.screenshot({path:join(root,"output/playwright/panel-docked.png")});
  await page.reload();
  await livePage.waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("sideWidth")), savedWidth);
  assert.equal((await assertDocked()).p.width, resized.p.width, "the docked width survives reload");
  // A narrow window clamps the display, without overwriting the user's saved width.
  await page.setViewportSize({width:768,height:900});
  await assertDocked();
  await page.setViewportSize({width:1440,height:1000});
  assert.equal((await assertDocked()).p.width, resized.p.width);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await main.isVisible(), false);
  assert.equal((await panel.boundingBox())!.width,390);
  assert.equal(await divider.isVisible(),false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await panel.getByRole("button", {name:"Close side panel",exact:true}).click();
  assert.equal(await main.isVisible(),true);
  await page.getByRole("button", {name:"Side panel",exact:true}).click();
  await livePage.waitFor();
  await page.setViewportSize({width:1104,height:785});
  await assertDocked();
});

test("explicit links to frame-blocked sites open in the same live in-app browser", { timeout: 30_000 }, async () => {
  let snapshots = 0;
  page.on("request", request => {if(request.url().includes("/api/snapshot")) snapshots++;});
  await page.locator(".turn-body").getByRole("link", { name: "External reference", exact: true }).click();
  await page.locator("#side-pane-browser").getByRole("button", {name:"Frame-blocked site",exact:true}).waitFor();
  await page.locator('canvas[data-ready="true"]').waitFor();
  await page.waitForFunction(url => document.querySelector<HTMLInputElement>('.live-browser-address input')?.value === url, unregisteredUrl);
  assert.equal(snapshots,0);
  assert.equal(await page.locator("#side-pane-browser iframe").count(),0);
  assert.equal(page.context().pages().length,1);
  assert.equal(await page.getByLabel("Address", {exact:true}).inputValue(),unregisteredUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#side-pane-browser").evaluate(element => element.scrollWidth <= element.clientWidth), true);
});

test("empty browser tabs explain run scope, and Keep open preserves a website across run switches", { timeout: 60_000 }, async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = page.getByRole("complementary", { name: "Side panel", exact: true });
  const state = async (id: string) => fetch(`${base}/api/browser?scope=run:${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "state" }) }).then(response => response.json());
  const original = (await state("preview-run")).selected;
  await panel.getByRole("button", { name: "Keep open when switching runs", exact: true }).click();
  await page.locator(".rail-run-row").getByRole("button", { name: /^Check dependencies/ }).click();
  await page.getByRole("heading", { name: "Check dependencies", exact: true }).waitFor();
  await panel.locator(".scope-state").getByText("Pinned", { exact: true }).waitFor();
  assert.equal(await panel.getByLabel("Address", { exact: true }).inputValue(), unregisteredUrl);
  assert.equal((await state("preview-run")).selected, original, "pinning keeps the original Chrome tab");
  await panel.getByRole("button", { name: "Follow", exact: true }).click();
  await panel.getByRole("region", { name: "Browser start page", exact: true }).waitFor();
  const blankCanvas = panel.locator(".live-browser-surface canvas");
  await page.waitForFunction(() => Number(document.querySelector<HTMLCanvasElement>(".live-browser-surface canvas")?.dataset.frames) > 0);
  assert.equal(await blankCanvas.isVisible(), false, "an actual about:blank frame never becomes a black canvas");
  assert.equal(await panel.getByLabel("Address", { exact: true }).inputValue(), "");
  await panel.getByRole("button", { name: "Enter address", exact: true }).click();
  assert.equal(await panel.getByLabel("Address", { exact: true }).evaluate(element => element === document.activeElement), true);
  await page.addScriptTag({ content: axe.source });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 785 });
      assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await page.waitForFunction(() => document.querySelector("#side-panel")!.getAnimations({ subtree: true }).every(animation => animation.playState !== "running"));
      const audit = await page.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run("#side-panel", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
      assert.deepEqual(audit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
      await page.screenshot({ path: join(root, `output/playwright/browser-empty-${theme}-${width}.png`) });
    }
  }
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".rail-run-row").getByRole("button", { name: /^Start the server/ }).click();
  await panel.getByRole("button", { name: "Frame-blocked site", exact: true }).waitFor();
  assert.equal((await state("preview-run")).selected, original, "returning to the run restores its original page");
  await panel.getByRole("button", { name: "New browser tab", exact: true }).click();
  await panel.getByRole("region", { name: "Browser start page", exact: true }).waitFor();
  assert.equal(await blankCanvas.isVisible(), false);
  const blank = (await state("preview-run")).selected;
  await panel.getByRole("button", { name: "Frame-blocked site", exact: true }).click();
  await panel.locator('canvas[data-ready="true"]').waitFor({ timeout: 10_000 }).catch(async error => {
    console.error("Selected page", await state("preview-run"), await blankCanvas.evaluate(canvas => ({ ...((canvas as HTMLCanvasElement).dataset), hidden: (canvas as HTMLCanvasElement).hidden })), await panel.innerText());
    await page.screenshot({ path: join(root, "output/playwright/browser-switch-failure.png") });
    throw error;
  });
  await panel.getByRole("button", { name: "New tab", exact: true }).click();
  await panel.getByRole("region", { name: "Browser start page", exact: true }).waitFor();
  assert.equal((await state("preview-run")).selected, blank);
  assert.equal(await blankCanvas.isVisible(), false, "switching back to a blank tab hides the prior website frame");
  await panel.getByRole("button", { name: "Close New tab", exact: true }).click();
  await panel.locator('canvas[data-ready="true"]').waitFor();
  assert.equal((await state("preview-run")).selected, original);
});
