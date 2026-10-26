// POST /api/cleanup over HTTP: olderThanDays and the scope are validated (a bad value is a 400,
// never "every finished run"), repo is read the way GET /api/disk reads it, and the answer says
// what was archived and what was kept and why. A real server on a free port with the fake
// agents; never ports 4317/4318.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "qa-cleanup-api-token";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let base: string, home: string, alias: string, repo: string, server: ChildProcess;

const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    if (port !== 4317 && port !== 4318) return port;
  }
};
const call = async (path: string, body?: unknown) => {
  const res = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: res.status, json: await res.json().catch(() => undefined) as any };
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

before(async () => {
  // On macOS the temp folder is reached through a symbolic link: `alias` is that spelling,
  // `repo` the real one git (and every run) uses.
  alias = mkdtempSync(join(tmpdir(), "codeflow-qa-cleanup-api-"));
  repo = realpathSync(alias);
  sh(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "README.md"), "Fixture\n");
  writeFileSync(join(repo, "sub", "file.txt"), "In a subfolder\n");
  sh(repo, "add", ".");
  sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  if (!existsSync(join(root, "public/index.html"))) execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "codeflow-qa-cleanup-api-home-"));
  server = spawn(join(root, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(await freePort()), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` },
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    if (await fetch(`${base}/api/health`, { headers }).then((r) => r.ok, () => false)) break;
    if (i > 150) throw new Error("server didn't start");
    await new Promise((r) => setTimeout(r, 200));
  }
});
after(() => {
  server?.kill("SIGTERM");
});

async function finishedRun(task: string) {
  const started = await call("/api/runs", { repo, pattern: "solo", task, roles: { agent: ["claude"] }, options: {} });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const id = started.json.id as string;
  for (let i = 0; i < 200; i++) {
    const run = (await call(`/api/runs/${id}`)).json;
    if (run.status !== "running" && run.endedAt) {
      assert.equal(run.status, "done", run.error);
      assert.equal((await call(`/api/runs/${id}/seen`, {})).status, 200);
      return (await call(`/api/runs/${id}`)).json;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${task} didn't finish`);
}

test("bad olderThanDays, repo or project is a 400 that changes nothing; repo is read as GET /api/disk reads it; kept runs say why", { timeout: 60_000 }, async () => {
  const dirty = await finishedRun("Chat that keeps its notes");
  const clean = await finishedRun("Chat with nothing left over");
  const dirtyTree = dirty.worktrees[0].path as string, cleanTree = clean.worktrees[0].path as string;
  writeFileSync(join(dirtyTree, "notes.txt"), "Only here\n");
  sh(cleanTree, "clean", "-fdq"); // whatever the fake agent left: this worktree is exactly its branch

  for (const body of [{ olderThanDays: "abc" }, { olderThanDays: "x7" }, { olderThanDays: "" }, { olderThanDays: "7" }, { olderThanDays: -1 }, { olderThanDays: {} }, { olderThanDays: [] }, { olderThanDays: 0, project: 5 }, { olderThanDays: 0, repo: 5 }, { olderThanDays: 0, repo: "not-a-path" }]) {
    const res = await call("/api/cleanup", body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(res.json)}`);
  }
  assert.match((await call("/api/cleanup", { olderThanDays: "abc" })).json.error, /olderThanDays must be a number of days/);
  for (const run of [dirty, clean]) {
    assert.equal((await call(`/api/runs/${run.id}`)).json.archived, false, "a rejected request archives nothing");
    assert.ok(existsSync(run.worktrees[0].path), "and removes nothing");
  }
  assert.deepEqual((await call("/api/cleanup", { olderThanDays: 7 })).json, { runs: 0, worktrees: 0, archived: 0, folders: 0, kept: [] });

  // A subfolder, the symlinked spelling and a trailing slash all name the repository.
  const scope = `${alias}/sub/`;
  const disk = await call(`/api/disk?repo=${encodeURIComponent(scope)}`);
  assert.deepEqual(disk.json.runs.map((r: { id: string }) => r.id).sort(), [dirty.id, clean.id].sort());
  const result = await call("/api/cleanup", { olderThanDays: 0, repo: scope });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.runs, 1);
  assert.equal(result.json.worktrees, 1);
  assert.equal(result.json.archived, 1);
  assert.deepEqual(result.json.kept.map((k: { id: string }) => k.id), [dirty.id]);
  assert.match(result.json.kept[0].reason, /uncommitted changes/);

  assert.equal((await call(`/api/runs/${dirty.id}`)).json.archived, false);
  assert.equal(readFileSync(join(dirtyTree, "notes.txt"), "utf8"), "Only here\n");
  assert.equal((await call(`/api/runs/${clean.id}`)).json.archived, true);
  assert.ok(!existsSync(cleanTree));
  assert.ok(sh(repo, "branch", "--list", clean.worktrees[0].branch), "the branch is kept");
  let log = "";
  for (let i = 0; i < 50 && !/archived the run/.test(log); i++) {
    log = readFileSync(join(home, "runs", `${clean.id}.jsonl`), "utf8");
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(log, /Cleaned up: removed 1 worktree\(s\) and archived the run; branches kept/);
});

test("Clean up loads no archived run it has nothing to do for (GET /api/health storage), and keeps commits only a detached HEAD holds", { timeout: 90_000 }, async () => {
  const archived = [await finishedRun("Archived long ago, one"), await finishedRun("Archived long ago, two")];
  for (const run of archived) assert.equal((await call(`/api/runs/${run.id}/archive`, { cleanup: true })).status, 200);
  const detached = await finishedRun("Work committed on a detached HEAD");
  const tree = detached.worktrees[0].path as string;
  sh(tree, "clean", "-fdq");
  sh(tree, "checkout", "-q", "--detach");
  writeFileSync(join(tree, "detached-work.txt"), "On no branch\n");
  sh(tree, "add", "detached-work.txt");
  sh(tree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "detached work");
  const head = sh(tree, "rev-parse", "HEAD");

  // Archived runs go to disk a moment after they're archived: wait until nothing more moves.
  const storage = async () => (await call("/api/health")).json.storage as { hot: number; pending: number; cold: { records: number } };
  const steady = async () => {
    let last = "";
    for (let i = 0; i < 100; i++) {
      const now = await storage();
      const key = JSON.stringify([now.hot, now.cold.records]);
      if (!now.pending && key === last) return now;
      last = key;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("storage didn't settle");
  };
  const before = await steady();
  assert.ok(before.cold.records >= archived.length, JSON.stringify(before));

  for (let i = 0; i < 2; i++) {
    const result = await call("/api/cleanup", { olderThanDays: 0 });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.runs, 0, JSON.stringify(result.json));
    const kept = result.json.kept.find((k: { id: string }) => k.id === detached.id);
    assert.match(kept?.reason ?? "", /commits no branch holds/, JSON.stringify(result.json));
  }
  const after = await steady();
  assert.equal(after.hot, before.hot, `no archived run was loaded into memory: ${JSON.stringify({ before, after })}`);
  assert.equal(after.cold.records, before.cold.records);
  assert.equal((await call(`/api/runs/${detached.id}`)).json.archived, false);
  assert.equal(sh(tree, "rev-parse", "HEAD"), head, "the detached work is where it was");
});
