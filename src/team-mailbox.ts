import { createHash } from "node:crypto";
import type { TeamCommandReceipt, TeamMessage, TeamState } from "./teams.js";

export type TeamMailboxCommandType = "send_message" | "ask_member" | "reply_request" | "yield_task" | "publish_finding" | "propose_contract" | "submit_task" | "request_help";
export interface TeamMailboxCommand {
  type: TeamMailboxCommandType;
  operationId: string;
  recipient?: string;
  body?: string;
  requestId?: string;
  blocking?: boolean;
  deadlineMs?: number;
  checkpoint?: string;
  evidence?: string[];
  title?: string;
  paths?: string[];
  artifacts?: string[];
}
export interface TeamMailboxAuthority {
  memberId: string;
  taskId?: string;
  attempt?: number;
  stepId?: string;
  origin: "agent" | "user";
}
const TYPES = new Set<TeamMailboxCommandType>(["send_message", "ask_member", "reply_request", "yield_task", "publish_finding", "propose_contract", "submit_task", "request_help"]);
const FIELDS = new Set(["type", "operationId", "recipient", "body", "requestId", "blocking", "deadlineMs", "checkpoint", "evidence", "title", "paths", "artifacts"]);
const nonempty = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const list = (v: unknown, max: number) => v === undefined || Array.isArray(v) && v.length <= max && v.every((x) => nonempty(x, 2_000));
const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);

export function mailboxCommandProblem(command: TeamMailboxCommand): string | undefined {
  if (!command || !TYPES.has(command.type) || Object.keys(command).some((key) => !FIELDS.has(key))) return "Unknown collaboration command or field";
  if (!nonempty(command.operationId, 240)) return "operationId must be a stable nonempty ID of at most 240 characters";
  if (command.body !== undefined && !nonempty(command.body, 8_000)) return "body must contain 1–8000 characters";
  if (command.checkpoint !== undefined && !nonempty(command.checkpoint, 12_000)) return "checkpoint must contain 1–12000 characters";
  if (command.title !== undefined && !nonempty(command.title, 200)) return "title must contain 1–200 characters";
  if (!list(command.evidence, 16) || !list(command.artifacts, 24) || !list(command.paths, 24)) return "Message evidence, artifacts, or paths exceed bounds";
  if (command.recipient !== undefined && !nonempty(command.recipient, 40)) return "Invalid recipient";
  if (command.requestId !== undefined && !nonempty(command.requestId, 300)) return "Invalid request ID";
  if (command.blocking !== undefined && typeof command.blocking !== "boolean") return "blocking must be boolean";
  if (command.deadlineMs !== undefined && (!Number.isSafeInteger(command.deadlineMs) || command.deadlineMs < 1_000 || command.deadlineMs > 3_600_000)) return "deadlineMs must be between 1000 and 3600000";
  if (["send_message", "ask_member", "reply_request", "publish_finding", "propose_contract", "request_help"].includes(command.type) && !command.body) return "This command needs a body";
  if (["send_message", "ask_member"].includes(command.type) && !command.recipient) return "This command needs an addressed recipient";
  if (command.type === "reply_request" && (!command.requestId || !command.evidence?.length)) return "A reply needs a request ID and evidence";
  if (["yield_task", "submit_task"].includes(command.type) && !command.checkpoint) return "Task transitions need a portable checkpoint";
  if (["publish_finding", "propose_contract"].includes(command.type) && !command.evidence?.length) return "Shared proposals need supporting evidence";
  return undefined;
}

/** Pure, atomic logical transaction. Caller must persist command + receipt before publishing state. */
export function applyMailboxCommand(input: TeamState, command: TeamMailboxCommand, authority: TeamMailboxAuthority, now: number): { state: TeamState; receipt: TeamCommandReceipt } {
  const state = structuredClone(input);
  return { state, receipt: applyMailboxCommandInPlace(state, command, authority, now) };
}

