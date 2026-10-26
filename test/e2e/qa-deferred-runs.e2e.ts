// QA regressions for Run once later in the browser: the composer's default configuration saves,
// AI team is explained instead of dropped, stale conflicts clear on refresh, finished records can
// be removed, and an untouched start suggestion never goes stale. Fake agents; never 4317/4318.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { DeferredRunJob } from "../../src/deferred-runs.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-deferred-ui";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
let directory: string, home: string, repo: string, base: string, project: string, port: number, fixture: string;
let child: ChildProcess, browser: Browser, app: BrowserContext;
const request = () => ({ repo, project, pattern: "solo", task: "Deferred QA fixture", roles: { agent: ["claude"] }, options: {}, loop: { check: "true", maxMinutes: 1, maxSteps: 5 } });
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 20_000): Promise<T> { const deadline = Date.now() + timeout; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Deferred QA fixture timed out: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 100)); } }
async function cancelAll() { for (const job of await api<DeferredRunJob[]>("/api/deferred-runs")) if (!["started", "cancelled", "failed"].includes(job.status)) await api(`/api/deferred-runs/${job.id}/cancel`, { expectedRevision: job.revision }); }
/** A signed-in app tab that records page errors and failed API calls. */
async function open(path: string): Promise<{ page: Page; errors: string[] }> {
  const page = await app.newPage(), errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().includes("/api/") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/${path}`); return { page, errors };
}
async function composer(task: string) {
  const { page, errors } = await open(`#/project/${encodeURIComponent(project)}/new`);
  await page.getByRole("textbox", { name: "Task", exact: true }).fill(task);
  return { page, errors };
}
async function schedule(page: Page, kind: "Run once later" | "Repeat") {
  await page.getByRole("button", { name: "Run actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Schedule…" }).click();
  await page.getByRole("dialog", { name: "Schedule work" }).getByRole("button", { name: new RegExp(`^${kind}`) }).click();
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-deferred-ui-"))); home = join(directory, "home"); repo = join(directory, "repo"); await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Deferred QA fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  port = await new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); }); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 400; attempt++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (child.exitCode !== null || attempt === 399) throw new Error(`Deferred QA server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
  project = (await api("/api/projects", { name: "Deferred QA", repos: [repo] })).id;
  const bundle = await build({ stdin: { contents: `import {h,render} from "preact"; import {DeferredRunsPanel} from "./ui/deferred-runs.tsx"; render(h(DeferredRunsPanel,{runRequest:${JSON.stringify(request())},repo:${JSON.stringify(repo)},project:${JSON.stringify(project)}}),document.body);`, resolveDir: root }, bundle: true, write: false, format: "esm", jsx: "automatic", jsxImportSource: "preact", target: "es2022" });
  fixture = `<!doctype html><html><body><script type="module">${bundle.outputFiles![0]!.text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  app = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); app.setDefaultTimeout(10_000);
  const signIn = await app.newPage(); await signIn.goto(`${base}/?token=${token}`); await signIn.close();
});
after(async () => { await browser?.close(); if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } await rm(directory, { recursive: true, force: true }); });

test("the composer's default configuration saves as a deferred run", { timeout: 60_000 }, async () => {
  const { page, errors } = await composer("Deferred with the single configured check");
  await schedule(page, "Run once later");
  const dialog = page.getByRole("dialog", { name: "Start later" });
  await dialog.getByText("Queue this run configuration", { exact: true }).click();
  await dialog.getByLabel("Deferred start condition", { exact: true }).selectOption("at");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/deferred-runs") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Save deferred run", exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 201, await response.text());
  assert.equal(JSON.parse(response.request().postData()!).run.loop.verification, undefined, "the composer no longer sends null for the default");
  await dialog.getByRole("article", { name: "Deferred run Deferred with the single configured check" }).getByText("Waiting for start time", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("alert").count(), 0);
  const job = (await api<DeferredRunJob[]>("/api/deferred-runs")).find((item) => item.name === "Deferred with the single configured check")!;
  assert.equal(job.status, "waiting-time"); assert.ok(job.notBefore > Date.now()); assert.equal(job.run.loop.verification, undefined);
  assert.deepEqual(errors, []);
  await page.close(); await cancelAll();
});

test("with AI team on, Run once later and Repeat explain why they cannot save the team", { timeout: 60_000 }, async () => {
  const { page, errors } = await composer("Deferred with an AI team");
  await page.getByRole("switch", { name: "AI team", exact: true }).click();
  assert.equal(await page.getByRole("switch", { name: "AI team", exact: true }).getAttribute("aria-checked"), "true");
  await schedule(page, "Run once later");
  const later = page.getByRole("dialog", { name: "Start later" });
  await later.getByText("Queue this run configuration", { exact: true }).click();
  await later.getByRole("status").filter({ hasText: "AI team works only in a live Agent conversation" }).waitFor();
  assert.equal(await later.getByRole("button", { name: "Save deferred run", exact: true }).isDisabled(), true);
  await later.getByRole("button", { name: "Close", exact: true }).click();
  await schedule(page, "Repeat");
  const repeat = page.getByRole("dialog", { name: "Save as automation" });
  await repeat.getByRole("status").filter({ hasText: "AI team works only in a live Agent conversation" }).waitFor();
  await repeat.getByText("Runs this task with this agent and these settings", { exact: false }).waitFor();
  assert.equal(await repeat.getByRole("button", { name: "Save automation", exact: true }).isDisabled(), true);
  await repeat.getByRole("button", { name: "Cancel", exact: true }).click();
  // Switching the team off schedules the single agent as before.
  await page.getByRole("switch", { name: "AI team", exact: true }).click();
  await schedule(page, "Repeat");
  assert.equal(await page.getByRole("dialog", { name: "Save as automation" }).getByRole("status").count(), 0);
  assert.equal(await page.getByRole("dialog", { name: "Save as automation" }).getByRole("button", { name: "Save automation", exact: true }).isEnabled(), true);
  assert.equal((await api<DeferredRunJob[]>("/api/deferred-runs")).filter((job) => job.name === "Deferred with an AI team").length, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a stale second tab shows the job's current status without an outdated conflict", { timeout: 90_000 }, async () => {
  const waiting = await api<DeferredRunJob>("/api/deferred-runs", { name: "Two tab cancel", run: request(), notBefore: Date.now() + 60 * 60_000 });
  // A known rejection with attempts left: the repository leaves its explicit project before launch.
  const strict = (await api("/api/projects", { name: "Deferred QA strict", repos: [repo] })).id;
  const rejected = await api<DeferredRunJob>("/api/deferred-runs", { name: "Two tab retry", run: { ...request(), project: strict, projectSelection: "explicit" }, notBefore: Date.now() + 500 });
  await api(`/api/projects/${strict}`, { repos: [] });
  await until(() => api<DeferredRunJob[]>("/api/deferred-runs").then((jobs) => jobs.find((job) => job.id === rejected.id)!), (job) => job.status === "failed", 30_000);
  const a = await open(`#/automations/once`), b = await open(`#/automations/once`);
  const cards = (page: Page) => ({ cancel: page.getByRole("article", { name: "Deferred run Two tab cancel" }), retry: page.getByRole("article", { name: "Deferred run Two tab retry" }) });
  for (const page of [a.page, b.page]) { await cards(page).cancel.getByText("Waiting for start time", { exact: true }).waitFor(); await cards(page).retry.getByText("Start rejected", { exact: true }).waitFor(); }

  await cards(a.page).cancel.getByRole("button", { name: "Cancel deferred run", exact: true }).click();
  await cards(a.page).cancel.getByText("Cancelled", { exact: true }).waitFor();
  await cards(b.page).cancel.getByRole("button", { name: "Cancel deferred run", exact: true }).click();
  await cards(b.page).cancel.getByText("Cancelled", { exact: true }).waitFor();
  assert.equal(await cards(b.page).cancel.getByRole("alert").count(), 0, "a repeat cancel already has its outcome");

  await cards(a.page).retry.getByRole("button", { name: "Cancel deferred run", exact: true }).click();
  await cards(a.page).retry.getByText("Cancelled", { exact: true }).waitFor();
  await cards(b.page).retry.getByRole("button", { name: "Retry after reviewing the failure", exact: true }).click();
  await cards(b.page).retry.getByText("Cancelled", { exact: true }).waitFor({ timeout: 3000 }); // refreshed at once, not on the next poll
  assert.equal(await cards(b.page).retry.getByRole("alert").count(), 0, "the conflict no longer applies to the refreshed job");
  await b.page.getByText(/changed elsewhere and is now: Cancelled/).waitFor();
  await b.page.getByRole("button", { name: "Refresh queue", exact: true }).click();
  assert.equal(await b.page.getByRole("alert").count(), 0);
  const jobs = await api<DeferredRunJob[]>("/api/deferred-runs");
  assert.equal(jobs.find((job) => job.id === waiting.id)!.status, "cancelled"); assert.equal(jobs.find((job) => job.id === rejected.id)!.attempts, 1);
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.page.close(); await b.page.close();
});

