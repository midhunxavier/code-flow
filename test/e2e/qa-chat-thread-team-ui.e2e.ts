// In the browser, with fake agents: a team's question card and progress stay in a chat after a quick
// question to the lead and a reload, an answer being typed survives the reload, and a finished Auto
// team's reply box starts valid after a one-call direct reply.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.QA_CHAT_PORT) || await new Promise<number>(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const p = (server.address() as { port: number }).port; server.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`, token = "qa-chat-thread-team-ui";
const home = mkdtempSync(join(tmpdir(), "cf-qa-chat-thread-")), repo = join(home, "repo");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page;
const browserErrors: string[] = [];
let serverLogs = "";
async function api(path: string, body?: unknown) { const r = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await r.json() as any; assert.ok(r.ok, JSON.stringify(value)); return value; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`); await new Promise(r => setTimeout(r, 200)); }
}
before(async () => {
  mkdirSync(repo); const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Empty input is valid.\n"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "Fixture");
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(home, "state"), CODEFLOW_TOKEN: token, FAKE_GH_STATE: join(home, "fake-gh.json"), FAKE_AUTO_SLOW_RELEASE: join(home, "release-slow"), PATH: `${root}/test/fake-bin:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", c => { serverLogs += c; }); server.stderr?.on("data", c => { serverLogs += c; });
  for (let i = 0; i < 150; i++) { if (await fetch(`${base}/api/health`, { headers }).then(r => r.ok, () => false)) break; if (i === 149) throw new Error(`Server failed: ${serverLogs}`); await new Promise(r => setTimeout(r, 200)); }
  browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1200 } }); page.setDefaultTimeout(20000);
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 500) browserErrors.push(`${response.status()} ${response.url()}`); });
  await page.addInitScript(() => { localStorage.setItem("sideOpen", "0"); });
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => server.once("exit", () => resolve())); }
  rmSync(home, { recursive: true, force: true });
  assert.deepEqual(browserErrors, [], "no browser errors or server 5xx responses");
  assert.doesNotMatch(serverLogs, /UnhandledPromiseRejection|uncaught exception/i);
});

test("t11-3 / t10-15: a question to the lead keeps the team's question card, progress and typed answer, also after a reload", { timeout: 120_000 }, async () => {
  const run = await api("/api/runs", { repo, pattern: "solo", task: "AUTO-USER-QUESTION Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 24, maxMinutes: 5, approvePlan: false } });
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  const main = page.locator(".runview");
  const card = page.getByRole("region", { name: "The team needs your answer" }), activity = page.getByRole("region", { name: "Team activity" });
  await card.waitFor({ timeout: 60_000 });
  await card.getByRole("textbox", { name: "Your answer" }).pressSequentially("Empty input is valid");
  await main.getByRole("textbox", { name: "Message agent", exact: true }).fill("how is it going?");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await until(() => api(`/api/runs/${run.id}`), (value) => value.steps.some((step: any) => step.leadQuestion && step.status === "done"), "the lead's answer");
  await main.getByText("how is it going?", { exact: true }).waitFor();
  assert.equal(await card.count(), 1, "the question card stays after the lead answers");
  assert.equal(await activity.count(), 1, "the team's progress stays after the lead answers");
  for (const reloaded of [false, true]) {
    if (reloaded) { await page.reload(); await card.waitFor(); }
    assert.equal(await activity.count(), 1);
    assert.equal(await card.getByRole("textbox", { name: "Your answer" }).inputValue(), "Empty input is valid", "an unsent answer is kept");
    const text = await main.innerText();
    assert.ok(text.indexOf("The team needs your answer") < text.indexOf("how is it going?"), "the card stays under the task, above the quick question");
  }
  await card.getByRole("button", { name: "Send answer" }).click();
  const parent = await until(() => api(`/api/runs/${run.id}`), (value) => value.status !== "running", "the team to finish", 90_000);
  assert.equal(parent.status, "done", parent.error);
  await page.reload(); await activity.waitFor();
  assert.equal(await activity.count(), 1, "the finished team shows its progress once");
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("team-answer-draft:"))), [], "a sent answer isn't restored");
});

