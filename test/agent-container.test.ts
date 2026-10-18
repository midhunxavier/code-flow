import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentContainerCapabilities, agentContainerLaunch, validateAgentContainer } from "../src/agent-container.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "codeflow-container-home-"));
const binaryDirectory = await mkdtemp(join(tmpdir(), "codeflow-container-bin-"));
const records = await mkdtemp(join(tmpdir(), "codeflow-container-records-"));
await chmod(join(root, "test/fake-agent-docker.mjs"), 0o755);
await symlink(join(root, "test/fake-agent-docker.mjs"), join(binaryDirectory, "docker"));
const originalPath = process.env.PATH;
process.env.CODEFLOW_HOME = home;
process.env.FAKE_DOCKER_RECORD_DIR = records;
process.env.PATH = `${binaryDirectory}:${join(root, "test/fake-bin")}:${originalPath}`;
const { codexAdapter } = await import("../src/adapters/codex.js");
const { claudeAdapter } = await import("../src/adapters/claude.js");
const { agyAdapter } = await import("../src/adapters/agy.js");

let repo: string;
let worktree: string;
before(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-container-repo-")));
  worktree = join(await realpath(await mkdtemp(join(tmpdir(), "codeflow-container-worktrees-"))), "task");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "Isolation fixture\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  git("worktree", "add", "-q", "--detach", worktree, "HEAD");
});
after(() => { process.env.PATH = originalPath; });

function mounts(args: string[]) { return args.filter((_arg, index) => args[index - 1] === "--mount"); }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(condition: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) { if (Date.now() > deadline) throw new Error("Timed out waiting for container process"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
async function recorded() {
  return Promise.all((await readdir(records)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(records, name), "utf8")) as { name: string; command: string; cliArgs: string[]; args: string[]; agentPid: number; insideEnvironment: Record<string, string> }));
}

test("agent container mounts only its workspace and verified Git metadata, with mode-specific access", () => {
  const read = agentContainerLaunch("codex", ["app-server"], worktree, "read", { image: "codeflow/agents:local", authVolume: "codeflow-auth", network: false });
  assert.deepEqual(mounts(read.args), [
    `type=bind,source=${worktree},target=${worktree},readonly`,
    `type=bind,source=${join(worktree, ".git")},target=${join(worktree, ".git")},readonly`,
    `type=bind,source=${join(repo, ".git")},target=${join(repo, ".git")},readonly`,
    "type=volume,source=codeflow-auth,target=/home/codeflow",
  ]);
  assert.ok(read.args.includes("--pull=never"));
  assert.ok(read.args.includes("--cap-drop=ALL"));
  assert.ok(read.args.includes("--security-opt=no-new-privileges"));
  assert.deepEqual(read.args.slice(read.args.indexOf("--network"), read.args.indexOf("--network") + 2), ["--network", "none"]);
  assert.deepEqual(read.args.slice(read.args.indexOf("--entrypoint")), ["--entrypoint", "codex", "codeflow/agents:local", "app-server"]);
  const write = agentContainerLaunch("claude", ["-p"], worktree, "write", { image: "codeflow/agents:local" });
  assert.equal(mounts(write.args)[0], `type=bind,source=${worktree},target=${worktree}`);
  assert.ok(!write.args.includes("--network"), "configured inference networking uses Docker's isolated bridge");
});

test("container config cannot inject flags, mount host credential paths, or reinterpret a worktree marker", async () => {
  for (const raw of [ { image: "--privileged" }, { image: "ok", authVolume: "/Users/me/.codex" }, { image: "ok", authVolume: "name,target=/" }, { image: "ok", cpus: Infinity }, { image: "ok", memoryMb: -1 } ]) assert.throws(() => validateAgentContainer(raw));
  assert.throws(() => agentContainerLaunch("/bin/sh", [], worktree, "write", { image: "ok" }), /official agent/);
  const forged = await realpath(await mkdtemp(join(tmpdir(), "codeflow-container-forged-")));
  const admin = (await readFile(join(worktree, ".git"), "utf8")).trim();
  await writeFile(join(forged, ".git"), admin + "\n");
  assert.throws(() => agentContainerLaunch("codex", [], forged, "write", { image: "ok" }), /does not belong/);
  assert.deepEqual(agentContainerCapabilities({ image: "ok" }), { runtime: "docker", image: "ok", network: true, credentialSource: "image", liveTeamTools: false, nativeCodexApprovals: true, hostHomeMounted: false });
});

