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
