import { MAX, selfReview, historyLimitMessage } from "./presentation.js";
export { MAX, selfReview, historyLimitMessage } from "./presentation.js";
import { randomBytes } from "node:crypto";
import type { SharedRole } from "../shared-accounts.js";

/**
 * The team board's data model: the shapes the hub store, the team API, the linked runner and the UI all
 * build against, the validators every input passes through, and the task state machine. Nothing here does
 * I/O, so each rule is testable on its own and the store can apply them to a structured clone before writing.
 */

export type TaskStatus = "planned" | "working" | "blocked" | "review" | "done";
export type AttemptState = "claimed" | "running" | "paused" | "finished" | "failed" | "stopped" | "unknown" | "superseded";
export const TASK_STATUSES: readonly TaskStatus[] = ["planned", "working", "blocked", "review", "done"];
export const ATTEMPT_STATES: readonly AttemptState[] = ["claimed", "running", "paused", "finished", "failed", "stopped", "unknown", "superseded"];
/** A repository a project's tasks work in, named by a short key so every teammate maps it to their own clone. */
export interface RepoRef { key: string; label: string; remote?: string; defaultBranch?: string }
export interface Who { userId: string; displayName: string; via?: "browser" | "runner" | "local" }
export interface AttemptProgress { stage?: string; summary?: string; runStatus?: string; changedFiles?: string[]; tests?: { ok: boolean; command: string; at: number }; verdict?: "passed" | "failing"; blockers?: string[]; head?: string; branch?: string; steps?: { done: number; total?: number }; updatedAt: number }
export interface Attempt { id: string; taskId: string; runnerId: string; runnerName: string; user: Who; state: AttemptState; runId?: string; baseCommit: string; fromCheckpointId?: string; branch?: string; head?: string; createdAt: number; startedAt?: number; endedAt?: number; lastSeq: number; lastHeartbeatAt: number; progress: AttemptProgress; checkpointId?: string; reason?: string }
export interface Checkpoint { id: string; taskId: string; attemptId: string; commit: string; baseCommit: string; branch: string; size: number; sha256: string; ref: string; createdBy: Who; at: number; note: string; requirements: string; decisions: string[]; testResults?: { ok: boolean; command: string; at: number }; remaining: string; changedFiles: string[]; bundle: "pending" | "available" | "deleted" }
export interface Comment { id: string; by: Who; text: string; mentions: string[]; at: number; kind: "comment" | "review-request" | "system" }
export interface Decision { id: string; by: Who; text: string; at: number }
export interface Instruction { id: string; by: Who; text: string; at: number; state: "proposed" | "approved" | "declined" | "delivered"; decidedBy?: Who; decidedAt?: number; attemptId?: string }
export interface Review { id: string; checkpointId: string; commit: string; by: Who; verdict: "approve" | "request-changes"; text: string; at: number; stale: boolean }
export interface Handoff { id: string; from: Who; to: Who; checkpointId: string; note: string; state: "offered" | "accepted" | "declined" | "cancelled"; offeredAt: number; respondedAt?: number; reason?: string }
export interface AuditEntry { at: number; by: Who; action: string; detail?: string }
export interface Task { id: string; projectId: string; repository: string; title: string; goal: string; acceptance: string; status: TaskStatus; blocker?: string; owner?: Who; collaborators: Who[]; reviewer?: Who; dependsOn: string[]; baseRef?: string; labels: string[]; revision: number; createdAt: number; updatedAt: number; createdBy: Who; attempts: Attempt[]; checkpoints: Checkpoint[]; decisions: Decision[]; discussion: Comment[]; instructions: Instruction[]; reviews: Review[]; handoff?: Handoff; handoffs: Handoff[]; audit: AuditEntry[] }
export type ReviewState = "approved" | "changes-requested" | "pending" | "none";
/** What a board card needs: no goal, discussion or history, and only the current attempt and the latest checkpoint. */
export type TaskSummary = Pick<Task, "id" | "projectId" | "repository" | "title" | "status" | "blocker" | "owner" | "collaborators" | "reviewer" | "dependsOn" | "labels" | "revision" | "createdAt" | "updatedAt"> & { attempt?: Pick<Attempt, "id" | "state" | "runnerName" | "user" | "lastHeartbeatAt" | "progress">; checkpoint?: Pick<Checkpoint, "id" | "commit" | "at">; handoff?: Pick<Handoff, "id" | "to" | "from" | "state">; unreadMentions?: number; reviewState?: ReviewState };
export interface BoardProject { id: string; name: string; role: SharedRole; repositories: RepoRef[]; members: { userId: string; username: string; displayName: string; role: SharedRole; online: boolean }[] }
export interface Board { revision: number; projects: BoardProject[]; tasks: TaskSummary[]; me: Who & { roles: Record<string, SharedRole>; runners: RunnerPublic[] }; inboxUnread: number }
export interface RunnerPublic { id: string; userId: string; name: string; createdAt: number; lastSeenAt: number; online: boolean; revokedAt?: number }
export type InboxKind = "assigned" | "mention" | "review-requested" | "review-recorded" | "handoff-offered" | "handoff-accepted" | "handoff-declined" | "handoff-cancelled" | "instruction-proposed" | "instruction-approved" | "instruction-declined" | "blocked" | "attempt-finished" | "attempt-failed" | "comment";
export interface InboxItem { id: string; userId: string; kind: InboxKind; taskId: string; taskTitle: string; text: string; by: Who; at: number; readAt?: number }
/** Who is acting on the hub: the owner process itself, or a shared account reached through a browser session or a linked runner's credential. */
export type CollabActor = { kind: "owner"; userId: "owner"; displayName: string } | { kind: "member"; userId: string; username: string; displayName: string; roles: Record<string, SharedRole>; via: "browser" | "runner"; runnerId?: string };
/** Carries the HTTP status so the API answers 403/404/409/503 without mapping messages back to codes. `code` names a refusal a client handles on its own, which the API sends beside the message: only STALE_REVISION so far. */
export class CollabError extends Error { constructor(message: string, readonly status = 400, readonly code?: string) { super(message); } }
/** A save based on an older revision: the one 409 a page answers by reloading and keeping the draft; every other 409 is a refusal whose message the person must read. */
export const STALE_REVISION = "stale-revision";
/** The JSON body an API answers a CollabError with: `{ error }`, plus `code` when the refusal has one. */
export const collabErrorBody = (error: CollabError): { error: string; code?: string } => error.code ? { error: error.message, code: error.code } : { error: error.message };

