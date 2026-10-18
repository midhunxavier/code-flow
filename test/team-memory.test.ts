import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../src/engine.js";
import { MemoryStore, type MemorySelection } from "../src/memory.js";
import { memoryAuthorityForRun, projectMemoryForRun, proposeProjectMemories } from "../src/team-memory.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-team-memory-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  await writeFile(join(root, "README.md"), "initial\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "initial");
  const first = git("rev-parse", "HEAD");
  await writeFile(join(root, "README.md"), "second\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "second");
  const head = git("rev-parse", "HEAD");
  const store = new MemoryStore(join(root, ".memory", "memory.json"));
  const run = { id: "r-team", task: "Update API contracts", repo: root, project: "p-team", baseRef: head, baseLabel: "main", branchPrefix: "codeflow/run", worktrees: [] } as unknown as Run & { memoryManifest?: MemorySelection["manifest"] };
  const project = { id: "p-team", name: "Team", repos: [root], createdAt: 1 };
  const projects = { get: (id: string) => id === "p-team" ? project : undefined };
  return { root, run, first, head, store, projects, project };
}

test("run memory authority keeps untrusted text separate from execution trust", () => {
  const base = { id: "r", repo: "/repo", project: "p" };
  assert.equal(memoryAuthorityForRun(base).kind, "run");
  for (const source of [
    { trusted: false },
    { trusted: true, untrustedText: true },
    {},
  ]) {
    const authority = memoryAuthorityForRun({ ...base, source: source as Run["source"] });
    assert.ok(authority.kind === "run" && authority.sourceTrust !== "trusted");
  }
  const locked = memoryAuthorityForRun({ ...base, lockdown: "Issue supplied by external author" });
  assert.ok(locked.kind === "run" && locked.lockedDown && locked.sourceTrust === "untrusted");
});

test("project retrieval checks ancestry and current project membership", async () => {
  const { root, run, first, store, projects, project } = await fixture();
  const accepted = await store.propose({ scope: "project", repo: root, projectId: "p-team", title: "Contract", body: "API uses explicit version numbers", applicability: { kind: "branch", branch: "main", commit: first } }, { kind: "user" });
  const selected = await projectMemoryForRun(run, "worker", "api", undefined, { store, projects });
  assert.deepEqual(selected.entries.map((entry) => entry.id), [accepted.id]);
  assert.equal((await projectMemoryForRun(run, "worker", "api", undefined, { store, projects, branch: "other" })).entries.length, 0);
  project.repos = [];
  assert.equal((await projectMemoryForRun(run, "worker", "api", undefined, { store, projects })).entries.length, 0);
  assert.deepEqual(await proposeProjectMemories(run, [{ title: "Fact", body: "Observation" }], "api", run.baseRef, "worker", { store, projects }), []);
});

test("live project retrieval honors task paths, query relevance and context limits", async () => {
  const { root, run, store, projects } = await fixture();
  await store.propose({ scope: "project", repo: root, projectId: "p-team", title: "Parser", body: "Decode the wire protocol", paths: ["src/parser"] }, { kind: "user" });
  await store.propose({ scope: "project", repo: root, projectId: "p-team", title: "API", body: "API contracts use version numbers" }, { kind: "user" });
  const selected = await projectMemoryForRun(run, "worker", "api", ["src/parser/decode.ts"], { store, projects, query: "wire protocol", maxEntries: 1, maxChars: 128 });
  assert.deepEqual(selected.entries.map((entry) => entry.title), ["Parser"]);
  assert.ok(selected.manifest.omitted.some((ref) => ref.reason === "entry budget"));
  assert.deepEqual((await projectMemoryForRun(run, "worker", "api", ["*"], { store, projects, query: "wire protocol", maxEntries: 1 })).entries.map((entry) => entry.title), ["Parser"]);
  assert.deepEqual((await projectMemoryForRun(run, "worker", "api", ["src/ui/view.ts"], { store, projects, query: "wire protocol" })).entries.map((entry) => entry.title), ["API"]);
});

test("findings inherit selected untrusted origins and remain branch-specific proposals", async () => {
  const { root, run, store, projects, head } = await fixture();
  const untrusted = memoryAuthorityForRun({ ...run, source: { trusted: false } as Run["source"] }, "worker");
  const proposed = await store.propose({ scope: "project", repo: root, projectId: "p-team", title: "External observation", body: "API endpoint behavior differs" }, untrusted);
  const accepted = await store.accept(proposed.id, proposed.revision, { kind: "user" });
  run.memoryManifest = { included: [{ id: accepted.id, revision: accepted.revision, reason: "applicable" }], omitted: [] };
  const findings = [{ title: "Derived lesson", body: "Future API work should verify endpoint behavior", evidenceRefs: ["check:passed"] }];
  const created = await proposeProjectMemories(run, findings, "api", head, "worker", { store, projects, branch: "codeflow/result" });
  assert.equal(created[0]!.status, "proposed");
  assert.deepEqual(created[0]!.applicability, { kind: "branch", branch: "codeflow/result", commit: head });
  assert.ok(created[0]!.origins.some((source) => source.trust === "untrusted"));
  assert.deepEqual(created[0]!.derivedFrom, [{ id: accepted.id, revision: accepted.revision }]);
  assert.ok(created[0]!.sourceRefs.includes("check:passed"));
  assert.deepEqual(await proposeProjectMemories(run, findings, "api", head, "worker", { store, projects, branch: "codeflow/result" }), created, "replay produces no duplicate knowledge");
  assert.equal((await projectMemoryForRun(run, "worker", "api", undefined, { store, projects })).entries.length, 1, "unapproved derived proposal is excluded");
});

test("learning disabled and deleted projects create no proposals", async () => {
  const { run, store, projects, head } = await fixture();
  run.learn = false;
  assert.deepEqual(await proposeProjectMemories(run, [{ title: "Fact", body: "Observation" }], "api", head, "worker", { store, projects }), []);
  run.learn = true;
  assert.deepEqual(await proposeProjectMemories(run, [{ title: "Fact", body: "Observation" }], "api", head, "worker", { store, projects: { get: () => undefined } }), []);
  assert.deepEqual((await projectMemoryForRun(run, "worker", "api", undefined, { store, projects: { get: () => undefined } })).entries, []);
});
