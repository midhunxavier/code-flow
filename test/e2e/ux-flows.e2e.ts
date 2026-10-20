import { after, before, test } from "node:test";
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
const headers = { authorization: "Bearer ux-flows-e2e", "content-type": "application/json" };
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
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-ux-flows-e2e-")));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test subject.test.mjs" } }));
  await writeFile(join(repo, "subject.txt"), "original subject\n");
  await writeFile(join(repo, "subject.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('fixture', () => assert.equal(1 + 1, 2));\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: "ux-flows-e2e", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) { if (await fetch(base + "/api/health", { headers }).then((res) => res.ok, () => false)) break; if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); localStorage.setItem("sideTab", "changes"); }, repo);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000); server.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

const errors: string[] = [];
let result: any;

test("template library and workflow selection preserve intentional drafts and expose the effective configuration", { timeout: 45_000 }, async () => {
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base + "/#/");
  const choose = async (id: string) => {
    await page.getByRole("button", { name: "Template library", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Template library", exact: true });
    await dialog.getByLabel("Template", { exact: true }).selectOption(id);
    await dialog.getByRole("button", { name: "Use template", exact: true }).click();
  };
  await choose("starter-feature");
  const draft = page.locator(".taskbox textarea");
  await draft.fill("Keep this task while changing the workflow");
  await page.getByLabel("Workflow", { exact: true }).selectOption("council");
  assert.equal(await draft.inputValue(), "Keep this task while changing the workflow");
  await choose("starter-explore");
  assert.equal(await page.getByLabel("Workflow", { exact: true }).inputValue(), "debate");
  const roles = await page.evaluate(() => JSON.parse(localStorage.getItem("roleSel") || "{}"));
  assert.deepEqual(roles.debate.builder, []); assert.deepEqual(roles.debate.reviewer, []);
  await choose("starter-bug");
  await page.getByLabel("Workflow", { exact: true }).selectOption("tdd");
  await page.locator(".composer-summary").getByText("Limit", { exact: true }).waitFor();
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await page.screenshot({ path: join(root, "output/playwright/ux-composer.png"), fullPage: true });
});

test("finished work leads to review, commit-scoped coverage and publishing in one screen", { timeout: 45_000 }, async () => {
  const started = await api<{ id: string }>("/api/runs", { repo, pattern: "solo", task: "Improve the login error message", roles: { agent: ["claude"] }, loop: { check: "true", prove: false, maxSteps: 4, maxMinutes: 1 } });
  result = await until(() => api(`/api/runs/${started.id}`), value => value.status !== "running");
  assert.equal(result.status, "done", result.error);
  await page.goto(base + `/#/project/${result.project}`);
  await page.getByRole("button", { name: /results? in the inbox/ }).click();
  await page.waitForURL(url => url.hash === "#/inbox");
  await page.locator(".inbox-item", { hasText: result.task }).locator("a.t").click();
  const next = page.getByRole("region", { name: "Next action" });
  await next.getByRole("heading", { name: "Ready for your review" }).waitFor();
  await page.locator(".run-evidence").getByText("Finished", { exact: true }).waitFor();
  await page.locator(".run-evidence").getByText("Passed", { exact: true }).waitFor();
  assert.equal(await page.locator(".run-head").getByRole("button", { name: "Archive…" }).count(), 0);
  await page.getByRole("button", { name: "More run actions" }).click();
  await page.getByRole("menuitem", { name: "Edit & run again", exact: true }).waitFor();
  await page.getByRole("button", { name: "More run actions" }).click();
  await page.getByRole("menu", { name: "More run actions" }).waitFor({ state: "hidden" });
  await page.screenshot({ path: join(root, "output/playwright/ux-result.png"), fullPage: true });
  await next.getByRole("button", { name: "Review changes", exact: true }).click();
  await page.locator(".review-diff .diff-file-head").waitFor();
  const coverage = await api(`/api/runs/${result.id}/review-coverage?branch=${encodeURIComponent(result.artifacts[0].branch)}`);
  await page.locator(".review-files .review-coverage > summary").click();
  await page.locator(".review-files").getByLabel(`Mark ${coverage.files[0]} reviewed`, { exact: true }).click();
  await until(() => api(`/api/runs/${result.id}/review-coverage?branch=${encodeURIComponent(result.artifacts[0].branch)}`), value => value.reviewed.includes(coverage.files[0]));
  await page.getByText("Publish changes", { exact: true }).click();
  await page.getByRole("button", { name: "Merge…", exact: true }).click();
  await page.getByRole("button", { name: "Validate merge result", exact: true }).waitFor();
  await page.getByRole("button", { name: "Merge…", exact: true }).click();
  await page.screenshot({ path: join(root, "output/playwright/ux-review.png"), fullPage: true });
  assert.ok(page.url().includes("#/review/"));
});

test("failed checks prepare a follow-up and blocked checks continue from saved work", { timeout: 60_000 }, async () => {
  const start = (check: string) => api<any>("/api/runs", { repo, pattern: "solo", task: "Recovery fixture", roles: { agent: ["claude"] }, loop: { check, prove: false, maxSteps: 4, maxMinutes: 1 } });
  const failed = await start("false");
  const finished = await until(() => api(`/api/runs/${failed.id}`), value => value.status !== "running");
  assert.equal(finished.verdict, "failing");
  await page.goto(base + `/#/run/${failed.id}`);
  await page.getByRole("region", { name: "Next action" }).getByRole("button", { name: "Request a fix" }).click();
  await until(() => page.locator("main .convo textarea").inputValue(), value => value.includes("Investigate and fix the failing checks"));
  assert.equal((await api<any>(`/api/runs/${failed.id}`)).status, "done", "preparing a fix doesn't dispatch it");
  const blocked = await start("codeflow-missing-test-executable");
  const blockedResult = await until(() => api(`/api/runs/${blocked.id}`), value => value.status !== "running");
  assert.ok(blockedResult.checkCantRun);
  await page.goto(base + `/#/run/${blocked.id}`);
  await page.getByRole("button", { name: "Fix check command", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fix check command" });
  assert.equal(await dialog.getByLabel("Continue from").inputValue(), blockedResult.artifacts[0].branch);
  await dialog.getByLabel("Check command", { exact: true }).fill("true");
  await dialog.getByRole("button", { name: "Start continuation" }).click();
  await page.waitForURL(url => url.hash.startsWith("#/run/") && !url.hash.includes(blocked.id));
  const child = await until(() => api<any>(`/api/runs/${page.url().split("/run/")[1]}`), value => value.status !== "running");
  assert.equal(child.parentRunId, blocked.id);
  assert.equal(child.baseLabel, blockedResult.artifacts[0].branch);
  assert.equal(child.loop.check, "true");
  assert.equal(child.verdict, "passed");
  assert.ok((await api<any>(`/api/runs/${blocked.id}`)).checkCantRun, "original evidence is retained");
});

test("project tools retain repository context and new screens fit mobile and pass accessibility checks", { timeout: 60_000 }, async () => {
  assert.ok(result.project);
  await page.goto(base + `/#/project/${result.project}`);
  await page.getByRole("link", { name: "Repository tools", exact: true }).click();
  assert.equal(await page.getByLabel("Repository or run worktree").inputValue(), repo);
  await page.reload();
  assert.equal(await page.getByLabel("Repository or run worktree").inputValue(), repo);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      for (const hash of ["/", "/inbox", "/automations", `/run/${result.id}`, `/review/${result.id}/${result.artifacts[0].branch}`]) {
        await page.goto(base + "/#" + hash);
        await page.locator("main > div").waitFor();
        if (hash.startsWith("/review")) await page.locator(".review-diff .diff-file-head").waitFor();
        if (hash.startsWith("/run")) await page.locator(".run-evidence").waitFor();
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations);
        assert.deepEqual(violations.map((v: any) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(" ")).join(", ")}`), [], `${hash}, ${width}, ${colorScheme}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${hash} overflows at ${width}`);
      }
    }
  }
  await page.screenshot({ path: join(root, "output/playwright/ux-review-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
});