export const TASK_ID = /^t-[a-f0-9]{16}$/, ATTEMPT_ID = /^[a-f0-9]{32}$/, CHECKPOINT_ID = /^[a-f0-9]{32}$/, RUNNER_ID = /^r-[a-f0-9]{16}$/, PREFIXED_ID = /^[a-z]{1,4}-[a-f0-9]{16}$/, PATH_ID = /^[a-zA-Z0-9_-]{1,100}$/, REPO_KEY = /^[a-z][a-z0-9-]{0,63}$/, COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, SHA256_HEX = /^[a-f0-9]{64}$/, RUNNER_TOKEN = /^tr-[A-Za-z0-9_-]{43}$/;
export type RandomSource = (bytes: number) => Buffer;
export const ID_PREFIX = { comment: "c", decision: "d", instruction: "i", review: "rv", handoff: "h", inbox: "n" } as const;
export const newTaskId = (random: RandomSource = randomBytes): string => `t-${random(8).toString("hex")}`;
export const newAttemptId = (random: RandomSource = randomBytes): string => random(16).toString("hex");
export const newCheckpointId = (random: RandomSource = randomBytes): string => random(16).toString("hex");
export const newRunnerId = (random: RandomSource = randomBytes): string => `r-${random(8).toString("hex")}`;
export const newId = (kind: keyof typeof ID_PREFIX, random: RandomSource = randomBytes): string => `${ID_PREFIX[kind]}-${random(8).toString("hex")}`;
/** 32 random bytes as base64url: 43 characters, matching RUNNER_TOKEN; only its sha256 is ever stored. */
export const newRunnerToken = (random: RandomSource = randomBytes): string => `tr-${random(32).toString("base64url")}`;

