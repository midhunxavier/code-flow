import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shells, ShellInfo } from "../src/shell.js";
import type { SharedUser } from "../src/shared-accounts.js";
import type { CollabStore } from "../src/collab/store.js";
import type { RunnerManager } from "../src/collab/runner.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-account-cleanup-"))); process.env.CODEFLOW_HOME = root;
const { TeamTerminals } = await import("../src/collab/terminals.js");
const { HostExecution } = await import("../src/collab/host-execution.js");
const { memberActor, ownerActor } = await import("../src/collab/store.js");
after(() => rmSync(root, { recursive: true, force: true }));

test("account removal closes live terminals and clears even deleted-project grants without losing attribution", async () => {
  const repo = join(root, "repo"); mkdirSync(repo); const file = join(root, "terminals.json");
  writeFileSync(file, JSON.stringify({ version: 1, revision: 1, grants: ["project", "gone-project"].map(projectId => ({ projectId, enabled: true, userIds: ["u-leaver", "u-retained"] })), audit: [] }));
  const user: SharedUser = { id: "u-leaver", username: "leaver", displayName: "Original person", revision: 1, enabled: true, roles: { project: "contributor" }, createdAt: 1, updatedAt: 1 };
  const running = new Map<string, ShellInfo>(), closed: string[] = [];
  const shells = { interactive: async () => true, open: async (cwd: string) => { const info = { id: "shell1", cwd, status: "running", startedAt: 1, interactive: true } as ShellInfo; running.set(info.id, info); return info; }, get: (id: string) => running.get(id), close: (id: string) => { closed.push(id); running.delete(id); }, closeAll: () => running.clear() } as unknown as Shells;
  const options = { file, shells, users: () => [user], projectRepos: (id: string) => id === "project" ? [repo] : undefined, resolveRepo: () => repo, enabled: () => true, changed: () => {} };
  const terminals = new TeamTerminals(options); await terminals.load();
  try {
    const actor = memberActor({ ...user, userId: user.id }, "browser"); const shell = await terminals.open(actor, { projectId: "project", repository: "app", cols: 80, rows: 24 }, () => {});
    await terminals.removeAccount(user.id); assert.deepEqual(closed, [shell.id]); assert.equal(terminals.active(), 0);
    const stored = JSON.parse(readFileSync(file, "utf8")); assert.deepEqual(stored.grants.map((g: any) => g.userIds), [["u-retained"], ["u-retained"]]); assert.equal(stored.audit[0].session.displayName, "Original person"); assert.equal(stored.audit[0].session.userId, user.id); assert.equal(stored.audit.at(-1).action, "closed");
    await terminals.removeAccount(user.id); assert.deepEqual(closed, [shell.id], "cleanup retry is harmless");
  } finally { await terminals.close(); }
  const restored = new TeamTerminals(options); await restored.load(); assert.equal(restored.active(), 0); await restored.close();
});

test("account removal cancels queued host work, clears unavailable-project policies and preserves historical snapshots", async () => {
  const dir = join(root, "host"); mkdirSync(dir); const file = join(dir, "queue.json");
  const policy = { projectId: "project", enabled: true, userIds: ["u-leaver", "u-retained"], agent: "claude", trust: "safe", maxMinutes: 5, maxSteps: 5 };
  const job = { id: "h-0000000000000001", taskId: "task", projectId: "project", userId: "u-leaver", username: "leaver", displayName: "Original person", state: "queued", createdAt: 1, policy, repo: root, contentHash: "a".repeat(64) };
  writeFileSync(file, JSON.stringify({ version: 1, revision: 1, concurrency: 1, policies: [policy, { ...policy, projectId: "gone-project" }], jobs: [job, { ...job, id: "h-0000000000000002", state: "finished", endedAt: 2 }] }));
  let starts = 0;
  const options = { dir, store: { hostExecutionChanged() {} } as unknown as CollabStore, manager: { start() { starts++; throw new Error("Deleted-account jobs must never start"); }, list: () => [] } as unknown as RunnerManager, members: () => [], projectRepos: (id: string) => id === "project" ? [root] : undefined, resolveRepo: () => root, enabled: () => true, findPattern: () => undefined, availableAgents: async () => [] };
  const queue = new HostExecution(options); await queue.load();
  try {
    await queue.removeAccount("u-leaver"); const stored = JSON.parse(readFileSync(file, "utf8")); assert.deepEqual(stored.policies.map((p: any) => p.userIds), [["u-retained"], ["u-retained"]]);
    assert.deepEqual(stored.jobs.map((j: any) => j.state), ["cancelled", "finished"]); assert.ok(stored.jobs[0].endedAt); assert.equal(stored.jobs[0].displayName, "Original person"); assert.ok(stored.jobs.every((j: any) => j.policy.userIds.includes("u-leaver")), "historical grants remain valid snapshots");
    await queue.tick(); await queue.removeAccount("u-leaver"); assert.equal(starts, 0);
  } finally { await queue.close(); }
  const restored = new HostExecution(options); await restored.load(); assert.deepEqual(restored.view(ownerActor()).jobs.map(j => j.state), ["cancelled", "finished"]); await restored.close();
});
