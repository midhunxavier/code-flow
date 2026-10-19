import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentId, AgentSettings } from "../adapters/index.js";
import { CODEFLOW_HOME } from "../config.js";
import type { LoopSettings, Pattern, Run, RunEvent, RunManager } from "../engine.js";
import { assertWorktree, commitAll, git, repoRoot, resolveCommit, uncommittedCount } from "../git.js";
import { logError } from "../log.js";
import { redactText } from "../privacy.js";
import { assertTransferTree } from "../remote-workers/bundles.js";
import type { Trust } from "../repo-config.js";
import { checkpointContext, checkpointRef, createCheckpointBundle, ensureCheckpointBranch, importCheckpointBundle } from "./checkpoints.js";
import type { CheckpointContextInput } from "./checkpoints.js";
import type { HubClient, ProgressReportBody } from "./hub-client.js";
import { ATTEMPT_ID, busyAttempt, CHECKPOINT_ID, CollabError, COMMIT_ID, latestCheckpoint, MAX, newAttemptId, newCheckpointId, ownerChangedMessage, TASK_ID } from "./model.js";
import type { AttemptProgress, Checkpoint, CheckpointInput, Instruction, Task } from "./model.js";
import type { FinishInput, FinishState } from "./store.js";

/**
 * The execution side of a team task on this computer: claims an attempt on the hub, starts an ordinary run in
 * the owner's own RunManager, publishes bounded progress and heartbeats while it runs, and turns its result into
 * a checkpoint bundle the hub stores. Everything it must not do twice (claim, report numbers, deliver an
 * instruction, finish) is journaled in `CODEFLOW_HOME/team-link/attempts/<attemptId>.json` before it happens,
 * so reconcile() after a restart only resumes what was already under way and never re-executes anything.
 */
export type LocalAttemptState = "claiming" | "claimed" | "running" | "finished" | "failed" | "paused" | "stopped" | "unknown";
/** A finish the hub has not acknowledged: what to report, and the bundle still to upload when the checkpoint manifest went through but its bytes did not. */
export interface PendingFinish { state: FinishState; head?: string; summary?: string; reason?: string; bundleFile?: string; error: string; at: number; tries: number }
export interface LocalAttemptRecord { attemptId: string; taskId: string; hubUrl?: string; repo: string; base: string; runId?: string; state: LocalAttemptState; lastSeq: number; lastAckedSeq: number; deliveredInstructionIds: string[]; checkpointId?: string; pendingFinish?: PendingFinish; updatedAt: number }
export interface StartAttemptInput { repo?: string; pattern: string | Pattern; roles: Record<string, AgentId[]>; agentSettings?: AgentSettings; roleSettings?: Record<string, AgentSettings>; trust?: Trust; loop?: Partial<LoopSettings>; fromCheckpointId?: string }
export interface HandOverInput { to: string; note?: string; includeUncommitted?: boolean }
/** What the runner needs from RunManager; a Pick so tests and other hosts can hand it a stand-in. */
export type RunnerManager = Pick<RunManager, "start" | "get" | "subscribe" | "cancel" | "resume" | "addNote" | "reviewCoverage" | "list">;
/** `retryIntervalMs` is the recovery timer's period (0 disables it; tests drive retryPending() themselves). */
export interface CollabRunnerOptions { manager: RunnerManager; hub: () => HubClient; findPattern: (id: string) => Pattern | undefined; dir?: string; resolveRepo?: (projectId: string, repoKey: string) => string | undefined; projectFor?: (repo: string) => string | undefined; now?: () => number; retryIntervalMs?: number }
export interface ReconcileResult { attached: number; finished: number; removed: number; unknown: number; retried: number }
interface Active { attemptId: string; runId: string; unsubscribe: () => void; heartbeat?: NodeJS.Timeout; publishTimer?: NodeJS.Timeout; dirty: boolean; ended: boolean; head?: string; changedFiles?: string[]; refreshing?: Promise<void> }
type OutcomeRun = Pick<Run, "status" | "stopReason" | "error"> & Partial<Pick<Run, "repo" | "worktrees">>;

export const PUBLISH_INTERVAL_MS = 2000, HEARTBEAT_INTERVAL_MS = 20_000, RETRY_INTERVAL_MS = 60_000;
/** A finish refused for a reason that may pass later (the hub unreachable, a 5xx, a task the account currently holds no role in) is retried with backoff from 30 s to 30 min, and given up after this many failures: about a day, the hub's own horizon before it marks a silent attempt unknown. */
export const MAX_FINISH_TRIES = 48;
const RETRY_BASE_MS = 30_000, RETRY_MAX_MS = 30 * 60_000;
/** The hub's final word on a finish or a report: the credential is gone (401), another credential executes the attempt (403: this computer was re-linked under a new runner id) or the attempt is already over (409). A 404 is not final: the hub answers it for a task the account currently holds no role in as well as for a deleted one, and a role can be restored. */
const HUB_FINAL: ReadonlySet<number> = new Set([401, 403, 409]);
const LOCAL_STATES: readonly LocalAttemptState[] = ["claiming", "claimed", "running", "finished", "failed", "paused", "stopped", "unknown"];
const RECORD_LIMIT = 256 * 1024, MAX_DELIVERED = 200;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, LINE_CONTROL = /[\x00-\x1f\x7f]/g;
/** Text for the hub, within its validators: control characters out, then cut to `max` characters (or bytes when the bound is a storage size). */
export function clean(value: unknown, max: number, singleLine = false): string {
  let text = typeof value === "string" ? value.replace(singleLine ? LINE_CONTROL : CONTROL, " ") : ""; if (singleLine) text = text.trim();
  const chars = [...text]; if (max >= 1024 && max % 1024 === 0) return Buffer.byteLength(text) <= max ? text : chars.slice(0, fitBytes(chars, max)).join("");
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
/** The longest prefix (in characters) of `chars` whose UTF-8 size stays within `max` bytes. */
function fitBytes(chars: string[], max: number, fromEnd = false): number { let low = 0, high = chars.length; while (low < high) { const mid = (low + high + 1) >> 1, slice = fromEnd ? chars.slice(chars.length - mid) : chars.slice(0, mid); if (Buffer.byteLength(slice.join("")) <= max) low = mid; else high = mid - 1; } return low; }
/** The last `max` bytes of a summary: what is left to do sits at the end of a run's summary, not its start. */
function tail(value: string | undefined, max: number): string { const text = clean(value, Number.MAX_SAFE_INTEGER); if (Buffer.byteLength(text) <= max) return text; const chars = [...text]; return `…${chars.slice(chars.length - fitBytes(chars, max - 3, true)).join("")}`; }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const asCollab = (error: unknown, status = 400) => error instanceof CollabError ? error : new CollabError(message(error), status);
const retryDelay = (tries: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(0, tries - 1), 20));
const PLACEHOLDER = "<local path>", PATH_TAIL = "[^\\s\"'`)\\]<>,;:]*";
const ABSOLUTE_PATH = new RegExp(`(?<=^|[\\s"'\`(\\[<=,])(?:\\/|~\\/|[A-Za-z]:[\\\\/])${PATH_TAIL}`, "g"), PLACEHOLDER_TAIL = new RegExp(`${PLACEHOLDER}${PATH_TAIL}`, "g");
/**
 * Engine and Git messages name this computer's folders (the repository, a worktree, CODEFLOW_HOME), and an attempt's
 * reason is read by every member of the project: docs/security.md promises that local paths stay where the run is, so
 * the paths this computer knows are replaced first (they may contain spaces) and any absolute path left after that.
 */
export function scrubLocalPaths(text: string, known: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const path of [...new Set(known.filter((entry): entry is string => !!entry && isAbsolute(entry)))].sort((a, b) => b.length - a.length)) out = out.split(path).join(PLACEHOLDER);
  return out.replace(ABSOLUTE_PATH, PLACEHOLDER).replace(PLACEHOLDER_TAIL, PLACEHOLDER);
}
const localPaths = (run: Partial<Pick<Run, "repo" | "worktrees">>): string[] => [run.repo, ...(run.worktrees ?? []).map((worktree) => worktree.path), CODEFLOW_HOME, tmpdir(), homedir()].filter((path): path is string => !!path);
/** Redact before truncating so a credential crossing the size limit cannot leave a partial secret in an upload. */
function sharedText(value: unknown, max: number, singleLine = false, paths: readonly string[] = []): string {
  return clean(scrubLocalPaths(redactText(typeof value === "string" ? value : ""), paths), max, singleLine);
}

