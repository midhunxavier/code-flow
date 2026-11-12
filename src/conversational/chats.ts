import { editableCandidate } from "../cli-teams/editable.js";
import { approvesProposal } from "./proposal-reply.js";
import { assertDiscussionProvider, discussionPattern } from "./discussion.js";
import { EventEmitter } from "node:events";
import { cursorSeq } from "../stream.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Run, RunManager } from "../engine.js";
import type { AgentId } from "../adapters/index.js";
import { getAdapter } from "../adapters/index.js";
import { findPattern } from "../patterns/index.js";
import { digest, fail, type Participant, type Definition } from "../cli-teams/model.js";
import { captureSource } from "../cli-teams/snapshots.js";
import { catalog, resolveParticipant } from "../cli-teams/providers.js";
import { repoRoot, git, assertWorktree } from "../git.js";
import { journalEntry, loadJournal, RUNS_DIR, flushWrites } from "../store.js";
import { chatAttachments, storeChatFiles, loadChatFiles } from "./attachments.js";
import { chatLeadPattern, leadProblem } from "./chat-lead.js";
import { fields, TaskConversations, type TaskSnapshot } from "./service.js";
import { TASK_LIMITS } from "./model.js";
import { captureAgentSource } from "./agent-source.js";
import { CHAT_LEAD_ALLOWANCE, CHAT_OUTCOMES, type ChatRecord, type ChatDefaults, type ChatEvent, type ChatAttachment, type LeadReply, type ProjectChatContext } from "./chat-model.js";

const META = "conversations";
function text(value: unknown, label: string, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("validation_failed", `${label} must contain 1–${max} characters`);
  return value.trim();
}
export function chatDefaults(value: any): ChatDefaults {
  fields(value, ["mode", "provider", "model", "effort", "trust", "tools", "maxCalls", "maxMinutes", "acpExecution"]);
  if (value.acpExecution !== undefined && value.acpExecution !== "native") fail("validation_failed", "Invalid ACP execution mode");
  if (!["agent", "team"].includes(value.mode) || !["safe", "standard", "trusted", "full"].includes(value.trust) || typeof value.tools !== "boolean") fail("validation_failed", "Choose valid mode and permission settings");
  getAdapter(value.provider);
  if (value.mode === "team" && !["claude", "codex"].includes(value.provider)) fail("unsupported_settings", "Team preparation requires Claude or Codex. Other providers remain available in Agent mode.");
  for (const name of ["model", "effort"]) if (value[name] !== undefined && (typeof value[name] !== "string" || value[name].length > (name === "model" ? 160 : 20))) fail("validation_failed", `Invalid ${name}`);
  if (value.maxCalls !== undefined && (!Number.isSafeInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 256) || value.maxMinutes !== undefined && (!Number.isFinite(value.maxMinutes) || value.maxMinutes < 1 || value.maxMinutes > 720)) fail("validation_failed", "Choose an Agent allowance of 1–256 calls and 1–720 minutes");
  return { ...value, maxCalls: value.maxCalls ?? 12, maxMinutes: value.maxMinutes ?? 30, model: value.model || undefined, effort: value.effort || undefined };
}

