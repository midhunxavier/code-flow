import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FilteredTasks, type FilteredTaskRuntime } from "../src/filtered-tasks.js";
import { ProjectFilePolicies, allowsFilePolicy, allowsFilePolicyDirectory, type FilePolicySnapshot } from "../src/filesystem-policy.js";
import { filteredTaskActive, filteredTaskCancellable } from "../src/filtered-task-state.js";

const imageId = "sha256:" + "a".repeat(64);
type Context = { home: string; repo: string; store: ProjectFilePolicies; make: (runtime: FilteredTaskRuntime) => FilteredTasks; git: (...args: string[]) => string };
async function fixture(files: Record<string, string>, fn: (context: Context) => Promise<void>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-filtered-"))), repo = join(home, "repo"), store = new ProjectFilePolicies(home);
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), text); }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); git("init", "-q", "-b", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "source");
  const services: FilteredTasks[] = []; const make = (runtime: FilteredTaskRuntime) => { const service = new FilteredTasks({ home, runtime, authorize: async () => [await store.get("project")], withRepository: async (_repo, work) => work() }); services.push(service); return service; };
  try { await fn({ home, repo, store, make, git }); } finally { await Promise.all(services.map((service) => service.close())); await rm(home, { recursive: true, force: true }); }
}
const input = (repo: string, overrides: Record<string, unknown> = {}) => ({ project: "project", repo, agent: "claude", image: "prepared-fixture:1", task: "Change the allowed source", network: false, ...overrides });
async function settled(service: FilteredTasks, id: string) { for (let attempt = 0; attempt < 300; attempt++) { const job = service.get(id); if (!["preparing", "running"].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Filtered fixture did not finish"); }
const runtime = (run: FilteredTaskRuntime["run"]): FilteredTaskRuntime => ({ pinImage: async () => imageId, run, stop: async () => undefined });
const edit = (path: string, text: string) => runtime(async (_job, workspace) => { await mkdir(dirname(join(workspace, path)), { recursive: true }); await writeFile(join(workspace, path), text); return { ok: true, finalText: "edited" }; });
const repoFiles = { "src/file.ts": "export const answer = 1;\n", "secrets/config.env": "API_URL=https://example.invalid\n", "config/credentials/production.yml.enc": "encrypted\n" };

test("a committed secrets/ folder the policy can read is exported and walked consistently, so the task completes", async () => fixture(repoFiles, async ({ repo, make }) => {
  let exported: string[] = [];
  const service = make(runtime(async (_job, workspace) => { exported = execFileSync("git", ["ls-files"], { cwd: workspace, encoding: "utf8" }).trim().split("\n"); await writeFile(join(workspace, "src/file.ts"), "export const answer = 2;\n"); return { ok: true, finalText: "done" }; }));
  await service.load(); const created = await service.create(input(repo)), done = await settled(service, created.id);
  assert.equal(done.status, "completed", done.error); assert.equal(done.error, undefined);
  assert.deepEqual(exported.sort(), ["config/credentials/production.yml.enc", "secrets/config.env", "src/file.ts"]);
  assert.deepEqual((await service.preview(created.id)).changes.map((change) => change.path), ["src/file.ts"]);
}));

test("credential-named files are still refused inside a readable secrets/ folder and name the refused path", async () => fixture(repoFiles, async ({ repo, make }) => {
  for (const path of ["secrets/.env", "src/id_rsa", "secrets/deploy.pem"]) {
    const service = make(edit(path, "PRIVATE\n")); await service.load();
    const done = await settled(service, (await service.create(input(repo))).id);
    assert.equal(done.status, "failed"); assert.match(done.error!, /forbidden path/); assert.ok(done.error!.includes(path), done.error);
    // A terminal status is visible before the final durable write releases its work claim.
    // Stop the fixture before reopening it; outer teardown removes its private directory.
    await service.close();
  }
  const nested = make(edit("src/.ssh/known_hosts", "host\n")); await nested.load();
  const refused = await settled(nested, (await nested.create(input(repo))).id);
  assert.equal(refused.status, "failed"); assert.match(refused.error!, /forbidden directory: src\/\.ssh/);
}));

test("every ancestor folder of a policy-readable file passes the directory check the result scan uses", () => {
  const snapshot = (read: FilePolicySnapshot["read"]): FilePolicySnapshot => ({ version: 1, projectId: "project", revision: 1, read, write: read, hash: "x", updatedAt: 0 });
  const policies = [snapshot({ allow: ["."], deny: [] }), snapshot({ allow: ["secrets/a", "credentials"], deny: ["Secrets/b.yaml"] }), snapshot({ allow: ["x.key"], deny: [] })];
  const paths = ["secrets/a", "secrets/b.yaml", "secret/b.yaml", "credentials/c", "x.key/d", ".env/e", "config/credentials/production.yml.enc", "pkg/secrets/handler.go", "a/.ssh/config", ".git/config"];
  let checked = 0;
  for (const policy of policies) for (const path of paths) {
    if (!allowsFilePolicy(policy, "read", path)) continue;
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) { checked++; assert.equal(allowsFilePolicyDirectory(policy, parts.slice(0, depth).join("/")), true, `${parts.slice(0, depth).join("/")} must be walkable for ${path}`); }
  }
  assert.ok(checked > 8);
  assert.equal(allowsFilePolicyDirectory(policies[0]!, "a/.ssh"), false); assert.equal(allowsFilePolicyDirectory(policies[1]!, "secrets/b.yaml"), false); assert.equal(allowsFilePolicyDirectory(policies[1]!, "private"), false);
});

test("cancel cannot discard a completed, failed or imported result", async () => fixture(repoFiles, async ({ repo, make, store }) => {
  const service = make(edit("src/file.ts", "export const answer = 2;\n")); await service.load();
  const done = await settled(service, (await service.create(input(repo))).id); assert.equal(done.status, "completed");
  assert.equal(filteredTaskCancellable(done), false); assert.equal(filteredTaskActive(done), false);
  await assert.rejects(service.cancel(done.id, done.revision), (error: Error & { status?: number }) => error.status === 409 && /nothing to cancel/.test(error.message));
  assert.equal(service.get(done.id).status, "completed"); assert.equal(service.get(done.id).revision, done.revision);
  const preview = await service.preview(done.id); assert.deepEqual(preview.changes.map((change) => change.path), ["src/file.ts"]);
  const imported = await service.import(done.id, { revision: done.revision, expectedHead: done.sourceHead, resultHash: done.resultHash }); assert.equal(imported.status, "imported");
  await assert.rejects(service.cancel(imported.id, imported.revision), /nothing to cancel/); assert.equal(service.get(imported.id).status, "imported");
  await service.delete(imported.id, imported.revision);
  await store.set("project", { revision: 0, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: ["src"] } });
  const failed = await settled(service, (await service.create(input(repo))).id); assert.equal(failed.status, "failed");
  await assert.rejects(service.cancel(failed.id, failed.revision), /nothing to cancel/); assert.equal(service.get(failed.id).error, failed.error);
  assert.equal(filteredTaskCancellable({ status: "running", containerStopped: false }), true); assert.equal(filteredTaskCancellable({ status: "unknown", containerStopped: false }), true);
  assert.equal(filteredTaskCancellable({ status: "unknown", containerStopped: true, importCommit: "a".repeat(40) }), false); assert.equal(filteredTaskCancellable({ status: "failed", containerStopped: false }), true);
}));

test("write-policy refusals name the offending paths, at most five", async () => fixture(repoFiles, async ({ repo, make, store }) => {
  await store.set("project", { revision: 0, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: ["src"] } });
  const one = make(edit("src/allowed.txt", "new\n")); await one.load();
  const single = await settled(one, (await one.create(input(repo))).id);
  assert.equal(single.error, "Result modified a path outside the write policy; nothing will be imported: src/allowed.txt");
  await one.close();
  const many = make(runtime(async (_job, workspace) => { for (let index = 1; index <= 7; index++) await writeFile(join(workspace, `src/new-${index}.txt`), "x"); return { ok: true, finalText: "edited" }; })); await many.load();
  const several = await settled(many, (await many.create(input(repo))).id);
  assert.match(several.error!, /^Result modified paths outside the write policy; nothing will be imported: src\/new-1\.txt, src\/new-2\.txt, src\/new-3\.txt, src\/new-4\.txt, src\/new-5\.txt and 2 more$/);
}));