/** A run's state as the team board shows it: the running step's title, the summary so far, counts, the check, what the run waits for, and (when the caller resolved them) the branch head and changed files. */
export function progressFromRun(run: Pick<Run, "status" | "worktrees"> & Partial<Pick<Run, "repo" | "steps" | "summary" | "verdict" | "lastCheck" | "awaiting" | "team">>, extra: { head?: string; changedFiles?: string[] } = {}, now = Date.now()): AttemptProgress {
  const share = (value: unknown, max: number, singleLine = false) => sharedText(value, max, singleLine, localPaths(run));
  const steps = run.steps ?? [], progress: AttemptProgress = { updatedAt: now, runStatus: clean(run.status, MAX.runStatus, true) || "running" };
  const running = [...steps].reverse().find((step) => step.status === "running");
  const stage = running ? `${running.title}${running.role && running.role !== running.title ? ` (${running.role})` : ""}` : run.status === "running" ? (steps.length ? "Between steps" : "Preparing the worktree") : "";
  if (stage) progress.stage = share(stage, MAX.stage, true);
  const summary = share(run.summary, MAX.summary); if (summary.trim()) progress.summary = summary;
  progress.steps = { done: steps.filter((step) => step.status !== "running").length, total: steps.length };
  if (run.verdict === "passed" || run.verdict === "failing") progress.verdict = run.verdict;
  if (run.lastCheck) progress.tests = { ok: run.lastCheck.ok, command: share(run.lastCheck.command, MAX.command, true) || "check", at: count(run.lastCheck.at) ? run.lastCheck.at : now };
  const blockers: string[] = [];
  if (run.awaiting) blockers.push(share(`Waiting for approval: ${run.awaiting.title}`, MAX.blockerItem, true));
  const question = run.team?.awaitingRequestId ? run.team.messages.find((entry) => entry.requestId === run.team!.awaitingRequestId || entry.id === run.team!.awaitingRequestId) : undefined;
  if (question) blockers.push(share(`Question from ${question.sender}: ${question.body}`, MAX.blockerItem, true)); else if (run.team?.awaitingRequestId) blockers.push("Waiting for an answer to the team's question");
  if (blockers.length) progress.blockers = blockers.slice(0, MAX.blockers);
  const branch = run.worktrees[0]?.branch; if (branch && branch.length <= MAX.branch) progress.branch = share(branch, MAX.branch, true);
  const head = extra.head?.toLowerCase(); if (head && COMMIT_ID.test(head)) progress.head = head;
  if (extra.changedFiles?.length) progress.changedFiles = extra.changedFiles.slice(0, MAX.changedFiles).map((path) => share(path, MAX.path, true)).filter(Boolean);
  return progress;
}
/** The attempt state a finished run reports: cancelled and interrupted runs are resumable here, so they pause rather than fail. The engine's own words travel only with local paths scrubbed. */
export function mapRunStatus(run: OutcomeRun): { state: FinishState; reason?: string } {
  const scrub = (text: unknown) => sharedText(text, MAX.reason, false, localPaths(run));
  switch (run.status) {
    case "done": return { state: "finished" };
    case "failed": return { state: "failed", reason: scrub(run.error) || "The run failed" };
    case "cancelled": return { state: "paused", reason: "Stopped on this computer; resume it from here to continue" };
    case "stopped": return { state: "stopped", reason: scrub(run.stopReason) || "The run stopped at a limit; resume it to continue" };
    case "interrupted": return { state: "paused", reason: "interrupted by a restart; resume from this computer" };
    default: throw new CollabError("The run is still running; stop it before finishing the attempt", 409);
  }
}
/** The agent's task: the task text itself (goal and acceptance are the work, not information about it), the team's decisions, and a checkpoint's fenced hand-over context when the attempt continues from one. */
export function taskPrompt(task: Pick<Task, "id" | "projectId" | "title" | "goal" | "acceptance" | "decisions">, context: { projectName?: string; checkpoint?: CheckpointContextInput } = {}): string {
  const section = (title: string, body: string) => body.trim() ? `## ${title}\n\n${body.trim()}` : "";
  const parts = [
    `Team task ${task.id} in project ${context.projectName?.trim() || task.projectId}; your result will be published to the team board.`,
    `# ${task.title.trim()}`,
    section("Goal", task.goal), section("Acceptance criteria", task.acceptance),
    task.decisions.length ? section("Decisions already made", task.decisions.slice(0, MAX.decisions).map((decision) => `- ${decision.text}`).join("\n")) : "",
    context.checkpoint ? checkpointContext(context.checkpoint) : "",
  ];
  return parts.filter(Boolean).join("\n\n").trimEnd() + "\n";
}
/** The note an approved instruction becomes: attributed, so the agent knows a teammate is speaking through the task owner. */
export function instructionNote(instruction: Pick<Instruction, "by" | "text">): string { return `Instruction from ${clean(instruction.by.displayName, MAX.displayName, true) || "a teammate"} via the team board:\n${clean(instruction.text, MAX.text)}`; }
function validateRecord(raw: unknown): LocalAttemptRecord | undefined {
  if (!object(raw) || typeof raw.attemptId !== "string" || !ATTEMPT_ID.test(raw.attemptId) || typeof raw.taskId !== "string" || !TASK_ID.test(raw.taskId) || typeof raw.repo !== "string" || !isAbsolute(raw.repo) || typeof raw.base !== "string" || !COMMIT_ID.test(raw.base)) return undefined;
  if (typeof raw.state !== "string" || !(LOCAL_STATES as readonly string[]).includes(raw.state) || !count(raw.lastSeq) || !count(raw.lastAckedSeq) || !count(raw.updatedAt) || !Array.isArray(raw.deliveredInstructionIds) || raw.deliveredInstructionIds.some((id) => typeof id !== "string" || id.length > 40)) return undefined;
  const record: LocalAttemptRecord = { attemptId: raw.attemptId, taskId: raw.taskId, repo: raw.repo, base: raw.base, state: raw.state as LocalAttemptState, lastSeq: raw.lastSeq, lastAckedSeq: raw.lastAckedSeq, deliveredInstructionIds: raw.deliveredInstructionIds.slice(0, MAX_DELIVERED) as string[], updatedAt: raw.updatedAt };
  if (typeof raw.hubUrl === "string" && raw.hubUrl.length <= 2048) record.hubUrl = raw.hubUrl; if (typeof raw.runId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.runId)) record.runId = raw.runId; if (typeof raw.checkpointId === "string" && CHECKPOINT_ID.test(raw.checkpointId)) record.checkpointId = raw.checkpointId;
  if (object(raw.pendingFinish) && typeof raw.pendingFinish.state === "string" && ["finished", "failed", "stopped", "paused", "unknown"].includes(raw.pendingFinish.state)) {
    const p = raw.pendingFinish, pending: PendingFinish = { state: p.state as FinishState, error: typeof p.error === "string" ? p.error.slice(0, 1000) : "", at: count(p.at) ? p.at : 0, tries: count(p.tries) ? p.tries : 0 };
    if (typeof p.head === "string" && COMMIT_ID.test(p.head)) pending.head = p.head; if (typeof p.summary === "string") pending.summary = clean(p.summary, MAX.summary); if (typeof p.reason === "string") pending.reason = clean(p.reason, MAX.reason); if (typeof p.bundleFile === "string" && isAbsolute(p.bundleFile)) pending.bundleFile = p.bundleFile;
    record.pendingFinish = pending;
  }
  return record;
}
/** The checkpoint id a bundle advertises in its only ref. The runner mints the id before bundling and the hub keeps it as the checkpoint's id (store.addCheckpoint), so the two must agree: importById refuses a bundle that names another checkpoint before anything reaches the repository. */
async function embeddedCheckpointId(repo: string, file: string): Promise<string> {
  const heads = await git(["bundle", "list-heads", file], repo, { timeoutMs: 30_000 }); if (heads.code) throw new CollabError(`Git cannot read the downloaded checkpoint bundle (${heads.stderr.trim().slice(-300) || "unknown error"}); download it again`);
  const lines = heads.stdout.trim().split("\n").filter(Boolean), match = lines.length === 1 ? /^[a-f0-9]{40,64} refs\/codeflow\/team\/([a-f0-9]{32})$/.exec(lines[0]!) : null;
  if (!match) throw new CollabError("The checkpoint bundle does not advertise exactly one team checkpoint reference; download it again or delete the checkpoint");
  return match[1]!;
}
/** Repositories with submodules or checkout filters cannot carry checkpoints (docs/team-collaboration.md), so they are refused before an attempt is claimed rather than after a run whose result could never be published. */
async function assertCheckpointable(repo: string, commit: string): Promise<void> {
  try { await assertTransferTree(repo, commit); }
  catch (error) {
    const text = message(error), why = text.includes("submodule") ? "it has a submodule" : text.includes("checkout filters") ? "it configures a checkout filter such as Git LFS in .gitattributes" : text.includes("20,000 files") ? "its tree exceeds 20,000 files, 256 MiB or 100 attribute files" : text.includes("256 KiB") ? "its checkout attributes exceed 256 KiB" : scrubLocalPaths(text, [repo]);
    throw new CollabError(`This repository cannot carry team checkpoints (${why}); use a repository without submodules or checkout filters for board tasks`);
  }
}
const emptyResult = (): ReconcileResult => ({ attached: 0, finished: 0, removed: 0, unknown: 0, retried: 0 });

