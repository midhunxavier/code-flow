import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  adapters,
  type AccessMode,
  type AgentEvent,
  type AgentId,
  type AgentSettings,
  type RunResult,
} from "./adapters/index.js";
import { MAX_DIFF_CHARS, STEP_TIMEOUT_MS } from "./config.js";
import { runCheck, type CheckResult } from "./checks.js";
import { contextPrompt, hasStagedFiles, prepareContext, type ContextInput, type RunContext } from "./context.js";
import { extractJson, shapeProblem } from "./json.js";
import {
  CONTEXT_DIR,
  commitAll,
  diffSince,
  diffStat,
  discardChanges,
  ensureCodeflowExcludes,
  isClean,
  mergeBranch,
  openWorktree,
  repoRoot,
  resolveCommit,
  uncommittedCount,
  validateBranchPrefix,
  worktreeRoot,
  type Worktree,
} from "./git.js";
import { appendLine, flushWrites, journalEntry, listRunIds, loadJournal, readJsonLines } from "./store.js";
import { branchDiff, mergeInto, openPullRequest, removeWorktrees, type DiffFile } from "./ship.js";

/** Per-run staging folder (inside the run's worktree folder) for context files. */
const STAGE_DIR = ".context";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/**
 * "stopped" = ended by a budget (time or step limit); "interrupted" = code-flow shut down
 * while it was running. Both can be resumed.
 */
export type Status = "running" | "done" | "failed" | "cancelled" | "stopped" | "interrupted";

export interface Step {
  id: string;
  /** An agent turn, or a command code-flow ran itself (the check, or worktree setup). */
  kind: "agent" | "check" | "setup";
  title: string;
  role: string;
  agent?: AgentId;
  mode: AccessMode;
  worktree?: string;
  status: Status;
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  finalText?: string;
  error?: string;
}

export interface Artifact {
  label: string;
  branch: string;
  path: string;
  stat?: string;
}

export interface Run {
  id: string;
  pattern: string;
  task: string;
  repo: string;
  /** Commit every worktree starts from. */
  baseRef: string;
  /** What the user picked as the base (branch name, or HEAD). */
  baseLabel: string;
  /** Result branches are `<branchPrefix>/<worktree name>`. */
  branchPrefix: string;
  /** Folder holding this run's worktrees. */
  worktreeDir: string;
  /** Files and folders the user handed to every agent. */
  context: RunContext;
  /** Model and effort per provider; unset means the CLI's own default. */
  agentSettings: AgentSettings;
  roles: Record<string, AgentId[]>;
  options: Record<string, number | boolean>;
  /** The "done when" check and the run's budgets. */
  loop: LoopSettings;
  usage: { agentSteps: number; checks: number };
  /** Result of the most recent check, if a check is configured. */
  lastCheck?: { ok: boolean; command: string; worktree: string; at: number };
  /** Set by patterns: did the result pass its check? */
  verdict?: "passed" | "failing";
  /** Why a "stopped" run stopped. */
  stopReason?: string;
  worktrees: { name: string; branch: string; path: string }[];
  /** The user has looked at the finished run (otherwise it "needs you"). */
  seen: boolean;
  archived: boolean;
  /** How many times the run was resumed. */
  resumes?: number;
  /** Work you sent back to an agent after the run (review comments, conflict fixes). */
  followUps: FollowUp[];
  /** Result branches merged from the UI. */
  merges: { branch: string; into: string; commit: string; at: number }[];
  /** Pull requests opened from the UI, by branch. */
  prs: Record<string, string>;
  status: Status;
  createdAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  steps: Step[];
  artifacts: Artifact[];
}

export type RunSummary = Omit<Run, "steps">;

export interface FollowUp {
  id: string;
  kind: "comments" | "resolve-conflicts";
  worktree: string;
  agent: AgentId;
  /** What to tell the agent (the user's comments), or the branch to merge for conflicts. */
  message: string;
  mergeFrom?: string;
  status: "pending" | "done" | "failed";
  result?: string;
  checkPassed?: boolean;
  at: number;
}

export interface LoopSettings {
  /** Shell command code-flow runs itself to decide "done" (e.g. `npm test`). Empty = agents' judgment only. */
  check?: string;
  /** Runs once in every new worktree before agents start (e.g. `npm ci`). */
  setup?: string;
  /** Stop the run after this many minutes. */
  maxMinutes: number;
  /** Stop the run after this many agent turns. */
  maxSteps: number;
  /** Per check/setup command. */
  checkTimeoutMin: number;
}

export const DEFAULT_LOOP: LoopSettings = { maxMinutes: 60, maxSteps: 40, checkTimeoutMin: 10 };

export type RunEvent = { seq: number; ts: number; runId: string } & (
  | { type: "run"; run: RunSummary }
  | { type: "step"; step: Step }
  | { type: "agent"; stepId: string; event: AgentEvent }
  | { type: "log"; level: "info" | "warn"; text: string }
);

type RunEventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "seq" | "ts" | "runId"> : never) : never;

// ---------------------------------------------------------------------------
// Pattern contract
// ---------------------------------------------------------------------------

export interface RoleSpec {
  id: string;
  label: string;
  description: string;
  /** Several agents may fill this role (e.g. contestants, debaters, workers). */
  multiple?: boolean;
  /** Role can be left empty (agent list []). */
  optional?: boolean;
  default: AgentId[];
}

export interface OptionSpec {
  id: string;
  label: string;
  type: "number" | "boolean";
  default: number | boolean;
  min?: number;
  max?: number;
}

export interface Pattern {
  id: string;
  name: string;
  /** One line for the picker. */
  summary: string;
  /** When to reach for this pattern. */
  description: string;
  roles: RoleSpec[];
  options: OptionSpec[];
  /** The pattern can't run without a "done when" check command. */
  requiresCheck?: boolean;
  /**
   * Runs the team; returns a markdown summary. Must be deterministic given the results of
   * ctx calls (ask/check/commit/worktree/remember) so an interrupted run can be replayed.
   */
  run(ctx: TeamContext): Promise<string>;
}

export interface AskParams {
  title: string;
  role: string;
  agent: AgentId;
  prompt: string;
  cwd: Worktree;
  mode: AccessMode;
  /** Continue this agent's earlier conversation instead of starting fresh. */
  resume?: StepOutcome;
  /** Return a failed outcome instead of throwing (useful for races). */
  allowFailure?: boolean;
  /** Constrain the answer to this JSON Schema. Prefer `ctx.decide()`, which also validates. */
  schema?: object;
}

export interface DecideParams extends AskParams {
  schema: object;
  /** What the answer is, for messages: "review verdict", "subtask list"… */
  what: string;
  /** Extra checks beyond the schema; return a problem description to reject the answer. */
  validate?: (value: any) => string | undefined;
}

export interface StepOutcome extends RunResult {
  stepId: string;
  agent: AgentId;
}

export class CancelledError extends Error {
  constructor() {
    super("Run cancelled");
  }
}

/** What a pattern sees: the task, its team, and primitives to coordinate them. */
export class TeamContext {
  readonly signal: AbortSignal;
  private readonly counters = new Map<string, number>();
  /** Agent turns taken in this attempt (the step budget restarts on resume). */
  private attemptSteps = 0;
  /** True while re-running already-journaled steps after a resume. */
  private replaying: boolean;

  constructor(
    readonly run: Run,
    private readonly controller: AbortController,
    private readonly manager: RunManager,
    private readonly journal: Map<string, unknown> = new Map(),
  ) {
    this.signal = controller.signal;
    this.replaying = journal.size > 0;
  }

  /** End the run because a budget ran out; in-flight agents and checks are stopped. */
  stop(reason: string) {
    if (this.run.stopReason) return;
    this.run.stopReason = reason;
    this.log(`Stopping: reached the ${reason}`, "warn");
    this.controller.abort();
  }

  /** True when the user configured a "done when" check command. */
  get hasCheck(): boolean {
    return !!this.run.loop.check;
  }

  /** Publish the run's current state (for engine helpers outside the class). */
  publish() {
    this.manager.emitRun(this.run);
  }

  /** Record whether the final result passes its check (shown in the result header). */
  setVerdict(verdict: "passed" | "failing") {
    this.run.verdict = verdict;
  }

  /** The user's task plus the context they attached — what every agent should be given. */
  get task() {
    return this.run.task + contextPrompt(this.run.context);
  }

  agents(role: string): AgentId[] {
    return this.run.roles[role] ?? [];
  }

  agent(role: string): AgentId {
    const [first] = this.agents(role);
    if (!first) throw new Error(`No agent assigned to role "${role}"`);
    return first;
  }

  option<T extends number | boolean>(id: string, fallback: T): T {
    const value = this.run.options[id];
    return (value ?? fallback) as T;
  }

  log(text: string, level: "info" | "warn" = "info") {
    if (this.replaying) return; // already in the log from the original attempt
    this.manager.emit(this.run, { type: "log", level, text });
  }

  checkCancelled() {
    if (this.signal.aborted) throw new CancelledError();
  }

  /**
   * Run `fn` once and record its result; on a resumed run the recorded result is returned
   * instead. Keys are kind + identity + occurrence, which stay stable across parallel
   * branches as long as identities differ (titles, worktree names).
   */
  async remember<T>(kind: string, identity: string, fn: () => Promise<T>): Promise<T> {
    const base = `${kind}:${identity}`;
    const n = (this.counters.get(base) ?? 0) + 1;
    this.counters.set(base, n);
    const key = `${base}#${n}`;
    if (this.journal.has(key)) return this.journal.get(key) as T;
    this.replaying = false;
    const value = await fn();
    this.journal.set(key, value);
    journalEntry(this.run.id, key, value ?? null);
    return value;
  }

