import { getAdapter, adapters, type AgentId } from "../adapters/index.js";
import { blocks, type FindingCheck, type Repro, type ReviewFinding, type TeamContext } from "../engine.js";
import type { Worktree } from "../git.js";
import { fence, section } from "./prompts.js";

/**
 * Checkable review findings: a reviewer shows a bug with a test (a repro), code-flow runs it on
 * the result, and approval goes by the findings that block (see `blocks` in the engine), not by
 * the reviewer's verdict word.
 */

export interface ReviewIssue {
  severity: string;
  file: string;
  problem: string;
  fix: string;
  repro?: Repro;
}

export interface ReviewVerdict {
  verdict: "approve" | "changes_requested";
  issues: ReviewIssue[];
}

/** The answer a reviewer ends with (REVIEW_SCHEMA). */
export const REVIEW_SHAPE =
  '{"verdict": "approve" | "changes_requested", "issues": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "...", ' +
  '"repro": {"path": "test file to add, or \\"\\"", "contents": "the whole test file, or \\"\\"", "command": "plain test command that runs it, or \\"\\""}}]}';

/** code-flow runs at most this many repros per review; the rest count as not checked. */
const MAX_REPROS = 6;

const SEVERITIES = ["high", "medium", "low"] as const;

/** What a reviewer is told about severities and repros: code-flow runs the evidence. */
export function reproRule(ctx: TeamContext): string {
  const check = ctx.hasCheck ? ctx.run.loop.check : undefined;
  return section(
    "Show it (code-flow runs your tests)",
    "Severity decides what blocks approval: high and medium issues block, low ones are suggestions. " +
      "A high-severity issue says the code has a bug, so show it with a `repro`: a test that fails on this code because of the bug. " +
      "Give the test file's path, named like the project's tests, and its whole contents" +
      (check
        ? `. code-flow adds it to a copy of this code and runs \`${check}\` there, or the plain test command you give instead (one that runs just your test, say).`
        : ", and the plain test command that runs it (e.g. `pytest tests/test_bug.py`): this run has no check of its own.") +
      " A command alone can run tests that are already there. " +
      "A high-severity issue blocks only if its test fails. If the test passes, the issue is a false alarm and doesn't block; " +
      "without a repro it's marked unconfirmed and doesn't block either, so rate a problem no test can show medium. " +
      'A repro on a medium issue is welcome too: if it passes, that issue doesn\'t block. Use "" for every `repro` field when there\'s none.',
  );
}

/**
 * Check a review's issues on the result in `wt`: each high or medium issue's repro runs there
 * (low issues are suggestions, not run). Records the review on the run and logs what it found.
 * Returns the findings, each marked with whether it blocks approval.
 */
export async function checkReview(
  ctx: TeamContext,
  wt: Worktree,
  opts: { label: string; reviewer: AgentId; round: number; review: ReviewVerdict },
): Promise<ReviewFinding[]> {
  const issues = opts.review.issues ?? [];
  const checks = await checkIssues(ctx, wt, issues, "Reviewer's test");
  const findings = issues.map((issue, i): ReviewFinding => {
    const severity = severityOf(issue.severity);
    const check = checks[i]!;
    return { severity, file: issue.file ?? "", problem: issue.problem, fix: issue.fix ?? "", check, blocking: blocks(severity, check.status) };
  });
  ctx.setFindings(wt, { reviewer: opts.reviewer, round: opts.round, verdict: opts.review.verdict, findings, at: Date.now() });
  const blocking = findings.filter((f) => f.blocking);
  ctx.log(`${opts.label}: ${opts.review.verdict} (${findings.length} issues${findings.length ? `; ${tally(findings)}` : ""})`);
  // Recurring problems are passed on to later runs; false alarms aren't problems.
  if (blocking.length) ctx.learn(findings.filter((f) => f.check.status !== "refuted"));
  return findings;
}

/**
 * Run the repro of each high or medium issue on the result in `wt`, in order, at most
 * MAX_REPROS of them (low issues are suggestions, not run). `title` starts each step's title.
 */
export async function checkIssues(ctx: TeamContext, wt: Worktree, issues: ReviewIssue[], title: string): Promise<FindingCheck[]> {
  const checks: FindingCheck[] = [];
  let ran = 0;
  for (const issue of issues) {
    if (severityOf(issue.severity) === "low") checks.push({ status: "unconfirmed", detail: "a suggestion: not checked" });
    else if (!hasRepro(issue.repro)) checks.push({ status: "unconfirmed", detail: "no test came with it" });
    else if (ran >= MAX_REPROS) checks.push({ status: "unverified", detail: `not run: code-flow runs at most ${MAX_REPROS} tests per review` });
    else {
      ran++;
      checks.push(await ctx.reproduce(wt, issue.repro, `${title}: ${short(issue.problem)}`));
    }
  }
  return checks;
}

export function severityOf(severity: string): ReviewFinding["severity"] {
  return SEVERITIES.find((s) => s === severity) ?? "medium";
}

/** True when nothing in the review blocks approval. */
export function approves(findings: ReviewFinding[]): boolean {
  return !findings.some((f) => f.blocking);
}

/**
 * What the builder (or whoever fixes) is told about a review: confirmed findings with the
 * reviewer's test and how it fails, the ones no test shows (which it may dispute with evidence),
 * false alarms, and suggestions.
 */
