import { randomUUID } from "node:crypto";
import { mkdir, open, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Run, RunManager } from "../engine.js";
import type { AgentId } from "../adapters/index.js";
import { getAdapter } from "../adapters/index.js";
import { findPattern } from "../patterns/index.js";
import { digest, fail, type Participant, type Definition } from "../cli-teams/model.js";
import { captureSource } from "../cli-teams/snapshots.js";
import { catalog } from "../cli-teams/providers.js";
import { repoRoot, git, assertWorktree } from "../git.js";
import { journalEntry, loadJournal, RUNS_DIR, flushWrites } from "../store.js";
import { chatAttachments, storeChatFiles, loadChatFiles } from "./attachments.js";
import { chatLeadPattern, leadProblem } from "./chat-lead.js";
import { fields, TaskConversations, type TaskSnapshot } from "./service.js";
import { TASK_LIMITS } from "./model.js";
import { captureAgentSource } from "./agent-source.js";
import { CHAT_LEAD_ALLOWANCE, CHAT_OUTCOMES, type ChatRecord, type ChatDefaults, type ChatEvent, type ChatAttachment, type LeadReply } from "./chat-model.js";

const META = "conversations";
function text(value: unknown, label: string, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("validation_failed", `${label} must contain 1–${max} characters`);
  return value.trim();
}
export function chatDefaults(value: any): ChatDefaults {
  fields(value, ["mode", "provider", "model", "effort", "trust", "tools", "maxCalls", "maxMinutes"]);
  if (!["agent", "team"].includes(value.mode) || !["safe", "standard", "trusted", "full"].includes(value.trust) || typeof value.tools !== "boolean") fail("validation_failed", "Choose valid mode and permission settings");
  getAdapter(value.provider);
  if (value.mode === "team" && !["claude", "codex"].includes(value.provider)) fail("unsupported_settings", "Team preparation requires Claude or Codex. Other providers remain available in Agent mode.");
  for (const name of ["model", "effort"]) if (value[name] !== undefined && (typeof value[name] !== "string" || value[name].length > (name === "model" ? 160 : 20))) fail("validation_failed", `Invalid ${name}`);
  if (value.maxCalls !== undefined && (!Number.isSafeInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 256) || value.maxMinutes !== undefined && (!Number.isFinite(value.maxMinutes) || value.maxMinutes < 1 || value.maxMinutes > 720)) fail("validation_failed", "Choose an Agent allowance of 1–256 calls and 1–720 minutes");
  return { ...value, maxCalls: value.maxCalls ?? 12, maxMinutes: value.maxMinutes ?? 30, model: value.model || undefined, effort: value.effort || undefined };
}