  /**
   * Run the "done when" check in a worktree — code-flow runs it, not an agent, so the result
   * can be trusted. Returns null when no check is configured.
   */
  async check(wt: Worktree, title = "Check", command = this.run.loop.check): Promise<CheckResult | null> {
    if (!command) return null;
    this.checkCancelled();
    return this.remember("check", `${wt.name}|${title}|${command}`, async () => {
      const result = await this.command("check", title, wt, command);
      this.run.usage.checks++;
      this.run.lastCheck = { ok: result.ok, command, worktree: wt.name, at: Date.now() };
      this.manager.emitRun(this.run);
      return result;
    });
  }

  /** Run a shell command in a worktree as a visible step (used for checks and setup). */
  private async command(kind: "check" | "setup", title: string, wt: Worktree, command: string): Promise<CheckResult> {
    this.checkCancelled();
    const step: Step = {
      id: `s${this.run.steps.length + 1}`,
      kind,
      title,
      role: kind,
      mode: "write",
      worktree: wt.name,
      status: "running",
      startedAt: Date.now(),
    };
    this.run.steps.push(step);
    this.manager.emit(this.run, { type: "step", step: { ...step } });
    this.manager.emit(this.run, { type: "agent", stepId: step.id, event: { kind: "tool_call", callId: step.id, name: "$", input: command } });

    const result = await runCheck(wt.path, command, { timeoutMs: this.run.loop.checkTimeoutMin * 60_000, signal: this.signal });

    this.manager.emit(this.run, {
      type: "agent",
      stepId: step.id,
      event: { kind: "tool_result", callId: step.id, output: result.output.slice(-8_000) || "(no output)", isError: !result.ok },
    });
    step.endedAt = Date.now();
    step.status = this.signal.aborted ? this.abortedStatus() : result.ok ? "done" : "failed";
    step.finalText = result.ok
      ? `Passed in ${Math.round(result.durationMs / 1000)}s`
      : result.timedOut
        ? `Timed out after ${this.run.loop.checkTimeoutMin} min`
        : `Failed (exit code ${result.exitCode})`;
    this.manager.emit(this.run, { type: "agent", stepId: step.id, event: { kind: "status", text: step.finalText } });
    this.manager.emit(this.run, { type: "step", step: { ...step } });
    this.checkCancelled();
    return result;
  }

  private abortedStatus(): Status {
    return this.manager.isShuttingDown ? "interrupted" : "cancelled";
  }

  /** A worktree for this run; reused if it already exists (e.g. when resuming). */
  async worktree(name: string, fromRef = this.run.baseRef): Promise<Worktree> {
    this.checkCancelled();
    const wt = await this.remember("worktree", name, () => this.openWorktreeLive(name, fromRef));
    if (!existsSync(wt.path)) {
      // Removed since it was recorded: check the branch out again.
      const { wt: reopened } = await openWorktree(this.run.repo, name, wt.path, wt.branch, fromRef);
      return reopened;
    }
    return wt;
  }

  private async openWorktreeLive(name: string, fromRef: string): Promise<Worktree> {
    const { wt, created } = await openWorktree(
      this.run.repo,
      name,
      join(this.run.worktreeDir, name),
      `${this.run.branchPrefix}/${name}`,
      fromRef,
    );
    if (!this.run.worktrees.some((w) => w.name === name)) {
      this.run.worktrees.push({ name: wt.name, branch: wt.branch, path: wt.path });
    }
    if (!created) {
      this.log(`Reusing existing worktree ${wt.path} (branch ${wt.branch})`);
      return wt;
    }
    this.log(`Created worktree ${wt.path} on branch ${wt.branch}`);
    if (hasStagedFiles(this.run.context)) {
      // Git-excluded, so it is never committed and doesn't count as a change.
      await cp(join(this.run.worktreeDir, STAGE_DIR), join(wt.path, CONTEXT_DIR), { recursive: true });
    }
    if (this.run.loop.setup) {
      const setup = await this.command("setup", `Setup ${name}`, wt, this.run.loop.setup);
      if (!setup.ok) throw new Error(`Setup command \`${this.run.loop.setup}\` failed in worktree ${name}`);
      if (!(await isClean(wt.path))) this.log(`Setup left changes in ${name}; they'll appear in its diff`, "warn");
    }
    return wt;
  }

  async commit(wt: Worktree, message: string): Promise<string | null> {
    return this.remember("commit", `${wt.name}|${message}`, async () => {
      const sha = await commitAll(wt, message);
      if (sha) this.log(`Committed ${sha.slice(0, 8)} on ${wt.branch}: ${message}`);
      return sha;
    });
  }

