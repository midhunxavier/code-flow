import { resolve } from "node:path";
import type { AgentApprovalRequest } from "../src/adapters/types.js";

/** Narrow allowlist for the opt-in acceptance task, never used for product approvals. */
export function approveLiveAcpRequest(request: AgentApprovalRequest, worktrees: { path: string }[], agent: string): boolean {
  const tree = worktrees.find((tree) => resolve(tree.path) === resolve(request.cwd ?? ""));
  if (!tree || !request.cwd) return false;
  let paths = request.paths ?? [];
  let command = request.command;
  // Native Cline omits ACP locations and requests approval for reads as well.
  // The adapter retains that JSON in the approval description.
  if (agent === "acp:cline") {
    let input;
    try { input = JSON.parse(request.command ?? ""); } catch { /* Plain commands use the normal check below. */ }
    if (input && typeof input === "object" && !Array.isArray(input)) {
      if (request.kind === "command" && request.reason?.startsWith("read_files:") && Object.keys(input).length === 1 && Array.isArray(input.files)) {
        return input.files.length > 0 && input.files.every((file: any) => file && typeof file.path === "string"
          && Object.keys(file).every((key) => ["path", "start_line", "end_line"].includes(key))
          && ["slugify.mjs", "slugify.test.mjs", "session-proof.txt"].some((name) => resolve(tree.path, name) === resolve(tree.path, file.path)));
      }
      if (!paths.length && request.kind === "file-change" && request.reason?.startsWith("editor:")
        && typeof input.path === "string" && Object.keys(input).every((key) => ["path", "old_text", "new_text", "insert_line"].includes(key))) paths = [input.path];
      if (request.kind === "command" && request.reason?.startsWith("run_commands:")
        && Object.keys(input).length === 1 && Array.isArray(input.commands) && input.commands.length === 1 && typeof input.commands[0] === "string") command = input.commands[0];
    }
  }
  return (request.kind === "file-change" && paths.length > 0 && paths.every((path) => ["slugify.mjs", "session-proof.txt"].some((name) => resolve(tree.path, name) === resolve(tree.path, path))))
    || (request.kind === "command" && command?.trim() === "node --test");
}
