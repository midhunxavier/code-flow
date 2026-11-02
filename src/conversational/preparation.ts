import type { Pattern } from "../engine.js";
import { CANDIDATE_SCHEMA, validateWebCandidate, shapeProblem, digest } from "../cli-teams/model.js";
import type { PrepareResult } from "./model.js";
import { extractJson } from "../json.js";
export const PREPARATION_SCHEMA = { type: "object", additionalProperties: false, required: ["kind"], properties: {
        kind: { enum: ["proposal", "question"] }, candidate: CANDIDATE_SCHEMA,
        question: { type: "object", additionalProperties: false, required: ["question", "options"], properties: { question: { type: "string", minLength: 1, maxLength: 2000 }, options: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 300 } } } },
    } };
export function preparationProblem(value: PrepareResult) {
    const issue = shapeProblem(PREPARATION_SCHEMA, value);
    if (issue)
        return issue;
    if (value.kind === "question")
        return !value.question || value.candidate ? "Return one material question only" : undefined;
    if (!value.candidate || value.question)
        return "Return a candidate only";
    try {
        validateWebCandidate(value.candidate);
    }
    catch (e) {
        return (e as Error).message;
    }
}
export const preparationPattern: Pattern = {
    id: "task-prepare", name: "Prepare task approach", summary: "Private bounded task preparation", description: "Read-only task preparation", roles: [], options: [],
    async run(ctx) {
        const state = ctx.run.cliTeam!, p = state.definition.participants[0]!, wt = await ctx.worktree("setup");
        // The graph has variant node shapes. Validate JSON locally rather than requiring
        // every native provider's response-schema dialect to support recursive/union schemas.
        const value = await ctx.remember<PrepareResult>("cli-preparation", "answer", async () => {
            let issue = "";
            for (let attempt = 1; attempt <= state.definition.limits.maxAttempts; attempt++) {
                const answer = await ctx.ask({ title: attempt === 1 ? "Prepare the approach" : "Correct the approach response", identity: `workflow/prepare/${attempt}`, cliAssignment: "workflow/prepare", role: p.id, agent: p.provider, settings: { model: p.model ?? "", effort: p.effort ?? "" }, mode: "read", cwd: wt, tools: false, planning: true,
                    prompt: `${ctx.task}\nResponse shape:\n${JSON.stringify(PREPARATION_SCHEMA)}\n${issue ? `Correct this validation issue from the previous response: ${issue}. Return only the complete corrected JSON object.` : "Return only the JSON object."}` });
                const response = answer.structured ?? extractJson(answer.finalText);
                issue = preparationProblem(response as PrepareResult) ?? "";
                if (!issue)
                    return response as PrepareResult;
                ctx.log(`The approach response needs correction: ${issue}`, "warn");
            }
            throw new Error(`Preparation could not produce a valid approach within its attempt allowance: ${issue}`);
        });
        const record = { kind: "result" as const, body: JSON.stringify(value), data: { preparation: true } };
        const artifact = { ...record, id: `a-${digest(record).slice(0, 32)}`, sha256: digest(record) };
        await ctx.remember("cli-artifact", "preparation", async () => artifact);
        state.artifacts[artifact.id] = artifact;
        state.outcome = "plan_ready";
        await ctx.recordCliClock();
        ctx.publish();
        return artifact.body;
    },
};
