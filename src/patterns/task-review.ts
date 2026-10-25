import { recoverableProviderFailure, type Pattern } from "../engine.js";
import { REVIEW_SCHEMA } from "./schemas.js";
import { extractJson, shapeProblem } from "../json.js";
import { REVIEW_SHAPE, type ReviewVerdict } from "./findings.js";

/** Internal review of an exact combined-workspace checkpoint; never edits the task. */
export const taskReviewPattern: Pattern = {
  id: "task-review", name: "Review combined changes", summary: "Independently review the reconciled task workspace.",
  description: "Read a private checkpoint and record findings without changing the conversation workspace.",
  roles: [{ id: "reviewer", label: "Reviewers", description: "Allowed independent providers", multiple: true, default: ["codex"] }], options: [],
  async run(ctx) {
    const cwd = await ctx.worktree("review");
    for (const agent of ctx.agents("reviewer")) {
      const outcome = await ctx.ask({ role: "reviewer", agent, cwd, title: "Review combined workspace", mode: "read", retryProviderFailure: true, allowFailure: true, teamResponse: true,
        schema: REVIEW_SCHEMA, prompt: `You have not authored this work. The current action is a new read-only review of the combined workspace, not another acknowledgement of an earlier conversation turn. Review against the current delegated task, latest corrections and applicable ongoing user constraints below. This is an immutable snapshot. Do not edit, run mutating commands, commit, or perform browser/computer actions. Read relevant files and return an independent review through the supplied schema. Use changes_requested if requirements are unmet. Report concrete issues; return empty issues when approved.\n\n${REVIEW_SHAPE}\n\n${ctx.task}` });
      if (!outcome.ok) { if (recoverableProviderFailure(outcome, false)) continue; throw new Error(outcome.error ?? "Review failed"); }
      const value = outcome.structured ?? extractJson(outcome.finalText);
      const problem = value === undefined ? "No review received" : shapeProblem(REVIEW_SCHEMA, value);
      if (problem) throw new Error(`Invalid combined-workspace review: ${problem}`);
      return JSON.stringify(value as ReviewVerdict);
    }
    throw new Error("No selected provider could review the combined workspace. Choose an available provider and refresh review.");
  },
};
