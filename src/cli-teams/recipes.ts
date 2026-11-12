import { fail, PROVIDERS, PROVIDER_NAMES, type Candidate, type Node, type Participant, type Provider } from "./model.js";

/**
 * Fixed team shapes for the one-call entry. The caller states intent (a mode and, optionally, who);
 * the candidate graph is composed here, so a host never has to author one for the common cases.
 * Anything these shapes do not cover still goes through codeflow_propose_run with a hand-written candidate.
 */
export const MODES = ["review", "plan", "implement"] as const;
export type Mode = typeof MODES[number];
export interface Member { provider: Provider; model?: string; effort?: string }
export interface RecipeInput {
  mode: Mode;
  /** Explicit choices, in role order: reviewers for a review; drafter then reviewer; writer then reviewer. */
  team?: Member[];
  /** Provider of the conversation that is asking, when known. A second opinion prefers a different one. */
  host?: Provider;
  installed: Provider[];
  preferred?: Provider;
  /** False when managed Antigravity cannot run in its sandbox on this computer. */
  agyAvailable?: boolean;
  check?: string; setup?: string;
  source?: "head" | "working_changes";
  maxMinutes?: number;
}
export interface Recipe { candidate: Candidate; roles: ({ role: string } & Member)[]; notes: string[] }

const REVIEW_CODE = "Review the captured changes against the task: correctness, regressions, missing tests and anything the task asked for that is absent. Cite file and line for each problem, most serious first. If the snapshot lists no changed files, review what the task names instead, for example recent commits. Do not edit files.";
const DRAFT_PLAN = "Read the repository, then draft an implementation plan for the task: the approach, the files to change, the order of work, the risks and how to verify the result. Do not edit files.";
const REVIEW_PLAN = "Review the plan against the task and the repository. Name concrete gaps, wrong assumptions and risks, with evidence from the code. Do not edit files.";
const REVISE_PLAN = "Revise the plan to resolve the review's findings. Keep what was sound, say what changed and why, and return the complete final plan.";
const IMPLEMENT = "Implement the task in this worktree. Keep the change focused, follow the project's conventions, and add or update tests where the project has them. If a previous pass is shown, fix its review findings and its failed check.";
const REVIEW_CHANGE = "Review the implementation against the task. Cite file and line for each blocking problem. Approve only when the change is correct and complete.";

