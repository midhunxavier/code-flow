import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { CODEFLOW_HOME } from "../config.js";
import { logError, logWarn } from "../log.js";
import type { SharedRole } from "../shared-accounts.js";
import { actorRole, assertCanChangeOwner, assignOwner, ATTEMPT_ID, ATTEMPT_STATES, busyAttempt, CHECKPOINT_ID, clone, CollabError, COMMIT_ID, isTaskOwner, latestCheckpoint, MAX, mentionsIn, newCheckpointId, newId, newRunnerId, newRunnerToken, newTaskId, ownerChangedMessage, PATH_ID, PREFIXED_ID, pushBounded, recordAudit, REPO_KEY, roleAtLeast, RUNNER_ID, RUNNER_TOKEN, SHA256_HEX, summarize, TASK_ID, TASK_STATUSES, transition, truncateText, validateCheckpointInput, validateCommit, validateProgress, validateProgressReport, validateRepoRefs, validateTaskInput, validateTaskPatch, validateText, validateUserRef, whoOf } from "./model.js";
import type { Attempt, AttemptState, Board, BoardProject, Checkpoint, CollabActor, Comment, Handoff, InboxItem, InboxKind, Instruction, RandomSource, RepoRef, RunnerPublic, Task, Who } from "./model.js";

/**
 * The hub's team board on disk: `CODEFLOW_HOME/team/{board,runners,inbox}.json` plus `checkpoints/<id>.bundle`.
 * Every rule in model.ts is applied here to a copy of the state, written durably, then swapped in and announced,
 * so in-process callers cannot bypass authorization and listeners never see a change that is not on disk. The one
 * exception is telemetry (progress reports on a running attempt, heartbeats, a runner's lastSeen): it is swapped in
 * and announced at once but reaches disk with the next durable change or the 30 s write-behind, so twenty agents
 * reporting every two seconds never turn into a serialize-and-fsync of the whole board per report.
 */

/** A shared account as the store needs it: the server maps SharedAccounts.snapshot().users onto this so the store depends on no class. */
export interface MemberRecord { userId: string; username: string; displayName: string; enabled: boolean; roles: Record<string, SharedRole> }
export interface ProjectRecord { id: string; name: string }
export interface CollabStoreOptions { dir?: string; members: () => MemberRecord[]; projects: () => ProjectRecord[]; ownerName?: () => string | undefined; random?: RandomSource; now?: () => number }
export type ChangeKind = "task" | "board" | "inbox" | "runners";
export interface ChangeEvent { seq: number; kind: ChangeKind; taskId?: string; projectId?: string; userIds?: string[] }
export interface EventPage { epoch: string; seq: number; events: ChangeEvent[]; resync: boolean }
export interface ClaimInput { attemptId: string; runnerId: string; runnerName: string; baseCommit: string; fromCheckpointId?: string; revision: number }
export type FinishState = "finished" | "failed" | "stopped" | "paused" | "unknown";
export interface FinishInput { state: FinishState; head?: string; summary?: string; reason?: string }
export interface ReviewInput { checkpointId: string; verdict: "approve" | "request-changes"; text?: string }
export interface HandoffInput { to: string; checkpointId: string; note?: string }
export interface BundleInfo { size: number; sha256: string }
interface RunnerRecord { id: string; userId: string; name: string; tokenHash: string; createdAt: number; lastSeenAt: number; revokedAt?: number; lastAddress?: string }
interface BoardDocument { version: 1; revision: number; ownerName?: string; projects: Record<string, { repositories: RepoRef[] }>; tasks: Task[] }
interface RunnersDocument { version: 1; runners: RunnerRecord[] }
interface InboxDocument { version: 1; items: InboxItem[] }
interface State { board: BoardDocument; runners: RunnersDocument; inbox: InboxDocument }
type DocumentName = "board" | "runners" | "inbox";
/** What a mutation touched: a document that must be written before the change is announced, or `telemetry` (a running attempt's progress or heartbeat) that is announced at once and written behind. */
type Dirty = DocumentName | "telemetry";
/** One mutation's working copy: the board is copied shallowly, tasks are cloned on first touch and the runners and inbox documents only when read, so a heartbeat on one task copies neither the board nor 5000 inbox items. */
interface Draft { board: BoardDocument; readonly runners: RunnersDocument; readonly inbox: InboxDocument; dirty: Set<Dirty>; events: Omit<ChangeEvent, "seq">[]; after: (() => Promise<void>)[]; undo: (() => Promise<void>)[]; task(id: string, dirty?: "board" | "telemetry"): Task | undefined; snapshot(): State }

export const RUNNER_LOCAL = "local";
const READ_LIMIT = 16 * 1024 * 1024, RING = 1000, TOUCH_MS = 10_000, FLUSH_MS = 30_000, RETENTION_MS = 30 * 24 * 60 * 60_000, STALE_ATTEMPT_MS = 24 * 60 * 60_000;
const TERMINAL: readonly AttemptState[] = ["finished", "failed", "superseded"], FINISH_STATES: readonly FinishState[] = ["finished", "failed", "stopped", "paused", "unknown"];
const INBOX_KINDS: readonly InboxKind[] = ["assigned", "mention", "review-requested", "review-recorded", "handoff-offered", "handoff-accepted", "handoff-declined", "handoff-cancelled", "instruction-proposed", "blocked", "attempt-finished", "attempt-failed", "comment"];
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const short = (commit: string) => commit.slice(0, 12);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];
export const ownerActor = (displayName = "Owner"): CollabActor => ({ kind: "owner", userId: "owner", displayName });
export const memberActor = (user: MemberRecord, via: "browser" | "runner", runnerId?: string): CollabActor => { const actor: CollabActor = { kind: "member", userId: user.userId, username: user.username, displayName: user.displayName, roles: { ...user.roles }, via }; if (runnerId !== undefined) actor.runnerId = runnerId; return actor; };
const runnerPublic = (runner: RunnerRecord, now: number): RunnerPublic => { const pub: RunnerPublic = { id: runner.id, userId: runner.userId, name: runner.name, createdAt: runner.createdAt, lastSeenAt: runner.lastSeenAt, online: runner.revokedAt === undefined && now - runner.lastSeenAt < MAX.heartbeatLiveMs }; if (runner.revokedAt !== undefined) pub.revokedAt = runner.revokedAt; return pub; };