export function findingsForBuilder(reviewer: AgentId, findings: ReviewFinding[]): string {
  const confirmed = findings.filter((f) => f.check.status === "confirmed" && f.severity !== "low");
  const open = findings.filter((f) => f.check.status !== "confirmed" && f.check.status !== "refuted" && f.severity !== "low");
  const falseAlarms = findings.filter((f) => f.check.status === "refuted" && f.severity !== "low");
  const suggestions = findings.filter((f) => f.severity === "low");
  const item = (f: ReviewFinding, i: number) => `${i + 1}. **${f.severity}** \`${f.file || "general"}\` — ${f.problem}\n   Suggested fix: ${f.fix || "(none given)"}`;
  return (
    `The ${getAdapter(reviewer).displayName} reviewer's findings, checked by code-flow. Fix what blocks, re-run the tests, then summarize what you fixed and anything you dispute.` +
    (confirmed.length
      ? section(
          "Confirmed: the reviewer's test fails on your code (these block)",
          confirmed
            .map(
              (f, i) =>
                item(f, i) +
                (f.check.path && f.check.contents ? `\n   The test, \`${f.check.path}\`:\n${fence(f.check.contents)}` : "") +
                `\n   \`${f.check.command}\` fails:\n${fence(f.check.detail)}`,
            )
            .join("\n") +
            "\n\nMake each of these tests pass by fixing the code, and add the reviewer's test (or one like it) to your change. If a test itself is wrong, say why instead.",
        )
      : "") +
    (open.length
      ? section(
          "Not shown by a test",
          open.map((f, i) => `${item(f, i)}\n   ${openNote(f)}`).join("\n") +
            "\n\nFix these if you agree. If you don't, change nothing for it and say why, with evidence (a test you ran, the code that already handles it): the reviewer sees your answer.",
        )
      : "") +
    (falseAlarms.length
      ? section("False alarms: the reviewer's own test passes (no change needed)", falseAlarms.map((f, i) => item(f, i)).join("\n"))
      : "") +
    (suggestions.length ? section("Suggestions (low severity, optional)", suggestions.map((f, i) => item(f, i)).join("\n")) : "")
  );
}

/** A reviewer seeing the result again, after the builder answered its findings. */
export function builderReply(text: string | undefined): string {
  if (!text?.trim()) return "";
  return section(
    "The builder's answer to your review",
    `${text.trim()}\n\nIt may dispute findings no test shows. Drop the ones it shows are wrong; keep a disputed bug only with a repro that fails.`,
  );
}

/** The findings for a result summary, each marked with what code-flow found. Empty without findings. */
export function findingsSection(title: string, findings: ReviewFinding[]): string {
  if (!findings.length) return "";
  return section(
    title,
    findings.map((f) => `- **${f.severity}** \`${f.file || "general"}\` — ${f.problem} — ${checkMark(f)}${f.blocking ? " · blocks" : ""}`).join("\n"),
  );
}

/** One line on what the review left: unconfirmed claims and false alarms. Empty when there's nothing to flag. */
export function findingsLine(findings: ReviewFinding[]): string {
  const unconfirmed = findings.filter((f) => f.severity === "high" && f.check.status === "unconfirmed").length;
  const falseAlarms = findings.filter((f) => f.check.status === "refuted" && f.severity !== "low").length;
  const parts = [
    unconfirmed ? `⚠ ${unconfirmed} unconfirmed high-severity claim${unconfirmed === 1 ? "" : "s"} (no test shows it; not blocking)` : "",
    falseAlarms ? `${falseAlarms} false alarm${falseAlarms === 1 ? "" : "s"} (the reviewer's own test passes)` : "",
  ].filter(Boolean);
  return parts.length ? `Review findings: ${parts.join("; ")}.` : "";
}

/** How a finding was checked, in a few words. */
export function checkMark(f: { severity: string; check?: FindingCheck }): string {
  const check = f.check;
  if (!check) return "not checked";
  if (check.status === "confirmed") return "✓ confirmed: its test fails";
  if (check.status === "refuted") return "✗ not confirmed: its test passes (a false alarm)";
  if (f.severity === "low") return "suggestion";
  if (check.status === "unverified") return `couldn't run its test (${check.detail})`;
  return f.severity === "high" ? "⚠ unconfirmed: no test shows it" : "no test";
}

/** Order for ranking: confirmed first, false alarms last. */
export const CONFIRMATION = { confirmed: 0, unverified: 1, unconfirmed: 2, refuted: 3 } as const;

/** A repro worth running: a test file or a command. */
export function hasRepro(repro: Repro | undefined): repro is Repro {
  return !!repro && (!!repro.path?.trim() || !!repro.command?.trim());
}

function openNote(f: ReviewFinding): string {
  if (f.check.status === "unverified") return `code-flow couldn't run the reviewer's test: ${f.check.detail}. It blocks on the reviewer's word.`;
  if (f.severity === "high") return `Unconfirmed: ${f.check.detail}. A bug claim nobody has shown; it doesn't block.`;
  return "No test with it; it blocks on the reviewer's word.";
}

function tally(findings: ReviewFinding[]): string {
  const count = (pred: (f: ReviewFinding) => boolean) => findings.filter(pred).length;
  const parts = [
    [count((f) => f.blocking), "blocking"],
    [count((f) => f.check.status === "confirmed"), "confirmed by a failing test"],
    [count((f) => f.check.status === "refuted"), "false alarm (its test passes)"],
    [count((f) => f.severity === "high" && f.check.status === "unconfirmed"), "unconfirmed high-severity claim"],
  ] as const;
  return parts.map(([n, what]) => `${n} ${what}`).filter((p) => !p.startsWith("0 ")).join(", ") || "none blocking";
}

function short(text: string): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
