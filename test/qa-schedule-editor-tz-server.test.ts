// QA regressions for the automation schedule API on a real server (TZ=Europe/Stockholm, fake
// agents): stale edits get 409, previews name the zone a time runs in, interval and zone rules,
// and a time missed while code-flow was closed shows in the event history. Never 4317/4318.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "qa-schedule-server";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
let directory: string, home: string, repo: string, base: string, child: ChildProcess | undefined;

const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); });
    if (port !== 4317 && port !== 4318) return port;
  }
};
async function start() {
  const port = await freePort(), remote = await freePort(); base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, TZ: "Europe/Stockholm", PORT: String(port), CODEFLOW_REMOTE_PORT: String(remote), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  child = server;
  let output = ""; server.stdout?.on("data", (chunk) => { output += String(chunk); }); server.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) return;
    if (server.exitCode !== null) throw new Error(`server exited: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${output}`);
}
async function stop() {
  const server = child; if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolve) => { const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000); server.once("exit", () => { clearTimeout(timer); resolve(); }); server.kill("SIGTERM"); });
}
async function call(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
const run = () => ({ repo, pattern: "solo", task: "Schedule QA task", roles: { agent: ["claude"] }, loop: { check: "true", maxMinutes: 1, maxSteps: 4 } });

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-schedule-server-"))); home = join(directory, "home"); repo = join(directory, "repo"); await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Schedule QA fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  await start();
});
after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });

test("a schedule saved from a stale window is refused with 409 and the newer one is kept", { timeout: 30_000 }, async () => {
  const created = await call("/api/automations", { name: "Two windows", enabled: false, run: run(), schedule: { at: "03:00", timezone: "Europe/Stockholm" } });
  assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.revision, 1);
  const id = created.body.id;
  const first = await call(`/api/automations/${id}`, { schedule: { at: "04:00", timezone: "Europe/Stockholm" }, revision: 1 });
  assert.equal(first.status, 200); assert.equal(first.body.revision, 2);
  const stale = await call(`/api/automations/${id}`, { schedule: { at: "03:00", timezone: "UTC" }, revision: 1 });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed in another window/);
  const [kept] = (await call("/api/automations")).body.filter((a: { id: string }) => a.id === id);
  assert.deepEqual(kept.schedule, { at: "04:00", timezone: "Europe/Stockholm" }); assert.equal(kept.revision, 2);
  assert.equal((await call(`/api/automations/${id}`, { schedule: { at: "05:00" }, revision: "2" })).status, 400);
  assert.equal((await call(`/api/automations/${id}`, { enabled: true })).body.revision, 3, "a change without a revision still applies");
});

test("previews say which zone a time of day runs in; one saved without a zone keeps server local time", { timeout: 30_000 }, async () => {
  const local = await call("/api/automations/schedule-preview", { schedule: { at: "08:00" }, after: Date.parse("2026-10-25T12:00:00Z"), count: 2 });
  assert.equal(local.status, 200); assert.equal(local.body.timezone, "Europe/Stockholm");
  assert.deepEqual(local.body.times, [Date.parse("2026-10-26T07:00:00Z"), Date.parse("2026-10-27T07:00:00Z")]);
  assert.equal((await call("/api/automations/schedule-preview", { schedule: { at: "08:00", timezone: "utc" }, count: 1 })).body.timezone, "UTC");
  assert.equal((await call("/api/automations/schedule-preview", { schedule: { every: 60 }, count: 1 })).body.timezone, undefined);
  const created = await call("/api/automations", { name: "Server local", enabled: true, run: run(), schedule: { at: "08:00" } });
  assert.deepEqual(created.body.schedule, { at: "08:00" }); assert.match(created.body.scheduleText, /server local time/);
});

test("interval and zone rules: no clamping, no ambiguous schedules, current zone names", { timeout: 30_000 }, async () => {
  const preview = (schedule: unknown) => call("/api/automations/schedule-preview", { schedule, count: 1 });
  for (const [schedule, message] of [[{ every: 3 }, /at least 5 minutes apart/], [{ every: 20_000 }, /at most 10080 minutes/], [{ every: "x" }, /whole number/], [{ every: 10, at: "07:00" }, /not both/], [{ at: "07:00", timezone: "Mars/Olympus" }, /IANA/]] as const) {
    const response = await preview(schedule);
    assert.equal(response.status, 400, JSON.stringify(schedule)); assert.match(response.body.error, message);
  }
  const created = await call("/api/automations", { name: "Kolkata", enabled: false, run: run(), schedule: { at: "07:00", timezone: "asia/kolkata" } });
  assert.equal(created.body.schedule.timezone, "Asia/Kolkata"); assert.match(created.body.scheduleText, /\(Asia\/Kolkata\)/);
  assert.equal((await call("/api/automations", { name: "Too long", enabled: false, run: run(), schedule: { every: 20_000 } })).status, 400);
});

test("a time missed while code-flow was closed shows in the automation's event history", { timeout: 60_000 }, async () => {
  const created = await call("/api/automations", { name: "Closed overnight", enabled: true, run: run(), schedule: { at: "03:00", timezone: "Europe/Stockholm" } });
  await stop();
  const file = join(home, "triggers.json");
  const triggers = JSON.parse(await readFile(file, "utf8"));
  triggers.find((t: { id: string }) => t.id === created.body.id).nextAt = Date.now() - 2 * 3_600_000;
  await writeFile(file, JSON.stringify(triggers));
  await start();
  const events = (await call(`/api/automations/${created.body.id}/events`)).body;
  assert.equal(events.length, 1); assert.equal(events[0].via, "schedule"); assert.equal(events[0].state, "skipped");
  assert.match(events[0].reason, /code-flow was closed or the computer asleep/);
  const [moved] = (await call("/api/automations")).body.filter((a: { id: string }) => a.id === created.body.id);
  assert.ok(moved.nextAt > Date.now(), "the schedule moved on to its next time");
});
