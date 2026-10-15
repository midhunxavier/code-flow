import { homedir } from "node:os";
import { join } from "node:path";

/** Where run logs live. */
export const CODEFLOW_HOME = process.env.CODEFLOW_HOME ?? join(homedir(), ".codeflow");

/**
 * Where worktrees are created. A relative path is resolved inside each repo (and added to
 * .git/info/exclude); an absolute path puts them outside the repo instead.
 */
export const WORKTREE_DIR = process.env.CODEFLOW_WORKTREE_DIR ?? ".worktrees";

export const PORT = Number(process.env.PORT ?? 4317);

/** Diffs larger than this are truncated before being handed to another agent. */
export const MAX_DIFF_CHARS = Number(process.env.CODEFLOW_MAX_DIFF_CHARS ?? 60_000);

/** Per agent-step timeout. */
export const STEP_TIMEOUT_MS = Number(process.env.CODEFLOW_STEP_TIMEOUT_MIN ?? 30) * 60_000;