  /** Diff of the worktree against its base, truncated to fit in a prompt. */
  async diff(wt: Worktree, base = wt.base): Promise<string> {
    const full = await diffSince(wt, base);
    if (!full.trim()) return "(no changes)";
    return full.length > MAX_DIFF_CHARS
      ? `${full.slice(0, MAX_DIFF_CHARS)}\n… diff truncated (${full.length} chars total); run \`git diff ${base}..HEAD\` to see all of it.`
      : full;
  }

  /** Publish a result branch (replaces an earlier artifact with the same label). */
  async artifact(label: string, wt: Worktree) {
    const stat = await diffStat(wt, this.run.baseRef).catch(() => "");
    this.run.artifacts = this.run.artifacts.filter((a) => a.label !== label);
    this.run.artifacts.push({ label, branch: wt.branch, path: wt.path, stat });
    this.manager.emitRun(this.run);
  }

  /**
   * Ask for a structured answer (verdict, pick, plan…). The CLI enforces the JSON Schema; if the
   * answer is still unusable the agent is asked once more in the same session, and then the
   * run fails — an unreadable answer is never treated as approval.
   */
  async decide<T>(params: DecideParams): Promise<{ value: T; outcome: StepOutcome }> {
    const read = (outcome: StepOutcome) => {
      const value = outcome.structured ?? extractJson(outcome.finalText);
      const problem = value === undefined ? "no JSON answer" : shapeProblem(params.schema, value) ?? params.validate?.(value);
      return { value: value as T, problem };
    };
    const first = await this.ask(params);
    const firstRead = read(first);
    if (!firstRead.problem) return { value: firstRead.value, outcome: first };

    this.log(`${params.title}: no valid ${params.what} (${firstRead.problem}); asking again`, "warn");
    const retry = await this.ask({
      ...params,
      title: `${params.title} (retry)`,
      resume: first.sessionId ? first : params.resume,
      prompt:
        `Your previous answer did not contain a valid ${params.what}: ${firstRead.problem}.\n` +
        `Reply again with only a JSON object matching this schema:\n\`\`\`json\n${JSON.stringify(params.schema)}\n\`\`\`` +
        (first.sessionId ? "" : `\n\nThe original request was:\n${params.prompt}`),
    });
    const retryRead = read(retry);
    if (retryRead.problem) {
      throw new Error(`${params.title} (${params.agent}) did not return a valid ${params.what}, even after a retry: ${retryRead.problem}`);
    }
    return { value: retryRead.value, outcome: retry };
  }

  /** Run one agent turn as a visible step in this run. */
  async ask(params: AskParams): Promise<StepOutcome> {
    this.checkCancelled();
    if (params.resume && params.resume.agent !== params.agent) {
      throw new Error(`Cannot resume a ${params.resume.agent} session with ${params.agent}`);
    }
    return this.remember("ask", `${params.role}|${params.agent}|${params.cwd.name}|${params.title}`, () => this.askLive(params));
  }

  private async askLive(params: AskParams): Promise<StepOutcome> {
    if (this.attemptSteps >= this.run.loop.maxSteps) {
      this.stop(`step limit (${this.run.loop.maxSteps} agent steps)`);
      this.checkCancelled();
    }
    this.attemptSteps++;
    this.run.usage.agentSteps++;
    const step: Step = {
      id: `s${this.run.steps.length + 1}`,
      kind: "agent",
      title: params.title,
      role: params.role,
      agent: params.agent,
      mode: params.mode,
      worktree: params.cwd.name,
      status: "running",
      startedAt: Date.now(),
    };
    this.run.steps.push(step);
    this.manager.emit(this.run, { type: "step", step: { ...step } });

    // Read-only is enforced here for every agent, not just trusted to each CLI's flags.
    const guardReadOnly = params.mode === "read" && (await isClean(params.cwd.path));

    const result = await adapters[params.agent].run(
      {
        prompt: params.prompt,
        cwd: params.cwd.path,
        mode: params.mode,
        resumeSessionId: params.resume?.sessionId,
        model: this.run.agentSettings[params.agent]?.model,
        effort: this.run.agentSettings[params.agent]?.effort,
        jsonSchema: params.schema,
        signal: this.signal,
        timeoutMs: STEP_TIMEOUT_MS,
      },
      (event) => {
        if (event.kind === "session") step.sessionId = event.sessionId;
        this.manager.emit(this.run, { type: "agent", stepId: step.id, event });
      },
    );

    if (guardReadOnly && !(await isClean(params.cwd.path))) {
      await discardChanges(params.cwd.path);
      this.log(`${params.title} (${params.agent}) modified files in read-only mode; changes were reverted`, "warn");
    }

    step.endedAt = Date.now();
    step.sessionId = result.sessionId;
    step.finalText = result.finalText;
    step.error = result.error;
    step.status = this.signal.aborted ? this.abortedStatus() : result.ok ? "done" : "failed";
    this.manager.emit(this.run, { type: "step", step: { ...step } });

    this.checkCancelled();
    if (!result.ok && !params.allowFailure) {
      throw new Error(`${params.title} (${params.agent}) failed: ${result.error ?? "unknown error"}`);
    }
    return { ...result, stepId: step.id, agent: params.agent };
  }
}