test("create names the invalid field instead of one generic message", async () => fixture(repoFiles, async ({ repo, make }) => {
  const service = make(edit("src/file.ts", "x")); await service.load();
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ maxMinutes: 0 }, /1–30 whole minutes/], [{ maxMinutes: 31 }, /1–30 whole minutes/], [{ maxMinutes: 1.5 }, /1–30 whole minutes/], [{ maxMinutes: "5" }, /1–30 whole minutes/],
    [{ repo: "C:\\repo" }, /absolute path/], [{ project: 5 }, /Choose a project/], [{ agent: "gpt" }, /supported provider/], [{ task: "   " }, /instructions/],
    [{ task: "é".repeat(24_000) }, /exceed 24 KB \(UTF-8 bytes\)/], [{ image: 5 }, /prepared local Docker image/], [{ image: " " }, /prepared local Docker image/], [{ network: "yes" }, /Network access must be true or false/],
  ];
  const messages = new Set<string>();
  for (const [overrides, pattern] of cases) await assert.rejects(service.create(input(repo, overrides)), (error: Error & { status?: number }) => { messages.add(error.message); return error.status === 400 && pattern.test(error.message); });
  assert.equal(messages.size, 8); assert.deepEqual(service.summaries(), []);
}));

test("a running task and a full history refuse a new task with different reasons", async () => fixture(repoFiles, async ({ home, repo, make }) => {
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const service = make(runtime(async (_job, workspace) => { await blocked; await writeFile(join(workspace, "src/file.ts"), "x"); return { ok: true, finalText: "done" }; })); await service.load();
  const first = await service.create(input(repo));
  await assert.rejects(service.create(input(repo)), (error: Error) => /still preparing, running, importing/.test(error.message) && !/history/.test(error.message));
  release(); const done = await settled(service, first.id); assert.equal(done.status, "completed"); await service.close();
  const job = JSON.parse(await readFile(join(home, "filtered-tasks", first.id, "job.json"), "utf8"));
  for (let index = 1; index < 100; index++) { const id = `filtered-${index.toString(16).padStart(24, "0")}`; await cp(join(home, "filtered-tasks", first.id), join(home, "filtered-tasks", id), { recursive: true }); await writeFile(join(home, "filtered-tasks", id, "job.json"), JSON.stringify({ ...job, id })); }
  const full = make(edit("src/file.ts", "x")); await full.load(); assert.equal(full.summaries().length, 100);
  await assert.rejects(full.create(input(repo)), (error: Error) => /history is full \(100 tasks\); delete a finished task/.test(error.message) && !/Wait for the current/.test(error.message));
}));
