import type { AgentId } from "../adapters/index.js";
import { blocks, type CouncilFinding, type FindingCheck, type Pattern, type Proof, type Repro } from "../engine.js";
import { defaultBranch, mergeBase } from "../github.js";
import { checkIssues, checkMark, CONFIRMATION, REVIEW_SHAPE, reproRule, severityOf, type ReviewVerdict } from "./findings.js";
import { COUNCIL_SCHEMA, REVIEW_SCHEMA } from "./schemas.js";
import { checkEvidence, fence, jsonInstruction, LETTERS, preamble, proofEvidence, proofLine, READ_ONLY, section } from "./prompts.js";

interface Merged {
  verdict: "approve" | "changes_requested";
  summary: string;
  findings: { severity: "high" | "medium" | "low"; file: string; problem: string; fix: string; raised_by: string[]; repro?: Repro }[];
}

const SEVERITY = { high: 0, medium: 1, low: 2 } as const;

/**
 * Review council.
 * Several agents review the same changes independently and read-only; code-flow runs the tests
 * they show their findings with, and a chair merges their reviews into one. Findings rank by
 * severity, then by whether a test confirms them, then by how many reviewers raised them.
 * Reviewers are anonymous to the chair ("Reviewer A/B/…") so it can't favour its own vendor.
 * Nothing is changed or posted: you decide whether to post the review to the pull request.
 */
