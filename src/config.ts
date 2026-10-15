import { homedir } from "node:os";
import { join } from "node:path";

/** Where worktrees and run logs live. Kept outside your repos on purpose. */
export const CODEFLOW_HOME = process.env.CODEFLOW_HOME ?? join(homedir(), ".codeflow");

export const PORT = Number(process.env.PORT ?? 4317);

/** Diffs larger than this are truncated before being handed to another agent. */
export const MAX_DIFF_CHARS = Number(process.env.CODEFLOW_MAX_DIFF_CHARS ?? 60_000);

/** Per agent-step timeout. */
export const STEP_TIMEOUT_MS = Number(process.env.CODEFLOW_STEP_TIMEOUT_MIN ?? 30) * 60_000;