export class CollabRunner {
  readonly dir: string; private readonly attemptsDir: string; private readonly bundlesDir: string;
  private readonly records = new Map<string, LocalAttemptRecord>(); private loading?: Promise<void>;
  private readonly active = new Map<string, Active>(); private readonly chains = new Map<string, Promise<unknown>>(); private closed = false;
  /** Attempts between startAttempt's first journal write and its attach(): a recovery pass must not read them as claims that never got their answer. */
  private readonly starting = new Set<string>();
  private readonly retryTimer?: NodeJS.Timeout;
  private readonly now: () => number;
  constructor(private readonly options: CollabRunnerOptions) {
    this.dir = options.dir ?? join(CODEFLOW_HOME, "team-link"); this.attemptsDir = join(this.dir, "attempts"); this.bundlesDir = join(this.dir, "bundles"); this.now = options.now ?? Date.now;
    const interval = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
    if (interval > 0) { this.retryTimer = setInterval(() => void this.retryPending().catch((error) => logError("The team attempt recovery pass failed; it runs again in a minute", error)), interval); this.retryTimer.unref?.(); }
  }
  /** The hub as currently linked; the provider lets the server swap a LocalHub for a RemoteHub when the link changes. */
  get hub(): HubClient { return this.options.hub(); }
  private get manager() { return this.options.manager; }

