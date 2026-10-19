import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { approveLiveAcpRequest } from "../scripts/acp-live-approval.js";
import type { AgentApprovalRequest } from "../src/adapters/types.js";

test("live ACP acceptance approves only task files and the exact check, including native Cline inputs", () => {
  const cwd = resolve("test-worktree"), trees = [{ path: cwd }];
  const edit: AgentApprovalRequest = { id: "1", kind: "file-change", cwd, reason: "editor: slugify.mjs", command: JSON.stringify({ path: "slugify.mjs", old_text: "old", new_text: "new" }) };
  const check: AgentApprovalRequest = { id: "2", kind: "command", cwd, reason: "run_commands: node --test", command: JSON.stringify({ commands: ["node --test"] }) };
  for (const request of [edit, check, { ...edit, command: "", paths: ["session-proof.txt"] }, { ...check, command: "node --test" }]) assert.equal(approveLiveAcpRequest(request, trees, "acp:cline"), true);
  for (const request of [
    { ...edit, cwd: resolve("elsewhere") }, { ...edit, cwd: undefined },
    { ...edit, command: JSON.stringify({ path: "../slugify.mjs" }) },
    { ...edit, command: JSON.stringify({ path: "slugify.test.mjs" }) },
    { ...edit, command: JSON.stringify({ path: "slugify.mjs", command: "unexpected" }) },
    { ...edit, command: '{"path":"slugify.mjs"' },
    { ...edit, paths: ["slugify.mjs", "slugify.test.mjs"] },
    { ...edit, reason: "unrecognized tool" },
    { ...check, command: JSON.stringify({ commands: ["node --test", "other command"] }) },
    { ...check, command: JSON.stringify({ commands: ["node --test"], cwd: "elsewhere" }) },
    { ...check, command: "node --test && other-command" },
  ]) assert.equal(approveLiveAcpRequest(request, trees, "acp:cline"), false, JSON.stringify(request));
  assert.equal(approveLiveAcpRequest(edit, trees, "acp:kilo"), false, "Cline input handling is specific to its native tools");
});

test("native Cline may read only the acceptance task files, including tests it cannot edit", () => {
  const cwd = resolve("test-worktree"), trees = [{ path: cwd }];
  const read: AgentApprovalRequest = { id: "1", kind: "command", cwd, reason: "read_files: task files" };
  const request = (files: unknown[]) => ({ ...read, command: JSON.stringify({ files }) });
  assert.equal(approveLiveAcpRequest(request([{ path: resolve(cwd, "slugify.mjs") }, { path: "slugify.test.mjs", start_line: 1, end_line: 20 }]), trees, "acp:cline"), true);
  assert.equal(approveLiveAcpRequest(request([{ path: "session-proof.txt" }]), trees, "acp:cline"), true);
  for (const files of [[], [null], [{ path: "../slugify.mjs" }], [{ path: "/etc/passwd" }], [{ path: "slugify.mjs" }, { path: "unrelated.txt" }], [{ path: "slugify.mjs", command: "other" }]]) {
    assert.equal(approveLiveAcpRequest(request(files), trees, "acp:cline"), false);
  }
  assert.equal(approveLiveAcpRequest(request([{ path: "slugify.mjs" }]), trees, "acp:kilo"), false);
  assert.equal(approveLiveAcpRequest({ ...request([{ path: "slugify.test.mjs" }]), kind: "file-change" }, trees, "acp:cline"), false);
});

test("native Cline search approval is limited to fixture names in the worktree", () => {
  const cwd = resolve("test-worktree"), trees = [{ path: cwd }];
  const search: AgentApprovalRequest = { id: "1", kind: "command", cwd, reason: "search_codebase: slugify" };
  for (const [input, allowed] of [
    [{ queries: ["slugify"] }, true], [{ queries: ["slugify.test.mjs", "session-proof.txt"] }, true],
    [{ queries: [] }, false], [{ queries: ["secret"] }, false], [{ queries: [{ pattern: "slugify" }] }, false],
    [{ queries: ["slugify"], path: ".." }, false],
  ] as const) assert.equal(approveLiveAcpRequest({ ...search, command: JSON.stringify(input) }, trees, "acp:cline"), allowed);
});
