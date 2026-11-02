import type { Pattern } from "../engine.js";
import { CANDIDATE_SCHEMA, digest, shapeProblem, validateWebCandidate } from "../cli-teams/model.js";
import { extractJson } from "../json.js";
import type { LeadReply } from "./chat-model.js";

export const CHAT_REPLY_SCHEMA = { type: "object", additionalProperties: false, required: ["kind", "body"], properties: {
  kind: { enum: ["answer", "clarify", "guidance", "proposal"] }, body: { type: "string", minLength: 1, maxLength: 12000 },
  target: { enum: ["new", "current"] }, candidate: CANDIDATE_SCHEMA,
} };
export function leadProblem(value: unknown): string | undefined {
  const problem = shapeProblem(CHAT_REPLY_SCHEMA, value);
  if (problem) return problem;
  const reply = value as LeadReply;
  if (reply.kind === "proposal") {
    if (!reply.candidate || !reply.target) return "A proposal needs a candidate and target";
    try { validateWebCandidate(reply.candidate); } catch (error) { return (error as Error).message; }
  } else if (reply.candidate || reply.target) return "Answers, clarification and guidance cannot contain an executable proposal";
}
export const chatLeadPattern: Pattern = {
  id: "chat-lead", name: "Conversation lead", summary: "Private bounded conversation turn", description: "Read-only interpretation and approach preparation", roles: [], options: [],
  async run(ctx) {
    const state = ctx.run.cliTeam!, participant = state.definition.participants[0]!, worktree = await ctx.worktree("lead");
    const reply = await ctx.remember<LeadReply>("chat-lead", "reply", async () => {
      let issue = "";
      for (let attempt = 1; attempt <= state.definition.limits.maxAttempts; attempt++) {
        const result = await ctx.ask({ title: "Respond to the conversation", identity: `lead/${attempt}`, cliAssignment: "lead", role: participant.id, agent: participant.provider, settings: { model: participant.model ?? "", effort: participant.effort ?? "" }, mode: "read", cwd: worktree, tools: false, planning: true,
          prompt: `${ctx.task}\nReturn JSON matching:\n${JSON.stringify(CHAT_REPLY_SCHEMA)}\n${issue ? `Correct this issue: ${issue}.` : ""}` });
        const value = result.structured ?? extractJson(result.finalText);
        issue = leadProblem(value) ?? "";
        if (!issue) return value as LeadReply;
      }
      throw new Error(`The lead could not produce a valid reply within its allowance: ${issue}`);
    });
    const record = { kind: "result" as const, body: JSON.stringify(reply), data: { lead: true } };
    const artifact = { ...record, id: `a-${digest(record).slice(0, 32)}`, sha256: digest(record) };
    await ctx.remember("cli-artifact", "lead-reply", async () => artifact);
    state.artifacts[artifact.id] = artifact;
    state.outcome = "plan_ready";
    await ctx.recordCliClock(); ctx.publish();
    return artifact.body;
  },
};
