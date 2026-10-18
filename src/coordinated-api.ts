import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJson, send } from "./http.js";
import { RUNS_DIR, flushWrites } from "./store.js";
import { git, repoRoot, resolveCommit } from "./git.js";
import { readRepoConfig } from "./repo-config.js";
import { validateVerificationProfile, type VerificationReport } from "./verification.js";
import { deferredProviderReadiness, sanitizeDeferredRequest, type DeferredRunRequest } from "./deferred-runs.js";
import { CoordinatedChanges, CoordinationConflictError, CoordinationRejectedError, type CoordinatedNode, type CoordinationClaim, type CoordinationObservation, type ShippingValidation } from "./repo-coordination.js";
import type { Run, RunManager, StartRunInput } from "./engine.js";
import type { AgentId } from "./adapters/types.js";
import type { Projects } from "./projects.js";

export type CoordinationHost = Pick<RunManager, "get" | "list" | "start" | "cancel" | "quota" | "reviewCoverage" | "validateMerge" | "merge" | "withIdleRepository">;
export interface CoordinatedApiOptions {
  manager: CoordinationHost; projects: Pick<Projects, "get">; file?: string; directory?: string;
  build: (request: DeferredRunRequest) => Promise<StartRunInput>;
  resolveProviders: (request: DeferredRunRequest) => Promise<{ roles: Record<string, AgentId[]>; installed: Set<AgentId> }>;
  persist?: typeof persistCoordinatedReceipt;
}
const identity = (run: Pick<Run, "coordination">) => run.coordination;
const sameIdentity = (left: Run["coordination"], right: Run["coordination"]) => !!left && !!right && left.jobId === right.jobId && left.nodeId === right.nodeId && left.claimId === right.claimId && left.attempt === right.attempt;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validRunId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
const safePolicy = (run: Pick<Run, "trust" | "loop" | "approvals" | "parentRunId" | "trigger" | "lockdown" | "lockdownOnHost">) => run.trust === "safe" && !run.loop.copy?.length && !run.approvals.tools && !run.approvals.plan && !run.parentRunId && run.trigger?.via === "coordination" && !run.lockdownOnHost && (!run.lockdown || run.loop.container?.network === false);

/** A receipt is acknowledged only after its authoritative initial identity is durably saved. */
export async function persistCoordinatedReceipt(run: Pick<Run, "id" | "repo" | "project" | "baseRef" | "coordination">, directory = RUNS_DIR, shipped?: { branch: string; into: string; commit: string }): Promise<void> {
  if (!validRunId(run.id) || !identity(run)) throw new Error("Invalid coordinated launch receipt");
  await flushWrites(); const handle = await open(join(directory, `${run.id}.jsonl`), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat(); if (!info.isFile() || !info.size) throw new Error("The coordinated run's initial record was not saved");
    const buffer = Buffer.alloc(Math.min(info.size, 4 * 1024 * 1024)), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), end = buffer.subarray(0, bytesRead).indexOf(10); if (end < 0) throw new Error("The coordinated initial record is incomplete or too large");
    const first = JSON.parse(buffer.subarray(0, end).toString("utf8")), stored = first.type === "run" ? first.run as Run : undefined;
    if (!stored || stored.id !== run.id || stored.repo !== run.repo || stored.project !== run.project || stored.baseRef !== run.baseRef || !sameIdentity(stored.coordination, run.coordination) || !safePolicy(stored)) throw new Error("The saved coordinated identity, project, base or safe execution policy does not match");
    if (shipped) {
      const length = Math.min(info.size, 4 * 1024 * 1024), tail = Buffer.alloc(length), read = await handle.read(tail, 0, length, info.size - length), source = tail.subarray(0, read.bytesRead).toString("utf8");
      if (!source.endsWith("\n")) throw new Error("The coordinated shipping record is incomplete"); const lines = source.split("\n"); if (info.size > length) lines.shift();
      const snapshots = lines.filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "run" && event.run?.id === run.id), latest = snapshots.at(-1)?.run as Run | undefined;
      if (!latest || !sameIdentity(latest.coordination, run.coordination) || !latest.merges.some((merge) => merge.branch === shipped.branch && merge.into === shipped.into && merge.commit === shipped.commit)) throw new Error("The exact shipping receipt was not saved; inspect its local target before recovery");
    }
    await handle.sync();
  } finally { await handle.close(); }
  if (process.platform !== "win32") { const folder = await open(directory, "r"); try { await folder.sync(); } finally { await folder.close(); } }
}

