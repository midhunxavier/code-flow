import { test } from "node:test";
import assert from "node:assert/strict";
import { presentFolders, workbenchFolders } from "../ui/workbench-folders.js";
import type { RunSummary } from "../ui/types.js";

const run = (id: string, extra: Partial<RunSummary> = {}) => ({ id, task: id, repo: "/repo", worktrees: [{ name: "build", branch: `codeflow/${id}/build`, path: `/repo/.worktrees/${id}/build` }], ...extra }) as RunSummary;

test("the repository tools list one folder per worktree, without removed archived worktrees", () => {
  const live = run("live"), kept = run("kept", { archived: true }), removed = run("removed", { archived: true });
  const folders = workbenchFolders([live, kept, removed], new Set([kept.worktrees[0]!.path]));
  assert.deepEqual(folders.map((folder) => folder.run.id), ["live", "kept"]);
  assert.equal(new Set(folders.map((folder) => folder.path)).size, folders.length);
});

test("a chat and its provider tab share one folder, owned by the chat", () => {
  const solo = [{ name: "solo", branch: "codeflow/chat/solo", path: "/repo/.worktrees/chat/solo" }];
  const tab = run("tab", { worktrees: solo, chatLink: { workspaceId: "chat", kind: "tab", sourceId: "chat" } }), chat = run("chat", { worktrees: solo });
  const folders = workbenchFolders([tab, chat], new Set());
  assert.equal(folders.length, 1); assert.equal(folders[0]!.run.id, "chat");
  assert.equal(workbenchFolders([chat, tab], new Set())[0]!.run.id, "chat");
});

test("folder presence lists each repository's worktree root and only the run folders still there", async () => {
  const disk: Record<string, string[]> = { "/repo/.worktrees": ["kept", "other"], "/repo/.worktrees/kept": ["build"], "/repo/.worktrees/other": [] };
  const requests: string[] = [];
  const present = await presentFolders(["/repo/.worktrees/kept/build", "/repo/.worktrees/gone/build", "/repo/.worktrees/other/build", "/repo/.worktrees/kept/build"], async (path) => { requests.push(path); return disk[path] ? { names: disk[path]!, truncated: false } : null; });
  assert.deepEqual([...present], ["/repo/.worktrees/kept/build"]);
  assert.deepEqual(requests.sort(), ["/repo/.worktrees", "/repo/.worktrees/kept", "/repo/.worktrees/other"], "a removed run folder is not requested");
  assert.deepEqual([...await presentFolders(["/elsewhere/a/b"], async () => null)], []);
});
