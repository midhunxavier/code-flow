import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalSharedPath, sharedCanReadRun, sharedCoverageProjection, sharedDiffProjection, sharedEventProjection, sharedProjectProjection, sharedProjectRole, sharedRoutePolicy, sharedRunProjection } from "../src/shared-access.js";
import type { Run, RunEvent } from "../src/engine.js";
import type { SharedPrincipal } from "../src/shared-accounts.js";

const policy = (method: string, path: string) => sharedRoutePolicy(method, canonicalSharedPath(path).parts);
test("shared route policy allows only exact human review routes and version aliases", () => {
  for (const prefix of ["/api", "/api/v1"]) {
    for (const path of ["/runs/one", "/runs/one/events", "/runs/one/export", "/runs/one/diff", "/runs/one/review-coverage", "/runs/one/collaboration"]) assert.equal(policy("GET", prefix + path), "run-read");
    for (const path of ["/runs/one/review-coverage", "/runs/one/collaboration"]) assert.equal(policy("POST", prefix + path), "run-review");
    assert.equal(policy("GET", prefix + "/runs?project=one"), "run-list"); assert.equal(policy("GET", prefix + "/events"), "run-list"); assert.equal(policy("GET", prefix + "/projects"), "project-list");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) for (const path of ["/workspace/file", "/workspace/search", "/workspace/context", "/projects/one/conventions", "/projects/one/memory", "/projects/one/conventions/publish", "/fs", "/file", "/tree", "/check", "/doctor", "/doctor/dependencies", "/health", "/models", "/agents", "/notes", "/serve", "/shells", "/preview", "/snapshot", "/remote", "/remote/devices", "/integrations", "/notifications", "/automations", "/approvals", "/team-capabilities", "/team-evaluations", "/team-rollout", "/stats", "/disk", "/maintenance/retention", "/deferred-runs", "/readiness", "/verification", "/github/issues", "/accounts", "/filtered-tasks", "/filtered-tasks/id/import", "/remote-workers", "/code-hosts", "/coordinated-changes", "/extensions", "/acp-connections", "/acp-connections/check", "/new-route", "/runs/one/export/extra"]) assert.equal(policy(method, prefix + path), "owner", `${method} ${prefix}${path}`);
    for (const operation of ["notes", "answer", "human-rework", "triage", "team-plan", "rerun-tasks", "followups", "fork", "resume", "cancel", "pause", "seen", "archive", "priority", "project", "merge", "validate-merge", "merge-pr", "pr", "push-pr", "post-review", "watch", "launch-profiles", "worktrees/tree/serve", "worktrees/tree/open"]) for (const method of ["GET", "POST", "DELETE"]) assert.equal(policy(method, `${prefix}/runs/one/${operation}`), "owner");
  }
});
test("canonicalization rejects ambiguous traversal, encoded separators, double encoding and appended route segments", () => {
  for (const path of ["/api/runs/../accounts", "/api/runs/%2e%2e/accounts", "/api/runs%2fone", "/api/runs%5cone", "/api/%252e%252e/accounts", "/api/runs//one", "/api/runs/one/", "/api/runs/one%00", "/api/runs/one%0a", "/api\\runs", "https://host/api/runs", "/api/runs/#extra"]) assert.throws(() => canonicalSharedPath(path), /path/);
  assert.deepEqual(canonicalSharedPath("/api/v1/runs/one?ignored=a%2fb").parts, ["api", "runs", "one"]);
  assert.equal(policy("GET", "/api/runs/one/collaboration/extra"), "owner"); assert.equal(policy("POST", "/api/runs/one/export"), "owner");
});
test("project assignment requires current exact membership; removed or ambiguous legacy runs remain inaccessible", () => {
  const identity: SharedPrincipal = { kind: "shared", userId: "user", username: "viewer", displayName: "Viewer", revision: 1, roles: { one: "viewer" } };
  const projects = [{ id: "one", name: "One", repos: ["/repo/one"], createdAt: 1 }, { id: "two", name: "Two", repos: ["/repo/two"], createdAt: 1 }];
  assert.equal(sharedCanReadRun(identity, { pattern: "solo", project: "one", repo: "/repo/one" }, projects), true);
  assert.equal(sharedCanReadRun(identity, { pattern: "solo", project: "one", repo: "/repo/one", projectTeam: { teamId: "private-team" } as import("../src/engine.js").Run["projectTeam"] }, projects), false);
  for (const run of [{ project: "two", repo: "/repo/two" }, { project: "one", repo: "/repo/two" }, { project: "missing", repo: "/repo/one" }]) assert.equal(sharedCanReadRun(identity, { ...run, pattern: "solo" }, projects), false);
  assert.equal(sharedCanReadRun(identity, { pattern: "solo", repo: "/repo/one" }, projects), true); assert.equal(sharedCanReadRun(identity, { pattern: "solo", repo: "/repo/one" }, [...projects, { ...projects[1]!, repos: ["/repo/one"] }]), false);
  assert.deepEqual(sharedProjectProjection({ ...projects[0]!, defaults: { pattern: "solo", teams: {} } }), { id: "one", name: "One", createdAt: 1 });
});
test("shared projections whitelist results while excluding private agent state, credentials, prompts and unauthorized parent links", () => {
  const run = { id: "one", project: "project", pattern: "solo", task: "Shared result", status: "done", createdAt: 1, repo: "/private/repo", worktreeDir: "/private/worktrees", worktrees: [{ name: "result", branch: "branch", path: "/private/tree", capability: "should-never-leak" }], parentRunId: "other", notes: [{ text: "private-note" }], memoryManifest: { text: "private-memory" }, loop: { setup: "private-command", agentContainer: { authVolume: "private-auth" } }, team: { capability: "private-capability" }, summary: "password=classified", steps: [{ id: "step", kind: "agent", title: "Build", role: "agent", status: "done", startedAt: 1, sessionId: "private-session", contextManifest: { prompt: "private-prompt" }, finalText: "Finished" }], verification: { version: 1, profile: "required", state: "verified", startedAt: 1, endedAt: 2, checks: [{ check: { id: "test", title: "Unit", kind: "unit", command: "private-command", required: true }, diagnosis: "passed", attempts: [{ output: "private-log" }] }], requirements: [{ id: "r1", description: "Requirement", covered: true, missing: [] }] } } as unknown as Run;
  const projected = sharedRunProjection(run); const source = JSON.stringify(projected);
  for (const hidden of ["/private/", "private-", "should-never-leak", "classified", "sessionId", "capability", "authVolume", "parentRunId"]) assert.equal(source.includes(hidden), false, hidden);
  assert.equal(projected.steps?.[0]!.finalText, "Finished"); assert.equal(sharedRunProjection(run, (id) => id === "other").parentRunId, "other");
  assert.equal(sharedEventProjection({ runId: "one", seq: 2, ts: 2, type: "agent", stepId: "step", event: { kind: "status", text: "private-prompt" } }, () => true), undefined);
  assert.equal(sharedEventProjection({ runId: "one", seq: 2, ts: 2, type: "log", level: "info", text: "private" }, () => true), undefined);
  assert.equal(sharedEventProjection({ runId: "one", seq: 2, ts: 2, type: "run", run }, () => false), undefined);
  assert.equal(JSON.stringify(sharedEventProjection({ runId: "one", seq: 2, ts: 2, type: "run", run }, () => true)).includes("private-session"), false);
});
test("shared diff and coverage projections omit credential files and private human rework notes", () => {
  const file = { status: "modified" as const, additions: 1, deletions: 1, binary: false, patch: "private arbitrary text", truncated: false };
  assert.deepEqual(sharedDiffProjection([{ ...file, path: ".env" }, { ...file, path: "renamed.txt", oldPath: ".npmrc" }, { ...file, path: "src/answer.ts" }]).map((file) => file.path), ["src/answer.ts"]);
  assert.deepEqual(sharedCoverageProjection({ head: "a".repeat(40), files: [".env", "src/answer.ts"], reviewed: [".env", "src/answer.ts"] }), { scope: "shared-reviewable-files", omittedCount: 1, head: "a".repeat(40), files: ["src/answer.ts"], reviewed: ["src/answer.ts"], stale: false, workingChanges: false, coverage: { changed: 1, reviewed: 1, percent: 100 } });
});
test("shared result projections bound UTF-8 text and recent steps with explicit truncation evidence", () => {
  const step = { id: "step", kind: "agent", title: "Build", role: "agent", status: "done", startedAt: 1, finalText: "🦉".repeat(3000), error: "e".repeat(5000) };
  const run = { id: "run", task: "🦉".repeat(7000), summary: "s".repeat(40000), error: "e".repeat(5000), worktrees: [], steps: Array.from({ length: 205 }, (_, index) => ({ ...step, id: String(index) })) } as unknown as Run;
  const value = sharedRunProjection(run); assert.equal(value.steps!.length, 200); assert.equal(value.steps![0]!.id, "5");
  assert.deepEqual(value.truncation, { task: true, summary: true, error: true, omittedSteps: 5 }); assert.ok(Buffer.byteLength(value.task) <= 24 * 1024); assert.ok(Buffer.byteLength(value.summary!) <= 32 * 1024); assert.ok(Buffer.byteLength(value.error!) <= 4 * 1024);
  assert.ok(Buffer.byteLength(value.steps![0]!.finalText!) <= 8 * 1024); assert.ok(Buffer.byteLength(value.steps![0]!.error!) <= 4 * 1024); assert.equal(value.steps![0]!.finalTextTruncated, true); assert.equal(value.task.includes("�"), false, "truncation preserves complete UTF-8 characters");
});
test("sharedProjectRole returns the raw assigned role for rank checks and contributors read their projects like viewers", () => {
  const identity: SharedPrincipal = { kind: "shared", userId: "user", username: "builder", displayName: "Builder", revision: 1, roles: { one: "contributor", two: "maintainer" } };
  assert.equal(sharedProjectRole(identity, "one"), "contributor"); assert.equal(sharedProjectRole(identity, "two"), "maintainer"); assert.equal(sharedProjectRole(identity, "three"), undefined); assert.equal(sharedProjectRole(identity, undefined), undefined); assert.equal(sharedProjectRole(identity, "toString"), undefined, "inherited object keys never grant a role");
  const projects = [{ id: "one", name: "One", repos: ["/repo/one"], createdAt: 1 }, { id: "three", name: "Three", repos: ["/repo/three"], createdAt: 1 }];
  assert.equal(sharedCanReadRun(identity, { pattern: "solo", project: "one", repo: "/repo/one" }, projects), true); assert.equal(sharedCanReadRun(identity, { pattern: "solo", project: "three", repo: "/repo/three" }, projects), false);
});
