import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cantRunReason, detectCheckCommand, failureExcerpt, failureFingerprint, runCheck, type CheckResult, type Container } from "./checks.js";

export type VerificationKind = "build" | "typecheck" | "lint" | "unit" | "integration" | "browser" | "mutation" | "visual" | "accessibility" | "custom";
export type VerificationPreset = "lightweight" | "standard" | "thorough";
export interface VerificationCheck {
  id: string;
  title?: string;
  kind: VerificationKind;
  command: string;
  required: boolean;
  timeoutMs: number;
}
export interface VerificationProfile {
  name: string;
  checks: VerificationCheck[];
  source?: string;
  setup?: string;
  requirements?: VerificationRequirement[];
}
export type VerificationState = "verified" | "needs-changes" | "unchecked" | "blocked";
export type CheckDiagnosis = "passed" | "regression" | "pre-existing" | "flaky" | "environment" | "failed";
export interface VerificationEvidence {
  check: VerificationCheck;
  attempts: CheckResult[];
  diagnosis: CheckDiagnosis;
  baseline?: CheckResult;
  reason?: string;
}
export interface ChangedFile { path: string; additions?: number; deletions?: number }
export interface ChangeRisk { level: "low" | "medium" | "high"; reasons: string[]; sensitiveFiles: string[] }
export interface ReviewCoverage { changed: number; reviewed: number; percent: number; unreviewed: string[] }
export interface VerificationRequirement { id: string; description: string; checks: string[] }
export interface VerificationReport {
  version: 1;
  profile: string;
  state: VerificationState;
  startedAt: number;
  endedAt: number;
  checks: VerificationEvidence[];
  skipped: { check: VerificationCheck; reason: string }[];
  risk?: ChangeRisk;
  review?: ReviewCoverage;
  requirements?: { id: string; description: string; covered: boolean; missing: string[] }[];
}

const KINDS = new Set<VerificationKind>(["build", "typecheck", "lint", "unit", "integration", "browser", "mutation", "visual", "accessibility", "custom"]);
const DEFAULT_CHECK_TIMEOUT = 5 * 60_000;
const MAX_CHECK_TIMEOUT = 30 * 60_000;
const MAX_SUITE_TIMEOUT = 60 * 60_000;

/** Validate at the API boundary; commands come from the user's repository or explicit configuration. */
export function validateVerificationProfile(value: unknown): VerificationProfile {
  if (!value || typeof value !== "object") throw new Error("A verification profile is required");
  const p = value as Record<string, unknown>;
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 120) throw new Error("Verification profile needs a name of at most 120 characters");
  if (!Array.isArray(p.checks) || p.checks.length > 12) throw new Error("Verification profiles support at most 12 checks");
  const ids = new Set<string>();
  const checks = p.checks.map((raw): VerificationCheck => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid verification check");
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(c.id) || ids.has(c.id)) throw new Error("Verification check IDs must be unique and contain letters, digits, underscores or hyphens");
    ids.add(c.id);
    if (!KINDS.has(c.kind as VerificationKind)) throw new Error(`Unknown verification kind for ${c.id}`);
    if (typeof c.command !== "string" || !c.command.trim() || c.command.length > 4_000 || c.command.includes("\0")) throw new Error(`Invalid command for ${c.id}`);
    const timeoutMs = c.timeoutMs ?? DEFAULT_CHECK_TIMEOUT;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CHECK_TIMEOUT) throw new Error(`Check timeout must be between 1 ms and ${MAX_CHECK_TIMEOUT} ms`);
    if (c.required !== undefined && typeof c.required !== "boolean") throw new Error(`Invalid required flag for ${c.id}`);
    return { id: c.id, ...(typeof c.title === "string" && c.title.trim() ? { title: c.title.trim().slice(0, 120) } : {}), kind: c.kind as VerificationKind, command: c.command.trim(), required: c.required !== false, timeoutMs };
  });
  let requirements: VerificationRequirement[] | undefined;
  if (p.requirements !== undefined) {
    if (!Array.isArray(p.requirements) || p.requirements.length > 48) throw new Error("Verification supports at most 48 requirement mappings");
    const requirementIds = new Set<string>();
    requirements = p.requirements.map((raw): VerificationRequirement => {
      if (!raw || typeof raw !== "object") throw new Error("Invalid requirement mapping");
      const requirement = raw as Record<string, unknown>;
      if (typeof requirement.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(requirement.id) || requirementIds.has(requirement.id) || typeof requirement.description !== "string" || !requirement.description.trim() || requirement.description.length > 4000 || !Array.isArray(requirement.checks) || requirement.checks.some((id) => typeof id !== "string" || !ids.has(id)) || new Set(requirement.checks).size !== requirement.checks.length) throw new Error("Requirements need unique IDs, descriptions, and references to configured checks");
      requirementIds.add(requirement.id);
      return { id: requirement.id, description: requirement.description.trim(), checks: [...requirement.checks] as string[] };
    });
  }
  return { name: p.name.trim(), checks, ...(requirements ? { requirements } : {}), ...(typeof p.source === "string" ? { source: p.source.slice(0, 500) } : {}), ...(typeof p.setup === "string" && p.setup.trim() ? { setup: p.setup.trim().slice(0, 4_000) } : {}) };
}