/**
 * The same transaction applied to `state` in place, for callers that replay a batch of recorded
 * commands onto one clone (every live tool call rebuilds its view that way, so a chatty turn
 * must not pay a full state copy per earlier command). Idempotent per operationId; validation
 * errors throw before anything changes.
 */
export function applyMailboxCommandInPlace(state: TeamState, command: TeamMailboxCommand, authority: TeamMailboxAuthority, now: number): TeamCommandReceipt {
  const problem = mailboxCommandProblem(command); if (problem) throw new Error(problem);
  const { stepId: _physicalStep, ...logicalAuthority } = authority;
  const fingerprint = createHash("sha256").update(stable({ command, authority: logicalAuthority })).digest("hex");
  const previous = state.commandReceipts?.find((r) => r.operationId === command.operationId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error("operationId was already used for different collaboration content");
    return previous;
  }
  if ((state.commandReceipts?.length ?? 0) >= 4096) throw new Error("Run collaboration command limit reached");
  state.commandReceipts ??= []; state.waits ??= [];
  const receipt: TeamCommandReceipt = { operationId: command.operationId, fingerprint, status: "accepted" };
  const done = () => { state.commandReceipts!.push(receipt); return receipt; };
  const stale = (reason: string) => { receipt.status = "stale"; receipt.reason = reason; return done(); };
  const member = state.members.find((m) => m.id === authority.memberId);
  const task = state.tasks.find((t) => t.id === authority.taskId);
  if (authority.origin === "agent" && (!member || member.status === "retired")) return stale("The sending member is absent or retired");
  if (authority.origin === "user" && authority.memberId !== "user") throw new Error("User origin requires authenticated user identity");
  if (authority.taskId && (!task || task.owner !== authority.memberId || authority.attempt !== task.attempts)) return stale("The task has been reassigned or this attempt is no longer current");
  const messageId = `mail:${createHash("sha256").update(command.operationId).digest("hex").slice(0, 24)}`;
  const effectiveRecipient = (requested: string): string => requested === "user" ? "user" : state.members.some((m) => m.id === requested && m.status !== "retired") ? requested : "coordinator";
  const add = (kind: TeamMessage["kind"], recipient: string, body: string, blocking = false) => {
    const target = effectiveRecipient(recipient);
    const message: TeamMessage = { id: messageId, kind, sender: authority.memberId, recipient: target, taskId: task?.id ?? "", body, blocking, evidence: command.evidence ?? [], status: kind === "question" ? "open" : "answered", sourceStepId: authority.stepId ?? "collaboration", origin: authority.origin, sourceAttempt: authority.attempt, revision: state.revision, createdAt: now, delivery: { status: "queued" }, ...(target !== recipient ? { originalRecipient: recipient } : {}) };
    state.messages.push(message); receipt.messageId = messageId; return message;
  };
  if (command.type === "reply_request") {
    const question = state.messages.find((m) => m.id === command.requestId && m.kind === "question");
    if (!question) throw new Error("Unknown request ID");
    if (question.recipient === "user" ? authority.origin !== "user" : authority.memberId !== question.recipient && authority.memberId !== "coordinator") throw new Error("Only the addressed member or coordinator may answer this request");
    if (question.status !== "open") return stale("The request already has an accepted answer");
    const owner = state.tasks.find((t) => t.id === question.taskId);
    // A reassignment deliberately transfers a task's request, not its private context.
    const reply = add("reply", owner?.owner ?? question.sender, command.body!);
    reply.taskId = question.taskId; reply.requestId = question.id;
    question.status = "answered"; question.answeredAt = now; receipt.requestId = question.id;
    for (const wait of state.waits) if (wait.requestId === question.id && wait.status !== "resolved") { wait.status = "resolved"; wait.resolvedAt = now; }
    if (owner?.status === "needs_info" && !state.messages.some((m) => m.kind === "question" && m.taskId === owner.id && m.blocking && m.status === "open")) owner.status = "pending";
  } else if (command.type === "ask_member" || command.type === "request_help") {
    if (!task) throw new Error("Questions must belong to a current task");
    if (command.recipient === authority.memberId) throw new Error("A member cannot ask itself");
    const question = add("question", command.recipient ?? "coordinator", command.body!, command.blocking ?? true);
    question.deadlineAt = now + (command.deadlineMs ?? 120_000); receipt.requestId = question.id;
    state.metrics.questionCount++;
    if (question.blocking) {
      state.waits.push({ requestId: question.id, taskId: task.id, memberId: member!.id, attempt: authority.attempt!, status: "waiting", createdAt: now, deadlineAt: question.deadlineAt });
      // A live question does not stop the process. The explicit yield/outcome releases its slot.
      task.waitingSince ??= now;
    }
  } else if (command.type === "yield_task") {
    if (!task || !member) throw new Error("yield_task needs a current assignment");
    if (task.status !== "running" && task.status !== "needs_info") return stale("The assignment already finished");
    if (!state.messages.some((m) => m.kind === "question" && m.taskId === task.id && m.blocking && m.status === "open")) throw new Error("Yield requires an unresolved blocking request");
    task.checkpoint = command.checkpoint; task.checkpointOwner = member.id;
    // Yield is a requested transition. The scheduler applies needs_info only after process exit.
    task.error = "Yield requested; waiting for the current turn to release its process slot";
  } else if (command.type === "submit_task") {
    if (!task || !member) throw new Error("submit_task needs a current assignment");
    if (task.status !== "running") return stale("The assignment is not running");
    if (state.messages.some((m) => m.kind === "question" && m.taskId === task.id && m.blocking && m.status === "open")) throw new Error("Cannot submit with an unanswered blocking request");
    task.checkpoint = command.checkpoint; task.checkpointOwner = member.id;
    task.artifacts = command.artifacts ?? [];
    // Submission is a proposal; only the ended turn + integration + checks change task status.
    add("message", "coordinator", "Task submission proposed; artifact verification is pending.");
  } else {
    const kind = command.type === "publish_finding" ? "finding" : command.type === "propose_contract" ? "contract" : "message";
    add(kind, command.recipient ?? "coordinator", `${command.title ? `${command.title}\n` : ""}${command.body!}`);
  }
  return done();
}

