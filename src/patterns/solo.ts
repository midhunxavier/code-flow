import { getAdapter } from "../adapters/index.js";
import type { Pattern } from "../engine.js";
import { proofLine, section, WRITE } from "./prompts.js";

/**
 * Single agent.
 * One agent works on the task in its own worktree, the way you'd use it in its own app, and you
 * keep talking to it: every reply continues the same session on the same branch (a follow-up),
 * and messages sent while it works become its next turn. Files stay uncommitted unless requested.
 * A turn that fails ends the turn, not the conversation.
 */
export const soloPattern: Pattern = {
  id: "solo",
  name: "Agent",
  summary: "One agent works on the task and you keep talking to it, like in its own app.",
  description:
    "For quick changes, questions and exploring, where a team is more than the task needs. Every reply continues the same session on the same branch; start a team from its result when you want a second opinion.",
  chat: true,
  roles: [{ id: "agent", label: "Agent", description: "Does the work and answers your replies", default: ["claude"] }],
  options: [],

  async run(ctx) {
    const agent = ctx.agent("agent");
    const name = getAdapter(agent).displayName;
    const wt = await ctx.worktree("solo");

    const turn = await ctx.ask({
      title: "Your task",
      role: "agent",
      agent,
      mode: ctx.run.chatLink?.kind === "side" ? "read" : "write",
      cwd: wt,
      allowFailure: true,
      prompt:
        [
          `You are ${name}, working with the user through code-flow.`,
          "You are in an ongoing conversation. Follow the user's request, ask when clarification is necessary, and continue the same task across replies.",
          ctx.run.chatLink?.kind === "side" ? "This is an independent read-only side conversation. Read files and explain; do not change files, commit, or run mutating commands. The main agent may continue editing while you read." : WRITE,
          ...(ctx.run.chatLink ? ["Read the attached chat-handoff file before responding. It contains the visible conversation at the point this chat was opened. Retain applicable user constraints and continue from the user's new request."] : []),
          ctx.run.checkpointOnFinish ? "Complete the task and report the result. Codeflow will checkpoint and check the completed work." : "Use your available tools to complete the requested work, including browser and connected tools when relevant. Report tool failures accurately. Commit, push, or create a pull request when the user requests it. Codeflow does not commit automatically.",
        ].join("\n") +
        section("Task", ctx.task) +
        section("When you're done", "If you changed code, run the relevant tests, then summarize what you did. If the task is a question, just answer it."),
    });
    if (ctx.run.checkpointOnFinish) {
      const sha = await ctx.commit(wt, `${agent}: ${ctx.task.split("\n")[0]!.slice(0, 60) || "task checkpoint"}`);
      const check = await ctx.check(wt);
      if (check) ctx.setVerdict(check.ok ? "passed" : "failing");
      await ctx.artifact("Result", wt);
      ctx.setFacts({ proof: ctx.proofOf(wt)?.status });
      if (!turn.ok) throw new Error(turn.error || "The agent task failed");
      const outcome = check ? ` — \`${check.command}\` ${check.ok ? "passes" : "fails"}` : "";
      return [`**${sha ? `Changes on \`${wt.branch}\`` : "No changes"}**${outcome}`, sha ? proofLine(ctx.proofOf(wt)) : "", section(`${name}'s answer`, turn.finalText || "(no answer)")].join("\n");
    } else await ctx.conversationResult(wt);
    if (!turn.ok) throw new Error(turn.error || "The agent turn failed");
    return turn.finalText || "The turn finished without an answer.";
  },
};