test("t11-9 / t11-14: after a one-call direct reply, a reload offers a valid whole-team budget and one error line for an invalid one", { timeout: 120_000 }, async () => {
  const run = await api("/api/runs", { repo, pattern: "auto-team", task: "AUTO-SAME-PROVIDER implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, approvals: { plan: false }, loop: { maxSteps: 200, maxMinutes: 240 } });
  const finished = await until(() => api(`/api/runs/${run.id}`), (value) => value.status !== "running", "the team to finish", 90_000);
  assert.equal(finished.status, "done", finished.error);
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  const convo = page.locator("main .convo"), send = convo.getByRole("button", { name: "Send", exact: true });
  await convo.waitFor();
  assert.equal(await page.locator(".team-details > summary").innerText(), "Team activity · Finished");
  const direct = await convo.locator("select option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value.includes("@")));
  assert.ok(direct, "a worker can get a direct reply");
  await convo.locator("select").selectOption(direct);
  await convo.locator(".followup-budget > summary").click();
  await page.getByLabel("Follow-up maximum calls", { exact: true }).fill("1");
  await page.getByLabel("Reply", { exact: true }).fill("Add a short note to the README.");
  await send.click();
  const replied = await until(() => api(`/api/runs/${run.id}`), (value) => value.followUps[0]?.status !== undefined && value.followUps[0].status !== "pending" && value.status !== "running", "the direct reply");
  assert.equal(replied.loop.maxInvocations, 1, "the reply ran on its own allocation");
  await page.reload(); await convo.waitFor();
  assert.equal(await convo.locator("select").inputValue(), "team");
  assert.equal(await convo.locator("[role=alert]").count(), 0, "no error before you change anything");
  assert.match(await convo.locator(".followup-budget > summary").innerText(), /· 4 calls ·/);
  await page.getByLabel("Reply", { exact: true }).fill("Keep the result and add documentation.");
  assert.equal(await send.isDisabled(), false);
  await convo.locator(".followup-budget > summary").click();
  await page.getByLabel("Follow-up maximum calls", { exact: true }).fill("1");
  assert.equal(await send.isDisabled(), true);
  assert.equal(await convo.locator(".msg.err").count(), 1, "the budget problem is said once");
  assert.match(await convo.locator(".followup-budget > summary").innerText(), /· 1 call ·/);
});

test("t11-2: stopped team turns keep their corrections and progress in message order", { timeout: 120_000 }, async () => {
  const run = await api("/api/runs", { repo, pattern: "solo", task: "AUTO-EVENT Implement part A", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 30, maxMinutes: 5, approvePlan: false } });
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  const main = page.locator(".runview");
  const send = async (text: string) => {
    await main.getByRole("textbox", { name: "Message agent", exact: true }).fill(text);
    await main.getByRole("button", { name: "Send", exact: true }).click();
  };
  const working = async (minimumTurns: number) => {
    await until(() => api(`/api/runs/${run.id}`), value => value.status === "running" && (value.teamTurns?.length ?? 0) >= minimumTurns, "the team's next turn");
    await until(async () => {
      const parent = await api(`/api/runs/${run.id}`);
      return api(`/api/runs/${parent.teamTurns.at(-1).executionId}`);
    }, value => value.team?.tasks.some((task: any) => task.id === "slow" && task.status === "running"), "the slow team assignment");
  };
  await working(1);
  // Mixed stop + work instructions steer the team (cluster14); this case exercises explicit stops.
  await send("Stop the team and wait.");
  await until(() => api(`/api/runs/${run.id}`), value => value.status === "cancelled", "first stop");
  await send("AUTO-EVENT Implement part B");
  await working(2);
  await send("stop");
  await until(() => api(`/api/runs/${run.id}`), value => value.status === "cancelled", "second stop");
  await page.reload();
  await main.getByText("Stop the team and wait.", { exact: true }).waitFor();
  assert.equal(await main.getByRole("region", { name: "Team activity", exact: true }).count(), 2);
  const text = await main.innerText();
  assert.ok(text.indexOf("Stop the team and wait.") < text.indexOf("AUTO-EVENT Implement part B"));
  assert.equal(await main.locator(".team-question-history").count(), 2, "both stop messages remain visible");
});

test("t11-8 / t11-14 / t10-12: revised and stopped teams show neutral, consistent states and valid minute budgets", { timeout: 120_000 }, async () => {
  const run = await api("/api/runs", { repo, pattern: "auto-team", task: "AUTO-USER-QUESTION Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, approvals: { plan: true }, loop: { maxSteps: 20, maxMinutes: 30 } });
  const revise = async (id: string) => {
    await page.goto(`${base}/?token=${token}#/run/${id}`);
    await page.getByRole("button", { name: "✓ Approve", exact: true }).waitFor();
    assert.equal(await page.locator(".team-details > summary").innerText(), "Team activity · Plan ready for approval");
    await page.getByRole("button", { name: "✓ Approve", exact: true }).click();
    await page.getByRole("region", { name: "The team needs your answer" }).waitFor();
    await page.getByRole("textbox", { name: "Message the team", exact: true }).fill("AUTO-USER-QUESTION Change the goal: reject empty input.");
    await page.getByRole("button", { name: "Revise goal", exact: true }).click();
    await page.waitForURL(url => url.hash.startsWith("#/run/") && url.hash !== `#/run/${id}`);
    return page.url().split("#/run/")[1]!;
  };
  const second = await revise(run.id), third = await revise(second);
  await page.goto(`${base}/#/run/${second}`);
  await page.getByText("Goal revised", { exact: false }).first().waitFor();
  assert.equal(await page.locator(".team-details > summary").innerText(), "Team activity · Stopped · goal revised");
  assert.equal(await page.locator(".result .ev.error").count(), 0);
  assert.match(await page.locator(".runview").innerText(), /previous conversation\s*·\s*Continue with the revised goal/);
  assert.equal((await api(`/api/runs/${second}`)).error, undefined);
  await page.goto(`${base}/#/run/${third}`);
  await page.getByRole("button", { name: "✓ Approve", exact: true }).click();
  await page.getByRole("region", { name: "The team needs your answer" }).waitFor();
  await page.getByRole("button", { name: "Stop run", exact: true }).click();
  await page.getByRole("button", { name: "Stop work", exact: true }).click();
  await until(() => api(`/api/runs/${third}`), value => value.status === "cancelled", "stop");
  await page.getByRole("heading", { name: "Stopped by you", exact: true }).waitFor();
  assert.equal(await page.locator(".team-details > summary").innerText(), "Team activity · Stopped");
  const minutes = page.getByLabel("Resume maximum minutes", { exact: true });
  assert.equal(await minutes.evaluate((input: HTMLInputElement) => input.validity.valid), true);
  assert.equal(Number.isInteger(Number(await minutes.inputValue())), true);
  assert.equal(await page.locator(".result .ev.error").count(), 0);
});
