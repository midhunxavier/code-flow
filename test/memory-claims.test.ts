import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMemoryClaims } from "../src/memory-claims.js";
import type { MemoryEntry } from "../src/memory.js";
const repo = "/repo", projectId = "project";
const entry = (id: string, body: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ id, revision: 3, scope: "project", repo, projectId, title: id, body, status: "accepted", tags: [], paths: [], applicability: { kind: "repository" }, derivedFrom: [], sourceRefs: [], origins: [{ kind: "user", trust: "trusted", lockedDown: false, private: false }], createdAt: 1, updatedAt: 2, ...patch });
const analyze = (...entries: MemoryEntry[]) => analyzeMemoryClaims({ repo, projectId, entries });
const facts = (value: unknown) => `\`\`\`codeflow-claims\n${JSON.stringify(value)}\n\`\`\``;

test("policy semantics recognize opposite instructions and paraphrases with source revisions and spans", () => {
  const a = entry("allow", "Always permit the guest requests."); const b = entry("deny", "Never allow guest requests."); const c = entry("equivalent", "Do not block guest requests.");
  const value = analyze(a, b, c); assert.equal(value.claims.length, 3); assert.equal(value.findings.filter((finding) => finding.kind === "contradiction").length, 2); assert.equal(value.findings.filter((finding) => finding.kind === "equivalent").length, 1);
  assert.deepEqual(value.findings[0]!.a, { id: "allow", revision: 3 }); assert.equal(value.findings[0]!.subject, "guest request"); assert.equal(a.body.slice(value.findings[0]!.left.evidence.start, value.findings[0]!.left.evidence.end), a.body); assert.equal(value.findings[0]!.left.evidence.method, "policy");
});
test("numeric meaning normalizes units and compares actual interval compatibility rather than unequal numbers", () => {
  const value = analyze(entry("a", "Set cache TTL to 5 minutes."), entry("b", "Cache time-to-live is 300 seconds."), entry("c", "Cache TTL is at most 200 seconds."), entry("d", "Cache TTL is at least 60 seconds."));
  assert.equal(value.claims.length, 4); assert.equal(value.findings.find((finding) => finding.a.id === "a" && finding.b.id === "b")!.kind, "equivalent"); assert.equal(value.findings.find((finding) => finding.a.id === "a" && finding.b.id === "c")!.kind, "contradiction"); assert.equal(value.findings.some((finding) => finding.a.id === "c" && finding.b.id === "d"), false, "overlapping ranges can both hold");
  const boundary = analyze(entry("less", "Timeout is < 1 second"), entry("atleast", "Timeout is >= 1000 ms")); assert.equal(boundary.findings[0]!.kind, "contradiction");
  assert.equal(analyze(entry("time", "Limit is 1 second"), entry("size", "Limit is 1 byte")).findings.length, 0, "dimensions are never compared");
});
test("explicit structured facts support boolean, exact settings and numeric ranges without interpreting instructions as code", () => {
  const a = entry("a", facts([{ subject: "guest requests", predicate: "allow", value: false }, { subject: "cache ttl", predicate: "setting", min: 5, max: 10, unit: "minutes" }, { subject: "package manager", predicate: "setting", value: "npm" }]));
  const b = entry("b", facts([{ subject: "guest requests", predicate: "permit", value: true }, { subject: "cache ttl", predicate: "setting", value: 4, unit: "minutes" }, { subject: "package manager", predicate: "setting", value: "pnpm" }]));
  const value = analyze(a, b); assert.equal(value.findings.length, 3); assert.ok(value.findings.every((finding) => finding.kind === "contradiction" && finding.left.evidence.method === "structured")); assert.equal(a.body.includes('"value":false'), true, "analysis never edits source guidance");
  assert.equal(analyze(entry("invalid", facts([{ subject: "x", predicate: "setting", value: 1, min: 2 }, { subject: "x", predicate: "setting", value: 1, unit: "unknown" }, { subject: "x", predicate: "setting", value: true, execute: "malicious" }]))).claims.length, 0);
});
test("scope and path/branch applicability prevent false contradictions across unrelated guidance", () => {
  const left = entry("left", "Never log passwords.", { paths: ["src/api"], applicability: { kind: "branch", branch: "main", commit: "a".repeat(40) } });
  const right = entry("right", "Always record passwords.", { paths: ["src/api/auth.ts"] }); assert.equal(analyze(left, right).findings.length, 1);
  for (const patch of [{ paths: ["src/web"] }, { applicability: { kind: "branch" as const, branch: "other" } }, { applicability: { kind: "branch" as const, branch: "main", commit: "b".repeat(40) } }, { scope: "private" as const }, { projectId: "other" }, { repo: "/other" }, { status: "deleted" as const }]) assert.equal(analyze(left, { ...right, ...patch }).findings.length, 0);
});
test("unsupported qualifiers and compound prose stay unsupported and contradictions within one entry remain visible", () => {
  const value = analyze(entry("conditional", "Allow guest requests if signed.\nNever allow guest requests when unsigned.\nUse cache and encrypt data.\nAllow guest requests. Use TLS.")); assert.equal(value.claims.length, 0); assert.equal(value.unsupported, 4); assert.match(value.method, /unsupported prose/i);
  const intra = analyze(entry("inconsistent", "Always allow guest requests.\nNever permit guest requests.")); assert.equal(intra.findings.length, 1); assert.equal(intra.findings[0]!.a.id, intra.findings[0]!.b.id);
});
test("claim count, comparison work, source snippets and bodies have explicit hard limits", () => {
  const many = analyze(...Array.from({ length: 501 }, (_, index) => entry(String(index), "Always allow guest requests."))); assert.equal(many.inspectedEntries, 500); assert.equal(many.findings.length, 100); assert.equal(many.truncated, true);
  const oversized = analyze(entry("large", "Unrecognized prose\n".repeat(2000))); assert.equal(oversized.truncated, true); assert.ok(oversized.claims.every((claim) => claim.evidence.text.length <= oversized.limits.snippetChars));
  const tooManyFacts = analyze(entry("facts", facts(Array.from({ length: 13 }, () => ({ subject: "x", predicate: "allow", value: true }))))); assert.equal(tooManyFacts.truncated, true); assert.equal(tooManyFacts.claims.length, 0);
});
