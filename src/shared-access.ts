import type { Run, RunEvent, RunSummary, Step } from "./engine.js";
import type { Project } from "./projects.js";
import type { SharedPrincipal, SharedRole } from "./shared-accounts.js";
import { redactExport } from "./privacy.js";
import { sensitiveContextPath } from "./context-inspection.js";
import type { DiffFile } from "./ship.js";

export type SharedRoutePolicy = "owner" | "identity" | "catalog" | "project-list" | "run-list" | "run-read" | "run-review";
export class SharedPathError extends Error { readonly status = 400; }
/** Inspect the original request target before WHATWG URL normalization can erase traversal. */
export function canonicalSharedPath(target: string): { pathname: string; parts: string[] } {
  const raw = target.split("?")[0]!;
  if (!raw.startsWith("/") || raw.length > 4000 || /[\\#\x00-\x20\x7f]/.test(raw) || /%(?:2f|5c|00|25)/i.test(raw)) throw new SharedPathError("Invalid request path");
  let path: string; try { path = decodeURIComponent(raw); } catch { throw new SharedPathError("Invalid request path encoding"); }
  if (/[\\#\x00-\x20\x7f]/.test(path)) throw new SharedPathError("Invalid request path");
  const parts = path === "/" ? [] : path.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new SharedPathError("Ambiguous request path");
  if (parts[0] === "api" && parts[1] === "v1" && parts[2] !== "capabilities") parts.splice(1, 1);
  return { pathname: `/${parts.join("/")}`, parts };
}
/** Explicit method and exact segment counts: new endpoints never gain shared access by accident. */
export function sharedRoutePolicy(method: string, parts: readonly string[]): SharedRoutePolicy {
  const route = parts.join("/");
  if ((method === "GET" && route === "api/auth/self") || (method === "POST" && route === "api/auth/logout")) return "identity";
  if (method === "GET" && ["api/patterns", "api/templates"].includes(route)) return "catalog";
  if (method === "GET" && route === "api/projects") return "project-list";
  if (method === "GET" && ["api/runs", "api/events"].includes(route)) return "run-list";
  if (parts[0] === "api" && parts[1] === "runs" && /^[a-zA-Z0-9_-]{1,100}$/.test(parts[2] ?? "")) {
    if (method === "GET" && (parts.length === 3 || parts.length === 4 && ["events", "export", "diff", "review-coverage", "collaboration"].includes(parts[3]!))) return "run-read";
    if (method === "POST" && parts.length === 4 && ["review-coverage", "collaboration"].includes(parts[3]!)) return "run-review";
  }
  return "owner";
}
export function sharedProjectRole(identity: SharedPrincipal, projectId: string | undefined): SharedRole | undefined { return projectId && Object.hasOwn(identity.roles, projectId) ? identity.roles[projectId] : undefined; }
/** A removed/ambiguous repository never silently inherits permission through another assigned project. */
export function sharedCanReadRun(identity: SharedPrincipal, run: Pick<Run, "project" | "repo">, projects: readonly Project[]): boolean {
  const candidates = run.project ? projects.filter((project) => project.id === run.project) : projects.filter((project) => project.repos.includes(run.repo));
  return candidates.length === 1 && candidates[0]!.repos.includes(run.repo) && !!sharedProjectRole(identity, candidates[0]!.id);
}
export function sharedProjectProjection(project: Project) { return { id: project.id, name: project.name, createdAt: project.createdAt }; }
export function sharedDiffProjection(files: readonly DiffFile[]): DiffFile[] { return redactExport(files.filter((file) => !sensitiveContextPath(file.path) && (!file.oldPath || !sensitiveContextPath(file.oldPath)))); }
export function sharedCoverageProjection(value: { head: string; files: string[]; reviewed: string[]; stale?: boolean }) {
  const files = value.files.filter((path) => !sensitiveContextPath(path)); const reviewed = value.reviewed.filter((path) => files.includes(path));
  return { scope: "shared-reviewable-files" as const, omittedCount: value.files.length - files.length, head: value.head, files, reviewed, stale: !!value.stale, coverage: { changed: files.length, reviewed: reviewed.length, percent: files.length ? Math.round(reviewed.length / files.length * 100) : 100 } };
}
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as Pick<T, K>; }
function boundedText(value: string | undefined, ceiling: number) {
  if (value === undefined) return { text: undefined, truncated: false };
  const data = Buffer.from(value); if (data.length <= ceiling) return { text: value, truncated: false };
  let end = ceiling; while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return { text: data.subarray(0, end).toString("utf8"), truncated: true };
}
function stepProjection(step: Step) {
  const finalText = boundedText(step.finalText, 8 * 1024), error = boundedText(step.error, 4 * 1024);
  return redactExport({ ...pick(step, ["id", "kind", "title", "role", "agent", "memberId", "taskId", "coordination", "invocations", "status", "startedAt", "endedAt", "retries"]), ...(finalText.text !== undefined ? { finalText: finalText.text } : {}), ...(error.text !== undefined ? { error: error.text } : {}), finalTextTruncated: finalText.truncated, errorTruncated: error.truncated, ...(step.contextInput ? { contextInput: pick(step.contextInput, ["scope", "measuredAt", "promptBytes", "schemaBytes", "bytes", "approximateTokens", "resumed", "excluded", "policy", "exceeded", "violations"]) } : {}) });
}
export function sharedRunProjection(run: Run | RunSummary, canReadRun: (id: string) => boolean = () => false) {
  const verification = run.verification, task = boundedText(run.task, 24 * 1024), summary = boundedText(run.summary, 32 * 1024), error = boundedText(run.error, 4 * 1024);
  const cold = (run as RunSummary).cold ? { cold: true as const, detailAvailable: true as const } : {};
  const steps = "steps" in run ? run.steps.slice(-200).map(stepProjection) : undefined;
  return redactExport({
    ...pick(run, ["id", "project", "pattern", "status", "createdAt", "endedAt", "baseRef", "baseLabel", "stopReason", "verdict", "facts"]), ...cold, task: task.text!, ...(summary.text !== undefined ? { summary: summary.text } : {}), ...(error.text !== undefined ? { error: error.text } : {}),
    truncation: { task: task.truncated, summary: summary.truncated, error: error.truncated, omittedSteps: "steps" in run ? Math.max(0, run.steps.length - 200) : 0 },
    worktrees: run.worktrees.map((worktree) => pick(worktree, ["name", "branch"])),
    ...(steps ? { steps } : {}),
    ...(run.parentRunId && canReadRun(run.parentRunId) ? { parentRunId: run.parentRunId } : {}),
    ...(run.supersededBy && canReadRun(run.supersededBy) ? { supersededBy: run.supersededBy } : {}),
    ...(verification ? { verification: { ...pick(verification, ["version", "profile", "state", "startedAt", "endedAt", "head", "branch"]), checks: verification.checks.map((evidence) => ({ check: pick(evidence.check, ["id", "title", "kind", "required"]), diagnosis: evidence.diagnosis })), ...(verification.requirements ? { requirements: verification.requirements.map((requirement) => pick(requirement, ["id", "description", "covered", "missing"])) } : {}) } } : {}),
  });
}
export type SharedRun = ReturnType<typeof sharedRunProjection>;
/** Raw agent events, logs, prompts, tool capabilities, session IDs and private memory never cross this boundary. */
export function sharedEventProjection(event: RunEvent, canReadRun: (id: string) => boolean = () => false): Record<string, unknown> | undefined {
  if (!canReadRun(event.runId)) return undefined;
  const common = { seq: event.seq, ts: event.ts, runId: event.runId };
  if (event.type === "run") return { ...common, type: "run", run: sharedRunProjection(event.run, canReadRun) };
  if (event.type === "step") return { ...common, type: "step", step: stepProjection(event.step) };
  return undefined;
}
