import type { AgentId } from "../adapters/index.js";
import type { CouncilFinding, Pattern, Proof } from "../engine.js";
import { defaultBranch, mergeBase } from "../github.js";
import { COUNCIL_SCHEMA, REVIEW_SCHEMA } from "./schemas.js";
import { checkEvidence, fence, jsonInstruction, LETTERS, preamble, proofEvidence, proofLine, READ_ONLY, section } from "./prompts.js";

interface Review {
  verdict: "approve" | "changes_requested";
  issues: { severity: "high" | "medium" | "low"; file: string; problem: string; fix: string }[];
}

interface Merged {
  verdict: "approve" | "changes_requested";
  summary: string;
  findings: { severity: "high" | "medium" | "low"; file: string; problem: string; fix: string; raised_by: string[] }[];
}

const SEVERITY = { high: 0, medium: 1, low: 2 } as const;

/**
 * Review council.
 * Several agents review the same changes independently and read-only; a chair merges their
 * reviews into one. Findings rank by severity, then by how many reviewers raised them: a low
 * problem two reviewers found doesn't outrank a high one only one did. Reviewers are anonymous
 * to the chair ("Reviewer A/B/…") so it can't favour its own vendor. Nothing is changed or
 * posted: you decide whether to post the review to the pull request.
 */