export const councilPattern: Pattern = {
  id: "council",
  name: "Review council",
  summary: "Several agents review the same changes on their own; a chair merges what they found.",
  description:
    "Use to review a pull request or a branch before merging: different models catch different problems, code-flow runs the tests reviewers show bugs with, and the worst confirmed problems rank first. Read-only — nothing is changed.",
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

    // A reviewer that doesn't finish is left out; the others carry on.
    const reviews = await ctx.parallel(reviewers, async (agent, i) => {
      const label = LETTERS[i]!;
      const outcome = await ctx
        .decide<ReviewVerdict>({
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
            reproRule(ctx) +
            jsonInstruction(REVIEW_SHAPE),
        })
        .catch((err: Error) => {
          if (ctx.signal.aborted) throw err;
          ctx.log(`Reviewer ${label} (${agent}) didn't finish: ${err.message}`, "warn");
          return undefined;
        });
      return outcome ? { label, agent, review: outcome.value } : undefined;
    });
    const done = reviews.filter((r): r is { label: string; agent: AgentId; review: ReviewVerdict } => !!r);
    if (!done.length) throw new Error("No reviewer finished");

    // Each reviewer's tests run before the reviews are merged, one reviewer after another: the
    // chair sees which findings a test confirms. The same test on the same code runs once.
    const checked: FindingCheck[][] = [];
    for (const r of done) checked.push(await checkIssues(ctx, wt, r.review.issues, `Reviewer ${r.label}'s test`));

    let merged: Merged;
    if (done.length === 1) {
      const only = done[0]!;
      merged = {
        verdict: only.review.verdict,
        summary: "",
        findings: only.review.issues.map((i) => ({ ...i, severity: severityOf(i.severity), raised_by: [only.label] })),
      };
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
            done
              .map((r, n) => {
                const issues = r.review.issues.map((issue, i) => ({ ...issue, checked_by_code_flow: checkNote(issue.severity, checked[n]![i]!) }));
                return `### Reviewer ${r.label}: ${r.review.verdict}\n${fence(JSON.stringify(issues, null, 2), "json")}`;
              })
              .join("\n\n"),
          ) +
          section(
            "Deliverable",
            "Merge these into one review. Combine findings that describe the same problem and list every reviewer who raised it. " +
              "`checked_by_code_flow` says what code-flow found running a finding's `repro` on the code: a high-severity finding whose test passes is a false alarm, and one without a test is unconfirmed. " +
              "Check doubtful findings against the code and drop the ones that are wrong. Keep each finding's `repro` as it is (the confirmed one, if several reviewers gave one); use \"\" fields when none did. " +
              "Request changes if a confirmed high-severity problem or a real medium one remains. Write a short summary for the author.",
          ) +
          jsonInstruction(
            '{"verdict": "approve" | "changes_requested", "summary": "...", "findings": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "...", "raised_by": ["A", "B"], "repro": {"path": "", "contents": "", "command": ""}}]}',
          ),
      });
      merged = value;
    }

    const agentOf = Object.fromEntries(done.map((r) => [r.label, r.agent]));
    // The merged findings' tests: what already ran is reused, a test the chair changed runs now.
    const checks = await checkIssues(ctx, wt, merged.findings, "Merged finding's test");
    const findings: CouncilFinding[] = merged.findings
      .map((f, i) => ({
        severity: severityOf(f.severity),
        file: f.file,
        problem: f.problem,
        fix: f.fix,
        raisedBy: [...new Set(f.raised_by.map((l) => agentOf[l]!).filter(Boolean))],
        check: checks[i]!,
      }))
      .sort(
        (a, b) =>
          SEVERITY[a.severity] - SEVERITY[b.severity] ||
          CONFIRMATION[a.check.status] - CONFIRMATION[b.check.status] ||
          b.raisedBy.length - a.raisedBy.length,
      );
    // Recurring problems are passed on to later runs; false alarms aren't problems.
    ctx.learn(findings.filter((f) => f.check?.status !== "refuted"));
    // The verdict goes by what blocks once code-flow has run the findings' tests, as in the other
    // patterns, not by the chair's word: a confirmed bug isn't approved, and false alarms and
    // suggestions alone don't request changes.
    const blocking = findings.filter((f) => blocks(f.severity, f.check?.status ?? "unconfirmed"));
    const verdict = blocking.length ? "changes_requested" : "approve";
    if (verdict !== merged.verdict) {
      ctx.log(
        `The chair ${merged.verdict === "approve" ? "approved" : "requested changes"}, but ` +
          (blocking.length ? `${blocking.length} finding${blocking.length === 1 ? "" : "s"} block${blocking.length === 1 ? "s" : ""}` : "no finding blocks") +
          ` once code-flow has run their tests, so the review says ${verdict === "approve" ? "Approve" : "Changes requested"}`,
        "warn",
      );
    }
    const markdown = renderReview(verdict, merged.summary, findings, done.map((r) => r.agent), proof);
    ctx.setReview({
      verdict,
      summary: merged.summary,
      findings,
      reviewers: done.map((r) => ({ agent: r.agent, verdict: r.review.verdict, issues: r.review.issues.length })),
      proof: proof ?? undefined,
      markdown,
    });
    if (proof) ctx.setFacts({ proof: proof.status });
    ctx.log(`Council: ${verdict === "approve" ? "approve" : "changes requested"} with ${findings.length} finding(s) from ${done.length} reviewer(s)`);
    return markdown;
  },
};

/** What code-flow found running a finding's test, for the chair. */
function checkNote(severity: string, check: FindingCheck): string {
  if (check.status === "confirmed") return `confirmed: \`${check.command}\` fails with its test on this code`;
  if (check.status === "refuted") return `false alarm: \`${check.command}\` passes with its test on this code`;
  if (severityOf(severity) === "low") return "a suggestion: not checked";
  return check.status === "unverified" ? `couldn't run its test: ${check.detail}` : `unconfirmed: ${check.detail}`;
}

export function renderReview(verdict: string, summary: string, findings: CouncilFinding[], reviewers: AgentId[], proof: Proof | null = null): string {
  const head = `**Review council: ${verdict === "approve" ? "Approve" : "Changes requested"}** — ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"} (${reviewers.join(", ")})`;
  const list = findings.length
    ? findings
        .map(
          (f, i) =>
            `${i + 1}. **${f.severity}** \`${f.file || "general"}\` — ${f.problem}\n   *Fix:* ${f.fix}\n   *Raised by:* ${f.raisedBy.join(", ")}` +
            (f.check ? `\n   *Checked by code-flow:* ${checkMark(f)}` : ""),
        )
        .join("\n")
    : "No problems found.";
  return [head, proofLine(proof), summary.trim() ? section("Summary", summary) : "", section("Findings", list)].join("\n");
}
