import { adapters, type AgentId } from "../adapters/index.js";
import { failureExcerpt, type CheckResult } from "../checks.js";
import { RejectedError, type Proof, type StepOutcome, type TeamContext } from "../engine.js";
import { changedFiles, resolveCommit, restorePaths, type Worktree } from "../git.js";

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

/** What an agent that writes the code is told up front when code-flow will prove it fail-to-pass. */
export function proofRule(ctx: TeamContext): string {
  if (!ctx.proves) return "";
  return section(
    "Prove it",
    "code-flow will run your tests on the original code, without your change: at least one should fail there and pass with your change. " +
      "Add or update a test that shows the change works, unless the task can't be tested that way (docs, a pure refactor); then say why in your summary.",
  );
}

/** A proof as evidence for a reviewer or judge: does any test fail without the change? Empty without one. */
export function proofEvidence(proof: Proof | null): string {
  if (!proof) return "";
  const tests = proof.tests.length ? `this change's tests (${proof.tests.join(", ")})` : "the existing tests";
  if (proof.status === "proven") {
    return section(
      "Fail-to-pass: proven (run by code-flow)",
      `code-flow put ${tests} onto the original code and ran \`${proof.command}\`: it fails there and passes with the change, so the tests need the change.\n${fence(proof.detail)}`,
    );
  }
  if (proof.status === "unproven") {
    return section(
      "Fail-to-pass: not proven (run by code-flow)",
      `code-flow put ${tests} onto the original code and ran \`${proof.command}\`: it passes there too, so no test shows the change works. ` +
        "Ask for a test that fails without the change, unless the task can't be tested that way (docs, a pure refactor).",
    );
  }
  return section("Fail-to-pass: couldn't tell (run by code-flow)", `code-flow couldn't run the tests on the original code: ${proof.detail}.`);
}

/** One line for a result summary. */
export function proofLine(proof: Proof | null): string {
  if (!proof) return "";
  if (proof.status === "proven") return `Proven: \`${proof.command}\` fails without the change${proof.tests.length ? ` (with ${proof.tests.join(", ")})` : ""}, so its tests need it.`;
  if (proof.status === "unproven") return "⚠ Not proven: no test fails without the change.";
  return `Couldn't prove it fails without the change: ${proof.detail}.`;
}

/**
 * Fail-to-pass, once the check passes: code-flow proves the change (see TeamContext.prove). When
 * no test fails without it and `ask` is set, `agent` is asked once to add one; the check (with up
 * to `attempts` fixes) and the proof then run again. Returns the last check and proof, the
 * agent's session, and whether it was asked.
 */
export async function proveOrAsk(
  ctx: TeamContext,
  opts: {
    agent: AgentId;
    role: string;
    wt: Worktree;
    check: CheckResult | null;
    session?: StepOutcome;
    attempts: number;
    /** Ask the agent for a test when it isn't proven (patterns ask once per run). */
    ask: boolean;
    context?: string;
  },
): Promise<{ check: CheckResult | null; proof: Proof | null; session?: StepOutcome; asked: boolean }> {
  let { check, session } = opts;
  if (!check?.ok) return { check, proof: null, session, asked: false };
  let proof = await ctx.prove(opts.wt);
  if (proof?.status !== "unproven" || !opts.ask) return { check, proof, session, asked: false };
  session = session?.agent === opts.agent ? session : undefined;
  const before = await ctx.remember("head", `before proof test in ${opts.wt.name}`, () => resolveCommit(opts.wt.path));
  session = await ctx.ask({
    title: "Add a test that fails without the change",
    role: opts.role,
    agent: opts.agent,
    mode: "write",
    cwd: opts.wt,
    resume: session,
    prompt:
      (session ? "" : preamble(opts.role, opts.agent, WRITE) + section("Task", ctx.task) + (opts.context ?? "")) +
      "The check passes, but code-flow ran this change's tests on the original code, without the change, and they pass there too: " +
      "nothing shows the change does what the task asks." +
      section(
        "Next",
        "Add or update a test that fails without your change and passes with it. Don't change the implementation unless the test finds a real bug. " +
          "If the task can't be tested that way (docs, a pure refactor), change nothing and say why.",
      ),
  });
  const sha = await ctx.commit(opts.wt, `${opts.agent}: add a test that fails without the change`);
  if (!sha) {
    ctx.log(`${adapters[opts.agent].displayName} added no test; the result stays unproven`, "warn");
    return { check, proof, session, asked: true };
  }
  const fixed = await fixUntilGreen(ctx, { agent: opts.agent, role: opts.role, wt: opts.wt, session, attempts: opts.attempts, context: opts.context });
  check = fixed.check;
  session = fixed.session ?? session;
  if (check && !check.ok) {
    // Asking for a proof mustn't cost a green result: undo what never passed, and it stays unproven.
    ctx.log(`The check fails since ${adapters[opts.agent].displayName} added its test, and fixing didn't help; undoing that`, "warn");
    const changed = await ctx.remember("changed", `since proof test in ${opts.wt.name}`, () => changedFiles(opts.wt.path, before));
    await ctx.remember("restore-before-proof", opts.wt.name, () => restorePaths(ctx.run.repo, opts.wt, before, changed).then(() => true));
    await ctx.commit(opts.wt, `code-flow: undo ${opts.agent}'s test that never passed`);
    check = await ctx.check(opts.wt);
    return { check, proof: check?.ok ? await ctx.prove(opts.wt) : null, session, asked: true };
  }
  proof = check?.ok ? await ctx.prove(opts.wt) : null;
  return { check, proof, session, asked: true };
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
