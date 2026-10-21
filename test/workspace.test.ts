import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-ws-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { readRepoConfig, copyIntoWorktree } = await import("../src/repo-config.js");
const { doctor } = await import("../src/doctor.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString();
const pipelineRoles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;
const manager: Manager = new RunManager(findPattern);

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-ws-repo-"));
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, ".codeflow"));
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, ".gitignore"), ".env\nconfig/*.local.json\n");
  writeFileSync(
    join(repo, ".codeflow", "config.json"),
    JSON.stringify({
      check: "test -f .env",
      setup: "true",
      copy: [".env", "config/*.local.json", "../escape"],
      run: { command: "npm run dev", port: 5173 },
      models: { claude: { model: "opus" } },
      limits: { maxSteps: 25 },
      trust: "safe",
    }),
  );
  writeFileSync(join(repo, "README.md"), "ws\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  // Files git doesn't carry into worktrees:
  writeFileSync(join(repo, ".env"), "SECRET=local\n");
  writeFileSync(join(repo, "config", "db.local.json"), "{}\n");
});

async function runPattern(roles: Record<string, any>, extra: Record<string, unknown> = {}) {
  const run = await manager.start({ pattern: findPattern("pipeline")!, task: "Workspace", repo, roles, options: {}, ...extra });
  await new Promise<void>((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}
const recorded = (dir: string) => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { vendor: string; args: string[]; prompt: string });

test("repo config is read and validated", async () => {
  const { config, found } = await readRepoConfig(repo);
  assert.ok(found);
  assert.deepEqual([config.check, config.trust, config.run?.port, config.limits?.maxSteps], ["test -f .env", "safe", 5173, 25]);
  const broken = mkdtempSync(join(tmpdir(), "codeflow-ws-broken-"));
  mkdirSync(join(broken, ".codeflow"));
  writeFileSync(join(broken, ".codeflow", "config.json"), "{ nope");
  assert.match((await readRepoConfig(broken)).error!, /\.codeflow\/config\.json:/);
});

test("config defaults apply: env files are copied (never committed), check and limits come from config", async () => {
  const run = await runPattern(pipelineRoles);
  assert.equal(run.status, "done", run.error);
  assert.deepEqual([run.loop.check, run.loop.setup, run.loop.maxSteps, run.trust], ["test -f .env", "true", 25, "safe"]);
  assert.deepEqual(run.app, { command: "npm run dev", port: 5173 });
  assert.equal(run.agentSettings.claude?.model, "opus");
  assert.equal(run.verdict, "passed", "the check found the copied .env");
  const wt = run.worktrees[0]!.path;
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "SECRET=local\n");
  assert.ok(existsSync(join(wt, "config", "db.local.json")));
  assert.ok(!git("ls-tree", "-r", "--name-only", run.artifacts[0]!.branch).includes(".env"), ".env is never committed");
  const logs = (await manager.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
  assert.match(logs, /Copied \.env, config\/db\.local\.json from your checkout into build/);
});

test("copy patterns can't escape the repo", async () => {
  const target = mkdtempSync(join(tmpdir(), "codeflow-ws-target-"));
  const { copied } = await copyIntoWorktree(repo, target, ["../etc/passwd", "/etc/hosts", ".env"]);
  assert.deepEqual(copied, [".env"]);
});

test("copy refuses symlinks (a cloned repo's .env → your credentials) and files git would commit", async () => {
  const outside = mkdtempSync(join(tmpdir(), "codeflow-ws-secret-"));
  writeFileSync(join(outside, "credentials"), "aws_secret=1\n");
  symlinkSync(join(outside, "credentials"), join(repo, "linked.local.json"));
  writeFileSync(join(repo, "notes.txt"), "untracked but not ignored\n");
  writeFileSync(join(repo, ".gitignore"), ".env\nconfig/*.local.json\nlinked.local.json\n");
  try {
    const target = mkdtempSync(join(tmpdir(), "codeflow-ws-target-"));
    const { copied, refused } = await copyIntoWorktree(repo, target, ["linked.local.json", "notes.txt", ".env"]);
    assert.deepEqual(copied, [".env"]);
    assert.deepEqual(
      refused.map((r) => [r.path, r.why]),
      [
        ["linked.local.json", "it's a symbolic link"],
        ["notes.txt", "git doesn't ignore it, so it would be committed with the agents' work"],
      ],
    );
    assert.ok(!existsSync(join(target, "linked.local.json")));
  } finally {
    rmSync(join(repo, "linked.local.json"));
    rmSync(join(repo, "notes.txt"));
    writeFileSync(join(repo, ".gitignore"), ".env\nconfig/*.local.json\n");
  }
});

test("explicit settings beat the config", async () => {
  const run = await runPattern(pipelineRoles, { loop: { check: "", maxSteps: 40 }, trust: "standard", agentSettings: { claude: { model: "sonnet" } } });
  assert.equal(run.status, "done", run.error);
  assert.deepEqual([run.loop.check, run.loop.maxSteps, run.trust, run.agentSettings.claude?.model], [undefined, 40, "standard", "sonnet"]);
});

test("permission modes and per-role models reach each CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  try {
    await runPattern(pipelineRoles, {
      trust: "trusted",
      loop: { check: "" },
      agentSettings: { claude: { model: "opus" } },
      roleSettings: { reviewer: { claude: { model: "sonnet", effort: "low" } } },
    });
    const calls = recorded(dir);
    const claudeCalls = calls.filter((c) => c.vendor === "claude");
    const planner = claudeCalls.find((c) => c.args.some(arg => arg.startsWith("Edit,Write,NotebookEdit")) && c.prompt.includes("planner"))!;
    const reviewer = claudeCalls.find((c) => c.prompt.includes("You are the reviewer"))!;
    assert.match(planner.args.join(" "), /--model opus/);
    assert.match(reviewer.args.join(" "), /--model sonnet --effort low/, "the reviewer role overrides the provider default");
    assert.match(calls.find((c) => c.vendor === "codex")!.args.join(" "), /sandbox_workspace_write\.network_access=true/);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  const dir2 = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir2;
  try {
    await runPattern({ planner: ["codex"], builder: ["claude"], reviewer: ["codex"] }, { trust: "safe", loop: { check: "" } });
    const builder = recorded(dir2).find((c) => c.vendor === "claude")!;
    const tools = builder.args[builder.args.indexOf("--allowedTools") + 1]!;
    assert.ok(!tools.includes("Bash(npm"), "safe mode: no build/test commands");
    assert.ok(tools.includes("Read"));
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  const dir3 = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir3;
  try {
    await runPattern({ planner: ["codex"], builder: ["claude"], reviewer: ["codex"] }, { trust: "standard", loop: { check: "" } });
    const builder = recorded(dir3).find((c) => c.vendor === "claude")!;
    const tools = builder.args[builder.args.indexOf("--allowedTools") + 1]!.split(",");
    for (const tool of ["Bash(npm *)", "Bash(pytest *)", "Bash(uv *)", "Bash(poetry *)"]) assert.ok(tools.includes(tool), `standard mode allows ${tool}`);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
});

test("full access: every tool and no sandbox in write steps; read steps stay read-only", async () => {
  // Each agent builds once (write) and plans or reviews once (read).
  const teams = [
    { planner: ["codex"], builder: ["claude"], reviewer: ["codex"] },
    { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] },
  ];
  const calls: (ReturnType<typeof recorded>[number] & { thread?: { sandbox: string }; token?: string | null })[] = [];
  // No sandbox doesn't mean code-flow's own secrets: the agents still get the filtered environment.
  process.env.CODEFLOW_TOKEN = "server-secret";
  for (const roles of teams) {
    const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
    process.env.FAKE_RECORD_DIR = dir;
    try {
      const run = await runPattern(roles, { trust: "full", loop: { check: "" } });
      assert.equal(run.status, "done", run.error);
      assert.equal(run.trust, "full");
      assert.match((await manager.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n"), /Full access: agents can run any command, with no sandbox/);
    } finally {
      delete process.env.FAKE_RECORD_DIR;
    }
    calls.push(...recorded(dir));
  }
  delete process.env.CODEFLOW_TOKEN;
  const write = (c: (typeof calls)[number]) => c.prompt.includes("You are the builder");
  const claudeWrite = calls.find((c) => c.vendor === "claude" && write(c))!;
  assert.match(claudeWrite.args.join(" "), /--permission-mode bypassPermissions/);
  assert.ok(!claudeWrite.args.includes("--allowedTools"), "no tool list: every tool is allowed");
  const claudeRead = calls.find((c) => c.vendor === "claude" && !write(c))!;
  assert.match(claudeRead.args.join(" "), /--disallowedTools Edit,Write,NotebookEdit/);
  assert.equal(calls.find((c) => c.vendor === "codex" && write(c))!.thread?.sandbox, "danger-full-access");
  assert.equal(calls.find((c) => c.vendor === "codex" && !write(c))!.thread?.sandbox, "read-only");
  const started = calls.filter((c) => c.token !== undefined);
  assert.ok(started.some((c) => c.vendor === "claude" && write(c)));
  assert.deepEqual(started.filter((c) => c.token !== null).map((c) => c.vendor), [], "no agent sees CODEFLOW_TOKEN");
});

test("full access is never taken from a repo's config file", async () => {
  const other = mkdtempSync(join(tmpdir(), "codeflow-ws-full-"));
  mkdirSync(join(other, ".codeflow"));
  writeFileSync(join(other, ".codeflow", "config.json"), JSON.stringify({ trust: "full" }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
  execFileSync("git", ["add", "."], { cwd: other });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: other });
  const { config } = await readRepoConfig(other);
  assert.equal(config.trust, undefined);
  const run = await manager.start({ pattern: findPattern("solo")!, task: "Config", repo: other, roles: { agent: ["claude"] }, options: {} });
  assert.equal(run.trust, "standard");
  manager.cancel(run.id);
});

test("full access is capped for runs nobody watches", async () => {
  const run = await manager.start({
    pattern: findPattern("solo")!,
    task: "Nightly",
    repo,
    roles: { agent: ["claude"] },
    options: {},
    trust: "full",
    trigger: { id: "t1", name: "Nightly", via: "schedule" },
  });
  assert.equal(run.trust, "trusted", "automations and sweeps get Trusted at most");
  manager.cancel(run.id);
  const { unattendedTrust } = await import("../src/watch.js");
  assert.equal(unattendedTrust({ trust: "full" }), "standard", "PR-watch fixes get Standard at most");
});

test("quota windows reported by Claude are kept per vendor", async () => {
  await runPattern(pipelineRoles, { loop: { check: "" } });
  assert.equal(manager.quota.claude?.windows.five_hour?.utilization, 0.42);
  assert.equal(manager.quota.claude?.windows.five_hour?.resetsAt, 1792092600_000);
});

test("doctor: installed, version, signed in — and how to fix it", async () => {
  process.env.FAKE_SIGNED_OUT = "codex";
  try {
    const health = await doctor(manager.quota);
    const byId = Object.fromEntries(health.map((h) => [h.id, h]));
    assert.deepEqual([byId.claude!.installed, byId.claude!.version, byId.claude!.signedIn, byId.claude!.account], [true, "2.1.300 (Claude Code)", true, "Claude subscription"]);
    assert.equal(byId.codex!.signedIn, false);
    assert.match(byId.codex!.fix!, /codex login/);
    assert.equal(byId.agy!.signedIn, true, "agy is signed in when it can list models");
    assert.equal(byId.claude!.quota?.windows.five_hour?.utilization, 0.42);
  } finally {
    delete process.env.FAKE_SIGNED_OUT;
  }
});

test("run app: a worktree's dev server on a free port, then stopped", async () => {
  const run = await runPattern(pipelineRoles, { loop: { check: "" } });
  const key = `${run.id}/build`;
  const server = await manager.devServers.start(
    key,
    run.worktrees[0]!.path,
    `node -e "require('http').createServer((q, r) => r.end('hello from ' + process.cwd().split('/').pop())).listen(process.env.PORT)"`,
    5173,
  );
  // 5173 is preferred, but another port when it (and the ones after it) are busy.
  assert.ok(server.port > 0 && server.port < 65_536);
  let body = "";
  for (let i = 0; i < 50 && !body; i++) {
    body = await fetch(server.url).then((r) => r.text(), () => "");
    if (!body) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(body, "hello from build");
  assert.ok(manager.devServers.stop(key));
  // Stopping takes as long as the process group takes to exit: poll, with a generous deadline.
  let state = "up";
  for (const deadline = Date.now() + 10_000; state === "up" && Date.now() < deadline; ) {
    state = await fetch(server.url).then(() => "up", () => "down");
    if (state === "up") await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state, "down");
});