/** One durable chat can contain ordinary Agent turns and several independently approved tasks. */
export class Conversations {
  private contexts = new Map<string, ProjectChatContext>();
  private records = new Map<string, ChatRecord>();
  private tails = new Map<string, Promise<unknown>>();
  private runOwners = new Map<string, Set<string>>();
  private unfinished = new Set<string>();
  private resultRuns = new Map<string, Set<string>>();
  private indexedEvents = new Map<string, number>();
  private persistedEvents = new Map<string, number>();
  private generation = randomUUID();
  private observations = new Map<string, { hash: string; revision: number }>();
  private closing = false;
  private bus = new EventEmitter().setMaxListeners(0);
  private updateSequence = 0;
  private updates = new Map<string, number[]>();
  private notify(id: string) {
    const seq = ++this.updateSequence;
    for (const topic of [id, "all"]) { const history = this.updates.get(topic) ?? []; history.push(seq); this.updates.set(topic, history.slice(-64)); this.bus.emit(topic, seq); }
  }
  constructor(readonly manager: RunManager, readonly tasks: TaskConversations, readonly authorize: (project: string, repo: string) => Promise<void>, readonly protect: <T>(work: () => Promise<T>) => Promise<T> = work => work()) {}
  private serialized<T>(id: string, work: () => Promise<T>) {
    const next = (this.tails.get(id) ?? Promise.resolve()).then(work), settled = next.catch(() => undefined);
    this.tails.set(id, settled); void settled.finally(() => { if (this.tails.get(id) === settled) this.tails.delete(id); }); return next;
  }
  private index(chat: ChatRecord) {
    const results = this.resultRuns.get(chat.id) ?? new Set<string>();
    for (const e of chat.events.slice(this.indexedEvents.get(chat.id) ?? 0)) if (e.kind === "result" && e.runId) results.add(e.runId);
    this.resultRuns.set(chat.id, results); this.indexedEvents.set(chat.id, chat.events.length);
    const tasks = chat.taskIds.map(id => this.tasks.historySummary(id, chat.project, chat.repo));
    for (const runId of [...chat.agentRuns, ...chat.leadRuns, ...tasks.flatMap(t => t.runIds)]) { const owners = this.runOwners.get(runId) ?? new Set<string>(); owners.add(chat.id); this.runOwners.set(runId, owners); }
    if (tasks.some(t => t.preparing || t.runId && !results.has(t.runId))) this.unfinished.add(chat.id); else this.unfinished.delete(chat.id);
  }
  private async save(chat: ChatRecord) {
    for (const event of chat.events.slice(this.persistedEvents.get(chat.id) ?? 0)) await journalEntry(META, `event:${chat.id}:${event.sequence}`, event);
    chat.version++; chat.updatedAt = Date.now();
    await journalEntry(META, `chat:${chat.id}`, { ...chat, events: [], eventCount: chat.events.length });
    this.persistedEvents.set(chat.id, chat.events.length); this.records.set(chat.id, chat); this.index(chat); this.notify(chat.id);
  }
  private event(chat: ChatRecord, event: Omit<ChatEvent, "sequence" | "at">, at = Date.now()) {
    if (chat.events.some(e => e.id === event.id)) return;
    if (chat.events.length >= 100000) fail("context_limit", "This chat has reached its event limit. Your work is preserved; start a new chat.");
    chat.events.push(JSON.parse(JSON.stringify({ ...event, at, sequence: chat.events.length + 1 })));
  }
  async load() {
    await mkdir(RUNS_DIR, { recursive: true });
    const file = join(RUNS_DIR, `${META}.journal.jsonl`), handle = await open(file, "a", 0o600); await handle.close(); await chmod(file, 0o600);
    const journal = await loadJournal(META, { strict: true });
    const eventsByChat = new Map<string, ChatEvent[]>();
    for (const [key, value] of journal) {
      if (!key.startsWith("event:")) continue;
      const id = key.slice(6, key.lastIndexOf(":")), events = eventsByChat.get(id) ?? [];
      events.push(value as ChatEvent); eventsByChat.set(id, events);
    }
    for (const [key, raw] of journal) {
      if (key.startsWith("context:")) { const c = raw as ProjectChatContext; if (digest(c.project) !== key.slice(8) || !Number.isSafeInteger(c.revision) || !Array.isArray(c.files) || typeof c.instructions !== "string" || !c.receipts) fail("storage_unavailable", "Project context storage needs repair"); this.contexts.set(c.project, c); }
      if (!key.startsWith("chat:")) continue;
      const chat = raw as ChatRecord;
      const count = (raw as ChatRecord & { eventCount?: number }).eventCount;
      if (count !== undefined) chat.events = (eventsByChat.get(chat.id) ?? []).filter(event => event.sequence <= count).sort((a, b) => a.sequence - b.sequence);
      if (chat.id !== key.slice(5) || !Array.isArray(chat.events) || !chat.receipts) fail("storage_unavailable", "Conversation storage needs repair");
      if (count !== undefined && (chat.events.length !== count || chat.events.some((event, i) => event.sequence !== i + 1))) fail("storage_unavailable", "Conversation event storage needs repair");
      this.persistedEvents.set(chat.id, count ?? 0);
      this.records.set(chat.id, chat); this.index(chat);
    }
  }
  /** Continue already-submitted turns while the window is closed; never starts an unaccepted task. */
  watch() {
    const scheduled = new Set<string>();
    let preparation: Promise<void> | undefined;
    const tick = () => {
      for (const chat of this.records.values()) {
        if (scheduled.has(chat.id) || !chat.pending && !this.unfinished.has(chat.id)) continue;
        scheduled.add(chat.id);
        void this.advance(chat.id).catch(() => undefined).finally(() => scheduled.delete(chat.id));
      }
    };
    const off = this.manager.subscribeAll(run => { for (const id of this.runOwners.get(run.id) ?? []) this.notify(id); });
    const offTasks = this.tasks.subscribeChanges(id => { for (const c of this.records.values()) if (c.taskIds.includes(id)) { this.index(c); this.notify(c.id); } });
    const timer = setInterval(() => { if (!preparation) preparation = this.tasks.advancePreparations().catch(() => undefined).finally(() => { preparation = undefined; }); tick(); }, 1000); timer.unref(); tick(); return async () => { this.closing = true; clearInterval(timer); off(); offTasks(); await Promise.allSettled([...this.tails.values(), ...(preparation ? [preparation] : [])]); };
  }
  private async authorizeChat(project: string, repo: string) {
    if (repo) return this.authorize(project, repo);
    if (project && !this.manager.projects?.get(project)) fail("scope_denied", "This project is no longer available");
    await this.manager.assertExecutionAllowed(RUNS_DIR, undefined, "Repository-free discussion");
  }
  private async discussionRepo(chat: ChatRecord) {
    const dir = join(RUNS_DIR, "discussions", chat.id); await mkdir(dir, { recursive: true, mode: 0o700 });
    const init = await git(["-c", "core.hooksPath=/dev/null", "init", "-q", "-b", "main"], dir); if (init.code) fail("storage_unavailable", "Could not prepare the private discussion workspace");
    for (const [key, value] of [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"]]) { const configured = await git(["config", "--local", key!, value!], dir); if (configured.code) fail("storage_unavailable", "Could not disable hooks in the private discussion workspace"); }
    const head = await git(["rev-parse", "--verify", "HEAD"], dir);
    if (head.code) { const commit = await git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Code Flow", "-c", "user.email=discussion@localhost", "commit", "--allow-empty", "-qm", "Empty discussion workspace"], dir); if (commit.code) fail("storage_unavailable", "Could not initialize the private discussion workspace"); }
    return dir;
  }
  private async require(id: string, copy = true): Promise<ChatRecord> {
    const stored = this.records.get(id);
    if (stored) { await this.authorizeChat(stored.project, stored.repo); return copy ? { ...structuredClone({ ...stored, events: [] }), events: [...stored.events] } : stored; }
    if (id.startsWith("task-")) {
      const snapshot = await this.tasks.read(id.slice(5)), task = snapshot.task;
      return { id, version: 0, project: task.project, repo: task.repo, title: task.request.split("\n")[0]!.slice(0, 90), createdAt: task.createdAt, updatedAt: task.updatedAt,
        defaults: { mode: "team", provider: task.coordinator.provider, model: task.coordinator.model, effort: task.coordinator.effort, trust: "standard", tools: false },
        events: [{ id: `legacy-${task.id}`, sequence: 1, at: task.createdAt, kind: "user", body: task.request }, { id: `task-${task.id}`, sequence: 2, at: task.createdAt, kind: "task", taskId: task.id }],
        taskIds: [task.id], activeTask: task.id, agentRuns: [], leadRuns: [], source: task.source, untracked: task.untracked, leadAllowance: { ...CHAT_LEAD_ALLOWANCE }, receipts: {}, createHash: "legacy" };
    }
    fail("not_found", "This chat is unavailable");
  }
  async create(a: any) {
    fields(a, ["operationId", "project", "repo", "defaults", "source", "untracked", "purpose"]);
    if (a.purpose !== undefined && a.purpose !== "automation") fail("validation_failed", "Unsupported chat purpose");
    const operationId = text(a.operationId, "Operation ID", 100), project = a.project ? text(a.project, "Project", 100) : "";
    if (a.repo !== undefined && typeof a.repo !== "string" || a.repo && !a.repo.startsWith("/")) fail("validation_failed", "Choose an absolute repository path");
    const repo = a.repo ? await repoRoot(a.repo) : ""; await this.authorizeChat(project, repo);
    const savedDefaults = this.contexts.get(project)?.defaults;
    const defaults = chatDefaults({ ...a.defaults, trust: a.defaults.trust ?? savedDefaults?.trust ?? "standard", maxCalls: a.defaults.maxCalls ?? savedDefaults?.maxCalls, maxMinutes: a.defaults.maxMinutes ?? savedDefaults?.maxMinutes }), id = digest([project, repo, operationId]).slice(0, 32), hash = digest(a);
    if (a.source !== undefined && !["head", "working_changes"].includes(a.source)) fail("validation_failed", "Choose committed code or working changes");
    if (a.untracked !== undefined && (!Array.isArray(a.untracked) || a.untracked.some((p: unknown) => typeof p !== "string"))) fail("validation_failed", "Choose repository-relative source files");
    if (repo) await captureSource(repo, a.source ?? "working_changes", a.untracked ?? []); else await assertDiscussionProvider(defaults.provider);
    return this.serialized(id, async () => {
      const prior = this.records.get(id);
      if (prior) { if (prior.createHash !== hash) fail("idempotency_conflict", "Creation ID was used with different arguments"); return { id, version: prior.version }; }
      const chat: ChatRecord = { id, purpose: a.purpose, version: 0, project, repo, title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), defaults, events: [], taskIds: [], agentRuns: [], leadRuns: [], source: a.source ?? "working_changes", untracked: a.untracked ?? [], leadAllowance: { ...CHAT_LEAD_ALLOWANCE }, receipts: {}, createHash: hash };
      await this.save(chat); return { id, version: chat.version };
    });
  }
  async cliContext(id: string, repo: string) {
    const chat = await this.require(id);
    if (chat.repo !== repo) fail("scope_denied", "This chat belongs to another repository");
    return { project: chat.project, chatId: chat.id };
  }
  /** Attach durable CLI work to the existing chat timeline without submitting another turn. */
  async syncCliTask(task: import("./model.js").TaskConversation, event?: { id: string; body: string; runId?: string; noteId?: string }) {
    const id = task.chatId!;
    return this.serialized(id, async () => {
      const stored = this.records.get(id);
      if (stored && (stored.project !== task.project || stored.repo !== task.repo)) fail("scope_denied", "Chat workspace identity changed");
      const chat: ChatRecord = stored ? { ...structuredClone({ ...stored, events: [] }), events: [...stored.events] } : {
        id, version: 0, project: task.project, repo: task.repo, title: task.request.split("\n")[0]!.slice(0, 90), createdAt: task.createdAt, updatedAt: task.updatedAt,
        defaults: { mode: "team", provider: task.coordinator.provider, model: task.coordinator.model, effort: task.coordinator.effort, trust: "standard", tools: false },
        events: [], taskIds: [], agentRuns: [], leadRuns: [], leadAllowance: { ...CHAT_LEAD_ALLOWANCE }, source: task.source, untracked: task.untracked, receipts: {}, createHash: digest(["cli", id]),
      };
      const count = chat.events.length;
      if (!chat.taskIds.includes(task.id)) {
        this.event(chat, { id: `cli-request-${task.id}`, kind: "user", body: task.request, mode: "team" });
        this.event(chat, { id: `task-${task.id}`, kind: "task", taskId: task.id });
        chat.taskIds.push(task.id); chat.activeTask = task.id;
      }
      if (event) this.event(chat, { id: event.id, kind: "user", body: event.body, taskId: task.id, runId: event.runId });
      if (count !== chat.events.length || !stored) await this.save(chat); else this.index(chat);
    });
  }
  async projectContext(project: string, repo: string) {
    await this.authorizeChat(project, repo);
    const { receipts: _, ...value } = this.contexts.get(project) ?? { project, revision: 0, instructions: "", files: [], receipts: {} };
    return structuredClone(value);
  }
  async setProjectContext(a: any) {
    fields(a, ["project", "repo", "operationId", "expectedRevision", "instructions", "attachments", "remove", "defaults"]);
    const project = text(a.project, "Project", 100), operationId = text(a.operationId, "Operation ID", 100);
    if (typeof a.repo !== "string") fail("validation_failed", "Choose a project repository");
    await this.authorize(project, a.repo);
    if (typeof a.instructions !== "string" || a.instructions.length > 6000 || a.remove !== undefined && (!Array.isArray(a.remove) || a.remove.some((v: unknown) => typeof v !== "string"))) fail("validation_failed", "Project instructions must contain at most 6,000 characters and file removals must use recorded hashes");
    if (a.defaults !== undefined) {
      fields(a.defaults, ["check", "setup", "maxCalls", "maxMinutes", "trust"]);
      for (const key of ["check", "setup"]) if (a.defaults[key] !== undefined && (typeof a.defaults[key] !== "string" || a.defaults[key].length > 4000)) fail("validation_failed", "Commands must contain at most 4,000 characters");
      if (a.defaults.maxCalls !== undefined && (!Number.isSafeInteger(a.defaults.maxCalls) || a.defaults.maxCalls < 1 || a.defaults.maxCalls > 256) || a.defaults.maxMinutes !== undefined && (!Number.isFinite(a.defaults.maxMinutes) || a.defaults.maxMinutes < 1 || a.defaults.maxMinutes > 720) || a.defaults.trust !== undefined && !["safe", "standard", "trusted", "full"].includes(a.defaults.trust)) fail("validation_failed", "Invalid project execution defaults");
    }
    const hash = digest({ ...a, expectedRevision: undefined });
    return this.serialized(`context:${project}`, () => this.protect(async () => {
      await this.authorize(project, a.repo);
      const old = this.contexts.get(project) ?? { project, revision: 0, instructions: "", files: [], receipts: {}, defaults: undefined };
      if (old.receipts[operationId]) { if (old.receipts[operationId] !== hash) fail("idempotency_conflict", "Context operation ID was used with different arguments"); return this.projectContext(project, a.repo); }
      if (a.expectedRevision !== old.revision) fail("revision_conflict", "Project context changed in another view. Reopen it before saving; your edits are preserved.");
      const added = await storeChatFiles(chatAttachments(a.attachments));
      const files = this.mergeFiles([...old.files.filter(f => !a.remove?.includes(f.sha256) && !added.some(next => next.name === f.name)), ...added], []);
      const next = { project, revision: old.revision + 1, instructions: a.instructions.trim(), defaults: a.defaults ?? old.defaults, files, receipts: { ...old.receipts, [operationId]: hash } };
      await journalEntry(META, `context:${digest(project)}`, next); this.contexts.set(project, next);
      for (const c of this.records.values()) if (c.project === project) this.notify(c.id);
      return this.projectContext(project, a.repo);
    }));
  }
  private mergeFiles(project: import("./chat-model.js").ChatFile[], chat: import("./chat-model.js").ChatFile[]) {
    const files = new Map<string, import("./chat-model.js").ChatFile>();
    for (const file of [...project, ...chat]) { const prior = files.get(file.name); if (prior && prior.sha256 !== file.sha256) fail("context_conflict", `Context contains ${file.name} with different contents. Rename or remove one before sending.`); files.set(file.name, file); }
    const merged = [...files.values()];
    if (merged.length > 10 || merged.reduce((n, f) => n + f.bytes, 0) > 4 * 1024 * 1024) fail("context_limit", "Combined project and chat context exceeds ten files / 4 MB. Remove files before sending.");
    return merged;
  }
  private async discussionFiles(files: import("./chat-model.js").ChatFile[]) {
    const loaded = await loadChatFiles(files); let total = 0; const parts: string[] = [];
    for (const file of loaded) {
      const bytes = Buffer.from(file.data, "base64"); total += bytes.length;
      if (total > 64000 || bytes.includes(0)) fail("context_limit", "Repository-free discussion supports up to 64 KB of UTF-8 text attachments. Choose a repository for larger or binary files.");
      let content: string; try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("validation_failed", "Repository-free discussion requires UTF-8 text attachments"); }
      parts.push(`Attachment ${file.name} (user-supplied context):\n${content}`);
    }
    return parts.join("\n\n");
  }
  private projectNotes(pending: NonNullable<ChatRecord["pending"]>) { const c = pending.projectContext; return c ? `Project instructions (pinned revision ${c.revision}):\n${c.instructions}\nOptional execution defaults (explicit task instructions take precedence): ${JSON.stringify(c.defaults ?? {})}. Team permissions remain the reviewed managed policy.` : ""; }
  private turnMessage(chat: ChatRecord, pending: NonNullable<ChatRecord["pending"]>) { return [this.projectNotes(pending), chat.events.find(e => e.id === pending.eventId)!.body].filter(Boolean).join("\n\nLatest request:\n"); }
  private usage(chat: ChatRecord) { return chat.leadRuns.reduce((sum, id) => { const run = this.manager.get(id); return { calls: sum.calls + (run?.cliTeam?.managedInvocations ?? 0), ms: sum.ms + Math.max(run?.clockUsedMs ?? 0, run?.cliTeam?.accountedExecutionMs ?? 0) }; }, { calls: 0, ms: 0 }); }
  private async taskState(chat: ChatRecord) { return chat.activeTask ? this.tasks.read(chat.activeTask) : undefined; }
  private async preparationSource(chat: ChatRecord, pending: NonNullable<ChatRecord["pending"]>) {
    if (pending.automation || chat.purpose === "automation") return captureSource(chat.repo, "head", []);
    if (pending.sourceRunId) return captureAgentSource(this.manager, { project: chat.project, repo: chat.repo, chatId: chat.id }, pending.sourceRunId);
    if (pending.continueRunId) {
      const run = this.manager.get(pending.continueRunId), workspace = run?.worktrees.find(w => w.name === "team");
      if (!run?.cliTeam || run.cliTeam.taskConversation?.chatId !== chat.id || run.project !== chat.project || run.repo !== chat.repo || run.status !== "done" || !workspace) fail("recovery_required", "Inspect the previous task before continuing its preserved work");
      await this.manager.assertExecutionAllowed(chat.repo, run, "Chat preparation source");
      const source = await captureSource(await assertWorktree(chat.repo, { path: workspace.path }), "working_changes", chat.untracked);
      return { ...source, base: run.cliTeam.source.base };
    }
    return captureSource(chat.repo, chat.source, chat.untracked);
  }
  private async reconcile(chat: ChatRecord) {
    const pending = chat.pending;
    if (pending?.runId && !pending.error) {
      const run = this.manager.get(pending.runId);
      if (!run) fail("recovery_required", "The submitted turn is unavailable. Your message is preserved; cancel this turn before sending it again.");
      if (run && pending.followUp && !run.followUps.some(turn => turn.operationId === `${chat.id}:${pending.operationId}`) && run.status === "done") {
        const source = chat.events.find(e => e.id === pending.eventId)!, defaults = pending.defaults;
        await this.manager.followUp(run.id, { operationId: `${chat.id}:${pending.operationId}`, kind: "reply", worktree: "solo", budget: { maxSteps: defaults.maxCalls ?? 12, maxInvocations: defaults.maxCalls ?? 12, maxMinutes: defaults.maxMinutes ?? 30 }, agent: defaults.provider, message: this.turnMessage(chat, pending), settings: { model: defaults.model, effort: defaults.effort }, trust: defaults.trust, tools: defaults.tools, attachments: await loadChatFiles(pending.files ?? source.attachments) });
        await flushWrites(); return;
      }
      if (run && !["running", "interrupted"].includes(run.status)) {
        const source = chat.events.find(e => e.id === pending.eventId)!;
        if ((pending.mode === "team" || pending.automation) && run.pattern !== discussionPattern.id) {
          if (run.status === "done") {
            const artifact = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "result"), reply = artifact && JSON.parse(artifact.body) as LeadReply;
            if (!reply || leadProblem(reply)) fail("validation_failed", "The lead reply is invalid; inspect the preserved turn");
            let proposedTask: TaskSnapshot | undefined;
            if (pending.automation && reply.kind === "clarify") chat.automationDraft ??= { request: source.body! };
            if (reply.kind === "proposal") {
              const currentSource = await this.preparationSource(chat, pending);
              if (currentSource.fingerprint !== run.cliTeam!.source.fingerprint) fail("snapshot_stale", "Source changed while preparing the approach. Your request and prepared reply are preserved; cancel this turn and prepare again from the current source.");
              const scheduled = pending.automation || chat.purpose === "automation";
              if (scheduled && pending.mode === "agent") this.assertAgentAutomation(reply.candidate!, pending.defaults);
              let taskId = !scheduled && reply.target === "current" ? pending.targetTask ?? chat.activeTask : undefined;
              if (!taskId) {
                const previous = await this.taskState(chat), previousRun = previous?.execution ? this.manager.get(previous.execution.id) : undefined;
                const priorResult = Object.values(previousRun?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1);
                const historyNotes = [...chat.events.filter(e => ["answer", "user"].includes(e.kind) && (e.kind !== "user" || e.sequence <= source.sequence)).slice(-8).map(e => `${e.kind}: ${e.body}`), ...(priorResult ? [`Previous delivered result:\n${priorResult.body}`] : [])].join("\n\n").slice(-2000);
                const contextNotes = [historyNotes, this.projectNotes(pending)].filter(Boolean).join("\n\n");
                const created = await this.tasks.create({ operationId: `chat-${chat.id}-${pending.operationId}`, project: chat.project, repo: chat.repo, request: scheduled && chat.automationDraft ? `${chat.automationDraft.request}\n\n${source.body}` : source.body, source: scheduled ? "head" : chat.source, untracked: scheduled ? [] : chat.untracked,
                  coordinator: { provider: pending.defaults.provider, ...(pending.defaults.model ? { model: pending.defaults.model } : {}), ...(pending.defaults.effort ? { effort: pending.defaults.effort } : {}) }, attachments: await loadChatFiles(pending.files ?? source.attachments) },
                  { chatId: chat.id, contextNotes, ...(pending.sourceRunId ? { sourceRunId: pending.sourceRunId } : {}), ...(pending.continueRunId ? { continueRunId: pending.continueRunId } : {}) });
                taskId = created.id;
              }
              const state = await this.tasks.read(taskId);
              if (state.execution?.status === "running" && (!state.execution.paused || state.execution.pausePending)) {
                await this.tasks.action(taskId, { operationId: `pause-${pending.operationId}`, expectedVersion: state.task.version, action: "pause" });
                this.event(chat, { id: `settling-${pending.operationId}`, kind: "receipt", body: "Pausing the current task before revising its approach. Active assignments are settling; the prepared revision is preserved.", taskId });
                await this.save(chat); return;
              }
              const current = await this.tasks.read(taskId);
              await this.tasks.action(taskId, { operationId: `approach-${pending.operationId}`, expectedVersion: current.task.version, action: "edit", candidate: { ...reply.candidate!, limits: { ...TASK_LIMITS, ...reply.candidate!.limits } } });
              if (!chat.taskIds.includes(taskId)) { chat.taskIds.push(taskId); this.event(chat, { id: `task-${taskId}`, kind: "task", taskId }); }
              if (scheduled) (chat.scheduledTasks ??= {})[taskId] = { mode: pending.mode, provider: pending.defaults.provider, model: pending.defaults.model, effort: pending.defaults.effort };
              if (scheduled) delete chat.automationDraft;
              chat.activeTask = taskId;
              proposedTask = await this.tasks.read(taskId);
            } else if (reply.kind === "guidance" && !pending.automation && (pending.targetTask ?? chat.activeTask)) {
              const taskId = (pending.targetTask ?? chat.activeTask)!, state = await this.tasks.read(taskId);
              if (state.execution?.status === "running") {
                await this.tasks.action(taskId, { operationId: `guidance-${pending.operationId}`, expectedVersion: state.task.version, action: "message", message: source.body });
                this.event(chat, { id: `guidance-${pending.operationId}`, kind: "receipt", body: "Guidance recorded for the next assignment. Delivery and completion are shown in task details.", taskId });
              } else { this.event(chat, { id: `guidance-${pending.operationId}`, kind: "receipt", body: "No active assignment received this guidance. Ask for a revised approach to continue the preserved work.", taskId }); }
            }
            this.event(chat, { id: `answer-${pending.operationId}`, kind: "answer", body: reply.body, taskId: proposedTask?.task.id ?? pending.targetTask, ...(proposedTask?.proposal ? { proposal: { id: proposedTask.proposal.id, revision: proposedTask.proposal.revision, hash: proposedTask.proposal.hash } } : {}), runId: run.id });
          } else this.event(chat, { id: `error-${pending.operationId}`, kind: "error", body: run.error || run.stopReason || "The lead stopped. Your request and completed work are preserved.", runId: run.id, errorKind: run.failure?.kind ?? run.steps.at(-1)?.errorKind });
        } else {
          const answer = run.followUps.at(-1)?.result || run.steps.filter(s => s.kind === "agent").at(-1)?.finalText || run.summary;
          this.event(chat, { id: `answer-${pending.operationId}`, kind: run.status === "done" ? "answer" : "error", body: answer || run.error || run.stopReason || "The turn ended without a readable response.", runId: run.id, errorKind: run.failure?.kind ?? run.steps.at(-1)?.errorKind });
        }
        chat.receipts[pending.operationId]!.complete = true; delete chat.pending;
        if (pending.mode === "agent" && !pending.automation && run.status !== "done" && chat.queue?.length) {
          for (const queued of chat.queue) chat.receipts[queued.operationId]!.complete = true;
          chat.queue = [];
          this.event(chat, { id: `queue-preserved-${pending.operationId}`, kind: "receipt", body: "Queued requests remain in the conversation. Inspect the preserved Agent work, then send the next request explicitly." });
        }
        chat.pending = chat.queue?.shift(); await this.save(chat);
      }
    }
    for (const taskId of chat.taskIds) {
      const metadata = this.tasks.historySummary(taskId, chat.project, chat.repo);
      if (!metadata.runId || metadata.status === "running" || metadata.status === "interrupted" || this.resultRuns.get(chat.id)?.has(metadata.runId)) continue;
      const snapshot = await this.tasks.read(taskId), execution = snapshot.execution;
      if (!execution || execution.status === "running" || execution.status === "interrupted") continue;
      if (this.resultRuns.get(chat.id)?.has(execution.id)) continue;
      const result = Object.values(this.manager.get(execution.id)?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1);
      this.event(chat, { id: `result-${execution.id}`, kind: "result", body: CHAT_OUTCOMES[execution.outcome ?? ""] ?? "Work preserved", taskId, runId: execution.id, evidence: execution.artifacts, artifact: result ? { id: result.id, sha256: result.sha256, kind: "result", data: result.data } : undefined }, this.manager.get(execution.id)?.endedAt);
      await this.save(chat);
    }
  }
  private async dispatch(chat: ChatRecord) {
    if (this.closing) return; // Leave a submitted, undispatched turn available after restart.
    const pending = chat.pending!;
    if (pending.runId) return;
    const event = chat.events.find(e => e.id === pending.eventId)!, state = pending.targetTask ? await this.tasks.read(pending.targetTask) : await this.taskState(chat);
    if (!chat.repo) {
      await assertDiscussionProvider(pending.defaults.provider);
      const participant = await resolveParticipant({ id: "agent", provider: "claude", model: pending.defaults.model, effort: pending.defaults.effort, binding: "managed" }, {}, {});
      const fileContext = await this.discussionFiles(pending.files ?? []);
      const discussionRepo = await this.discussionRepo(chat);
      const history = chat.events.filter(e => e.body && ["answer", "user"].includes(e.kind) && e.sequence < event.sequence).slice(-16).map(e => `${e.kind}: ${e.body}`).join("\n\n").slice(-18000);
      await this.manager.start({ pattern: discussionPattern, unscopedDiscussion: true, conversationId: chat.id, repo: discussionRepo, task: `${history}\n\n${fileContext}\n\n${this.turnMessage(chat, pending)}`, roles: { agent: ["claude"] }, agentSettings: { claude: { model: participant.model, effort: participant.effort } }, options: {}, trust: "safe", permissionRequirements: ["no-external-tools"], approvals: { tools: false }, loop: { maxSteps: 1, maxInvocations: 1, maxMinutes: Math.min(5, pending.defaults.maxMinutes ?? 5) }, context: { attachments: await loadChatFiles(pending.files) }, beforeDispatch: async run => { await flushWrites(); pending.runId = run.id; chat.agentRuns.push(run.id); await this.save(chat); } });
      return;
    }
    if (pending.mode === "agent" && !pending.automation) {
      const writer = await this.taskState(chat);
      if (chat.taskIds.some(id => { const task = this.tasks.historySummary(id, chat.project, chat.repo), run = task.runId ? this.manager.get(task.runId) : undefined; return task.scope === "write" && task.status === "running" && (!run?.pauseRequested || run.steps.some(step => step.status === "running")); })) return;
      const prior = chat.agentRuns.at(-1), run = prior ? this.manager.get(prior) : undefined, defaults = pending.defaults;
      if (run?.status === "running") return;
      const latestTaskRun = writer?.execution ? this.manager.get(writer.execution.id) : undefined;
      if (run && (!latestTaskRun || latestTaskRun.createdAt < run.createdAt) && run.pattern === "solo" && run.repo === chat.repo && run.roles.agent?.[0] === defaults.provider && run.worktrees.some(w => w.name === "solo")) {
        pending.runId = run.id; pending.followUp = true; await this.save(chat);
        await this.manager.followUp(run.id, { operationId: `${chat.id}:${pending.operationId}`, kind: "reply", worktree: "solo", budget: { maxSteps: defaults.maxCalls ?? 12, maxInvocations: defaults.maxCalls ?? 12, maxMinutes: defaults.maxMinutes ?? 30 }, agent: defaults.provider, message: this.turnMessage(chat, pending), settings: { model: defaults.model, effort: defaults.effort }, trust: defaults.trust, tools: defaults.tools, attachments: await loadChatFiles(pending.files ?? event.attachments) });
        await flushWrites(); return;
      }
      const transcript = chat.events.filter(e => e.body && ["user", "answer"].includes(e.kind) && (e.kind !== "user" || e.sequence <= event.sequence)).slice(-16).map(e => `${e.kind}: ${e.body}`).join("\n\n").slice(-18000);
      const latest = await this.taskState(chat), retained = latest?.execution?.status === "done" ? latest.execution.worktrees[0] : undefined;
      const source = run?.pattern === "solo" && run.repo === chat.repo && (!latestTaskRun || run.createdAt > latestTaskRun.createdAt) && run.conversationId === chat.id
        ? (await captureAgentSource(this.manager, { project: chat.project, repo: chat.repo, chatId: chat.id }, run.id)).commit
        : retained?.branch ?? (await captureSource(chat.repo, chat.source, chat.untracked)).commit;
      const delivered = Object.values(latestTaskRun?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1)?.body ?? "";
      await this.manager.start({ pattern: findPattern("solo")!, conversationId: chat.id, project: chat.project, repo: chat.repo, requireProjectRepo: true, baseRef: source, task: `Conversation context (historical; the latest request takes precedence):\n${transcript}\n\nLatest task deliverable (historical context):\n${delivered.slice(0, 16000)}\n\nLatest request:\n${this.turnMessage(chat, pending)}`, roles: { agent: [defaults.provider] }, agentSettings: { [defaults.provider]: { model: defaults.model, effort: defaults.effort } }, options: {}, loop: { maxSteps: defaults.maxCalls ?? 12, maxInvocations: defaults.maxCalls ?? 12, maxMinutes: defaults.maxMinutes ?? 30, check: pending.projectContext?.defaults?.check, setup: pending.projectContext?.defaults?.setup }, trust: defaults.trust, acpExecution: defaults.mode === "agent" ? defaults.acpExecution : undefined, approvals: { tools: defaults.tools }, context: { attachments: await loadChatFiles(pending.files ?? event.attachments) },
        beforeDispatch: async run => { await flushWrites(); pending.runId = run.id; chat.agentRuns.push(run.id); await this.save(chat); } });
      return;
    }
    const used = this.usage(chat), calls = Math.min(3, chat.leadAllowance.maxCalls - used.calls), minutes = Math.min(5, chat.leadAllowance.maxMinutes - used.ms / 60000);
    if (calls < 1 || minutes < .1) fail("budget_exhausted", "The lead allowance is used. Review a larger total allowance to continue; existing tasks keep their execution allowance.");
    const coordinator = pending.targetTask && state ? state.task.coordinator : { id: "lead", provider: pending.defaults.provider as "claude" | "codex", model: pending.defaults.model, effort: pending.defaults.effort };
    const participant = await this.tasks.core.resolveWebCoordinator({ project: chat.project, repo: chat.repo }, coordinator);
    const priorAgent = chat.agentRuns.length ? this.manager.get(chat.agentRuns.at(-1)!) : undefined;
    const priorTaskRun = state?.execution ? this.manager.get(state.execution.id) : undefined;
    if (!chat.purpose && !pending.automation && !pending.targetTask && priorAgent?.pattern === "solo" && priorAgent.repo === chat.repo && priorAgent.status === "done" && (!priorTaskRun || priorAgent.createdAt > priorTaskRun.createdAt)) pending.sourceRunId = priorAgent.id;
    else if (!chat.purpose && !pending.automation && !pending.targetTask && priorTaskRun?.status === "done" && priorTaskRun.cliTeam?.taskConversation?.chatId === chat.id) pending.continueRunId = priorTaskRun.id;
    const source = await this.preparationSource(chat, pending);
    const discovery = await this.tasks.core.operateWeb({ project: chat.project, repo: chat.repo }, "codeflow_list_providers", {});
    const inventory = await Promise.all(discovery.providers.filter((p: any) => p.installed).map(async (p: any) => ({ provider: p.id, ...await catalog(p.id).catch(() => ({})) })));
    const skill = await (await import("node:fs/promises")).readFile(new URL("../../integrations/cli-teams/GUIDE.md", import.meta.url), "utf8");
    const files = await git(["ls-tree", "-r", "--name-only", source.commit], chat.repo), pkg = await git(["show", `${source.commit}:package.json`], chat.repo);
    const currentRun = state?.execution ? this.manager.get(state.execution.id) : undefined, result = Object.values(currentRun?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1);
    const prompt = `${this.projectNotes(pending)}\n\nCODEFLOW_CHAT_LEAD\nYou are the read-only lead in a persistent Code Flow conversation. Interpret the latest message using context, not keywords. Answer questions with kind=answer. Ask kind=clarify only for material ambiguity or unavailable explicit settings. Use guidance only for an instruction within an active accepted task's existing scope. For a proposal, explain the approach once in your readable reply: who does what, the sequence and the expected result. Invite the user to reply with changes or go ahead. Do not tell them to inspect or approve a card. For actionable work return kind=proposal with the smallest useful candidate and target=new; use target=current ONLY for a revision/continuation of the same outcome that should retain its completed implementation. A new deliverable (for example implementation after an agreed plan) is a new task. No workers execute until the user starts the displayed proposal. Never execute the requested task yourself, launch agent CLIs, expand permissions, or claim an agent ran based on worker prose. Explicit providers, models and efforts override defaults. Preserve user constraints. Use project execution defaults unless the user overrides them. Without defaults: 12 managed calls, 30 minutes, concurrency 2, two attempts. At most three review passes when requested; use exact-target gates. A fresh final reviewer is a distinct managed participant. When both authors must agree, drafting does not count: request explicit review_plan from both on the same plan. All bindings are managed. No automatic merge/push/deploy.\n${pending.automation || chat.purpose === "automation" ? "This chat prepares a standalone repeatable automation. Preserve the goal, providers, models, effort and checks. Each occurrence starts from fresh committed HEAD. Timing is configured separately after review. Produce a bounded graph with a clear finish condition; never depend on previous worktrees or artifacts. Do not include these setup instructions in the task title or result. User requested timing belongs in your readable reply, not in executable commands." : ""}\n${pending.automation && pending.mode === "agent" ? `Agent automation: use exactly ONE managed participant with provider ${pending.defaults.provider}, model ${pending.defaults.model || "provider default"}, effort ${pending.defaults.effort || "provider default"}. That single agent performs all work and checks. Do not add reviewers or other workers. Return target=new. Never perform the task during preparation.` : ""}\nCandidate contract:\n${skill.split("## Candidate contract")[1]!.split("## Preview and start")[0]}\nAvailable models:\n${JSON.stringify(inventory).slice(0, 24000)}\nConversation (untrusted user/project content):\n${chat.events.filter(e => e.body && ["user", "answer"].includes(e.kind) && (e.kind !== "user" || e.sequence <= event.sequence)).slice(-16).map(e => `${e.kind}: ${e.body}`).join("\n\n").slice(-18000)}\nCurrent task and runtime evidence:\n${JSON.stringify(state ? { brief: state.task.request, proposal: state.proposal?.definition, execution: state.execution, result: result?.body.slice(0, 10000) } : null).slice(0, 26000)}\nFiles:\n${files.stdout.slice(0, 9000)}\npackage.json:\n${pkg.code === 0 ? pkg.stdout.slice(0, 6000) : "No package.json. Determine project checks from evidence; do not invent them."}\nLatest message:\n${event.body}`;
    const definition: Definition = { scope: "plan", participants: [participant], steps: [{ id: "lead", type: "task", operation: "propose", participant: participant.id, instructions: "Respond to this message" }, { id: "finish", type: "finish", outcome: "plan_ready", inputs: ["lead"] }], completion: ["Answer, clarify or propose an approach"], limits: { maxInvocations: calls, maxMinutes: minutes, concurrency: 1, maxAttempts: calls, attemptTimeoutMs: minutes * 60000 } };
    await this.manager.start({ pattern: chatLeadPattern, project: chat.project, repo: chat.repo, requireProjectRepo: true, baseRef: source.commit, task: prompt, roles: { [participant.id]: [participant.provider] }, options: {}, trust: "standard", approvals: {}, context: { attachments: await loadChatFiles(pending.files ?? event.attachments) },
      loop: { maxSteps: calls, maxInvocations: calls, maxMinutes: minutes, setup: "", check: "", copy: [] }, cliTeam: { version: 1, taskConversation: { id: chat.id, phase: "preparation" }, proposalId: `lead-${pending.operationId}`, proposalHash: digest(prompt), definition, source, hostConnection: "", artifacts: {}, pending: {}, questions: {} },
      beforeDispatch: async run => { await flushWrites(); pending.runId = run.id; chat.leadRuns.push(run.id); await this.save(chat); } });
  }
  private assertAgentAutomation(candidate: import("../cli-teams/model.js").Candidate, defaults: Pick<ChatDefaults, "provider" | "model" | "effort">) {
    const participant = candidate.participants[0];
    if (candidate.participants.length !== 1 || participant?.provider !== defaults.provider ||
      defaults.model && participant.model !== defaults.model || defaults.effort && participant.effort !== defaults.effort)
      fail("validation_failed", "Agent automation must use exactly the selected provider, model and effort. Ask for a corrected single-agent approach or choose Team.");
  }
  /** Freeze the reviewed graph; scheduling never asks a lead to invent a different team. */
  async automationRecipe(id: string, taskId: string, hash: string) {
    const chat = await this.require(id);
    if (!chat.taskIds.includes(taskId)) fail("scope_denied", "Choose a task from this chat");
    const task = await this.tasks.read(taskId), p = task.proposal ? this.tasks.core.getWebProposal({ repo: chat.repo, project: chat.project, taskId, chatId: id }, task.proposal.id) : undefined;
    if (!p || p.hash !== hash || task.task.preparation.active) fail("acceptance_stale", "Review the current approach before automating it");
    if (p.context.continueRunId || p.context.sourceRunId || p.context.artifacts?.length) fail("validation_failed", "This approach depends on a previous execution. Ask for a standalone repeatable approach first.");
    const selected = chat.scheduledTasks?.[taskId];
    if (selected?.mode === "agent") this.assertAgentAutomation(editableCandidate(p.definition), selected);
    const candidate = { ...editableCandidate(p.definition), source: "head" as const }, limits = p.definition.limits;
    return { repo: chat.repo, project: chat.project, pattern: "cli-team", task: p.task, roles: Object.fromEntries(candidate.participants.map(p => [p.id, [p.provider]])), loop: { maxInvocations: limits.maxInvocations, maxMinutes: limits.maxMinutes, check: candidate.check, setup: candidate.setup }, chatRecipe: { chatId: id, candidate, notes: p.context.notes, attachments: p.context.attachments, proposalHash: hash, mode: selected?.mode ?? "team" } };
  }
  /** Called only by the saved automation dispatcher, after the user authorizes this recipe. */
  async startAutomation(body: any, trigger: NonNullable<Run["trigger"]>, occurrence: string, untrustedText = false) {
    const recipe = body.chatRecipe;
    return this.serialized(recipe.chatId, () => this.protect(async () => {
      const chat = await this.require(recipe.chatId);
      if (chat.repo !== body.repo || chat.project !== body.project) fail("scope_denied", "Automation source no longer belongs to its chat");
      const op = digest([trigger.id, occurrence]);
      const first = recipe.candidate.participants[0];
      const created = await this.tasks.create({ operationId: op, project: chat.project, repo: chat.repo, request: body.task, source: "head", coordinator: JSON.parse(JSON.stringify({ provider: first.provider, model: first.model, effort: first.effort })), attachments: recipe.attachments }, { chatId: chat.id, contextNotes: recipe.notes });
      (chat.scheduledTasks ??= {})[created.id] = { mode: recipe.mode ?? "team", provider: first.provider, model: first.model, effort: first.effort };
      if (!chat.taskIds.includes(created.id)) { chat.taskIds.push(created.id); if (!chat.pending) chat.activeTask = created.id; this.event(chat, { id: `task-${created.id}`, kind: "task", taskId: created.id }); await this.save(chat); }
      let task = await this.tasks.read(created.id);
      if (!task.proposal) { await this.tasks.action(created.id, { action: "edit", operationId: `${op}:prepare`, expectedVersion: task.task.version, candidate: recipe.candidate }); task = await this.tasks.read(created.id); }
      const p = task.proposal!;
      await this.tasks.action(created.id, { action: "start", operationId: `${op}:start`, expectedVersion: task.task.version, proposalId: p.id, revision: p.revision, hash: p.hash }, trigger, untrustedText || !!body.source);
      task = await this.tasks.read(created.id);
      this.index(chat); this.notify(chat.id);
      return this.manager.get(task.execution!.id)!;
    }));
  }
  private async assertStartAvailable(chat: ChatRecord, taskId: string) {
    const target = await this.tasks.read(taskId);
    if (target.proposal?.definition.scope !== "write") return;
    const otherWriter = await Promise.all(chat.taskIds.filter(id => id !== taskId).map(id => this.tasks.read(id)));
    if (otherWriter.some(t => t.proposal?.definition.scope === "write" && t.execution?.status === "running" && (!t.execution.paused || t.execution.pausePending)) || chat.agentRuns.some(id => this.manager.get(id)?.status === "running")) fail("conflict", "Pause the current writer and wait for it to settle before starting another writing task in this chat");
  }
  async action(id: string, a: any) {
    const allowed: Record<string, string[]> = { send: ["message", "attachments", "targetTask", "automation", "approval"], defaults: ["defaults"], control: ["control"], allowance: ["maxCalls", "maxMinutes"], task: ["taskId", "input"], remove_file: ["sha256"], cancel_message: ["messageId"], organize: ["title", "pinned", "archived"], repository: ["project", "repo", "source", "untracked"] };
    if (!a || !Object.hasOwn(allowed, a.action)) fail("validation_failed", "Unknown chat action");
    fields(a, ["operationId", "expectedVersion", "action", ...allowed[a.action]!]);
    const operationId = text(a.operationId, "Operation ID", 100), hash = digest({ ...a, expectedVersion: undefined, ...(a.action === "task" ? { input: { ...a.input, expectedVersion: undefined } } : {}) });
    return this.serialized(id, () => this.protect(async () => {
      const chat = await this.require(id), previous = chat.receipts[operationId];
      if (previous && previous.hash !== hash && previous.hash !== digest(a)) fail("idempotency_conflict", "Operation ID was used with different arguments");
      if (previous?.complete) return { id, version: chat.version };
      if (!previous && chat.version !== a.expectedVersion) fail("revision_conflict", "This chat changed in another view. Refresh; your draft is preserved.");
      if (!previous) { chat.receipts[operationId] = { hash }; await this.save(chat); }
      if (a.action === "organize") {
        if (id.startsWith("task-")) fail("validation_failed", "Legacy task history is managed in its original workflow");
        if (a.title !== undefined) chat.title = text(a.title, "Chat title", 90);
        for (const key of ["pinned", "archived"] as const) if (a[key] !== undefined) { if (typeof a[key] !== "boolean") fail("validation_failed", `Invalid ${key}`); chat[key] = a[key]; }
      } else if (a.action === "repository") {
        if (chat.repo || chat.pending || chat.taskIds.length || chat.queue?.length) fail("conflict", "Attach a repository after the current discussion settles. Existing task sources stay pinned.");
        const project = text(a.project, "Project", 100), selected = text(a.repo, "Repository", 2000);
        if (chat.project && chat.project !== project) fail("scope_denied", "Choose a repository in this chat's project");
        const repo = await repoRoot(selected); await this.authorize(project, repo);
        if (!["head", "working_changes"].includes(a.source) || !Array.isArray(a.untracked) || a.untracked.some((p: unknown) => typeof p !== "string")) fail("validation_failed", "Choose a valid source");
        await captureSource(repo, a.source, a.untracked); chat.project = project; chat.repo = repo; chat.source = a.source; chat.untracked = a.untracked;
        this.event(chat, { id: operationId, kind: "receipt", body: "Repository attached. Future approaches can inspect this source; discussion history is retained." });
      } else if (a.action === "defaults") chat.defaults = chatDefaults(a.defaults);
      else if (a.action === "allowance") {
        if (!Number.isSafeInteger(a.maxCalls) || a.maxCalls < chat.leadAllowance.maxCalls || a.maxCalls > 100 || !Number.isFinite(a.maxMinutes) || a.maxMinutes < chat.leadAllowance.maxMinutes || a.maxMinutes > 240 || chat.pending?.runId) fail("validation_failed", "Wait for the lead to settle, then choose a larger total allowance up to 100 calls / 240 minutes");
        chat.leadAllowance = { maxCalls: a.maxCalls, maxMinutes: a.maxMinutes };
        if (chat.pending && !chat.pending.runId) { delete chat.pending.error; delete chat.pending.errorCode; }
        this.event(chat, { id: operationId, kind: "receipt", body: `Lead allowance changed to ${a.maxCalls} total calls / ${a.maxMinutes} total minutes.` });
      } else if (a.action === "cancel_message") {
        const queued = chat.queue?.find(pending => pending.eventId === a.messageId);
        if (!queued) fail("conflict", "This message is no longer queued");
        chat.queue = chat.queue!.filter(pending => pending !== queued);
        chat.receipts[queued.operationId]!.complete = true;
        this.event(chat, { id: operationId, kind: "receipt", body: "Queued message cancelled. Its text remains in this chat." });
      } else if (a.action === "remove_file") {
        if (chat.pending) fail("conflict", "Wait for the current turn before changing its context");
        chat.files = (chat.files ?? []).filter(file => file.sha256 !== a.sha256);
        this.event(chat, { id: operationId, kind: "receipt", body: "File removed from future chat context. Accepted tasks keep their pinned attachments." });
      } else if (a.action === "task") {
        if (!chat.taskIds.includes(a.taskId)) fail("scope_denied", "This task belongs to another chat");
        if (a.input?.action === "start") await this.assertStartAvailable(chat, a.taskId);
        await this.tasks.action(a.taskId, { ...a.input, operationId: `chat-${operationId}` });
        this.event(chat, { id: operationId, kind: "receipt", taskId: a.taskId, body: a.input.action === "start" ? "Started the reviewed approach. Its scope, participants, settings and allowance are fixed for this execution." : `Task ${a.input.action} requested.` });
      } else if (a.action === "send" && a.approval !== undefined) {
        fields(a.approval, ["taskId", "proposalId", "revision", "hash"]);
        const body = text(a.message, "Message"), approval = a.approval;
        if (!approvesProposal(body) || chatAttachments(a.attachments).length || a.automation) fail("validation_failed", "Send changes or new context as a message before approving the approach.");
        if (chat.pending || chat.queue?.length) fail("conflict", "Wait for the current reply before approving an approach.");
        if (approval.taskId !== chat.activeTask || !chat.taskIds.includes(approval.taskId) || a.targetTask && a.targetTask !== approval.taskId) fail("scope_denied", "Approve the current task in this chat.");
        if (chat.scheduledTasks?.[approval.taskId]) fail("validation_failed", "Review the timing and enable this automation in its schedule setup.");
        const target = await this.tasks.read(approval.taskId), proposal = target.proposal;
        if (!proposal || proposal.id !== approval.proposalId || proposal.revision !== approval.revision || proposal.hash !== approval.hash || target.task.preparation.active || proposal.runId && !previous) fail("acceptance_stale", "The approach changed or already started. Review the current proposal before approving it.");
        if (!approvesProposal(body, proposal.definition.scope)) fail("validation_failed", "Describe the requested scope change in chat before approving the approach.");
        await this.assertStartAvailable(chat, approval.taskId);
        this.event(chat, { id: operationId, kind: "user", body, taskId: approval.taskId, mode: "team" });
        await this.save(chat);
        await this.tasks.action(approval.taskId, { action: "start", operationId: `chat-${operationId}`, expectedVersion: target.task.version, proposalId: proposal.id, revision: proposal.revision, hash: proposal.hash });
        this.event(chat, { id: `started-${operationId}`, kind: "receipt", taskId: approval.taskId, body: "Started the reviewed approach." });
      } else if (a.action === "control") {
        if (!["pause", "resume", "cancel"].includes(a.control) || !chat.pending) fail("conflict", "No conversation turn is available for this control");
        const pending = chat.pending, run = pending.runId ? this.manager.get(pending.runId) : undefined;
        if (a.control === "cancel") {
          if (run?.status === "running") this.manager.cancel(run.id);
          else {
            chat.receipts[pending.operationId]!.complete = true;
            if (run && pending.mode === "agent" && !pending.automation) { for (const item of chat.queue ?? []) chat.receipts[item.operationId]!.complete = true; chat.queue = []; }
            chat.pending = chat.queue?.shift();
          }
        }
        else if (run?.status === "running") this.manager.setPaused(run.id, a.control === "pause");
        else if (a.control === "resume" && run?.status === "interrupted" && (pending.mode === "team" || pending.automation)) await this.manager.resume(run.id, undefined, true);
        else fail("recovery_required", "Inspect the preserved conversation turn before continuing an interrupted writer");
      } else {
        if (chat.queue?.some(pending => pending.operationId === operationId)) return { id, version: chat.version };
        if (chat.pending?.operationId !== operationId) {
          if (chat.events.length >= 99000) fail("context_limit", "This chat is near its event limit. Start another chat; submitted work and results remain preserved.");
          if ((chat.queue?.length ?? 0) >= 20) fail("context_limit", "Twenty messages are queued. Wait for a turn to finish; your draft is preserved.");
          if (a.automation !== undefined && typeof a.automation !== "boolean") fail("validation_failed", "Choose a valid scheduling option");
          const automation = a.automation ?? !!chat.automationDraft;
          if (automation && (!chat.repo || !chat.project || a.targetTask)) fail("validation_failed", "Choose a project and repository and prepare a new standalone task to schedule.");
          if (automation && !["claude", "codex"].includes(chat.defaults.provider)) fail("unsupported_settings", "Scheduled Agent and Team tasks currently require Claude or Codex.");
          if (!automation) delete chat.automationDraft;
          chat.archived = false;
          const body = text(a.message, "Message"), attachments = await storeChatFiles(chatAttachments(a.attachments));
          if (!chat.repo) await assertDiscussionProvider(chat.defaults.provider);
          const context = await this.projectContext(chat.project, chat.repo);
          const files = [...(chat.files ?? []).filter(file => !attachments.some(next => next.name === file.name)), ...attachments];
          if (files.length > 10 || files.reduce((sum, file) => sum + file.bytes, 0) > 4 * 1024 * 1024) fail("context_limit", "Chat files exceed ten files / 4 MB. Remove older files in Task details or start a new chat.");
          const mergedFiles = this.mergeFiles(context.files, files);
          if (!chat.repo) await this.discussionFiles(mergedFiles);
          chat.files = files;
          if (a.targetTask != null && !chat.taskIds.includes(a.targetTask)) fail("scope_denied", "This task belongs to another chat");
          this.event(chat, { id: operationId, kind: "user", body, mode: chat.defaults.mode, projectContext: { revision: context.revision, files: context.files }, attachments });
          if (chat.title === "New chat") chat.title = body.split("\n")[0]!.slice(0, 90);
          const pending = { ...(automation ? { automation: true as const } : {}), operationId, eventId: operationId, mode: (a.targetTask || chat.defaults.mode === "team" ? "team" : "agent") as "team" | "agent", defaults: { ...chat.defaults }, files: structuredClone(mergedFiles), projectContext: { revision: context.revision, instructions: context.instructions, defaults: context.defaults, files: context.files }, targetTask: a.targetTask || undefined };
          if (chat.pending) {
            (chat.queue ??= []).push(pending);
            this.event(chat, { id: `queued-${operationId}`, kind: "receipt", body: "Message queued for the next turn with its selected settings." });
            await this.save(chat); return { id, version: chat.version };
          }
          chat.pending = pending;
          await this.save(chat);
        }
        await this.dispatch(chat);
        await this.save(chat); return { id, version: chat.version };
      }
      chat.receipts[operationId]!.complete = true; await this.save(chat); return { id, version: chat.version };
    }));
  }
  async advance(id: string) {
    return this.serialized(id, () => this.protect(async () => {
      const chat = await this.require(id);
      try { await this.reconcile(chat); if (chat.pending && !chat.pending.runId && !chat.pending.error) await this.dispatch(chat); }
      catch (error) {
        const eventId = `pending-error-${chat.pending?.operationId ?? randomUUID()}`;
        const changed = chat.pending?.error !== (error as Error).message;
        if (chat.pending) { chat.pending.error = (error as Error).message; chat.pending.errorCode = (error as { code?: string }).code; }
        const missing = !chat.events.some(event => event.id === eventId);
        if (missing) this.event(chat, { id: eventId, kind: "error", body: (error as Error).message, errorKind: (error as { code?: string }).code, runId: chat.pending?.runId });
        if (changed || missing) await this.save(chat);
      }
    }));
  }
  /** Reading history never starts a CLI, consumes allowance or changes a durable record. */
  async get(id: string, page: { before?: number; limit?: number } = {}) {
    return this.serialized(id, () => this.protect(async () => {
      const chat = await this.require(id, false);
      const limit = page.limit ?? 50, before = page.before ?? chat.events.length + 1;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) fail("validation_failed", "Choose a history page of 1–100 messages and a valid sequence");
      const end = Math.min(chat.events.length, before - 1), start = Math.max(0, end - limit);
      const events = structuredClone(chat.events.slice(start, end));
      const visibleTasks = [...new Set([...chat.taskIds.slice(-12), ...events.flatMap(e => e.taskId ? [e.taskId] : []), ...(chat.activeTask ? [chat.activeTask] : [])])];
      const tasks = await Promise.all(visibleTasks.map(id => this.tasks.read(id))), { receipts: _, createHash: __, ...safe } = chat;
      const pendingRun = chat.pending?.runId ? this.manager.get(chat.pending.runId) : undefined;
      const snapshot = { chat: structuredClone({ ...safe, events }), projectContext: await this.projectContext(chat.project, chat.repo), history: { total: chat.events.length, hasOlder: start > 0, before: events[0]?.sequence ?? before, lastSequence: chat.events.length }, tasks, leadUsage: this.usage(chat),
        turn: chat.pending ? { mode: chat.pending.mode, queued: !chat.pending.runId, runId: pendingRun?.id, status: pendingRun?.status, error: chat.pending.error ?? pendingRun?.error, errorCode: chat.pending.errorCode, paused: !!pendingRun?.pauseRequested } : undefined };
      const hash = digest(snapshot), prior = this.observations.get(id), observation = prior?.hash === hash ? prior.revision : (prior?.revision ?? 0) + 1;
      this.observations.set(id, { hash, revision: observation });
      return { ...snapshot, generation: this.generation, observation, cursor: `${this.generation}:${hash}` };
    }));
  }
  async subscribe(name: string, after: string | undefined, deliver: (data: unknown) => void) {
    const check = async () => { if (name === "all") await this.list(""); else await this.require(name, false); };
    await check();
    let stopped = false, draining = false, latest = this.updateSequence;
    const drain = async () => {
      if (draining || stopped) return; draining = true;
      try { do { const seq = latest; await check(); if (stopped) break; deliver({ type: "changed", cursor: `${this.generation}:${seq}` }); if (latest === seq) break; } while (!stopped); }
      catch { if (!stopped) deliver({ type: "error", status: 403, message: "Chat access changed. Refresh project access." }); stop(); }
      finally { draining = false; }
    };
    const listener = (seq: number) => { latest = seq; void drain(); };
    const stop = () => { stopped = true; this.bus.off(name, listener); };
    this.bus.on(name, listener);
    const seq = cursorSeq(after, this.generation), history = this.updates.get(name) ?? [];
    const replay = seq !== undefined && seq <= this.updateSequence && (!history.length || seq >= history[0]! - 1);
    deliver({ type: "hello", reset: !replay, cursor: `${this.generation}:${this.updateSequence}` });
    if (!replay || history.some(n => n > seq!)) listener(this.updateSequence);
    return stop;
  }
  async list(project: string, query: { q?: string; archived?: boolean } = {}) {
    const out: { id: string; title: string; project: string; updatedAt: number; status: string; runIds: string[]; pinned?: boolean; archived?: boolean; match?: { sequence: number; snippet: string } }[] = [], owned = new Set<string>();
    for (const chat of this.records.values()) {
      if (project && project !== chat.project) continue;
      try {
        await this.authorizeChat(chat.project, chat.repo);
        chat.taskIds.forEach(id => owned.add(id));
        if (!!chat.archived !== !!query.archived) continue;
        const q = (query.q ?? "").trim().toLowerCase().slice(0, 200);
        const found = q ? chat.events.find(e => ["user", "answer", "result"].includes(e.kind) && e.body?.toLowerCase().includes(q)) : undefined;
        if (q && !chat.title.toLowerCase().includes(q) && !found) continue;
        const offset = found?.body?.toLowerCase().indexOf(q) ?? 0;
        const match = found ? { sequence: found.sequence, snippet: found.body!.slice(Math.max(0, offset - 40), offset + 150) } : undefined;
        const taskStates = chat.taskIds.map(id => this.tasks.historySummary(id, chat.project, chat.repo)), active = taskStates.find(t => t.status === "running" || t.preparing), latest = taskStates.at(-1);
        const pendingRun = chat.pending?.runId ? this.manager.get(chat.pending.runId) : undefined;
        const agent = chat.agentRuns.length ? this.manager.get(chat.agentRuns.at(-1)!) : undefined;
        const agentNeedsAttention = agent && agent.status !== "done" && (!latest || agent.createdAt > latest.updatedAt);
        const status = chat.pending?.error || pendingRun?.status === "interrupted" ? "Needs attention"
          : chat.pending ? pendingRun?.status === "failed" ? "Needs attention" : pendingRun?.pauseRequested ? "Paused" : "Responding"
          : active ? active.view.label
          : latest?.ready ? latest.view.label
          : agentNeedsAttention ? "Needs attention"
          : latest ? latest.view.label : "Chat";
        out.push({ id: chat.id, title: chat.title, project: chat.project, pinned: chat.pinned, archived: chat.archived, match, updatedAt: Math.max(chat.updatedAt, ...taskStates.map(t => t.updatedAt)), status, runIds: [...chat.agentRuns, ...chat.leadRuns, ...taskStates.flatMap(t => t.runIds)] });
      } catch { /* A removed membership cannot reveal another project's history. */ }
    }
    const projects = project ? [project] : this.manager.projects?.list().map(p => p.id) ?? [];
    for (const projectId of projects) for (const task of await this.tasks.list(projectId)) {
      if (query.archived || query.q && !task.request.toLowerCase().includes(query.q.trim().toLowerCase()) || owned.has(task.id) || task.chatId && this.records.has(task.chatId)) continue;
      const state = await this.tasks.read(task.id);
      out.push({ id: `task-${task.id}`, title: task.request, project: projectId, updatedAt: task.updatedAt, status: state.view.label, runIds: [...state.task.executions, ...state.task.preparation.runs] });
    }
    return out.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  }
}
export type ChatSnapshot = Awaited<ReturnType<Conversations["get"]>>;
export type ChatSummary = Awaited<ReturnType<Conversations["list"]>>[number];
