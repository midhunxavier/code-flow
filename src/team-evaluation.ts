import { createHash } from "node:crypto";
import type { Run, Step } from "./engine.js";
import type { MemoryEntry } from "./memory.js";

export type EvaluationMode = "fake" | "real" | "unknown";
export interface ReplayMeasurement { bytes: number; records: number; durationMs: number; kind: "journal-load" | "execution-replay" }
export interface EvaluationReproducibility {
  nodeVersion: string;
  platform: string;
  applicationRevision?: string;
  applicationDirty?: boolean;
  fixtureTree?: string;
  requestedSettings: Record<string, { model?: string; effort?: string }>;
  /** These are requested settings; CLIs may resolve aliases or select a server-side default. */
  stepSettings: { provider: string; model?: string; effort?: string }[];
}
export interface TeamEvaluation {
  version: 1;
  id: string;
  runId: string;
  at: number;
  mode: EvaluationMode;
  caseId: string;
  pairId?: string;
  taskHash: string;
  baseRef: string;
  pattern: string;
  cliVersions: Record<string, string>;
  reproducibility?: EvaluationReproducibility;
  status: Run["status"];
  verified: boolean;
  verification: { checks: "passed" | "failed" | "not_required" | "unknown"; review: "approved" | "rejected" | "unknown"; proof?: string; proofNotRequired?: "unchanged-rerun" | "documentation-only"; gaps: number; requirements: number; covered: number; integrityFlags: number; retainedTasks?: number; newlyExecutedTasks?: number; requirementsUsingBaseline?: number };
  metrics: {
    invocations: number; coordinatorInvocations: number; coordinatorFraction: number | null; workerTurns: number; multiWorker: boolean;
    elapsedMs?: number; activeWorkMs: number; coordinatorMs?: number;
    reportedTokens?: number; reportedApiCostUsd?: number; tokenReportingTurns: number;
    questions: number; peerQuestions: number; blockedTurns: number; peerYieldRate: number | null;
    peerWaitingMs?: number; peerWaitingWallMs?: number; avoidableBarrierEstimateMs?: number;
    timedPeerQuestions: number; repairTurns: number; selectedMemories: number; omittedMemories: number;
    coordinatorRevisions: number;
    approvals?: { approved: number; revised: number; rejected: number; withReason: number };
    memoryFeedback?: { useful: number; irrelevant: number; stale: number; incorrect: number };
    replay?: ReplayMeasurement;
  };
  limitations: string[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const interval = (start: unknown, end: unknown): [number, number][] => finite(start) && finite(end) && end >= start ? [[start, end]] : [];
/** Union, rather than sum, makes parallel turns comparable to elapsed wall time. */
export function intervalDuration(intervals: readonly [number, number][]): number {
  let total = 0, start = -1, end = -1;
  for (const [a, b] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (a > end) { if (start >= 0) total += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  return total + (start < 0 ? 0 : end - start);
}

export function buildTeamEvaluation(run: Run, options: { mode?: EvaluationMode; cliVersions?: Record<string, string>; caseId?: string; pairId?: string; replay?: ReplayMeasurement; journal?: ReadonlyMap<string, unknown>; memoryEntries?: MemoryEntry[]; reproducibility?: Partial<Omit<EvaluationReproducibility, "requestedSettings" | "stepSettings">> } = {}): TeamEvaluation {
  const team = run.team;
  const turns = run.steps.filter((step) => step.kind === "agent");
  const coordinator = (step: Step) => step.coordination === true || (!team && step.role === "supervisor");
  const workers = turns.filter((step) => {
    if (!team) return step.role === "workers" || step.role === "worker";
    const member = team.members.find((item) => item.id === step.memberId);
    // Answer and final repair turns retain member identity but may have no task ID.
    if (member) return member.role === "worker" && !coordinator(step);
    // Older records may lack the member map; retain their task-based classification.
    return !!step.taskId && !coordinator(step) && step.role !== "coordinator" && step.role !== "reviewer";
  });
  const invocations = team?.metrics.invocations ?? turns.reduce((sum, step) => sum + (step.invocations ?? 1), 0);
  const coordination = team?.metrics.coordinatorInvocations ?? turns.filter(coordinator).reduce((sum, step) => sum + (step.invocations ?? 1), 0);
  const peer = (team?.messages ?? []).filter((message) => message.kind === "question" && message.recipient !== "user" && message.originalRecipient !== "user");
  const peerIntervals = peer.flatMap((message) => interval(message.createdAt, message.answeredAt));
  const barriers: [number, number][] = [];
  for (const message of peer) {
    if (!finite(message.answeredAt)) continue;
    const task = team?.tasks.find((item) => item.id === message.taskId);
    // A reply does not make code dependencies available. Count an estimate only where
    // every declared dependency was complete at reply time and a later turn actually ran.
    if (!task || !task.dependsOn.every((id) => { const dependency = team?.tasks.find((item) => item.id === id); return finite(dependency?.finishedAt) && dependency.finishedAt <= message.answeredAt!; })) continue;
    const next = workers.filter((step) => step.taskId === task.id && step.startedAt >= message.answeredAt!).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (next) barriers.push([message.answeredAt, next.startedAt]);
  }
  const usage = turns.filter((step) => step.usage);
  const integrityFlags = Object.values(run.integrity ?? {}).reduce((sum, issues) => sum + issues.length, 0);
  const check = team?.verification?.check === "not_required" ? "not_required" : run.verdict === "passed" ? "passed" : run.verdict === "failing" ? "failed" : "unknown";
  const approved = team ? !!team.verification?.reviewed && !!team.verification.approved : run.facts?.approved === true;
  const requirements = team?.requirements.length ?? 0;
  const covered = team?.requirements.filter((requirement) => {
    const tasks = team.tasks.filter((task) => task.requirements.includes(requirement.id));
    return tasks.length > 0 && tasks.every((task) => task.status === "completed" && !task.evidenceStale && (!task.retainedBaseline || approved));
  }).length ?? 0;
  const gaps = team?.gaps.length ?? 0;
  const unchangedRerun = !!run.teamRerun && run.facts?.proofNotRequired === "unchanged-rerun" && check === "passed" && approved;
  const documentationOnly = run.facts?.proofNotRequired === "documentation-only" && check === "passed" && approved;
  const verified = run.status === "done" && approved && (check === "passed" || check === "not_required") && !gaps && !integrityFlags && (!team || team.status === "completed" && covered === requirements) && (run.prove === false || check === "not_required" || run.facts?.proof === "proven" || unchangedRerun || documentationOnly);
  const mode = options.mode ?? "unknown";
  const approvalAnswers = options.journal ? [...options.journal].filter(([key]) => key.startsWith("approval:")).map(([, value]) => value as { decision?: string; note?: string }) : undefined;
  const rated = options.memoryEntries?.flatMap((entry) => entry.feedback?.filter((feedback) => feedback.runId === run.id && run.memoryManifest?.included.some((ref) => ref.id === entry.id && ref.revision === feedback.revision)) ?? []);
  return {
    version: 1, id: `evaluation-${run.id}`, runId: run.id, at: run.endedAt ?? Date.now(), mode,
    caseId: options.caseId ?? "unspecified", pairId: options.pairId ?? run.group?.id,
    taskHash: createHash("sha256").update(run.task).digest("hex"), baseRef: run.baseRef, pattern: run.pattern,
    cliVersions: { ...options.cliVersions }, status: run.status, verified,
    reproducibility: { nodeVersion: process.version, platform: `${process.platform}/${process.arch}`, ...options.reproducibility,
      requestedSettings: Object.fromEntries(Object.entries(run.agentSettings ?? {}).filter((entry): entry is [string, {model?: string; effort?: string}] => entry[1] !== undefined).map(([id, settings]) => [id, structuredClone(settings)])),
      stepSettings: [...new Map(turns.filter((step) => step.agent).map((step) => { const settings = { provider: step.agent!, model: step.settings?.model, effort: step.settings?.effort }; return [JSON.stringify(settings), settings] as const; })).values()] },
    verification: { checks: check, review: approved ? "approved" : run.facts?.approved === false || team?.verification?.reviewed ? "rejected" : "unknown", proof: run.facts?.proof, proofNotRequired: run.facts?.proofNotRequired, gaps, requirements, covered, integrityFlags, ...(run.teamRerun ? { proofNotRequired: run.facts?.proofNotRequired, retainedTasks: team?.tasks.filter((task) => task.retainedBaseline).length ?? 0, newlyExecutedTasks: team?.tasks.filter((task) => !task.retainedBaseline && (task.attempts ?? 0) > 0).length ?? 0, requirementsUsingBaseline: team?.requirements.filter((requirement) => team.tasks.some((task) => task.retainedBaseline && task.requirements.includes(requirement.id))).length ?? 0 } : {}) },
    metrics: {
      invocations, coordinatorInvocations: coordination, coordinatorFraction: invocations ? coordination / invocations : null,
      workerTurns: workers.length, multiWorker: new Set(workers.map((step) => team ? step.memberId ?? step.agent : step.worktree ?? step.agent)).size > 1,
      elapsedMs: run.endedAt === undefined ? undefined : Math.max(0, run.endedAt - run.createdAt),
      activeWorkMs: intervalDuration(run.steps.flatMap((step) => interval(step.startedAt, step.endedAt))),
      coordinatorMs: turns.some(coordinator) ? turns.filter(coordinator).reduce((sum, step) => sum + (finite(step.endedAt) ? Math.max(0, step.endedAt - step.startedAt) : 0), 0) : undefined,
      reportedTokens: usage.length ? usage.reduce((sum, step) => sum + step.usage!.inputTokens + (step.usage!.cacheReadTokens ?? 0) + step.usage!.outputTokens, 0) : undefined,
      reportedApiCostUsd: usage.some((step) => step.usage!.costUsd > 0) ? usage.reduce((sum, step) => sum + step.usage!.costUsd, 0) : undefined,
      tokenReportingTurns: usage.length,
      questions: team?.metrics.questionCount ?? 0, peerQuestions: peer.length, blockedTurns: team?.metrics.blockedTurns ?? 0,
      peerYieldRate: workers.length ? new Set(peer.filter((message) => message.blocking).map((message) => `${message.sender}:${message.taskId}:${message.sourceAttempt ?? message.sourceStepId ?? message.id}`)).size / workers.length : null,
      peerWaitingMs: peerIntervals.length ? peerIntervals.reduce((sum, [a, b]) => sum + b - a, 0) : peer.length ? undefined : 0,
      peerWaitingWallMs: peerIntervals.length ? intervalDuration(peerIntervals) : peer.length ? undefined : 0,
      avoidableBarrierEstimateMs: barriers.length ? intervalDuration(barriers) : peer.length ? undefined : 0,
      timedPeerQuestions: peerIntervals.length, repairTurns: turns.filter((step) => !step.taskId && /repair|fix/i.test(step.title)).length, // engine-titled repair/fix steps, never model-titled task names
      selectedMemories: run.memoryManifest?.included.length ?? 0, omittedMemories: run.memoryManifest?.omitted.length ?? 0,
      coordinatorRevisions: team?.metrics.revisions ?? 0,
      approvals: approvalAnswers ? { approved: approvalAnswers.filter((answer) => answer.decision === "approve").length, revised: approvalAnswers.filter((answer) => answer.decision === "revise").length, rejected: approvalAnswers.filter((answer) => answer.decision === "reject").length, withReason: approvalAnswers.filter((answer) => !!answer.note?.trim()).length } : undefined,
      memoryFeedback: rated ? { useful: rated.filter((item) => item.rating === "useful").length, irrelevant: rated.filter((item) => item.rating === "irrelevant").length, stale: rated.filter((item) => item.rating === "stale").length, incorrect: rated.filter((item) => item.rating === "incorrect").length } : undefined,
      replay: options.replay,
    },
    limitations: [
      ...(mode !== "real" ? [mode === "fake" ? "Deterministic fake CLIs validate orchestration, not model quality or subscription savings." : "Execution provenance is unknown."] : []),
      "API-equivalent cost is not a subscription charge; unreported values remain unknown.",
      "Model identities record requested CLI settings. A provider default or alias is not an immutable model snapshot and may change between trials.",
      "Avoidable barrier time is a counterfactual upper-bound estimate after answered peer questions; it does not prove spare process capacity or an asynchronous speedup.",
      "Active work is the union of observed step intervals; it excludes gaps and is not a full run-clock measurement.",
      ...(run.teamRerun ? ["Selective reruns retain explicitly pinned source task inputs. Baseline task counts are not newly executed work; final review still covers every original requirement."] : []),
      ...(!team ? ["Supervisor coordination includes its planning, integration and repair turns; legacy requirements have no structured coverage manifest."] : []),
    ],
  };
}
