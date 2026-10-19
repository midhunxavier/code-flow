import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryConflictError, MemoryStore, type MemoryAuthority, type MemoryInput, type MemoryVerification } from "../src/memory.js";

const repo = "/projects/api";
const projectId = "p-api";
const sha = "a".repeat(40);
const user: MemoryAuthority = { kind: "user", repo, projectId };
const run: MemoryAuthority = { kind: "run", repo, projectId, runId: "run-1", memberId: "worker", lockedDown: false, sourceTrust: "trusted" };
const coordinator: MemoryAuthority = { ...run, memberId: "coordinator", canAcceptTeam: true };
const verified: MemoryVerification = { passed: true, commit: sha, branch: "main", merged: true, evidenceRefs: ["run-1/check:test", "run-1/review:approved"] };
const input = (patch: Partial<MemoryInput> = {}): MemoryInput => ({ scope: "project", repo, projectId, title: "Check API behavior", body: "Run the HTTP contract checks before merging API changes.", ...patch });
const fresh = async () => new MemoryStore(join(await mkdtemp(join(tmpdir(), "codeflow-memory-")), "memory.json"));

test("memory snapshots survive reconstruction, preserve permissions, and serialize writers", async () => {
  const store = await fresh();
  await store.load();
  const other = new MemoryStore(store.file);
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? store : other).propose(input({ title: `Rule ${index}` }), user)));
  assert.equal(new Set(results.map((entry) => entry.id)).size, 16);
  const restored = new MemoryStore(store.file);
  assert.equal((await restored.list({ repo, projectId }, user)).length, 16);
  if (process.platform !== "win32") assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(store.file, "..")), ["memory.sqlite"]);
});

test("revision-scoped user feedback tunes retrieval without changing trust or leaking across revisions", async () => {
  const store = await fresh();
  const first = await store.propose(input({ title: "First convention" }), user);
  const second = await store.propose(input({ title: "Second convention" }), user);
  await store.recordFeedback(first.id, first.revision, { rating: "useful", runId: "observed-run" }, user);
  await store.recordFeedback(first.id, first.revision, { rating: "useful", runId: "observed-run" }, user);
  const selected = await store.retrieve({ repo, projectId, maxEntries: 1 }, user);
  assert.equal(selected.entries[0]!.id, first.id);
  assert.equal(selected.entries[0]!.feedback!.length, 1, "duplicate feedback cannot boost rank");
  assert.equal(selected.entries[0]!.revision, first.revision, "metadata does not change body identity");
  assert.deepEqual(selected.entries[0]!.origins, first.origins);
  await assert.rejects(store.recordFeedback(first.id, first.revision, { rating: "useful" }, run), /Only the user/);
  await store.recordFeedback(first.id, first.revision, { rating: "stale", note: "Outdated convention" }, user);
  const excluded = await store.retrieve({ repo, projectId }, user);
  assert.equal(excluded.entries[0]!.id, second.id);
  assert.match(excluded.manifest.omitted.find((ref) => ref.id === first.id)!.reason, /stale or incorrect/);
  const replay = await store.resolveSelection({ repo, projectId }, selected.manifest, user);
  assert.equal(replay.entries.length, 0, "new turns cannot replay stale knowledge bodies");
  const corrected = await store.revise(first.id, first.revision, { body: "Corrected convention" }, user);
  assert.ok((await store.retrieve({ repo, projectId }, user)).entries.some((entry) => entry.id === corrected.id));
  await assert.rejects(store.recordFeedback(first.id, first.revision, { rating: "useful" }, user), MemoryConflictError);
  await store.remove(corrected.id, corrected.revision, user);
  assert.doesNotMatch(await readFile(store.file, "utf8"), /Outdated convention/);
});

