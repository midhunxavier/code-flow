import { adapters, type AgentId } from "../adapters/index.js";
import { failureExcerpt, type CheckResult } from "../checks.js";
import { RejectedError, type StepOutcome, type TeamContext } from "../engine.js";
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

/**
 * "Approve the plan" checkpoint: you approve, ask for changes (the author revises in its own
 * session and asks again), or reject (the run ends). A no-op unless the run enabled it.
 */
export async function planCheckpoint(
  ctx: TeamContext,
  opts: { agent: AgentId; role: string; wt: Worktree; plan: StepOutcome; what: string; render?: (text: string) => string },
): Promise<StepOutcome> {
  let plan = opts.plan;
  for (let round = 1; ; round++) {
    const title = round === 1 ? `Approve the ${opts.what}` : `Approve the revised ${opts.what} (${round})`;
    const answer = await ctx.approve("plan", title, opts.render ? opts.render(plan.finalText) : plan.finalText);
    if (answer.decision === "approve") return plan;
    if (answer.decision === "reject") throw new RejectedError(`You rejected the ${opts.what}.${answer.note ? ` (${answer.note})` : ""}`);
    plan = await ctx.ask({
      title: `Revise the ${opts.what} (${round})`,
      role: opts.role,
      agent: opts.agent,
      mode: "read",
      cwd: opts.wt,
      resume: plan.sessionId ? plan : undefined,
      prompt:
        (plan.sessionId ? "" : `Your earlier ${opts.what}:\n${plan.finalText}\n\n`) +
        `The user asked for changes to your ${opts.what}:\n${answer.note}\n\nRevise it and reply with the complete updated ${opts.what}.`,
    });
  }
}

/** What code-flow's own run of the check showed — the evidence agents should act on. */
export function checkSection(result: CheckResult, maxOutput = 6_000): string {
  const status = result.ok ? "passed" : result.timedOut ? "timed out" : `failed (exit code ${result.exitCode})`;
  const body = result.ok ? "All checks pass." : fence(failureExcerpt(result.output, maxOutput) || "(no output)");
  return section(`Check \`${result.command}\` ${status} (run by code-flow)`, body);
}

/**
 * The check as evidence for a reviewer: its result, or that code-flow couldn't run it here, so
 * nobody has tested the change. Empty without a check.
 */
export function checkEvidence(ctx: TeamContext, check: CheckResult | null, maxOutput?: number): string {
  if (check) return checkSection(check, maxOutput);
  const cantRun = ctx.run.checkCantRun;
  if (!cantRun) return "";
  return section(
    `Check \`${cantRun.command}\` couldn't run (run by code-flow)`,
    `It can't run in this environment (${cantRun.reason}) — on the base commit either, so not because of this change. Nobody has run the tests on this change; review it with that in mind.`,
  );
}

/**
 * If the check fails, let `agent` fix it — up to `attempts` times, re-running the check after
 * each try. Returns the last check (null when no check is configured, or it can't run here — no
 * point fixing code for that) and the agent's session.
 */
export async function fixUntilGreen(
  ctx: TeamContext,
  opts: {
    agent: AgentId;
    role: string;
    wt: Worktree;
    session?: StepOutcome;
    attempts: number;
    initial?: CheckResult | null;
    /** More for a fresh session to know (prompt sections), e.g. which parts are missing. */
    context?: string;
  },
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
        (session ? "" : preamble(opts.role, opts.agent, WRITE) + section("Task", ctx.task) + (opts.context ?? "")) +
        "code-flow ran the project's check on the current code and it fails. Fix the cause in the code — don't weaken or skip tests — then summarize." +
        checkSection(check),
    });
    await ctx.commit(opts.wt, `${opts.agent}: fix failing check`);
    check = await ctx.check(opts.wt);
  }
  return { check, session };
}