export const councilPattern: Pattern = {
  id: "council",
  name: "Review council",
  summary: "Several agents review the same changes on their own; a chair merges what they found.",
  description:
    "Use to review a pull request or a branch before merging: different models catch different problems. The worst problems rank first, and among them the ones several reviewers agree on. Read-only — nothing is changed.",
  roles: [
    { id: "reviewers", label: "Reviewers", description: "Each reviews the changes on its own, read-only", multiple: true, default: ["claude", "codex", "agy"] },
    { id: "chair", label: "Chair", description: "Merges the reviews into one, noting where reviewers agree", default: ["claude"] },
  ],
  options: [],

  async run(ctx) {
    const reviewers = ctx.agents("reviewers");
    if (!reviewers.length) throw new Error("Pick at least one reviewer");
    const wt = await ctx.worktree("review");

    // What's under review: the PR's changes, or this branch's changes against the default branch.
    const base = await ctx.remember("review-base", "base", async () => {
      if (ctx.run.reviewBase) return ctx.run.reviewBase;
      const main = await defaultBranch(ctx.run.repo);
      return main ? (await mergeBase(ctx.run.repo, main, ctx.run.baseRef)) ?? null : null;
    });
    const diff = base && base !== ctx.run.baseRef ? await ctx.diff(wt, base) : "(no changes)";
    const scope =
      diff === "(no changes)"
        ? section("What to review", "There's no diff against the default branch, so review the code the task is about.")
        : section("Changes under review", fence(diff, "diff"));
    if (diff === "(no changes)") ctx.log("No diff against the default branch; reviewing the code the task points at");

    // Evidence for every reviewer, when there's a check: does it pass on the changes, and does a
    // test in them fail without them (their tests put onto the code they started from)?
    let evidence = "";
    let proof: Proof | null = null;
    if (ctx.proves && base && diff !== "(no changes)") {
      const check = await ctx.check(wt, "Check the changes");
      proof = check?.ok ? await ctx.prove(wt, { from: base }) : null;
      evidence = checkEvidence(ctx, check, 3_000) + proofEvidence(proof);
    }

    const shape = '{"verdict": "approve" | "changes_requested", "issues": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "..."}]}';
    // A reviewer that doesn't finish is left out; the others carry on.
    const reviews = await ctx.parallel(reviewers, async (agent, i) => {
      const label = LETTERS[i]!;
      const outcome = await ctx
        .decide<Review>({
          title: `Review ${label}`,
          schema: REVIEW_SCHEMA,
          what: "review",
          role: "reviewers",
          agent,
          mode: "read",
          cwd: wt,
          prompt:
            preamble("reviewer", agent, `${READ_ONLY} Other reviewers are reviewing the same changes independently.`) +
            section("Task", ctx.task) +
            scope +
            evidence +
            section(
              "Deliverable",
              "Look for bugs, security problems, missing or weak tests, and anything that doesn't do what the task or description says. " +
                "Read the surrounding code where you need to. Report real problems only — not style preferences — with the file and a concrete fix.",
            ) +
            jsonInstruction(shape),
        })
        .catch((err: Error) => {
          if (ctx.signal.aborted) throw err;
          ctx.log(`Reviewer ${label} (${agent}) didn't finish: ${err.message}`, "warn");
          return undefined;
        });
      return outcome ? { label, agent, review: outcome.value } : undefined;
    });
    const done = reviews.filter((r): r is { label: string; agent: AgentId; review: Review } => !!r);
    if (!done.length) throw new Error("No reviewer finished");

    let merged: Merged;
    if (done.length === 1) {
      const only = done[0]!;
      merged = { verdict: only.review.verdict, summary: "", findings: only.review.issues.map((i) => ({ ...i, raised_by: [only.label] })) };
    } else {
      const chair = ctx.agent("chair");
      const letters = done.map((r) => r.label);
      const { value } = await ctx.decide<Merged>({
        title: "Merge the reviews",
        schema: COUNCIL_SCHEMA,
        what: "merged review",
        role: "chair",
        agent: chair,
        mode: "read",
        cwd: wt,
        validate: (v: Merged) => {
          const bad = v.findings.flatMap((f) => f.raised_by).find((l) => !letters.includes(l));
          return bad ? `raised_by must only use reviewer letters ${letters.join(", ")} (got "${bad}")` : undefined;
        },
        prompt:
          preamble("chair of a review council", chair, READ_ONLY) +
          section("Task", ctx.task) +
          section(
            "Reviews",
            done.map((r) => `### Reviewer ${r.label}: ${r.review.verdict}\n${fence(JSON.stringify(r.review.issues, null, 2), "json")}`).join("\n\n"),
          ) +
          section(
            "Deliverable",
            "Merge these into one review. Combine findings that describe the same problem and list every reviewer who raised it. " +
              "Check doubtful findings against the code and drop the ones that are wrong. Request changes if any real high or medium problem remains. " +
              "Write a short summary for the author.",
          ) +
          jsonInstruction(
            '{"verdict": "approve" | "changes_requested", "summary": "...", "findings": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "...", "raised_by": ["A", "B"]}]}',
          ),
      });
      merged = value;
    }

    const agentOf = Object.fromEntries(done.map((r) => [r.label, r.agent]));
    const findings: CouncilFinding[] = merged.findings
      .map((f) => ({ severity: f.severity, file: f.file, problem: f.problem, fix: f.fix, raisedBy: [...new Set(f.raised_by.map((l) => agentOf[l]!).filter(Boolean))] }))
      .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.raisedBy.length - a.raisedBy.length);
    ctx.learn(findings);
    const markdown = renderReview(merged.verdict, merged.summary, findings, done.map((r) => r.agent), proof);
    ctx.setReview({
      verdict: merged.verdict,
      summary: merged.summary,
      findings,
      reviewers: done.map((r) => ({ agent: r.agent, verdict: r.review.verdict, issues: r.review.issues.length })),
      proof: proof ?? undefined,
      markdown,
    });
    if (proof) ctx.setFacts({ proof: proof.status });
    ctx.log(`Council: ${merged.verdict === "approve" ? "approve" : "changes requested"} with ${findings.length} finding(s) from ${done.length} reviewer(s)`);
    return markdown;
  },
};

export function renderReview(verdict: string, summary: string, findings: CouncilFinding[], reviewers: AgentId[], proof: Proof | null = null): string {
  const head = `**Review council: ${verdict === "approve" ? "Approve" : "Changes requested"}** — ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"} (${reviewers.join(", ")})`;
  const list = findings.length
    ? findings
        .map((f, i) => `${i + 1}. **${f.severity}** \`${f.file || "general"}\` — ${f.problem}\n   *Fix:* ${f.fix}\n   *Raised by:* ${f.raisedBy.join(", ")}`)
        .join("\n")
    : "No problems found.";
  return [head, proofLine(proof), summary.trim() ? section("Summary", summary) : "", section("Findings", list)].join("\n");
}