test("finished records can be removed one at a time or cleared for the listed scope", { timeout: 60_000 }, async () => {
  await cancelAll();
  const waiting = await api<DeferredRunJob>("/api/deferred-runs", { name: "Still waiting", run: request(), notBefore: Date.now() + 60 * 60_000 });
  for (const name of ["Finished one", "Finished two"]) { const job = await api<DeferredRunJob>("/api/deferred-runs", { name, run: request(), notBefore: Date.now() + 60 * 60_000 }); await api(`/api/deferred-runs/${job.id}/cancel`, { expectedRevision: job.revision }); }
  const { page, errors } = await open(`#/project/${encodeURIComponent(project)}/automation/once`);
  const one = page.getByRole("article", { name: "Deferred run Finished one" });
  await one.getByRole("button", { name: "Remove record", exact: true }).click(); await one.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("article", { name: "Deferred run Still waiting" }).getByRole("button", { name: "Remove record" }).count(), 0, "open work cannot be removed");
  const finished = (await api<DeferredRunJob[]>("/api/deferred-runs")).filter((job) => job.run.project === project && ["started", "cancelled"].includes(job.status)).length;
  await page.getByRole("button", { name: `Clear finished (${finished})`, exact: true }).click();
  await page.getByRole("dialog", { name: "Clear finished deferred runs?" }).getByRole("button", { name: "Remove records", exact: true }).click();
  await page.getByRole("article", { name: "Deferred run Finished two" }).waitFor({ state: "detached" });
  await page.getByRole("article", { name: "Deferred run Still waiting" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Clear finished/ }).count(), 0);
  assert.deepEqual((await api<DeferredRunJob[]>("/api/deferred-runs")).filter((job) => job.run.project === project).map((job) => job.id), [waiting.id]);
  assert.deepEqual(errors, []);
  await page.close(); await cancelAll();
});

