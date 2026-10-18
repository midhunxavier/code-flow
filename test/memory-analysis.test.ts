import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProjectMemory } from "../src/memory-analysis.js";
import type { MemoryEntry } from "../src/memory.js";

let repo: string;
let base: string;
let head: string;
let diverged: string;
const projectId = "analysis-project";
const now = Date.now();
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
function entry(id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id, revision: 1, scope: "project", repo, projectId, title: `Guidance ${id}`, body: `Guidance about ${id}.`,
    status: "accepted", acceptedBy: "user", tags: [], paths: [], applicability: { kind: "repository" }, derivedFrom: [], sourceRefs: [],
    origins: [{ kind: "user", trust: "trusted", lockedDown: false, private: false }], createdAt: now - 10_000, updatedAt: now,
    ...patch,
  };
}
before(async () => {
  repo = await mkdtemp(join(tmpdir(), "codeflow-memory-analysis-"));
  git("init", "-q", "-b", "main");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src/config.ts"), "export const enabled = true;\n");
  await writeFile(join(repo, "README.md"), "Project guidance\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "other");
  await writeFile(join(repo, "other.txt"), "Other branch\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "other branch");
  diverged = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  await writeFile(join(repo, "src/config.ts"), "export const enabled = false;\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "change config");
  head = git("rev-parse", "HEAD");
});
after(() => rm(repo, { recursive: true, force: true }));

test("provenance uses directed revision references without recovering hidden or erased source text", async () => {
  const source = entry("source", { revision: 3, body: "Current source text" });
  const child = entry("child", { derivedFrom: [{ id: source.id, revision: 1 }, { id: "private", revision: 1 }, { id: "erased", revision: 1 }] });
  const grandchild = entry("grandchild", { derivedFrom: [{ id: child.id, revision: 1 }] });
  const result = await analyzeProjectMemory({ repo, projectId, entries: [source, child, grandchild,
    entry("private", { scope: "private", body: "SECRET PRIVATE BODY", title: "SECRET PRIVATE TITLE" }),
    entry("other-project", { projectId: "other", body: "SECRET OTHER PROJECT" }),
    entry("other-repo", { repo: repo + "-other", body: "SECRET OTHER REPO" }),
    entry("erased", { status: "deleted", body: "ERASED BODY" }),
  ] });
  assert.deepEqual(result.graph.edges.filter((edge) => edge.to === "child@1"), [
    { from: "source@1", to: "child@1" }, { from: "private@1", to: "child@1" }, { from: "erased@1", to: "child@1" },
  ]);
  assert.equal(result.graph.nodes.find((node) => node.key === "source@1")?.available, false);
  assert.equal(result.graph.nodes.find((node) => node.key === "source@3")?.available, true);
  assert.equal(result.graph.nodes.find((node) => node.key === "private@1")?.title, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|ERASED BODY/);
  const impact = result.deletionImpact.find((item) => item.id === "source")!;
  assert.deepEqual(impact.direct, [{ id: "child", revision: 1 }]);
  assert.deepEqual(impact.transitive, [{ id: "child", revision: 1 }, { id: "grandchild", revision: 1 }]);
  assert.match(impact.retained, /Derived entries retain their own text/);
  assert.match(impact.retained, /transcripts.*separate retention/);
});

test("cyclic provenance terminates and counts each downstream entry once", async () => {
  const result = await analyzeProjectMemory({ repo, projectId, entries: [
    entry("a", { derivedFrom: [{ id: "c", revision: 1 }] }),
    entry("b", { derivedFrom: [{ id: "a", revision: 1 }] }),
    entry("c", { derivedFrom: [{ id: "b", revision: 1 }] }),
  ] });
  assert.deepEqual(result.deletionImpact.find((item) => item.id === "a")?.transitive, [{ id: "b", revision: 1 }, { id: "c", revision: 1 }]);
});

test("freshness reports actual missing paths, branch ancestry, changed paths and current-revision feedback", async () => {
  const verification = (commit: string) => ({ passed: true, commit, merged: true, evidenceRefs: ["check:test"] });
  const result = await analyzeProjectMemory({ repo, projectId, now, entries: [
    entry("changed", { paths: ["src"], verification: verification(base) }),
    entry("same", { paths: ["README.md"], verification: verification(base) }),
    entry("missing", { paths: ["src/deleted.ts"] }),
    entry("wildcard", { paths: ["src/*.ts"] }),
    entry("branch", { applicability: { kind: "branch", branch: "other", commit: diverged } }),
    entry("missing-commit", { verification: verification("f".repeat(40)) }),
    entry("expired", { expiresAt: now - 1 }),
    entry("feedback", { revision: 2, feedback: [
      { id: "old", origin: "user", revision: 1, rating: "incorrect", at: now },
      { id: "new", origin: "user", revision: 2, rating: "stale", note: "Changed entrypoint", at: now },
    ] }),
    entry("old-feedback", { revision: 2, feedback: [{ id: "old", origin: "user", revision: 1, rating: "incorrect", at: now }] }),
  ] });
  assert.equal(result.git.head, head);
  assert.equal(result.git.branch, "main");
  const kinds = (id: string) => result.stale.find((item) => item.id === id)?.reasons.map((reason) => reason.kind) ?? [];
  assert.deepEqual(kinds("changed"), ["paths-changed"]);
  assert.match(result.stale.find((item) => item.id === "changed")!.reasons[0]!.detail, /does not prove it incorrect/);
  assert.deepEqual(kinds("same"), []);
  assert.deepEqual(kinds("missing"), ["missing-path"]);
  assert.deepEqual(kinds("wildcard"), ["missing-path"], "pathspec metacharacters are literal");
  assert.deepEqual(kinds("branch"), ["branch-mismatch", "commit-not-ancestor"]);
  assert.deepEqual(kinds("missing-commit"), ["commit-unavailable"]);
  assert.deepEqual(kinds("expired"), ["expired"]);
  assert.deepEqual(kinds("feedback"), ["feedback"]);
  assert.deepEqual(kinds("old-feedback"), []);
});

test("Git unavailable never invents missing files or ancestry and branch guidance is withheld", async () => {
  const unavailable = repo + "-missing";
  const result = await analyzeProjectMemory({ repo: unavailable, projectId, now, entries: [
    entry("safe", { repo: unavailable }),
    entry("path-bound", { repo: unavailable, paths: ["README.md"] }),
    entry("branch", { repo: unavailable, paths: ["missing.ts"], applicability: { kind: "branch", branch: "main", commit: base } }),
    entry("expired", { repo: unavailable, expiresAt: now - 1 }),
  ] });
  assert.equal(result.git.available, false);
  assert.deepEqual(result.stale.map((item) => item.id), ["expired"]);
  assert.deepEqual(result.onboarding.sourceRefs, [{ id: "safe", revision: 1 }]);
  assert.match(result.onboarding.reasons.find((item) => item.id === "branch")!.reason, /branch is unknown/);
  assert.match(result.onboarding.reasons.find((item) => item.id === "path-bound")!.reason, /unavailable/);
});

test("overlap flags exact normalized text and lexical similarity without pretending to resolve contradiction", async () => {
  const text = "Database connection retries exponential backoff bounded timeout jitter";
  const result = await analyzeProjectMemory({ repo, projectId, entries: [
    entry("one", { body: text }), entry("copy", { body: " Database  connection\nretries exponential backoff bounded timeout jitter " }),
    entry("similar", { body: `${text} failures` }), entry("opposite", { body: "Never configure retry behavior" }),
  ] });
  const between = (a: string, b: string) => result.duplicates.find((pair) => [pair.a.id, pair.b.id].includes(a) && [pair.a.id, pair.b.id].includes(b));
  assert.equal(between("one", "copy")?.kind, "exact");
  assert.equal(between("one", "similar")?.kind, "lexical-overlap");
  assert.ok(between("one", "similar")!.similarity < 1);
  assert.equal(between("one", "opposite"), undefined);
  assert.ok(result.notes.some((note) => note.includes("does not detect semantic contradictions")));
});

test("onboarding curates only accepted fresh guidance with exclusively trusted user origins", async () => {
  const result = await analyzeProjectMemory({ repo, projectId, now, entries: [
    entry("safe", { revision: 4, title: "A setup", body: "Run the local setup command." }),
    entry("branch-safe", { title: "B branch", applicability: { kind: "branch", branch: "main", commit: head } }),
    entry("proposal", { status: "proposed", acceptedBy: undefined }),
    entry("verification", { acceptedBy: "verification" }),
    entry("run", { origins: [{ kind: "run", trust: "trusted", lockedDown: false, private: false }] }),
    entry("imported", { origins: [{ kind: "import", trust: "unknown", lockedDown: false, private: false }] }),
    entry("tainted", { origins: [{ kind: "user", trust: "trusted", lockedDown: false, private: false }, { kind: "run", trust: "untrusted", lockedDown: true, private: false }] }),
    entry("private-origin", { origins: [{ kind: "user", trust: "trusted", lockedDown: false, private: true }] }),
    entry("expired", { expiresAt: now - 1 }), entry("summary", { tags: ["onboarding-summary"] }),
  ] });
  assert.deepEqual(result.onboarding.sourceRefs, [{ id: "safe", revision: 4 }, { id: "branch-safe", revision: 1 }]);
  assert.equal(result.onboarding.omitted, 8);
  assert.match(result.onboarding.body, /Source: safe \(revision 4\)/);
  assert.match(result.onboarding.body, /Applies to branch main/);
  for (const id of ["proposal", "verification", "run", "imported", "tainted", "private-origin", "expired", "summary"]) assert.ok(result.onboarding.reasons.some((reason) => reason.id === id), id);
});

test("entry, graph, comparison and onboarding limits are explicit and deterministic", async () => {
  const entries = Array.from({ length: 520 }, (_, index) => entry(`entry-${index.toString().padStart(3, "0")}`, {
    body: `A unique instruction ${index} ${"bounded guidance ".repeat(700)}`,
    updatedAt: now - index,
    derivedFrom: Array.from({ length: 12 }, (_, source) => ({ id: `missing-${index}-${source}`, revision: 1 })),
  }));
  const result = await analyzeProjectMemory({ repo, projectId, entries });
  assert.equal(result.truncated, true);
  assert.equal(result.graph.nodes.filter((node) => node.available).length, 500);
  assert.equal(result.graph.edges.length, result.limits.references);
  assert.ok(result.graph.nodes.length <= 500 + result.limits.references);
  assert.ok(result.duplicates.length <= result.limits.duplicatePairs);
  assert.ok(result.onboarding.body.length <= result.limits.onboardingChars);
  assert.ok(result.onboarding.sourceRefs.length <= result.limits.onboardingEntries);
  assert.equal(result.onboarding.omitted, 520 - result.onboarding.sourceRefs.length);
  const again = await analyzeProjectMemory({ repo, projectId, entries, now });
  assert.deepEqual(again, result);
});

test("onboarding withholds path guidance beyond the evidence budget instead of silently treating it as fresh", async () => {
  const entries = Array.from({ length: 16 }, (_, index) => entry(`many-paths-${index}`, {
    updatedAt: now - index,
    paths: Array.from({ length: 64 }, (_, path) => `missing-${index}-${path}.ts`),
  }));
  entries.push(entry("unchecked-path", { updatedAt: now - 100, paths: ["README.md"] }));
  const result = await analyzeProjectMemory({ repo, projectId, entries });
  assert.equal(result.truncated, true);
  assert.equal(result.stale.some((item) => item.id === "unchecked-path"), false, "a skipped path is not asserted missing");
  assert.equal(result.onboarding.sourceRefs.some((item) => item.id === "unchecked-path"), false);
  assert.match(result.onboarding.reasons.find((item) => item.id === "unchecked-path")!.reason, /reached a limit/);
});
