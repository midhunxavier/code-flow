// Run logs survive failed writes, and the one-server lock can't be held by a stranger's pid or
// taken by two servers at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const home = mkdtempSync(join(tmpdir(), "codeflow-store-home-"));
process.env.CODEFLOW_HOME = home;

const { appendLine, flushWrites, readJsonLines, acquireLock, writeHealth, RUNS_DIR } = await import("../src/store.js");

const lockFile = join(home, "server.lock");
const bootTime = () => Date.now() - uptime() * 1000;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A live process that isn't a code-flow server: a stand-in for a reused pid. */
function stranger(t: { after: (fn: () => void) => void }): ChildProcess {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = child.pid!;
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  while (alive(pid)) await new Promise((r) => setTimeout(r, 10));
  return pid;
}

test("a failed write doesn't glue the next line to the fragment it left", { skip: process.getuid?.() === 0 && "root ignores file permissions" }, async () => {
  const file = "failed-write.jsonl";
  const path = join(RUNS_DIR, file);
  appendLine(file, { a: 1 });
  await flushWrites();
  // What a write cut short by a full disk leaves behind, and a write that then fails.
  appendFileSync(path, '{"b":');
  chmodSync(path, 0o444);
  const failures = writeHealth.failures;
  appendLine(file, { b: 2 });
  await flushWrites();
  assert.equal(writeHealth.failures, failures + 1);
  chmodSync(path, 0o644);
  appendLine(file, { c: 3 });
  await flushWrites();
  const stats = { skipped: 0 };
  assert.deepEqual(await readJsonLines(file, stats), [{ a: 1 }, { c: 3 }]);
  assert.equal(stats.skipped, 1, "the fragment is counted, not silently dropped");
});

test("synced lines and flushed lines are on disk in order", async () => {
  const file = "synced.jsonl";
  appendLine(file, { n: 1 });
  appendLine(file, { n: 2 }, { sync: true });
  appendLine(file, { n: 3 });
  await flushWrites();
  assert.deepEqual(await readJsonLines(file), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  const stats = { skipped: 0 };
  await readJsonLines(file, stats);
  assert.equal(stats.skipped, 0);
});

test("a live pid that isn't the server that wrote the lock doesn't hold it", async (t) => {
  const other = stranger(t);
  writeFileSync(lockFile, JSON.stringify({ pid: other.pid, started: Date.now() - 3_600_000, boot: Math.round(bootTime()) }));
  const release = await acquireLock(300);
  assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).pid, process.pid);
  release();
  assert.ok(!existsSync(lockFile));
});

test("a lock written before this boot is stale, even if its pid is alive now", async (t) => {
  const other = stranger(t);
  // No start time to compare (a platform without ps): the boot time decides.
  writeFileSync(lockFile, JSON.stringify({ pid: other.pid, boot: Math.round(bootTime()) - 86_400_000 }));
  (await acquireLock(300))();

  // An older version's plain pid, last written a day ago (before this boot).
  writeFileSync(lockFile, String(other.pid));
  const dayAgo = new Date(Date.now() - 86_400_000);
  utimesSync(lockFile, dayAgo, dayAgo);
  (await acquireLock(300))();

  // The same plain pid written just now still holds it.
  writeFileSync(lockFile, String(other.pid));
  await assert.rejects(acquireLock(300), /Another code-flow server \(pid \d+\)/);
  other.kill("SIGKILL");
  await new Promise((r) => other.once("exit", r));
  (await acquireLock(300))();
});

test("an empty lock is being written: young it holds, old it's stale", async () => {
  writeFileSync(lockFile, "");
  await assert.rejects(acquireLock(300), /Another code-flow server is using/);
  const old = new Date(Date.now() - 10_000);
  utimesSync(lockFile, old, old);
  const release = await acquireLock(300);
  assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).pid, process.pid);
  release();
});

test("release leaves a lock that another server took over", async () => {
  const release = await acquireLock(300);
  const theirs = JSON.stringify({ pid: 999_999, started: 1 });
  writeFileSync(lockFile, theirs);
  release();
  assert.equal(readFileSync(lockFile, "utf8"), theirs);
});

test("servers starting at once over a stale lock: exactly one wins", async (t) => {
  const raceHome = mkdtempSync(join(tmpdir(), "codeflow-store-race-"));
  writeFileSync(join(raceHome, "server.lock"), JSON.stringify({ pid: await deadPid(), started: Date.now() - 60_000, boot: Math.round(bootTime()) }));
  const script = join(mkdtempSync(join(tmpdir(), "codeflow-store-script-")), "acquire.mjs");
  writeFileSync(
    script,
    `const { acquireLock } = await import(process.env.STORE_URL);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.env.GO_AT) - Date.now())));
try {
  const release = await acquireLock(1_500);
  console.log("won");
  process.stdin.resume();
  process.stdin.on("end", () => { release(); process.exit(0); });
} catch (err) {
  console.log("lost " + err.message);
  process.exit(0);
}
`,
  );
  const root = fileURLToPath(new URL("..", import.meta.url));
  const env = { ...process.env, CODEFLOW_HOME: raceHome, STORE_URL: pathToFileURL(fileURLToPath(new URL("../src/store.ts", import.meta.url))).href, GO_AT: String(Date.now() + 2_500) };
  const children = [...Array(4)].map(() => spawn(process.execPath, ["--import", "tsx", script], { cwd: root, env, stdio: ["pipe", "pipe", "inherit"] }));
  t.after(() => children.forEach((c) => c.kill("SIGKILL")));
  const results = await Promise.all(
    children.map(
      (child) =>
        new Promise<string>((resolve) => {
          let out = "";
          child.stdout!.on("data", (d) => {
            out += d;
            if (out.includes("\n")) resolve(out.trim());
          });
          child.once("exit", () => resolve(out.trim()));
        }),
    ),
  );
  assert.equal(results.filter((r) => r === "won").length, 1, results.join("\n"));
  for (const r of results.filter((r) => r !== "won")) assert.match(r, /^lost Another code-flow server \(pid \d+\)/);
  const winner = children[results.indexOf("won")]!;
  assert.equal(JSON.parse(readFileSync(join(raceHome, "server.lock"), "utf8")).pid, winner.pid);
  winner.stdin!.end();
  await new Promise((r) => winner.once("exit", r));
  assert.deepEqual(readdirSync(raceHome).filter((f) => f.startsWith("server.lock")), [], "no lock, temp file or takeover link left behind");
});