// ---------------------------------------------------------------------------
// Run manager
// ---------------------------------------------------------------------------

export interface StartRunInput {
  pattern: Pattern;
  task: string;
  repo: string;
  /** Branch, tag or commit to start from; defaults to the repo's current HEAD. */
  baseRef?: string;
  /** Defaults to `codeflow/<run id>`. */
  branchPrefix?: string;
  context?: ContextInput;
  agentSettings?: AgentSettings;
  loop?: Partial<LoopSettings>;
  roles: Record<string, AgentId[]>;
  options: Record<string, number | boolean>;
}

export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly history = new Map<string, RunEvent[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly bus = new EventEmitter();
  private seq = 0;
  private shuttingDown = false;

  constructor(private readonly findPattern: (id: string) => Pattern | undefined = () => undefined) {
    this.bus.setMaxListeners(0);
  }

  get isShuttingDown() {
    return this.shuttingDown;
  }

  /** Rebuild runs from their event logs; runs that were mid-flight become "interrupted". */
  async load(): Promise<void> {
    for (const id of await listRunIds()) {
      if (this.runs.has(id)) continue;
      const events = await readJsonLines<RunEvent>(`${id}.jsonl`);
      for (const e of events) if (typeof e.seq === "number" && e.seq > this.seq) this.seq = e.seq;
      const run = rebuildRun(events);
      if (!run) continue;
      this.runs.set(id, run);
      if (run.status === "running") {
        run.status = "interrupted";
        run.error = "code-flow stopped while this run was in progress. Resume to continue.";
        run.endedAt = run.endedAt ?? Date.now();
        run.seen = false;
        for (const step of run.steps) {
          if (step.status === "running") {
            step.status = "interrupted";
            this.emit(run, { type: "step", step: { ...step } });
          }
        }
        this.emitRun(run);
      }
    }
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map(strip).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  /** Full event history of a run (from memory, or from its log for runs loaded from disk). */
  async events(id: string): Promise<RunEvent[]> {
    const cached = this.history.get(id);
    if (cached) return cached;
    await flushWrites();
    return readJsonLines<RunEvent>(`${id}.jsonl`);
  }

  subscribe(id: string, listener: (e: RunEvent) => void): () => void {
    this.bus.on(id, listener);
    return () => this.bus.off(id, listener);
  }

  /** Every run snapshot as it changes, for the sidebar and notifications. */
  subscribeAll(listener: (run: RunSummary) => void): () => void {
    this.bus.on("*", listener);
    return () => this.bus.off("*", listener);
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  setSeen(id: string, seen = true) {
    const run = this.runs.get(id);
    if (!run || run.seen === seen) return;
    run.seen = seen;
    this.emitRun(run);
  }

  setArchived(id: string, archived: boolean) {
    const run = this.require(id);
    if (run.status === "running") throw new Error("Stop the run before archiving it");
    run.archived = archived;
    if (archived) run.seen = true;
    this.emitRun(run);
  }

  /**
   * Archive a run and, optionally, remove its worktrees (branches are kept unless asked).
   * A later Resume re-attaches kept branches, so nothing committed is lost.
   */
  async archive(id: string, opts: { cleanup?: boolean; deleteBranches?: boolean } = {}) {
    const run = this.require(id);
    this.setArchived(id, true);
    if (!opts.cleanup) return { removed: [], deletedBranches: [] };
    const result = await removeWorktrees(run.repo, run.worktrees, !!opts.deleteBranches);
    this.emit(run, {
      type: "log",
      level: "info",
      text: `Archived: removed ${result.removed.length} worktree(s)${result.deletedBranches.length ? ` and ${result.deletedBranches.length} branch(es)` : "; branches kept"}`,
    });
    return result;
  }

  /** Per-file diff of one of the run's branches against the run's base. */
  async diff(id: string, branch: string): Promise<DiffFile[]> {
    const run = this.require(id);
    if (!run.worktrees.some((w) => w.branch === branch) && !run.artifacts.some((a) => a.branch === branch)) {
      throw new Error("That branch doesn't belong to this run");
    }
    return branchDiff(run.repo, run.baseRef, branch);
  }

  /** Send work back to an agent after the run (review comments, or resolving merge conflicts). */
  async followUp(id: string, input: { kind?: FollowUp["kind"]; worktree: string; agent: AgentId; message?: string; mergeFrom?: string }) {
    const run = this.require(id);
    if (run.status !== "done") throw new Error("Follow-ups can be sent once the run has finished");
    if (!run.worktrees.some((w) => w.name === input.worktree)) throw new Error(`Unknown worktree "${input.worktree}"`);
    const kind = input.kind ?? "comments";
    if (kind === "comments" && !input.message?.trim()) throw new Error("Write at least one comment");
    if (kind === "resolve-conflicts" && !input.mergeFrom) throw new Error("Say which branch to merge");
    run.followUps.push({
      id: `f${run.followUps.length + 1}`,
      kind,
      worktree: input.worktree,
      agent: input.agent,
      message: input.message?.trim() ?? "",
      mergeFrom: input.mergeFrom,
      status: "pending",
      at: Date.now(),
    });
    return this.resume(id);
  }

  /** Merge a result branch into one of your branches (see `mergeInto` for how it stays safe). */
  async merge(id: string, input: { branch: string; into: string; archiveAfter?: boolean }) {
    const run = this.require(id);
    if (run.status === "running") throw new Error("Wait for the run to finish before merging");
    if (!run.worktrees.some((w) => w.branch === input.branch)) throw new Error("That branch doesn't belong to this run");
    const outcome = await mergeInto(run.repo, input.branch, input.into, `Merge ${input.branch} into ${input.into} (code-flow run ${run.id})`);
    if (outcome.ok) {
      run.merges.push({ branch: input.branch, into: input.into, commit: outcome.commit, at: Date.now() });
      this.emit(run, { type: "log", level: "info", text: `Merged ${input.branch} into ${input.into} (${outcome.commit.slice(0, 8)})` });
      this.emitRun(run);
      if (input.archiveAfter) await this.archive(id, { cleanup: true });
    }
    return outcome;
  }

  /** Push a result branch and open a pull request for it. */
  async pullRequest(id: string, input: { branch: string; into: string }) {
    const run = this.require(id);
    if (!run.worktrees.some((w) => w.branch === input.branch)) throw new Error("That branch doesn't belong to this run");
    const title = run.task.split("\n")[0]!.slice(0, 72) || `code-flow run ${run.id}`;
    const agents = [...new Set(Object.values(run.roles).flat())].join(", ");
    const body = [
      run.task,
      "",
      "---",
      `Made by a code-flow team (${this.findPattern(run.pattern)?.name ?? run.pattern}; agents: ${agents}).`,
      run.loop.check ? `Check: \`${run.loop.check}\` — ${run.verdict === "passed" ? "passing" : run.verdict === "failing" ? "failing" : "not run"}.` : "",
      "",
      run.summary ?? "",
    ].join("\n");
    const url = await openPullRequest(run.repo, input.branch, input.into, title, body);
    run.prs[input.branch] = url;
    this.emit(run, { type: "log", level: "info", text: `Opened pull request ${url}` });
    this.emitRun(run);
    return url;
  }

  private require(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    return run;
  }

  async start(input: StartRunInput): Promise<Run> {
    const loop: LoopSettings = {
      ...DEFAULT_LOOP,
      ...Object.fromEntries(Object.entries(input.loop ?? {}).filter(([, v]) => v !== undefined && v !== "")),
    };
    loop.check = loop.check?.trim() || undefined;
    loop.setup = loop.setup?.trim() || undefined;
    if (input.pattern.requiresCheck && !loop.check) {
      throw new Error(`${input.pattern.name} needs a check command (Settings → Done when), e.g. "npm test"`);
    }
    const repo = await repoRoot(input.repo);
    const baseLabel = input.baseRef?.trim() || "HEAD";
    const baseRef = await resolveCommit(repo, baseLabel).catch(() => {
      throw new Error(`Base branch "${baseLabel}" not found in ${repo}`);
    });
    const id = newRunId();
    const branchPrefix = input.branchPrefix?.trim().replace(/^\/+|\/+$/g, "") || `codeflow/${id}`;
    await validateBranchPrefix(repo, branchPrefix);
    await ensureCodeflowExcludes(repo);

    const worktreeDir = join(worktreeRoot(repo), id);
    const context = await prepareContext(repo, baseRef, input.context, join(worktreeDir, STAGE_DIR)).catch(async (err) => {
      await rm(worktreeDir, { recursive: true, force: true });
      throw err;
    });

    const run: Run = {
      id,
      pattern: input.pattern.id,
      task: input.task,
      repo,
      baseRef,
      baseLabel,
      branchPrefix,
      worktreeDir,
      context,
      agentSettings: input.agentSettings ?? {},
      roles: input.roles,
      options: input.options,
      loop,
      usage: { agentSteps: 0, checks: 0 },
      worktrees: [],
      followUps: [],
      merges: [],
      prs: {},
      seen: false,
      archived: false,
      status: "running",
      createdAt: Date.now(),
      steps: [],
      artifacts: [],
    };
    this.runs.set(run.id, run);
    this.history.set(run.id, []);
    this.emitRun(run);
    this.execute(run, input.pattern, new Map());
    return run;
  }

  /**
   * Continue a run that was interrupted, stopped at a limit, failed or cancelled. Its pattern
   * runs again from the top; every step that already completed is replayed from the journal
   * instantly, and real work resumes at the first unfinished step — with a fresh budget.
   */
  async resume(id: string): Promise<Run> {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    if (run.status === "running") throw new Error("This run is already running");
    const pattern = this.findPattern(run.pattern);
    if (!pattern) throw new Error(`Unknown pattern "${run.pattern}"`);
    if (!existsSync(run.repo)) throw new Error(`Repository ${run.repo} no longer exists`);

    if (!this.history.has(id)) this.history.set(id, await this.events(id));
    const journal = await loadJournal(id);
    run.status = "running";
    run.error = undefined;
    run.stopReason = undefined;
    run.summary = undefined;
    run.verdict = undefined;
    run.endedAt = undefined;
    run.seen = false;
    run.archived = false;
    run.resumes = (run.resumes ?? 0) + 1;
    run.artifacts = run.artifacts.filter((a) => !a.label.startsWith("Work so far"));
    this.emitRun(run);
    this.emit(run, {
      type: "log",
      level: "info",
      text: journal.size
        ? `Resuming: replaying ${journal.size} recorded results, then continuing with a fresh budget`
        : "Resuming from the start: no completed steps were recorded (existing worktrees are reused)",
    });
    this.execute(run, pattern, journal);
    return run;
  }

  private execute(run: Run, pattern: Pattern, journal: Map<string, unknown>) {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const ctx = new TeamContext(run, controller, this, journal);
    const timeBudget = setTimeout(() => ctx.stop(`time limit (${run.loop.maxMinutes} min)`), run.loop.maxMinutes * 60_000);
    timeBudget.unref?.();

    const done = pattern
      .run(ctx)
      .then(async (summary) => {
        run.summary = summary;
        await runFollowUps(ctx, run);
        run.status = "done";
      })
      .catch((err: Error) => {
        const aborted = controller.signal.aborted || err instanceof CancelledError;
        if (aborted && this.shuttingDown && !run.stopReason) {
          run.status = "interrupted";
          run.error = "code-flow was shut down while this run was in progress. Resume to continue.";
        } else {
          run.status = run.stopReason ? "stopped" : aborted ? "cancelled" : "failed";
          run.error = run.stopReason ? `Stopped at the ${run.stopReason}.` : err.message;
        }
      })
      .then(() => (run.status === "done" || run.status === "interrupted" ? undefined : collectUnfinishedWork(run)))
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeBudget);
        run.endedAt = Date.now();
        run.seen = run.status === "cancelled"; // you stopped it yourself; nothing to review
        this.controllers.delete(run.id);
        this.active.delete(run.id);
        this.emitRun(run);
      });
    this.active.set(run.id, done);
  }

  /** Stop every running run as "interrupted" (resumable) and make sure the logs are on disk. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.race([
      Promise.allSettled([...this.active.values()]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
    await flushWrites();
  }

  emitRun(run: Run) {
    this.emit(run, { type: "run", run: strip(run) });
  }

  emit(run: Run, body: RunEventBody) {
    const event = { seq: ++this.seq, ts: Date.now(), runId: run.id, ...body } as RunEvent;
    this.history.get(run.id)?.push(event);
    this.bus.emit(run.id, event);
    if (event.type === "run") this.bus.emit("*", event.run);
    appendLine(`${run.id}.jsonl`, event);
  }
}

/** Work the user sent back after the run: each follow-up is one agent turn, then the check. */
async function runFollowUps(ctx: TeamContext, run: Run) {
  for (const f of run.followUps) {
    if (f.status !== "pending") continue;
    const wt = await ctx.worktree(f.worktree);
    if (f.kind === "resolve-conflicts" && f.mergeFrom) {
      // code-flow starts the merge; the agent only resolves the conflict markers.
      await ctx.remember("merge-start", `${f.id}|${f.mergeFrom}`, () => mergeBranch(wt, f.mergeFrom!));
    }
    // Continue the agent's own session in this worktree when it has one.
    const previous = [...run.steps].reverse().find((s) => s.kind === "agent" && s.agent === f.agent && s.worktree === f.worktree && s.sessionId);
    const outcome = await ctx.ask({
      title: f.kind === "resolve-conflicts" ? `Resolve conflicts with ${f.mergeFrom}` : "Address review comments",
      role: "follow-up",
      agent: f.agent,
      mode: "write",
      cwd: wt,
      allowFailure: true,
      resume: previous ? { ok: true, finalText: previous.finalText ?? "", sessionId: previous.sessionId, stepId: previous.id, agent: f.agent } : undefined,
      prompt:
        (previous ? "" : `You are working in a git worktree for this task:\n${ctx.task}\n\n`) +
        (f.kind === "resolve-conflicts"
          ? `code-flow merged \`${f.mergeFrom}\` into this branch and it has conflicts. Resolve every conflict so both sides' intent is kept, ` +
            "remove all conflict markers, make sure it builds, and summarize. Don't run git merge --abort or commit."
          : `The user reviewed your changes and left these comments:\n\n${f.message}\n\nAddress each one, run the relevant tests, and summarize what you changed. Don't commit; code-flow does.`),
    });
    await ctx.commit(wt, f.kind === "resolve-conflicts" ? `Merge ${f.mergeFrom} (conflicts resolved by ${f.agent})` : `${f.agent}: address review comments (${f.id})`);
    const check = await ctx.check(wt, `Check after follow-up ${f.id}`);
    f.status = outcome.ok ? "done" : "failed";
    f.result = outcome.ok ? outcome.finalText : outcome.error;
    f.checkPassed = check ? check.ok : undefined;
    const artifact = run.artifacts.find((a) => a.branch === wt.branch);
    if (artifact) await ctx.artifact(artifact.label, wt);
    ctx.publish();
  }
  // The latest follow-up's check is the current truth about the result, and the summary
  // (rebuilt by the pattern on every replay) should say what happened after the run.
  const lastChecked = [...run.followUps].reverse().find((f) => f.status === "done" && f.checkPassed !== undefined);
  if (lastChecked) ctx.setVerdict(lastChecked.checkPassed ? "passed" : "failing");
  const finished = run.followUps.filter((f) => f.status !== "pending");
  if (finished.length) {
    run.summary += `\n\n## Follow-ups\n${finished
      .map((f) => {
        const what = f.kind === "resolve-conflicts" ? `resolved conflicts with \`${f.mergeFrom}\`` : "addressed your review comments";
        const check = f.checkPassed === undefined ? "" : f.checkPassed ? " — check passes" : " — check still fails";
        return `- ${f.agent} ${f.status === "done" ? what : "couldn't finish"} in ${f.worktree}${check}`;
      })
      .join("\n")}`;
  }
}

/** When a run doesn't finish, list each worktree that holds work so you can still use it. */
async function collectUnfinishedWork(run: Run) {
  const listed = new Set(run.artifacts.map((a) => a.branch));
  for (const wt of run.worktrees) {
    if (listed.has(wt.branch)) continue;
    const stat = await diffStat({ ...wt, base: run.baseRef }, run.baseRef).catch(() => "");
    const pending = await uncommittedCount(wt.path).catch(() => 0);
    if (!stat && !pending) continue;
    const note = pending ? `${pending} uncommitted change${pending === 1 ? "" : "s"} left in the worktree` : "";
    run.artifacts.push({ label: `Work so far: ${wt.name}`, branch: wt.branch, path: wt.path, stat: [stat, note].filter(Boolean).join("\n") });
  }
}

/** Rebuild a run from its event log: the last run snapshot plus the latest state of each step. */
function rebuildRun(events: RunEvent[]): Run | undefined {
  let snapshot: RunSummary | undefined;
  const steps = new Map<string, Step>();
  for (const e of events) {
    if (e.type === "run") snapshot = e.run;
    else if (e.type === "step") steps.set(e.step.id, { ...e.step, kind: e.step.kind ?? "agent" });
  }
  if (!snapshot) return undefined;
  // Logs written before newer fields existed get sensible defaults.
  const legacy = snapshot as Partial<Run> & RunSummary;
  return {
    ...legacy,
    context: legacy.context ?? { paths: [], attachments: [] },
    agentSettings: legacy.agentSettings ?? {},
    loop: { ...DEFAULT_LOOP, ...(legacy.loop ?? {}) },
    usage: legacy.usage ?? { agentSteps: 0, checks: 0 },
    worktrees: legacy.worktrees ?? [],
    baseLabel: legacy.baseLabel ?? "HEAD",
    branchPrefix: legacy.branchPrefix ?? `codeflow/${legacy.id}`,
    worktreeDir: legacy.worktreeDir ?? join(worktreeRoot(legacy.repo), legacy.id),
    followUps: legacy.followUps ?? [],
    merges: legacy.merges ?? [],
    prs: legacy.prs ?? {},
    seen: legacy.seen ?? true,
    archived: legacy.archived ?? false,
    artifacts: legacy.artifacts ?? [],
    steps: [...steps.values()],
  };
}

function strip(run: Run): RunSummary {
  const { steps: _steps, ...rest } = run;
  return { ...rest, artifacts: [...rest.artifacts], worktrees: [...rest.worktrees], followUps: rest.followUps.map((f) => ({ ...f })) };
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}