test("guarded publication atomically rejects sources edited, deleted, expired or rated stale after preview", async () => {
  const store = await fresh();
  const source = await store.propose(input({ title: "Source guidance" }), user);
  const refs = [{ id: source.id, revision: source.revision }];
  const summary = input({ title: "Reviewed summary", derivedFrom: refs });
  // Queue the competing write before publication without awaiting it. Both instances share
  // the file transaction queue, so the publication checks the committed competing version.
  const other = new MemoryStore(store.file);
  const edit = other.revise(source.id, source.revision, { body: "New source guidance" }, user);
  await assert.rejects(store.propose(summary, user, { expectedSources: refs }), MemoryConflictError);
  const edited = await edit;
  assert.equal((await store.list({ repo, projectId }, user)).length, 1, "conflict must not save a partial summary");
  assert.equal((await store.propose(summary, user)).derivedFrom[0]!.revision, source.revision, "ordinary historical derivation remains backwards compatible");
  const currentRefs = [{ id: edited.id, revision: edited.revision }];
  const currentSummary = input({ title: "Current summary", derivedFrom: currentRefs });
  const feedback = other.recordFeedback(edited.id, edited.revision, { rating: "stale" }, user);
  await assert.rejects(store.propose(currentSummary, user, { expectedSources: currentRefs }), MemoryConflictError);
  await feedback;
  await other.recordFeedback(edited.id, edited.revision, { rating: "useful" }, user);
  const published = await store.propose(currentSummary, user, { expectedSources: currentRefs });
  assert.deepEqual(published.derivedFrom, currentRefs);
  const deletion = other.remove(edited.id, edited.revision, user);
  await assert.rejects(store.propose(currentSummary, user, { expectedSources: currentRefs }), MemoryConflictError);
  await deletion;
  const expiring = await store.propose(input({ expiresAt: Date.now() - 1 }), user);
  const expiredRefs = [{ id: expiring.id, revision: expiring.revision }];
  await assert.rejects(store.propose(input({ derivedFrom: expiredRefs }), user, { expectedSources: expiredRefs }), MemoryConflictError);
  await assert.rejects(store.propose(input({ derivedFrom: refs }), user, { expectedSources: [] }), /every derivation source/);
});

test("a crashed temporary snapshot cannot overwrite the last complete snapshot", async () => {
  const store = await fresh();
  const saved = await store.propose(input(), user);
  await writeFile(`${store.file}.crash.tmp`, '{"schemaVersion":1,"entries":[', { mode: 0o600 });
  const recovered = new MemoryStore(store.file);
  assert.deepEqual((await recovered.list({ repo, projectId }, user)).map((entry) => entry.id), [saved.id]);
});

test("corrupt and unsupported stores fail closed and never get reset on writes", async () => {
  const store = await fresh();
  const legacy = store.file.replace(/\.sqlite$/, ".json");
  for (const body of ['{"broken":', '{"schemaVersion":99,"entries":[]}', '{"schemaVersion":1,"entries":[{"id":"x"}]}']) {
    await writeFile(legacy, body);
    await assert.rejects(store.load(), /cannot be read/);
    await assert.rejects(store.propose(input(), user), /cannot be read/);
    assert.equal(await readFile(legacy, "utf8"), body);
  }
  await writeFile(legacy, '{"schemaVersion":1,"entries":[]}');
  assert.equal((await store.propose(input(), user)).status, "accepted", "a failed queue operation does not poison later repaired storage");
});

test("storage failures are returned to callers and do not report successful mutations", async () => {
  const store = await fresh();
  const saved = await store.propose(input(), user);
  const backup = `${store.file}.saved`;
  await rename(store.file, backup);
  await mkdir(store.file);
  await assert.rejects(store.revise(saved.id, saved.revision, { body: "must not be reported saved" }, user));
  const original = { entries: readEntries(backup) };
  assert.equal(original.entries[0].body, saved.body);
  assert.equal(original.entries[0].revision, 1);
});