/** One durable chat can contain ordinary Agent turns and several independently approved tasks. */
export class Conversations {
  private records = new Map<string, ChatRecord>();
  private tails = new Map<string, Promise<unknown>>();
  private persistedEvents = new Map<string, number>();
  private generation = randomUUID();
  private observations = new Map<string, { hash: string; revision: number }>();
  private closing = false;
  constructor(readonly manager: RunManager, readonly tasks: TaskConversations, readonly authorize: (project: string, repo: string) => Promise<void>, readonly protect: <T>(work: () => Promise<T>) => Promise<T> = work => work()) {}
  private serialized<T>(id: string, work: () => Promise<T>) {
    const next = (this.tails.get(id) ?? Promise.resolve()).then(work), settled = next.catch(() => undefined);
    this.tails.set(id, settled); void settled.finally(() => { if (this.tails.get(id) === settled) this.tails.delete(id); }); return next;
  }
  private async save(chat: ChatRecord) {
    for (const event of chat.events.slice(this.persistedEvents.get(chat.id) ?? 0)) await journalEntry(META, `event:${chat.id}:${event.sequence}`, event);
    chat.version++; chat.updatedAt = Date.now();
    await journalEntry(META, `chat:${chat.id}`, { ...chat, events: [], eventCount: chat.events.length });
    this.persistedEvents.set(chat.id, chat.events.length); this.records.set(chat.id, chat);
  }
  private event(chat: ChatRecord, event: Omit<ChatEvent, "sequence" | "at">, at = Date.now()) {
    if (chat.events.some(e => e.id === event.id)) return;
    if (chat.events.length >= 2000) fail("context_limit", "This chat has reached its event limit. Your work is preserved; start a new chat.");
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
      if (!key.startsWith("chat:")) continue;
      const chat = raw as ChatRecord;
      const count = (raw as ChatRecord & { eventCount?: number }).eventCount;
      if (count !== undefined) chat.events = (eventsByChat.get(chat.id) ?? []).filter(event => event.sequence <= count).sort((a, b) => a.sequence - b.sequence);
      if (chat.id !== key.slice(5) || !Array.isArray(chat.events) || !chat.receipts) fail("storage_unavailable", "Conversation storage needs repair");
      if (count !== undefined && (chat.events.length !== count || chat.events.some((event, i) => event.sequence !== i + 1))) fail("storage_unavailable", "Conversation event storage needs repair");
      this.persistedEvents.set(chat.id, count ?? 0);
      this.records.set(chat.id, chat);
    }
  }
  /** Continue already-submitted turns while the window is closed; never starts an unaccepted task. */
  watch() {
    const scheduled = new Set<string>();
    const tick = () => {
      for (const chat of this.records.values()) {
        if (!chat.pending || scheduled.has(chat.id)) continue;
        scheduled.add(chat.id);
        void this.get(chat.id).catch(() => undefined).finally(() => scheduled.delete(chat.id));
      }
    };
    const timer = setInterval(tick, 1000); timer.unref(); return async () => { this.closing = true; clearInterval(timer); await Promise.allSettled([...this.tails.values()]); };
  }
  private async require(id: string): Promise<ChatRecord> {
    const stored = this.records.get(id);
    if (stored) { await this.authorize(stored.project, stored.repo); return structuredClone(stored); }
    if (id.startsWith("task-")) {
      const snapshot = await this.tasks.get(id.slice(5)), task = snapshot.task;
      return { id, version: 0, project: task.project, repo: task.repo, title: task.request.split("\n")[0]!.slice(0, 90), createdAt: task.createdAt, updatedAt: task.updatedAt,
        defaults: { mode: "team", provider: task.coordinator.provider, model: task.coordinator.model, effort: task.coordinator.effort, trust: "standard", tools: false },
        events: [{ id: `legacy-${task.id}`, sequence: 1, at: task.createdAt, kind: "user", body: task.request }, { id: `task-${task.id}`, sequence: 2, at: task.createdAt, kind: "task", taskId: task.id }],
        taskIds: [task.id], activeTask: task.id, agentRuns: [], leadRuns: [], source: task.source, untracked: task.untracked, leadAllowance: { ...CHAT_LEAD_ALLOWANCE }, receipts: {}, createHash: "legacy" };
    }
    fail("not_found", "This chat is unavailable");
  }
  async create(a: any) {
    fields(a, ["operationId", "project", "repo", "defaults", "source", "untracked"]);
    const operationId = text(a.operationId, "Operation ID", 100), project = text(a.project, "Project", 100);
    if (typeof a.repo !== "string" || !a.repo.startsWith("/")) fail("validation_failed", "Choose an absolute repository path");
    const repo = await repoRoot(a.repo); await this.authorize(project, repo);
    const defaults = chatDefaults(a.defaults), id = digest([project, repo, operationId]).slice(0, 32), hash = digest(a);
    if (a.source !== undefined && !["head", "working_changes"].includes(a.source)) fail("validation_failed", "Choose committed code or working changes");
    if (a.untracked !== undefined && (!Array.isArray(a.untracked) || a.untracked.some((p: unknown) => typeof p !== "string"))) fail("validation_failed", "Choose repository-relative source files");
    await captureSource(repo, a.source ?? "working_changes", a.untracked ?? []);
    return this.serialized(id, async () => {
      const prior = this.records.get(id);
      if (prior) { if (prior.createHash !== hash) fail("idempotency_conflict", "Creation ID was used with different arguments"); return { id, version: prior.version }; }
      const chat: ChatRecord = { id, version: 0, project, repo, title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), defaults, events: [], taskIds: [], agentRuns: [], leadRuns: [], source: a.source ?? "working_changes", untracked: a.untracked ?? [], leadAllowance: { ...CHAT_LEAD_ALLOWANCE }, receipts: {}, createHash: hash };
      await this.save(chat); return { id, version: chat.version };
    });
  }
  private usage(chat: ChatRecord) { return chat.leadRuns.reduce((sum, id) => { const run = this.manager.get(id); return { calls: sum.calls + (run?.cliTeam?.managedInvocations ?? 0), ms: sum.ms + Math.max(run?.clockUsedMs ?? 0, run?.cliTeam?.accountedExecutionMs ?? 0) }; }, { calls: 0, ms: 0 }); }
  private async taskState(chat: ChatRecord) { return chat.activeTask ? this.tasks.get(chat.activeTask) : undefined; }
  private async preparationSource(chat: ChatRecord, pending: NonNullable<ChatRecord["pending"]>) {
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
        await this.manager.followUp(run.id, { operationId: `${chat.id}:${pending.operationId}`, kind: "reply", worktree: "solo", budget: { maxSteps: defaults.maxCalls ?? 12, maxInvocations: defaults.maxCalls ?? 12, maxMinutes: defaults.maxMinutes ?? 30 }, agent: defaults.provider, message: source.body, settings: { model: defaults.model, effort: defaults.effort }, trust: defaults.trust, tools: defaults.tools, attachments: await loadChatFiles(source.attachments) });
        await flushWrites(); return;
      }
      if (run && !["running", "interrupted"].includes(run.status)) {
        const source = chat.events.find(e => e.id === pending.eventId)!;
        if (pending.mode === "team") {
          if (run.status === "done") {
            const artifact = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "result"), reply = artifact && JSON.parse(artifact.body) as LeadReply;
            if (!reply || leadProblem(reply)) fail("validation_failed", "The lead reply is invalid; inspect the preserved turn");
            if (reply.kind === "proposal") {
              const currentSource = await this.preparationSource(chat, pending);
              if (currentSource.fingerprint !== run.cliTeam!.source.fingerprint) fail("snapshot_stale", "Source changed while preparing the approach. Your request and prepared reply are preserved; cancel this turn and prepare again from the current source.");
              let taskId = reply.target === "current" ? pending.targetTask ?? chat.activeTask : undefined;
              if (!taskId) {
                const previous = await this.taskState(chat), previousRun = previous?.execution ? this.manager.get(previous.execution.id) : undefined;
                const priorResult = Object.values(previousRun?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1);
                const contextNotes = [...chat.events.filter(e => ["answer", "user"].includes(e.kind) && (e.kind !== "user" || e.sequence <= source.sequence)).slice(-8).map(e => `${e.kind}: ${e.body}`), ...(priorResult ? [`Previous delivered result:\n${priorResult.body}`] : [])].join("\n\n").slice(-8000);
                const created = await this.tasks.create({ operationId: `chat-${chat.id}-${pending.operationId}`, project: chat.project, repo: chat.repo, request: source.body, source: chat.source, untracked: chat.untracked,
                  coordinator: { provider: pending.defaults.provider, ...(pending.defaults.model ? { model: pending.defaults.model } : {}), ...(pending.defaults.effort ? { effort: pending.defaults.effort } : {}) }, attachments: await loadChatFiles(pending.files ?? source.attachments) },
                  { chatId: chat.id, contextNotes, ...(pending.sourceRunId ? { sourceRunId: pending.sourceRunId } : {}), ...(pending.continueRunId ? { continueRunId: pending.continueRunId } : {}) });
                taskId = created.id;
              }
              const state = await this.tasks.get(taskId);
              if (state.execution?.status === "running" && (!state.execution.paused || state.execution.pausePending)) {
                await this.tasks.action(taskId, { operationId: `pause-${pending.operationId}`, expectedVersion: state.task.version, action: "pause" });
                this.event(chat, { id: `settling-${pending.operationId}`, kind: "receipt", body: "Pausing the current task before revising its approach. Active assignments are settling; the prepared revision is preserved.", taskId });
                await this.save(chat); return;
              }
              const current = await this.tasks.get(taskId);
              await this.tasks.action(taskId, { operationId: `approach-${pending.operationId}`, expectedVersion: current.task.version, action: "edit", candidate: { ...reply.candidate!, limits: { ...TASK_LIMITS, ...reply.candidate!.limits } } });
              if (!chat.taskIds.includes(taskId)) { chat.taskIds.push(taskId); this.event(chat, { id: `task-${taskId}`, kind: "task", taskId }); }
              chat.activeTask = taskId;
            } else if (reply.kind === "guidance" && (pending.targetTask ?? chat.activeTask)) {
              const taskId = (pending.targetTask ?? chat.activeTask)!, state = await this.tasks.get(taskId);
              if (state.execution?.status === "running") {
                await this.tasks.action(taskId, { operationId: `guidance-${pending.operationId}`, expectedVersion: state.task.version, action: "message", message: source.body });
                this.event(chat, { id: `guidance-${pending.operationId}`, kind: "receipt", body: "Guidance recorded for the next assignment. Delivery and completion are shown in task details.", taskId });
              } else { this.event(chat, { id: `guidance-${pending.operationId}`, kind: "receipt", body: "No active assignment received this guidance. Ask for a revised approach to continue the preserved work.", taskId }); }
            }
            this.event(chat, { id: `answer-${pending.operationId}`, kind: "answer", body: reply.body, taskId: pending.targetTask, runId: run.id });
          } else this.event(chat, { id: `error-${pending.operationId}`, kind: "error", body: run.error || run.stopReason || "The lead stopped. Your request and completed work are preserved.", runId: run.id, errorKind: run.failure?.kind ?? run.steps.at(-1)?.errorKind });
        } else {
          const answer = run.followUps.at(-1)?.result || run.steps.filter(s => s.kind === "agent").at(-1)?.finalText || run.summary;
          this.event(chat, { id: `answer-${pending.operationId}`, kind: run.status === "done" ? "answer" : "error", body: answer || run.error || run.stopReason || "The turn ended without a readable response.", runId: run.id, errorKind: run.failure?.kind ?? run.steps.at(-1)?.errorKind });
        }
        chat.receipts[pending.operationId]!.complete = true; delete chat.pending;
        if (pending.mode === "agent" && run.status !== "done" && chat.queue?.length) {
          for (const queued of chat.queue) chat.receipts[queued.operationId]!.complete = true;
          chat.queue = [];
          this.event(chat, { id: `queue-preserved-${pending.operationId}`, kind: "receipt", body: "Queued requests remain in the conversation. Inspect the preserved Agent work, then send the next request explicitly." });
        }
        chat.pending = chat.queue?.shift(); await this.save(chat);
      }
    }
    for (const taskId of chat.taskIds) {
      const metadata = this.tasks.historySummary(taskId, chat.project, chat.repo);
      if (!metadata.runId || metadata.status === "running" || metadata.status === "interrupted" || chat.events.some(event => event.id === `result-${metadata.runId}`)) continue;
      const snapshot = await this.tasks.get(taskId), execution = snapshot.execution;
      if (!execution || execution.status === "running" || execution.status === "interrupted") continue;
      if (chat.events.some(e => e.id === `result-${execution.id}`)) continue;
      const result = Object.values(this.manager.get(execution.id)?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1);
      this.event(chat, { id: `result-${execution.id}`, kind: "result", body: CHAT_OUTCOMES[execution.outcome ?? ""] ?? "Work preserved", taskId, runId: execution.id, evidence: execution.artifacts, artifact: result ? { id: result.id, sha256: result.sha256, kind: "result", data: result.data } : undefined }, this.manager.get(execution.id)?.endedAt);
      await this.save(chat);
    }
  }
  private async dispatch(chat: ChatRecord) {
    if (this.closing) return; // Leave a submitted, undispatched turn available after restart.
    const pending = chat.pending!;
    if (pending.runId) return;
    const event = chat.events.find(e => e.id === pending.eventId)!, state = pending.targetTask ? await this.tasks.get(pending.targetTask) : await this.taskState(chat);
    if (pending.mode === "agent") {
      const writer = await this.taskState(chat);
      if (chat.taskIds.some(id => { const task = this.tasks.historySummary(id, chat.project, chat.repo), run = task.runId ? this.manager.get(task.runId) : undefined; return task.scope === "write" && task.status === "running" && (!run?.pauseRequested || run.steps.some(step => step.status === "running")); })) return;
      const prior = chat.agentRuns.at(-1), run = prior ? this.manager.get(prior) : undefined, defaults = pending.defaults;
      if (run?.status === "running") return;
      const latestTaskRun = writer?.execution ? this.manager.get(writer.execution.id) : undefined;
      if (run && (!latestTaskRun || latestTaskRun.createdAt < run.createdAt) && run.roles.agent?.[0] === defaults.provider && run.worktrees.some(w => w.name === "solo")) {
        pending.runId = run.id; pending.followUp = true; await this.save(chat);
        await this.manager.followUp(run.id, { operationId: `${chat.id}:${pending.operationId}`, kind: "reply", worktree: "solo", budget: { maxSteps: defaults.maxCalls ?? 12, maxInvocations: defaults.maxCalls ?? 12, maxMinutes: defaults.maxMinutes ?? 30 }, agent: defaults.provider, message: event.body, settings: { model: defaults.model, effort: defaults.effort }, trust: defaults.trust, tools: defaults.tools, attachments: await loadChatFiles(event.attachments) });
        await flushWrites(); return;
      }
      const transcript = chat.events.filter(e => e.body && ["user", "answer"].includes(e.kind) && (e.kind !== "user" || e.sequence <= event.sequence)).slice(-16).map(e => `${e.kind}: ${e.body}`).join("\n\n").slice(-18000);
      const latest = await this.taskState(chat), retained = latest?.execution?.status === "done" ? latest.execution.worktrees[0] : undefined;
      const source = run && (!latestTaskRun || run.createdAt > latestTaskRun.createdAt) && run.conversationId === chat.id
        ? (await captureAgentSource(this.manager, { project: chat.project, repo: chat.repo, chatId: chat.id }, run.id)).commit
        : retained?.branch ?? (await captureSource(chat.repo, chat.source, chat.untracked)).commit;
      const delivered = Object.values(latestTaskRun?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1)?.body ?? "";
      await this.manager.start({ pattern: findPattern("solo")!, conversationId: chat.id, project: chat.project, repo: chat.repo, requireProjectRepo: true, baseRef: source, task: `Conversation context (historical; the latest request takes precedence):\n${transcript}\n\nLatest task deliverable (historical context):\n${delivered.slice(0, 16000)}\n\nLatest request:\n${event.body}`, roles: { agent: [defaults.provider] }, agentSettings: { [defaults.provider]: { model: defaults.model, effort: defaults.effort } }, options: {}, loop: { maxSteps: defaults.maxCalls ?? 12, maxInvocations: defaults.maxCalls ?? 12, maxMinutes: defaults.maxMinutes ?? 30 }, trust: defaults.trust, approvals: { tools: defaults.tools }, context: { attachments: await loadChatFiles(pending.files ?? event.attachments) },
        beforeDispatch: async run => { await flushWrites(); pending.runId = run.id; chat.agentRuns.push(run.id); await this.save(chat); } });
      return;
    }
    const used = this.usage(chat), calls = Math.min(3, chat.leadAllowance.maxCalls - used.calls), minutes = Math.min(5, chat.leadAllowance.maxMinutes - used.ms / 60000);
    if (calls < 1 || minutes < .1) fail("budget_exhausted", "The lead allowance is used. Review a larger total allowance to continue; existing tasks keep their execution allowance.");
    const coordinator = pending.targetTask && state ? state.task.coordinator : { id: "lead", provider: pending.defaults.provider as "claude" | "codex", model: pending.defaults.model, effort: pending.defaults.effort };
    const participant = await this.tasks.core.resolveWebCoordinator({ project: chat.project, repo: chat.repo }, coordinator);
    const priorAgent = chat.agentRuns.length ? this.manager.get(chat.agentRuns.at(-1)!) : undefined;
    const priorTaskRun = state?.execution ? this.manager.get(state.execution.id) : undefined;
    if (!pending.targetTask && priorAgent?.status === "done" && (!priorTaskRun || priorAgent.createdAt > priorTaskRun.createdAt)) pending.sourceRunId = priorAgent.id;
    else if (!pending.targetTask && priorTaskRun?.status === "done" && priorTaskRun.cliTeam?.taskConversation?.chatId === chat.id) pending.continueRunId = priorTaskRun.id;
    const source = await this.preparationSource(chat, pending);
    const discovery = await this.tasks.core.operateWeb({ project: chat.project, repo: chat.repo }, "codeflow_list_providers", {});
    const inventory = await Promise.all(discovery.providers.filter((p: any) => p.installed).map(async (p: any) => ({ provider: p.id, ...await catalog(p.id).catch(() => ({})) })));
    const skill = await (await import("node:fs/promises")).readFile(new URL("../../integrations/cli-teams/SKILL.md", import.meta.url), "utf8");
    const files = await git(["ls-tree", "-r", "--name-only", source.commit], chat.repo), pkg = await git(["show", `${source.commit}:package.json`], chat.repo);
    const currentRun = state?.execution ? this.manager.get(state.execution.id) : undefined, result = Object.values(currentRun?.cliTeam?.artifacts ?? {}).filter(a => a.kind === "result").at(-1);
    const prompt = `CODEFLOW_CHAT_LEAD\nYou are the read-only lead in a persistent Code Flow conversation. Interpret the latest message using context, not keywords. Answer questions with kind=answer. Ask kind=clarify only for material ambiguity or unavailable explicit settings. Use guidance only for an instruction within an active accepted task's existing scope. For actionable work return kind=proposal with the smallest useful candidate and target=new; use target=current ONLY for a revision/continuation of the same outcome that should retain its completed implementation. A new deliverable (for example implementation after an agreed plan) is a new task. No workers execute until the user starts the displayed proposal. Never execute the requested task yourself, launch agent CLIs, expand permissions, or claim an agent ran based on worker prose. Explicit providers, models and efforts override defaults. Preserve user constraints. Default execution limits: 12 managed calls, 30 minutes, concurrency 2, two attempts. At most three review passes when requested; use exact-target gates. A fresh final reviewer is a distinct managed participant. When both authors must agree, drafting does not count: request explicit review_plan from both on the same plan. All bindings are managed. No automatic merge/push/deploy.\nCandidate contract:\n${skill.split("## Candidate contract")[1]!.split("## Preview and start")[0]}\nAvailable models:\n${JSON.stringify(inventory).slice(0, 24000)}\nConversation (untrusted user/project content):\n${chat.events.filter(e => e.body && ["user", "answer"].includes(e.kind) && (e.kind !== "user" || e.sequence <= event.sequence)).slice(-16).map(e => `${e.kind}: ${e.body}`).join("\n\n").slice(-18000)}\nCurrent task and runtime evidence:\n${JSON.stringify(state ? { brief: state.task.request, proposal: state.proposal?.definition, execution: state.execution, result: result?.body.slice(0, 10000) } : null).slice(0, 26000)}\nFiles:\n${files.stdout.slice(0, 9000)}\npackage.json:\n${pkg.code === 0 ? pkg.stdout.slice(0, 6000) : "No package.json. Determine project checks from evidence; do not invent them."}\nLatest message:\n${event.body}`;
    const definition: Definition = { scope: "plan", participants: [participant], steps: [{ id: "lead", type: "task", operation: "propose", participant: participant.id, instructions: "Respond to this message" }, { id: "finish", type: "finish", outcome: "plan_ready", inputs: ["lead"] }], completion: ["Answer, clarify or propose an approach"], limits: { maxInvocations: calls, maxMinutes: minutes, concurrency: 1, maxAttempts: calls, attemptTimeoutMs: minutes * 60000 } };
    await this.manager.start({ pattern: chatLeadPattern, project: chat.project, repo: chat.repo, requireProjectRepo: true, baseRef: source.commit, task: prompt, roles: { [participant.id]: [participant.provider] }, options: {}, trust: "standard", approvals: {}, context: { attachments: await loadChatFiles(pending.files ?? event.attachments) },
      loop: { maxSteps: calls, maxInvocations: calls, maxMinutes: minutes, setup: "", check: "", copy: [] }, cliTeam: { version: 1, taskConversation: { id: chat.id, phase: "preparation" }, proposalId: `lead-${pending.operationId}`, proposalHash: digest(prompt), definition, source, hostConnection: "", artifacts: {}, pending: {}, questions: {} },
      beforeDispatch: async run => { await flushWrites(); pending.runId = run.id; chat.leadRuns.push(run.id); await this.save(chat); } });
  }
  async action(id: string, a: any) {
    const allowed: Record<string, string[]> = { send: ["message", "attachments", "targetTask"], defaults: ["defaults"], control: ["control"], allowance: ["maxCalls", "maxMinutes"], task: ["taskId", "input"], remove_file: ["sha256"], cancel_message: ["messageId"] };
    if (!a || !Object.hasOwn(allowed, a.action)) fail("validation_failed", "Unknown chat action");
    fields(a, ["operationId", "expectedVersion", "action", ...allowed[a.action]!]);
    const operationId = text(a.operationId, "Operation ID", 100), hash = digest({ ...a, expectedVersion: undefined, ...(a.action === "task" ? { input: { ...a.input, expectedVersion: undefined } } : {}) });
    return this.serialized(id, () => this.protect(async () => {
      const chat = await this.require(id), previous = chat.receipts[operationId];
      if (previous && previous.hash !== hash && previous.hash !== digest(a)) fail("idempotency_conflict", "Operation ID was used with different arguments");
      if (previous?.complete) return { id, version: chat.version };
      if (!previous && chat.version !== a.expectedVersion) fail("revision_conflict", "This chat changed in another view. Refresh; your draft is preserved.");
      if (!previous) { chat.receipts[operationId] = { hash }; await this.save(chat); }
      if (a.action === "defaults") chat.defaults = chatDefaults(a.defaults);
      else if (a.action === "allowance") {
        if (!Number.isSafeInteger(a.maxCalls) || a.maxCalls < chat.leadAllowance.maxCalls || a.maxCalls > 100 || !Number.isFinite(a.maxMinutes) || a.maxMinutes < chat.leadAllowance.maxMinutes || a.maxMinutes > 240 || chat.pending?.runId) fail("validation_failed", "Wait for the lead to settle, then choose a larger total allowance up to 100 calls / 240 minutes");
        chat.leadAllowance = { maxCalls: a.maxCalls, maxMinutes: a.maxMinutes };
        if (chat.pending && !chat.pending.runId) delete chat.pending.error;
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
        if (a.input?.action === "start") {
          const target = await this.tasks.get(a.taskId);
          if (target.proposal?.definition.scope === "write") {
            const otherWriter = await Promise.all(chat.taskIds.filter(id => id !== a.taskId).map(id => this.tasks.get(id)));
            if (otherWriter.some(t => t.proposal?.definition.scope === "write" && t.execution?.status === "running" && (!t.execution.paused || t.execution.pausePending)) || chat.agentRuns.some(id => this.manager.get(id)?.status === "running")) fail("conflict", "Pause the current writer and wait for it to settle before starting another writing task in this chat");
          }
        }
        await this.tasks.action(a.taskId, { ...a.input, operationId: `chat-${operationId}` });
        this.event(chat, { id: operationId, kind: "receipt", taskId: a.taskId, body: a.input.action === "start" ? "Started the reviewed approach. Its scope, participants, settings and allowance are fixed for this execution." : `Task ${a.input.action} requested.` });
      } else if (a.action === "control") {
        if (!["pause", "resume", "cancel"].includes(a.control) || !chat.pending) fail("conflict", "No conversation turn is available for this control");
        const pending = chat.pending, run = pending.runId ? this.manager.get(pending.runId) : undefined;
        if (a.control === "cancel") {
          if (run?.status === "running") this.manager.cancel(run.id);
          else {
            chat.receipts[pending.operationId]!.complete = true;
            if (run && pending.mode === "agent") { for (const item of chat.queue ?? []) chat.receipts[item.operationId]!.complete = true; chat.queue = []; }
            chat.pending = chat.queue?.shift();
          }
        }
        else if (run?.status === "running") this.manager.setPaused(run.id, a.control === "pause");
        else if (a.control === "resume" && run?.status === "interrupted" && pending.mode === "team") await this.manager.resume(run.id, undefined, true);
        else fail("recovery_required", "Inspect the preserved conversation turn before continuing an interrupted writer");
      } else {
        if (chat.queue?.some(pending => pending.operationId === operationId)) return { id, version: chat.version };
        if (chat.pending?.operationId !== operationId) {
          if ((chat.queue?.length ?? 0) >= 20) fail("context_limit", "Twenty messages are queued. Wait for a turn to finish; your draft is preserved.");
          const body = text(a.message, "Message"), attachments = await storeChatFiles(chatAttachments(a.attachments));
          const files = [...(chat.files ?? []).filter(file => !attachments.some(next => next.name === file.name)), ...attachments];
          if (files.length > 10 || files.reduce((sum, file) => sum + file.bytes, 0) > 4 * 1024 * 1024) fail("context_limit", "Chat files exceed ten files / 4 MB. Remove older files in Task details or start a new chat.");
          chat.files = files;
          if (a.targetTask != null && !chat.taskIds.includes(a.targetTask)) fail("scope_denied", "This task belongs to another chat");
          this.event(chat, { id: operationId, kind: "user", body, mode: chat.defaults.mode, attachments });
          if (chat.title === "New chat") chat.title = body.split("\n")[0]!.slice(0, 90);
          const pending = { operationId, eventId: operationId, mode: (a.targetTask || chat.defaults.mode === "team" ? "team" : "agent") as "team" | "agent", defaults: { ...chat.defaults }, files: structuredClone(files), targetTask: a.targetTask || undefined };
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
  async get(id: string) {
    return this.serialized(id, () => this.protect(async () => {
      const chat = await this.require(id);
      try { await this.reconcile(chat); if (chat.pending && !chat.pending.runId && !chat.pending.error) await this.dispatch(chat); }
      catch (error) {
        const eventId = `pending-error-${chat.pending?.operationId ?? randomUUID()}`;
        const changed = chat.pending?.error !== (error as Error).message;
        if (chat.pending) chat.pending.error = (error as Error).message;
        const missing = !chat.events.some(event => event.id === eventId);
        if (missing) this.event(chat, { id: eventId, kind: "error", body: (error as Error).message, runId: chat.pending?.runId });
        if (changed || missing) await this.save(chat);
      }
      const visibleTasks = [...new Set([...chat.taskIds.slice(-12), ...(chat.activeTask ? [chat.activeTask] : [])])];
      const tasks = await Promise.all(visibleTasks.map(id => this.tasks.get(id))), { receipts: _, createHash: __, ...safe } = chat;
      const pendingRun = chat.pending?.runId ? this.manager.get(chat.pending.runId) : undefined;
      const snapshot = { chat: safe, tasks, leadUsage: this.usage(chat),
        turn: chat.pending ? { mode: chat.pending.mode, queued: !chat.pending.runId, runId: pendingRun?.id, status: pendingRun?.status, error: chat.pending.error ?? pendingRun?.error, paused: !!pendingRun?.pauseRequested } : undefined };
      const hash = digest(snapshot), prior = this.observations.get(id), observation = prior?.hash === hash ? prior.revision : (prior?.revision ?? 0) + 1;
      this.observations.set(id, { hash, revision: observation });
      return { ...snapshot, generation: this.generation, observation, cursor: `${this.generation}:${hash}` };
    }));
  }
  async list(project: string) {
    const out: { id: string; title: string; project: string; updatedAt: number; status: string; runIds: string[] }[] = [], owned = new Set<string>();
    for (const chat of this.records.values()) {
      if (project && project !== chat.project) continue;
      try {
        await this.authorize(chat.project, chat.repo);
        chat.taskIds.forEach(id => owned.add(id));
        const taskStates = chat.taskIds.map(id => this.tasks.historySummary(id, chat.project, chat.repo)), active = taskStates.find(t => t.status === "running" || t.preparing), latest = taskStates.at(-1);
        const pendingRun = chat.pending?.runId ? this.manager.get(chat.pending.runId) : undefined;
        const agent = chat.agentRuns.length ? this.manager.get(chat.agentRuns.at(-1)!) : undefined;
        const waiting = active?.runId ? Object.values(this.manager.get(active.runId)?.cliTeam?.questions ?? {}).some(question => !question.answer) : false;
        const agentNeedsAttention = agent && agent.status !== "done" && (!latest || agent.createdAt > latest.updatedAt);
        const status = chat.pending?.error || pendingRun?.status === "interrupted" ? "Needs attention"
          : chat.pending ? pendingRun?.status === "failed" ? "Needs attention" : pendingRun?.pauseRequested ? "Paused" : "Responding"
          : latest?.ready ? "Approach ready"
          : active ? waiting ? "Needs attention" : active.paused ? "Paused" : "Working"
          : agentNeedsAttention ? "Needs attention"
          : latest?.outcome ? CHAT_OUTCOMES[latest.outcome] ?? "Work preserved" : "Chat";
        out.push({ id: chat.id, title: chat.title, project: chat.project, updatedAt: Math.max(chat.updatedAt, ...taskStates.map(t => t.updatedAt)), status, runIds: [...chat.agentRuns, ...chat.leadRuns, ...taskStates.flatMap(t => t.runIds)] });
      } catch { /* A removed membership cannot reveal another project's history. */ }
    }
    const projects = project ? [project] : this.manager.projects?.list().map(p => p.id) ?? [];
    for (const projectId of projects) for (const task of await this.tasks.list(projectId)) {
      if (owned.has(task.id) || task.chatId && this.records.has(task.chatId)) continue;
      const state = await this.tasks.get(task.id);
      out.push({ id: `task-${task.id}`, title: task.request, project: projectId, updatedAt: task.updatedAt, status: state.execution?.outcome ? CHAT_OUTCOMES[state.execution.outcome] ?? "Work preserved" : state.execution?.status === "running" ? "Working" : state.proposal ? "Approach ready" : "Chat", runIds: [...state.task.executions, ...state.task.preparation.runs] });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
export type ChatSnapshot = Awaited<ReturnType<Conversations["get"]>>;
export type ChatSummary = Awaited<ReturnType<Conversations["list"]>>[number];