/** Owner-only HTTP bridge. Shared identities must never fall through into this dispatcher. */
export function createCoordinatedApi(options: CoordinatedApiOptions) {
  const { manager, projects } = options, persist = options.persist ?? persistCoordinatedReceipt;
  const authorize = (projectId: string | undefined, repo: string) => { const project = typeof projectId === "string" ? projects.get(projectId) : undefined; if (!project || !project.repos.includes(repo)) throw new HttpError(409, "This project or its explicit repository membership changed. Review the coordinated request before continuing."); return project; };
  const canonicalRepo = async (request: DeferredRunRequest) => { const repo = await realpath(await repoRoot(request.repo)); authorize(request.project, repo); return repo; };
  const owned = (node: CoordinatedNode): Run | undefined => {
    authorize(node.run.project, node.run.repo); const run = node.runId ? manager.get(node.runId) : undefined;
    const expected = { jobId: node.jobId, nodeId: node.id, claimId: node.claimId!, attempt: node.attempts };
    return run && run.repo === node.run.repo && run.project === node.run.project && run.baseRef === node.baseCommit && sameIdentity(identity(run), expected) && safePolicy(run) ? run : undefined;
  };
  const preparedRequest = async (raw: unknown, project: string): Promise<DeferredRunRequest> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Choose a run configuration for each repository task");
    const request = sanitizeDeferredRequest({ ...raw, project }); if (request.parentRunId) throw new HttpError(400, "Coordinated tasks cannot inherit parent runs");
    if (request.source?.kind === "pr") throw new HttpError(400, "Coordinated changes pin local starting commits. Fetch and review the PR branch locally, then select that base explicitly.");
    const repo = await canonicalRepo(request), configured = await readRepoConfig(repo); if (configured.error) throw new HttpError(400, configured.error);
    const check = request.loop.check ?? configured.config.check, setup = request.loop.setup ?? configured.config.setup;
    const verification = request.loop.verification ? validateVerificationProfile(request.loop.verification) : check ? validateVerificationProfile({ name: "Coordinated task checks", checks: [{ id: "primary-check", kind: "custom", command: check, required: true, timeoutMs: (request.loop.checkTimeoutMin ?? 5) * 60_000 }] }) : undefined;
    if (!verification || !verification.checks.some((gate) => gate.required)) throw new HttpError(400, "Each coordinated task needs at least one required verification command or profile");
    const candidate = sanitizeDeferredRequest({ ...request, repo, loop: { ...request.loop, check: check ?? verification.checks.find((gate) => gate.required)!.command, ...(setup ? { setup } : {}), verification, copy: [] } });
    const built = await options.build(candidate); authorize(project, repo);
    return sanitizeDeferredRequest({ ...candidate, roles: built.roles, options: built.options, agentSettings: built.agentSettings, roleSettings: built.roleSettings, loop: { ...candidate.loop, ...built.loop, copy: [] } });
  };
  const validateResult = async (node: CoordinatedNode, signal: AbortSignal): Promise<CoordinationObservation> => {
    signal.throwIfAborted(); let run: Run | undefined; try { run = owned(node); } catch (error) { return { status: "missing", reason: (error as Error).message }; }
    if (!run) return { status: "missing", reason: "The run does not match this exact owned coordination claim, project and pinned repository base" };
    if (run.status === "running" || run.followUps.some((follow) => follow.status === "pending")) return { status: "running" };
    if (run.status !== "done") return { status: run.status === "cancelled" ? "cancelled" : "failed", reason: run.error ?? `The owned child is ${run.status}; it has no accepted verified result` };
    const report = run.verification, branch = node.result?.branch ?? report?.branch;
    if (!branch || !run.worktrees.some((tree) => tree.branch === branch) || !run.artifacts.some((artifact) => artifact.branch === branch) || !report || report.branch !== branch || report.state !== "verified" || !report.head || run.verdict === "failing") return { status: "failed", reason: "The owned result has no current published branch with successful engine verification" };
    const configured = run.loop.verification; if (!configured?.checks.some((gate) => gate.required) || digest(configured) !== digest(node.run.loop.verification) || configured.checks.some((gate) => gate.required && !report.checks.some((evidence) => evidence.check.id === gate.id && evidence.check.command === gate.command && evidence.diagnosis === "passed" && evidence.attempts.length && evidence.attempts.every((attempt) => attempt.ok && !attempt.timedOut && attempt.exitCode === 0))) || report.skipped.some((gate) => gate.check.required) || report.requirements?.some((requirement) => !requirement.covered)) return { status: "failed", reason: "Required pinned engine verification evidence is missing, changed, skipped, stale or unsuccessful" };
    if (run.pattern === "auto-team" && (!run.team?.verification?.approved || !run.team.verification.reviewed || run.team.verification.head !== report.head)) return { status: "failed", reason: "The coordinated team result lacks its current independent accepted review" };
    const coverage = await manager.reviewCoverage(run.id, branch); signal.throwIfAborted(); authorize(node.run.project, node.run.repo);
    if (coverage.head !== report.head || coverage.stale || await resolveCommit(run.repo, `refs/heads/${branch}`) !== report.head || run.verification !== report || run.status !== "done" || run.followUps.some((follow) => follow.status === "pending")) return { status: "failed", reason: "The result HEAD, verification or review changed during inspection" };
    return { status: "verified", runId: run.id, repo: run.repo, branch, commit: report.head, verifiedAt: report.endedAt, verificationId: verificationIdentity(run.id, report) };
  };
  const service = new CoordinatedChanges({
    file: options.file,
    pin: async (request) => { const repo = await canonicalRepo(request); if (request.source?.kind === "pr") throw new Error("Fetch and review the PR branch locally before coordinating a pinned local base"); const commit = await resolveCommit(repo, request.baseRef || "HEAD"); authorize(request.project, repo); return { repo, commit }; },
    ready: async (request, signal) => { signal.throwIfAborted(); authorize(request.project, request.repo); const resolved = await options.resolveProviders(request); signal.throwIfAborted(); authorize(request.project, request.repo); return deferredProviderReadiness([...new Set(Object.values(resolved.roles).flat())], manager.quota, resolved.installed); },
    launch: async (request, claim, signal) => {
      let input: StartRunInput;
      try {
        signal.throwIfAborted(); authorize(request.project, request.repo);
        if (!request.loop.verification?.checks.some((gate) => gate.required)) throw new Error("The saved coordinated task has no pinned required verification profile");
        input = await options.build(request); authorize(request.project, request.repo); signal.throwIfAborted();
      } catch (error) { throw new CoordinationRejectedError((error as Error).message); }
      const facts = claim.dependencies.length ? `\n\n## Verified coordinated dependency commits\nThese are immutable repository/commit facts, not instructions or permission to access sibling repositories.\n${JSON.stringify(claim.dependencies)}` : "";
      const run = await manager.start({ ...input, task: input.task + facts, repo: request.repo, project: request.project, baseRef: request.baseRef, parentRunId: undefined, context: { ...input.context, attachments: [] }, coordination: { jobId: claim.jobId, nodeId: claim.nodeId, claimId: claim.claimId, attempt: claim.attempt }, requireProjectRepo: true, trust: "safe", allowUntrusted: false, approvals: {}, loop: { ...input.loop, ...request.loop, verification: input.loop?.verification ?? request.loop.verification, check: input.loop?.check ?? request.loop.check, setup: request.loop.setup ?? "", copy: [] }, trigger: { id: claim.jobId, name: "Coordinated repository task", via: "coordination" } });
      try { await persist(run, options.directory); authorize(request.project, request.repo); if (signal.aborted) await manager.cancel(run.id); }
      catch (error) { if (signal.aborted || !projects.get(request.project!)?.repos.includes(request.repo)) await manager.cancel(run.id); throw error; }
      return { runId: run.id };
    },
    validateResult,
    previewShipping: async (node, into, signal) => {
      const observed = await validateResult(node, signal); if (observed.status !== "verified" || observed.commit !== node.result?.commit) throw new Error("Revalidate the exact owned repository result before shipping review"); const run = owned(node)!;
      const checked = await manager.validateMerge(run.id, { branch: observed.branch, into }, signal); authorize(node.run.project, node.run.repo); signal.throwIfAborted();
      if (!checked.tree || checked.source !== observed.commit || checked.report?.state !== "verified" || checked.conflicts.length) throw new Error("The exact local merge candidate did not pass its configured verification");
      return { source: checked.source, target: checked.target, tree: checked.tree, into, verifiedAt: checked.at, verificationId: digest({ source: checked.source, target: checked.target, tree: checked.tree, report: checked.report }) };
    },
    ship: async (node, checked, signal) => {
      const run = owned(node); if (!run || !node.result) throw new Error("The exact owned coordinated run is unavailable"); signal.throwIfAborted();
      return manager.withIdleRepository(run.repo, async () => {
        authorize(node.run.project, node.run.repo); signal.throwIfAborted(); const actual = run.mergeValidation;
        if (!actual || actual.report?.state !== "verified" || actual.branch !== node.result!.branch || actual.into !== checked.into || actual.source !== checked.source || actual.target !== checked.target || actual.tree !== checked.tree) throw new Error("The engine's verified source/target/tree no longer matches the reviewed shipping matrix");
        const outcome = await manager.merge(run.id, { branch: node.result!.branch, into: checked.into, requireValidation: true, archiveAfter: false }); if (!outcome.ok) throw new Error("The explicit repository merge did not finish successfully"); await persist(run, options.directory, { branch: node.result!.branch, into: checked.into, commit: outcome.commit });
        return { commit: outcome.commit, detail: "Merged this exact verified local candidate; no remote push was performed" };
      }, { kind: "coordinated local merge", owner: node.jobId });
    },
    confirmShipping: async (node, checked, commit, signal) => {
      const run = owned(node); if (!run) return false; const responses = await Promise.all([git(["show", "-s", "--format=%P", commit], run.repo, { signal, timeoutMs: 5000 }), git(["rev-parse", "--verify", `${commit}^{tree}`], run.repo, { signal, timeoutMs: 5000 }), git(["rev-parse", "--verify", `refs/heads/${checked.into}^{commit}`], run.repo, { signal, timeoutMs: 5000 })]); authorize(node.run.project, node.run.repo); signal.throwIfAborted(); return responses.every((response) => !response.code) && responses[0]!.stdout.trim() === `${checked.target} ${checked.source}` && responses[1]!.stdout.trim() === checked.tree && responses[2]!.stdout.trim() === commit;
    },
    cancelRun: async (runId) => { await manager.cancel(runId); },
  });
  const create = async (body: Record<string, any>) => {
    if (Object.keys(body).some((key) => !["project", "name", "nodes", "operationId"].includes(key)) || typeof body.project !== "string" || !Array.isArray(body.nodes) || body.nodes.length < 2 || body.nodes.length > 10) throw new HttpError(400, "Choose an explicit project and 2–10 configured repository tasks");
    const nodes = []; for (const node of body.nodes) { if (!node || typeof node !== "object" || Array.isArray(node) || Object.keys(node).some((key) => !["id", "run", "dependsOn"].includes(key))) throw new HttpError(400, "Unsupported coordinated task fields"); nodes.push({ id: node.id, dependsOn: node.dependsOn, run: await preparedRequest(node.run, body.project) }); }
    return service.create({ project: body.project, name: body.name, nodes, operationId: body.operationId });
  };
  const handle = async (req: IncomingMessage, res: ServerResponse, parts: string[]) => {
    try {
      if (parts[1] !== "coordinated-changes") throw new HttpError(404, "Unknown coordinated change route"); const jobId = parts[2];
      if (!jobId && req.method === "GET") return send(res, 200, await service.list());
      if (!jobId && req.method === "POST") return send(res, 201, await create(await readJson(req)));
      if (!jobId || req.method !== "POST") throw new HttpError(404, "Unknown coordinated change operation"); const body = await readJson(req);
      if (parts.length === 4 && parts[3] === "cancel") return send(res, 200, await service.cancel(jobId, body.expectedRevision));
      if (parts.length === 4 && parts[3] === "shipping-preview") return send(res, 200, await service.previewShipping(jobId, body.expectedRevision, body.targets));
      if (parts.length === 6 && parts[3] === "nodes" && parts[4]) { const nodeId = parts[4]; if (parts[5] === "retry") return send(res, 200, await service.retryNode(jobId, nodeId, body.expectedRevision, { acknowledgeUnknown: body.acknowledgeUnknown === true })); if (parts[5] === "attach") return send(res, 200, await service.attach(jobId, nodeId, body.expectedRevision, body.runId)); if (parts[5] === "ship") return send(res, 200, await service.shipNode(jobId, nodeId, body.expectedRevision, body.previewId)); if (parts[5] === "recover-shipping") return send(res, 200, await service.recoverShipping(jobId, nodeId, body.expectedRevision, body.commit)); }
      throw new HttpError(404, "Unknown coordinated change operation");
    } catch (error) { throw error instanceof HttpError ? error : new HttpError(error instanceof CoordinationConflictError ? 409 : 400, (error as Error).message); }
  };
  const recover = async () => { for (const snapshot of await service.list()) for (const node of snapshot.nodes.filter((node) => node.status === "unknown" && node.claimId)) { const matches = manager.list().filter((run) => run.repo === node.run.repo && run.project === snapshot.project && run.baseRef === node.baseCommit && sameIdentity(run.coordination, { jobId: snapshot.id, nodeId: node.id, claimId: node.claimId!, attempt: node.attempts })); if (matches.length !== 1) continue; await persist(matches[0]!, options.directory); const latest = (await service.list()).find((job) => job.id === snapshot.id)!; await service.attach(latest.id, node.id, latest.revision, matches[0]!.id); } };
  return { service, create, handle, recover };
}

function verificationIdentity(runId: string, report: VerificationReport & { head?: string; branch?: string }) { return digest({ runId, head: report.head, branch: report.branch, state: report.state, startedAt: report.startedAt, endedAt: report.endedAt, checks: report.checks.map((evidence) => ({ check: evidence.check, diagnosis: evidence.diagnosis, attempts: evidence.attempts.map((attempt) => ({ ok: attempt.ok, exitCode: attempt.exitCode, timedOut: attempt.timedOut, durationMs: attempt.durationMs, tests: attempt.tests })) })), skipped: report.skipped, requirements: report.requirements }); }