test("CAS updates expose a revision conflict without losing the winner", async () => {
  const store = await fresh();
  const saved = await store.propose(input(), user);
  const outcomes = await Promise.allSettled([
    store.revise(saved.id, 1, { body: "first writer" }, user),
    store.revise(saved.id, 1, { body: "second writer" }, user),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof MemoryConflictError);
  assert.equal((await store.list({ repo, projectId }, user))[0]!.body, "first writer");
});

test("logical operation IDs deduplicate replay and reject changed content", async () => {
  const store = await fresh();
  const command = input({ operationId: "run-1:api:finding:0" });
  const a = await store.propose(command, run);
  const b = await new MemoryStore(store.file).propose(command, run);
  assert.deepEqual(a, b);
  assert.equal((await store.list({ repo, projectId }, user)).length, 1);
  await assert.rejects(store.propose({ ...command, body: "different finding" }, run), /already used/);
});

test("namespaced live-tool operation IDs retain their full identity across reload and retry", async () => {
  const store = await fresh();
  const operationId = `${"r".repeat(20)}:${"m".repeat(40)}:${"a".repeat(24)}:${"o".repeat(160)}`;
  assert.ok(operationId.length > 240);
  const command = input({ operationId });
  const original = await store.propose(command, run);
  assert.equal(original.operationId, operationId);
  assert.deepEqual(await new MemoryStore(store.file).propose(command, run), original);
  await assert.rejects(store.propose(input({ operationId: "x".repeat(501) }), run), /operationId/);
});

test("acceptance replay survives a snapshot-before-journal crash without weakening revision checks", async () => {
  const store = await fresh();
  const proposed = await store.propose(input({ scope: "team", runId: "run-1" }), run);
  const operation = `run-1:task-api:${proposed.id}:${proposed.revision}:accept`;
  const accepted = await store.accept(proposed.id, proposed.revision, coordinator, undefined, operation);
  assert.equal(accepted.revision, proposed.revision + 1);
  // The run journal still holds the pre-acceptance reference after an interrupted append.
  const restored = new MemoryStore(store.file);
  assert.deepEqual(await restored.accept(proposed.id, proposed.revision, coordinator, undefined, operation), accepted);
  await assert.rejects(restored.accept(proposed.id, proposed.revision, coordinator), MemoryConflictError, "ordinary exact-revision commands keep their original CAS behavior");
  await assert.rejects(restored.accept(proposed.id, proposed.revision, { ...coordinator, memberId: "another-coordinator" }, undefined, operation), /different approval/);
  await assert.rejects(restored.accept(proposed.id, proposed.revision, coordinator, verified, operation), /different approval/);
  const edited = await restored.revise(accepted.id, accepted.revision, { body: "The user changed this content after acceptance" }, user);
  await assert.rejects(restored.accept(proposed.id, proposed.revision, coordinator, undefined, operation), MemoryConflictError, "an old retry never accepts or hides later body edits");
  assert.equal((await restored.list({ repo, projectId, runId: "run-1" }, user)).find((entry) => entry.id === edited.id)?.body, edited.body);
});

test("private notes are scoped by member and run, including revision errors", async () => {
  const store = await fresh();
  const saved = await store.propose(input({ scope: "private", runId: "run-1", memberId: "worker", body: "PRIVATE SECRET" }), run);
  assert.equal(saved.status, "accepted");
  const own = await store.retrieve({ repo, projectId, runId: "run-1", memberId: "worker" }, run);
  assert.equal(own.entries.length, 1);
  assert.equal((await store.retrieve({ repo, projectId, runId: "run-1", memberId: "coordinator" }, coordinator)).entries.length, 0);
  await assert.rejects(store.revise(saved.id, 999, { body: "replace" }, coordinator), (error) => {
    assert.match((error as Error).message, /Private memory belongs/);
    assert.ok(!(error instanceof MemoryConflictError), "do not expose a private body through conflict details");
    return true;
  });
  const otherRun: MemoryAuthority = { ...run, runId: "run-2" };
  assert.equal((await store.retrieve({ repo, projectId, runId: "run-2", memberId: "worker" }, otherRun)).entries.length, 0);
  await assert.rejects(store.propose(input({ derivedFrom: [{ id: saved.id, revision: saved.revision }] }), run), /Publishing private memory/);
});

test("team proposals require assigned coordinator acceptance and stay in their run", async () => {
  const store = await fresh();
  const proposed = await store.propose(input({ scope: "team", runId: "run-1" }), run);
  assert.equal((await store.retrieve({ repo, projectId, runId: "run-1" }, run)).entries.length, 0);
  await assert.rejects(store.accept(proposed.id, proposed.revision, run), /assigned coordinator/);
  const accepted = await store.accept(proposed.id, proposed.revision, coordinator);
  assert.equal(accepted.acceptedBy, "team");
  assert.equal((await store.retrieve({ repo, projectId, runId: "run-1" }, run)).entries.length, 1);
  assert.equal((await store.retrieve({ repo, projectId, runId: "run-2" }, { ...run, runId: "run-2" })).entries.length, 0);
});

test("untrusted, locked-down and unknown origins cannot be automatically promoted", async () => {
  for (const authority of [
    { ...run, sourceTrust: "untrusted" as const },
    { ...run, lockedDown: true },
    { ...run, sourceTrust: "unknown" as const },
  ]) {
    const store = await fresh();
    const proposed = await store.propose(input(), authority);
    await assert.rejects(store.accept(proposed.id, proposed.revision, run, verified), /explicit user approval/);
    const approved = await store.accept(proposed.id, proposed.revision, user);
    assert.equal(approved.acceptedBy, "user");
    assert.deepEqual(approved.origins, proposed.origins, "approval retains the original provenance");
    await assert.rejects(store.accept(approved.id, proposed.revision, user), MemoryConflictError);
  }
});

test("summaries and edits retain all provenance and cannot launder untrusted content", async () => {
  const store = await fresh();
  const tainted: MemoryAuthority = { ...run, lockedDown: true, sourceTrust: "untrusted" };
  const original = await store.propose(input({ scope: "team", runId: "run-1" }), tainted);
  const summary = await store.propose(input({ scope: "team", runId: "run-1", body: "Coordinator summary", derivedFrom: [{ id: original.id, revision: original.revision }] }), coordinator);
  const revised = await store.revise(summary.id, summary.revision, { body: "A cleaner-looking summary", derivedFrom: [] }, coordinator);
  assert.ok(revised.origins.some((source) => source.trust === "untrusted" && source.lockedDown));
  assert.deepEqual(revised.derivedFrom, summary.derivedFrom);
  await assert.rejects(store.promote(revised.id, revised.revision, { projectId, applicability: { kind: "repository" } }, coordinator, verified), /explicit user approval/);
  const approved = await store.promote(revised.id, revised.revision, { projectId, applicability: { kind: "repository" } }, user);
  assert.equal(approved.scope, "project");
  assert.ok(approved.origins.some((source) => source.trust === "untrusted"));
});

test("historical observations are unknown proposals, never automatically trusted conventions", async () => {
  const store = await fresh();
  const observation = await store.propose(input(), { kind: "import", repo, projectId });
  assert.equal(observation.status, "proposed");
  assert.deepEqual(observation.origins.map((source) => source.trust), ["unknown"]);
  const derived = await store.propose(input({ derivedFrom: [{ id: observation.id, revision: 1 }] }), run);
  await assert.rejects(store.accept(derived.id, derived.revision, run, verified), /explicit user approval/);
  assert.equal((await store.retrieve({ repo, projectId }, user)).entries.length, 0);
});

test("automatic promotion requires actual verification and correct merge/branch applicability", async () => {
  const store = await fresh();
  const proposed = await store.propose(input({ scope: "team", runId: "run-1" }), run);
  const destination = { projectId, applicability: { kind: "repository" as const } };
  await assert.rejects(store.promote(proposed.id, 1, destination, coordinator), /passing runtime verification/);
  await assert.rejects(store.promote(proposed.id, 1, destination, coordinator, { ...verified, merged: false }), /Unmerged knowledge/);
  const branch = { projectId, applicability: { kind: "branch" as const, branch: "feature", commit: sha } };
  await assert.rejects(store.promote(proposed.id, 1, branch, coordinator, verified), /match the verified branch/);
  const accepted = await store.promote(proposed.id, 1, branch, coordinator, { ...verified, merged: false, branch: "feature" });
  assert.equal(accepted.acceptedBy, "verification");
  assert.equal((await store.retrieve({ repo, projectId, branch: "main", commit: sha }, user)).entries.length, 0);
  assert.equal((await store.retrieve({ repo, projectId, branch: "feature", commit: "b".repeat(40) }, user)).entries.length, 0);
  assert.equal((await store.retrieve({ repo, projectId, branch: "feature", commit: "b".repeat(40), allowedCommits: [sha] }, user)).entries.length, 1);
});

test("retrieval isolates repositories/projects and filters paths, expiry and context budgets", async () => {
  const store = await fresh();
  await store.propose(input({ title: "API", paths: ["src/api"], tags: ["http"] }), user);
  await store.propose(input({ title: "UI", paths: ["src/ui"] }), user);
  await store.propose(input({ title: "Expired", expiresAt: 1 }), user);
  await store.propose(input({ repo: "/projects/elsewhere", title: "Other repo" }), { kind: "user" });
  await store.propose(input({ projectId: "p-other", title: "Other project" }), { kind: "user" });
  const selected = await store.retrieve({ repo, projectId, paths: ["src/api/routes.ts"], query: "HTTP contract", maxEntries: 1 }, run);
  assert.deepEqual(selected.entries.map((entry) => entry.title), ["API"]);
  assert.ok(selected.manifest.omitted.some((entry) => entry.reason === "outside task paths"));
  assert.ok(selected.manifest.omitted.some((entry) => entry.reason === "expired"));
  assert.equal(selected.manifest.included.length + selected.manifest.omitted.length, 3, "do not even expose IDs from another project/repository");
  await assert.rejects(store.retrieve({ repo: "/projects/elsewhere", projectId }, run), /repository scope mismatch/);
  const tooLarge = await store.propose(input({ title: "Long", body: "x".repeat(200) }), user);
  const small = await store.retrieve({ repo, projectId, maxChars: 128 }, run);
  assert.ok(small.manifest.omitted.some((entry) => entry.id === tooLarge.id && entry.reason === "context budget"));
});

test("whole-repository task ownership retrieves scoped paths without crossing project boundaries", async () => {
  const store = await fresh();
  const scoped = await store.propose(input({ paths: ["src/api"] }), user);
  await store.propose(input({ repo: "/projects/elsewhere", paths: ["src/api"] }), { kind: "user" });
  await store.propose(input({ projectId: "p-other", paths: ["src/api"] }), { kind: "user" });
  const query = { repo, projectId, paths: ["*"] };
  const selected = await store.retrieve(query, run);
  assert.deepEqual(selected.entries.map((entry) => entry.id), [scoped.id]);
  assert.equal(selected.manifest.omitted.length, 0, "out-of-scope identities stay invisible");
  assert.deepEqual((await store.resolveSelection(query, selected.manifest, run)).entries.map((entry) => entry.id), [scoped.id]);
});

test("deletion erases the entry's body; entries that saw it keep theirs, keep its origins, and can still cite it", async () => {
  const store = await fresh();
  const tainted: MemoryAuthority = { ...run, lockedDown: true, sourceTrust: "untrusted" };
  const original = await store.propose(input({ scope: "team", runId: "run-1", body: "SECRET ORIGINAL BODY" }), tainted);
  const summary = await store.propose(input({ scope: "team", runId: "run-1", body: "A worker's own note written with the original in context", derivedFrom: [{ id: original.id, revision: 1 }] }), coordinator);
  const checkpoint = await store.propose(input({ scope: "private", runId: "run-1", memberId: "worker", body: "Private progress", derivedFrom: [{ id: summary.id, revision: 1 }] }), { ...run, memberId: "worker" });
  await store.propose(input({ title: "Unrelated", body: "Keep me" }), user);
  await writeFile(`${store.file}.12345678-1234-1234-1234-123456789abc.tmp`, "SECRET CRASH-LEFT SNAPSHOT");
  const removed = await store.remove(original.id, 1, { kind: "user", repo });
  assert.equal(removed.status, "deleted");
  const raw = await readFile(store.file, "utf8");
  assert.ok(!raw.includes("SECRET"), "the deleted body and the crash-left snapshot are gone");
  const stored = readEntries(store.file);
  // "Derived from" records what was in a member's context, not text copied from it: a deletion must not
  // cascade through every checkpoint and note of every run that saw the entry.
  assert.equal(stored.find((entry: { id: string }) => entry.id === summary.id).status, "proposed");
  assert.equal(stored.find((entry: { id: string }) => entry.id === checkpoint.id).status, "accepted");
  assert.ok(stored.find((entry: { id: string }) => entry.id === summary.id).origins.some((origin: { trust: string }) => origin.trust === "untrusted"), "inherited provenance survives the deletion");
  // A run that still holds the deleted reference in its recorded context can keep writing; it inherits the tombstone's origins.
  const later = await store.propose(input({ scope: "team", runId: "run-1", title: "Later note", body: "Written after the deletion", derivedFrom: [{ id: original.id, revision: 1 }] }), coordinator);
  assert.ok(later.origins.some((origin) => origin.trust === "untrusted" && origin.lockedDown));
  // The worker's checkpoint, written with the deleted entry in context, is still its own retrievable record.
  assert.deepEqual((await store.retrieve({ repo, projectId, runId: "run-1", memberId: "worker" }, run)).entries.map((entry) => entry.title).sort(), [checkpoint.title, "Unrelated"].sort());
  assert.deepEqual(await readdir(join(store.file, "..")), ["memory.sqlite"], "there is no history/index/temp body left behind");
});

test("a user's edit keeps a proposal a proposal unless they accept it, and archiving a run retires only its private and team records", async () => {
  const store = await fresh();
  const proposal = await store.propose(input({ scope: "team", runId: "run-1", title: "Proposed convention" }), run);
  assert.equal(proposal.status, "proposed");
  const edited = await store.revise(proposal.id, proposal.revision, { title: "Proposed convention (typo fixed)" }, { kind: "user", repo });
  assert.equal(edited.status, "proposed", "fixing a typo is not an approval");
  const accepted = await store.revise(edited.id, edited.revision, { tags: ["reviewed"] }, { kind: "user", repo }, { accept: true });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.acceptedBy, "user");
  const rule = await store.propose(input({ title: "User rule" }), user);
  await store.propose(input({ scope: "private", runId: "run-1", memberId: "worker", title: "Checkpoint" }), { ...run, memberId: "worker" });
  await store.propose(input({ scope: "team", runId: "run-2", title: "Other run's note" }), { ...run, runId: "run-2" });
  assert.equal(await store.purgeRun("run-1"), 2);
  assert.deepEqual((await store.list({ repo, projectId, runId: "run-1", memberId: "worker" }, run)).filter((entry) => entry.scope !== "project"), [], "run-1's private and team records are retired");
  assert.deepEqual((await store.list({ repo, projectId, runId: "run-2", scope: "team" }, { ...run, runId: "run-2" })).map((entry) => entry.title), ["Other run's note"], "another run's records are untouched");
  assert.equal((await store.list({ repo, projectId, scope: "project" }, { kind: "user", repo })).some((entry) => entry.id === rule.id), true);
});