export function composeRecipe(input: RecipeInput): Recipe {
  const { mode, host } = input, team = input.team ?? [], notes: string[] = [];
  if (!MODES.includes(mode)) fail("validation_failed", `Choose a mode: ${MODES.join(", ")}`);
  if (team.length > 2) fail("validation_failed", mode === "review" ? "A review uses one or two reviewers" : `${mode === "plan" ? "A plan" : "An implementation"} uses one author and one reviewer; for a larger team use codeflow_propose_run`);
  for (const member of team) if (!input.installed.includes(member.provider)) fail("provider_unavailable", `${PROVIDER_NAMES[member.provider]} is not installed on this computer. Installed: ${input.installed.map(p => PROVIDER_NAMES[p]).join(", ") || "none"}.`);
  if (!input.installed.length) fail("provider_unavailable", "No provider CLI is installed. Install Claude Code, Codex or Antigravity CLI and sign in, then try again.");
  if (mode !== "implement" && (input.check || input.setup)) fail("validation_failed", "Only mode implement runs setup and check commands; a review or plan never executes project commands");
  // Antigravity is experimental here: never chosen automatically while Claude or Codex is installed.
  const stable = [...new Set([...(input.preferred ? [input.preferred] : []), ...PROVIDERS])].filter(p => p !== "agy" && input.installed.includes(p));
  const agy = input.installed.includes("agy") && input.agyAvailable !== false ? ["agy" as const] : [];
  const pool = stable.length ? stable : agy;
  if (!pool.length) fail("provider_unavailable", "Antigravity is installed but its sandbox is unavailable here, and no other provider is installed. Install Claude Code or Codex, or name Antigravity explicitly with the unrestricted setup through codeflow_propose_run.");
  if (team.some(m => m.provider === "agy") || !stable.length) notes.push("Antigravity support is experimental.");
  const other = (than: Provider) => pool.find(p => p !== than);
  const first = host && pool.includes(host) ? host : pool[0]!;
  const limits = input.maxMinutes ? { limits: { maxMinutes: input.maxMinutes } } : {};
  const participant = (id: string, m: Member): Participant => ({ id, provider: m.provider, ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) });
  const task = (id: string, operation: string, who: string | undefined, instructions?: string, inputs?: string[]) => ({ id, type: "task", operation, ...(who ? { participant: who } : {}), ...(instructions ? { instructions } : {}), ...(inputs ? { inputs } : {}) }) as Node;

  if (mode === "review") {
    let reviewers = team;
    if (!reviewers.length) {
      const different = host ? other(host) : pool[0];
      reviewers = [{ provider: different ?? pool[0]! }];
      if (host && !different) notes.push(`Only ${PROVIDER_NAMES[pool[0]!]} is installed, so this review comes from a separate ${PROVIDER_NAMES[pool[0]!]} session, not from a different provider.`);
    }
    const ids = reviewers.map((_, i) => i ? `reviewer-${i + 1}` : "reviewer"), reviews = ids.map((_, i) => i ? `review-${i + 1}` : "review");
    const work = ids.map((id, i) => task(reviews[i]!, "review_code", id, REVIEW_CODE, ["snapshot"]));
    return {
      roles: reviewers.map(m => ({ role: "reviewer", ...m })), notes,
      candidate: {
        scope: "review", ...(input.source ? { source: input.source } : {}), ...limits,
        participants: reviewers.map((m, i) => participant(ids[i]!, m)),
        completion: ["Each reviewer reports its findings on the captured code"],
        steps: [task("snapshot", "capture_snapshot", undefined), ...(work.length > 1 ? [{ id: "reviews", type: "parallel", tasks: work } as Node] : work), { id: "result", type: "finish", outcome: "review_complete", inputs: reviews }],
      },
    };
  }

  const author = team[0] ?? { provider: first };
  if (mode === "implement" && author.provider === "agy") fail("validation_failed", "Antigravity can review here but not write. Choose Claude or Codex as the writer, or use codeflow_propose_run.");
  const second = team[1] ?? (other(author.provider) ? { provider: other(author.provider)! } : undefined);

  if (mode === "plan") {
    if (!second) notes.push("Only one provider is installed, so this plan has no independent review.");
    const members = [participant("drafter", author), ...(second ? [participant("reviewer", second)] : [])];
    const steps: Node[] = second
      ? [task("draft", "propose", "drafter", DRAFT_PLAN), task("review", "review_plan", "reviewer", REVIEW_PLAN, ["draft"]), task("final", "revise_proposal", "drafter", REVISE_PLAN, ["draft", "review"]), { id: "result", type: "finish", outcome: "plan_ready", inputs: ["final", "review"] }]
      : [task("draft", "propose", "drafter", DRAFT_PLAN), { id: "result", type: "finish", outcome: "plan_ready", inputs: ["draft"] }];
    return {
      roles: [{ role: "drafter", ...author }, ...(second ? [{ role: "reviewer", ...second }] : [])], notes,
      candidate: { scope: "plan", ...(input.source ? { source: input.source } : {}), ...limits, participants: members, completion: [second ? "The plan covers the task and answers the independent review" : "The plan covers the task"], steps },
    };
  }

  if (!input.check?.trim()) fail("validation_failed", "An implementation needs a check command that proves the change, for example the project's test command. Ask the user which command to use, then call again with check.");
  // With one provider installed the reviewer is a separate session of the same provider: independent context, same model family.
  const reviewer = second ?? { provider: author.provider };
  if (!second) notes.push(`Only ${PROVIDER_NAMES[author.provider]} is installed, so the review comes from a separate ${PROVIDER_NAMES[author.provider]} session, not from a different provider.`);
  return {
    roles: [{ role: "writer", ...author }, { role: "reviewer", ...reviewer }], notes,
    candidate: {
      scope: "write", check: input.check.trim(), ...(input.setup?.trim() ? { setup: input.setup.trim() } : {}), ...(input.source ? { source: input.source } : {}), ...limits,
      participants: [participant("writer", author), participant("reviewer", reviewer)],
      completion: ["The check passes on the delivered code and the reviewer approves that same code"],
      steps: [
        // The second pass is the repair: the writer sees the first pass's findings and failed check.
        { id: "attempt", type: "loop", maxIterations: 2, steps: [
          task("build", "implement", "writer", IMPLEMENT), task("check", "verify", undefined),
          task("review", "review_code", "reviewer", REVIEW_CHANGE, ["build"]),
          { id: "gate", type: "gate", policy: "verified", target: "build", reviews: ["review"], verification: "check" },
        ] },
        { id: "result", type: "finish", outcome: "verified_changes", inputs: ["build", "gate", "check", "review"] },
      ],
    },
  };
}

/** The provider a host conversation runs on, from the MCP client name or the shell environment. Unknown stays unknown. */
export function hostProvider(clientName?: string, env: NodeJS.ProcessEnv = process.env): Provider | undefined {
  const explicit = env.CODEFLOW_HOST_PROVIDER;
  if (explicit && (PROVIDERS as readonly string[]).includes(explicit)) return explicit as Provider;
  const name = (clientName ?? "").toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  if (name.includes("antigravity") || name.includes("agy")) return "agy";
  if (!clientName && env.CLAUDECODE === "1") return "claude";
  return undefined;
}
