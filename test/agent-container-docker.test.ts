import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.CODEFLOW_TEST_DOCKER === "1";
const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-docker-native-")));
process.env.CODEFLOW_HOME = join(directory, "home");
const { startJsonlProcess } = await import("../src/adapters/process.js");
const image = `codeflow-agent-fixture:${Date.now().toString(36)}`;
let worktree: string;
let built = false;

before(async () => {
  if (!enabled) return;
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000, stdio: "pipe" });
  const repo = join(directory, "repo");
  worktree = join(directory, "worktree");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "Native containment fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  execFileSync("git", ["worktree", "add", "-q", "--detach", worktree, "HEAD"], { cwd: repo });
  await writeFile(join(directory, "outside-secret"), "EXTERNAL_TEST_SECRET\n");
  await symlink(join(directory, "outside-secret"), join(worktree, "escape"));
  await writeFile(join(directory, "Dockerfile"), "FROM busybox:1.37\nRUN mkdir -p /home/codeflow && chmod 1777 /home/codeflow\nCOPY codex /usr/local/bin/codex\nRUN chmod 755 /usr/local/bin/codex\n");
  await writeFile(join(directory, "codex"), `#!/bin/sh
if [ "$1" = "linger" ]; then
  printf '{"type":"started"}\\n'
  sleep 60
  exit 0
fi
write_allowed=false
if touch created 2>/dev/null; then write_allowed=true; fi
git_writable=false
if printf hacked 2>/dev/null >.git; then git_writable=true; fi
admin="$(sed 's/^gitdir: //' .git)"
metadata_writable=false
if touch "$admin/codeflow-native-probe" 2>/dev/null; then metadata_writable=true; fi
outside_visible=false
if cat escape >/dev/null 2>&1; then outside_visible=true; fi
host_secret=false
if [ -n "$CODEFLOW_TEST_SECRET" ]; then host_secret=true; fi
printf '{"type":"probe","writeAllowed":%s,"gitWritable":%s,"metadataWritable":%s,"outsideVisible":%s,"hostSecret":%s}\\n' "$write_allowed" "$git_writable" "$metadata_writable" "$outside_visible" "$host_secret"
`);
  execFileSync("docker", ["build", "--quiet", "--tag", image, directory], { timeout: 120_000, stdio: "pipe" });
  built = true;
});

after(async () => {
  if (built) { try { execFileSync("docker", ["image", "rm", "--force", image], { timeout: 15_000, stdio: "pipe" }); } catch {} }
  delete process.env.CODEFLOW_TEST_SECRET;
  await rm(directory, { recursive: true, force: true });
});

test("real Docker enforces read/write mounts and excludes host secrets and Git writes", { skip: !enabled, timeout: 30_000 }, async () => {
  process.env.CODEFLOW_TEST_SECRET = "HOST_FIXTURE_SECRET";
  for (const mode of ["read", "write"] as const) {
    const messages: any[] = [];
    const process = startJsonlProcess({ command: "codex", args: ["probe"], cwd: worktree, agentContainer: { config: { image, network: false, memoryMb: 128, cpus: 0.5 }, mode }, timeoutMs: 10_000, onJson: (message) => messages.push(message) });
    const outcome = await process.outcome;
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.deepEqual(messages, [{ type: "probe", writeAllowed: mode === "write", gitWritable: false, metadataWritable: false, outsideVisible: false, hostSecret: false }]);
  }
});

async function activeContainerName(): Promise<string> {
  const snapshot = JSON.parse(await readFile(join(directory, "home", "processes.json"), "utf8"));
  return snapshot.groups.filter((group: { containerName?: string }) => group.containerName)
    .sort((a: { startedAt: number }, b: { startedAt: number }) => b.startedAt - a.startedAt)[0]?.containerName;
}
function exists(name: string) {
  try { execFileSync("docker", ["container", "inspect", name], { timeout: 10_000, stdio: "pipe" }); return true; }
  catch { return false; }
}

test("real Docker cancellation removes the underlying daemon container before returning", { skip: !enabled, timeout: 30_000 }, async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const process = startJsonlProcess({ command: "codex", args: ["linger"], cwd: worktree, agentContainer: { config: { image, network: false, memoryMb: 128 }, mode: "read" }, signal: controller.signal, timeoutMs: 10_000, onJson: () => started() });
  await ready;
  const name = await activeContainerName();
  assert.ok(name);
  try { assert.equal(exists(name), true); }
  finally { controller.abort(); }
  assert.equal((await process.outcome).aborted, true);
  assert.equal(exists(name), false);
});

test("real Docker hard timeout also removes the daemon container", { skip: !enabled, timeout: 30_000 }, async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const process = startJsonlProcess({ command: "codex", args: ["linger"], cwd: worktree, agentContainer: { config: { image, network: false, memoryMb: 128 }, mode: "read" }, timeoutMs: 2_000, onJson: () => started() });
  await ready;
  const name = await activeContainerName();
  assert.equal((await process.outcome).timedOut, true);
  assert.equal(exists(name), false);
});