test("runs cannot overwrite user rules or another run's proposals", async () => {
  const store = await fresh();
  const rule = await store.propose(input(), user);
  await assert.rejects(store.revise(rule.id, rule.revision, { body: "override" }, run), /user-authored rule/);
  const proposed = await store.propose(input(), run);
  assert.equal(proposed.runId, "run-1", "the host binds project proposals to their originating run");
  await assert.rejects(store.accept(proposed.id, proposed.revision, { ...run, runId: "run-2" }, verified), /another run/);
});

test("invalid paths, scopes, oversized content and source versions fail before persistence", async () => {
  const store = await fresh();
  await assert.rejects(store.propose(input({ paths: ["../escape"] }), user), /inside the repository/);
  await assert.rejects(store.propose(input({ body: "x".repeat(16_001) }), user), /body/);
  await assert.rejects(store.propose(input({ scope: "private" }), user), /run ID/);
  const source = await store.propose(input(), user);
  await assert.rejects(store.propose(input({ derivedFrom: [{ id: source.id, revision: 9 }] }), user), MemoryConflictError);
  await assert.rejects(store.revise(source.id, 1, { derivedFrom: [{ id: source.id, revision: 1 }] }, user), /derive from itself/);
});

function readEntries(file: string): any[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT document FROM memories").all().map((row) => JSON.parse(String(row.document))); }
  finally { db.close(); }
}