// ---- Stored-document validation: a file that fails is moved aside with the reason, never repaired in place. The same checks run before every write, so the store never writes what it could not read back.
class InvalidDocument extends Error {}
function invalid(what: string): never { throw new InvalidDocument(what); }
function fields(v: unknown, allowed: readonly string[], what: string): Record<string, unknown> { if (!object(v)) invalid(`${what} is not an object`); const extra = Object.keys(v).find((key) => !allowed.includes(key)); if (extra !== undefined) invalid(`${what} has an unknown field ${JSON.stringify(extra.slice(0, 40))}`); return v; }
function time(v: unknown, what: string): number { if (!integer(v)) invalid(`${what} is not a time`); return v; }
function matching(v: unknown, pattern: RegExp, what: string): string { if (typeof v !== "string" || !pattern.test(v) || UNSAFE_KEYS.includes(v)) invalid(`${what} has an unexpected format`); return v; }
function text(v: unknown, max: number, what: string, required = false): string { if (v === undefined && !required) return ""; try { return validateText(v, max, what, { required }); } catch (error) { return invalid(error instanceof Error ? error.message : String(error)); } }
function oneOf<T extends string>(v: unknown, values: readonly T[], what: string): T { if (typeof v !== "string" || !(values as readonly string[]).includes(v)) invalid(`${what} is not one of ${values.join(", ")}`); return v as T; }
function list(v: unknown, max: number, what: string): unknown[] { if (!Array.isArray(v) || v.length > max) invalid(`${what} is not a list of at most ${max} entries`); return v; }
function who(v: unknown, what: string): Who { const w = fields(v, ["userId", "displayName", "via"], what); matching(w.userId, PATH_ID, `${what} user id`); text(w.displayName, MAX.displayName, `${what} display name`, true); if (w.via !== undefined) oneOf(w.via, ["browser", "runner", "local"], `${what} via`); return w as unknown as Who; }
function model<T>(what: string, run: () => T): T { try { return run(); } catch (error) { return invalid(`${what}: ${error instanceof Error ? error.message : String(error)}`); } }
const runnerIdOk = (v: unknown) => v === RUNNER_LOCAL || (typeof v === "string" && RUNNER_ID.test(v));
const TASK_KEYS = ["id", "projectId", "repository", "title", "goal", "acceptance", "status", "blocker", "owner", "collaborators", "reviewer", "dependsOn", "baseRef", "labels", "revision", "createdAt", "updatedAt", "createdBy", "attempts", "checkpoints", "decisions", "discussion", "instructions", "reviews", "handoff", "handoffs", "audit"];
const ATTEMPT_KEYS = ["id", "taskId", "runnerId", "runnerName", "user", "state", "runId", "baseCommit", "fromCheckpointId", "branch", "head", "createdAt", "startedAt", "endedAt", "lastSeq", "lastHeartbeatAt", "progress", "checkpointId", "reason"];
const CHECKPOINT_KEYS = ["id", "taskId", "attemptId", "commit", "baseCommit", "branch", "size", "sha256", "ref", "createdBy", "at", "note", "requirements", "decisions", "testResults", "remaining", "changedFiles", "bundle"];
function validateAttemptRecord(v: unknown, taskId: string): Attempt {
  const a = fields(v, ATTEMPT_KEYS, "attempt"); matching(a.id, ATTEMPT_ID, "attempt id"); if (a.taskId !== taskId) invalid("attempt task id does not match its task"); if (!runnerIdOk(a.runnerId)) invalid("attempt runner id has an unexpected format");
  text(a.runnerName, MAX.runnerName, "runner name", true); who(a.user, "attempt user"); oneOf(a.state, ATTEMPT_STATES, "attempt state"); if (a.runId !== undefined) matching(a.runId, PATH_ID, "attempt run id"); matching(a.baseCommit, COMMIT_ID, "attempt base commit");
  if (a.fromCheckpointId !== undefined) matching(a.fromCheckpointId, CHECKPOINT_ID, "attempt checkpoint id"); if (a.branch !== undefined) text(a.branch, MAX.branch, "attempt branch", true); if (a.head !== undefined) matching(a.head, COMMIT_ID, "attempt head");
  time(a.createdAt, "attempt createdAt"); if (a.startedAt !== undefined) time(a.startedAt, "attempt startedAt"); if (a.endedAt !== undefined) time(a.endedAt, "attempt endedAt"); if (!integer(a.lastSeq)) invalid("attempt lastSeq is not a count"); time(a.lastHeartbeatAt, "attempt heartbeat");
  model("attempt progress", () => validateProgress(a.progress)); if (!object(a.progress) || !integer(a.progress.updatedAt)) invalid("attempt progress has no update time");
  if (a.checkpointId !== undefined) matching(a.checkpointId, CHECKPOINT_ID, "attempt checkpoint"); if (a.reason !== undefined) text(a.reason, MAX.reason, "attempt reason");
  return a as unknown as Attempt;
}
function validateCheckpointRecord(v: unknown, taskId: string): Checkpoint {
  const c = fields(v, CHECKPOINT_KEYS, "checkpoint"), id = matching(c.id, CHECKPOINT_ID, "checkpoint id"); if (c.taskId !== taskId) invalid("checkpoint task id does not match its task"); matching(c.attemptId, ATTEMPT_ID, "checkpoint attempt id");
  model("checkpoint manifest", () => validateCheckpointInput({ commit: c.commit, baseCommit: c.baseCommit, branch: c.branch, size: c.size, sha256: c.sha256, note: c.note, requirements: c.requirements, decisions: c.decisions, testResults: c.testResults, remaining: c.remaining, changedFiles: c.changedFiles }));
  if (c.ref !== `refs/codeflow/team/${id}`) invalid("checkpoint ref does not match its id"); who(c.createdBy, "checkpoint creator"); time(c.at, "checkpoint time"); oneOf(c.bundle, ["pending", "available", "deleted"], "checkpoint bundle state");
  return c as unknown as Checkpoint;
}
function validateEntryRecord(v: unknown, kind: "comment" | "decision" | "instruction" | "review" | "handoff" | "audit"): void {
  switch (kind) {
    case "comment": { const e = fields(v, ["id", "by", "text", "mentions", "at", "kind"], "comment"); matching(e.id, PREFIXED_ID, "comment id"); who(e.by, "comment author"); text(e.text, MAX.text, "comment", true); for (const m of list(e.mentions, 200, "comment mentions")) matching(m, PATH_ID, "mention"); time(e.at, "comment time"); oneOf(e.kind, ["comment", "review-request", "system"], "comment kind"); return; }
    case "decision": { const e = fields(v, ["id", "by", "text", "at"], "decision"); matching(e.id, PREFIXED_ID, "decision id"); who(e.by, "decision author"); text(e.text, MAX.decision, "decision", true); time(e.at, "decision time"); return; }
    case "instruction": { const e = fields(v, ["id", "by", "text", "at", "state", "decidedBy", "decidedAt", "attemptId"], "instruction"); matching(e.id, PREFIXED_ID, "instruction id"); who(e.by, "instruction author"); text(e.text, MAX.text, "instruction", true); time(e.at, "instruction time"); oneOf(e.state, ["proposed", "approved", "declined", "delivered"], "instruction state"); if (e.decidedBy !== undefined) who(e.decidedBy, "instruction decider"); if (e.decidedAt !== undefined) time(e.decidedAt, "instruction decision time"); if (e.attemptId !== undefined) matching(e.attemptId, ATTEMPT_ID, "instruction attempt"); return; }
    case "review": { const e = fields(v, ["id", "checkpointId", "commit", "by", "verdict", "text", "at", "stale"], "review"); matching(e.id, PREFIXED_ID, "review id"); matching(e.checkpointId, CHECKPOINT_ID, "review checkpoint"); matching(e.commit, COMMIT_ID, "review commit"); who(e.by, "reviewer"); oneOf(e.verdict, ["approve", "request-changes"], "review verdict"); text(e.text, MAX.text, "review"); time(e.at, "review time"); if (typeof e.stale !== "boolean") invalid("review stale flag"); return; }
    case "handoff": { const e = fields(v, ["id", "from", "to", "checkpointId", "note", "state", "offeredAt", "respondedAt", "reason"], "hand-over"); matching(e.id, PREFIXED_ID, "hand-over id"); who(e.from, "hand-over sender"); who(e.to, "hand-over recipient"); matching(e.checkpointId, CHECKPOINT_ID, "hand-over checkpoint"); text(e.note, MAX.note, "hand-over note"); oneOf(e.state, ["offered", "accepted", "declined", "cancelled"], "hand-over state"); time(e.offeredAt, "hand-over time"); if (e.respondedAt !== undefined) time(e.respondedAt, "hand-over response time"); if (e.reason !== undefined) text(e.reason, MAX.reason, "hand-over reason"); return; }
    case "audit": { const e = fields(v, ["at", "by", "action", "detail"], "audit entry"); time(e.at, "audit time"); who(e.by, "audit actor"); text(e.action, MAX.auditAction, "audit action", true); if (e.detail !== undefined) text(e.detail, MAX.auditDetail, "audit detail"); return; }
  }
}
function validateTaskRecord(v: unknown): Task {
  const t = fields(v, TASK_KEYS, "task"), id = matching(t.id, TASK_ID, "task id"); matching(t.projectId, PATH_ID, "task project id"); matching(t.repository, REPO_KEY, "task repository key");
  text(t.title, MAX.title, "title", true); text(t.goal, MAX.goal, "goal"); text(t.acceptance, MAX.acceptance, "acceptance criteria"); const status = oneOf(t.status, TASK_STATUSES, "task status");
  if (t.blocker !== undefined) text(t.blocker, MAX.blocker, "blocker", true); if (status === "blocked" && typeof t.blocker !== "string") invalid("blocked task has no blocker");
  if (t.owner !== undefined) who(t.owner, "task owner"); for (const c of list(t.collaborators, MAX.collaborators, "collaborators")) who(c, "collaborator"); if (t.reviewer !== undefined) who(t.reviewer, "task reviewer");
  for (const d of list(t.dependsOn, MAX.dependsOn, "dependencies")) matching(d, TASK_ID, "dependency"); if (t.baseRef !== undefined) text(t.baseRef, MAX.baseRef, "base branch", true); for (const l of list(t.labels, MAX.labels, "labels")) text(l, MAX.label, "label", true);
  if (!integer(t.revision) || t.revision < 1) invalid("task revision is not a positive count"); time(t.createdAt, "task createdAt"); time(t.updatedAt, "task updatedAt"); who(t.createdBy, "task creator");
  const attempts = new Set<string>(); for (const a of list(t.attempts, MAX.attempts, "attempts")) { const attempt = validateAttemptRecord(a, id); if (attempts.has(attempt.id)) invalid(`duplicate attempt ${attempt.id}`); attempts.add(attempt.id); }
  const checkpoints = new Set<string>(); for (const c of list(t.checkpoints, MAX.checkpoints, "checkpoints")) { const checkpoint = validateCheckpointRecord(c, id); if (checkpoints.has(checkpoint.id)) invalid(`duplicate checkpoint ${checkpoint.id}`); checkpoints.add(checkpoint.id); }
  for (const e of list(t.decisions, MAX.decisions, "decisions")) validateEntryRecord(e, "decision"); for (const e of list(t.discussion, MAX.discussion, "discussion")) validateEntryRecord(e, "comment"); for (const e of list(t.instructions, MAX.instructions, "instructions")) validateEntryRecord(e, "instruction");
  for (const e of list(t.reviews, MAX.reviews, "reviews")) validateEntryRecord(e, "review"); if (t.handoff !== undefined) validateEntryRecord(t.handoff, "handoff"); for (const e of list(t.handoffs, MAX.handoffs, "hand-over history")) validateEntryRecord(e, "handoff"); for (const e of list(t.audit, MAX.audit, "audit")) validateEntryRecord(e, "audit");
  return t as unknown as Task;
}
/** `trusted` holds task objects this validator already passed: the store mutates tasks only through clones, so an untouched task is the very object validated at load or at the last write and needs no second pass, which keeps a write's cost proportional to what changed rather than to the board. The cross-task checks (duplicate ids, an attempt or checkpoint in two tasks) still cover every task. */
function validateBoardDocument(raw: unknown, trusted?: WeakSet<object>): BoardDocument {
  const d = fields(raw, ["version", "revision", "ownerName", "projects", "tasks"], "board"); if (d.version !== 1) invalid("board version is not 1"); if (!integer(d.revision)) invalid("board revision is not a count"); if (d.ownerName !== undefined) text(d.ownerName, MAX.displayName, "owner name", true);
  if (!object(d.projects)) invalid("board projects is not a map"); for (const [projectId, entry] of Object.entries(d.projects)) { matching(projectId, PATH_ID, "project id"); const p = fields(entry, ["repositories"], `project ${projectId}`); model(`project ${projectId} repositories`, () => validateRepoRefs(p.repositories)); }
  const ids = new Set<string>(), attempts = new Set<string>(), checkpoints = new Set<string>();
  for (const entry of list(d.tasks, MAX.tasks, "tasks")) {
    const task = trusted?.has(entry as object) ? entry as Task : validateTaskRecord(entry); trusted?.add(task); if (ids.has(task.id)) invalid(`duplicate task ${task.id}`); ids.add(task.id);
    for (const a of task.attempts) { if (attempts.has(a.id)) invalid(`attempt ${a.id} appears in two tasks`); attempts.add(a.id); } for (const c of task.checkpoints) { if (checkpoints.has(c.id)) invalid(`checkpoint ${c.id} appears in two tasks`); checkpoints.add(c.id); }
  }
  return d as unknown as BoardDocument;
}
function validateRunnersDocument(raw: unknown): RunnersDocument {
  const d = fields(raw, ["version", "runners"], "runners"); if (d.version !== 1) invalid("runners version is not 1"); const ids = new Set<string>(), hashes = new Set<string>();
  for (const entry of list(d.runners, MAX.runners, "runners")) {
    const r = fields(entry, ["id", "userId", "name", "tokenHash", "createdAt", "lastSeenAt", "revokedAt", "lastAddress"], "runner"), id = matching(r.id, RUNNER_ID, "runner id"), hash = matching(r.tokenHash, SHA256_HEX, "runner token hash");
    matching(r.userId, PATH_ID, "runner account"); text(r.name, MAX.runnerName, "runner name", true); time(r.createdAt, "runner createdAt"); time(r.lastSeenAt, "runner lastSeenAt"); if (r.revokedAt !== undefined) time(r.revokedAt, "runner revokedAt"); if (r.lastAddress !== undefined) text(r.lastAddress, 128, "runner address");
    if (ids.has(id) || hashes.has(hash)) invalid(`duplicate runner ${id}`); ids.add(id); hashes.add(hash);
  }
  return d as unknown as RunnersDocument;
}
function validateInboxDocument(raw: unknown): InboxDocument {
  const d = fields(raw, ["version", "items"], "inbox"); if (d.version !== 1) invalid("inbox version is not 1"); const ids = new Set<string>();
  for (const entry of list(d.items, MAX.inboxTotal, "inbox items")) {
    const i = fields(entry, ["id", "userId", "kind", "taskId", "taskTitle", "text", "by", "at", "readAt"], "inbox item"), id = matching(i.id, PREFIXED_ID, "inbox item id"); matching(i.userId, PATH_ID, "inbox account"); oneOf(i.kind, INBOX_KINDS, "inbox kind"); matching(i.taskId, TASK_ID, "inbox task");
    text(i.taskTitle, MAX.title, "inbox task title", true); text(i.text, MAX.inboxText, "inbox text"); who(i.by, "inbox actor"); time(i.at, "inbox time"); if (i.readAt !== undefined) time(i.readAt, "inbox read time"); if (ids.has(id)) invalid(`duplicate inbox item ${id}`); ids.add(id);
  }
  return d as unknown as InboxDocument;
}
const emptyBoard = (): BoardDocument => ({ version: 1, revision: 0, projects: {}, tasks: [] }), emptyRunners = (): RunnersDocument => ({ version: 1, runners: [] }), emptyInbox = (): InboxDocument => ({ version: 1, items: [] });
/** Bounded with O_NOFOLLOW like every store here: ENOENT is "no document yet", a parse failure is a corrupt file (the caller moves it aside), anything else leaves the store unavailable. */
async function readDocument(file: string): Promise<unknown> {
  let body: string;
  try { const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const info = await handle.stat(); if (!info.isFile()) throw new Error(`${file} is not a regular file`); if (info.size > READ_LIMIT) throw new Error(`${file} exceeds the 16 MiB limit`); body = await handle.readFile("utf8"); } finally { await handle.close(); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return JSON.parse(body); } catch (error) { throw new InvalidDocument(`not valid JSON (${(error as Error).message})`); }
}