/** Discover existing scripts only; never invent commands that are absent from a repository. */
export async function detectVerificationProfile(repo: string, preset: VerificationPreset = "standard"): Promise<VerificationProfile> {
  if (!["lightweight", "standard", "thorough"].includes(preset)) throw new Error("Unknown verification preset");
  const include: VerificationKind[] = preset === "lightweight" ? ["typecheck", "lint", "unit"] : preset === "standard" ? ["build", "typecheck", "lint", "unit"] : ["build", "typecheck", "lint", "unit", "integration", "browser", "mutation", "visual", "accessibility"];
  const has = (path: string) => existsSync(join(repo, path));
  const checks: VerificationCheck[] = [];
  if (has("package.json")) {
    let pkg: { scripts?: Record<string, unknown> };
    try { pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")); }
    catch { throw new Error("Cannot detect verification: package.json is not valid JSON"); }
    const runner = has("pnpm-lock.yaml") ? "pnpm run" : has("yarn.lock") ? "yarn run" : has("bun.lock") || has("bun.lockb") ? "bun run" : "npm run";
    const scripts: [VerificationKind, string[]][] = [["build", ["build"]], ["typecheck", ["typecheck", "check:types"]], ["lint", ["lint"]], ["unit", ["test:unit", "test"]], ["integration", ["test:integration"]], ["browser", ["test:e2e", "test:browser"]], ["mutation", ["test:mutation", "mutation"]], ["visual", ["test:visual"]], ["accessibility", ["test:a11y", "test:accessibility"]]];
    for (const [kind, candidates] of scripts) {
      if (!include.includes(kind)) continue;
      const script = candidates.find((name) => typeof pkg.scripts?.[name] === "string" && String(pkg.scripts[name]).trim() && !/no test specified/i.test(String(pkg.scripts[name])));
      if (script) checks.push({ id: kind, kind, command: `${runner} ${script}`, required: true, timeoutMs: DEFAULT_CHECK_TIMEOUT });
    }
    if (checks.length) return { name: preset, checks, source: "package.json" };
  }
  const detected = await detectCheckCommand(repo);
  if (detected) checks.push({ id: "unit", kind: "unit", command: detected.command, required: true, timeoutMs: DEFAULT_CHECK_TIMEOUT });
  return { name: preset, checks, source: detected?.source, setup: detected?.setup };
}

/** Mixed repeated results stay flaky even if the latest attempt passes. */
export function diagnoseChecks(attempts: CheckResult[], baseline?: CheckResult): { diagnosis: CheckDiagnosis; reason?: string } {
  if (!attempts.length) return { diagnosis: "failed", reason: "No check attempt completed" };
  if (attempts.some((a) => a.ok) && attempts.some((a) => !a.ok)) return { diagnosis: "flaky", reason: "The same command both passed and failed on this revision" };
  if (attempts.every((a) => a.ok)) return { diagnosis: "passed" };
  const reason = attempts.map(cantRunReason).find(Boolean);
  if (reason) return { diagnosis: "environment", reason };
  if (baseline?.ok) return { diagnosis: "regression", reason: "This check passed on the baseline revision" };
  if (baseline && !baseline.ok && attempts.every((a) => failureFingerprint(a) === failureFingerprint(baseline))) return { diagnosis: "pre-existing", reason: "The baseline reports the same failure; this check still requires attention" };
  return { diagnosis: "failed" };
}

export function resultState(checks: VerificationEvidence[], skipped: VerificationReport["skipped"] = []): VerificationState {
  if (skipped.some((c) => c.check.required)) return "blocked";
  const required = checks.filter((c) => c.check.required);
  if (required.some((c) => c.diagnosis === "environment")) return "blocked";
  if (required.some((c) => c.diagnosis !== "passed")) return "needs-changes";
  return required.length ? "verified" : "unchecked";
}

export interface VerificationOptions {
  signal?: AbortSignal;
  container?: Container;
  /** Overall deadline, in addition to each command's timeout. Maximum one hour. */
  timeoutMs?: number;
  /** Run every check this many times on the same revision (1–3). */
  repeats?: number;
  baseline?: Record<string, CheckResult>;
  changedFiles?: ChangedFile[];
  reviewedFiles?: string[];
  requirements?: VerificationRequirement[];
  /** Engine integration can journal and publish each bounded gate through its command runner. */
  execute?: (check: VerificationCheck, opts: { timeoutMs: number; signal?: AbortSignal; container?: Container }) => Promise<CheckResult>;
}

export async function runVerification(cwd: string, input: VerificationProfile, opts: VerificationOptions = {}): Promise<VerificationReport> {
  const profile = validateVerificationProfile(input);
  const repeats = opts.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("Verification repeats must be between 1 and 3");
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SUITE_TIMEOUT) throw new Error("Verification deadline must be between 1 ms and one hour");
  const startedAt = Date.now();
  const checks: VerificationEvidence[] = [];
  const skipped: VerificationReport["skipped"] = [];
  for (const check of profile.checks) {
    if (opts.signal?.aborted || Date.now() - startedAt >= timeoutMs) {
      skipped.push({ check, reason: opts.signal?.aborted ? "Verification was cancelled" : "The verification deadline was reached" });
      continue;
    }
    const attempts: CheckResult[] = [];
    for (let i = 0; i < repeats; i++) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (opts.signal?.aborted || remaining <= 0) break;
      const execution = { timeoutMs: Math.min(check.timeoutMs, remaining), signal: opts.signal, container: opts.container };
      attempts.push(await (opts.execute ? opts.execute(check, execution) : runCheck(cwd, check.command, execution)));
    }
    const baseline = opts.baseline?.[check.id];
    const diagnosis = diagnoseChecks(attempts, baseline);
    if (["unit", "integration", "browser"].includes(check.kind) && attempts.some((attempt) => attempt.tests === 0)) {
      diagnosis.diagnosis = "failed";
      diagnosis.reason = "The test runner reported zero executed tests";
    }
    checks.push({ check, attempts, baseline, ...diagnosis });
    if (attempts.length < repeats || opts.signal?.aborted) skipped.push({ check, reason: opts.signal?.aborted ? "Verification was cancelled" : "Repeated verification did not complete before the deadline" });
  }
  const requirements = (opts.requirements ?? profile.requirements)?.map((r) => {
    const missing = r.checks.filter((id) => !checks.some((c) => c.check.id === id && c.diagnosis === "passed"));
    return { id: r.id, description: r.description, covered: r.checks.length > 0 && !missing.length, missing };
  });
  let state = resultState(checks, skipped);
  if (state === "verified" && requirements?.some((r) => !r.covered)) state = "needs-changes";
  return { version: 1, profile: profile.name, state, startedAt, endedAt: Date.now(), checks, skipped, requirements,
    ...(opts.changedFiles ? { risk: assessChangeRisk(opts.changedFiles), review: reviewCoverage(opts.changedFiles.map((f) => f.path), opts.reviewedFiles ?? []) } : {}) };
}

