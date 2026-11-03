import { runEvidence } from "./evidence.js";
import { captureAgentSource } from "../conversational/agent-source.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, mkdir, open, chmod, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Run, RunManager, TeamContext } from "../engine.js";
import { DEFAULT_LOOP } from "../run-projection.js";
import { CODEFLOW_HOME, STEP_TIMEOUT_MS } from "../config.js";
import { getAdapter } from "../adapters/index.js";
import { repoRoot, assertWorktree } from "../git.js";
import { flushWrites, journalEntry, loadJournal, RUNS_DIR } from "../store.js";
import { cliTeamPattern } from "./pattern.js";
import { catalog, resolveParticipant } from "./providers.js";
import { captureSource, type SourceSnapshot } from "./snapshots.js";
import { canonical, digest, fail, validateCandidate, validateWebCandidate, validatePreferences, type Definition, type PendingAssignment, type Preferences } from "./model.js";
import { validateTool } from "./tools.js";
import { registerHostHandlers } from "./host.js";
import { recoverCliAccounting } from "./accounting.js";

export interface Proposal { origin?: "cli"; chatId?: string; project?: string; taskId?: string; id: string; repo: string; revision: number; hash: string; task: string; context: { chatId?: string; projectId?: string; sourceRunId?: string; attachments?: { name: string; data: string }[]; notes?: string; continueRunId?: string; untracked?: string[]; artifacts?: { runId: string; artifactId: string; sha256: string }[] }; definition: Definition; source: SourceSnapshot; accepted?: { hash: string; at: number }; runId?: string; hostConnection: string }
export interface ConversationScope { chatId?: string; repo: string; project?: string; taskId?: string; surface?: "web"; id?: string }
export interface Connection extends ConversationScope { id: string; expiresAt: number; active: boolean; kind: "mcp" | "terminal" }
const META = "cli-teams-control";
const id = () => randomBytes(16).toString("hex");
export const tokenMatches = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
async function preferences(path: string, projectRoot?: string): Promise<Preferences> {
  try {
    if (projectRoot && ((await lstat(join(projectRoot, ".codeflow"))).isSymbolicLink() || (await lstat(path)).isSymbolicLink())) fail("validation_failed", "Project preference files must stay inside the repository; replace the symlink before use");
    if ((await stat(path)).size > 16384) fail("validation_failed", "Preferences exceed 16 KiB");
    const text = await readFile(path, "utf8"); if (Buffer.byteLength(text) > 16384) fail("validation_failed", "Preferences exceed 16 KiB");
    const parsed = JSON.parse(text);
    if (parsed?.schemaVersion !== undefined && parsed.schemaVersion !== 1) fail("validation_failed", "Unsupported CLI preference schema version");
    return validatePreferences(parsed.preferences ?? parsed);
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
}
export class CliTeamsService {
  workspace?: {
    resolve: (repo: string, context: Proposal["context"], proposalId: string) => Promise<{ project: string; taskId: string; chatId: string }>;
    sync: (proposal: Proposal, event?: { id: string; body: string; runId?: string; noteId?: string }) => Promise<void>;
    describe: (proposal: Proposal) => Promise<unknown>;
    open: (path: string) => Promise<boolean>;
    url: (path: string) => string;
  };
  workspaceProposals() { return [...this.journal.entries()].filter(([k]) => k.startsWith("proposal:")).map(([, p]) => structuredClone(p as Proposal)); }
  private readonly syncedWorkspaceEvents = new Set<string>();
  private async syncWorkspace(p: Proposal) {
    await this.workspace?.sync(p);
    // Receipts and their visible events commit together. Replaying is safe after a crash.
    for (const [key, raw] of this.journal) {
      const receipt = raw as { workspaceEvent?: { proposalId: string; id: string; body: string; runId?: string; noteId?: string } };
      if (key.startsWith("receipt:") && receipt.workspaceEvent?.proposalId === p.id && !this.syncedWorkspaceEvents.has(key)) {
        await this.workspace?.sync(p, receipt.workspaceEvent); this.syncedWorkspaceEvents.add(key);
      }
    }
  }
  async reconcileWorkspace() {
    for (const p of this.workspaceProposals()) if (p.origin === "cli" && p.chatId && this.manager.projects?.get(p.project!)?.repos.includes(p.repo)) {
      try { await this.manager.assertExecutionAllowed(p.repo, undefined, "Restore CLI workspace"); }
      catch { continue; } // A restricted project must not disable unrelated chats.
      await this.syncWorkspace(p);
    }
  }
  hostState(run: Run) {
    if (!run.cliTeam) return undefined;
    const state = run.cliTeam, connection = this.connections.get(state.hostConnection);
    return { waiting: run.status === "running" && Object.values(state.pending).some(p => !p.output), connected: !!connection?.active && connection.expiresAt > Date.now() };
  }
  private workspaceProposal(c: ConversationScope, reference: string) {
    if (this.journal.has(`proposal:${reference}`)) return this.proposal(c, reference);
    const run = this.run(c, reference); return this.proposal(c, run.cliTeam!.proposalId);
  }
  private journal = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Map<string, Set<() => void>>();
  readonly connections = new Map<string, Connection>();
  constructor(readonly manager: RunManager, readonly home = CODEFLOW_HOME) {
    registerHostHandlers((ctx, request) => this.host(ctx, request), (ctx, key, question, options, inputs) => this.question(ctx, key, question, options, inputs));
  }
  async load() {
    await mkdir(RUNS_DIR, { recursive: true });
    const file = join(RUNS_DIR, `${META}.journal.jsonl`), handle = await open(file, "a", 0o600); await handle.close(); await chmod(file, 0o600);
    this.journal = await loadJournal(META, { strict: true });
    for (const summary of this.manager.list()) {
      if (!summary.cliTeam) continue;
      const run = this.manager.get(summary.id)!;
      const journal = await loadJournal(run.id, { strict: true }), state = run.cliTeam!;
      recoverCliAccounting(run, journal);
      for (const [key, value] of journal) if (key.startsWith("cli-artifact:")) {
        const a = value as import("./model.js").Artifact;
        if (a.sha256 !== digest({ kind: a.kind, body: a.body, data: a.data, ...(a.participant ? { participant: a.participant } : {}) })) fail("storage_unavailable", "A CLI artifact failed its integrity check");
        state.artifacts[a.id] = a;
      }
    }
  }
  private async save(key: string, value: unknown) { await journalEntry(META, key, value); this.journal.set(key, structuredClone(value)); }
  private async serialized<T>(work: () => Promise<T>): Promise<T> { const task = this.tail.then(work); this.tail = task.catch(() => undefined); return task; }
  private notify(key: string) { for (const finish of this.waiters.get(key) ?? []) finish(); }
  private wait(ctx: TeamContext, key: string) {
    return new Promise<void>(resolve => {
      const set = this.waiters.get(key) ?? new Set<() => void>(); this.waiters.set(key, set);
      const finish = () => { set.delete(finish); if (!set.size) this.waiters.delete(key); ctx.signal.removeEventListener("abort", finish); resolve(); };
      set.add(finish); ctx.signal.addEventListener("abort", finish, { once: true }); if (ctx.signal.aborted) finish();
    });
  }
  async connect(path: string, kind: Connection["kind"] = "mcp"): Promise<Connection> {
    const repo = await realpath(await repoRoot(path));
    await this.manager.assertExecutionAllowed(repo, undefined, "CLI project connection");
    for (const [key, old] of this.connections) if (!old.active || old.expiresAt < Date.now()) this.connections.delete(key);
    const c = { id: id(), repo, kind, expiresAt: Date.now() + 60_000, active: true }; this.connections.set(c.id, c); return c;
  }
  disconnect(connection: Connection) { connection.active = false; }
  heartbeat(connection: Connection) { this.validateConnection(connection); connection.expiresAt = Date.now() + 60_000; }
  private validateConnection(c: Connection) { if (!this.connections.has(c.id) || !c.active || c.expiresAt < Date.now()) fail("scope_denied", "Connection expired; reconnect the Code Flow MCP server"); }
  private proposal(c: ConversationScope, proposalId: string): Proposal {
    const p = this.journal.get(`proposal:${proposalId}`) as Proposal | undefined;
    if (!p || p.repo !== c.repo || c.surface === "web" && p.project !== c.project || c.taskId && p.taskId !== c.taskId) fail("scope_denied", "Proposal is unavailable in this project"); return structuredClone(p);
  }
  private run(c: ConversationScope, runId: string): Run {
    const r = this.manager.get(runId); if (!r?.cliTeam || r.repo !== c.repo || c.surface === "web" && (r.project !== c.project || (r.cliTeam.taskConversation?.id !== c.taskId && !(c.chatId && r.cliTeam.taskConversation?.chatId === c.chatId)))) fail("scope_denied", "Run is unavailable in this project"); return r;
  }
  private async source(c: ConversationScope, source: SourceSnapshot["source"], context: Proposal["context"]): Promise<SourceSnapshot> {
    if (context.sourceRunId && !context.continueRunId) return captureAgentSource(this.manager, c, context.sourceRunId);
    if (!context.continueRunId) return captureSource(c.repo, source, context.untracked);
    const prior = this.run(c, context.continueRunId);
    await this.manager.assertExecutionAllowed(c.repo, prior, "CLI continuation snapshot");
    if (prior.status === "running" && (!prior.pauseRequested || prior.steps.some(s => s.status === "running"))) fail("recovery_required", "Pause the previous run and wait for active turns to settle before capturing a continuation");
    const wt = prior.worktrees.find(w => w.name === "team");
    if (!wt) fail("recovery_required", "No preserved team worktree is available for continuation");
    const captured = await captureSource(await assertWorktree(c.repo, { path: wt.path }), "working_changes", context.untracked);
    return { ...captured, base: prior.cliTeam!.source.base };
  }
  preview(p: Proposal, compact = false) {
    const labels = new Map<string, string>();
    let hasWriter = false;
    const collect = (steps: Definition["steps"]) => { for (const n of steps) { if (n.type === "task" && ["implement", "repair"].includes(n.operation)) hasWriter = true; labels.set(n.id, n.type === "task" ? n.instructions.slice(0, 100) : n.type === "gate" ? "Required review decision" : n.type === "finish" ? "Final result" : n.type === "user_decision" ? n.question : n.type === "loop" ? "Revision cycle" : "Combined outputs"); if (n.type === "loop") collect(n.steps); if (n.type === "parallel") collect(n.tasks); } }; collect(p.definition.steps);
    const operations = { propose: "Draft a plan", revise_proposal: "Revise the plan", synthesize: "Combine proposals", review_plan: "Review the plan", implement: "Implement", repair: "Address findings", review_code: "Review changes", verify: "Run the check", capture_snapshot: "Capture the source" };
    const describe = (steps: Definition["steps"], prefix = ""): string[] => steps.flatMap((n, index) => {
      const number = `${prefix}${index + 1}`;
      if (n.type === "task") return [`${number}. ${operations[n.operation]} — ${n.participant ?? "Code Flow"}\n${compact ? n.instructions.slice(0, 100) : n.instructions}${n.inputs?.length ? `\nUses: ${n.inputs.map(id => labels.get(id)).join("; ")}` : ""}`];
      if (n.type === "loop") return [`${number}. Repeat until required reviews pass, at most ${n.maxIterations} passes. A rejected review skips the rest of that pass.`, ...describe(n.steps, `${number}.`)];
      if (n.type === "parallel") return [`${number}. Work in parallel, then wait for all results.`, ...describe(n.tasks, `${number}.`)];
      if (n.type === "gate") return [n.reviews.length ? `${number}. Require ${n.reviews.length} distinct participant review(s) on the same version of “${labels.get(n.target)}”${n.policy === "verified" ? ", with a passing check on the same code" : ""}.` : `${number}. Require a passing check on this exact code. No independent review is included.`];
      if (n.type === "user_decision") return [`${number}. Ask you: ${n.question}\nOptions: ${n.options.join("; ")}${n.continueOn ? `\nContinue only when you choose: ${n.continueOn}. Other answers stop for revision.` : ""}`];
      if (n.type === "join") return [`${number}. Combine: ${n.inputs.map(id => labels.get(id)).join("; ")}`];
      return [`${number}. Return ${n.outcome.replaceAll("_", " ")}. Include: ${n.inputs.map(id => labels.get(id)).join("; ")}`];
    });
    const preview = [
      `Task: ${compact ? p.task.slice(0, 2000) : p.task}`, `Project: ${p.repo}`, `Scope: ${p.definition.scope}; source: ${p.source.source}; snapshot: ${p.source.commit}`,
      ...(p.definition.scope === "write" && !hasWriter ? ["Verification only: no code editing assignment is included. Setup/check commands run as shown below."] : []),
      ...p.definition.participants.map(a => `${a.id}: ${a.provider}${a.binding === "current_session" ? " (host-reported, unverified)" : ""} / ${a.model ?? "provider default (unverified)"} / ${a.effort ?? "default (unverified)"} / ${a.binding ?? "managed"}; model from ${a.provenance.model}, effort from ${a.provenance.effort}`),
      `Setup: ${p.definition.setup || "none"}; check: ${p.definition.check || "none"}`,
      `Limits: ${p.definition.limits.maxInvocations} lifetime managed calls; ${p.definition.limits.maxMinutes} execution minutes; ${p.definition.limits.concurrency} concurrent workers; ${p.definition.limits.maxAttempts} managed attempts per assignment, including transport/schema repair; ${p.definition.limits.attemptTimeoutMs / 60000} minutes per attempt. Host usage unobserved; waiting time excluded.`,
      `Permissions: Standard managed tools, native delegation disabled; current-session assignments remain read-only cooperative work. Existing provider/file access boundaries apply. No merge/push/deploy.`,
      `Completion: ${p.definition.completion.map(s => compact ? s.slice(0, 300) : s).join("; ")}`, `Work sequence:\n${describe(p.definition.steps).join("\n\n")}`,
      ...(compact ? ["This is a compact preview. The interactive confirmation shows the full request, instructions, inputs, and configuration."] : [`Context notes: ${p.context.notes ?? "none"}\nSelected untracked files: ${p.context.untracked?.join(", ") || "none"}\nContinuation of: ${p.context.continueRunId ?? p.context.sourceRunId ?? "none"}\nAttached files: ${p.context.attachments?.map(file => `${file.name} (${Buffer.byteLength(file.data, "base64")} bytes)`).join("; ") || "none"}\nReferenced artifacts: ${p.context.artifacts?.map(a => `${a.artifactId} (${a.sha256}) from ${a.runId}`).join("; ") || "none"}`]),
      `Proposal ${p.id} revision ${p.revision}; hash ${p.hash}`,
      `Approve this exact revision in the connected host when supported. Terminal fallback: codeflow approve ${p.id} --revision ${p.revision}`,
    ].join("\n\n");
    return compact && Buffer.byteLength(preview) > 24000 ? preview.slice(0, 7500) + "\n\n[Compact preview abbreviated. Read the complete configuration in interactive confirmation.]" : preview;
  }
  async acceptancePreview(c: Connection, proposalId: string, revision: number) {
    const p = this.proposal(c, proposalId);
    if (p.revision !== revision || p.runId) fail("revision_conflict", "Proposal changed or already started; retrieve the current proposal");
    return { preview: this.preview(p), hash: p.hash };
  }
  /** Called only by the local interactive terminal path, never exposed as an MCP tool. */
  async accept(c: Connection, proposalId: string, revision: number, hash: string) {
    return this.serialized(async () => {
      const p = this.proposal(c, proposalId);
      if (p.revision !== revision || p.hash !== hash) fail("acceptance_stale", "The displayed proposal changed; review it again");
      if (p.runId) return { proposalId, revision, accepted: true };
      p.accepted = { hash, at: Date.now() }; await this.save(`proposal:${p.id}`, p); return { proposalId, revision, accepted: true };
    });
  }
  async attach(c: Connection, runId: string, connectionId: string) {
    return this.serialized(async () => {
      const run = this.run(c, runId), connection = this.connections.get(connectionId);
      if (!connection?.active || connection.expiresAt <= Date.now() || connection.kind !== "mcp" || connection.repo !== c.repo) fail("scope_denied", "Choose a live MCP connection for this project");
      await journalEntry(run.id, "cli-host-connection", connection.id);
      run.cliTeam!.hostConnection = connection.id;
      for (const pending of Object.values(run.cliTeam!.pending)) { delete pending.claimHash; delete pending.connection; delete pending.claimExpiresAt; }
      return { runId, attached: true };
    });
  }
  async call(c: Connection, name: string, args: any): Promise<unknown> {
    this.heartbeat(c);
    if (name === "codeflow_open_task") {
      validateTool(name, args);
      const p = this.workspaceProposal(c, args.id);
      await this.manager.assertExecutionAllowed(c.repo, undefined, "Open Code Flow workspace");
      if (!this.workspace) fail("runtime_unavailable", "The visual workspace is unavailable; restart Code Flow with this version");
      if (p.chatId) await this.syncWorkspace(p);
      const path = p.chatId ? `/?team=local#/chat/${p.chatId}` : p.runId ? `/?team=local#/run/${p.runId}` : undefined;
      if (!path) fail("not_found", "Revise this older proposal to create its visual workspace");
      return { workspace: { url: this.workspace.url(path), chatId: p.chatId, taskId: p.taskId }, conversation: p.chatId ? await this.workspace.describe(p) : undefined, opened: args.open === false ? false : await this.workspace.open(path) };
    }
    const value: any = await this.operate(c, name, args);
    if (!this.workspace || !value || !(value.proposalId || value.runId)) return value;
    const p = this.workspaceProposal(c, value.proposalId ?? value.runId);
    if (!p.chatId) return value;
    await this.syncWorkspace(p);
    return { ...value, workspace: { url: this.workspace.url(`/?team=local#/chat/${p.chatId}`), chatId: p.chatId, taskId: p.taskId, projectId: p.project }, conversation: await this.workspace.describe(p) };
  }
  private async operate(c: ConversationScope, name: string, args: any): Promise<unknown> {
    const spec = validateTool(name, args);
    if (Buffer.byteLength(JSON.stringify(args)) > (name === "codeflow_propose_run" ? 7 * 1024 * 1024 : 64 * 1024)) fail("validation_failed", "Request exceeds this operation’s size limit");
    await this.manager.assertExecutionAllowed(c.repo, undefined, "Conversational operation");
    if (c.surface === "web" && (!c.project || !this.manager.projects?.get(c.project)?.repos.includes(c.repo))) fail("scope_denied", "This repository is no longer an explicit member of the selected project");
    if (spec.annotations.readOnlyHint) return this.read(c, name, args);
    return this.serialized(async () => {
      const key = `receipt:${digest([c.surface === "web" ? [c.project, c.repo, c.taskId] : c.repo, name, ["codeflow_claim_step", "codeflow_submit_step"].includes(name) ? c.id : "project", args.operationId])}`, hash = digest(args);
      const prior = this.journal.get(key) as { hash: string; value: unknown } | undefined;
      if (prior) { if (prior.hash !== hash) fail("idempotency_conflict", "Operation ID was used with different arguments"); return structuredClone(prior.value); }
      const value = await this.mutate(c, name, args);
      // Claim secrets are private control receipts, never copied into run projections.
      const p = c.surface !== "web" && value.accepted !== false && ["codeflow_steer_run", "codeflow_control_run"].includes(name) ? this.workspaceProposal(c, value.proposalId ?? value.runId) : undefined;
      const workspaceEvent = p?.chatId ? { proposalId: p.id, id: `cli-${digest([c.repo, name, args.operationId])}`, body: name === "codeflow_steer_run" ? args.message : `${args.action === "pause" ? "Pause requested" : args.action === "resume" ? "Resume requested" : "Cancel requested"} from CLI.`, runId: args.runId, noteId: value.noteId } : undefined;
      await this.save(key, { hash, value, ...(workspaceEvent ? { workspaceEvent } : {}) }); return value;
    });
  }
  /** Trusted web adapters supply project scope; no CLI connection or bootstrap credential is involved. */
  async operateWeb(scope: ConversationScope, name: string, args: any): Promise<any> {
    if (!["codeflow_propose_run", "codeflow_get_run", "codeflow_get_artifact", "codeflow_control_run", "codeflow_steer_run", "codeflow_list_providers", "codeflow_list_models"].includes(name)) fail("scope_denied", "Unsupported web conversation operation");
    return this.operate({ ...scope, surface: "web", id: undefined }, name, JSON.parse(JSON.stringify(args)));
  }
  getWebProposal(scope: ConversationScope, proposalId: string, revision?: number): Proposal {
    const current = this.proposal({ ...scope, surface: "web" }, proposalId);
    if (revision === undefined || revision === current.revision) return current;
    const previous = this.journal.get(`proposal-history:${proposalId}:${revision}`) as Proposal | undefined;
    if (!previous || previous.taskId !== scope.taskId || previous.project !== scope.project) fail("not_found", "That approach revision is unavailable");
    return structuredClone(previous);
  }
  async resolveWebCoordinator(scope: ConversationScope, participant: import("./model.js").Participant) {
    await this.manager.assertExecutionAllowed(scope.repo, undefined, "Task coordinator settings");
    if (!scope.project || !this.manager.projects?.get(scope.project)?.repos.includes(scope.repo)) fail("scope_denied", "Project membership changed");
    const project = await preferences(join(scope.repo, ".codeflow", "cli-teams.json"), scope.repo), personal = await preferences(join(this.home, "cli-teams-preferences.json"));
    return resolveParticipant(participant, project, personal);
  }
  async acceptAndStartWeb(scope: ConversationScope, a: { proposalId: string; expectedRevision: number; proposalHash: string; operationId: string }, trigger?: Run["trigger"], untrustedText = false) {
    const c = { ...scope, surface: "web" as const };
    return this.serialized(async () => {
      await this.manager.assertExecutionAllowed(c.repo, undefined, "Web task start");
      if (!c.project || !this.manager.projects?.get(c.project)?.repos.includes(c.repo)) fail("scope_denied", "Project membership changed; choose an available repository");
      const p = this.proposal(c, a.proposalId);
      if (p.revision !== a.expectedRevision || p.hash !== a.proposalHash) fail("acceptance_stale", "The approach changed; review its current revision");
      if (!p.runId) { p.accepted = { hash: p.hash, at: Date.now() }; await this.save(`proposal:${p.id}`, p); }
      return this.startProposal(c, a, trigger, untrustedText);
    });
  }
  private async propose(c: ConversationScope, a: any) {
    const old = a.proposalId ? this.proposal(c, a.proposalId) : undefined;
    const candidate = validateCandidate(a.candidate);
    if (c.surface === "web") {
      // The browser may preserve a CLI-bound reviewer, but cannot invent a host binding.
      for (const participant of candidate.participants.filter(p => p.binding === "current_session")) {
        if (old?.origin !== "cli" || !old.definition.participants.some(p => p.id === participant.id && p.provider === participant.provider && p.binding === "current_session")) fail("validation_failed", "The browser is not an agent session; choose a managed participant for new assignments");
      }
      validateWebCandidate({ ...candidate, participants: candidate.participants.map(p => ({ ...p, binding: "managed" })) });
    }
    if (old && (old.revision !== a.expectedRevision || old.runId)) fail("revision_conflict", "Proposal changed or started; create a new proposal");
    const project = await preferences(join(c.repo, ".codeflow", "cli-teams.json"), c.repo), personal = await preferences(join(this.home, "cli-teams-preferences.json"));
    const participants = await Promise.all(candidate.participants.map(p => resolveParticipant(p, project, personal)));
    const limits = { maxInvocations: Math.min(DEFAULT_LOOP.maxInvocations ?? DEFAULT_LOOP.maxSteps, 256), maxMinutes: Math.min(DEFAULT_LOOP.maxMinutes, 720), concurrency: 2, maxAttempts: 2, ...candidate.limits, attemptTimeoutMs: STEP_TIMEOUT_MS };
    const definition: Definition = { ...candidate, participants, limits };
    limits.attemptTimeoutMs = Math.min(limits.attemptTimeoutMs, limits.maxMinutes * 60_000);
    const context = a.context ?? {};
    if (old?.chatId && context.chatId && context.chatId !== old.chatId || old?.project && context.projectId && context.projectId !== old.project) fail("scope_denied", "Revise this proposal in its original project and chat");
    if (context.attachments) (await import("../conversational/attachments.js")).chatAttachments(context.attachments);
    const source = await this.source(c, candidate.source ?? (candidate.scope === "review" ? "working_changes" : "head"), context);
    const sourceAgain = await this.source(c, source.source, context);
    if (source.fingerprint !== sourceAgain.fingerprint) fail("snapshot_stale", "Repository changed during capture; retry proposal creation");
    for (const ref of context.artifacts ?? []) {
      const previous = this.run(c, ref.runId), artifact = previous.cliTeam!.artifacts[ref.artifactId];
      if (!artifact || artifact.sha256 !== ref.sha256) fail("artifact_stale", "A supplied artifact reference is stale");
      if (previous.cliTeam!.source.fingerprint !== source.fingerprint && context.continueRunId !== previous.id) fail("context_stale", "The repository context changed since this plan; review/rebase the plan in a new proposal before implementation");
    }
    const proposalId = old?.id ?? id();
    const link = old?.chatId ? { project: old.project, taskId: old.taskId, chatId: old.chatId } : c.surface === "web" ? { project: c.project, taskId: c.taskId, chatId: c.chatId } : await this.workspace?.resolve(c.repo, context, proposalId);
    const p: Proposal = { ...link, ...(old?.origin === "cli" || c.surface !== "web" ? { origin: "cli" as const } : {}), id: proposalId, repo: c.repo, revision: (old?.revision ?? 0) + 1, hash: "", task: a.task, context, definition, source, hostConnection: c.id ?? old?.hostConnection ?? "" };
    p.hash = digest({ ...p, hash: undefined });
    await this.save(`proposal-history:${p.id}:${p.revision}`, p);
    await this.save(`proposal:${p.id}`, p);
    return { proposalId: p.id, revision: p.revision, proposalHash: p.hash, preview: this.preview(p, true), definition: { participants, limits, scope: definition.scope }, nextAction: `codeflow approve ${p.id} --revision ${p.revision}` };
  }
  private async startProposal(c: ConversationScope, a: any, trigger?: Run["trigger"], untrustedText = false): Promise<any> {
    const p = this.proposal(c, a.proposalId);
    if (p.revision !== a.expectedRevision || p.hash !== a.proposalHash) fail("revision_conflict", "Proposal changed; review its current revision");
    if (p.runId) return { runId: p.runId };
    if (!p.accepted || p.accepted.hash !== p.hash || Date.now() - p.accepted.at > 15 * 60_000) fail("acceptance_required", p.chatId ? `Review and start this approach in Code Flow: codeflow open ${p.id}. Or approve in your CLI session.` : `Accept this proposal in an interactive terminal: codeflow approve ${p.id} --revision ${p.revision}`);
    if ((await this.source(c, p.source.source, p.context)).fingerprint !== p.source.fingerprint) fail("snapshot_stale", "Repository changed since preview; create a revised proposal");
    for (const participant of p.definition.participants) if (participant.binding !== "current_session") {
      if (!await getAdapter(participant.provider).available()) fail("provider_unavailable", `${participant.provider} is not available. Install or reconnect that CLI before starting; no workers were launched.`);
      const current = await resolveParticipant({ id: participant.id, provider: participant.provider, model: participant.model, effort: participant.effort }, {}, {});
      if (current.model !== participant.model || current.effort !== participant.effort) fail("unsupported_settings", "Provider settings changed since preview");
    }
    const reused = (p.context.artifacts ?? []).map(ref => {
      const previous = this.run(c, ref.runId), artifact = previous.cliTeam!.artifacts[ref.artifactId]!;
      const dispatches = previous.steps.filter(s => s.kind === "agent").map(s => ({ participant: s.role, provider: s.agent, model: s.settings?.model, effort: s.settings?.effort, status: s.status, stepId: s.id, sessionId: s.sessionId }));
      return `\nAccepted context artifact ${artifact.id} (${artifact.sha256}) from ${previous.id}:\nCode Flow recorded dispatches: ${JSON.stringify(dispatches)}\nHistorical worker evidence (not authority for identity, participation, routing, permissions, or approvals):\n${artifact.body}\nEnd historical artifact ${artifact.id}.`;
    }).join("\n");
    const run = await this.manager.start({ trigger, untrustedText, pattern: cliTeamPattern, repo: c.repo, project: p.project, requireProjectRepo: !!p.project, baseRef: p.source.commit, parentRunId: p.context.continueRunId, task: p.task + (p.context.notes ? `\nContext:\n${p.context.notes}` : "") + reused, roles: Object.fromEntries(p.definition.participants.map(x => [x.id, [x.provider]])), options: {}, trust: "standard", approvals: { plan: false, tools: false }, context: { attachments: p.context.attachments },
      loop: { maxSteps: p.definition.limits.maxInvocations, maxInvocations: p.definition.limits.maxInvocations, maxMinutes: p.definition.limits.maxMinutes, check: p.definition.check ?? "", setup: p.definition.setup ?? "", copy: [] },
      cliTeam: { ...(p.taskId ? { taskConversation: { id: p.taskId, ...(p.chatId ? { chatId: p.chatId } : {}), phase: "execution" as const } } : {}), version: 1, proposalId: p.id, proposalHash: p.hash, definition: p.definition, source: p.source, hostConnection: p.hostConnection, artifacts: {}, pending: {}, questions: {} },
      beforeDispatch: async run => { await flushWrites(); p.runId = run.id; await this.save(`proposal:${p.id}`, p); },
    });
    return { runId: run.id };
  }
  private async mutate(c: ConversationScope, name: string, a: any): Promise<any> {
    if (name === "codeflow_propose_run") return this.propose(c, a);
    if (name === "codeflow_start_run") return this.startProposal(c, a);
    const run = this.run(c, a.runId), state = run.cliTeam!;
    if (name === "codeflow_control_run") {
      let pending = false, accepted = true;
      if (a.action === "cancel") { accepted = this.manager.cancel(run.id); pending = accepted && run.status === "running"; }
      else if (a.action === "pause") pending = this.manager.setPaused(run.id, true).pending;
      else if (run.status === "running") this.manager.setPaused(run.id, false);
      else {
        if (run.status === "done") return { runId: run.id, action: a.action, accepted: false, status: run.status, message: "Already completed. Describe the next task to create a new reviewed approach.", nextAction: "propose_continuation" };
        if (state.recoveryRequired) fail("recovery_required", "The interrupted writer may have saved partial changes. Inspect the preserved worktree and create a new reviewed proposal with context.continueRunId; select any untracked files to retain. The writer will not be replayed automatically.");
        if (state.outcome === "stopped_limit" || state.outcome === "blocked" || run.stopReason?.startsWith("assignment attempt limit") || (run.clockUsedMs ?? 0) >= state.definition.limits.maxMinutes * 60_000) fail("budget_exhausted", "Create a new proposal for completed work, changed completion criteria, or extended execution limits");
        await this.manager.resume(run.id, undefined, true);
      }
      await flushWrites(); return { runId: run.id, action: a.action, accepted, pending, status: run.status, paused: !!run.pauseRequested };
    }
    if (name === "codeflow_steer_run") {
      if (a.candidate) {
        if (run.status === "running") this.manager.setPaused(run.id, true);
        if (run.steps.some(s => s.status === "running")) return { runId: run.id, paused: true, pending: true, nextAction: "Wait for active turns to settle, then send the revised candidate with a new operation ID" };
        const previous = this.proposal(c, state.proposalId);
        return this.propose(c, { task: previous.task, candidate: a.candidate, context: { notes: a.message, continueRunId: run.id, ...(previous.chatId ? { chatId: previous.chatId } : {}) } });
      }
      if (a.questionId) {
        const q = state.questions[a.questionId];
        if (!q || q.answer !== undefined || !q.options.includes(a.message)) fail("validation_failed", "Answer a pending question using one of its options");
        await journalEntry(run.id, `cli-answer:${a.questionId}`, a.message); q.answer = a.message; this.notify(`${run.id}:${a.questionId}`);
      } else {
        // Scope-changing instructions must become explicit candidate revisions. A note never changes authority.
        const note = await this.manager.addTeamNote(run.id, `Clarification within the accepted scope only: ${a.message}`);
        return { runId: run.id, recorded: true, noteId: note.id, delivery: note.status };
      }
      return { runId: run.id, recorded: true };
    }
    const pending = state.pending[a.stepId];
    if (!pending || pending.attemptId !== a.attemptId || state.hostConnection !== c.id || run.status !== "running") fail("claim_conflict", "Assignment is not available to this host; reconnect with codeflow attach if necessary");
    if (name === "codeflow_claim_step") {
      if (pending.claimHash) fail("claim_conflict", "Assignment is already claimed; use its existing claim token");
      const token = id();
      const claim = { hash: digest(token), connection: c.id, expiresAt: Date.now() + 30 * 60_000, attemptId: pending.attemptId };
      await journalEntry(run.id, `cli-claim:${pending.id}`, claim);
      Object.assign(pending, { claimHash: claim.hash, claimExpiresAt: claim.expiresAt, connection: c.id });
      return { assignment: { id: pending.id, participant: pending.participant, operation: pending.operation, instructions: pending.instructions, inputs: pending.inputs.map(({ id, kind, sha256 }) => ({ id, kind, sha256 })), attemptId: pending.attemptId }, claimToken: token, deadline: claim.expiresAt };
    }
    if (name === "codeflow_submit_step") {
      if (pending.output || pending.connection !== c.id || pending.claimExpiresAt! < Date.now() || pending.claimHash !== digest(a.claimToken)) fail("claim_revoked", "Claim expired, was revoked, or already submitted");
      const review = pending.operation.startsWith("review");
      if (!a.output.body.trim()) fail("validation_failed", "Assignment output must contain a readable deliverable");
      if (review && (!a.output.verdict || !Array.isArray(a.output.findings))) fail("validation_failed", "Review requires verdict and findings");
      await journalEntry(run.id, `cli-host-output:${pending.id}`, a.output);
      pending.output = a.output; this.notify(`${run.id}:${pending.id}`); return { runId: run.id, submitted: true };
    }
    fail("unknown_tool", "Unknown mutation");
  }
  private async read(c: ConversationScope, name: string, a: any): Promise<any> {
    if (name === "codeflow_list_providers") {
      const project = await preferences(join(c.repo, ".codeflow", "cli-teams.json"), c.repo), personal = await preferences(join(this.home, "cli-teams-preferences.json"));
      return { preferredProvider: project.preferredProvider ?? personal.preferredProvider, providers: await Promise.all((["claude", "codex"] as const).map(async provider => ({ id: provider, installed: await getAdapter(provider).available(), authentication: "unverified; catalog discovery does not prove execution permissions", preferences: { ...personal.providers?.[provider], ...project.providers?.[provider] } }))) };
    }
    if (name === "codeflow_list_models") { const models = await catalog(a.providerId, a.refresh); const offset = a.cursor ?? 0, end = offset + (a.limit ?? 50); return { ...models, models: models.models.slice(offset, end), nextCursor: end < models.models.length ? end : undefined }; }
    if (name === "codeflow_list_runs") {
      const runs = this.manager.list().filter(r => r.repo === c.repo && r.pattern === "cli-team").filter(r => {
        try { const run = this.run(c, r.id); return !a.unfinishedOnly || !["plan_ready", "agreed_plan", "verified_changes", "review_complete"].includes(run.cliTeam!.outcome ?? ""); } catch { return false; }
      });
      const offset = a.cursor ?? 0, end = offset + (a.limit ?? 20);
      return { runs: runs.slice(offset, end).map(r => { const run = this.run(c, r.id); return { runId: run.id, task: run.task.slice(0, 300), status: run.status, outcome: run.cliTeam!.outcome, createdAt: run.createdAt, chatId: run.cliTeam!.taskConversation?.chatId }; }), total: runs.length, nextCursor: end < runs.length ? end : undefined };
    }
    const run = this.run(c, a.runId), state = run.cliTeam!;
    if (name === "codeflow_get_artifact") {
      const artifact = state.artifacts[a.artifactId];
      if (!artifact || artifact.sha256 !== a.sha256) fail("artifact_stale", "Choose the exact artifact ID/hash returned by get_run");
      const bytes = Buffer.from(artifact.body), cursor = a.cursor ?? 0;
      if (cursor > bytes.length || cursor < bytes.length && (bytes[cursor]! & 0xc0) === 0x80) fail("validation_failed", "Invalid UTF-8 artifact cursor");
      let end = Math.min(bytes.length, cursor + (a.maxBytes ?? 12000));
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      const files = artifact.data.changedFiles;
      const fileCursor = a.fileCursor ?? 0, fileEnd = fileCursor + 100;
      let data: Record<string, unknown> = Array.isArray(files) ? { ...artifact.data, changedFiles: files.slice(fileCursor, fileEnd), nextFileCursor: fileEnd < files.length ? fileEnd : undefined } : artifact.data;
      if (artifact.kind === "verification") {
        const check = artifact.data.evidence as Record<string, unknown> | undefined;
        // Check logs already page through body; do not duplicate unbounded output in metadata.
        data = { targetHash: data.targetHash, passed: data.passed, command: data.command,
          evidence: check ? { ok: check.ok, exitCode: check.exitCode, timedOut: check.timedOut, durationMs: check.durationMs } : undefined };
      }
      return { id: artifact.id, sha256: artifact.sha256, kind: artifact.kind, body: bytes.subarray(cursor, end).toString("utf8"), totalBytes: bytes.length, nextCursor: end < bytes.length ? end : undefined, ...(cursor === 0 ? { data: ["result", "code_snapshot", "review", "verification"].includes(artifact.kind) ? data : undefined } : {}) };
    }
    const events = await this.manager.events(run.id);
    const cursor = a.afterCursor ?? 0;
    const meaningful = events.filter(e => e.seq > cursor && (e.type === "log" || e.type === "step"));
    if (!meaningful.length && run.status === "running" && a.waitMs) await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); off(); resolve(); }; const off = this.manager.subscribe(run.id, finish); const timer = setTimeout(finish, a.waitMs); });
    let eventBytes = 0;
    const latest = (await this.manager.events(run.id)).filter(e => e.seq > cursor && (e.type === "log" || e.type === "step")).slice(0, a.limit ?? 50).map(e => e.type === "step" ? { seq: e.seq, type: e.type, title: e.step.title.slice(0, 200), status: e.step.status, error: e.step.error?.slice(0, 500) } : e.type === "log" ? { seq: e.seq, type: e.type, text: e.text.slice(0, 500) } : { seq: e.seq }).filter(e => { eventBytes += Buffer.byteLength(JSON.stringify(e)); return eventBytes < 10000; });
    const status = run.status === "running" && Object.values(state.pending).some(p => !p.output) ? "waiting_host" : run.status === "running" && Object.values(state.questions).some(q => !q.answer) ? "waiting_user" : run.status;
    const artifacts = Object.values(state.artifacts), artifactCursor = a.artifactCursor ?? 0, artifactEnd = artifactCursor + (a.artifactLimit ?? 50);
    const persistent = this.connections.get(c.id ?? "")?.kind === "mcp";
    const needsHost = state.definition.participants.some(p => p.binding === "current_session");
    return { ...runEvidence(run), runId: run.id, status, runtimeStatus: run.status, paused: !!run.pauseRequested, outcome: state.outcome, error: run.error?.slice(0, 1000), detail: state.detail?.slice(0, 1000), summary: run.summary?.slice(0, 4000), events: latest, afterCursor: latest.at(-1)?.seq ?? cursor,
      artifacts: artifacts.slice(artifactCursor, artifactEnd).map(({ id, kind, sha256, participant }) => ({ id, kind, sha256, participant })), artifactCount: artifacts.length, nextArtifactCursor: artifactEnd < artifacts.length ? artifactEnd : undefined,
      assignments: state.hostConnection === c.id ? Object.values(state.pending).filter(p => !p.output).map(p => ({ id: p.id, participant: p.participant, attemptId: p.attemptId, claimed: !!p.claimHash })) : [],
      questions: Object.entries(state.questions).filter(([, q]) => !q.answer).map(([id, q]) => ({ id, ...q })),
      host: { connected: this.connections.get(state.hostConnection)?.active === true && this.connections.get(state.hostConnection)!.expiresAt > Date.now(), thisSession: state.hostConnection === c.id, ...(needsHost && state.hostConnection !== c.id ? persistent ? { attachCommand: `codeflow attach ${run.id} --connection ${c.id}` } : { reconnect: "Ask your Claude or Codex MCP session to inspect this run, then use the attachment command it returns. Terminal status connections are temporary." } : {}) },
      limits: state.definition.limits, usage: { managedInvocations: state.managedInvocations ?? 0, accountedExecutionMs: Math.max(run.clockUsedMs ?? 0, state.accountedExecutionMs ?? 0), recoveryTimeChargeMs: state.recoveryTimeChargeMs, providerReported: run.usage, host: "unobserved", cost: "Provider usage may be incomplete or API-equivalent; this is not a billing total" },
    };
  }
  private async host(ctx: TeamContext, request: PendingAssignment): Promise<NonNullable<PendingAssignment["output"]>> {
    const state = ctx.run.cliTeam!;
    state.pending[request.id] = request; ctx.publish(); ctx.pauseClock();
    try {
      const journal = await loadJournal(ctx.run.id, { strict: true });
      const binding = journal.get("cli-host-connection"); if (typeof binding === "string") state.hostConnection = binding;
      request.output ??= journal.get(`cli-host-output:${request.id}`) as PendingAssignment["output"];
      while (!ctx.signal.aborted) {
        if (request.output) return request.output;
        await this.wait(ctx, `${ctx.run.id}:${request.id}`);
      }
      ctx.checkCancelled(); throw new Error("Host assignment cancelled");
    } finally { delete state.pending[request.id]; ctx.resumeClock(); ctx.publish(); }
  }
  private async question(ctx: TeamContext, key: string, question: string, options: string[], inputs?: string[]) {
    const q = ctx.run.cliTeam!.questions[key] = { question, options, inputs, answer: undefined as string | undefined }; ctx.pauseClock(); ctx.publish();
    try {
      q.answer ??= (await loadJournal(ctx.run.id, { strict: true })).get(`cli-answer:${key}`) as string | undefined;
      while (!ctx.signal.aborted) {
        if (q.answer) return q.answer;
        await this.wait(ctx, `${ctx.run.id}:${key}`);
      }
      ctx.checkCancelled(); throw new Error("Decision cancelled");
    } finally { ctx.resumeClock(); }
  }
}
