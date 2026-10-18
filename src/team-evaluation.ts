import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import type { Run, Step } from "./engine.js";
import type { MemoryEntry } from "./memory.js";

export type EvaluationMode = "fake" | "real" | "unknown";
export type RolloutStage = "experimental" | "beta" | "default";
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
  verification: { checks: "passed" | "failed" | "not_required" | "unknown"; review: "approved" | "rejected" | "unknown"; proof?: string; gaps: number; requirements: number; covered: number; integrityFlags: number };
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
export interface RolloutDecision { at: number; stage: RolloutStage; rationale: string; evaluationIds: string[] }
export interface TeamRollout { enabled: boolean; stage: RolloutStage; reason: string; decision?: RolloutDecision }
export interface RolloutAssessment {
  realRuns: number; realAutoRuns: number; realWorkerTurns: number; matchedPairs: number;
  verifiedAutoRuns: number; overheadFraction: number | null; peerYieldRate: number | null;
  eligibleBeta: boolean; eligibleDefault: boolean; blockers: string[];
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
    return tasks.length > 0 && tasks.every((task) => task.status === "completed" && !task.evidenceStale);
  }).length ?? 0;
  const gaps = team?.gaps.length ?? 0;
  const verified = run.status === "done" && approved && (check === "passed" || check === "not_required") && !gaps && !integrityFlags && (!team || team.status === "completed" && covered === requirements) && (run.prove === false || check === "not_required" || run.facts?.proof === "proven");
  const mode = options.mode ?? "unknown";
  const approvalAnswers = options.journal ? [...options.journal].filter(([key]) => key.startsWith("approval:")).map(([, value]) => value as { decision?: string; note?: string }) : undefined;
  const rated = options.memoryEntries?.flatMap((entry) => entry.feedback?.filter((feedback) => feedback.runId === run.id && run.memoryManifest?.included.some((ref) => ref.id === entry.id && ref.revision === feedback.revision)) ?? []);
  return {
    version: 1, id: `evaluation-${run.id}`, runId: run.id, at: run.endedAt ?? Date.now(), mode,
    caseId: options.caseId ?? "unspecified", pairId: options.pairId ?? run.group?.id,
    taskHash: createHash("sha256").update(run.task).digest("hex"), baseRef: run.baseRef, pattern: run.pattern,
    cliVersions: { ...options.cliVersions }, status: run.status, verified,
    reproducibility: { nodeVersion: process.version, platform: `${process.platform}/${process.arch}`, ...options.reproducibility,
      requestedSettings: structuredClone(run.agentSettings ?? {}),
      stepSettings: [...new Map(turns.filter((step) => step.agent).map((step) => { const settings = { provider: step.agent!, model: step.settings?.model, effort: step.settings?.effort }; return [JSON.stringify(settings), settings] as const; })).values()] },
    verification: { checks: check, review: approved ? "approved" : run.facts?.approved === false || team?.verification?.reviewed ? "rejected" : "unknown", proof: run.facts?.proof, gaps, requirements, covered, integrityFlags },
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
      ...(mode !== "real" ? [mode === "fake" ? "Deterministic fake CLIs validate orchestration, not model quality or subscription savings." : "Execution provenance is unknown; excluded from real-run rollout evidence."] : []),
      "API-equivalent cost is not a subscription charge; unreported values remain unknown.",
      "Model identities record requested CLI settings. A provider default or alias is not an immutable model snapshot and may change between trials.",
      "Avoidable barrier time is a counterfactual upper-bound estimate after answered peer questions; it does not prove spare process capacity or an asynchronous speedup.",
      "Active work is the union of observed step intervals; it excludes gaps and is not a full run-clock measurement.",
      ...(!team ? ["Supervisor coordination includes its planning, integration and repair turns; legacy requirements have no structured coverage manifest."] : []),
    ],
  };
}

