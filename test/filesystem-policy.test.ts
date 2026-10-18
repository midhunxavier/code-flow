import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectFilePolicies, allowsFilePolicy, assertPolicyExecution, assertProjectDirectoryAccess, assertProjectFileAccess, configureFilePolicyResolver, filterPolicyDiff, normalizePolicyPath, policyIsRestrictive } from "../src/filesystem-policy.js";
const policy = { read: { allow: ["src"], deny: ["src/private"] }, write: { allow: ["src/public"], deny: [] } };
async function fixture(fn: (store: ProjectFilePolicies, home: string) => Promise<void>) { const home = await mkdtemp(join(tmpdir(), "codeflow-file-policy-")); try { await fn(new ProjectFilePolicies(home), home); } finally { await rm(home, { recursive: true, force: true }); } }
test("filesystem policies have exact CAS revisions, canonical content hashes and durable private storage", async () => fixture(async (store, home) => {
  const initial = await store.get("project"); assert.equal(initial.revision, 0); assert.equal(policyIsRestrictive(initial), false);
  const saved = await store.set("project", { revision: 0, ...policy }); assert.equal(saved.revision, 1); assert.equal(policyIsRestrictive(saved), true); assert.match(saved.hash, /^[a-f0-9]{64}$/); assert.deepEqual(await new ProjectFilePolicies(home).get("project"), saved);
  await assert.rejects(store.set("project", { revision: 0, ...policy }), /changed/); assert.equal((await store.get("project")).revision, 1);
  if (process.platform !== "win32") assert.equal((await stat(join(home, "filesystem-policies/project.json"))).mode & 0o777, 0o600);
  const file = join(home, "filesystem-policies/project.json"); const changed = JSON.parse(await readFile(file, "utf8")); changed.read.allow = ["."]; await writeFile(file, JSON.stringify(changed)); await assert.rejects(store.get("project"), /hash changed/);
}));
test("allow and deny rules enforce subtree boundaries, fixed credentials and traversal rejection", async () => fixture(async (store) => {
  const saved = await store.set("project", { revision: 0, ...policy });
  assert.equal(allowsFilePolicy(saved, "read", "src/public/index.ts"), true); assert.equal(allowsFilePolicy(saved, "write", "src/public/index.ts"), true); assert.equal(allowsFilePolicy(saved, "read", "src/private/key.txt"), false); assert.equal(allowsFilePolicy(saved, "read", "src-private/file.ts"), false); assert.equal(allowsFilePolicy(saved, "write", "src/index.ts"), false); assert.equal(allowsFilePolicy(saved, "read", "src/public/.env"), false);
  assert.equal(allowsFilePolicy(saved, "read", "src/PRIVATE/key.txt"), false, "case-insensitive filesystems cannot bypass a deny rule");
  for (const path of ["../escape", "/absolute", "src/../escape", "src//file", ".git/config", "src/.git/config", "src/*", "src\\escape", "C:/escape", "src\0file"]) assert.throws(() => normalizePolicyPath(path));
  assert.throws(() => assertPolicyExecution([saved], "Agent launch"), /cannot enforce/); assert.doesNotThrow(() => assertPolicyExecution([], "Agent launch"));
  const diff = { path: "src/public/file.ts", status: "modified" as const, additions: 1, deletions: 1, binary: false, patch: "source", truncated: false }; assert.equal(filterPolicyDiff([saved], [diff, { ...diff, path: "src/private/key.txt" }, { ...diff, oldPath: "src/private/key.txt" }]).length, 1);
}));
test("policy activation is guarded until a durable commit and failed barriers recover without widening access", async () => fixture(async (store) => {
  let updates = 0; store.onChange((next, previous) => { updates++; assert.equal(next.revision, previous.revision + 1); });
  let enter!: () => void, release!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  const saving = store.set("project", { revision: 0, ...policy }, async (commit) => { enter(); await gate; await commit(); }); await entered; assert.equal((await store.get("project")).revision, 0, "active policy stays committed and readable while root holds its execution barrier"); release(); await saving; assert.equal(updates, 1);
  await assert.rejects(store.set("project", { revision: 1, ...policy }, async () => { throw new Error("Could not stop active worker"); }), /stop active worker/); assert.equal((await store.get("project")).revision, 1); assert.equal(updates, 1);
  await assert.rejects(store.set("project", { revision: 1, ...policy }, async () => {}), /not activated/); assert.equal((await store.get("project")).revision, 1);
  await store.set("project", { revision: 1, ...policy }); assert.equal(updates, 2, "a failed activation does not poison later policy changes");
  await assert.rejects(store.set("project", { revision: 2, ...policy }, async (commit) => { await commit(); throw new Error("Observer failed after commit"); }), /Observer failed/); assert.equal(updates, 3, "a durable policy notifies authorization observers even if its activation callback later fails"); assert.equal((await store.get("project")).revision, 3);
}));
test("configured file checks use fresh intersected policy and reject symlink escapes for existing or future writes", async () => fixture(async (store, home) => {
  const repo = join(home, "repo"); await mkdir(join(repo, "src/public"), { recursive: true }); await writeFile(join(repo, "src/public/file.ts"), "safe"); await mkdir(join(home, "outside")); await symlink(join(home, "outside"), join(repo, "src/public/link"));
  let current = await store.set("project", { revision: 0, ...policy }); const pinned = current; const stop = configureFilePolicyResolver(async () => [pinned, current]);
  try { await assertProjectFileAccess(repo, "src/public/file.ts", "read"); await assertProjectDirectoryAccess(repo, "."); await assertProjectDirectoryAccess(repo, "src"); await assert.rejects(assertProjectDirectoryAccess(repo, "src/private"), /denies/); await assert.rejects(assertProjectDirectoryAccess(repo, "src/public/link"), /Symbolic/, "tree browsing cannot expose a denied subtree through an allowed symlink alias"); await assert.rejects(assertProjectFileAccess(repo, "src/private/key", "read"), /denies/); await assert.rejects(assertProjectFileAccess(repo, "src/public/link/new.ts", "write"), /Symbolic/); current = await store.set("project", { revision: 1, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } }); await assert.rejects(assertProjectFileAccess(repo, "README.md", "read"), /denies/, "weakening current policy cannot bypass a pinned run restriction"); }
  finally { stop(); }
  await assertProjectFileAccess(repo, "src/private/key", "read");
}));
test("symbolic or corrupt policy storage is not overwritten or reset to unrestricted defaults", async () => fixture(async (store, home) => {
  await mkdir(join(home, "elsewhere")); await symlink(join(home, "elsewhere"), join(home, "filesystem-policies")); await assert.rejects(store.get("project"), /cannot be a symbolic/); await assert.rejects(store.set("project", { revision: 0, ...policy }), /cannot be a symbolic/);
  await rm(join(home, "filesystem-policies")); await mkdir(join(home, "filesystem-policies")); await writeFile(join(home, "filesystem-policies/project.json"), "not-json"); await assert.rejects(store.get("project"), /cannot be read/); assert.equal(await readFile(join(home, "filesystem-policies/project.json"), "utf8"), "not-json");
}));