export function assessChangeRisk(files: ChangedFile[]): ChangeRisk {
  const reasons = new Set<string>();
  const sensitiveFiles: string[] = [];
  for (const f of files) {
    const path = f.path.replaceAll("\\", "/");
    let sensitive = false;
    for (const [pattern, reason] of [
      [/(^|\/)(migrations?|schema)(\/|\.)|\.sql$/i, "Database or schema changes require migration review"],
      [/(^|[\/_-])(auth|permissions?|security|secrets?|credentials?|crypto)([\/_.-]|$)/i, "Authentication, permissions or sensitive data handling changed"],
      [/(^|\/)(\.github\/workflows|Dockerfile|\.env)|(^|\/)(deploy|infra|terraform)(\/|\.)/i, "Execution or deployment configuration changed"],
    ] as [RegExp, string][]) if (pattern.test(path)) { reasons.add(reason); sensitive = true; }
    if (sensitive) sensitiveFiles.push(f.path);
  }
  const lines = files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  if (files.length > 20 || lines > 1_000) reasons.add("Large change surface needs broader verification");
  return { level: sensitiveFiles.length ? "high" : reasons.size || files.length > 5 ? "medium" : "low", reasons: [...reasons], sensitiveFiles };
}

export function reviewCoverage(changed: string[], reviewed: string[]): ReviewCoverage {
  const normalize = (p: string) => p.replaceAll("\\", "/").replace(/^\.\//, "");
  const files = [...new Set(changed.map(normalize))];
  const seen = new Set(reviewed.map(normalize));
  const unreviewed = files.filter((f) => !seen.has(f));
  return { changed: files.length, reviewed: files.length - unreviewed.length, percent: files.length ? Math.round(100 * (files.length - unreviewed.length) / files.length) : 100, unreviewed };
}

/** Standalone Markdown report, suitable for export or a PR attachment. */
export function renderVerificationReport(report: VerificationReport): string {
  const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
  const parts = [`# Verification: ${report.state}`, "", `Profile: ${cell(report.profile)} · Duration: ${((report.endedAt - report.startedAt) / 1_000).toFixed(1)}s`, "", "| Check | Required | Result | Attempts |", "| --- | --- | --- | --- |"];
  for (const c of report.checks) parts.push(`| ${cell(c.check.title ?? c.check.id)} | ${c.check.required ? "yes" : "no"} | ${c.diagnosis} | ${c.attempts.length} |`);
  for (const s of report.skipped) parts.push(`| ${cell(s.check.id)} | ${s.check.required ? "yes" : "no"} | skipped: ${cell(s.reason)} | 0 |`);
  for (const c of report.checks.filter((c) => c.diagnosis !== "passed")) {
    const output = failureExcerpt(c.attempts.find((a) => !a.ok)?.output ?? c.reason ?? "No output");
    const fence = "`".repeat(Math.max(3, ...[...output.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    parts.push("", `## ${cell(c.check.id)}: ${c.diagnosis}`, "", c.reason ?? "The check did not pass.", "", fence, output, fence);
  }
  if (report.risk) parts.push("", `Change risk: ${report.risk.level}`, ...report.risk.reasons.map((r) => `- ${r}`));
  if (report.review) parts.push("", `Review coverage: ${report.review.reviewed}/${report.review.changed} files (${report.review.percent}%)`, ...report.review.unreviewed.map((p) => `- Unreviewed: ${p}`));
  if (report.requirements) parts.push("", "Requirements:", ...report.requirements.map((r) => `- ${r.covered ? "[x]" : "[ ]"} ${r.id}: ${r.description}${r.missing.length ? ` (missing: ${r.missing.join(", ")})` : ""}`));
  return `${parts.join("\n")}\n`;
}
