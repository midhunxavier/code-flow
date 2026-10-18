import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilteredTasks, dockerFilteredRuntime } from "../src/filtered-tasks.js";
import { ProjectFilePolicies } from "../src/filesystem-policy.js";

const enabled = process.env.CODEFLOW_TEST_DOCKER === "1", home = await realpath(await mkdtemp(join(tmpdir(), "codeflow-filtered-native-"))), repo = join(home, "repo"), image = `codeflow-filtered-fixture:${Date.now().toString(36)}`;
const shell = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); let built = false, service: FilteredTasks;
before(async () => {
  if (!enabled) return;
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 }); await mkdir(join(repo, "src"), { recursive: true }); await mkdir(join(repo, "private")); await writeFile(join(repo, "src/allowed.txt"), "original allowed\n"); await writeFile(join(repo, "reference.txt"), "readable but immutable\n"); await writeFile(join(repo, "private/secret.txt"), "DENIED_DOCKER_SENTINEL\n"); git("init", "-q", "-b", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "source"); const deniedBlob = git("rev-parse", "HEAD:private/secret.txt"), originalCommit = git("rev-parse", "HEAD");
  await writeFile(join(home, "Dockerfile"), "FROM busybox:1.37\nRUN mkdir -p /home/codeflow /opt/provider /opt/codeflow-credential-seed && chmod 1777 /home/codeflow\nCOPY claude /opt/provider/claude\nCOPY launcher /usr/local/bin/claude\nCOPY fixture-auth.json /opt/codeflow-credential-seed/auth.json\nRUN chmod 755 /opt/provider/claude /usr/local/bin/claude\n");
  await writeFile(join(home, "fixture-auth.json"), '{"fixture_auth":"NO_REAL_CREDENTIALS"}\n');
  await writeFile(join(home, "launcher"), '#!/bin/sh\nset -eu\numask 077\nmkdir -p "$HOME/.claude"\ncp /opt/codeflow-credential-seed/auth.json "$HOME/.claude/auth.json"\nexec /opt/provider/claude "$@"\n');
  await writeFile(join(home, "claude"), `#!/bin/sh
set -eu
test -f "$HOME/.claude/auth.json"
grep -q NO_REAL_CREDENTIALS "$HOME/.claude/auth.json"
printf disposable >"$HOME/temporary-session"
prompt="$(cat)"
case "$prompt" in *linger*) printf '{"type":"system","subtype":"init","session_id":"filtered-fixture"}\\n'; sleep 60;; esac
test ! -e ${shell(join(repo, "private/secret.txt"))}
test ! -e ${shell(join(repo, ".git"))}
test ! -e private/secret.txt
test ! -e .git/objects/${deniedBlob.slice(0, 2)}/${deniedBlob.slice(2)}
test ! -e .git/objects/${originalCommit.slice(0, 2)}/${originalCommit.slice(2)}
test ! -e .git/objects/info/alternates
! grep -q 'remote "' .git/config
if printf hacked 2>/dev/null >.git/config; then exit 31; fi
if printf hacked 2>/dev/null >reference.txt; then exit 32; fi
if touch /var/tmp/filtered-write 2>/dev/null; then exit 33; fi
if env | grep -q '^CODEFLOW_TOKEN='; then exit 34; fi
printf 'filtered allowed edit\\n' >src/allowed.txt
printf '{"type":"result","subtype":"success","is_error":false,"result":"namespace and readonly mounts verified"}\\n'
`);
  execFileSync("docker", ["build", "--quiet", "--tag", image, home], { timeout: 120_000, stdio: "pipe" }); built = true;
  const store = new ProjectFilePolicies(home); await store.set("project", { revision: 0, read: { allow: ["src", "reference.txt"], deny: [] }, write: { allow: ["src"], deny: [] } }); service = new FilteredTasks({ home, authorize: async (project, selected) => { assert.equal(project, "project"); assert.equal(selected, repo); return [await store.get("project")]; }, withRepository: async (_repo, operation) => operation() }); await service.load();
});
after(async () => { await service?.close(); if (built) { try { execFileSync("docker", ["image", "rm", "--force", image], { timeout: 15_000, stdio: "pipe" }); } catch {} } await rm(home, { recursive: true, force: true }); });
async function settled(id: string) { for (let attempt = 0; attempt < 300; attempt++) { const job = service.get(id); if (job.status !== "running") return job; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Native filtered task did not settle"); }
test("real filtered Docker excludes denied blobs/original metadata, enforces readonly mounts and imports only allowed edits into a new branch", { skip: !enabled, timeout: 45_000 }, async () => {
  const original = git("rev-parse", "HEAD"), index = git("ls-files", "--stage"); const started = await service.create({ project: "project", repo, task: "Exercise actual namespace containment", agent: "claude", image, network: false }); const done = await settled(started.id); assert.equal(done.status, "completed", done.error); assert.equal(done.containerStopped, true); assert.match(done.imageId!, /^sha256:[a-f0-9]{64}$/); assert.match(done.finalText!, /namespace and readonly mounts verified/);
  const preview = await service.preview(done.id); assert.deepEqual(preview.changes.map((change) => change.path), ["src/allowed.txt"]); const imported = await service.import(done.id, { revision: done.revision, expectedHead: done.sourceHead, resultHash: done.resultHash }); assert.equal(imported.status, "imported"); assert.equal(git("rev-parse", "HEAD"), original); assert.equal(git("ls-files", "--stage"), index); assert.equal(await readFile(join(repo, "src/allowed.txt"), "utf8"), "original allowed\n"); assert.equal(git("show", `${imported.importBranch}:src/allowed.txt`), "filtered allowed edit"); assert.equal(git("show", `${imported.importBranch}:private/secret.txt`), "DENIED_DOCKER_SENTINEL");
});
test("real filtered cancellation confirms daemon removal before its terminal receipt", { skip: !enabled, timeout: 45_000 }, async () => {
  const started = await service.create({ project: "project", repo, task: "linger until explicitly cancelled", agent: "claude", image, network: false }); let containers = ""; for (let attempt = 0; attempt < 100; attempt++) { containers = execFileSync("docker", ["ps", "-q", "--filter", `label=codeflow.filtered-task=${started.id}`], { encoding: "utf8", timeout: 5000 }).trim(); if (containers) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.ok(containers, "fixture actually started a daemon-owned container");
  const cancelled = await service.cancel(started.id, service.get(started.id).revision); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.containerStopped, true); assert.equal(execFileSync("docker", ["ps", "-aq", "--filter", `label=codeflow.filtered-task=${started.id}`], { encoding: "utf8", timeout: 5000 }).trim(), ""); await dockerFilteredRuntime.stop(started.id);
});
