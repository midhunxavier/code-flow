import { adapters } from "../adapters/index.js";
import type { Pattern } from "../engine.js";
import { proofLine, section, WRITE } from "./prompts.js";

/**
 * Single agent.
 * One agent works on the task in its own worktree, the way you'd use it in its own app, and you
 * keep talking to it: every reply continues the same session on the same branch (a follow-up),
 * and messages sent while it works become its next turn. code-flow commits after every turn and
 * runs the check if you set one. A turn that fails ends the turn, not the conversation.
 */
export const soloPattern: Pattern = {
  id: "solo",
  name: "Single agent",
  summary: "One agent works on the task and you keep talking to it, like in its own app.",
  description:
    "For quick changes, questions and exploring, where a team is more than the task needs. Every reply continues the same session on the same branch; start a team from its result when you want a second opinion.",
  chat: true,
  roles: [{ id: "agent", label: "Agent", description: "Does the work and answers your replies", default: ["claude"] }],
  options: [],

  async run(ctx) {
    const agent = ctx.agent("agent");
    const name = adapters[agent].displayName;
    const wt = await ctx.worktree("solo");

    const turn = await ctx.ask({
      title: "Your task",
      role: "agent",
      agent,
      mode: "write",
      cwd: wt,
      allowFailure: true,
      prompt:
        [
          `You are ${name}, working with the user through code-flow.`,
          "Each turn runs non-interactively, but the user reads your answer and can reply: when something important is unclear, say so and ask rather than guessing big.",
          WRITE,
          "Do not run `git commit`, `git push` or change branches — code-flow commits your work after every turn.",
        ].join("\n") +
        section("Task", ctx.task) +
        section("When you're done", "If you changed code, run the relevant tests, then summarize what you did. If the task is a question, just answer it."),
    });
    // Whatever it changed is kept, even when the turn failed part way: you decide what happens next.
    const sha = await ctx.commit(wt, `${agent}: ${ctx.task.split("\n")[0]!.slice(0, 60) || "your task"}`);
    const check = await ctx.check(wt);
    if (check) ctx.setVerdict(check.ok ? "passed" : "failing");
    // Publishing the result proves it (fail-to-pass) when its check passes; nobody is asked for a test.
    await ctx.artifact("Result", wt);
    ctx.setFacts({ proof: ctx.proofOf(wt)?.status });

    if (!turn.ok) {
      return `**${name} didn't finish:** ${turn.error ?? "unknown error"}\n\nReply to try again or to change course${sha ? `; what it changed is on \`${wt.branch}\`` : ""}.`;
    }
    const outcome = check ? (check.ok ? ` — \`${check.command}\` passes` : ` — \`${check.command}\` fails`) : "";
    return [
      `**${sha ? `Changes on \`${wt.branch}\`` : "No changes"}**${outcome}`,
      sha ? proofLine(ctx.proofOf(wt)) : "",
      section(`${name}'s answer`, turn.finalText || "(no answer)"),
    ].join("\n");
  },
};