export class CollabStore {
  readonly dir: string; private readonly bundleDir: string;
  private state: State = { board: emptyBoard(), runners: emptyRunners(), inbox: emptyInbox() };
  private loaded = false; private loading?: Promise<void>; private readable = true; private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(event: ChangeEvent) => void>(); private readonly ring: ChangeEvent[] = []; private seq = 0;
  /** Random per process: a client whose cursor names another epoch gets a resync instead of a replay from the wrong ring. */
  readonly epoch: string;
  /** Write-behind state: runner lastSeen touches and board telemetry wait for the next durable change or the flush timer. */
  private runnersDirty = false; private boardPending = false; private flushTimer?: NodeJS.Timeout;
  /** Task objects validateBoardDocument has passed, so a write re-validates only the tasks the mutation cloned. */
  private readonly validated = new WeakSet<object>();
  /** Documents that did not load as written (set aside or unreadable); a bundle sweep never trusts a board that was. */
  private readonly degraded = new Set<string>();
  private readonly random: RandomSource; private readonly now: () => number;
  constructor(private readonly options: CollabStoreOptions) { this.dir = options.dir ?? join(CODEFLOW_HOME, "team"); this.bundleDir = join(this.dir, "checkpoints"); this.random = options.random ?? randomBytes; this.now = options.now ?? Date.now; this.epoch = this.random(8).toString("hex"); }
  get available() { return this.loaded && this.readable; }
  /** The hub owner's display name as teammates see it: the saved profile, else what the server passes, else "Owner". */
  get ownerName(): string { return this.state.board.ownerName ?? this.options.ownerName?.() ?? "Owner"; }
  load(): Promise<void> {
    return this.loading ??= (async () => {
      try { await mkdir(this.bundleDir, { recursive: true, mode: 0o700 }); } catch (error) { this.readable = false; logError(`Couldn't create ${this.dir}; the team board is unavailable until it can be created`, error); }
      const board = await this.loadDocument("board.json", (raw) => validateBoardDocument(raw, this.validated), emptyBoard), runners = await this.loadDocument("runners.json", validateRunnersDocument, emptyRunners), inbox = await this.loadDocument("inbox.json", validateInboxDocument, emptyInbox);
      this.state = { board, runners, inbox }; this.loaded = true;
      if (this.readable) await this.sweepBundles(board, !this.degraded.has("board.json"));
    })();
  }
  /** Removes what an upload interrupted by a crash, or a crash between a board write and its cleanup, left in `checkpoints/`: temp files always, and bundle files no available checkpoint names only when board.json itself loaded, since a board set aside as corrupt may be repaired and still name them. Runs once, at load, when no upload is in flight. */
  private async sweepBundles(board: BoardDocument, unreferenced: boolean): Promise<void> {
    const wanted = new Set<string>(); for (const task of board.tasks) for (const checkpoint of task.checkpoints) if (checkpoint.bundle === "available") wanted.add(`${checkpoint.id}.bundle`);
    let names: string[]; try { names = await readdir(this.bundleDir); } catch (error) { logError(`The checkpoint folder ${this.bundleDir} could not be listed for cleanup`, error); return; }
    const stale = names.filter((name) => /^[a-f0-9]{32}\.bundle\.[a-f0-9]{12}\.tmp$/.test(name) || (unreferenced && /^[a-f0-9]{32}\.bundle$/.test(name) && !wanted.has(name)));
    for (const name of stale) await rm(join(this.bundleDir, name), { force: true }).catch((error) => logError(`Stale checkpoint file ${name} could not be removed from ${this.bundleDir}`, error));
    if (stale.length) logWarn(`Removed ${stale.length} stale checkpoint file(s) left in ${this.bundleDir} by an interrupted upload or cleanup`);
  }
  /** Persists pending telemetry and runner lastSeen touches and stops the write-behind timer; nothing else is held open. */
  async close(): Promise<void> { if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; } if ((this.runnersDirty || this.boardPending) && this.available) await this.change(() => undefined).catch(() => undefined); }
  /** Arms the 30 s write-behind once; a durable change in the meantime carries the pending documents along and the timer finds nothing to do. */
  private armFlush(): void { this.flushTimer ??= setTimeout(() => { this.flushTimer = undefined; if ((this.runnersDirty || this.boardPending) && this.available) this.change(() => undefined).catch(() => undefined); }, FLUSH_MS); this.flushTimer.unref?.(); }
  onChange(listener: (event: ChangeEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Replays the ring after `<epoch>:<seq>`; a cursor from another process or older than the ring asks the client to reload instead of missing changes silently. */
  eventsSince(cursor?: string): EventPage {
    const page: EventPage = { epoch: this.epoch, seq: this.seq, events: [], resync: false }; if (cursor === undefined || cursor === "") return page;
    const match = /^([a-f0-9]{16}):(\d{1,15})$/.exec(cursor); if (!match || match[1] !== this.epoch) return { ...page, resync: true };
    const after = Number(match[2]), first = this.ring[0]; if (after > this.seq || (after < this.seq && (!first || first.seq > after + 1))) return { ...page, resync: true };
    page.events = this.ring.filter((event) => event.seq > after); return page;
  }

  // ---- Reads
  async board(actor: CollabActor, projectId?: string): Promise<Board> {
    await this.load(); this.require(); const now = this.now(), { board, inbox, runners } = this.state;
    let projects = this.options.projects().filter((project) => actorRole(actor, project.id) !== undefined);
    if (projectId !== undefined) { const one = projects.find((project) => project.id === projectId); if (!one) throw new CollabError("Project not found", 404); projects = [one]; }
    const visible = new Set(projects.map((project) => project.id)), mentions = new Map<string, number>(); let inboxUnread = 0;
    for (const item of this.visibleInbox(board, inbox, actor)) if (item.readAt === undefined) { inboxUnread++; if (item.kind === "mention") mentions.set(item.taskId, (mentions.get(item.taskId) ?? 0) + 1); }
    const online = this.onlineUsers(now), roles: Record<string, SharedRole> = actor.kind === "owner" ? Object.fromEntries(this.options.projects().map((project) => [project.id, "maintainer"])) : { ...actor.roles };
    const me: Board["me"] = { ...whoOf(actor), roles, runners: runners.runners.filter((runner) => runner.userId === actor.userId).map((runner) => runnerPublic(runner, now)) };
    return { revision: board.revision, projects: projects.map((project) => this.projectView(board, project, actor, online)), tasks: board.tasks.filter((task) => visible.has(task.projectId)).map((task) => summarize(task, actor.userId, now, mentions.get(task.id) ?? 0)), me, inboxUnread };
  }
  async task(actor: CollabActor, id: string): Promise<Task> { await this.load(); this.require(); return clone(this.findTask(this.state.board, actor, id)); }
  async inbox(actor: CollabActor, after?: unknown): Promise<{ items: InboxItem[]; unread: number }> {
    await this.load(); this.require(); const since = after === undefined || after === null || after === "" ? undefined : Number(after); if (since !== undefined && !Number.isSafeInteger(since)) throw new CollabError("Send after as a Unix time in milliseconds");
    const mine = this.visibleInbox(this.state.board, this.state.inbox, actor);
    return { items: clone(mine.filter((item) => since === undefined || item.at > since).reverse()), unread: mine.filter((item) => item.readAt === undefined).length };
  }
  /** Runners are account-wide: only the hub owner may see or revoke another account's runners. */
  async runners(actor: CollabActor): Promise<RunnerPublic[]> { await this.load(); this.require(); const now = this.now(), all = this.seesAllRunners(actor); return this.state.runners.runners.filter((runner) => all || runner.userId === actor.userId).map((runner) => runnerPublic(runner, now)); }
  /** Constant-time against every stored hash; a revoked runner or a disabled account is refused. lastSeenAt moves at most every 10 s and reaches disk with the next mutation or the 30 s write-behind, so a heartbeat storm never turns into an fsync storm. */
  authenticateRunner(token: unknown): { runnerId: string; userId: string } | undefined {
    if (!this.available || typeof token !== "string" || !RUNNER_TOKEN.test(token)) return undefined;
    const hash = Buffer.from(sha256Hex(token), "hex"); let match: RunnerRecord | undefined;
    for (const runner of this.state.runners.runners) { const stored = Buffer.from(runner.tokenHash, "hex"); if (stored.length === hash.length && timingSafeEqual(stored, hash) && !match) match = runner; }
    if (!match || match.revokedAt !== undefined) return undefined; const userId = match.userId;
    const member = this.options.members().find((entry) => entry.userId === userId); if (!member?.enabled) return undefined;
    const now = this.now(); if (now - match.lastSeenAt >= TOUCH_MS) { match.lastSeenAt = now; this.runnersDirty = true; this.armFlush(); }
    return { runnerId: match.id, userId };
  }

  // ---- Shared helpers
  private require() { if (!this.loaded) throw new CollabError("Team storage has not finished loading; retry in a moment", 503); if (!this.readable) throw new CollabError(`Team storage is unavailable; repair the files in ${this.dir} (see server.log), then restart code-flow`, 503); }
  private bundleFile(checkpointId: string) { return join(this.bundleDir, `${checkpointId}.bundle`); }
  private onlineUsers(now: number): Set<string> { const online = new Set<string>(); for (const runner of this.state.runners.runners) if (runner.revokedAt === undefined && now - runner.lastSeenAt < MAX.heartbeatLiveMs) online.add(runner.userId); return online; }
  private seesAllRunners(actor: CollabActor) { return actor.kind === "owner"; }
  private visibleInbox(board: BoardDocument, inbox: InboxDocument, actor: CollabActor): InboxItem[] {
    const projects = new Set(this.options.projects().filter((project) => actorRole(actor, project.id) !== undefined).map((project) => project.id));
    const tasks = new Set(board.tasks.filter((task) => projects.has(task.projectId)).map((task) => task.id));
    return inbox.items.filter((item) => item.userId === actor.userId && tasks.has(item.taskId));
  }
  private projectView(board: BoardDocument, project: ProjectRecord, actor: CollabActor, online: Set<string>): BoardProject {
    const members: BoardProject["members"] = [{ userId: "owner", username: "owner", displayName: this.ownerName, role: "maintainer", online: true }];
    for (const member of this.membersOf(project.id)) members.push({ userId: member.userId, username: member.username, displayName: member.displayName, role: member.roles[project.id]!, online: online.has(member.userId) });
    return { id: project.id, name: project.name, role: actorRole(actor, project.id)!, repositories: clone(Object.hasOwn(board.projects, project.id) ? board.projects[project.id]!.repositories : []), members };
  }
  private membersOf(projectId: string): MemberRecord[] { return this.options.members().filter((member) => member.enabled && Object.hasOwn(member.roles, projectId) && member.roles[projectId] !== undefined); }
  /** `@owner` reaches the person running the hub first, then members by username (model.mentionsIn keeps the first listed on a clash). */
  private mentionTargets(projectId: string) { return [{ userId: "owner", username: "owner" }, ...this.membersOf(projectId).map((member) => ({ userId: member.userId, username: member.username }))]; }
  /** Unknown ids and ids in projects where the actor holds no role are the same 404, so a task id never confirms existence. */
  private findTask(board: BoardDocument, actor: CollabActor, id: unknown): Task { const task = typeof id === "string" && TASK_ID.test(id) ? board.tasks.find((entry) => entry.id === id) : undefined; if (!task || actorRole(actor, task.projectId) === undefined) throw new CollabError("Task not found", 404); return task; }
  private findAttempt(board: BoardDocument, actor: CollabActor, id: unknown): { task: Task; attempt: Attempt } { const found = this.attemptById(board, id); if (!found || actorRole(actor, found.task.projectId) === undefined) throw new CollabError("Attempt not found", 404); return found; }
  private attemptById(board: BoardDocument, id: unknown): { task: Task; attempt: Attempt } | undefined { if (typeof id !== "string" || !ATTEMPT_ID.test(id)) return undefined; for (const task of board.tasks) { const attempt = task.attempts.find((entry) => entry.id === id); if (attempt) return { task, attempt }; } return undefined; }
  private findCheckpoint(board: BoardDocument, actor: CollabActor, id: unknown): { task: Task; checkpoint: Checkpoint; attempt: Attempt } {
    if (typeof id === "string" && CHECKPOINT_ID.test(id)) for (const task of board.tasks) { const checkpoint = task.checkpoints.find((entry) => entry.id === id); if (checkpoint && actorRole(actor, task.projectId) !== undefined) { const attempt = task.attempts.find((entry) => entry.id === checkpoint.attemptId); if (attempt) return { task, checkpoint, attempt }; } }
    throw new CollabError("Checkpoint not found", 404);
  }
  private project(projectId: unknown, actor: CollabActor): ProjectRecord { const project = typeof projectId === "string" ? this.options.projects().find((entry) => entry.id === projectId) : undefined; if (!project || actorRole(actor, project.id) === undefined) throw new CollabError("Project not found", 404); return project; }
  private need(actor: CollabActor, projectId: string, role: SharedRole, action: string): SharedRole { const held = actorRole(actor, projectId); if (!roleAtLeast(held, role)) throw new CollabError(`A project ${role} role is required to ${action}`, 403); return held!; }
  /** Progress, heartbeats, finishes and checkpoints come only from the machine executing the attempt: the owner process for "local" attempts, otherwise the very runner credential the attempt was claimed with, used by the same account. */
  private assertAttemptRunner(attempt: Attempt, actor: CollabActor): void {
    const ok = actor.kind === "owner" ? attempt.runnerId === RUNNER_LOCAL && attempt.user.userId === "owner" : actor.via === "runner" && actor.runnerId !== undefined && actor.runnerId === attempt.runnerId && actor.userId === attempt.user.userId;
    if (!ok) throw new CollabError("Only the runner executing this attempt may report on it", 403);
  }
  private cas(task: Task, revision: unknown): void { if (revision === undefined || revision === null) throw new CollabError("Send the task's current revision with the change"); if (!integer(revision) || revision !== task.revision) throw new CollabError("Task changed; reload before saving", 409); }
  private resolveWho(projectId: string, userId: unknown, minRole: SharedRole, label: string): Who {
    const id = validateUserRef(userId, label); if (id === "owner") return { userId: "owner", displayName: this.ownerName };
    const member = this.options.members().find((entry) => entry.userId === id); if (!member || !member.enabled || !Object.hasOwn(member.roles, projectId)) throw new CollabError(`Choose the ${label} from the project's members`);
    if (!roleAtLeast(member.roles[projectId], minRole)) throw new CollabError(`The ${label} needs at least the ${minRole} role in this project`); return { userId: member.userId, displayName: member.displayName };
  }
  private assertRepository(board: BoardDocument, projectId: string, key: string): void { const repositories = Object.hasOwn(board.projects, projectId) ? board.projects[projectId]!.repositories : []; if (!repositories.some((repo) => repo.key === key)) throw new CollabError(repositories.length ? `Choose the repository from this project's keys: ${repositories.map((repo) => repo.key).join(", ")}` : "Define this project's repository keys in People first"); }
  private dependencies(board: BoardDocument, projectId: string, ids: string[], self: string | undefined): string[] { for (const id of ids) if (id === self || !board.tasks.some((task) => task.id === id && task.projectId === projectId)) throw new CollabError("Choose the tasks this one depends on from the board"); return ids; }
  private stakeholders(task: Task): string[] { const ids = task.collaborators.map((who) => who.userId); if (task.owner) ids.unshift(task.owner.userId); if (task.reviewer) ids.push(task.reviewer.userId); return ids; }
  /** Every change to a task bumps the task and board revisions and leaves an audit line; progress and heartbeats bypass this on purpose. */
  private commit(draft: Draft, task: Task, by: Who, action: string, detail: string | undefined, now: number): void { task.revision++; task.updatedAt = now; recordAudit(task, by, action, detail, now); draft.board.revision++; draft.dirty.add("board"); draft.events.push({ kind: "task", taskId: task.id, projectId: task.projectId }); }
  /** A system line in the discussion; skipped rather than failing the mutation when the discussion is full. */
  private system(task: Task, by: Who, text: string, now: number, kind: Comment["kind"] = "system"): void { if (task.discussion.length < MAX.discussion) task.discussion.push({ id: newId("comment", this.random), by, text, mentions: [], at: now, kind }); }
  /** Inbox items for everyone named except the actor; each user keeps at most 500 (oldest read first), the hub at most 5000. */
  private notify(draft: Draft, task: Task, actor: CollabActor, userIds: Iterable<string>, kind: InboxKind, text: string): void {
    if (!this.options.projects().some((project) => project.id === task.projectId)) return;
    const members = new Set(["owner", ...this.membersOf(task.projectId).map((member) => member.userId)]);
    const targets = new Set([...userIds].filter((id) => members.has(id))); targets.delete(actor.userId); if (!targets.size) return; const now = this.now(), items = draft.inbox.items;
    for (const userId of targets) {
      items.push({ id: newId("inbox", this.random), userId, kind, taskId: task.id, taskTitle: task.title, text: truncateText(text, MAX.inboxText), by: whoOf(actor), at: now });
      const mine = items.filter((item) => item.userId === userId); while (mine.length > MAX.inboxPerUser) { const victim = mine.find((item) => item.readAt !== undefined) ?? mine[0]!; items.splice(items.indexOf(victim), 1); mine.splice(mine.indexOf(victim), 1); }
    }
    while (items.length > MAX.inboxTotal) { const victim = items.find((item) => item.readAt !== undefined) ?? items[0]!; items.splice(items.indexOf(victim), 1); }
    draft.dirty.add("inbox"); draft.events.push({ kind: "inbox", userIds: [...targets] });
  }

  // ---- Persistence
  private async loadDocument<T>(name: string, validate: (raw: unknown) => T, empty: () => T): Promise<T> {
    const file = join(this.dir, name); let raw: unknown;
    try { raw = await readDocument(file); } catch (error) { this.degraded.add(name); if (error instanceof InvalidDocument) return this.setAside(file, error.message, empty); this.readable = false; logError(`Couldn't read ${file}; the team board is unavailable and the file is left untouched until it can be read`, error); return empty(); }
    if (raw === undefined) return empty();
    try { return validate(raw); } catch (error) { this.degraded.add(name); return this.setAside(file, error instanceof Error ? error.message : String(error), empty); }
  }
  private async setAside<T>(file: string, why: string, empty: () => T): Promise<T> {
    const aside = `${file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
    try { await rename(file, aside); logError(`${file} is unusable (${why}): moved it to ${aside}; the team board starts without it`); }
    catch (error) { this.readable = false; logError(`${file} is unusable (${why}) and couldn't be moved aside; the team board is unavailable until it's fixed`, error); }
    return empty();
  }
  private serialize<T>(document: T, validate: (raw: unknown) => T, name: string): string {
    try { validate(document); } catch (error) { throw new CollabError(`Team storage refused to write an inconsistent ${name} document: ${error instanceof Error ? error.message : String(error)}`, 500); }
    // Deleting a checkpoint keeps its manifest (and adds an audit line), so only deleting tasks makes the board smaller.
    const body = JSON.stringify(document); if (Buffer.byteLength(body) > READ_LIMIT) throw new CollabError(`The team ${name} has reached its 16 MiB storage limit; delete finished tasks first`, 413); return body;
  }
  private async writeDocument(name: string, body: string): Promise<void> {
    const file = join(this.dir, name);
    try { const info = await lstat(file); if (!info.isFile()) throw new CollabError(`Refusing to replace ${file}: it is not a regular file`, 503); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = `${file}.${this.random(8).toString("hex")}.tmp`;
    try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); } await rename(temp, file); await chmod(file, 0o600); if (process.platform !== "win32") { const dir = await open(this.dir, "r"); try { await dir.sync(); } finally { await dir.close(); } } }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  private draft(): Draft {
    const state = this.state, cloned = new Map<string, Task>(); let runners: RunnersDocument | undefined, inbox: InboxDocument | undefined;
    const draft: Draft = {
      board: { ...state.board, projects: { ...state.board.projects }, tasks: [...state.board.tasks] }, dirty: new Set(), events: [], after: [], undo: [],
      get runners() { return runners ??= clone(state.runners); }, get inbox() { return inbox ??= clone(state.inbox); },
      task(id, dirty = "board") { let task = cloned.get(id); if (!task) { const index = draft.board.tasks.findIndex((entry) => entry.id === id); if (index < 0) return undefined; task = clone(draft.board.tasks[index]!); draft.board.tasks[index] = task; cloned.set(id, task); } draft.dirty.add(dirty); return task; },
      snapshot: () => ({ board: draft.board, runners: runners ?? state.runners, inbox: inbox ?? state.inbox }),
    };
    return draft;
  }
  /** The one mutation queue: apply to a draft, validate, write the touched documents (board last, as the commit point), swap, then announce. A failed write leaves memory and the announced state untouched. A mutation that touched telemetry alone skips the write: it is swapped in and announced, and the board is flagged for the next durable change or the write-behind timer. */
  private change<T>(fn: (draft: Draft) => T | Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(async () => {
      await this.load(); this.require(); const draft = this.draft(); const result = await fn(draft);
      if (draft.dirty.has("telemetry") && draft.dirty.size === 1) { this.state = draft.snapshot(); this.boardPending = true; this.armFlush(); this.announce(draft); return result; }
      if (this.runnersDirty) draft.dirty.add("runners"); if (this.boardPending || draft.dirty.delete("telemetry")) draft.dirty.add("board");
      if (draft.dirty.size) {
        const bodies: [string, string][] = [];
        if (draft.dirty.has("runners")) bodies.push(["runners.json", this.serialize(draft.runners, validateRunnersDocument, "runners")]);
        if (draft.dirty.has("inbox")) bodies.push(["inbox.json", this.serialize(draft.inbox, validateInboxDocument, "inbox")]);
        if (draft.dirty.has("board")) bodies.push(["board.json", this.serialize(draft.board, (raw) => validateBoardDocument(raw, this.validated), "board")]);
        try { for (const [name, body] of bodies) await this.writeDocument(name, body); }
        catch (error) { for (const undo of draft.undo) await undo().catch(() => undefined); throw error instanceof CollabError ? error : new CollabError(`Team storage could not be written: ${error instanceof Error ? error.message : String(error)}`, 503); }
        this.state = draft.snapshot(); if (draft.dirty.has("runners")) this.runnersDirty = false; if (draft.dirty.has("board")) this.boardPending = false;
        this.announce(draft);
        for (const task of draft.after) await task().catch((error) => logError("Team storage could not finish a cleanup after a durable change", error));
      }
      return result;
    });
    this.queue = run; return run;
  }
  /** Each distinct event once, in order; listeners that throw cannot undo a durable change. */
  private announce(draft: Draft): void { const seen = new Set<string>(); for (const event of draft.events) { const key = JSON.stringify(event); if (!seen.has(key)) { seen.add(key); this.emit(event); } } }
  /** Wake project-filtered team views after a durable host queue or policy change. */
  hostExecutionChanged(projectId?: string, taskId?: string): void { if (projectId) this.emit({ kind: "task", projectId, taskId }); else for (const project of this.options.projects()) this.emit({ kind: "task", projectId: project.id }); }
  private emit(event: Omit<ChangeEvent, "seq">): void { const full: ChangeEvent = { ...event, seq: ++this.seq }; this.ring.push(full); if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING); for (const listener of this.listeners) { try { listener(full); } catch { /* a failed stream callback cannot undo a durable change */ } } }

  // ---- Tasks
  async createTask(actor: CollabActor, input: unknown): Promise<Task> {
    const data = validateTaskInput(input);
    return this.change((draft) => {
      const now = this.now(), project = this.project(data.projectId, actor), by = whoOf(actor); this.need(actor, project.id, "contributor", "create tasks"); this.assertRepository(draft.board, project.id, data.repository);
      const task: Task = { id: newTaskId(this.random), projectId: project.id, repository: data.repository, title: data.title, goal: data.goal, acceptance: data.acceptance, status: "planned", collaborators: data.collaborators.map((id) => this.resolveWho(project.id, id, "viewer", "collaborator")), dependsOn: this.dependencies(draft.board, project.id, data.dependsOn, undefined), labels: data.labels, revision: 1, createdAt: now, updatedAt: now, createdBy: by, attempts: [], checkpoints: [], decisions: [], discussion: [], instructions: [], reviews: [], handoffs: [], audit: [] };
      if (data.baseRef) task.baseRef = data.baseRef; if (data.reviewer) task.reviewer = this.resolveWho(project.id, data.reviewer, "reviewer", "reviewer");
      if (data.owner) { const owner = this.resolveWho(project.id, data.owner, "contributor", "owner"); assertCanChangeOwner(task, actor, owner); assignOwner(task, owner, now); }
      if (data.status !== "planned") transition(task, data.status, actor, data.blocker, now);
      recordAudit(task, by, "created", undefined, now); pushBounded(draft.board.tasks, task, MAX.tasks, "tasks"); draft.board.revision++; draft.dirty.add("board"); draft.events.push({ kind: "task", taskId: task.id, projectId: task.projectId }, { kind: "board", projectId: task.projectId });
      if (task.owner) this.notify(draft, task, actor, [task.owner.userId], "assigned", `${actor.displayName} assigned you “${task.title}”`);
      if (task.reviewer) this.notify(draft, task, actor, [task.reviewer.userId], "review-requested", `${actor.displayName} asked you to review “${task.title}”`);
      if (task.status === "blocked") this.notify(draft, task, actor, this.stakeholders(task), "blocked", `“${task.title}” is blocked: ${task.blocker}`);
      return clone(task);
    });
  }
  /** A partial save under the owner rules (assertCanChangeOwner/assignOwner) and the status rules (transition); `null` clears an optional field. */
  async updateTask(actor: CollabActor, id: string, patch: unknown, revision: unknown): Promise<Task> {
    const changes = validateTaskPatch(patch);
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, id); this.need(actor, current.projectId, "contributor", "edit tasks"); this.cas(current, revision);
      const task = draft.task(current.id)!, changed: string[] = [], before = { owner: task.owner?.userId, reviewer: task.reviewer?.userId, status: task.status };
      if (changes.repository !== undefined && changes.repository !== task.repository) { this.assertRepository(draft.board, task.projectId, changes.repository); task.repository = changes.repository; changed.push("repository"); }
      if (changes.title !== undefined && changes.title !== task.title) { task.title = changes.title; changed.push("title"); } if (changes.goal !== undefined && changes.goal !== task.goal) { task.goal = changes.goal; changed.push("goal"); } if (changes.acceptance !== undefined && changes.acceptance !== task.acceptance) { task.acceptance = changes.acceptance; changed.push("acceptance"); }
      if (changes.labels !== undefined) { task.labels = changes.labels; changed.push("labels"); } if (changes.dependsOn !== undefined) { task.dependsOn = this.dependencies(draft.board, task.projectId, changes.dependsOn, task.id); changed.push("dependencies"); }
      if (changes.baseRef !== undefined) { if (changes.baseRef === null) delete task.baseRef; else task.baseRef = changes.baseRef; changed.push("base"); }
      if (changes.collaborators !== undefined) { task.collaborators = changes.collaborators.map((userId) => this.resolveWho(task.projectId, userId, "viewer", "collaborator")); changed.push("collaborators"); }
      if (changes.reviewer !== undefined) { if (changes.reviewer === null) delete task.reviewer; else task.reviewer = this.resolveWho(task.projectId, changes.reviewer, "reviewer", "reviewer"); changed.push("reviewer"); }
      if (changes.owner !== undefined) { const next = changes.owner === null ? undefined : this.resolveWho(task.projectId, changes.owner, "contributor", "owner"); assertCanChangeOwner(task, actor, next); assignOwner(task, next, now); changed.push("owner"); }
      if (changes.status !== undefined || changes.blocker !== undefined) { transition(task, changes.status ?? task.status, actor, changes.blocker, now); changed.push(changes.status !== undefined ? "status" : "blocker"); }
      this.commit(draft, task, whoOf(actor), "updated", changed.join(", ") || undefined, now);
      if (task.owner && task.owner.userId !== before.owner) this.notify(draft, task, actor, [task.owner.userId], "assigned", `${actor.displayName} assigned you “${task.title}”`);
      if (task.reviewer && task.reviewer.userId !== before.reviewer) this.notify(draft, task, actor, [task.reviewer.userId], "review-requested", `${actor.displayName} asked you to review “${task.title}”`);
      if (task.status === "blocked" && before.status !== "blocked") this.notify(draft, task, actor, this.stakeholders(task), "blocked", `“${task.title}” is blocked: ${task.blocker}`);
      return clone(task);
    });
  }
  async deleteTask(actor: CollabActor, id: string, revision: unknown): Promise<{ deleted: true }> {
    return this.change((draft) => {
      const now = this.now(), task = this.findTask(draft.board, actor, id); this.need(actor, task.projectId, "maintainer", "delete tasks"); this.cas(task, revision);
      const busy = busyAttempt(task); if (busy) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before deleting the task`, 409);
      draft.board.tasks = draft.board.tasks.filter((entry) => entry.id !== task.id); draft.board.revision++; draft.dirty.add("board"); draft.events.push({ kind: "task", taskId: task.id, projectId: task.projectId }, { kind: "board", projectId: task.projectId });
      for (const other of draft.board.tasks) if (other.dependsOn.includes(task.id)) { const dependent = draft.task(other.id)!; dependent.dependsOn = dependent.dependsOn.filter((dep) => dep !== task.id); this.commit(draft, dependent, whoOf(actor), "dependency-removed", task.title, now); }
      const affected = new Set<string>(), items = draft.inbox.items.filter((item) => { if (item.taskId !== task.id) return true; affected.add(item.userId); return false; }); if (affected.size) { draft.inbox.items = items; draft.dirty.add("inbox"); draft.events.push({ kind: "inbox", userIds: [...affected] }); }
      const files = task.checkpoints.filter((checkpoint) => checkpoint.bundle === "available").map((checkpoint) => this.bundleFile(checkpoint.id)); if (files.length) draft.after.push(async () => { for (const file of files) await rm(file, { force: true }); });
      return { deleted: true };
    });
  }
  /** Repository keys are what every teammate maps to a clone, so a key still used by a task cannot disappear. The board revision is the CAS here. */
  async setRepositories(actor: CollabActor, projectId: string, repositories: unknown, revision: unknown): Promise<BoardProject> {
    const refs = validateRepoRefs(repositories);
    return this.change((draft) => {
      const project = this.project(projectId, actor); this.need(actor, project.id, "maintainer", "define repositories");
      if (revision === undefined || revision === null) throw new CollabError("Send the board's current revision with the change"); if (!integer(revision) || revision !== draft.board.revision) throw new CollabError("Team board changed; reload before saving", 409);
      const keys = new Set(refs.map((repo) => repo.key)), used = draft.board.tasks.find((task) => task.projectId === project.id && !keys.has(task.repository));
      if (used) throw new CollabError(`Task “${used.title}” still uses repository ${used.repository}; move it to another repository before removing that key`, 409);
      draft.board.projects[project.id] = { repositories: refs }; draft.board.revision++; draft.dirty.add("board"); draft.events.push({ kind: "board", projectId: project.id });
      return this.projectView(draft.board, project, actor, this.onlineUsers(this.now()));
    });
  }
  async setOwnerName(actor: CollabActor, name: unknown): Promise<{ ownerName: string }> {
    return this.change((draft) => {
      if (actor.kind !== "owner") throw new CollabError("Only the hub owner may change the owner's display name", 403); const label = validateText(name, MAX.displayName, "display name", { required: true, singleLine: true });
      draft.board.ownerName = label; draft.board.revision++; draft.dirty.add("board"); draft.events.push({ kind: "board" }); return { ownerName: label };
    });
  }

  // ---- Discussion, decisions, reviews, instructions
  async comment(actor: CollabActor, taskId: string, text: unknown): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); this.need(actor, current.projectId, "reviewer", "comment"); const body = validateText(text, MAX.text, "comment", { required: true });
      const task = draft.task(current.id)!, mentions = mentionsIn(body, this.mentionTargets(task.projectId));
      pushBounded(task.discussion, { id: newId("comment", this.random), by: whoOf(actor), text: body, mentions, at: now, kind: "comment" }, MAX.discussion, "comments");
      this.commit(draft, task, whoOf(actor), "commented", truncateText(body, 120), now);
      this.notify(draft, task, actor, mentions, "mention", `${actor.displayName} mentioned you: ${body}`); this.notify(draft, task, actor, this.stakeholders(task).filter((id) => !mentions.includes(id)), "comment", `${actor.displayName} commented: ${body}`);
      return clone(task);
    });
  }
  async decide(actor: CollabActor, taskId: string, text: unknown): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); this.need(actor, current.projectId, "contributor", "add decisions"); const body = validateText(text, MAX.decision, "decision", { required: true });
      const task = draft.task(current.id)!, mentions = mentionsIn(body, this.mentionTargets(task.projectId));
      pushBounded(task.decisions, { id: newId("decision", this.random), by: whoOf(actor), text: body, at: now }, MAX.decisions, "decisions");
      this.commit(draft, task, whoOf(actor), "decided", truncateText(body, 120), now); this.notify(draft, task, actor, mentions, "mention", `${actor.displayName} mentioned you in a decision: ${body}`);
      return clone(task);
    });
  }
  async requestReview(actor: CollabActor, taskId: string, reviewerUserId: unknown, revision: unknown): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); this.need(actor, current.projectId, "contributor", "request reviews"); this.cas(current, revision);
      const task = draft.task(current.id)!, reviewer = this.resolveWho(task.projectId, reviewerUserId, "reviewer", "reviewer"); task.reviewer = reviewer;
      this.system(task, whoOf(actor), `${actor.displayName} asked ${reviewer.displayName} to review this task`, now, "review-request"); this.commit(draft, task, whoOf(actor), "review-requested", reviewer.displayName, now);
      this.notify(draft, task, actor, [reviewer.userId], "review-requested", `${actor.displayName} asked you to review “${task.title}”`);
      return clone(task);
    });
  }
  /** A review names an existing checkpoint of the task; reviews of anything but the latest checkpoint are stale, which reviewState ignores. */
  async review(actor: CollabActor, taskId: string, input: ReviewInput, revision: unknown): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); this.need(actor, current.projectId, "reviewer", "record reviews"); this.cas(current, revision);
      if (!object(input)) throw new CollabError("Send the review as { checkpointId, verdict, text }"); const checkpoint = current.checkpoints.find((entry) => entry.id === input.checkpointId); if (!checkpoint) throw new CollabError("Checkpoint not found", 404);
      if (input.verdict !== "approve" && input.verdict !== "request-changes") throw new CollabError('Choose a verdict: "approve" or "request-changes"'); const body = validateText(input.text, MAX.text, "review");
      const task = draft.task(current.id)!, latest = latestCheckpoint(task)!, mentions = mentionsIn(body, this.mentionTargets(task.projectId));
      pushBounded(task.reviews, { id: newId("review", this.random), checkpointId: checkpoint.id, commit: checkpoint.commit, by: whoOf(actor), verdict: input.verdict, text: body, at: now, stale: checkpoint.id !== latest.id }, MAX.reviews, "reviews");
      for (const entry of task.reviews) entry.stale = entry.checkpointId !== latest.id;
      this.commit(draft, task, whoOf(actor), "reviewed", `${input.verdict} on ${short(checkpoint.commit)}`, now);
      this.notify(draft, task, actor, mentions, "mention", `${actor.displayName} mentioned you in a review: ${body}`);
      if (task.owner) this.notify(draft, task, actor, [task.owner.userId], "review-recorded", `${actor.displayName} ${input.verdict === "approve" ? "approved" : "requested changes on"} “${task.title}”${body ? `: ${body}` : ""}`);
      return clone(task);
    });
  }
  /** "Send to agent": the task owner's own instructions are approved at once; anyone else's wait for the owner (or a maintainer). */
  async proposeInstruction(actor: CollabActor, taskId: string, text: unknown): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); this.need(actor, current.projectId, "contributor", "send instructions to the agent"); const body = validateText(text, MAX.text, "instruction", { required: true });
      const task = draft.task(current.id)!, by = whoOf(actor), approved = isTaskOwner(task, actor), instruction: Instruction = { id: newId("instruction", this.random), by, text: body, at: now, state: approved ? "approved" : "proposed" };
      if (approved) { instruction.decidedBy = by; instruction.decidedAt = now; } pushBounded(task.instructions, instruction, MAX.instructions, "instructions");
      this.commit(draft, task, by, approved ? "instruction-approved" : "instruction-proposed", truncateText(body, 120), now);
      this.notify(draft, task, actor, mentionsIn(body, this.mentionTargets(task.projectId)), "mention", `${actor.displayName} mentioned you in an instruction: ${body}`);
      if (!approved && task.owner) this.notify(draft, task, actor, [task.owner.userId], "instruction-proposed", `${actor.displayName} proposed an instruction for the agent on “${task.title}”: ${body}`);
      return clone(task);
    });
  }
  async decideInstruction(actor: CollabActor, taskId: string, instructionId: string, action: "approve" | "decline"): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); if (!isTaskOwner(current, actor) && !roleAtLeast(actorRole(actor, current.projectId), "maintainer")) throw new CollabError("Only the task owner or a project maintainer may approve or decline instructions", 403);
      if (action !== "approve" && action !== "decline") throw new CollabError('Choose an action: "approve" or "decline"'); const existing = current.instructions.find((entry) => entry.id === instructionId); if (!existing) throw new CollabError("Instruction not found", 404);
      if (existing.state !== "proposed") throw new CollabError(`This instruction was already ${existing.state}`, 409);
      const task = draft.task(current.id)!, instruction = task.instructions.find((entry) => entry.id === instructionId)!, by = whoOf(actor); instruction.state = action === "approve" ? "approved" : "declined"; instruction.decidedBy = by; instruction.decidedAt = now;
      this.commit(draft, task, by, `instruction-${instruction.state}`, truncateText(instruction.text, 120), now); return clone(task);
    });
  }
  /** The runner records delivery so a reconnect never hands the agent the same instruction twice. */
  async markInstructionDelivered(actor: CollabActor, taskId: string, instructionId: string, attemptId: string): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId), attempt = current.attempts.find((entry) => entry.id === attemptId); if (!attempt) throw new CollabError("Attempt not found", 404); this.assertAttemptRunner(attempt, actor);
      const existing = current.instructions.find((entry) => entry.id === instructionId); if (!existing) throw new CollabError("Instruction not found", 404);
      if (existing.state === "delivered" && existing.attemptId === attempt.id) return clone(current); if (existing.state !== "approved") throw new CollabError(`Only approved instructions can be delivered; this one is ${existing.state}`, 409);
      const task = draft.task(current.id)!, instruction = task.instructions.find((entry) => entry.id === instructionId)!; instruction.state = "delivered"; instruction.attemptId = attempt.id;
      this.commit(draft, task, whoOf(actor), "instruction-delivered", attempt.runnerName, now); return clone(task);
    });
  }

  // ---- Attempts
  /** Only the task owner's own machine claims: the owner process with runner id "local", or a member's runner credential naming itself. Idempotent on attemptId, so a runner that crashed after claiming can resume safely. */
  async claimAttempt(actor: CollabActor, taskId: string, input: ClaimInput): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); this.need(actor, current.projectId, "contributor", "run tasks");
      if (!object(input)) throw new CollabError("Send the attempt as { attemptId, runnerId, runnerName, baseCommit, fromCheckpointId?, revision }");
      if (typeof input.attemptId !== "string" || !ATTEMPT_ID.test(input.attemptId)) throw new CollabError("Send the attempt id as 32 lowercase hexadecimal characters"); const attemptId = input.attemptId;
      const runnerName = validateText(input.runnerName, MAX.runnerName, "runner name", { required: true, singleLine: true }), baseCommit = validateCommit(input.baseCommit, "base commit");
      const fromCheckpointId = input.fromCheckpointId === undefined || input.fromCheckpointId === null ? undefined : input.fromCheckpointId; if (fromCheckpointId !== undefined && (typeof fromCheckpointId !== "string" || !CHECKPOINT_ID.test(fromCheckpointId))) throw new CollabError("Send the checkpoint id as 32 lowercase hexadecimal characters");
      if (!isTaskOwner(current, actor)) throw new CollabError("Only the task owner may start an attempt; take the task first", 403);
      const runnerId = this.claimRunnerId(actor, input.runnerId), existing = this.attemptById(draft.board, attemptId);
      if (existing) { if (existing.task.id === current.id && existing.attempt.runnerId === runnerId && existing.attempt.user.userId === actor.userId) return clone(current); throw new CollabError("That attempt id already belongs to another attempt; generate a new one", 409); }
      this.cas(current, input.revision);
      const busy = busyAttempt(current); if (busy) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before starting another`, 409);
      if (current.handoff?.state === "offered") throw new CollabError("Accept, decline or cancel the offered hand-over before starting an attempt", 409);
      // A claim moves Planned, Blocked or In review to Working; Done is a choice the owner made and is not undone by a stale "Start" button.
      if (current.status === "done") throw new CollabError("Move the task out of Done before starting an attempt", 409);
      if (fromCheckpointId !== undefined) { const checkpoint = current.checkpoints.find((entry) => entry.id === fromCheckpointId); if (!checkpoint) throw new CollabError("Checkpoint not found", 404); const latest = latestCheckpoint(current)!; if (checkpoint.id !== latest.id && !roleAtLeast(actorRole(actor, current.projectId), "maintainer")) throw new CollabError(`Continue from the latest checkpoint (${short(latest.commit)}); only a project maintainer may start from an older one`, 409); }
      const task = draft.task(current.id)!, attempt: Attempt = { id: attemptId, taskId: task.id, runnerId, runnerName, user: whoOf(actor), state: "claimed", baseCommit, createdAt: now, lastSeq: 0, lastHeartbeatAt: now, progress: { updatedAt: now } };
      if (fromCheckpointId !== undefined) attempt.fromCheckpointId = fromCheckpointId; pushBounded(task.attempts, attempt, MAX.attempts, "attempts");
      if (task.status !== "working") transition(task, "working", actor, undefined, now);
      this.commit(draft, task, whoOf(actor), "attempt-claimed", `${runnerName} from ${short(baseCommit)}`, now); return clone(task);
    });
  }
  private claimRunnerId(actor: CollabActor, runnerId: unknown): string {
    if (actor.kind === "owner") { if (runnerId !== RUNNER_LOCAL) throw new CollabError(`The hub owner runs tasks in-process; send runnerId "${RUNNER_LOCAL}"`); return RUNNER_LOCAL; }
    if (actor.via !== "runner" || actor.runnerId === undefined) throw new CollabError("Start attempts from your own code-flow (Connections → Share access → Connect this computer), not from the browser", 403);
    if (runnerId !== actor.runnerId) throw new CollabError("The attempt's runnerId must be the runner id of the credential making the request", 403); return actor.runnerId;
  }
  /** Reports are ordered by `seq`; a stale or duplicate report is a no-op that returns the current attempt. Progress never bumps revisions, so an editing teammate is not conflicted by a running agent, and on an attempt already running it is telemetry (announced at once, written behind). A report that revives a paused, stopped or unknown attempt is a state change under the claim's rules: refused when the attempt's user no longer owns the task (403), on a Done task, while another attempt is busy on the task or while a hand-over is offered (409; so a stale Resume never puts two runs on one task or reopens a finished one), and written at once like the first report of a claimed attempt. */
  async attemptProgress(actor: CollabActor, attemptId: string, report: unknown): Promise<{ attempt: Attempt }> {
    const parsed = validateProgressReport(report, this.now());
    return this.change((draft) => {
      const now = this.now(), found = this.findAttempt(draft.board, actor, attemptId); this.assertAttemptRunner(found.attempt, actor); this.assertNotEnded(found.attempt);
      if (parsed.seq <= found.attempt.lastSeq) return { attempt: clone(found.attempt) };
      if (found.attempt.state !== "claimed" && found.attempt.state !== "running") {
        // Every rule of a claim applies to a revive. A change of hands supersedes what the previous owner left (assignOwner), but a board written before that rule, or any path that misses it, must not let the old owner's machine put a run back on a task that is no longer theirs; and Done stays the owner's decision, as for a claim.
        if (!isTaskOwner(found.task, actor)) throw new CollabError(ownerChangedMessage(found.task), 403);
        if (found.task.status === "done") throw new CollabError("Move the task out of Done before resuming the attempt", 409);
        const busy = busyAttempt(found.task); if (busy && busy.id !== found.attempt.id) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before resuming this one`, 409);
        if (found.task.handoff?.state === "offered") throw new CollabError("Accept, decline or cancel the offered hand-over before resuming the attempt", 409);
      }
      const task = draft.task(found.task.id, found.attempt.state === "running" ? "telemetry" : "board")!, attempt = task.attempts.find((entry) => entry.id === found.attempt.id)!;
      attempt.progress = parsed.progress; attempt.lastSeq = parsed.seq; attempt.lastHeartbeatAt = now; attempt.state = "running"; attempt.startedAt ??= now; delete attempt.endedAt; delete attempt.reason;
      if (parsed.runId !== undefined) attempt.runId = parsed.runId; if (parsed.progress.head) attempt.head = parsed.progress.head; if (parsed.progress.branch) attempt.branch = parsed.progress.branch;
      draft.events.push({ kind: "task", taskId: task.id, projectId: task.projectId }); return { attempt: clone(attempt) };
    });
  }
  async heartbeat(actor: CollabActor, attemptId: string): Promise<{ attempt: Attempt; instructions: Instruction[] }> {
    return this.change((draft) => {
      const found = this.findAttempt(draft.board, actor, attemptId); this.assertAttemptRunner(found.attempt, actor); this.assertNotEnded(found.attempt);
      const task = draft.task(found.task.id, "telemetry")!, attempt = task.attempts.find((entry) => entry.id === found.attempt.id)!; attempt.lastHeartbeatAt = this.now();
      draft.events.push({ kind: "task", taskId: task.id, projectId: task.projectId }); return { attempt: clone(attempt), instructions: clone(task.instructions.filter((entry) => entry.state === "approved")) };
    });
  }
  private assertNotEnded(attempt: Attempt): void { if (TERMINAL.includes(attempt.state)) throw new CollabError(`This attempt ${attempt.state === "superseded" ? "was superseded by a change of owner or recovery" : `already ended as ${attempt.state}`}; start a new attempt instead`, 409); }
  /** Idempotent for the runner's retries: finishing again with the same state returns the attempt unchanged. paused/stopped/unknown attempts can be resumed, finished/failed cannot. */
  async finishAttempt(actor: CollabActor, attemptId: string, input: FinishInput): Promise<{ attempt: Attempt }> {
    return this.change((draft) => {
      const now = this.now(), found = this.findAttempt(draft.board, actor, attemptId); this.assertAttemptRunner(found.attempt, actor);
      if (!object(input) || !(FINISH_STATES as readonly unknown[]).includes(input.state)) throw new CollabError('Choose the final state: "finished", "failed", "stopped", "paused" or "unknown"'); const state = input.state as FinishState;
      const head = input.head === undefined || input.head === null ? undefined : validateCommit(input.head, "head"), summary = validateText(input.summary, MAX.summary, "summary"), reason = validateText(input.reason, MAX.reason, "reason");
      if (found.attempt.state === state) return { attempt: clone(found.attempt) }; this.assertNotEnded(found.attempt);
      const task = draft.task(found.task.id)!, attempt = task.attempts.find((entry) => entry.id === found.attempt.id)!;
      attempt.state = state; if (state === "unknown") delete attempt.endedAt; else attempt.endedAt = now; attempt.lastHeartbeatAt = now; if (head) attempt.head = head; if (summary) { attempt.progress.summary = summary; attempt.progress.updatedAt = now; } if (reason) attempt.reason = reason;
      this.commit(draft, task, whoOf(actor), `attempt-${state}`, truncateText(reason || summary, 200) || undefined, now);
      const label = state === "finished" ? "finished" : state === "failed" ? "failed" : state === "stopped" ? "stopped at a limit" : state === "paused" ? "paused" : "lost contact";
      if (task.owner) this.notify(draft, task, actor, [task.owner.userId], state === "failed" || state === "unknown" ? "attempt-failed" : "attempt-finished", `The attempt on ${attempt.runnerName} ${label}${reason ? `: ${reason}` : ""}`);
      return { attempt: clone(attempt) };
    });
  }

  /** A human recovery decision, never a heartbeat timeout: confirm the original execution has stopped before releasing its reservation. */
  async recoverAttempt(actor: CollabActor, attemptId: string, input: { revision?: unknown; reason?: unknown; confirmedStopped?: unknown }): Promise<Task> {
    return this.change((draft) => {
      const found = this.findAttempt(draft.board, actor, attemptId), role = actorRole(actor, found.task.projectId);
      if (!(isTaskOwner(found.task, actor) && roleAtLeast(role, "contributor")) && !roleAtLeast(role, "maintainer")) throw new CollabError("Only the task owner or a project maintainer may recover an attempt", 403);
      this.cas(found.task, input.revision);
      if (found.attempt.state !== "unknown") throw new CollabError("Only an unknown attempt can be recovered; reconcile or stop its runner first", 409);
      if (input.confirmedStopped !== true) throw new CollabError("Confirm that the original agent has stopped before releasing this task");
      const reason = validateText(input.reason, MAX.reason, "recovery reason", { required: true }), now = this.now();
      const task = draft.task(found.task.id)!, attempt = task.attempts.find((entry) => entry.id === attemptId)!;
      attempt.state = "superseded"; attempt.endedAt = now; attempt.reason = reason;
      this.commit(draft, task, whoOf(actor), "attempt-recovered", reason, now);
      this.system(task, whoOf(actor), `${actor.displayName} confirmed execution on ${attempt.runnerName} has stopped: ${reason}`, now);
      return clone(task);
    });
  }

  // ---- Checkpoints
  /** The manifest may name the checkpoint (`id`): the runner mints it before bundling, so the bundle's only ref, the board and the branch `team/<task>/<id8>` agree and every importing machine lands `refs/codeflow/team/<id>` under the id the board shows. Ids are random, so one already on the board (any task) is a stale retry and is refused; hub-side callers that send none get a generated id. */
  async addCheckpoint(actor: CollabActor, attemptId: string, input: unknown): Promise<Checkpoint> {
    const manifest = validateCheckpointInput(input);
    return this.change((draft) => {
      const now = this.now(), found = this.findAttempt(draft.board, actor, attemptId); this.assertAttemptRunner(found.attempt, actor);
      if (found.attempt.state === "superseded") throw new CollabError("This attempt was superseded by a change of owner; its work can no longer be checkpointed", 409);
      if (manifest.id !== undefined && draft.board.tasks.some((entry) => entry.checkpoints.some((checkpoint) => checkpoint.id === manifest.id))) throw new CollabError("A checkpoint with this id already exists; create the bundle again under a new id", 409);
      const task = draft.task(found.task.id)!, attempt = task.attempts.find((entry) => entry.id === found.attempt.id)!, id = manifest.id ?? newCheckpointId(this.random);
      const checkpoint: Checkpoint = { id, taskId: task.id, attemptId: attempt.id, commit: manifest.commit, baseCommit: manifest.baseCommit, branch: manifest.branch, size: manifest.size, sha256: manifest.sha256, ref: `refs/codeflow/team/${id}`, createdBy: whoOf(actor), at: now, note: manifest.note, requirements: manifest.requirements, decisions: manifest.decisions, remaining: manifest.remaining, changedFiles: manifest.changedFiles, bundle: "pending" };
      if (manifest.testResults) checkpoint.testResults = manifest.testResults; pushBounded(task.checkpoints, checkpoint, MAX.checkpoints, "checkpoints"); attempt.checkpointId = id; attempt.head = manifest.commit;
      for (const review of task.reviews) review.stale = review.checkpointId !== id;
      this.commit(draft, task, whoOf(actor), "checkpoint-added", short(manifest.commit), now); return clone(checkpoint);
    });
  }
  /** Streams to a temp file while hashing and counting (outside the mutation queue, so a slow upload blocks nobody), then moves it into place and marks the bundle available in one durable step. */
  async storeBundle(actor: CollabActor, checkpointId: string, stream: AsyncIterable<Uint8Array> | Readable, info: BundleInfo): Promise<Checkpoint> {
    await this.load(); this.require(); const found = this.findCheckpoint(this.state.board, actor, checkpointId); this.assertAttemptRunner(found.attempt, actor); this.assertPendingBundle(found.checkpoint);
    if (!object(info) || info.size !== found.checkpoint.size || typeof info.sha256 !== "string" || info.sha256.toLowerCase() !== found.checkpoint.sha256) throw new CollabError("The upload's size and sha256 must match the checkpoint manifest");
    await mkdir(this.bundleDir, { recursive: true, mode: 0o700 });
    const temp = `${this.bundleFile(found.checkpoint.id)}.${this.random(6).toString("hex")}.tmp`, hash = createHash("sha256"); let received = 0;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk; received += bytes.length;
          if (received > MAX.bundle) throw new CollabError(`Checkpoint bundles are limited to ${MAX.bundle / 1024 / 1024} MiB`, 413); if (received > found.checkpoint.size) throw new CollabError("The uploaded bundle is larger than the checkpoint manifest says; upload the file the manifest describes");
          hash.update(bytes); await handle.write(bytes);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (received !== found.checkpoint.size || hash.digest("hex") !== found.checkpoint.sha256) throw new CollabError("The uploaded bundle does not match the checkpoint's size or sha256 digest; upload it again");
    } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error instanceof CollabError ? error : new CollabError(`The bundle upload failed: ${error instanceof Error ? error.message : String(error)}; upload it again`); }
    // Whatever stops the temp file from becoming the bundle (the task deleted while it streamed, no room, a rename failure) removes it: nothing sweeps this folder until the next start.
    let installed = false;
    try {
      return await this.change(async (draft) => {
        const now = this.now(), again = this.findCheckpoint(draft.board, actor, checkpointId); this.assertPendingBundle(again.checkpoint); const evicted = this.makeRoom(draft, whoOf(actor), now);
        const task = draft.task(again.task.id)!, checkpoint = task.checkpoints.find((entry) => entry.id === again.checkpoint.id)!, file = this.bundleFile(checkpoint.id); checkpoint.bundle = "available";
        try { await rename(temp, file); } catch (error) { logError(`A checkpoint bundle could not be moved into place as ${file}`, error); throw new CollabError("Team storage could not store the checkpoint bundle; check the team server's checkpoints folder (see server.log), then upload it again", 503); }
        installed = true; draft.undo.push(() => rm(file, { force: true })); if (evicted.length) draft.after.push(async () => { for (const old of evicted) await rm(old, { force: true }); });
        this.commit(draft, task, whoOf(actor), "bundle-stored", `${checkpoint.size} bytes`, now); return clone(checkpoint);
      });
    } finally { if (!installed) await rm(temp, { force: true }).catch(() => undefined); }
  }
  private assertPendingBundle(checkpoint: Checkpoint): void { if (checkpoint.bundle !== "pending") throw new CollabError(checkpoint.bundle === "available" ? "This checkpoint's bundle was already uploaded" : "This checkpoint's bundle was deleted; create a new checkpoint", 409); }
  /** Keeps at most 200 bundles on disk by retiring the oldest bundle of a done task; when none qualifies the upload fails with 507 instead of removing live work. */
  private makeRoom(draft: Draft, by: Who, now: number): string[] {
    const available: { taskId: string; checkpointId: string; at: number; done: boolean }[] = [];
    for (const task of draft.board.tasks) for (const checkpoint of task.checkpoints) if (checkpoint.bundle === "available") available.push({ taskId: task.id, checkpointId: checkpoint.id, at: checkpoint.at, done: task.status === "done" && !(task.handoff?.state === "offered" && task.handoff.checkpointId === checkpoint.id) });
    const files: string[] = [];
    while (available.length >= MAX.bundlesOnDisk) {
      const victim = available.filter((entry) => entry.done).sort((a, b) => a.at - b.at)[0]; if (!victim) throw new CollabError("Team checkpoint storage is full; delete checkpoints of finished tasks first", 507);
      const task = draft.task(victim.taskId)!, checkpoint = task.checkpoints.find((entry) => entry.id === victim.checkpointId)!; checkpoint.bundle = "deleted"; this.commit(draft, task, by, "bundle-evicted", `${short(checkpoint.commit)} to make room`, now);
      available.splice(available.indexOf(victim), 1); files.push(this.bundleFile(checkpoint.id));
    }
    return files;
  }
  async bundlePath(actor: CollabActor, checkpointId: string): Promise<{ path: string; checkpoint: Checkpoint }> {
    await this.load(); this.require(); const found = this.findCheckpoint(this.state.board, actor, checkpointId); this.need(actor, found.task.projectId, "contributor", "download checkpoint bundles");
    if (found.checkpoint.bundle !== "available") throw new CollabError("Checkpoint bundle is not available", 404);
    const path = this.bundleFile(found.checkpoint.id), info = await lstat(path).catch(() => undefined); if (!info?.isFile() || info.size !== found.checkpoint.size) throw new CollabError("The checkpoint bundle is missing from the hub's storage; create a new checkpoint", 404);
    return { path, checkpoint: clone(found.checkpoint) };
  }
  async deleteCheckpoint(actor: CollabActor, id: string): Promise<Checkpoint> {
    return this.change((draft) => {
      const now = this.now(), found = this.findCheckpoint(draft.board, actor, id); this.need(actor, found.task.projectId, "maintainer", "delete checkpoints"); if (found.checkpoint.bundle === "deleted") return clone(found.checkpoint);
      if (found.task.handoff?.state === "offered" && found.task.handoff.checkpointId === found.checkpoint.id) throw new CollabError("Cancel the offered hand-over before deleting its checkpoint", 409);
      const task = draft.task(found.task.id)!, checkpoint = task.checkpoints.find((entry) => entry.id === found.checkpoint.id)!, hadFile = checkpoint.bundle === "available"; checkpoint.bundle = "deleted";
      this.commit(draft, task, whoOf(actor), "checkpoint-deleted", short(checkpoint.commit), now); if (hadFile) { const file = this.bundleFile(checkpoint.id); draft.after.push(() => rm(file, { force: true })); }
      return clone(checkpoint);
    });
  }

  // ---- Hand-overs
  /** The task owner (or a maintainer) offers a contributor the task at an available checkpoint; nothing moves until the recipient accepts, so a declined or failed hand-over leaves the owner in place. */
  async offerHandoff(actor: CollabActor, taskId: string, input: HandoffInput, revision: unknown): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId), role = actorRole(actor, current.projectId);
      if (!(isTaskOwner(current, actor) && roleAtLeast(role, "contributor")) && !roleAtLeast(role, "maintainer")) throw new CollabError("Only the task owner or a project maintainer may hand the task over", 403); this.cas(current, revision);
      if (!object(input)) throw new CollabError("Send the hand-over as { to, checkpointId, note }"); const to = this.resolveWho(current.projectId, input.to, "contributor", "teammate"); if (to.userId === current.owner?.userId) throw new CollabError("Choose a teammate other than the task's current owner to hand over to");
      const busy = busyAttempt(current); if (busy) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before handing the task over`, 409);
      if (current.handoff?.state === "offered") throw new CollabError(`A hand-over to ${current.handoff.to.displayName} is already offered; cancel it before offering another`, 409);
      const checkpoint = current.checkpoints.find((entry) => entry.id === input.checkpointId); if (!checkpoint) throw new CollabError("Checkpoint not found", 404); if (checkpoint.bundle !== "available") throw new CollabError("The checkpoint's bundle is not on the hub; upload it or choose another checkpoint", 409);
      const note = validateText(input.note, MAX.note, "note"), task = draft.task(current.id)!, by = whoOf(actor), handoff: Handoff = { id: newId("handoff", this.random), from: by, to, checkpointId: checkpoint.id, note, state: "offered", offeredAt: now }; task.handoff = handoff;
      this.system(task, by, `${actor.displayName} offered to hand this task over to ${to.displayName}`, now); this.commit(draft, task, by, "handoff-offered", to.displayName, now);
      this.notify(draft, task, actor, [to.userId], "handoff-offered", `${actor.displayName} offered you “${task.title}”${note ? `: ${note}` : ""}`); this.notify(draft, task, actor, mentionsIn(note, this.mentionTargets(task.projectId)).filter((id) => id !== to.userId), "mention", `${actor.displayName} mentioned you in a hand-over note: ${note}`);
      return clone(task);
    });
  }
  /** accept (recipient): the task changes hands through assignOwner, superseding paused or stopped attempts; decline (recipient) and cancel (sender or maintainer) leave the owner as is. */
  async respondHandoff(actor: CollabActor, taskId: string, handoffId: string, action: "accept" | "decline" | "cancel", revision: unknown): Promise<Task> {
    return this.change((draft) => {
      const now = this.now(), current = this.findTask(draft.board, actor, taskId); this.cas(current, revision);
      const offered = current.handoff; if (!offered || offered.id !== handoffId) { const past = current.handoffs.find((entry) => entry.id === handoffId); if (past) throw new CollabError(`This hand-over was already ${past.state}`, 409); throw new CollabError("Hand-over not found", 404); }
      if (action !== "accept" && action !== "decline" && action !== "cancel") throw new CollabError('Choose an action: "accept", "decline" or "cancel"'); const role = actorRole(actor, current.projectId);
      if (action === "cancel") { if (offered.from.userId !== actor.userId && !roleAtLeast(role, "maintainer")) throw new CollabError("Only the teammate who offered the hand-over or a project maintainer may cancel it", 403); }
      else { if (offered.to.userId !== actor.userId) throw new CollabError("Only the teammate the task was offered to may accept or decline it", 403); if (action === "accept" && !roleAtLeast(role, "contributor")) throw new CollabError("A project contributor role is required to accept a hand-over", 403); }
      const task = draft.task(current.id)!, handoff = task.handoff!, by = whoOf(actor); if (action === "accept") assignOwner(task, handoff.to, now);
      handoff.state = action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled"; handoff.respondedAt = now; delete task.handoff; pushBounded(task.handoffs, handoff, MAX.handoffs, "hand-overs", "drop-oldest");
      this.system(task, by, `${actor.displayName} ${handoff.state} the hand-over ${action === "cancel" ? `to ${handoff.to.displayName}` : `from ${handoff.from.displayName}`}`, now); this.commit(draft, task, by, `handoff-${handoff.state}`, action === "cancel" ? handoff.to.displayName : handoff.from.displayName, now);
      this.notify(draft, task, actor, [action === "cancel" ? handoff.to.userId : handoff.from.userId], `handoff-${handoff.state}`, `${actor.displayName} ${handoff.state} the hand-over of “${task.title}”`);
      return clone(task);
    });
  }

  // ---- Inbox and runners
  async markRead(actor: CollabActor, ids: unknown): Promise<{ unread: number }> {
    if (ids !== "all" && (!Array.isArray(ids) || ids.length > MAX.inboxPerUser || ids.some((id) => typeof id !== "string" || !PREFIXED_ID.test(id)))) throw new CollabError(`Send the inbox item ids to mark read as a list of at most ${MAX.inboxPerUser} ids, or "all"`);
    return this.change((draft) => {
      const now = this.now(), wanted = ids === "all" ? undefined : new Set(ids as string[]); let changed = false;
      const visible = this.visibleInbox(draft.board, draft.inbox, actor);
      for (const item of visible) if (item.readAt === undefined && (wanted === undefined || wanted.has(item.id))) { item.readAt = now; changed = true; }
      if (changed) { draft.dirty.add("inbox"); draft.events.push({ kind: "inbox", userIds: [actor.userId] }); }
      return { unread: visible.filter((item) => item.readAt === undefined).length };
    });
  }
  /** Called after the connect handshake proved the password; the token is returned once and only its sha256 is stored. */
  async registerRunner(userId: unknown, name: unknown, address?: unknown): Promise<{ runner: RunnerPublic; token: string }> {
    return this.change((draft) => {
      const now = this.now(), id = validateUserRef(userId, "account"), member = this.options.members().find((entry) => entry.userId === id);
      if (!member || !member.enabled || !Object.values(member.roles).some((role) => roleAtLeast(role, "contributor"))) throw new CollabError("A contributor role in at least one project is required to link a runner", 403);
      const label = validateText(name, MAX.runnerName, "runner name", { required: true, singleLine: true }), lastAddress = validateText(address, 128, "address", { singleLine: true });
      if (draft.runners.runners.filter((runner) => runner.revokedAt === undefined && runner.userId === id).length >= MAX.runnersPerUser) throw new CollabError(`At most ${MAX.runnersPerUser} runners may be linked per account; revoke one in Connections → Share access first`, 409);
      while (draft.runners.runners.length >= MAX.runners) { const revoked = draft.runners.runners.filter((runner) => runner.revokedAt !== undefined).sort((a, b) => a.revokedAt! - b.revokedAt!)[0]; if (!revoked) throw new CollabError(`The hub has reached its limit of ${MAX.runners} linked runners; revoke unused runners first`, 409); draft.runners.runners.splice(draft.runners.runners.indexOf(revoked), 1); }
      const token = newRunnerToken(this.random), runner: RunnerRecord = { id: newRunnerId(this.random), userId: id, name: label, tokenHash: sha256Hex(token), createdAt: now, lastSeenAt: now }; if (lastAddress) runner.lastAddress = lastAddress;
      draft.runners.runners.push(runner); draft.dirty.add("runners"); draft.events.push({ kind: "runners", userIds: [id] }); return { runner: runnerPublic(runner, now), token };
    });
  }
  /** A revoked runner can no longer report. Its attempts remain reserved as unknown until explicitly recovered. */
  async revokeRunner(actor: CollabActor, id: unknown): Promise<RunnerPublic> {
    return this.change((draft) => {
      const now = this.now(), runner = typeof id === "string" ? draft.runners.runners.find((entry) => entry.id === id) : undefined;
      if (!runner || (runner.userId !== actor.userId && !this.seesAllRunners(actor))) throw new CollabError("Runner not found", 404); if (runner.revokedAt !== undefined) return runnerPublic(runner, now);
      runner.revokedAt = now; draft.dirty.add("runners"); draft.events.push({ kind: "runners", userIds: [runner.userId] });
      for (const current of draft.board.tasks) for (const entry of current.attempts) if (entry.runnerId === runner.id && (entry.state === "claimed" || entry.state === "running")) { const task = draft.task(current.id)!, attempt = task.attempts.find((candidate) => candidate.id === entry.id)!; attempt.state = "unknown"; delete attempt.endedAt; attempt.reason = `Runner ${runner.name} was revoked while this attempt was active`; this.commit(draft, task, whoOf(actor), "attempt-unknown", `runner ${runner.name} revoked`, now); }
      return runnerPublic(runner, now);
    });
  }
  /** Housekeeping: drops old revoked runners and read inbox items; silent attempts become unknown but retain their execution reservation. */
  async prune(now = this.now()): Promise<{ runners: number; inbox: number; attempts: number }> {
    return this.change((draft) => {
      const runners = draft.runners.runners.filter((runner) => runner.revokedAt === undefined || now - runner.revokedAt < RETENTION_MS), prunedRunners = draft.runners.runners.length - runners.length; if (prunedRunners) { draft.runners.runners = runners; draft.dirty.add("runners"); draft.events.push({ kind: "runners" }); }
      const items = draft.inbox.items.filter((item) => item.readAt === undefined || now - item.readAt < RETENTION_MS), prunedItems = draft.inbox.items.length - items.length; if (prunedItems) { draft.inbox.items = items; draft.dirty.add("inbox"); }
      let attempts = 0; const by: Who = { userId: "owner", displayName: this.ownerName };
      for (const current of draft.board.tasks) { const busy = busyAttempt(current); if (busy && busy.state !== "unknown" && now - busy.lastHeartbeatAt >= STALE_ATTEMPT_MS) { const task = draft.task(current.id)!, attempt = task.attempts.find((entry) => entry.id === busy.id)!; attempt.state = "unknown"; delete attempt.endedAt; attempt.reason = "No heartbeat for 24 hours; reconcile the runner or confirm execution has stopped before recovering this task"; this.commit(draft, task, by, "attempt-unknown", "no heartbeat for 24 hours", now); attempts++; } }
      return { runners: prunedRunners, inbox: prunedItems, attempts };
    });
  }
}