test("all vendor transports execute in the container and no host environment is forwarded inside", async () => {
  process.env.CODEFLOW_TEST_SECRET = "host-only";
  try {
    for (const adapter of [codexAdapter, claudeAdapter, agyAdapter]) {
      const result = await adapter.run({ prompt: "Look around", cwd: worktree, mode: "read", agentContainer: { image: "prepared/agent:local" } }, () => {});
      assert.ok(result.ok, `${adapter.id}: ${result.error}`);
    }
    process.env.CODEFLOW_CODEX_TRANSPORT = "exec";
    const schema = { type: "object", properties: { verdict: { enum: ["pass", "fail"] } } };
    const result = await codexAdapter.run({ prompt: 'Reply with {"verdict": "pass" | "fail"}', cwd: worktree, mode: "read", jsonSchema: schema, agentContainer: { image: "prepared/agent:local" } }, () => {});
    assert.ok(result.ok, result.error);
    const calls = await recorded();
    assert.ok(calls.some((call) => call.command === "codex" && call.cliArgs[0] === "app-server"));
    assert.ok(calls.some((call) => call.command === "codex" && call.cliArgs[0] === "exec" && mounts(call.args).some((mount) => mount.includes("schema.json") && mount.endsWith(",readonly"))));
    assert.ok(calls.some((call) => call.command === "claude"));
    assert.ok(calls.some((call) => call.command === "agy"));
    for (const call of calls) {
      assert.equal(call.insideEnvironment.HOME, "/home/codeflow");
      assert.equal(call.insideEnvironment.CODEFLOW_TEST_SECRET, undefined);
      assert.equal(call.insideEnvironment.CODEFLOW_TOKEN, undefined);
      assert.equal(call.insideEnvironment.OPENAI_API_KEY, undefined);
      assert.ok(!mounts(call.args).some((mount) => mount.includes(process.env.HOME + "/.codex")));
    }
  } finally { delete process.env.CODEFLOW_TEST_SECRET; delete process.env.CODEFLOW_CODEX_TRANSPORT; }
});

test("cancellation stops daemon-owned containers, not only the Docker client", async () => {
  const controller = new AbortController();
  let steerable = false;
  process.env.FAKE_SLEEP_VENDOR = "codex";
  process.env.FAKE_SLEEP_MS = "20000";
  try {
    const running = codexAdapter.run({ prompt: "Take your time", cwd: worktree, mode: "read", signal: controller.signal, agentContainer: { image: "prepared/agent:local" }, onSteerable: (steer) => { steerable ||= !!steer; } }, () => {});
    await until(() => steerable);
    const call = (await recorded()).find((entry) => alive(entry.agentPid))!;
    assert.ok(call);
    controller.abort();
    assert.equal((await running).errorKind, "cancelled");
    await until(() => !alive(call.agentPid));
    await until(async () => (await readFile(join(records, "removed.jsonl"), "utf8")).includes(call.name));
  } finally { delete process.env.FAKE_SLEEP_VENDOR; delete process.env.FAKE_SLEEP_MS; }
});

test("hard timeouts also remove the daemon-owned container", async () => {
  process.env.FAKE_SLEEP_VENDOR = "codex";
  process.env.FAKE_SLEEP_MS = "20000";
  try {
    let pid: number | undefined;
    const result = await codexAdapter.run({ prompt: "Take your time", cwd: worktree, mode: "read", timeoutMs: 700, agentContainer: { image: "prepared/agent:local" }, onSteerable: (steer) => { if (steer) void recorded().then((calls) => { pid = calls.find((entry) => alive(entry.agentPid))?.agentPid; }); } }, () => {});
    assert.equal(result.errorKind, "timeout", result.error);
    assert.ok(pid);
    await until(() => !alive(pid!));
  } finally { delete process.env.FAKE_SLEEP_VENDOR; delete process.env.FAKE_SLEEP_MS; }
});

test("restart recovery removes an orphan container even after the server is killed without cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-container-restart-"));
  const orphanRecords = join(directory, "records");
  const orphanHome = join(directory, "home");
  const module = new URL("../src/adapters/process.ts", import.meta.url).href;
  const script = `import {startJsonlProcess} from ${JSON.stringify(module)}; const running=startJsonlProcess({command:"codex",args:["app-server"],cwd:${JSON.stringify(worktree)},interactive:true,agentContainer:{config:{image:"prepared/agent:local"},mode:"read"},timeoutMs:30000,onJson:()=>{}});setTimeout(()=>console.log("READY"),400);await running.outcome;`;
  const environment = { ...process.env, CODEFLOW_HOME: orphanHome, FAKE_DOCKER_RECORD_DIR: orphanRecords };
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root, env: environment, stdio: "pipe" });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Orphan fixture did not start")), 5_000);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("READY")) { clearTimeout(timer); resolve(); } });
    child.once("error", reject);
  });
  const calls = await readdir(orphanRecords);
  const record = JSON.parse(await readFile(join(orphanRecords, calls.find((name) => name.endsWith(".json"))!), "utf8"));
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal(alive(record.agentPid), true, "daemon-side process outlives the crashed server");
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {reapOrphanGroups} from ${JSON.stringify(module)};console.log(await reapOrphanGroups());`], { cwd: root, env: environment, timeout: 15_000, encoding: "utf8" });
  assert.match(output.trim(), /^[01]$/, "removing the daemon container may also let the client exit before its process group is reaped");
  await until(() => !alive(record.agentPid));
  assert.match(await readFile(join(orphanRecords, "removed.jsonl"), "utf8"), new RegExp(record.name));
});
