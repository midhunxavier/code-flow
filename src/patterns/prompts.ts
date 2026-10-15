import { adapters, type AgentId } from "../adapters/index.js";
import type { CheckResult } from "../checks.js";
import type { StepOutcome, TeamContext } from "../engine.js";
import type { Worktree } from "../git.js";

/** Shared framing so every agent knows it is one member of a team. */
export function preamble(role: string, agent: AgentId, duty: string): string {
  return [
    `You are the ${role} on a team of AI coding agents (Claude Code, Codex, Antigravity) coordinated by code-flow.`,
    `You are running as ${adapters[agent].displayName}, non-interactively: nobody can answer questions, so make reasonable assumptions and state them.`,
    duty,
    "Do not run `git commit`, `git push` or change branches — code-flow commits your work after you finish.",
  ].join("\n");
}

export function section(title: string, body: string): string {
  return `\n## ${title}\n${body.trim()}\n`;
}

export function fence(body: string, lang = ""): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

export const READ_ONLY = "You have read-only access: inspect code and run read-only commands, but do not modify any files.";
export const WRITE = "You may edit files and run build/test commands in the current directory, which is an isolated git worktree.";

export function jsonInstruction(shape: string): string {
  return `\nEnd your answer with a fenced \`\`\`json block exactly matching this shape:\n${fence(shape, "json")}`;
}

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** What code-flow's own run of the check showed — the evidence agents should act on. */
export function checkSection(result: CheckResult, maxOutput = 6_000): string {
  const status = result.ok ? "passed" : result.timedOut ? "timed out" : `failed (exit code ${result.exitCode})`;
  const body = result.ok ? "All checks pass." : fence(result.output.slice(-maxOutput).trim() || "(no output)");
  return section(`Check \`${result.command}\` ${status} (run by code-flow)`, body);
}

/**
 * If the check fails, let `agent` fix it — up to `attempts` times, re-running the check after
 * each try. Returns the last check (null when no check is configured) and the agent's session.
 */
export async function fixUntilGreen(
  ctx: TeamContext,
  opts: { agent: AgentId; role: string; wt: Worktree; session?: StepOutcome; attempts: number; initial?: CheckResult | null },
): Promise<{ check: CheckResult | null; session?: StepOutcome }> {
  let check = opts.initial !== undefined ? opts.initial : await ctx.check(opts.wt);
  let session = opts.session?.agent === opts.agent ? opts.session : undefined;
  for (let attempt = 1; check && !check.ok && attempt <= opts.attempts; attempt++) {
    session = await ctx.ask({
      title: `Fix failing check (${attempt}/${opts.attempts})`,
      role: opts.role,
      agent: opts.agent,
      mode: "write",
      cwd: opts.wt,
      resume: session,
      prompt:
        (session ? "" : preamble(opts.role, opts.agent, WRITE) + section("Task", ctx.task)) +
        "code-flow ran the project's check on the current code and it fails. Fix the cause in the code — don't weaken or skip tests — then summarize." +
        checkSection(check),
    });
    await ctx.commit(opts.wt, `${opts.agent}: fix failing check`);
    check = await ctx.check(opts.wt);
  }
  return { check, session };
}
