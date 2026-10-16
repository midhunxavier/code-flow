import { homedir } from "node:os";
import { join } from "node:path";

/** Where run logs live. */
export const CODEFLOW_HOME = process.env.CODEFLOW_HOME ?? join(homedir(), ".codeflow");

/** The longest delay setTimeout takes; anything longer (or NaN) fires after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

const warned = new Set<string>();

/**
 * A number from the environment, or `fallback` when it's unset, not a number, or out of range
 * (with a warning, once): `Number("30m")` is NaN, and a NaN timeout fires after 1 ms.
 */
export function envNumber(name: string, fallback: number, range: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  const { min = -Infinity, max = Infinity } = range;
  if (!Number.isFinite(value) || value < min || value > max) {
    if (!warned.has(name)) {
      warned.add(name);
      const bounds = [min > -Infinity ? `at least ${min}` : "", max < Infinity ? `at most ${max}` : ""].filter(Boolean).join(", ");
      console.warn(`code-flow: ignoring ${name}=${JSON.stringify(raw)} (${bounds ? `must be a number, ${bounds}` : "not a number"}); using ${fallback}`);
    }
    return fallback;
  }
  return value;
}

/** A delay setTimeout honours: clamped to [min, ~24.8 days]; NaN becomes the maximum. */
export function timerMs(ms: number, min = 0): number {
  return Number.isFinite(ms) ? Math.min(MAX_TIMER_MS, Math.max(min, ms)) : MAX_TIMER_MS;
}

/**
 * Where worktrees are created. A relative path is resolved inside each repo (and added to
 * .git/info/exclude); an absolute path puts them outside the repo instead.
 */
export const WORKTREE_DIR = process.env.CODEFLOW_WORKTREE_DIR ?? ".worktrees";

export const PORT = envNumber("PORT", 4317, { min: 1, max: 65_535 });

/** Diffs larger than this are truncated before being handed to another agent. */
export const MAX_DIFF_CHARS = envNumber("CODEFLOW_MAX_DIFF_CHARS", 60_000, { min: 1_000 });

/** Per agent-step timeout. */
export const STEP_TIMEOUT_MS = timerMs(envNumber("CODEFLOW_STEP_TIMEOUT_MIN", 30, { min: 0.01, max: 24 * 60 }) * 60_000);

/**
 * An agent CLI that prints nothing for this long is stuck (a login prompt, a stalled network,
 * a hook that never returns) and is stopped. Generous: a long test run inside a turn is silent.
 */
export const STEP_IDLE_MS = timerMs(envNumber("CODEFLOW_STEP_IDLE_MIN", 15, { min: 0.01, max: 24 * 60 }) * 60_000);

/**
 * How code-flow drives Codex: "app-server" (JSON-RPC; your messages reach a turn while it runs),
 * "exec" (one `codex exec` per turn), or "auto" — app-server when the installed Codex has it.
 * Read on every turn, so changing it doesn't need a restart of running runs.
 */
export function codexTransport(): "auto" | "app-server" | "exec" {
  const value = process.env.CODEFLOW_CODEX_TRANSPORT;
  return value === "app-server" || value === "exec" ? value : "auto";
}
