import { editableCandidate } from "../cli-teams/editable.js";
import { taskView } from "./view.js";
import { captureAgentSource } from "./agent-source.js";
import { randomBytes } from "node:crypto";
import { mkdir, open, chmod } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Run, RunManager } from "../engine.js";
import { journalEntry, loadJournal, RUNS_DIR, flushWrites } from "../store.js";
import { git, repoRoot, assertWorktree } from "../git.js";
import { CliTeamsService, type ConversationScope, type Proposal } from "../cli-teams/service.js";
import { digest, fail, validateCandidate, shapeProblem, type Candidate, type Participant, type Definition } from "../cli-teams/model.js";
import { catalog } from "../cli-teams/providers.js";
import { captureSource } from "../cli-teams/snapshots.js";
import { preparationPattern, preparationProblem } from "./preparation.js";
import { PREPARATION_LIMITS, TASK_LIMITS, type TaskConversation, type PrepareResult } from "./model.js";
const META = "web-task-conversations";
const freshId = () => randomBytes(12).toString("hex");
export function fields(value: any, allowed: string[]) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    fail("validation_failed", "This operation contains unsupported fields"); }
function text(value: unknown, label: string, max = 8000) { if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("validation_failed", `${label} must contain 1–${max} characters`); return value.trim(); }
function files(value: unknown): string[] { if (!Array.isArray(value) || value.length > 100 || value.some(p => typeof p !== "string" || !p || p.length > 2000 || p.startsWith("/") || p.split(/[\\/]/).includes("..") || p.includes("\0")))
    fail("validation_failed", "Choose at most 100 repository-relative new files"); return value as string[]; }