/** Reconcile by identity so asynchronous worker closures keep valid task/member references. */
export function applyMailboxProjection(target: TeamState, next: TeamState): void {
  const tasks = next.tasks.map((t) => { const previous = target.tasks.find((old) => old.id === t.id); return previous ? Object.assign(previous, t) : t; });
  const members = next.members.map((m) => { const previous = target.members.find((old) => old.id === m.id); return previous ? Object.assign(previous, m) : m; });
  Object.assign(target, next, { tasks, members });
}

/** Deterministic liveness pass; its timestamp must be journaled by the caller. */
export function escalateMailbox(state: TeamState, now: number, unavailable: Set<string> = new Set()): string[] {
  const reasons: string[] = [];
  const open = state.messages.filter((m) => m.kind === "question" && m.status === "open" && m.recipient !== "user");
  const edges = new Map<string, string[]>();
  for (const q of open.filter((q) => q.blocking)) edges.set(q.sender, [...(edges.get(q.sender) ?? []), q.recipient]);
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
    if (from === target) return true;
    if (visited.has(from)) return false; visited.add(from);
    return (edges.get(from) ?? []).some((next) => reaches(next, target, visited));
  };
  for (const question of open) {
    const wait = state.waits?.find((w) => w.requestId === question.id);
    if (wait?.status === "escalated") continue;
    const recipient = state.members.find((m) => m.id === question.recipient);
    const reason = !recipient || recipient.status === "retired" || unavailable.has(question.recipient) ? "recipient unavailable" : question.deadlineAt !== undefined && question.deadlineAt <= now ? "request deadline elapsed" : reaches(question.recipient, question.sender) ? "cyclic member wait" : undefined;
    if (!reason) continue;
    question.originalRecipient ??= question.recipient; question.recipient = "coordinator";
    if (wait) { wait.status = "escalated"; wait.reason = reason; }
    reasons.push(`${question.id}: ${reason}`);
  }
  return reasons;
}
