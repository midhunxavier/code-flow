import { tmpdir } from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = mkdtempSync(join(realpathSync(tmpdir()), "codeflow-alias-replay-"));
const home = join(fixture, "home"), repo = join(fixture, "repo"), bin = join(fixture, "bin");
const evidence = join(root, "output/playwright/qa-team-model-alias");
const ports = await reserveQaPorts(2), base = `http://127.0.0.1:${ports.port}`;
const token = "saved-plan-replay", headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
let server: ChildProcess | undefined, browser: Browser | undefined, logs = "";
const errors: string[] = [];
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60000;
  for (;;) { const value = await read(); if (ready(value)) return value; assert.ok(Date.now() < deadline, JSON.stringify(value).slice(0, 3000)); await new Promise(resolve => setTimeout(resolve, 100)); }
}
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server!.once("exit", resolve)); server.kill("SIGTERM"); await exited; }
  await ports.release();
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "server.log"), logs); writeFileSync(join(evidence, "browser.json"), JSON.stringify(errors, null, 2));
  rmSync(fixture, { recursive: true, force: true });
});

test("the saved real Haiku plan is accepted through the app and dispatches its canonical worker", async () => {
  for (const path of [home, repo, bin, evidence, join(fixture, "os-home")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(fixture, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-qb", "main");
  writeFileSync(join(repo, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  writeFileSync(join(repo, "sum.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; import {sum} from "./sum.mjs"; test("sum",()=>assert.equal(sum(2,3),5));\n');
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":false}');
  git("add", "."); git("commit", "-qm", "fixture");
  const planPath = join(root, "test/fixtures/qa-real-haiku-plan.json");
  for (const file of ["fake-agent.mjs", "fake-team-tools.mjs"]) copyFileSync(join(root, "test", file), join(fixture, file));
  // Replay the unmodified captured plan. Hold the fake worker after dispatch so
  // the test can inspect its identity without claiming real model execution.
  const work = readFileSync(join(root, "test/fake-work.mjs"), "utf8")
    .replace('if (prompt.includes("You are the code-flow documentation assistant.")) {', `if (prompt.includes("AUTO_TEAM_PLAN")) { answer = readFileSync(${JSON.stringify(planPath)}, "utf8"); } else if (prompt.includes("You are the code-flow documentation assistant.")) {`)
    .replace('} else if (prompt.includes("AUTO_TEAM_TASK")) {', '} else if (prompt.includes("AUTO_TEAM_TASK")) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);');
  writeFileSync(join(fixture, "fake-work.mjs"), work);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec node '${join(fixture, "fake-agent.mjs")}' claude "$@"\n`, { mode: 0o755 });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  await ports.release();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root, env: { ...inherited, HOME: join(fixture, "os-home"), SHELL: join(fixture, "bash"), BASH_ENV: "", ENV: "", CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(ports.port), CODEFLOW_REMOTE_PORT: String(ports.port + 1), PATH: `${bin}:${join(root, "test/fake-bin")}:${process.env.PATH}`, FAKE_DISCOVERY_MODELS: JSON.stringify([{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", supportsEffort: true, supportedEffortLevels: ["low", "medium"] }]) }, stdio: "pipe",
  });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", data => logs += data);
  await until(() => fetch(base + "/api/health", { headers }).then(response => response.ok, () => false), Boolean);
  const project = (await api("/api/projects", { name: "Saved Haiku plan", repos: [repo] })).id;
  await api("/api/models");
  const made = await api("/api/runs", { project, repo, pattern: "solo", task: "Replay the captured Haiku plan for the synthetic sum fixture", roles: { agent: ["claude"] }, trust: "standard", agentSettings: { claude: { model: "haiku", effort: "low" } }, loop: { check: "node --test sum.test.mjs", prove: false, maxSteps: 6, maxMinutes: 3 }, taskTeam: { enabled: true, preset: "build-review", coordinator: "claude", providers: ["claude"], settings: { claude: { model: "haiku", effort: "low" } }, maxMembers: 3, maxCalls: 6, maxMinutes: 3, approvePlan: false } });
  const parent = await until(() => api(`/api/runs/${made.id}`), run => !!run.teamTurns?.length);
  const id = parent.teamTurns[0].executionId;
  const execution = await until(() => api(`/api/runs/${id}`), run => run.team?.tasks?.some((task: any) => task.status === "running") || run.status !== "running");
  writeFileSync(join(evidence, "execution.json"), JSON.stringify(execution, null, 2));
  assert.equal(execution.status, "running", execution.error);
  assert.equal(execution.team.metrics.coordinatorInvocations, 1);
  assert.equal(execution.team.members.find((member: any) => member.id === "worker").model, "claude-haiku-5-5");
  assert.equal(execution.team.tasks[0].id, "add");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${base}/?token=${token}#/run/${made.id}`);
  await page.getByRole("region", { name: "Team activity" }).waitFor();
  await page.screenshot({ path: join(evidence, "saved-plan-worker-dispatch.png"), fullPage: true });
  await api(`/api/runs/${made.id}/cancel`, {});
  await until(() => api(`/api/runs/${made.id}`), run => run.status !== "running");
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/);
});