const candidateFrom = (p: Proposal): Candidate => editableCandidate(p.definition);
function visibleContext(context: Proposal["context"]) {
    const { attachments, ...rest } = context;
    return { ...rest, ...(attachments?.length ? { attachments: attachments.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.data, "base64") })) } : {}) };
}
export class TaskConversations {
    private tasks = new Map<string, TaskConversation>();
    private tail: Promise<unknown> = Promise.resolve();
    private bus = new EventEmitter();
    private readonly generation = freshId();
    private observations = new Map<string, {
        hash: string;
        revision: number;
    }>();
    constructor(readonly manager: RunManager, readonly core: CliTeamsService, readonly authorize: (project: string, repo: string) => Promise<void>, readonly protect: <T>(work: () => Promise<T>) => Promise<T> = work => work()) { this.bus.setMaxListeners(0); }
    async load() {
        await mkdir(RUNS_DIR, { recursive: true });
        const file = join(RUNS_DIR, `${META}.journal.jsonl`), handle = await open(file, "a", 0o600);
        await handle.close();
        await chmod(file, 0o600);
        for (const [key, value] of await loadJournal(META, { strict: true }))
            if (key.startsWith("task:")) {
                const task = value as TaskConversation;
                if (task.id !== key.slice(5) || !task.receipts || !task.preparation)
                    fail("storage_unavailable", "Task conversation storage needs repair");
                this.tasks.set(task.id, task);
            }
    }
    /** Project the canonical CLI proposal; no inference, approval or execution is performed. */
    async syncCliProposal(p: Proposal, event?: { id: string; body: string; runId?: string; noteId?: string }) {
        if (!p.project || !p.taskId || !p.chatId) fail("scope_denied", "Missing CLI workspace identity");
        await this.authorize(p.project, p.repo);
        return this.serialized(async () => {
            const existing = this.tasks.get(p.taskId!);
            if (existing && (existing.project !== p.project || existing.repo !== p.repo || existing.chatId !== p.chatId)) fail("scope_denied", "Task workspace identity changed");
            // Browser task leads are Claude or Codex, so an Antigravity worker is never chosen to lead.
            const managed = p.definition.participants.filter(a => a.binding !== "current_session");
            const first = managed.find(a => a.provider === "claude" || a.provider === "codex") ?? managed[0] ?? p.definition.participants[0]!;
            const t: TaskConversation = existing ? structuredClone(existing) : {
                id: p.taskId!, version: 0, project: p.project!, repo: p.repo, chatId: p.chatId, createHash: digest(["cli", p.taskId]), createdAt: Date.now(), updatedAt: Date.now(), request: p.task,
                source: p.source.source, untracked: p.context.untracked ?? [], coordinator: { id: "coordinator", provider: first.provider, model: first.model, effort: first.effort },
                messages: [], preparation: { ...PREPARATION_LIMITS, runs: [], processed: [] }, proposals: [], executions: [], changes: [], receipts: {},
            };
            let changed = !existing;
            const known = t.approaches?.some(a => a.id === p.id && a.revision === p.revision);
            if (!known) {
                // Do not let a delayed projection replace a newer browser revision.
                const newer = t.approaches?.some(a => a.id === p.id && a.revision > p.revision);
                if (!newer) {
                    t.request = p.task; t.source = p.source.source; t.untracked = p.context.untracked ?? [];
                    t.attachments = p.context.attachments; t.contextNotes = p.context.notes; t.continuation = p.context.continueRunId; t.sourceRunId = p.context.sourceRunId;
                    if (!t.proposals.includes(p.id)) t.proposals.push(p.id);
                    (t.approaches ??= []).push({ id: p.id, revision: p.revision, hash: p.hash, scope: p.definition.scope, at: Date.now() });
                    this.addMessage(t, "user", p.task, `cli-proposal-${p.id}-${p.revision}`); changed = true;
                }
            }
            if (p.runId && !t.executions.includes(p.runId)) { t.executions.push(p.runId); changed = true; }
            if (event && !t.messages.some(m => m.id === event.id)) { this.addMessage(t, "user", event.body, event.id); Object.assign(t.messages.at(-1)!, { runId: event.runId, noteId: event.noteId }); changed = true; }
            if (changed) await this.save(t);
            return t;
        });
    }
    private serialized<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.catch(() => undefined); return next; }
    private async save(t: TaskConversation, touch = true) { if (touch) {
        t.version++;
        t.updatedAt = Date.now();
    } await journalEntry(META, `task:${t.id}`, t); this.tasks.set(t.id, t); this.bus.emit(t.id); this.bus.emit("change", t.id); }
    private scope(t: TaskConversation): ConversationScope { return { repo: t.repo, project: t.project, taskId: t.id, chatId: t.chatId, surface: "web" }; }
    private async task(id: string) { const t = this.tasks.get(id); if (!t)
        fail("not_found", "This task conversation is unavailable"); await this.authorize(t.project, t.repo); return t; }
    private addMessage(t: TaskConversation, role: "user" | "system", body: string, id = freshId()) { if (t.messages.some(m => m.id === id))
        return; if (t.messages.length >= 200)
        fail("validation_failed", "This conversation has reached 200 messages. Its work is preserved; open another task to continue."); t.messages.push({ id, role, body, at: Date.now() }); }
    async list(project: string) { const list = [...this.tasks.values()].filter(t => t.project === project); const out = []; for (const t of list) {
        try {
            await this.authorize(t.project, t.repo);
            out.push({ id: t.id, request: t.request.slice(0, 180), updatedAt: t.updatedAt, chatId: t.chatId, preparing: !!t.preparation.active });
        }
        catch { }
    } return out.sort((a, b) => b.updatedAt - a.updatedAt); }
    /** Internal metadata projection; the conversation service authorizes its owning project first. */
    historySummary(id: string, project: string, repo: string) {
        const task = this.tasks.get(id);
        if (!task || task.project !== project || task.repo !== repo) fail("scope_denied", "Task belongs to another conversation source");
        const run = task.executions.length ? this.manager.get(task.executions.at(-1)!) : undefined;
        const proposal = this.proposal(task);
        const view = taskView({ task, proposal, execution: run ? { id: run.id, host: this.core.hostState(run), status: run.status, outcome: run.cliTeam?.outcome, paused: !!run.pauseRequested, pausePending: !!run.pauseRequested && run.steps.some(s => s.status === "running"), recoveryRequired: !!run.cliTeam?.recoveryRequired, waitingForSlot: !!run.cliTeam?.waitingForSlot, failureKind: run.failure?.kind, questions: Object.values(run.cliTeam?.questions ?? {}).filter(q => !q.answer), participation: [] } : undefined });
        return { view, id, request: task.request, updatedAt: Math.max(task.updatedAt, run?.endedAt ?? run?.createdAt ?? 0), runId: run?.id, status: run?.status, paused: !!run?.pauseRequested, outcome: run?.cliTeam?.outcome, scope: proposal?.definition.scope, preparing: !!task.preparation.active, ready: !!proposal && !proposal.runId, runIds: [...task.executions, ...task.preparation.runs] };
    }
    async create(a: any, link?: { chatId: string; continueRunId?: string; sourceRunId?: string; contextNotes?: string }) {
        fields(a, ["operationId", "project", "repo", "request", "source", "untracked", "coordinator", "attachments"]);
        const operationId = text(a.operationId, "Operation ID", 100), project = text(a.project, "Project", 100), repo = await repoRoot(text(a.repo, "Repository", 2000));
        await this.authorize(project, repo);
        if (!a.repo.startsWith("/"))
            fail("validation_failed", "Choose an absolute repository path");
        const id = digest([project, repo, operationId]).slice(0, 32), hash = link ? digest([a, link]) : digest(a);
        return this.serialized(async () => {
            const prior = this.tasks.get(id);
            if (prior) {
                if (prior.createHash !== hash)
                    fail("idempotency_conflict", "Creation ID was used with different arguments");
                return { id, version: prior.version };
            }
            let provider = a.coordinator?.provider;
            if (!provider) {
                const discovered = await this.core.operateWeb({ project, repo }, "codeflow_list_providers", {});
                // Coordinators are Claude or Codex; an Antigravity preference applies to workers.
                const lead = (id: unknown) => id === "claude" || id === "codex";
                provider = (lead(discovered.preferredProvider) ? discovered.preferredProvider : undefined) ?? discovered.providers.find((p: any) => p.installed && lead(p.id))?.id;
            }
            const request = text(a.request, "Task", 12000), coordinator: Participant = { id: "coordinator", provider, ...a.coordinator };
            if (a.coordinator)
                fields(a.coordinator, ["provider", "model", "effort"]);
            if (a.coordinator && shapeProblem({ type: "object", properties: { provider: { enum: ["claude", "codex"] }, model: { type: "string", minLength: 1, maxLength: 160 }, effort: { type: "string", minLength: 1, maxLength: 20 } } }, a.coordinator))
                fail("validation_failed", "Choose a supported coordinator provider with string model/effort settings");
            if (!["claude", "codex"].includes(coordinator.provider))
                fail("validation_failed", "Choose Claude or Codex as coordinator");
            const t: TaskConversation = { id, version: 0, project, repo, createHash: hash, createdAt: Date.now(), updatedAt: Date.now(), request, source: a.source ?? "working_changes", untracked: files(a.untracked ?? []), coordinator, messages: [], preparation: { ...PREPARATION_LIMITS, runs: [], processed: [] }, proposals: [], executions: [], changes: [], receipts: {} };
            if (link) {
                t.chatId = link.chatId; t.contextNotes = link.contextNotes; t.sourceRunId = link.sourceRunId;
                if (link.continueRunId) {
                    const parent = this.manager.get(link.continueRunId);
                    if (parent?.project !== project || parent.repo !== repo || parent.cliTeam?.taskConversation?.chatId !== link.chatId) fail("scope_denied", "Retained work belongs to another conversation");
                    t.continuation = parent.id;
                }
            }
            if (a.attachments !== undefined) t.attachments = (await import("./attachments.js")).chatAttachments(a.attachments);
            await this.source(t);
            this.addMessage(t, "user", request);
            await this.save(t);
            return { id, version: t.version };
        });
    }
    private async source(t: TaskConversation) {
        if (!["head", "working_changes"].includes(t.source))
            fail("validation_failed", "Choose committed code or the current working copy");
        if (t.sourceRunId && !t.continuation) return captureAgentSource(this.manager, this.scope(t), t.sourceRunId);
        if (t.continuation) {
            const r = this.manager.get(t.continuation), wt = r?.worktrees.find(w => w.name === "team");
            if (!r || !wt)
                fail("recovery_required", "The retained worktree is unavailable; inspect the previous execution");
            const source = await captureSource(await assertWorktree(t.repo, wt), "working_changes", t.untracked);
            return { ...source, base: r.cliTeam!.source.base };
        }
        return captureSource(t.repo, t.source, t.untracked);
    }
    private usage(t: TaskConversation) { return t.preparation.runs.reduce((v, id) => { const r = this.manager.get(id); return { calls: v.calls + (r?.cliTeam?.managedInvocations ?? 0), ms: v.ms + Math.max(r?.clockUsedMs ?? 0, r?.cliTeam?.accountedExecutionMs ?? 0) }; }, { calls: 0, ms: 0 }); }
    private proposal(t: TaskConversation) { return t.proposals.length ? this.core.getWebProposal(this.scope(t), t.proposals.at(-1)!) : undefined; }
    private goal(t: TaskConversation) {
        let baseline = 0;
        t.messages.forEach((m, i) => { if (m.role === "user" && m.body === t.request) baseline = i + 1; });
        const changes = t.messages.slice(baseline).filter(m => m.role === "user" && m.kind !== "status").map(m => m.body).join("\n");
        const goal = changes ? `${t.request}\n\nLatest user changes, taking precedence where they explicitly revise the original request:\n${changes}` : t.request;
        if (goal.length > 12000) fail("context_limit", "The task and its changes exceed the proposal context limit. Edit a shorter complete task request; the conversation and work are preserved.");
        return goal;
    }
    private checkIntent(t: TaskConversation, candidate: Candidate) {
        let readOnly = false, checkpoint = false;
        let baseline = 0;
        t.messages.forEach((m, i) => { if (m.role === "user" && m.body === t.request) baseline = i; });
        for (const m of t.messages.slice(baseline).filter(m => m.role === "user" && m.kind !== "status")) {
            const waits = /before (?:coding|implementing)|until (?:I|we) (?:approve|review)|show me (?:the )?(?:design|plan).*before/i.test(m.body);
            if (/\b(?:plan|planning|review) only\b|\b(?:do not|don't) (?:edit|implement|fix)\b|\bno code edits\b/i.test(m.body) && !waits) readOnly = true;
            else if (/^(?:please )?(?:implement|build|fix|add|change|update)\b/i.test(m.body)) readOnly = false;
            if (waits) checkpoint = true;
        }
        if (readOnly && candidate.scope === "write") fail("scope_denied", "This request explicitly permits planning/review only. Prepare a non-writing approach, or explicitly replace that instruction in a new proposal.");
        if (checkpoint && candidate.scope === "write") {
            let approvedEarlier = false, violation = false;
            const visit = (steps: Candidate["steps"]) => { for (const n of steps) { if (n.type === "user_decision" && n.continueOn && n.inputs?.length) approvedEarlier = true; if (n.type === "task" && ["implement", "repair"].includes(n.operation) && !approvedEarlier) violation = true; if (n.type === "loop") visit(n.steps); } }; visit(candidate.steps);
            if (violation) fail("validation_failed", "The request requires design review before editing. Place an explicit human checkpoint with its referenced plan before implementation.");
        }
    }
    private async submit(t: TaskConversation, candidate: Candidate, operationId: string) {
        candidate = validateCandidate(candidate);
        this.checkIntent(t, candidate);
        candidate.source = t.source;
        const previous = this.proposal(t), prior = t.continuation ? this.manager.get(t.continuation) : undefined, artifact = prior ? Object.values(prior.cliTeam!.artifacts).filter(a => a.kind === "result").at(-1) : undefined;
        const p = await this.core.operateWeb(this.scope(t), "codeflow_propose_run", { operationId, task: this.goal(t), candidate, ...(previous && !previous.runId ? { proposalId: previous.id, expectedRevision: previous.revision } : {}), context: { notes: (t.contextNotes ? [t.messages.filter(m => m.role === "user").slice(-12).map(m => m.body).join("\n").slice(-1600), t.contextNotes].join("\n") : t.messages.filter(m => m.role === "user").slice(-12).map(m => m.body).join("\n")).slice(-8000), untracked: t.untracked, attachments: t.attachments, sourceRunId: t.sourceRunId, continueRunId: t.continuation, ...(artifact && prior ? { artifacts: [{ runId: prior.id, artifactId: artifact.id, sha256: artifact.sha256 }] } : previous && !previous.runId && previous.context.artifacts ? { artifacts: previous.context.artifacts } : {}) } });
        if (t.proposals.at(-1) !== p.proposalId)
            t.proposals.push(p.proposalId);
        const next = this.proposal(t)!;
        (t.approaches ??= []).push({ id: next.id, revision: next.revision, hash: next.hash, scope: next.definition.scope, at: Date.now() });
        t.changes = previous ? [previous.definition.scope !== next.definition.scope ? `Scope changed from ${previous.definition.scope} to ${next.definition.scope}.` : "Scope unchanged.", ...(digest(previous.definition.participants) !== digest(next.definition.participants) ? ["Participant model, effort, or assignments changed."] : []), ...(digest(previous.definition.limits) !== digest(next.definition.limits) ? ["Execution limits changed."] : []), ...(digest(previous.definition.steps) !== digest(next.definition.steps) ? ["Work sequence changed."] : []), ...(t.continuation ? ["Continue from retained work; editing occurs only if an implementation assignment is included."] : [])] : [];
        delete t.question;
        delete t.error;
        delete t.draftCandidate;
    }
    private async reconcile(t: TaskConversation) {
        const p = this.proposal(t);
        if (p?.runId && !t.executions.includes(p.runId)) {
            t.executions.push(p.runId);
            await this.save(t);
        }
        const id = t.preparation.active;
        if (!id)
            return;
        const run = this.manager.get(id);
        if (run?.status === "running" || run?.status === "interrupted")
            return;
        if (t.preparation.processed.includes(id)) {
            delete t.preparation.active;
            return;
        }
        try {
            if (run?.status !== "done")
                throw new Error(run?.error || run?.stopReason || "Preparation stopped. The request and its used allowance are preserved.");
            const output = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "result");
            if (!output)
                throw new Error("Preparation produced no structured approach");
            const result = JSON.parse(output.body) as PrepareResult, problem = preparationProblem(result);
            if (problem)
                throw new Error(problem);
            if (result.kind === "question") {
                t.question = result.question;
                this.addMessage(t, "system", result.question!.question, `question-${id}`);
            }
            else {
                result.candidate!.limits = { ...TASK_LIMITS, ...result.candidate!.limits };
                t.draftCandidate = result.candidate;
                if ((await this.source(t)).fingerprint !== run.cliTeam!.source.fingerprint)
                    throw new Error("Source changed while preparing. Refresh the source and review the retained approach before starting.");
                await this.submit(t, result.candidate!, `preparation-${id}`);
                this.addMessage(t, "system", "The approach is ready for review. Start task approves and starts this exact revision.", `ready-${id}`);
            }
        }
        catch (e) {
            t.error = (e as Error).message;
        }
        t.preparation.processed.push(id);
        delete t.preparation.active;
        await this.save(t);
    }
    private async prepare(t: TaskConversation, operationId: string) {
        this.goal(t);
        await this.reconcile(t);
        if (t.preparation.active) {
            const r = this.manager.get(t.preparation.active);
            if (r?.status === "interrupted") {
                await this.manager.resume(r.id, undefined, true);
                return;
            }
            fail("conflict", "An approach is already being prepared");
        }
        const latest = t.executions.at(-1), run = latest && this.manager.get(latest);
        if (run) {
            if (run.status === "running") {
                this.manager.setPaused(run.id, true);
                if (run.steps.some(s => s.status === "running"))
                    fail("conflict", "Pausing the current work. Wait for its active assignment to finish, then prepare the revision.");
            }
            t.continuation = run.id; delete t.sourceRunId;
        }
        const used = this.usage(t), calls = t.preparation.maxCalls - used.calls, minutes = t.preparation.maxMinutes - used.ms / 60000;
        if (calls < 1 || minutes < 0.1)
            fail("budget_exhausted", "The preparation allowance is used. Increase it explicitly or edit the existing approach without inference.");
        const source = await this.source(t), discovery = await this.core.operateWeb(this.scope(t), "codeflow_list_providers", {});
        const inventory = await Promise.all(discovery.providers.filter((p: any) => p.installed).map(async (p: any) => { try {
            return { provider: p.id, ...(await catalog(p.id)) };
        }
        catch (e) {
            return { provider: p.id, error: (e as Error).message };
        } }));
        const coordinator = await this.core.resolveWebCoordinator(this.scope(t), t.coordinator);
        const tree = await git(["ls-tree", "-r", "--name-only", source.commit], t.repo), pkg = await git(["show", `${source.commit}:package.json`], t.repo);
        const skillText = await (await import("node:fs/promises")).readFile(new URL("../../integrations/cli-teams/SKILL.md", import.meta.url), "utf8");
        const skill = skillText.split("## Candidate contract")[1]!.split("## Preview and start")[0]!;
        const previous = this.proposal(t);
        const prompt = `CODEFLOW_WEB_PREPARATION\nPrepare the PROCESS for the user's task. Do not perform the requested work or write repository files. Return JSON matching the response schema. Use kind=question only for a material ambiguity or unavailable explicit setting. Otherwise use kind=proposal and a candidate following the contract below. Preserve explicit provider/model/effort requests. Later explicit user changes take precedence over earlier requests in a new proposal; retain earlier constraints unless the user changed them. Never mutate an accepted execution. Each job may have a different model/effort, even within the same provider. All participants are managed. A plan-only or review-only instruction must not authorize edits.\nUse the smallest adequate team. Default task allowance: ${JSON.stringify(TASK_LIMITS)}. Up to three review passes, only when requested and feasible within the call allowance; never promise unbounded agreement. Checks must be real project commands from context; do not invent successful evidence. A retained implementation can be reviewed and checked without another writer. When both authors must agree, require explicit review_plan endorsements from both participants on the same revision; drafting alone is not endorsement. A fresh final reviewer is a separate managed participant. If the user requests design review before coding, produce a plan artifact followed by user_decision with inputs pointing to that plan and continueOn pointing to the exact approval option. A rejection must stop before implementation.\nFor a scope/model/process/allowance change produce a new candidate; ordinary user constraints belong in assignments.\nCandidate contract:\n${skill}\nAvailable catalogs:\n${JSON.stringify(inventory).slice(0, 32000)}\nTask request:\n${this.goal(t)}\nRecent user conversation:\n${t.messages.filter(m => m.role === "user").slice(-12).map(m => m.body).join("\n").slice(-12000)}\nSource files:\n${tree.stdout.slice(0, 12000)}\npackage.json from the pinned source:\n${pkg.code === 0 ? pkg.stdout.slice(0, 8000) : "No package.json; ask if a required check cannot be established."}\n${previous ? `Previous approach (historical; apply the user's requested changes):\n${JSON.stringify(candidateFrom(previous)).slice(0, 24000)}` : ""}\n${t.continuation ? "Continue from the retained code snapshot. Do not rewrite completed implementation when only review/check was requested." : ""}`;
        const definition: Definition = { scope: "plan", participants: [coordinator], steps: [{ id: "prepare", type: "task", operation: "propose", participant: coordinator.id, instructions: "Prepare the approach" }, { id: "finish", type: "finish", outcome: "plan_ready", inputs: ["prepare"] }], completion: ["A valid approach or material clarification"], limits: { maxInvocations: calls, maxMinutes: minutes, concurrency: 1, maxAttempts: Math.min(3, calls), attemptTimeoutMs: Math.min(5 * 60000, minutes * 60000) } };
        await this.manager.start({ pattern: preparationPattern, project: t.project, requireProjectRepo: true, repo: t.repo, baseRef: source.commit, task: prompt, roles: { coordinator: [coordinator.provider] }, options: {}, trust: "standard", approvals: {}, loop: { maxSteps: calls, maxInvocations: calls, maxMinutes: minutes, setup: "", check: "", copy: [] }, cliTeam: { version: 1, taskConversation: { id: t.id, phase: "preparation" }, proposalId: `prepare-${operationId}`, proposalHash: digest(prompt), definition, source, hostConnection: "", artifacts: {}, pending: {}, questions: {} }, beforeDispatch: async (r) => { await flushWrites(); t.preparation.runs.push(r.id); t.preparation.active = r.id; delete t.error; delete t.question; await this.save(t); } });
    }
    async action(id: string, a: any, trigger?: Run["trigger"], untrustedText = false) {
        const inputs: Record<string, string[]> = { prepare: ["message", "request", "source", "untracked"], edit: ["candidate", "source", "untracked"], start: ["proposalId", "revision", "hash"], pause: [], resume: [], cancel: [], message: ["message"], answer: ["message", "questionId"], status: ["message"], allow_preparation: ["maxCalls", "maxMinutes"] };
        if (!a || !Object.hasOwn(inputs, a.action))
            fail("validation_failed", "Unknown task action");
        fields(a, ["operationId", "expectedVersion", "action", ...inputs[a.action]!]);
        const operationId = text(a.operationId, "Operation ID", 100), hash = digest({ ...a, expectedVersion: undefined });
        return this.serialized(async () => {
            const t = structuredClone(await this.task(id)), prior = t.receipts[operationId];
            if (prior && prior.hash !== hash && prior.hash !== digest(a))
                fail("idempotency_conflict", "Operation ID was used with different arguments");
            if (prior?.completed)
                return { id: t.id, version: t.version };
            if (!prior) {
                if (a.expectedVersion !== t.version)
                    fail("revision_conflict", "This task changed in another view. Refresh before submitting; your draft is preserved.");
                if (Object.keys(t.receipts).length >= 500)
                    fail("validation_failed", "This conversation reached its operation limit; work remains preserved");
                t.receipts[operationId] = { hash };
                await this.save(t, false);
            }
            try {
                if (a.request !== undefined) {
                    t.request = text(a.request, "Task", 12000);
                    this.addMessage(t, "user", t.request, `request-${operationId}`);
                }
                if (a.source !== undefined) {
                    if (!["head", "working_changes"].includes(a.source))
                        fail("validation_failed", "Choose a supported source snapshot");
                    t.source = a.source;
                }
                if (a.untracked !== undefined)
                    t.untracked = files(a.untracked);
                const runId = t.executions.at(-1);
                if (a.action === "prepare") {
                    if (a.message)
                        this.addMessage(t, "user", text(a.message, "Changes"), operationId);
                    await this.prepare(t, operationId);
                }
                else if (a.action === "edit") {
                    if (!a.candidate)
                        fail("validation_failed", "Supply the edited approach");
                    const candidate = validateCandidate(a.candidate), previous = this.proposal(t);
                    const changed = candidate.participants.filter(p => { const old = previous?.definition.participants.find(old => old.id === p.id); return old && (old.provider !== p.provider || old.model !== p.model || old.effort !== p.effort); });
                    if (changed.length) this.addMessage(t, "user", `Explicit participant settings override earlier textual model/effort choices for these jobs:\n${changed.map(p => `${p.id}: ${p.provider} / ${p.model ?? "project or provider default"} / ${p.effort ?? "default effort"}`).join("\n")}`, `settings-${operationId}`);
                    const run = runId && this.manager.get(runId);
                    if (run) {
                        if (run.status === "running" && (!run.pauseRequested || run.steps.some(s => s.status === "running")))
                            fail("conflict", "Pause active work before changing the approach");
                        t.continuation = run.id; delete t.sourceRunId;
                    }
                    await this.submit(t, candidate, operationId);
                }
                else if (a.action === "start") {
                    const p = this.proposal(t);
                    if (!p || p.id !== a.proposalId || p.revision !== a.revision || p.hash !== a.hash || t.preparation.active)
                        fail("acceptance_stale", "Review the current approach before starting");
                    const started = await this.core.acceptAndStartWeb(this.scope(t), { operationId, proposalId: p.id, expectedRevision: p.revision, proposalHash: p.hash }, trigger, untrustedText);
                    if (!t.executions.includes(started.runId))
                        t.executions.push(started.runId);
                    const priorRun = t.continuation && this.manager.get(t.continuation);
                    if (priorRun && priorRun.id !== started.runId && priorRun.status === "running" && priorRun.pauseRequested)
                        this.manager.cancel(priorRun.id);
                }
                else if (["pause", "resume", "cancel"].includes(a.action)) {
                    const target = t.preparation.active ?? runId;
                    if (!target)
                        fail("conflict", "No execution is available");
                    if (t.preparation.active) {
                        if (a.action === "cancel")
                            this.manager.cancel(target);
                        else if (a.action === "pause")
                            this.manager.setPaused(target, true);
                        else if (this.manager.get(target)?.status === "running")
                            this.manager.setPaused(target, false);
                        else
                            await this.manager.resume(target, undefined, true);
                    }
                    else
                        await this.core.operateWeb(this.scope(t), "codeflow_control_run", { operationId, runId: target, action: a.action });
                }
                else if (a.action === "message" || a.action === "answer") {
                    if (!runId)
                        fail("conflict", "Prepare an approach before sending execution instructions");
                    const body = text(a.message, "Message");
                    const result = await this.core.operateWeb(this.scope(t), "codeflow_steer_run", { operationId, runId, message: body, ...(a.action === "answer" ? { questionId: a.questionId } : {}) });
                    this.addMessage(t, "user", body, operationId);
                    Object.assign(t.messages.find(m => m.id === operationId)!, { noteId: result.noteId, runId });
                }
                else if (a.action === "status") {
                    const r = runId ? this.manager.get(runId) : undefined;
                    const artifacts = Object.values(r?.cliTeam?.artifacts ?? {}), result = artifacts.filter(a => a.kind === "result").at(-1);
                    const linked = new Set(Array.isArray(result?.data.artifacts) ? result.data.artifacts : []);
                    const reviews = artifacts.filter(a => a.kind === "review" && (!linked.size || linked.has(a.id) || linked.has(a.data.target))).slice(-3);
                    this.addMessage(t, "user", a.message ? text(a.message, "Question") : "What remains unresolved?", operationId);
                    t.messages.find(m => m.id === operationId)!.kind = "status";
                    this.addMessage(t, "system", r ? `Execution: ${r.status}${r.pauseRequested ? " · pause requested" : ""}. ${r.cliTeam?.outcome ?? r.error ?? r.stopReason ?? "Work continues within the accepted approach."}\nRecorded review evidence (artifact IDs identify revisions):\n${reviews.map(a => `${a.id}; target ${a.data.target}\n${a.body}`).join("\n\n").slice(-10000)}` : t.preparation.active ? "The approach is being prepared. No task implementation has started." : "Review the prepared approach, then choose Start task.", `status-${operationId}`);
                }
                else if (a.action === "allow_preparation") {
                    if (!Number.isSafeInteger(a.maxCalls) || a.maxCalls < t.preparation.maxCalls || a.maxCalls > 20 || !Number.isFinite(a.maxMinutes) || a.maxMinutes < t.preparation.maxMinutes || a.maxMinutes > 60)
                        fail("validation_failed", "Choose a total preparation allowance up to 20 calls and 60 minutes");
                    if (t.preparation.active)
                        fail("conflict", "Wait for preparation to settle before changing its allowance");
                    t.preparation.maxCalls = a.maxCalls;
                    t.preparation.maxMinutes = a.maxMinutes;
                    this.addMessage(t, "system", `Preparation allowance explicitly changed to ${a.maxCalls} total calls and ${a.maxMinutes} total minutes.`);
                }
                else
                    fail("validation_failed", "Unknown task action");
                t.receipts[operationId]!.completed = true;
                delete t.error;
                await this.save(t);
                return { id: t.id, version: t.version };
            }
            catch (error) {
                t.error = (error as Error).message;
                await this.save(t);
                throw error;
            }
        });
    }
    subscribeChanges(listener: (id: string) => void) { this.bus.on("change", listener); return () => { this.bus.off("change", listener); }; }
    async advance(id: string) { return this.serialized(() => this.protect(async () => this.reconcile(await this.task(id)))); }
    async advancePreparations() { for (const t of this.tasks.values()) if (t.preparation.active) await this.advance(t.id).catch(() => undefined); }
    read(id: string, after?: string, waitMs = 0, signal?: AbortSignal) { return this.get(id, after, waitMs, signal, false); }
    readExecution(id: string, runId: string) { return this.get(id, undefined, 0, undefined, false, runId); }
    async get(id: string, after?: string, waitMs = 0, signal?: AbortSignal, advance = true, executionId?: string) {
        let t = await this.task(id);
        if (advance) await this.advance(id);
        const project = async () => {
            t = await this.task(id);
            if (executionId && !t.executions.includes(executionId)) fail("scope_denied", "That execution belongs to another task");
            let p = this.proposal(t); const runId = executionId ?? t.executions.at(-1), run = runId ? this.manager.get(runId) : undefined, preparing = t.preparation.active ? this.manager.get(t.preparation.active) : undefined;
            const state = run?.cliTeam;
            if (executionId && state) { const approach = t.approaches?.find(a => a.hash === state.proposalHash); if (!approach) fail("not_found", "The preserved execution approach is unavailable"); p = { ...this.core.getWebProposal(this.scope(t), state.proposalId, approach.revision), runId: run!.id }; }
            const participation = state?.definition.participants.map(p => ({ id: p.id, provider: p.provider, model: p.model, effort: p.effort, binding: p.binding, hostSubmissions: p.binding === "current_session" ? Object.values(state.artifacts).filter(a => a.participant === p.id && (a.kind === "plan" || a.kind === "review")).length : 0, assignments: run!.steps.filter(s => s.kind === "agent" && s.role === p.id).map(s => ({ id: s.id, status: s.status, title: s.title.slice(0, 200), model: s.settings?.model, effort: s.settings?.effort, invocations: s.invocations ?? 0, sessionId: s.sessionId })) })) ?? [];
            const artifacts = Object.values(state?.artifacts ?? {});
            const previewIds = new Set(artifacts.filter(a => a.kind !== "result" && a.kind !== "collection").slice(-4).map(a => a.id));
            const outputs = artifacts.map(({ id, sha256, kind, data, participant, body }) => ({
                id, sha256, kind, participant,
                excerpt: previewIds.has(id) ? body.slice(0, 600) : undefined,
                excerptTruncated: previewIds.has(id) && body.length > 600 || undefined,
                data: kind === "review" || kind === "decision" || kind === "result" ? data : undefined,
            }));
            const snapshot = { task: t, proposal: p ? { id: p.id, revision: p.revision, hash: p.hash, task: p.task, definition: p.definition, source: p.source, context: visibleContext(p.context), runId: p.runId } : undefined, preparationUsage: this.usage(t), executionTotals: t.executions.reduce((total, id) => { const r = this.manager.get(id); return { calls: total.calls + (r?.cliTeam?.managedInvocations ?? 0), ms: total.ms + Math.max(r?.clockUsedMs ?? 0, r?.cliTeam?.accountedExecutionMs ?? 0) }; }, { calls: 0, ms: 0 }), preparing: preparing ? { id: preparing.id, status: preparing.status, error: preparing.error, steps: preparing.steps.map(s => ({ title: s.title, status: s.status })) } : undefined,
                execution: run ? { id: run.id, status: run.status, host: this.core.hostState(run), participation, paused: !!run.pauseRequested, pausePending: !!run.pauseRequested && run.steps.some(s => s.status === "running"), waitingForSlot: !!state?.waitingForSlot, limits: state?.definition.limits, recoveryRequired: !!state?.recoveryRequired, failureKind: run.failure?.kind ?? run.steps.find(s => s.status === "failed")?.errorKind, outcome: state?.outcome, error: run.error, detail: state?.detail, stopReason: run.stopReason, usage: { calls: state?.managedInvocations ?? 0, ms: Math.max(run.clockUsedMs ?? 0, state?.accountedExecutionMs ?? 0) }, activity: state?.activity ?? [], questions: Object.entries(state?.questions ?? {}).filter(([, q]) => !q.answer).map(([id, q]) => ({ id, ...q })), artifacts: outputs, worktrees: run.worktrees.map(w => ({ branch: w.branch, path: w.path })), notes: run.notes.map(n => ({ id: n.id, status: n.status, deliveredTo: n.deliveredTo })) } : undefined };
            const { receipts: _, createHash: __, attachments: ___, ...safeTask } = snapshot.task;
            const visible = structuredClone({ ...snapshot, task: safeTask, view: taskView(snapshot) }), hash = digest(visible), old = this.observations.get(id);
            const observation = old?.hash === hash ? old.revision : (old?.revision ?? 0) + 1;
            this.observations.set(id, { hash, revision: observation });
            return { ...visible, generation: this.generation, observation, cursor: `${this.generation}:${hash}` };
        };
        let value = await project();
        if (after === value.cursor && waitMs > 0) {
            await new Promise<void>(resolve => { const off = [...t.executions.slice(-1), ...(t.preparation.active ? [t.preparation.active] : [])].map(id => this.manager.subscribe(id, finish)); const timer = setTimeout(finish, Math.min(waitMs, 25000)).unref(); function finish() { clearTimeout(timer); off.forEach(fn => fn()); thisBus.off(id, finish); signal?.removeEventListener("abort", finish); resolve(); } const thisBus = this.bus; this.bus.once(id, finish); signal?.addEventListener("abort", finish, { once: true }); if (signal?.aborted)
                finish(); });
            if (advance) await this.advance(id);
            value = await project();
        }
        return value;
    }
    async artifact(id: string, runId: string, artifactId: string, sha256: string, cursor = 0) { const t = await this.task(id); if (!t.executions.includes(runId))
        fail("scope_denied", "This artifact belongs to another task"); return this.core.operateWeb(this.scope(t), "codeflow_get_artifact", { runId, artifactId, sha256, cursor, maxBytes: 24000 }); }
    async sourceFiles(project: string, path: string) { if (!path.startsWith("/"))
        fail("validation_failed", "Choose an absolute repository path"); const repo = await repoRoot(path); await this.authorize(project, repo); const head = await git(["rev-parse", "--verify", "HEAD"], repo), changed = await git(head.code ? ["ls-files", "--cached", "-z"] : ["diff", "--name-only", "HEAD", "-z"], repo), untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], repo); const defaults = await this.core.operateWeb({ project, repo }, "codeflow_list_providers", {}); return { changed: changed.stdout.split("\0").filter(Boolean).slice(0, 200), untracked: untracked.stdout.split("\0").filter(Boolean).slice(0, 200), defaultProvider: defaults.preferredProvider ?? defaults.providers.find((p: any) => p.installed)?.id }; }
    async retainedSourceFiles(id: string) { const t = await this.task(id), runId = t.continuation ?? t.sourceRunId ?? t.executions.at(-1), run = runId ? this.manager.get(runId) : undefined, wt = run?.worktrees.find(w => w.name === "team" || w.name === "solo"); if (!wt || !run)
        return this.sourceFiles(t.project, t.repo); const checkout = await assertWorktree(t.repo, wt), changed = await git(["diff", "--name-only", (run.cliTeam?.source.base ?? run.baseRef), "-z"], checkout), untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], checkout); return { changed: changed.stdout.split("\0").filter(Boolean).slice(0, 200), untracked: untracked.stdout.split("\0").filter(Boolean).slice(0, 200) }; }
    async approach(id: string, proposalId: string, revision: number) { const t = await this.task(id); if (!t.approaches?.some(p => p.id === proposalId && p.revision === revision))
        fail("not_found", "That approach does not belong to this task"); const p = this.core.getWebProposal(this.scope(t), proposalId, revision); return { definition: p.definition, source: p.source, revision: p.revision }; }
    async models(project: string, path: string, provider: "claude" | "codex") { if (!path.startsWith("/"))
        fail("validation_failed", "Choose an absolute repository path"); const repo = await repoRoot(path); await this.authorize(project, repo); if (!["claude", "codex"].includes(provider))
        fail("validation_failed", "Choose Claude or Codex"); return catalog(provider); }
}
export type TaskSnapshot = Awaited<ReturnType<TaskConversations["get"]>>;