export const SHARED_ROLE_RANK: Record<SharedRole, number> = { viewer: 0, reviewer: 1, contributor: 2, maintainer: 3 };
export function roleAtLeast(role: SharedRole | undefined, needed: SharedRole): boolean { return role !== undefined && Object.hasOwn(SHARED_ROLE_RANK, role) && SHARED_ROLE_RANK[role] >= SHARED_ROLE_RANK[needed]; }
/** The owner runs the hub, so it is a maintainer of every project; members hold exactly the roles their account lists. */
export function actorRole(actor: CollabActor, projectId: string): SharedRole | undefined { if (actor.kind === "owner") return "maintainer"; return Object.hasOwn(actor.roles, projectId) ? actor.roles[projectId] : undefined; }
export function isTaskOwner(task: Pick<Task, "owner">, actor: Pick<Who, "userId">): boolean { return task.owner !== undefined && task.owner.userId === actor.userId; }
export function whoOf(actor: CollabActor): Who { return { userId: actor.userId, displayName: actor.displayName, via: actor.kind === "owner" ? "local" : actor.via }; }
export function clone<T>(value: T): T { return structuredClone(value); }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const absent = (v: unknown): v is undefined | null => v === undefined || v === null;
const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/, LINE_CONTROL = /[\x00-\x1f\x7f]/, REF_FORBIDDEN = /[\s~^:?*[\\\x00-\x1f\x7f]/;
const bytes = (max: number) => max >= 1024 && max % 1024 === 0;
const limitLabel = (max: number) => bytes(max) ? `${max / 1024} KiB` : `${max} characters`;
function assertKeys(value: Record<string, unknown>, allowed: readonly string[], what: string) { const extra = Object.keys(value).find((key) => !allowed.includes(key)); if (extra !== undefined) throw new CollabError(`Unknown ${what} field ${JSON.stringify(extra.slice(0, 40))}; the allowed fields are ${allowed.join(", ")}`); }

/** Text limits written in KiB bound storage (UTF-8 bytes); the rest bound what a person types (characters). Tabs and newlines stay; other control characters never enter the board. */
export function validateText(value: unknown, max: number, label: string, options: { required?: boolean; singleLine?: boolean } = {}): string {
  if (absent(value)) { if (options.required) throw new CollabError(`Enter a ${label} of 1–${limitLabel(max)}`); return ""; }
  if (typeof value !== "string") throw new CollabError(`Enter the ${label} as text`);
  const text = options.singleLine ? value.trim() : value;
  if ((options.singleLine ? LINE_CONTROL : CONTROL).test(text)) throw new CollabError(`Remove control characters from the ${label}`);
  if (options.required && !text.trim()) throw new CollabError(`Enter a ${label} of 1–${limitLabel(max)}`);
  if ((bytes(max) ? Buffer.byteLength(text) : [...text].length) > max) throw new CollabError(`Keep the ${label} within ${limitLabel(max)}`);
  return text;
}
/** Account ids key inbox and member maps, so prototype names are refused along with anything outside the id alphabet. */
export function validateUserRef(value: unknown, label = "teammate"): string { if (typeof value !== "string" || !PATH_ID.test(value) || UNSAFE_KEYS.includes(value)) throw new CollabError(`Choose the ${label} from the project's members`); return value; }
export function validatePathId(value: unknown, label: string): string { if (typeof value !== "string" || !PATH_ID.test(value) || UNSAFE_KEYS.includes(value)) throw new CollabError(`Use a ${label} of 1–100 letters, digits, underscores or dashes`); return value; }
export function validateRepoKey(value: unknown): string { if (typeof value !== "string" || !REPO_KEY.test(value)) throw new CollabError("Use a repository key of up to 64 lowercase letters, digits or dashes that starts with a letter"); return value; }
export function validateCommit(value: unknown, label = "commit"): string { if (typeof value !== "string" || !COMMIT_ID.test(value)) throw new CollabError(`Send the ${label} as a full lowercase commit hash`); return value; }
/** Branch and tag names follow git-check-ref-format closely enough that nothing here can become a command flag or a path escape. */
export function validateRef(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value || value.length > max || REF_FORBIDDEN.test(value) || value.includes("..") || value.includes("@{") || value.includes("//") || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock") || value.split("/").some((part) => part.startsWith("."))) throw new CollabError(`Use a Git branch, tag or commit of up to ${max} characters for the ${label}`);
  return value;
}
export function validateStatus(value: unknown): TaskStatus { if (typeof value !== "string" || !(TASK_STATUSES as readonly string[]).includes(value)) throw new CollabError("Choose a status: planned, working, blocked, review or done"); return value as TaskStatus; }
function validateTime(value: unknown, label: string): number { if (!integer(value)) throw new CollabError(`Send ${label} as a Unix time in milliseconds`); return value; }
function validateTests(value: unknown): { ok: boolean; command: string; at: number } {
  if (!object(value)) throw new CollabError("Report tests as { ok, command, at }"); assertKeys(value, ["ok", "command", "at"], "test result");
  if (typeof value.ok !== "boolean") throw new CollabError("Report the test result ok flag as true or false");
  return { ok: value.ok, command: validateText(value.command, MAX.command, "test command", { required: true, singleLine: true }), at: validateTime(value.at, "the test time") };
}
function stringList(value: unknown, maxItems: number, maxLength: number, label: string, item: string, singleLine = false): string[] {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new CollabError(`List at most ${maxItems} ${label}`);
  const items: string[] = []; for (const entry of value) { const text = validateText(entry, maxLength, item, { required: true, singleLine }); if (!items.includes(text)) items.push(text); } return items;
}
function userList(value: unknown, max: number, label: string, item: string): string[] {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > max) throw new CollabError(`Add at most ${max} ${label}`);
  const ids: string[] = []; for (const entry of value) { const id = validateUserRef(entry, item); if (!ids.includes(id)) ids.push(id); } return ids;
}
function taskIdList(value: unknown): string[] {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > MAX.dependsOn) throw new CollabError(`A task can depend on at most ${MAX.dependsOn} other tasks`);
  const ids: string[] = []; for (const entry of value) { if (typeof entry !== "string" || !TASK_ID.test(entry)) throw new CollabError("Choose the tasks this one depends on from the board"); if (!ids.includes(entry)) ids.push(entry); } return ids;
}
/** Paths are shown, never opened, on the hub; they still get a length and a control-character bound so a runner cannot flood the board. */
export function validatePaths(value: unknown, label = "changed files"): string[] {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > MAX.changedFiles) throw new CollabError(`List at most ${MAX.changedFiles} ${label}`);
  const paths: string[] = []; for (const entry of value) { if (typeof entry !== "string" || !entry || entry.length > MAX.path || LINE_CONTROL.test(entry)) throw new CollabError(`Each of the ${label} must be a path of 1–${MAX.path} characters without control characters`); if (!paths.includes(entry)) paths.push(entry); } return paths;
}
export function validateRepoRefs(value: unknown): RepoRef[] {
  if (!Array.isArray(value) || value.length > MAX.repositories) throw new CollabError(`Define at most ${MAX.repositories} repositories per project`);
  const refs: RepoRef[] = [], seen = new Set<string>();
  for (const entry of value) {
    if (!object(entry)) throw new CollabError("Each repository needs a key and a label, and may add a remote and a default branch"); assertKeys(entry, ["key", "label", "remote", "defaultBranch"], "repository");
    const key = validateRepoKey(entry.key); if (seen.has(key)) throw new CollabError(`Repository key ${key} is used twice; keys must be unique within a project`); seen.add(key);
    const ref: RepoRef = { key, label: validateText(entry.label ?? key, MAX.repoLabel, "repository label", { required: true, singleLine: true }) };
    const remote = validateText(entry.remote, MAX.repoRemote, "repository remote", { singleLine: true }); if (remote) ref.remote = remote;
    if (!absent(entry.defaultBranch) && entry.defaultBranch !== "") ref.defaultBranch = validateRef(entry.defaultBranch, MAX.branch, "default branch");
    refs.push(ref);
  }
  return refs;
}
/** A validated task creation body: people are referenced by account id here and resolved to `Who` by the store, which knows the members. */
export interface TaskInput { projectId: string; repository: string; title: string; goal: string; acceptance: string; status: TaskStatus; blocker?: string; baseRef?: string; owner?: string; reviewer?: string; collaborators: string[]; dependsOn: string[]; labels: string[] }
/** A partial save: absent fields stay, `null` clears an optional one. */
export interface TaskPatch { repository?: string; title?: string; goal?: string; acceptance?: string; status?: TaskStatus; blocker?: string | null; baseRef?: string | null; owner?: string | null; reviewer?: string | null; collaborators?: string[]; dependsOn?: string[]; labels?: string[] }
const TASK_FIELDS = ["projectId", "repository", "title", "goal", "acceptance", "status", "blocker", "baseRef", "owner", "reviewer", "collaborators", "dependsOn", "labels"] as const;
export const BLOCKER_REQUIRED = "Describe what blocks the task before marking it blocked";
export function validateTaskInput(value: unknown): TaskInput {
  if (!object(value)) throw new CollabError("Send the task as a JSON object"); assertKeys(value, TASK_FIELDS, "task");
  const projectId = validatePathId(value.projectId, "project id"), repository = validateRepoKey(value.repository);
  const title = validateText(value.title, MAX.title, "title", { required: true, singleLine: true }), goal = validateText(value.goal, MAX.goal, "goal"), acceptance = validateText(value.acceptance, MAX.acceptance, "acceptance criteria");
  const status = value.status === undefined ? "planned" : validateStatus(value.status), blocker = validateText(value.blocker, MAX.blocker, "blocker");
  if (status === "blocked" && !blocker.trim()) throw new CollabError(BLOCKER_REQUIRED);
  const input: TaskInput = { projectId, repository, title, goal, acceptance, status, collaborators: userList(value.collaborators, MAX.collaborators, "collaborators", "collaborator"), dependsOn: taskIdList(value.dependsOn), labels: stringList(value.labels, MAX.labels, MAX.label, "labels", "label", true) };
  if (status === "blocked") input.blocker = blocker.trim();
  if (!absent(value.baseRef) && value.baseRef !== "") input.baseRef = validateRef(value.baseRef, MAX.baseRef, "base branch");
  if (!absent(value.owner) && value.owner !== "") input.owner = validateUserRef(value.owner, "owner");
  if (!absent(value.reviewer) && value.reviewer !== "") input.reviewer = validateUserRef(value.reviewer, "reviewer");
  return input;
}
/** `revision` and `id` travel in the same body as the fields and are read by the store, so they pass through here unread. */
export function validateTaskPatch(value: unknown): TaskPatch {
  if (!object(value)) throw new CollabError("Send the task changes as a JSON object");
  if (value.projectId !== undefined) throw new CollabError("Tasks cannot move between projects; create a new task in the other project instead");
  assertKeys(value, [...TASK_FIELDS, "revision", "id"], "task");
  const patch: TaskPatch = {}, cleared = (v: unknown) => v === null || v === "";
  if (value.repository !== undefined) patch.repository = validateRepoKey(value.repository);
  if (value.title !== undefined) patch.title = validateText(value.title, MAX.title, "title", { required: true, singleLine: true });
  if (value.goal !== undefined) patch.goal = validateText(value.goal, MAX.goal, "goal");
  if (value.acceptance !== undefined) patch.acceptance = validateText(value.acceptance, MAX.acceptance, "acceptance criteria");
  if (value.status !== undefined) patch.status = validateStatus(value.status);
  if (value.blocker !== undefined) patch.blocker = cleared(value.blocker) ? null : validateText(value.blocker, MAX.blocker, "blocker").trim() || null;
  if (value.baseRef !== undefined) patch.baseRef = cleared(value.baseRef) ? null : validateRef(value.baseRef, MAX.baseRef, "base branch");
  if (value.owner !== undefined) patch.owner = cleared(value.owner) ? null : validateUserRef(value.owner, "owner");
  if (value.reviewer !== undefined) patch.reviewer = cleared(value.reviewer) ? null : validateUserRef(value.reviewer, "reviewer");
  if (value.collaborators !== undefined) patch.collaborators = userList(value.collaborators, MAX.collaborators, "collaborators", "collaborator");
  if (value.dependsOn !== undefined) patch.dependsOn = taskIdList(value.dependsOn);
  if (value.labels !== undefined) patch.labels = stringList(value.labels, MAX.labels, MAX.label, "labels", "label", true);
  if (patch.status === "blocked" && patch.blocker === null) throw new CollabError(BLOCKER_REQUIRED);
  return patch;
}
const PROGRESS_FIELDS = ["stage", "summary", "runStatus", "changedFiles", "tests", "verdict", "blockers", "head", "branch", "steps", "updatedAt", "seq", "runId"] as const;
/** Report numbers order progress and are compared raw by the store's `seq ≤ lastSeq` guard, so anything but a positive whole number (a string, a fraction, 1e308) would reorder or freeze an attempt for good. */
export function validateSeq(value: unknown): number { if (!integer(value) || value < 1) throw new CollabError("Send seq as a positive whole number that increases with every report"); return value; }
/** Run ids are the engine's `<minute stamp>-<hex>` (or a linked runner's own token); the hub shows and matches them, never opens them, so the path-id alphabet and length are bound enough. */
export function validateRunId(value: unknown): string { return validatePathId(value, "run id"); }
/** A progress report is a whole snapshot, so absent fields mean "nothing to show". `seq` and `runId` ride along for the store and are not part of the progress, but a malformed one is refused here too so no body passes "validation" with a seq the store would compare raw; `POST …/progress` goes through validateProgressReport, which requires `seq` and returns both. */
export function validateProgress(value: unknown, now = Date.now()): AttemptProgress {
  if (!object(value)) throw new CollabError("Send the progress report as a JSON object"); assertKeys(value, PROGRESS_FIELDS, "progress");
  if (!absent(value.seq)) validateSeq(value.seq); if (!absent(value.runId)) validateRunId(value.runId);
  const progress: AttemptProgress = { updatedAt: absent(value.updatedAt) ? now : validateTime(value.updatedAt, "updatedAt") };
  const stage = validateText(value.stage, MAX.stage, "stage", { singleLine: true }); if (stage) progress.stage = stage;
  const summary = validateText(value.summary, MAX.summary, "summary"); if (summary) progress.summary = summary;
  const runStatus = validateText(value.runStatus, MAX.runStatus, "run status", { singleLine: true }); if (runStatus) progress.runStatus = runStatus;
  if (!absent(value.changedFiles)) progress.changedFiles = validatePaths(value.changedFiles);
  if (!absent(value.tests)) progress.tests = validateTests(value.tests);
  if (!absent(value.verdict)) { if (value.verdict !== "passed" && value.verdict !== "failing") throw new CollabError('Report the verdict as "passed" or "failing"'); progress.verdict = value.verdict; }
  if (!absent(value.blockers)) progress.blockers = stringList(value.blockers, MAX.blockers, MAX.blockerItem, "blockers", "blocker");
  if (!absent(value.head)) progress.head = validateCommit(value.head, "head");
  if (!absent(value.branch)) progress.branch = validateRef(value.branch, MAX.branch, "branch");
  if (!absent(value.steps)) {
    if (!object(value.steps)) throw new CollabError("Report steps as { done, total? } counts"); assertKeys(value.steps, ["done", "total"], "steps");
    if (!integer(value.steps.done) || value.steps.done > MAX.steps || (!absent(value.steps.total) && (!integer(value.steps.total) || value.steps.total > MAX.steps || value.steps.total < value.steps.done))) throw new CollabError("Report steps as { done, total? } counts with done no larger than total");
    progress.steps = absent(value.steps.total) ? { done: value.steps.done } : { done: value.steps.done, total: value.steps.total };
  }
  return progress;
}
/** The body of `POST /api/team/attempts/:aid/progress`: the snapshot plus the transport fields the store orders by (`seq`, required) and links the attempt to its run with (`runId`). */
export interface ProgressReport { progress: AttemptProgress; seq: number; runId?: string }
export function validateProgressReport(value: unknown, now = Date.now()): ProgressReport {
  const progress = validateProgress(value, now), body = value as Record<string, unknown>, report: ProgressReport = { progress, seq: validateSeq(body.seq) };
  if (!absent(body.runId)) report.runId = validateRunId(body.runId);
  return report;
}
/** A checkpoint manifest as the hub receives it. `id` is optional and names the checkpoint when present: the runner mints it before bundling, because the bundle's only ref is `refs/codeflow/team/<id>` and every importing machine must land it under the id the board shows. */
export interface CheckpointInput { id?: string; commit: string; baseCommit: string; branch: string; size: number; sha256: string; note: string; requirements: string; decisions: string[]; testResults?: { ok: boolean; command: string; at: number }; remaining: string; changedFiles: string[] }
const CHECKPOINT_FIELDS = ["id", "commit", "baseCommit", "branch", "size", "sha256", "note", "requirements", "decisions", "testResults", "remaining", "changedFiles"] as const;
/** The store decides what an `id` means (the checkpoint's id, refused when taken); here it only has to be a checkpoint id, so a malformed one never reaches a ref name. */
export function validateCheckpointInput(value: unknown): CheckpointInput {
  if (!object(value)) throw new CollabError("Send the checkpoint manifest as a JSON object"); assertKeys(value, CHECKPOINT_FIELDS, "checkpoint");
  const commit = validateCommit(value.commit, "commit"), baseCommit = validateCommit(value.baseCommit, "base commit"), branch = validateRef(value.branch, MAX.branch, "branch");
  if (!integer(value.size) || value.size < 1 || value.size > MAX.bundle) throw new CollabError(`Checkpoint bundles must be between 1 byte and ${MAX.bundle / 1024 / 1024} MiB`);
  if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256)) throw new CollabError("Send the bundle digest as 64 lowercase hex characters of SHA-256");
  const input: CheckpointInput = { commit, baseCommit, branch, size: value.size, sha256: value.sha256, note: validateText(value.note, MAX.note, "note"), requirements: validateText(value.requirements, MAX.requirements, "requirements"), decisions: stringList(value.decisions, MAX.decisions, MAX.decision, "decisions", "decision"), remaining: validateText(value.remaining, MAX.remaining, "remaining work"), changedFiles: validatePaths(value.changedFiles) };
  if (!absent(value.id)) { if (typeof value.id !== "string" || !CHECKPOINT_ID.test(value.id)) throw new CollabError("Send the checkpoint id as 32 lowercase hexadecimal characters"); input.id = value.id; }
  if (!absent(value.testResults)) input.testResults = validateTests(value.testResults);
  return input;
}
/** `@username` tokens that name a project member, as account ids in order of first appearance; trailing punctuation that is not part of a name is forgiven, e-mail addresses are not mentions. When two members share a name the first listed wins: the store lists the hub owner (username `owner`) first, so `@owner` reaches the person running the hub even if an account took that username. */
export function mentionsIn(text: string, members: readonly { userId: string; username: string }[]): string[] {
  const byName = new Map<string, string>(); for (const member of members) { const name = member.username.toLowerCase(); if (!byName.has(name)) byName.set(name, member.userId); }
  const ids: string[] = [];
  for (const match of text.slice(0, 64 * 1024).matchAll(/(?<![A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)) {
    let name = match[1]!.toLowerCase(); while (name && !byName.has(name) && /[._-]$/.test(name)) name = name.slice(0, -1);
    const id = byName.get(name); if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const BUSY_STATES: readonly AttemptState[] = ["claimed", "running", "unknown"], NOT_SUPERSEDED = ATTEMPT_STATES.filter((state) => state !== "superseded");
const latestAttempt = (task: Pick<Task, "attempts">, states: readonly AttemptState[]): Attempt | undefined => { for (let index = task.attempts.length - 1; index >= 0; index--) { const attempt = task.attempts[index]!; if (states.includes(attempt.state)) return attempt; } return undefined; };
/** Execution stays reserved while claimed, running or unknown. Lost contact is not evidence that an agent stopped. */
export function busyAttempt(task: Pick<Task, "attempts">): Attempt | undefined { return latestAttempt(task, ["claimed", "running"]) ?? latestAttempt(task, BUSY_STATES); }
/** The attempt a task is "on": the busy one while a runner executes, else the latest attempt that was not superseded, when it is paused (or unknown: its runner may come back). A paused attempt behind a newer finished, failed or stopped one is history, not the task's state, so the card never reports it over the newer outcome. */
export function currentAttempt(task: Pick<Task, "attempts">): Attempt | undefined { const busy = busyAttempt(task); if (busy) return busy; const latest = latestAttempt(task, NOT_SUPERSEDED); return latest && (latest.state === "paused" || latest.state === "unknown") ? latest : undefined; }
/** Retires an attempt that can no longer continue (paused or stopped behind a change of hands or a newer attempt), saying why in its own reason: the reason it paused with ("resume it from here") would otherwise outlive the Resume it promised. */
export function supersedeAttempt(attempt: Attempt, reason: string, now: number): void { attempt.state = "superseded"; attempt.endedAt = now; attempt.reason = truncateText(reason, MAX.reason); }
/** Older saved boards may still have a paused attempt before a newer result. Its runner cannot revive that older line of work. */
export function assertLatestAttempt(task: Pick<Task, "attempts">, attempt: Attempt): void {
  const latest = latestAttempt(task, NOT_SUPERSEDED);
  if (latest && latest.id !== attempt.id) throw new CollabError("A newer attempt started; continue from the task's latest checkpoint instead", 409);
}
/** Live means a runner is executing and said so within the last 90 s; a paused or unknown attempt has nobody heartbeating for it. */
export function attemptIsLive(attempt: Pick<Attempt, "state" | "lastHeartbeatAt">, now = Date.now()): boolean { return (attempt.state === "claimed" || attempt.state === "running") && now - attempt.lastHeartbeatAt < MAX.heartbeatLiveMs; }
/** Lost contact: marked unknown, or claimed or running without a word for 90 s ("Connection lost"). Execution stays reserved either way, and either is what a human may recover once they confirmed the agent stopped. */
export function attemptLostContact(attempt: Pick<Attempt, "state" | "lastHeartbeatAt">, now = Date.now()): boolean { return attempt.state === "unknown" || ((attempt.state === "claimed" || attempt.state === "running") && !attemptIsLive(attempt, now)); }
export function liveAttempt(task: Pick<Task, "attempts">, now = Date.now()): Attempt | undefined { const busy = busyAttempt(task); return busy && attemptIsLive(busy, now) ? busy : undefined; }
const assertNotBusy = (task: Pick<Task, "attempts">, before: string): void => { const busy = busyAttempt(task); if (busy) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before ${before}`, 409); };
export function latestCheckpoint(task: Pick<Task, "checkpoints">): Checkpoint | undefined { let latest: Checkpoint | undefined; for (const checkpoint of task.checkpoints) if (!latest || checkpoint.at >= latest.at) latest = checkpoint; return latest; }
/** Reviews attach to checkpoints, so only the latest checkpoint's non-stale reviews count and the most recent verdict wins. */
export function reviewState(task: Pick<Task, "checkpoints" | "reviews" | "reviewer"> & Partial<Pick<Task, "owner">>): ReviewState {
  const latest = latestCheckpoint(task); if (!latest) return "none";
  const reviews = task.reviews.filter((review) => review.checkpointId === latest.id && !review.stale && !selfReview(task, review)).sort((a, b) => a.at - b.at), last = reviews[reviews.length - 1];
  if (last) return last.verdict === "approve" ? "approved" : "changes-requested";
  return task.reviewer ? "pending" : "none";
}
/** The blocker a save would leave on the task, in the TaskPatch convention: undefined keeps the recorded one, null clears it, text replaces it. A default parameter could not tell "not sent" from "cleared", because JavaScript applies defaults to an explicit undefined. */
const nextBlocker = (task: Pick<Task, "blocker">, blocker: string | null | undefined): string | undefined => blocker === undefined ? task.blocker : blocker === null ? undefined : blocker;
function transitionProblem(task: Task, to: TaskStatus, actor: CollabActor, blocker: string | null | undefined): { message: string; status: number } | undefined {
  if (!TASK_STATUSES.includes(to)) return { message: "Choose a status: planned, working, blocked, review or done", status: 400 };
  if (!roleAtLeast(actorRole(actor, task.projectId), "contributor")) return { message: "A project contributor role is required to change the status", status: 403 };
  if (to === "blocked" && !nextBlocker(task, blocker)?.trim()) return { message: BLOCKER_REQUIRED, status: 400 };
  if (to === task.status) return undefined;
  if (to === "done") {
    const busy = busyAttempt(task); if (busy) return { message: `Stop the attempt running on ${busy.runnerName} before marking the task done`, status: 409 };
    if (task.handoff?.state === "offered") return { message: "Accept, decline or cancel the offered hand-over before marking the task done", status: 409 };
  }
  return undefined;
}
/** Why the status change is refused, or undefined when it may go ahead. `blocker` follows TaskPatch: omitted keeps the task's blocker, null clears it, text replaces it. */
export function canTransition(task: Task, to: TaskStatus, actor: CollabActor, blocker?: string | null): string | undefined { return transitionProblem(task, to, actor, blocker)?.message; }
/** Applies a status change in place (to a clone, in the store): entering or re-saving `blocked` records the blocker, leaving it clears the blocker. */
export function transition(task: Task, to: TaskStatus, actor: CollabActor, blocker?: string | null, now = Date.now()): Task {
  const problem = transitionProblem(task, to, actor, blocker); if (problem) throw new CollabError(problem.message, problem.status);
  task.status = to; if (to === "blocked") task.blocker = nextBlocker(task, blocker)!.trim(); else delete task.blocker; task.updatedAt = now; return task;
}
/** Owner rules: contributors take unowned tasks and hand back their own; maintainers assign anyone; nobody changes hands under a claimed, running or unknown attempt. `nextOwner` undefined unassigns. */
export function assertCanChangeOwner(task: Task, actor: CollabActor, nextOwner: Pick<Who, "userId"> | undefined): void {
  if (nextOwner?.userId === task.owner?.userId) return;
  const role = actorRole(actor, task.projectId); if (!roleAtLeast(role, "contributor")) throw new CollabError("A project contributor role is required to take a task", 403);
  assertNotBusy(task, "changing the owner");
  if (roleAtLeast(role, "maintainer")) return;
  if (nextOwner === undefined) { if (isTaskOwner(task, actor)) return; throw new CollabError("Only the task owner or a project maintainer may unassign this task", 403); }
  if (nextOwner.userId === actor.userId && !task.owner) return;
  throw new CollabError(task.owner ? "Only a project maintainer may reassign a task that already has an owner" : "Only a project maintainer may assign a task to someone else", 403);
}
/** Changing hands supersedes everything the previous owner's machines left paused or stopped, not only the latest attempt: each is resumable and would stay a live handle onto a task its user no longer owns, and the next attempt starts from a checkpoint, never from one of those worktrees. A claimed, running or unknown attempt refuses the change (409) here as well, so no caller path can move a task under its runner. */
export function assignOwner(task: Task, nextOwner: Who | undefined, now = Date.now()): Task {
  if (nextOwner?.userId !== task.owner?.userId) { assertNotBusy(task, "changing the owner"); const why = nextOwner ? `Superseded when the task passed to ${nextOwner.displayName}; work continues from the task's latest checkpoint` : "Superseded when the task was unassigned; whoever takes it continues from its latest checkpoint"; for (const attempt of task.attempts) if (attempt.state === "paused" || attempt.state === "stopped" || attempt.state === "unknown") supersedeAttempt(attempt, why, now); }
  if (nextOwner) task.owner = { ...nextOwner }; else delete task.owner;
  task.updatedAt = now; return task;
}
/** Why the previous owner's machine is refused, worded by what its user can do now: an owned task is reassigned only by a maintainer, an unowned one can be taken. */
export function ownerChangedMessage(task: Pick<Task, "owner">): string { return task.owner ? `The task now belongs to ${task.owner.displayName}; they continue it from its latest checkpoint, or a project maintainer reassigns it` : "The task has no owner now; take it to start a new attempt from its latest checkpoint"; }
const publicWho = (who: Who): Who => ({ ...who });
/** The board card view of a task. `unreadMentions` is personal and comes from the inbox, so it is attached only when the caller names the person it was counted for. `now` is the snapshot clock the caller already uses for liveness; the card carries timestamps so viewers can judge staleness on their own clock. */
export function summarize(task: Task, forUserId?: string, now = Date.now(), unreadMentions?: number): TaskSummary {
  const attempt = currentAttempt(task), checkpoint = latestCheckpoint(task);
  const summary: TaskSummary = { id: task.id, projectId: task.projectId, repository: task.repository, title: task.title, status: task.status, collaborators: task.collaborators.map(publicWho), dependsOn: [...task.dependsOn], labels: [...task.labels], revision: task.revision, createdAt: task.createdAt, updatedAt: task.updatedAt, reviewState: reviewState(task) };
  if (task.blocker) summary.blocker = task.blocker; if (task.owner) summary.owner = publicWho(task.owner); if (task.reviewer) summary.reviewer = publicWho(task.reviewer);
  if (attempt) summary.attempt = { id: attempt.id, state: attempt.state, runnerName: attempt.runnerName, user: publicWho(attempt.user), lastHeartbeatAt: attempt.lastHeartbeatAt, progress: clone(attempt.progress) };
  if (checkpoint) summary.checkpoint = { id: checkpoint.id, commit: checkpoint.commit, at: checkpoint.at };
  if (task.handoff) summary.handoff = { id: task.handoff.id, to: publicWho(task.handoff.to), from: publicWho(task.handoff.from), state: task.handoff.state };
  if (forUserId !== undefined && unreadMentions !== undefined) summary.unreadMentions = unreadMentions;
  return summary;
}
/** Appends within a hard bound. People-facing lists refuse (the task has grown past what a board should hold); `drop-oldest` is for the audit trail, which is a window, not a record. */
export function pushBounded<T>(list: T[], item: T, max: number, label: string, overflow: "refuse" | "drop-oldest" = "refuse"): T[] {
  if (list.length >= max) { if (overflow === "refuse") throw new CollabError(historyLimitMessage(max, label)); list.splice(0, list.length - max + 1); }
  list.push(item); return list;
}
export function trimAudit<T extends Pick<Task, "audit">>(task: T): T { if (task.audit.length > MAX.audit) task.audit.splice(0, task.audit.length - MAX.audit); return task; }
/** Cuts system-generated text (inbox lines, audit details) to `max` characters with an ellipsis; people's text is refused instead, by validateText. */
export function truncateText(value: string, max: number): string { const chars = [...value]; return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`; }
export function recordAudit(task: Pick<Task, "audit">, by: Who, action: string, detail?: string, now = Date.now()): AuditEntry {
  const entry: AuditEntry = { at: now, by: { userId: by.userId, displayName: by.displayName }, action: truncateText(action, MAX.auditAction) }; if (detail) entry.detail = truncateText(detail, MAX.auditDetail);
  pushBounded(task.audit, entry, MAX.audit, "audit entries", "drop-oldest"); return entry;
}