export function assessTeamRollout(reports: TeamEvaluation[]): RolloutAssessment {
  const real = reports.filter((report) => report.mode === "real" && report.status !== "running");
  const auto = real.filter((report) => report.pattern === "auto-team");
  const pairs = new Map<string, TeamEvaluation[]>();
  for (const report of real) if (report.pairId) { const key = `${report.pairId}:${report.caseId}:${report.taskHash}:${report.baseRef}`; pairs.set(key, [...(pairs.get(key) ?? []), report]); }
  const matched = [...pairs.values()].filter((items) => items.some((item) => item.pattern === "auto-team") && items.some((item) => item.pattern === "supervisor"));
  const verifiedMatch = matched.some((items) => items.some((item) => item.pattern === "auto-team" && item.verified));
  const pairedQuality = matched.every((items) => !items.some((item) => item.pattern === "supervisor" && item.verified) || items.some((item) => item.pattern === "auto-team" && item.verified));
  const multi = auto.filter((report) => report.metrics.multiWorker);
  const denominator = multi.reduce((sum, report) => sum + report.metrics.invocations, 0);
  const overhead = denominator ? multi.reduce((sum, report) => sum + report.metrics.coordinatorInvocations, 0) / denominator : null;
  const workerTurns = auto.reduce((sum, report) => sum + report.metrics.workerTurns, 0);
  const peerYields = auto.reduce((sum, report) => sum + (report.metrics.peerYieldRate ?? 0) * report.metrics.workerTurns, 0);
  const blockers: string[] = [];
  if (auto.length < 20) blockers.push(`Need 20 real Auto runs; recorded ${auto.length}.`);
  if (workerTurns < 100) blockers.push(`Need 100 real worker turns; recorded ${workerTurns}.`);
  if (matched.length < 20) blockers.push(`Need 20 matched Auto/Supervisor comparisons; recorded ${matched.length}.`);
  if (!pairedQuality) blockers.push("Auto verification regressed against a matched Supervisor result.");
  if (auto.some((report) => !report.verified)) blockers.push("Some real Auto results are incomplete or unverified.");
  if (overhead === null || overhead > .25) blockers.push(overhead === null ? "No multi-worker coordinator overhead sample." : "Observed multi-worker coordinator calls exceed 25% of invocations.");
  if (real.some((report) => !Object.keys(report.cliVersions).length)) blockers.push("Some real results have no recorded CLI versions.");
  return { realRuns: real.length, realAutoRuns: auto.length, realWorkerTurns: workerTurns, matchedPairs: matched.length, verifiedAutoRuns: auto.filter((report) => report.verified).length, overheadFraction: overhead, peerYieldRate: workerTurns ? peerYields / workerTurns : null, eligibleBeta: verifiedMatch && pairedQuality && real.every((report) => Object.keys(report.cliVersions).length > 0), eligibleDefault: blockers.length === 0, blockers };
}

/** Local immutable reports and an explicit, audited rollout decision. No model output can change it. */
export class TeamEvaluationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory = join(CODEFLOW_HOME, "team-evaluations")) {}
  private async write(file: string, value: unknown) {
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `.${file}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(this.directory, file));
      if (process.platform !== "win32") { const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await rm(temporary, { force: true }); }
  }
  async list(): Promise<TeamEvaluation[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const reports = await Promise.all(names.filter((name) => /^evaluation-[\w-]+\.json$/.test(name)).map(async (name) => {
      const value = JSON.parse(await readFile(join(this.directory, name), "utf8")) as TeamEvaluation;
      if (value.version !== 1 || value.id + ".json" !== name) throw new Error(`Unsupported or damaged evaluation ${name}`);
      return value;
    }));
    return reports.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }
  async record(report: TeamEvaluation): Promise<TeamEvaluation> {
    if (report.version !== 1 || !/^evaluation-[\w-]+$/.test(report.id) || !["fake", "real", "unknown"].includes(report.mode)) throw new Error("Invalid evaluation report");
    const operation = this.queue.then(async () => {
      const previous = await readFile(join(this.directory, `${report.id}.json`), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (previous) { if (JSON.stringify(JSON.parse(previous)) !== JSON.stringify(report)) throw new Error("An evaluation is immutable; use a new run for another trial"); return report; }
      await this.write(`${report.id}.json`, report); return report;
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
  async rollout(enabled = true): Promise<TeamRollout> {
    const decision = await readFile(join(this.directory, "rollout.json"), "utf8").then((text) => JSON.parse(text) as RolloutDecision, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (decision && (!["experimental", "beta", "default"].includes(decision.stage) || !Array.isArray(decision.evaluationIds))) throw new Error("Damaged team rollout decision");
    return { enabled, stage: decision?.stage ?? "experimental", reason: enabled ? decision?.rationale ?? "Opt-in experiment; no promotion decision has been recorded." : "New Auto teams are disabled. Existing teams can still be viewed and resumed.", decision };
  }
  async decide(input: { stage: RolloutStage; rationale: string; evaluationIds: string[] }): Promise<TeamRollout> {
    if (!["experimental", "beta", "default"].includes(input.stage) || typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > 4000 || !Array.isArray(input.evaluationIds)) throw new Error("Choose a stage, evaluation reports and a written rationale");
    const operation = this.queue.then(async () => {
      const all = await this.list(); const ids = [...new Set(input.evaluationIds)];
      if (ids.some((id) => !all.some((report) => report.id === id))) throw new Error("Unknown evaluation report");
      const selected = all.filter((report) => ids.includes(report.id));
      // Promotion is judged on every real report, not on the ones a caller chose to cite.
      const assessment = assessTeamRollout(all);
      if (input.stage === "beta" && !assessment.eligibleBeta) throw new Error("Beta needs a verified real Auto result and a matched Supervisor comparison with CLI versions and no verification regression");
      if (input.stage === "default" && !assessment.eligibleDefault) throw new Error(`Default rollout is not supported: ${assessment.blockers.join(" ")}`);
      // The evidence permits it; the decision must still say which reports it rests on.
      if (input.stage !== "experimental" && !selected.length) throw new Error("Cite the evaluation reports the decision rests on");
      const decision: RolloutDecision = { at: Date.now(), stage: input.stage, rationale: input.rationale.trim(), evaluationIds: ids };
      await this.write(`decision-${decision.at}-${randomBytes(4).toString("hex")}.json`, decision);
      await this.write("rollout.json", decision); return this.rollout();
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
}

export const teamEvaluationStore = new TeamEvaluationStore();