  // ---- Local records: journaled before every step the hub must see at most once.
  /** Re-reading the files never replaces a record that work in progress holds (a run being followed, a start under way, or an operation queued on its chain): that object carries changes its save has not finished writing, and a stale copy from disk would make the next pass publish the finish a second time or reuse a report number. */
  private load(force = false): Promise<void> {
    if (force) this.loading = undefined;
    return this.loading ??= (async () => {
      let names: string[]; try { names = await readdir(this.attemptsDir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") logError(`Couldn't list ${this.attemptsDir}; local attempt records are unavailable`, error); names = []; }
      const seen = new Set<string>();
      for (const name of names) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue; const file = join(this.attemptsDir, name);
        try { const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let body: string; try { const info = await handle.stat(); if (!info.isFile() || info.size > RECORD_LIMIT) throw new Error("not a regular file within 256 KiB"); body = await handle.readFile("utf8"); } finally { await handle.close(); } const record = validateRecord(JSON.parse(body)); if (!record || `${record.attemptId}.json` !== name) throw new Error("the record does not describe the attempt its file is named after"); if (this.active.has(record.attemptId) || this.starting.has(record.attemptId) || this.chains.has(record.attemptId)) { seen.add(record.attemptId); continue; } this.records.set(record.attemptId, record); seen.add(record.attemptId); }
        catch (error) { logError(`Skipping the unreadable attempt record ${file}; remove it if the attempt is over`, error); }
      }
      for (const id of [...this.records.keys()]) if (!seen.has(id) && !this.active.has(id) && !this.starting.has(id) && !this.chains.has(id)) this.records.delete(id);
    })();
  }
  private async record(attemptId: string): Promise<LocalAttemptRecord | undefined> { await this.load(); return this.records.get(attemptId); }
  private async save(record: LocalAttemptRecord): Promise<void> {
    record.updatedAt = this.now(); this.records.set(record.attemptId, record); await mkdir(this.attemptsDir, { recursive: true, mode: 0o700 });
    const file = join(this.attemptsDir, `${record.attemptId}.json`), temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); } await rename(temp, file); } finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  private async remove(attemptId: string): Promise<void> { this.records.delete(attemptId); await rm(join(this.attemptsDir, `${attemptId}.json`), { force: true }).catch(() => undefined); }
  /** One operation at a time per attempt, so report numbers go out in order and a finish never races a publish. */
  private serial<T>(attemptId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(attemptId) ?? Promise.resolve(), next = previous.catch(() => undefined).then(fn);
    this.chains.set(attemptId, next); next.finally(() => { if (this.chains.get(attemptId) === next) this.chains.delete(attemptId); }).catch(() => undefined); return next;
  }
  async attempts(): Promise<LocalAttemptRecord[]> { await this.load(); return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((record) => structuredClone(record)); }
  attemptForRun(runId: string): LocalAttemptRecord | undefined { for (const record of this.records.values()) if (record.runId === runId) return structuredClone(record); return undefined; }
  /** The latest local attempt of a task, optionally among some states; what the stop/resume/hand-over routes act on. */
  async attemptForTask(taskId: string, states?: readonly LocalAttemptState[]): Promise<LocalAttemptRecord | undefined> { await this.load(); let found: LocalAttemptRecord | undefined; for (const record of this.records.values()) if (record.taskId === taskId && (!states || states.includes(record.state)) && (!found || record.updatedAt >= found.updatedAt)) found = record; return found && structuredClone(found); }
  private assertOpen() { if (this.closed) throw new CollabError("code-flow is shutting down; team attempts cannot start now", 503); }

  // ---- Repositories and checkpoints on this computer
  private async repoAt(path: unknown, hint: string): Promise<string> {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) throw new CollabError(hint);
    try { return await realpath(await repoRoot(path)); } catch { throw new CollabError(`${path} is not inside a Git repository on this computer`); }
  }
  private resolveRepo(task: Pick<Task, "projectId" | "repository">, explicit: string | undefined): Promise<string> {
    const path = explicit ?? this.options.resolveRepo?.(task.projectId, task.repository);
    if (!path) throw new CollabError(`Map repository ${task.repository} to a folder in Settings → Team, or choose the folder when starting`);
    return this.repoAt(path, "Repository must be an absolute path");
  }
  /** Download, verify and import a checkpoint's bundle into `repo` under `refs/codeflow/team/<checkpoint id>`; idempotent, and HEAD/branches stay untouched. A bundle whose ref names another checkpoint is refused (409) rather than filed under the wrong id on this computer. */
  private async importById(repo: string, checkpointId: string): Promise<{ manifest: Checkpoint; commit: string }> {
    if (!CHECKPOINT_ID.test(checkpointId)) throw new CollabError("Send the checkpoint id as 32 lowercase hexadecimal characters");
    await mkdir(tmpdir(), { recursive: true }).catch(() => undefined); const file = join(tmpdir(), `codeflow-team-download-${checkpointId}-${randomBytes(6).toString("hex")}.bundle`);
    try {
      const manifest = await this.hub.downloadBundle(checkpointId, file), embedded = await embeddedCheckpointId(repo, file);
      if (embedded !== checkpointId) throw new CollabError(`The downloaded bundle does not belong to checkpoint ${checkpointId}; it advertises refs/codeflow/team/${embedded}. Delete this checkpoint and create a new one from the computer that holds the work`, 409);
      const { commit } = await importCheckpointBundle(repo, file, { id: checkpointId, commit: manifest.commit, baseCommit: manifest.baseCommit, size: manifest.size, sha256: manifest.sha256, ref: checkpointRef(checkpointId) });
      return { manifest, commit };
    } finally { await rm(file, { force: true }).catch(() => undefined); }
  }
  /** The checkpoint of what a run left on its branch. Its id is minted here, before bundling, and travels in the manifest: the bundle's only ref is `refs/codeflow/team/<id>` and the hub keeps that id as the checkpoint's, so the board, the branch `team/<task>/<id8>` and the refs on every importing machine agree. The bundle is kept under this runner's folder until the hub has its bytes, so a failed upload is retried, never rebuilt; a bundle kept for an earlier checkpoint of the attempt is dropped first, never left behind. */
  private async publishCheckpoint(record: LocalAttemptRecord, run: Pick<Run, "repo" | "summary" | "lastCheck"> & OutcomeRun, task: Task, head: string, branch: string, note: string, changedFiles: string[]): Promise<Checkpoint> {
    await this.dropKept(record);
    // Carry the original shared base through every continuation. Each bundle then includes the entire chain of
    // teammates' commits and can be imported by a fresh clone even after earlier bundles have been deleted.
    const parentId = task.attempts.find((attempt) => attempt.id === record.attemptId)?.fromCheckpointId;
    const parent = parentId ? task.checkpoints.find((checkpoint) => checkpoint.id === parentId) : undefined;
    if (parentId && !parent) throw new CollabError("The checkpoint this attempt continued from is missing; restore its manifest before publishing", 409);
    const baseCommit = parent?.baseCommit ?? record.base;
    const share = (value: unknown, max: number, singleLine = false) => sharedText(value, max, singleLine, localPaths(run));
    const checkpointId = newCheckpointId(), bundle = await createCheckpointBundle(run.repo, head, baseCommit, checkpointId), kept = join(this.bundlesDir, `${checkpointId}.bundle`);
    await mkdir(this.bundlesDir, { recursive: true, mode: 0o700 });
    try { await rename(bundle.file, kept); } catch { await copyFile(bundle.file, kept, constants.COPYFILE_EXCL); await rm(bundle.file, { force: true }); }
    const manifest: CheckpointInput = { id: checkpointId, commit: head, baseCommit, branch: share(branch, MAX.branch, true), size: bundle.size, sha256: bundle.sha256, note: share(note, MAX.note), requirements: share(`${task.title}\n\n## Goal\n${task.goal}\n\n## Acceptance criteria\n${task.acceptance}`, MAX.requirements), decisions: task.decisions.slice(0, MAX.decisions).map((decision) => share(decision.text, MAX.decision)).filter(Boolean), remaining: tail(share(run.summary, Number.MAX_SAFE_INTEGER), MAX.remaining), changedFiles: changedFiles.slice(0, MAX.changedFiles).map((path) => share(path, MAX.path, true)).filter(Boolean) };
    if (run.lastCheck) manifest.testResults = { ok: run.lastCheck.ok, command: share(run.lastCheck.command, MAX.command, true) || "check", at: count(run.lastCheck.at) ? run.lastCheck.at : this.now() };
    let checkpoint: Checkpoint; try { checkpoint = await this.hub.addCheckpoint(record.attemptId, manifest); } catch (error) { await rm(kept, { force: true }).catch(() => undefined); throw error; }
    // A hub that renamed the checkpoint would store a bundle no importer accepts (its ref names this id), so the mismatch is refused here, where the bundle can still be dropped.
    if (checkpoint.id !== checkpointId) { await rm(kept, { force: true }).catch(() => undefined); throw new CollabError(`The team server named the checkpoint ${checkpoint.id} instead of ${checkpointId}, so its bundle could never be imported; update the team server to a code-flow that keeps checkpoint ids`, 502); }
    // The pending finish records what the run's end reports (a hand-over of a paused attempt stays paused, not "finished") plus the bundle still to upload.
    record.checkpointId = checkpoint.id; record.pendingFinish = { state: run.status === "running" ? "finished" : mapRunStatus(run).state, error: "", at: this.now(), tries: 0, ...record.pendingFinish, bundleFile: kept }; await this.save(record);
    await this.uploadKept(record, checkpoint); return checkpoint;
  }
  /** Uploads the kept bundle of `checkpoint`. The hub refuses a repeated upload before reading the body and drops the socket, so a retry of an upload it already completed can end in a write error rather than its 409: the checkpoint on the hub, not the answer, says whether the bytes arrived. */
  private async uploadKept(record: LocalAttemptRecord, checkpoint: Pick<Checkpoint, "id" | "size" | "sha256">): Promise<void> {
    const kept = record.pendingFinish?.bundleFile; if (!kept) return;
    try { await this.hub.uploadBundle(checkpoint.id, kept, { size: checkpoint.size, sha256: checkpoint.sha256 }); }
    catch (error) {
      const already = error instanceof CollabError && error.status === 409 && /already uploaded/.test(error.message);
      const stored = already ? undefined : await this.hub.task(record.taskId).then((task) => task.checkpoints.find((entry) => entry.id === checkpoint.id)).catch(() => undefined);
      if (!already && !(stored?.bundle === "available" && stored.sha256 === checkpoint.sha256)) throw error;
    }
    await this.dropKept(record); await this.save(record);
  }
  /** Removes the bundle kept for a checkpoint this computer no longer needs to upload (the hub has it, it was replaced, the attempt is over); the caller saves the record. */
  private async dropKept(record: LocalAttemptRecord): Promise<void> { const kept = record.pendingFinish?.bundleFile; if (!kept) return; await rm(kept, { force: true }).catch(() => undefined); delete record.pendingFinish!.bundleFile; }
  /**
   * The hub's checkpoint of `head` for this attempt, bytes included: the one already recorded when it still names this
   * head (its kept bundle uploaded when the hub lacks the bytes, dropped when the hub has them), else a new one. A
   * checkpoint deleted on the hub, or left pending without a bundle here, is replaced. Runs under serial(record.attemptId).
   */
  private async ensureCheckpoint(record: LocalAttemptRecord, run: Pick<Run, "repo" | "summary" | "lastCheck"> & OutcomeRun, task: Task, head: string, branch: string, note: string, files: string[]): Promise<string> {
    const attempt = task.attempts.find((entry) => entry.id === record.attemptId), id = record.checkpointId ?? attempt?.checkpointId, existing = id ? task.checkpoints.find((entry) => entry.id === id) : undefined;
    if (existing && existing.commit === head && existing.bundle !== "deleted") {
      if (existing.bundle === "available") { await this.dropKept(record); await this.save(record); return existing.id; }
      if (record.pendingFinish?.bundleFile) { try { await this.uploadKept(record, existing); return existing.id; } catch (error) { if (!(error instanceof CollabError && error.status === 409 && /deleted/.test(error.message))) throw error; } }
    }
    return (await this.publishCheckpoint(record, run, task, head, branch, note, files)).id;
  }
  private async changedFilesOf(runId: string, branch: string): Promise<{ head: string; files: string[] } | undefined> { try { const coverage = await this.manager.reviewCoverage(runId, branch); return { head: coverage.head, files: coverage.files }; } catch { return undefined; } }

  // ---- Starting, attaching, publishing
  async startAttempt(taskId: string, input: StartAttemptInput): Promise<{ attemptId: string; runId: string }> {
    this.assertOpen(); const hub = this.hub; let task = await hub.task(taskId);
    const pattern = typeof input.pattern === "string" ? this.options.findPattern(input.pattern) : input.pattern; if (!pattern) throw new CollabError("Unknown pattern");
    // A busy attempt of this very computer with nothing running behind it (a claim whose answer was lost, a finish the hub never got) is settled here, rather than refused as "stop it first" until the next recovery pass.
    let busy = busyAttempt(task); if (busy && busy.runnerId === hub.runnerId && await this.settleStale(busy.id)) { task = await hub.task(taskId); busy = busyAttempt(task); }
    if (busy) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before starting another`, 409);
    if (task.handoff?.state === "offered") throw new CollabError("Accept, decline or cancel the offered hand-over before starting an attempt", 409);
    const repo = await this.resolveRepo(task, input.repo); let checkpoint: Checkpoint | undefined, base: string;
    if (input.fromCheckpointId !== undefined) {
      checkpoint = task.checkpoints.find((entry) => entry.id === input.fromCheckpointId); if (!checkpoint) throw new CollabError("Checkpoint not found", 404);
      if (checkpoint.bundle !== "available") throw new CollabError("The checkpoint's bundle is not on the team server; choose another checkpoint or start from the base branch", 409);
      base = (await this.importById(repo, checkpoint.id)).commit;
      // The download can take minutes, during which comments and reviews bump the task's revision: the claim goes out against the task as it is now, re-checked for what matters.
      task = await hub.task(taskId); busy = busyAttempt(task); if (busy) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before starting another`, 409); if (task.handoff?.state === "offered") throw new CollabError("Accept, decline or cancel the offered hand-over before starting an attempt", 409);
    } else { const ref = task.baseRef ?? "HEAD"; try { base = await resolveCommit(repo, ref); } catch { throw new CollabError(`Base ${ref} does not exist in ${repo}; fetch it or change the task's base branch`); } await assertCheckpointable(repo, base); }
    const record: LocalAttemptRecord = { attemptId: newAttemptId(), taskId: task.id, repo, base, state: "claiming", lastSeq: 0, lastAckedSeq: 0, deliveredInstructionIds: [], updatedAt: this.now() }; if (hub.url) record.hubUrl = hub.url;
    this.starting.add(record.attemptId);
    try {
      await this.save(record);
      // A definite refusal (4xx) means the hub never saw the claim; a network failure is ambiguous, so the "claiming" record stays for the recovery pass to settle against the hub.
      let claimed: Task; try { claimed = await hub.claimAttempt(task.id, { attemptId: record.attemptId, runnerId: hub.runnerId, runnerName: hub.runnerName, baseCommit: base, ...(checkpoint ? { fromCheckpointId: checkpoint.id } : {}), revision: task.revision }); } catch (error) { if (error instanceof CollabError && error.status < 500) await this.remove(record.attemptId); throw error; }
      record.state = "claimed"; await this.save(record);
      const projectName = await hub.board(task.projectId).then((board) => board.projects.find((project) => project.id === task.projectId)?.name).catch(() => undefined);
      // A hand-over's note is written for whoever continues: when this attempt continues from the checkpoint that was handed over, the note joins the checkpoint's own (a reused checkpoint carries none of it otherwise).
      const handover = checkpoint ? [...claimed.handoffs].reverse().find((entry) => entry.state === "accepted" && entry.checkpointId === checkpoint.id) : undefined, handoverNote = handover?.note.trim() ?? "";
      const context = checkpoint && handoverNote && handoverNote !== checkpoint.note.trim() ? { ...checkpoint, note: clean([checkpoint.note.trim(), `Hand-over note from ${clean(handover!.from.displayName, MAX.displayName, true) || "a teammate"}: ${handoverNote}`].filter(Boolean).join("\n\n"), MAX.note) } : checkpoint;
      const prompt = taskPrompt(claimed, { projectName, checkpoint: context });
      let run: Run;
      try { run = await this.manager.start({ pattern, task: prompt, repo, baseRef: base, roles: input.roles, options: {}, agentSettings: input.agentSettings, roleSettings: input.roleSettings, trust: input.trust, loop: input.loop, project: this.options.projectFor?.(repo) }); }
      catch (error) {
        // Journaled as a pending finish before it is sent: a hub that cannot be reached right now learns of the failure from the recovery pass, instead of showing the attempt claimed (and the task busy) until its 24 h prune.
        const reason = sharedText(`The run could not start on this computer: ${message(error)}`, MAX.reason, false, localPaths({ repo }));
        record.state = "failed"; record.pendingFinish = { state: "failed", reason, error: "", at: this.now(), tries: 0 }; await this.save(record);
        await this.withoutRun(record, "failed", reason).catch((failure) => logError("The team server could not be told that the run failed to start; the recovery pass retries it", failure));
        throw asCollab(error);
      }
      record.runId = run.id; record.state = "running"; await this.save(record);
      await this.serial(record.attemptId, () => this.report(record, { runId: run.id, runStatus: "running", updatedAt: this.now() }));
      this.attach(record.attemptId, run.id); return { attemptId: record.attemptId, runId: run.id };
    } finally { this.starting.delete(record.attemptId); }
  }
  /** Journals the next report number before it goes out, so a crash can never reuse one; a failed send is not retried (the next snapshot supersedes it). */
  private async report(record: LocalAttemptRecord, body: Omit<ProgressReportBody, "seq">): Promise<number | undefined> {
    const seq = ++record.lastSeq; if (record.state === "claimed" || record.state === "paused" || record.state === "stopped" || record.state === "unknown") record.state = "running"; await this.save(record);
    try { await this.hub.progress(record.attemptId, { seq, ...body }); record.lastAckedSeq = seq; await this.save(record); return undefined; }
    catch (error) { logError(`Progress report ${seq} for attempt ${record.attemptId} did not reach the team server`, error); return error instanceof CollabError ? error.status : undefined; }
  }
  /** Losing execution authority stops the local agent as well as its reports. The hub keeps unknown attempts reserved until stopping is confirmed. */
  private hubEnded(live: Active, status: number | undefined, what: string): boolean { if (status === undefined || !HUB_FINAL.has(status)) return false; logError(`The team server no longer accepts ${what} for attempt ${live.attemptId} (HTTP ${status}); stopping run ${live.runId}`); this.detach(live); this.manager.cancel(live.runId); return true; }
  /** Follows a run already started for an attempt: bounded snapshots at most every 2 s (at once when it ends), the branch head after each step, heartbeats every 20 s, and the finish when the run ends. */
  attach(attemptId: string, runId: string): void {
    if (this.closed || this.active.has(attemptId)) return;
    const run = this.manager.get(runId); if (!run) { void this.serial(attemptId, async () => { const record = await this.record(attemptId); if (record) await this.lost(record, `Run ${runId} is missing from this computer`); }); return; }
    const live: Active = { attemptId, runId, unsubscribe: () => {}, dirty: true, ended: false }; this.active.set(attemptId, live);
    live.unsubscribe = this.manager.subscribe(runId, (event: RunEvent) => {
      if (live.ended) return;
      if (event.type === "step" && event.step.status !== "running") void this.refreshHead(live);
      if (event.type === "run" || event.type === "step") this.schedulePublish(live);
      if (event.type === "run" && event.run.status !== "running") this.terminal(live);
    });
    live.heartbeat = setInterval(() => void this.heartbeatNow(live), HEARTBEAT_INTERVAL_MS); live.heartbeat.unref?.();
    void this.refreshHead(live); this.schedulePublish(live, true);
    if (run.status !== "running") this.terminal(live);
  }
  private refreshHead(live: Active): Promise<void> {
    const run = this.manager.get(live.runId), branch = run?.worktrees[0]?.branch; if (!run || !branch) return Promise.resolve();
    const work = this.changedFilesOf(run.id, branch).then((result) => { if (result) { live.head = result.head; live.changedFiles = result.files; live.dirty = true; } }); live.refreshing = work; return work;
  }
  private schedulePublish(live: Active, immediate = false): void {
    live.dirty = true; if (live.ended) return;
    if (immediate) { if (live.publishTimer) { clearTimeout(live.publishTimer); live.publishTimer = undefined; } void this.publish(live); return; }
    if (live.publishTimer) return; live.publishTimer = setTimeout(() => { live.publishTimer = undefined; void this.publish(live); }, PUBLISH_INTERVAL_MS); live.publishTimer.unref?.();
  }
  private publish(live: Active): Promise<void> {
    return this.serial(live.attemptId, async () => {
      if (!live.dirty || this.closed) return; live.dirty = false; await live.refreshing?.catch(() => undefined);
      // Snapshots are for a run that goes; the terminal one is finishNow's, so a run that ended never revives a paused attempt on the hub with a late report.
      const record = await this.record(live.attemptId), run = this.manager.get(live.runId); if (!record || !run || run.status !== "running" || record.state === "finished" || record.state === "failed") return;
      this.hubEnded(live, await this.report(record, { ...progressFromRun(run, { head: live.head, changedFiles: live.changedFiles }, this.now()), runId: live.runId }), "progress reports");
    });
  }
  private detach(live: Active): void { live.ended = true; if (live.publishTimer) clearTimeout(live.publishTimer); if (live.heartbeat) clearInterval(live.heartbeat); live.unsubscribe(); if (this.active.get(live.attemptId) === live) this.active.delete(live.attemptId); }
  private terminal(live: Active): void {
    if (live.ended) return; this.detach(live);
    void this.serial(live.attemptId, async () => { const record = await this.record(live.attemptId); if (!record || this.closed) return; await this.finishNow(record).catch((error) => logError(`Attempt ${record.attemptId} could not be finished on the team server; it is retried by the recovery pass`, error)); });
  }
  /** Delivers approved instructions once each: the note reaches the agent, the id is journaled, then the hub is told; a crash in between is caught by the journal, not by a second note. */
  private heartbeatNow(live: Active): Promise<string[]> {
    return this.serial(live.attemptId, async () => {
      if (live.ended || this.closed) return []; const record = await this.record(live.attemptId); if (!record) return [];
      let result: { instructions: Instruction[] }; try { result = await this.hub.heartbeat(record.attemptId); } catch (error) { if (!this.hubEnded(live, error instanceof CollabError ? error.status : undefined, "heartbeats")) logError(`Heartbeat for attempt ${record.attemptId} did not reach the team server`, error); return []; }
      const delivered: string[] = [];
      for (const instruction of result.instructions) {
        if (instruction.state !== "approved") continue;
        if (!record.deliveredInstructionIds.includes(instruction.id)) {
          try { this.manager.addNote(live.runId, instructionNote(instruction)); } catch (error) { logError(`Instruction ${instruction.id} could not be handed to the run ${live.runId}`, error); continue; }
          record.deliveredInstructionIds.push(instruction.id); if (record.deliveredInstructionIds.length > MAX_DELIVERED) record.deliveredInstructionIds.splice(0, record.deliveredInstructionIds.length - MAX_DELIVERED); await this.save(record); delivered.push(instruction.id);
        }
        try { await this.hub.markInstructionDelivered(record.taskId, instruction.id, record.attemptId); } catch (error) { logError(`Instruction ${instruction.id} was delivered but the team server could not be told`, error); }
      }
      return delivered;
    });
  }
  /** A heartbeat on demand (the timer sends one every 20 s): returns the ids of instructions handed to the agent this time. */
  async heartbeat(attemptId: string): Promise<string[]> { const live = this.active.get(attemptId); if (!live) throw new CollabError("This attempt is not running on this computer", 409); return this.heartbeatNow(live); }

  // ---- Finishing
  async finishAttempt(attemptId: string): Promise<LocalAttemptRecord> { const record = await this.record(attemptId); if (!record) throw new CollabError("Attempt not found on this computer", 404); return this.serial(attemptId, () => this.finishNow(record)); }
  /**
   * The terminal snapshot (with the branch head and changed files) goes out first, so the hub's attempt knows its run even
   * when the finish is the first thing this computer managed to send; then the checkpoint, then the finish. Idempotent: an
   * attempt whose publish failed keeps `pendingFinish` and is finished again with the same checkpoint on the next call. A
   * checkpoint the hub or Git would refuse again (a tree checkpoints cannot carry, a bundle over 64 MiB, a manifest the hub
   * rejects) does not hold the attempt open: the task is released with the reason, and the work stays on this computer's branch.
   */
  private async finishNow(record: LocalAttemptRecord): Promise<LocalAttemptRecord> {
    const run = record.runId ? this.manager.get(record.runId) : undefined;
    // A start that failed after the claim left a `failed` finish with its reason to publish; anything else without a run behind it is lost.
    if (!run && !record.runId && record.pendingFinish?.state === "failed") return this.withoutRun(record, "failed", record.pendingFinish.reason ?? "The run could not start on this computer");
    if (!run) return this.lost(record, record.runId ? `Run ${record.runId} is missing from this computer` : "The run never started on this computer; start a new attempt");
    if (run.status === "running") throw new CollabError("The run is still running; stop it before finishing the attempt", 409);
    const outcome = mapRunStatus(run), branch = run.worktrees[0]?.branch, coverage = branch ? await this.changedFilesOf(run.id, branch) : undefined, head = coverage?.head ?? (branch ? await resolveCommit(run.repo, `refs/heads/${branch}`).catch(() => undefined) : undefined);
    if (record.state !== "finished" && record.state !== "failed" && !record.pendingFinish) await this.report(record, { ...progressFromRun(run, { head, changedFiles: coverage?.files }, this.now()), runId: run.id });
    const pending: PendingFinish = { ...record.pendingFinish, state: outcome.state, error: record.pendingFinish?.error ?? "", at: this.now(), tries: record.pendingFinish?.tries ?? 0 };
    if (head) pending.head = head; else delete pending.head; const summary = sharedText(run.summary, MAX.summary, false, localPaths(run)); if (summary.trim()) pending.summary = summary; else delete pending.summary; if (outcome.reason) pending.reason = outcome.reason; else delete pending.reason;
    record.pendingFinish = pending;
    const finish: FinishInput = { state: pending.state, ...(pending.head ? { head: pending.head } : {}), ...(pending.summary ? { summary: pending.summary } : {}), ...(pending.reason ? { reason: pending.reason } : {}) }; let finishing = false;
    try {
      if (head && branch && head !== record.base) {
        const task = await this.hub.task(record.taskId);
        try { await this.ensureCheckpoint(record, run, task, head, branch, "", coverage?.files ?? []); }
        catch (error) {
          if (!(error instanceof CollabError && error.status >= 400 && error.status < 500)) throw error;
          await this.dropKept(record); finish.state = pending.state === "finished" ? "failed" : pending.state; finish.reason = sharedText(`No checkpoint was published: ${error.message}${pending.reason ? ` (${pending.reason})` : ""}`, MAX.reason, false, localPaths(run));
          logError(`Attempt ${record.attemptId} ends on the team server without a checkpoint; its work stays on branch ${branch} of ${run.repo}`, error);
        }
      }
      finishing = true; await this.hub.finish(record.attemptId, finish);
      await this.dropKept(record); delete record.pendingFinish; record.state = finish.state; await this.save(record); return structuredClone(record);
    } catch (error) {
      const status = error instanceof CollabError ? error.status : undefined;
      // The hub's final word (a revoked credential anywhere; another runner id or an attempt already closed, on the finish itself) leaves nothing a retry could change: the local outcome is recorded and the pending finish dropped.
      if (status === 401 || (finishing && status !== undefined && HUB_FINAL.has(status))) { logError(`The team server closed attempt ${record.attemptId} on its own (${message(error)}); this computer records the run's outcome and stops retrying`); await this.dropKept(record); delete record.pendingFinish; record.state = pending.state; await this.save(record); return structuredClone(record); }
      const current = record.pendingFinish ?? pending; current.error = clean(message(error), 1000); current.tries++; current.at = this.now(); record.pendingFinish = current; record.state = pending.state;
      if (current.tries >= MAX_FINISH_TRIES) { logError(`Attempt ${record.attemptId} could not be finished on the team server in ${current.tries} tries (${current.error}); this computer keeps the run's outcome and gives up`); await this.dropKept(record); delete record.pendingFinish; await this.save(record); return structuredClone(record); }
      await this.save(record); throw asCollab(error, 502);
    }
  }
  /** A missing run cannot prove execution stopped: leave the hub reservation unknown for explicit recovery. */
  private lost(record: LocalAttemptRecord, reason: string): Promise<LocalAttemptRecord> { return this.withoutRun(record, "unknown", reason); }
  /** Publishes the finish of an attempt that has no run to report on: `unknown` when the run is gone, `failed` when it never started. The hub's final word and the retry bound apply as in finishNow. */
  private async withoutRun(record: LocalAttemptRecord, state: "unknown" | "failed", reason: string): Promise<LocalAttemptRecord> {
    await this.dropKept(record); const pending: PendingFinish = { state, reason: sharedText(reason, MAX.reason, false, localPaths({ repo: record.repo })), error: record.pendingFinish?.error ?? "", at: this.now(), tries: record.pendingFinish?.tries ?? 0 };
    try { await this.hub.finish(record.attemptId, { state, reason: pending.reason }); delete record.pendingFinish; record.state = state; await this.save(record); return structuredClone(record); }
    catch (error) {
      const status = error instanceof CollabError ? error.status : undefined; record.state = state;
      if (status !== undefined && HUB_FINAL.has(status)) { logError(`The team server closed attempt ${record.attemptId} on its own (${message(error)}); this computer records it as ${state} and stops retrying`); delete record.pendingFinish; await this.save(record); return structuredClone(record); }
      pending.error = clean(message(error), 1000); pending.tries++; record.pendingFinish = pending;
      if (pending.tries >= MAX_FINISH_TRIES) { logError(`Attempt ${record.attemptId} could not be reported ${state} to the team server in ${pending.tries} tries (${pending.error}); this computer gives up`); delete record.pendingFinish; await this.save(record); return structuredClone(record); }
      await this.save(record); throw asCollab(error, 502);
    }
  }

  // ---- Stop, resume, hand over, accept, fetch
  /** `manager.cancel` is the engine's stop; the run's terminal snapshot then finishes the attempt as paused, so it can be resumed from here. */
  async stopAttempt(attemptId: string): Promise<{ attemptId: string; runId: string; cancelled: boolean }> {
    const record = await this.record(attemptId); if (!record) throw new CollabError("Attempt not found on this computer", 404); if (!record.runId) throw new CollabError("This attempt has no run on this computer yet", 409);
    const run = this.manager.get(record.runId); if (!run || run.status !== "running") throw new CollabError("The run is not running; there is nothing to stop", 409);
    // Attached first: a manager that ends the run inside cancel() delivers the terminal event to one listener, not to a second attach made afterwards.
    if (!this.active.has(attemptId)) this.attach(attemptId, record.runId); const cancelled = this.manager.cancel(record.runId);
    return { attemptId, runId: record.runId, cancelled };
  }
  /** Resumes the paused run of an attempt the hub still considers this computer's: one superseded by a hand-over or a reassignment, or a task busy with another attempt, must not get its agent back here, where every report would be refused. */
  async resumeAttempt(attemptId: string): Promise<{ attemptId: string; runId: string }> {
    this.assertOpen(); const record = await this.record(attemptId); if (!record) throw new CollabError("Attempt not found on this computer", 404); if (!record.runId) throw new CollabError("This attempt has no run on this computer to resume", 409);
    if (record.state === "finished" || record.state === "failed") throw new CollabError(`This attempt already ${record.state}; start a new attempt instead`, 409);
    const run = this.manager.get(record.runId); if (!run) throw new CollabError(`Run ${record.runId} is missing from this computer`, 404); if (run.status === "running") throw new CollabError("The run is already running", 409);
    return this.serial(attemptId, async () => {
      const task = await this.hub.task(record.taskId), attempt = task.attempts.find((entry) => entry.id === attemptId);
      if (!attempt) throw new CollabError("The team server no longer lists this attempt; start a new attempt instead", 409);
      if (attempt.state === "superseded") throw new CollabError("This attempt was superseded by a change of owner; start a new attempt from the latest checkpoint instead", 409);
      if (attempt.state === "finished" || attempt.state === "failed") throw new CollabError(`This attempt already ended as ${attempt.state} on the team server; start a new attempt instead`, 409);
      if (task.status === "done") throw new CollabError("Move the task out of Done before resuming the attempt", 409);
      const busy = busyAttempt(task); if (busy && busy.id !== attemptId) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before resuming this one`, 409);
      if (task.handoff?.state === "offered") throw new CollabError("Accept, decline or cancel the offered hand-over before resuming an attempt", 409);
      if (task.owner?.userId !== attempt.user.userId) throw new CollabError(ownerChangedMessage(task), 409);
      // Acquire the hub reservation before restarting the agent. A lost response is ambiguous and must not start
      // execution; reconciliation will settle the reservation against this still-stopped run.
      const previousState = record.state, seq = ++record.lastSeq; record.state = "claimed"; await this.save(record);
      try { await this.hub.progress(record.attemptId, { seq, runId: record.runId, runStatus: "running", updatedAt: this.now() }); }
      catch (error) { if (error instanceof CollabError && error.status < 500) { record.state = previousState; await this.save(record); } throw error; }
      record.lastAckedSeq = seq; record.state = "claimed"; await this.dropKept(record); delete record.pendingFinish; await this.save(record);
      try { await this.manager.resume(record.runId!); }
      catch (error) { await this.finishNow(record); throw asCollab(error, 409); }
      record.state = "running"; await this.save(record);
      this.attach(attemptId, record.runId!); return { attemptId, runId: record.runId! };
    });
  }
  /** Offers the task at a checkpoint of this computer's work: the attempt's existing checkpoint when it still matches the branch, else a new one (committing uncommitted changes first only when asked). Only the task's current attempt can be checkpointed: after a hand-over round trip this computer's latest record may be a superseded attempt, whose checkpoint is older than the task's latest. */
  async handOver(taskId: string, input: HandOverInput): Promise<Task> {
    const hub = this.hub, task = await hub.task(taskId), busy = busyAttempt(task); if (busy) throw new CollabError(`Stop the attempt running on ${busy.runnerName} before handing the task over`, 409);
    if (task.handoff?.state === "offered") throw new CollabError(`A hand-over to ${task.handoff.to.displayName} is already offered; cancel it before offering another`, 409);
    const record = await this.attemptForTask(task.id); let checkpointId: string | undefined;
    const run = record?.runId ? this.manager.get(record.runId) : undefined, worktree = run?.worktrees[0], attempt = record ? task.attempts.find((entry) => entry.id === record.attemptId) : undefined;
    const current = attempt !== undefined && attempt.state !== "superseded" && [...task.attempts].reverse().find((entry) => entry.state !== "superseded")?.id === attempt.id;
    if (record && run && worktree && attempt && current) {
      if (run.status === "running") throw new CollabError("Stop the run before handing the task over", 409);
      let head = await resolveCommit(run.repo, `refs/heads/${worktree.branch}`).catch(() => undefined);
      const checkout = await assertWorktree(run.repo, { path: worktree.path, branch: worktree.branch }).catch(() => undefined), dirty = checkout ? await uncommittedCount(checkout).catch(() => 0) : 0;
      if (dirty > 0) { if (!input.includeUncommitted) throw new CollabError("Commit, discard, or include uncommitted changes first", 409); head = await commitAll(run.repo, { name: worktree.name, path: worktree.path, branch: worktree.branch, base: run.baseRef }, "Hand-over checkpoint") ?? head; }
      if (head) {
        const files = (await this.changedFilesOf(run.id, worktree.branch))?.files ?? [];
        checkpointId = await this.serial(record.attemptId, async () => {
          const live = this.records.get(record.attemptId) ?? record;
          // With the bundle on the hub, a pending finish whose state the hub already shows has nothing left to report; one the hub never got (an attempt it marked unknown) keeps its retry.
          try { const id = await this.ensureCheckpoint(live, run, task, head!, worktree.branch, input.note ?? "", files); if (live.pendingFinish && !live.pendingFinish.bundleFile && live.pendingFinish.state === attempt.state) delete live.pendingFinish; await this.save(live); return id; }
          catch (error) { if (live.pendingFinish?.bundleFile) { live.pendingFinish.error = clean(message(error), 1000); live.pendingFinish.tries++; live.pendingFinish.at = this.now(); await this.save(live); } throw error; }
        });
      }
    } else if (record && run && worktree && attempt) {
      // Work committed on a superseded attempt's branch can no longer be checkpointed (the hub refuses it), so it is pointed out rather than silently left out of the hand-over.
      const head = await resolveCommit(run.repo, `refs/heads/${worktree.branch}`).catch(() => undefined), recorded = (attempt.checkpointId ? task.checkpoints.find((entry) => entry.id === attempt.checkpointId)?.commit : undefined) ?? attempt.head ?? record.base;
      const checkout = input.includeUncommitted ? await assertWorktree(run.repo, { path: worktree.path, branch: worktree.branch }).catch(() => undefined) : undefined, dirty = checkout ? await uncommittedCount(checkout).catch(() => 0) : 0;
      if ((head && head !== recorded) || dirty > 0) throw new CollabError(`Branch ${worktree.branch} on this computer holds work made after its attempt was superseded by a change of owner, which cannot be handed over; start a new attempt from the latest checkpoint to continue from it`, 409);
    }
    if (!checkpointId) { const latest = latestCheckpoint(task); if (latest?.bundle === "available") checkpointId = latest.id; else throw new CollabError("Nothing to hand over yet: run the task on this computer first, or wait for a checkpoint", 409); }
    const fresh = await hub.task(task.id); return hub.offerHandoff(task.id, { to: input.to, checkpointId, note: sharedText(input.note, MAX.note, false, localPaths(run ?? {})) }, fresh.revision);
  }
  /** The bundle is imported into the recipient's clone before ownership moves, so a failed download leaves the task with its current owner. The download can take minutes, during which comments and reviews bump the task's revision: the accept goes out against the task as it is afterwards, as long as the same offer still stands. */
  async acceptHandoff(taskId: string, handoffId: string, input: { repo?: string } = {}): Promise<Task> {
    const hub = this.hub, task = await hub.task(taskId), handoff = task.handoff;
    if (!handoff || handoff.id !== handoffId) { const past = task.handoffs.find((entry) => entry.id === handoffId); if (past) throw new CollabError(`This hand-over was already ${past.state}`, 409); throw new CollabError("Hand-over not found", 404); }
    const checkpoint = task.checkpoints.find((entry) => entry.id === handoff.checkpointId); if (!checkpoint) throw new CollabError("Checkpoint not found", 404); if (checkpoint.bundle !== "available") throw new CollabError("The hand-over's checkpoint bundle is not on the team server; ask the sender to hand over again", 409);
    const repo = await this.resolveRepo(task, input.repo); await this.importById(repo, checkpoint.id);
    const fresh = await hub.task(taskId), offer = fresh.handoff;
    if (!offer || offer.id !== handoffId) { const past = fresh.handoffs.find((entry) => entry.id === handoffId); if (past) throw new CollabError(`This hand-over was already ${past.state}`, 409); throw new CollabError("Hand-over not found", 404); }
    return hub.respondHandoff(fresh.id, offer.id, "accept", fresh.revision);
  }
  /** Imports a checkpoint for review or integration and puts it on `team/<task id>/<first 8 of the checkpoint id>`, never checking it out. */
  async fetchCheckpoint(checkpointId: string, input: { repo: unknown }): Promise<{ commit: string; branch: string; taskId: string; created: boolean }> {
    const repo = await this.repoAt(input.repo, "Repository must be an absolute path"), { manifest, commit } = await this.importById(repo, checkpointId);
    const result = await ensureCheckpointBranch(repo, `team/${manifest.taskId}/${manifest.id.slice(0, 8)}`, commit); return { commit, branch: result.branch, taskId: manifest.taskId, created: result.created };
  }

  // ---- Recovery
  /** One record against the hub (under serial): a claim is settled or forgotten, a pending finish retried, a run that still goes is followed, one that ended is published, one that is missing reported lost. Never starts a run. */
  private async settle(attemptId: string, result: ReconcileResult): Promise<void> {
    const current = this.records.get(attemptId); if (!current || this.starting.has(attemptId)) return;
    // Only a record still at "claiming" proves manager.start was never reached. A "claimed" record without a
    // run id may have crashed between starting the agent and journaling that id, so it must retain its reservation.
    const neverStarted = current.state === "claiming";
    if (current.state === "claiming") {
      let task: Task | undefined; try { task = await this.hub.task(current.taskId); } catch (error) { if (!(error instanceof CollabError && error.status === 404)) throw error; }
      if (!task?.attempts.some((attempt) => attempt.id === current.attemptId)) { await this.remove(current.attemptId); result.removed++; return; } current.state = "claimed"; await this.save(current);
    }
    if (current.pendingFinish && !this.active.has(current.attemptId)) { result.retried++; await this.finishNow(current); return; }
    const run = current.runId ? this.manager.get(current.runId) : undefined;
    if (current.state === "claimed" || current.state === "running") {
      if (!run) {
        if (neverStarted) await this.withoutRun(current, "failed", "The run never started on this computer; start a new attempt");
        else await this.lost(current, current.runId ? `Run ${current.runId} is missing from this computer` : "The run's id was not recorded; confirm execution has stopped before recovering the attempt");
        result.unknown++; return;
      }
      if (run.status === "running") { if (!this.active.has(current.attemptId)) { this.attach(current.attemptId, run.id); result.attached++; } return; }
      await this.finishNow(current); result.finished++; return;
    }
    if ((current.state === "paused" || current.state === "stopped") && run?.status === "running" && !this.active.has(current.attemptId)) { this.attach(current.attemptId, run.id); result.attached++; }
  }
  /** Settles the local record of an attempt the hub shows busy for this computer when nothing runs behind it here; true when a pass ran, so the caller rereads the task. */
  private async settleStale(attemptId: string): Promise<boolean> {
    await this.load(); const record = this.records.get(attemptId); if (!record || this.active.has(attemptId) || this.starting.has(attemptId)) return false;
    await this.serial(attemptId, () => this.settle(attemptId, emptyResult())).catch((error) => logError(`Attempt ${attemptId} could not be settled with the team server before starting another`, error)); return true;
  }
  /** After a start, a reconnect or on demand: finish what ended, follow what still runs, forget claims that never reached the hub, and retry unacknowledged finishes at once. Never starts a run. */
  async reconcile(): Promise<ReconcileResult> {
    await this.load(true); const result = emptyResult();
    for (const record of [...this.records.values()]) {
      if (this.closed) break; if (this.starting.has(record.attemptId)) continue;
      await this.serial(record.attemptId, () => this.settle(record.attemptId, result)).catch((error) => logError(`Attempt ${record.attemptId} could not be reconciled with the team server; it is retried by the recovery pass`, error));
    }
    return result;
  }
  /** The recovery timer's pass (every minute): claims whose answer was lost are settled and unacknowledged finishes retried with backoff, so a hub attempt left claimed or running by a lost answer is released within minutes rather than at the next restart or reconnect. Returns how many records were due. */
  async retryPending(): Promise<number> {
    if (this.closed) return 0; await this.load(); const now = this.now(); let due = 0;
    for (const record of [...this.records.values()]) {
      if (this.closed) break; if (this.starting.has(record.attemptId) || this.active.has(record.attemptId)) continue;
      const pending = record.pendingFinish; if (!(record.state === "claiming" || record.state === "claimed" || (pending !== undefined && now - pending.at >= retryDelay(pending.tries)))) continue; due++;
      await this.serial(record.attemptId, () => this.settle(record.attemptId, emptyResult())).catch((error) => logError(`Attempt ${record.attemptId} could not be settled with the team server; it is retried later`, error));
    }
    return due;
  }
  /** Stops timers and listeners; runs keep going and are picked up again by reconcile() after a restart. */
  async close(): Promise<void> { this.closed = true; if (this.retryTimer) clearInterval(this.retryTimer); for (const live of [...this.active.values()]) this.detach(live); await Promise.allSettled([...this.chains.values()]); }
}