test("an untouched earliest-start suggestion is refreshed instead of going stale while the form stays open", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ extraHTTPHeaders: headers });
  await page.route(base + "/deferred-fixture", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  await page.clock.install({ time: new Date() });
  await page.goto(base + "/deferred-fixture");
  await page.getByText("Queue this run configuration", { exact: true }).click();
  await page.getByLabel("Deferred run label", { exact: true }).fill("Suggested start");
  await page.clock.fastForward("00:30:00");
  await page.getByLabel("Deferred start condition", { exact: true }).selectOption("at");
  const field = page.getByLabel("Deferred earliest start", { exact: true });
  const pageNow = () => page.evaluate(() => Date.now());
  assert.ok(new Date(await field.inputValue()).getTime() > await pageNow() + 55 * 60_000, "choosing a time suggests an hour from now, not from when the form opened");
  await page.clock.fastForward("01:01:00");
  await page.getByRole("button", { name: "Save deferred run", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "The suggested start time passed while this was open" }).waitFor();
  assert.ok(new Date(await field.inputValue()).getTime() > await pageNow(), "the field moves to a future time for review");
  assert.equal((await api<DeferredRunJob[]>("/api/deferred-runs")).filter((job) => job.name === "Suggested start").length, 0, "nothing is saved without review");
  await page.getByRole("button", { name: "Save deferred run", exact: true }).click();
  await page.getByRole("article", { name: "Deferred run Suggested start" }).waitFor();
  const job = (await api<DeferredRunJob[]>("/api/deferred-runs")).find((item) => item.name === "Suggested start")!;
  assert.equal(job.status, "waiting-time"); assert.ok(job.notBefore > Date.now());
  // A time you typed is kept exactly and still has to be in the future.
  await page.getByLabel("Deferred run label", { exact: true }).fill("Typed start");
  await field.fill("2020-01-01T09:00");
  await page.getByRole("button", { name: "Save deferred run", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Choose a future local start time." }).waitFor();
  assert.equal(await field.inputValue(), "2020-01-01T09:00");
  await page.close(); await cancelAll();
});

test("an unreadable queue is reported once and the panel and project page stop polling it", { timeout: 90_000 }, async () => {
  const faultHome = join(directory, "fault-home"); await mkdir(faultHome, { recursive: true });
  await writeFile(join(faultHome, "deferred-runs.json"), '{"version":1,"jobs":[{"id":"oops"', { mode: 0o600 });
  const free = () => new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
  let faultPort = await free(); while (faultPort === 4317 || faultPort === 4318) faultPort = await free();
  const faultBase = `http://127.0.0.1:${faultPort}`;
  const faulted = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(faultPort), CODEFLOW_REMOTE_PORT: String(await free()), CODEFLOW_HOME: faultHome, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; faulted.stdout?.on("data", (chunk) => { output += String(chunk); }); faulted.stderr?.on("data", (chunk) => { output += String(chunk); });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(10_000);
  try {
    for (let attempt = 0; attempt < 400; attempt++) { if (await fetch(faultBase + "/api/health", { headers }).then((response) => response.ok, () => false)) break; if (faulted.exitCode !== null || attempt === 399) throw new Error(`Faulted deferred QA server failed: ${output}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
    const created = await fetch(faultBase + "/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Deferred fault QA", repos: [repo] }) });
    assert.equal(created.status, 201, await created.clone().text());
    const faultProject = (await created.json() as { id: string }).id;
    const signIn = await context.newPage(); await signIn.goto(`${faultBase}/?token=${token}`); await signIn.close();
    const page = await context.newPage(), reads: string[] = [];
    page.on("request", (sent) => { if (new URL(sent.url()).pathname.endsWith("/api/deferred-runs") && sent.method() === "GET") reads.push(sent.url()); });
    await page.clock.install();
    await page.goto(`${faultBase}/#/project/${encodeURIComponent(faultProject)}/automation/once`);
    const panel = page.getByRole("region", { name: "Deferred runs" });
    await panel.getByRole("alert").filter({ hasText: /Deferred runs are unavailable: Deferred queue cannot be read/ }).waitFor();
    await panel.getByRole("alert").filter({ hasText: /deferred-runs\.json and restart code-flow/ }).waitFor();
    await page.waitForTimeout(500);
    const initial = reads.length;
    assert.ok(initial >= 1 && initial <= 2, `the panel and the project page each ask at most once on open: ${initial}`);
    // Two simulated minutes: before, the panel asked every 5 s and the project page every 15 s.
    for (let tick = 0; tick < 24; tick++) { await page.clock.fastForward(5_000); await page.waitForTimeout(100); }
    assert.equal(reads.length, initial, "background polls stop asking a queue that stays unavailable until restart");
    await panel.getByRole("alert").filter({ hasText: /Deferred runs are unavailable/ }).waitFor();
    // Refresh queue still checks again on request.
    await panel.getByRole("button", { name: "Refresh queue", exact: true }).click();
    await until(async () => reads.length, (count) => count === initial + 1, 5_000);
    await panel.getByRole("alert").filter({ hasText: /Deferred runs are unavailable/ }).waitFor();
    assert.match(output, /Deferred runs disabled/);
    assert.doesNotMatch(output, /\/api\/deferred-runs failed/, "the read error is logged once at startup, not for every request");
    await page.close();
  } finally {
    await context.close();
    if (faulted.exitCode === null) { faulted.kill("SIGTERM"); await new Promise((resolve) => faulted.once("exit", resolve)); }
  }
});
