import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  adapters,
  type AccessMode,
  type AgentEvent,
  type AgentId,
  type AgentSettings,
  type ErrorKind,
  type RunResult,
} from "./adapters/index.js";
import { CODEFLOW_HOME, MAX_DIFF_CHARS, STEP_IDLE_MS, STEP_TIMEOUT_MS, timerMs } from "./config.js";
import { logWarn } from "./log.js";
import { cantRunMessage, cantRunReason, runCheck, type CheckResult, type Container } from "./checks.js";
import { commandExists } from "./adapters/process.js";
import { contextPrompt, hasStagedFiles, prepareContext, type ContextInput, type RunContext } from "./context.js";
import { fitDiff } from "./diff.js";
import { describeIssues, inspectChanges, unverifiedIssue, type IntegrityIssue } from "./integrity.js";
import { extractJson, shapeProblem } from "./json.js";
import { readConventions, recordFindings, recurringLessons } from "./learnings.js";
import { Slots } from "./slots.js";
import {
  CONTEXT_DIR,
  branchExists,
  commitAll,
  diffSince,
  diffStat,
  ensureCodeflowExcludes,
  git,
  isAncestor,
  isClean,
  isMerging,
  mergeBranch,
  openDetachedWorktree,
  openWorktree,
  removeDetachedWorktree,
  repoRoot,
  resolveCommit,
  restoreSnapshot,
  snapshot,
  uncommittedCount,
  validateBranchPrefix,
  validRef,
  worktreeRoot,
  type MergeResult,
  type Snapshot,
  type Worktree,
} from "./git.js";
import { appendLine, flushWrites, journalEntry, listRunIds, loadJournal, readJsonLines, RUNS_DIR } from "./store.js";
import { branchDiff, mergeInto, openPullRequest, pullRequestTarget, removeWorktrees, type DiffFile } from "./ship.js";
import { copyIntoWorktree, readRepoConfig, type Trust } from "./repo-config.js";
import { DevServers } from "./serve.js";
import { projectOf, type Project, type Projects } from "./projects.js";
import { commentOnPr, loadSource, mergeBase, pushBranch, sourcePrompt, type RunSource, type SourceInput } from "./github.js";

/** How many agent CLIs, and how many check/setup commands, may run at once across all runs. */
const agentSlots = new Slots(Math.max(1, Number(process.env.CODEFLOW_MAX_AGENTS) || 6));
const checkSlots = new Slots(Math.max(1, Number(process.env.CODEFLOW_MAX_CHECKS) || 3));
/** Waits before retrying an agent turn that failed for a passing reason (overloaded, network). */
const RETRY_DELAYS_MS = (process.env.CODEFLOW_RETRY_DELAYS_MS ?? "20000,60000").split(",").map(Number).filter((n) => n >= 0);

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
  /** Tokens (and, when the CLI reports it, API-equivalent cost) this turn used. */
  usage?: TokenUsage;
  /** Times this turn was retried after a passing failure (overloaded, network). */
  retries?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Claude Code reports what the turn would cost on the API; subscription use isn't billed. */
  costUsd: number;
}

export interface AgentUsage extends TokenUsage {
  steps: number;
  /** Steps that ended in an error. */
  failures: number;
  /** Steps in write mode (building, fixing) rather than planning or reviewing. */
  writeSteps: number;
  ms: number;
}

export interface Usage extends Partial<TokenUsage> {
  agentSteps: number;
  checks: number;
  byAgent?: Partial<Record<AgentId, AgentUsage>>;
}

/** What a pattern learned that's worth comparing across runs (who won, who got it green). */
export interface RunFacts {
  /** Race: the winning contestant and everyone who entered. */
  winner?: AgentId;
  entrants?: AgentId[];
  /** Loop: the worker whose round made the check pass, and how often work was handed over. */
  solvedBy?: AgentId;
  handoffs?: number;
  /** Review rounds before approval (pipeline), and whether the reviewer approved. */
  reviewRounds?: number;
  approved?: boolean;
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
  /** The project the run belongs to (see projects.ts); runs from before projects have none recorded. */
  project?: string;
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
  /** Per-role overrides of model/effort (e.g. Opus to plan, Sonnet to review). */
  roleSettings: Record<string, AgentSettings>;
  /** How much agents may do in write mode. */
  trust: Trust;
  /** How to run the app for "Run app" (from .codeflow/config.json). */
  app?: { command: string; port?: number };
  roles: Record<string, AgentId[]>;
  options: Record<string, number | boolean>;
  /** The "done when" check and the run's budgets. */
  loop: LoopSettings;
  usage: Usage;
  /** Result of the most recent check, if a check is configured. */
  lastCheck?: { ok: boolean; command: string; worktree: string; at: number };
  /** Set by patterns: did the result pass its check? */
  verdict?: "passed" | "failing";
  /**
   * The check can't run in this environment: its first run failed in a way that says the
   * environment is wrong, not the code (see `cantRunReason`), and it fails the same way on the
   * base commit. It's set aside for the rest of the run: no fix rounds, and no verdict.
   */
  checkCantRun?: { command: string; reason: string };
  /** Why a "stopped" run stopped. */
  stopReason?: string;
  worktrees: { name: string; branch: string; path: string }[];
  /** The user has looked at the finished run (otherwise it "needs you"). */
  seen: boolean;
  archived: boolean;
  /**
   * Messages you sent while the run was going: delivered into a running turn that takes input
   * (Codex app-server), otherwise at the start of an agent's next turn.
   */
  notes: Note[];
  /** Checkpoints you asked to approve (e.g. the plan before building). */
  approvals: { plan?: boolean };
  /** Set while the run is paused for your decision. */
  awaiting?: { kind: "plan"; title: string; content: string; at: number };
  /** The run this one continues (a "whole team again" reply). */
  parentRunId?: string;
  /** How many times the run was resumed. */
  resumes?: number;
  /** Work you sent back to an agent after the run (review comments, conflict fixes). */
  followUps: FollowUp[];
  /** Result branches merged from the UI. */
  merges: { branch: string; into: string; commit: string; at: number }[];
  /** Pull requests opened from the UI (or the PR the run started from, once pushed to), by branch. */
  prs: Record<string, string>;
  /** The GitHub issue or pull request the run started from. */
  source?: RunSource;
  /** Commit the changes under review are compared against (a PR's merge base). */
  reviewBase?: string;
  /** A review council's merged review. */
  review?: CouncilReview;
  /** PRs code-flow keeps an eye on after they're opened, by result branch. */
  watches: Record<string, PrWatch>;
  /** How "Auto" roles were filled when the run started. */
  routing?: string[];
  /**
   * Started by an automation (schedule, webhook, or "Run now") or a sweep, rather than by you
   * one at a time: its result waits in the inbox.
   */
  trigger?: { id: string; name: string; via: "schedule" | "webhook" | "manual" | "sweep" };
  /** Your decision on an automation's result: it waits in the inbox until you make one. */
  triage?: { state: "pending" | "approved" | "rejected" | "empty"; at: number; note?: string };
  /** Changes to tests in each result branch that could make the check pass without a fix. */
  integrity?: Record<string, IntegrityIssue[]>;
  /** Comparable outcomes (see RunFacts). */
  facts?: RunFacts;
  /** Runs started together to compare setups on the same task. */
  group?: { id: string; label: string };
  /** The repo's AGENTS.md / CLAUDE.md…, read at the base commit and given to every agent. */
  conventions?: string;
  /** Problems reviewers raised in earlier runs in this repo, given to every agent. */
  lessons?: string[];
  /** Why the run is locked down (untrusted input): Safe mode, nothing copied in, checks isolated. */
  lockdown?: string;
  /** Locked down without Docker, and you chose to run its commands on this machine anyway. */
  lockdownOnHost?: boolean;
  /** Record review findings for later runs (`learn` in .codeflow/config.json; default on). */
  learn?: boolean;
  /** The pattern itself finished; resuming only runs pending follow-ups. */
  patternDone?: boolean;
  /** The pattern's own summary (follow-ups are appended to `summary`). */
  patternSummary?: string;
  status: Status;
  createdAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  steps: Step[];
  artifacts: Artifact[];
}

export type RunSummary = Omit<Run, "steps">;

export interface Note {
  id: string;
  text: string;
  /** Deliver to this agent's running turn (if it takes input) or next turn; undefined = whoever can take it first. */
  agent?: AgentId;
  status: "queued" | "delivered";
  /** midTurn: it went into that step's turn while it ran, not into the turn's opening prompt. */
  deliveredTo?: { stepId: string; agent: AgentId; midTurn?: boolean };
  at: number;
}

export interface ApprovalAnswer {
  decision: "approve" | "revise" | "reject";
  note?: string;
}

export interface FollowUp {
  id: string;
  kind: "comments" | "reply" | "resolve-conflicts" | "ci-fix";
  worktree: string;
  agent: AgentId;
  /** What to tell the agent (comments, a reply, CI failures), or the branch to merge for conflicts. */
  message: string;
  mergeFrom?: string;
  /** Who the comments are from, when it isn't you (e.g. "@alice on the pull request"). */
  from?: string;
  /** Push the result to this branch on origin afterwards (PR follow-through). */
  push?: string;
  /** The result branch whose PR watch asked for this follow-up. */
  watch?: string;
  /** Permissions for this turn when they differ from the run's (unattended follow-ups get less). */
  trust?: Trust;
  /** Test changes code-flow found in this follow-up's commit. */
  integrity?: IntegrityIssue[];
  status: "pending" | "done" | "failed";
  result?: string;
  checkPassed?: boolean;
  pushed?: string;
  pushError?: string;
  at: number;
}

export interface CouncilFinding {
  severity: "high" | "medium" | "low";
  file: string;
  problem: string;
  fix: string;
  /** Reviewers who raised it; more agreement ranks first. */
  raisedBy: AgentId[];
}

export interface CouncilReview {
  verdict: "approve" | "changes_requested";
  summary: string;
  findings: CouncilFinding[];
  reviewers: { agent: AgentId; verdict: string; issues: number }[];
  markdown: string;
  /** Set when you posted it to the pull request. */
  postedTo?: string;
  postedAt?: number;
}

/**
 * Follow-through on an open PR: failing CI and new comments from the repo's collaborators go
 * back to `agent` as follow-ups, whose fixes are pushed to the PR. Never merges.
 */
export interface PrWatch {
  branch: string;
  pr: string;
  /** Branch on origin that fixes are pushed to. */
  remoteBranch: string;
  agent: AgentId;
  /** GitHub logins besides yours whose new comments the agent acts on. */
  allow?: string[];
  maxFixes: number;
  fixes: number;
  state: "watching" | "fixing" | "green" | "needs-you" | "closed" | "stopped";
  detail: string;
  checks?: { pass: number; fail: number; pending: number };
  /** PR head commits already sent for a CI fix. */
  fixedHeads: string[];
  /** Comment ids already handled (or ignored); unset until the first poll. */
  seenComments?: string[];
  lastPolled?: number;
  startedAt: number;
}

export interface LoopSettings {
  /** Shell command code-flow runs itself to decide "done" (e.g. `npm test`). Empty = agents' judgment only. */
  check?: string;
  /** Runs once in every new worktree before agents start (e.g. `npm ci`). */
  setup?: string;
  /** Gitignored files (like `.env`) copied from your checkout into every new worktree. */
  copy?: string[];
  /** Stop the run after this many minutes. */
  maxMinutes: number;
  /** Stop the run after this many agent turns. */
  maxSteps: number;
  /** Per check/setup command. */
  checkTimeoutMin: number;
  /** Run check and setup commands in this Docker container instead of on your machine. */
  container?: Container;
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
  /**
   * The prompt for a new conversation when the one to resume is gone (or never worked). Defaults
   * to the task followed by `prompt`.
   */
  fresh?: string;
  /** Return a failed outcome instead of throwing (useful for races). */
  allowFailure?: boolean;
  /** Identifies the step for resume when the title alone isn't unique (defaults to the title). */
  identity?: string;
  /** Permissions for this turn instead of the run's. */
  trust?: Trust;
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

/** You rejected a checkpoint (e.g. the plan); the run ends without building. */
export class RejectedError extends Error {}

export class CancelledError extends Error {
  constructor() {
    super("Run cancelled");
  }
}

/** The `parallel()` branch the current code runs in, so ctx calls made there stop with it. */
const branchScope = new AsyncLocalStorage<{ ctx: TeamContext; signal: AbortSignal }>();

/** What a pattern sees: the task, its team, and primitives to coordinate them. */
export class TeamContext {
  private readonly counters = new Map<string, number>();
  /** Agent turns taken in this attempt (the step budget restarts on resume). */
  private attemptSteps = 0;
  /** True while re-running already-journaled steps after a resume. */
  private replaying: boolean;
  /**
   * The commit each worktree is at *in this pass through the pattern*. On a replay the
   * worktree on disk already has every later commit, so recorded checks are matched against
   * this, not against HEAD: a check recorded for different code is run again.
   */
  private readonly heads = new Map<string, string>();
  /** How many tests the run's check ran in each worktree: the first time, and the latest. */
  private readonly testCounts = new Map<string, { first?: number; last?: number }>();
  /** Why the run's check can't run here (null: it can), settled by its first result. */
  private checkRunsHere?: Promise<string | null>;

  constructor(
    readonly run: Run,
    private readonly controller: AbortController,
    private readonly manager: RunManager,
    private readonly journal: Map<string, unknown> = new Map(),
    /** Only the run's pending follow-ups are run; the pattern finished in an earlier attempt. */
    readonly followUpsOnly = false,
  ) {
    this.replaying = journal.size > 0;
  }

  /**
   * Aborts when the run stops — or, inside a `parallel()` branch, when that branch is stopped
   * because another one failed. Agents, checks and waits all use it.
   */
  get signal(): AbortSignal {
    const scope = branchScope.getStore();
    return scope?.ctx === this ? scope.signal : this.controller.signal;
  }

  /**
   * Run `fn` for every item at once, each as a branch with its own abort signal (linked to the
   * enclosing one), so the agents and checks a branch starts can be stopped on their own. When a
   * branch throws, the others are stopped and every branch is waited for — nothing keeps running
   * (holding slots, out of reach of Stop) after the run has ended — and the first error is
   * thrown. A branch that may fail without stopping the others catches its own errors.
   */
  async parallel<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const parent = this.signal;
    const branches = items.map(() => new AbortController());
    const stopAll = () => branches.forEach((b) => b.abort());
    parent.addEventListener("abort", stopAll, { once: true });
    if (parent.aborted) stopAll();
    const failure: { error?: unknown; failed: boolean } = { failed: false };
    try {
      const settled = await Promise.allSettled(
        items.map((item, i) =>
          branchScope.run({ ctx: this, signal: branches[i]!.signal }, async () => {
            try {
              return await fn(item, i);
            } catch (error) {
              if (!failure.failed) {
                failure.failed = true;
                failure.error = error;
                stopAll();
              }
              throw error;
            }
          }),
        ),
      );
      if (failure.failed) throw failure.error;
      return settled.map((s) => (s as PromiseFulfilledResult<R>).value);
    } finally {
      parent.removeEventListener("abort", stopAll);
    }
  }

  private clock?: { timer?: ReturnType<typeof setTimeout>; remaining: number; startedAt: number };

  /** Start the run's time budget; it pauses while the run waits for you. */
  startClock(minutes: number) {
    this.clock = { remaining: minutes * 60_000, startedAt: Date.now() };
    this.armClock();
  }
  private armClock() {
    if (!this.clock) return;
    this.clock.startedAt = Date.now();
    // Clamped: past setTimeout's range (or NaN) a timer fires at once and would stop the run.
    this.clock.timer = setTimeout(() => this.stop(`time limit (${this.run.loop.maxMinutes} min)`), timerMs(this.clock.remaining));
    this.clock.timer.unref?.();
  }
  pauseClock() {
    if (!this.clock?.timer) return;
    clearTimeout(this.clock.timer);
    this.clock.timer = undefined;
    this.clock.remaining -= Date.now() - this.clock.startedAt;
  }
  resumeClock() {
    if (this.clock && !this.clock.timer) this.armClock();
  }
  stopClock() {
    if (this.clock?.timer) clearTimeout(this.clock.timer);
    this.clock = undefined;
  }

  /**
   * A checkpoint: if you asked to approve this kind of decision, the run pauses (time budget
   * too) until you approve, ask for changes, or reject. Answers are journaled, so a resumed run
   * doesn't ask again. Without the checkpoint enabled, this approves immediately.
   */
  async approve(kind: "plan", title: string, content: string): Promise<ApprovalAnswer> {
    if (!this.run.approvals?.[kind]) return { decision: "approve" };
    this.checkCancelled();
    return this.remember("approval", title, async () => {
      this.run.awaiting = { kind, title, content, at: Date.now() };
      this.run.seen = false;
      this.pauseClock();
      this.manager.emitRun(this.run);
      this.log(`Waiting for you: ${title}`);
      try {
        const answer = await this.manager.waitForAnswer(this.run.id, this.signal);
        this.log(`You chose to ${answer.decision === "revise" ? "ask for changes" : answer.decision}${answer.note ? `: ${answer.note}` : ""}`);
        return answer;
      } finally {
        this.run.awaiting = undefined;
        this.resumeClock();
        this.manager.emitRun(this.run);
      }
    });
  }

  /** Hand the notes you queued for this agent to the turn it's about to take. */
  private takeNotes(agent: AgentId, stepId: string) {
    const due = this.run.notes.filter((n) => n.status === "queued" && (!n.agent || n.agent === agent));
    if (!due.length) return;
    for (const n of due) {
      n.status = "delivered";
      n.deliveredTo = { stepId, agent };
    }
    this.manager.emitRun(this.run);
  }

  /** Every note a step was given, as the prompt preamble (a retry repeats mid-turn ones too). */
  private notesFor(stepId: string): string {
    const given = this.run.notes.filter((n) => n.status === "delivered" && n.deliveredTo?.stepId === stepId);
    return given.length ? `${noteMessage(given.map((n) => n.text))}\n\n` : "";
  }

  /** End the run because a budget ran out; in-flight agents and checks are stopped. */
  stop(reason: string) {
    if (this.run.stopReason) return;
    this.run.stopReason = reason;
    this.log(`Stopping: reached the ${reason}`, "warn");
    this.controller.abort();
  }

  /** True when the user configured a "done when" check command and it can run here. */
  get hasCheck(): boolean {
    return !!this.run.loop.check && !this.run.checkCantRun;
  }

  /** Publish the run's current state (for engine helpers outside the class). */
  publish() {
    this.manager.emitRun(this.run);
  }

  /** Record whether the final result passes its check (shown in the result header). */
  setVerdict(verdict: "passed" | "failing") {
    if (this.run.checkCantRun) return; // unknown: the check never ran on this change
    this.run.verdict = verdict;
  }

  /** Record comparable outcomes (race winner, who got the loop green…) for Insights. */
  setFacts(facts: RunFacts) {
    this.run.facts = { ...this.run.facts, ...facts };
  }

  /**
   * The user's task plus everything every agent is given with it: its source (issue, PR),
   * attached context, the repo's conventions and the problems reviewers keep raising here.
   */
  get task() {
    return this.run.task + sourcePrompt(this.run.source) + contextPrompt(this.run.context) + knowledgePrompt(this.run);
  }

  /** Record a review council's result (shown as the run's review, postable to the PR). */
  setReview(review: CouncilReview) {
    const posted = this.run.review?.markdown === review.markdown ? this.run.review : undefined;
    this.run.review = { ...review, postedTo: posted?.postedTo, postedAt: posted?.postedAt };
    this.manager.emitRun(this.run);
  }

  /** Remember review findings, so problems that keep coming back are passed on to later runs. */
  learn(findings: { severity?: string; file?: string; problem: string }[]) {
    if (this.replaying || this.run.learn === false) return;
    void recordFindings(this.run.repo, this.run.id, findings);
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
   * branches as long as identities differ (titles, worktree names). `valid` can reject a
   * recorded result that no longer applies (e.g. a check recorded for different code); the
   * step is then run again and its new result recorded.
   */
  async remember<T>(kind: string, identity: string, fn: () => Promise<T>, valid?: (recorded: T) => boolean | Promise<boolean>): Promise<T> {
    const base = `${kind}:${identity}`;
    const n = (this.counters.get(base) ?? 0) + 1;
    this.counters.set(base, n);
    const key = `${base}#${n}`;
    if (this.journal.has(key)) {
      const recorded = this.journal.get(key) as T;
      if (!valid || (await valid(recorded))) return recorded;
      this.replaying = false;
      this.log(`Running "${identity.split("|").slice(-2).join(" ")}" again: the code changed since its result was recorded`);
    }
    this.replaying = false;
    const value = await fn();
    this.journal.set(key, value);
    // On disk before the pattern goes on: killed right after, a resume replays this step
    // instead of running (and paying for) it again.
    await journalEntry(this.run.id, key, value ?? null);
    return value;
  }

  /**
   * Run the "done when" check in a worktree — code-flow runs it, not an agent, so the result
   * can be trusted. Returns null when no check is configured, or when it can't run here.
   */
  async check(wt: Worktree, title = "Check", command = this.run.loop.check): Promise<CheckResult | null> {
    if (!command) return null;
    this.checkCancelled();
    const doneWhen = command === this.run.loop.check; // not an agent-suggested command
    if (doneWhen && this.run.checkCantRun) return null;
    const head = this.heads.get(wt.name);
    const result = await this.remember(
      "check",
      `${wt.name}|${title}|${command}`,
      async (): Promise<CheckResult & { head?: string }> => {
        const result = await this.command("check", title, wt, command);
        this.run.usage.checks++;
        this.run.lastCheck = { ok: result.ok, command, worktree: wt.name, at: Date.now() };
        this.manager.emitRun(this.run);
        return { ...result, head: await resolveCommit(wt.path).catch(() => undefined) };
      },
      (recorded) => !recorded.head || !head || recorded.head === head,
    );
    if (doneWhen && !(await this.checkCanRun(wt, result))) return null;
    if (doneWhen && result.tests !== undefined) {
      const counts = this.testCounts.get(wt.name) ?? {};
      counts.first ??= result.tests;
      counts.last = result.tests;
      this.testCounts.set(wt.name, counts);
    }
    return result;
  }

  /**
   * The first result of the run's check settles whether it can run here at all. A failure that
   * says the environment is wrong (see `cantRunReason`) is tried once more on the base commit:
   * failing the same way there, the change isn't to blame, so the check is set aside for the
   * rest of the run — agents would otherwise spend fix rounds rewriting the test setup to get
   * around it. Returns false when it's set aside.
   */
  private async checkCanRun(wt: Worktree, result: CheckResult & { head?: string }): Promise<boolean> {
    const settling = (this.checkRunsHere ??= cantRunReason(result)
      ? this.remember("check-env", result.command, () => this.compareWithBase(wt, result))
      : Promise.resolve(null));
    let reason: string | null;
    try {
      reason = await settling;
    } catch (err) {
      // Couldn't tell (git failed setting up the base commit): the next check asks again.
      if (this.checkRunsHere === settling) this.checkRunsHere = undefined;
      throw err;
    }
    if (!reason || result.ok) return true;
    if (!this.run.checkCantRun) {
      this.run.checkCantRun = { command: result.command, reason };
      this.log(`${cantRunMessage(reason)}. Not spending fix rounds on it; the verdict stays unknown.`, "warn");
      this.manager.emitRun(this.run);
    }
    return false;
  }

  /** Why the check can't run, when it fails the same way on the commit `wt` started from; else null. */
  private async compareWithBase(wt: Worktree, result: CheckResult & { head?: string }): Promise<string | null> {
    const reason = cantRunReason(result)!;
    if (result.head === wt.base) return reason; // nothing changed yet: this is the base commit
    this.log(`The check couldn't run (${reason}); running it on the base commit to see whether the change is to blame`);
    const base = await this.checkOnBase(wt.base, result.command);
    if (base && !base.ok && cantRunReason(base)) return reason;
    this.log(
      base?.ok
        ? "It runs on the base commit, so the change broke it: treating it as a failing check"
        : base
          ? "It runs on the base commit (with failing tests), so the change broke it: treating it as a failing check"
          : "Setup failed on the base commit, so it can't tell: treating it as a failing check",
    );
    return null;
  }

  /** Set up a throwaway checkout of `commit` and run the check there; undefined when setup fails. */
  private async checkOnBase(commit: string, command: string): Promise<CheckResult | undefined> {
    const wt: Worktree = { name: "base", path: join(this.run.worktreeDir, ".base-check"), branch: "", base: commit };
    const { warning } = await openDetachedWorktree(this.run.repo, wt.path, commit, { signal: this.signal });
    if (warning) this.log(warning, "warn");
    try {
      if (this.run.loop.copy?.length) await copyIntoWorktree(this.run.repo, wt.path, this.run.loop.copy);
      if (this.run.loop.setup && !(await this.command("setup", "Setup base commit", wt, this.run.loop.setup)).ok) return undefined;
      const result = await this.command("check", "Check on base commit", wt, command);
      this.run.usage.checks++;
      return result;
    } finally {
      await removeDetachedWorktree(this.run.repo, wt.path).catch(() => undefined);
    }
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

    this.manager.noteActivity();
    let release: (() => void) | undefined;
    if (checkSlots.busy >= checkSlots.size) {
      this.manager.emit(this.run, { type: "agent", stepId: step.id, event: { kind: "status", text: `Waiting: ${checkSlots.size} checks are already running (CODEFLOW_MAX_CHECKS)` } });
    }
    const container = this.run.loop.container ? { ...this.run.loop.container, readOnly: [join(this.run.repo, ".git")] } : undefined;
    let result: CheckResult;
    try {
      // A locked-down run's commands run in Docker, or on this machine only if you said so. A
      // command the pattern picked itself (a tester's test command) isn't an exception.
      if (this.run.lockdown && !container && !this.run.lockdownOnHost) {
        throw new Error(`${this.run.lockdown}, and Docker isn't available, so code-flow won't run \`${command}\` on this machine`);
      }
      release = await checkSlots.acquire(this.signal).catch(() => undefined);
      result = release
        ? await runCheck(wt.path, command, { timeoutMs: timerMs(this.run.loop.checkTimeoutMin * 60_000, 1_000), signal: this.signal, container })
        : { command, ok: false, exitCode: null, timedOut: false, durationMs: 0, output: "Cancelled before it started" };
    } catch (err) {
      // Couldn't even start it: the step still ends, as a failure that says why.
      result = { command, ok: false, exitCode: null, timedOut: false, durationMs: 0, output: `code-flow couldn't run it: ${(err as Error).message}` };
    } finally {
      release?.();
    }

    this.manager.emit(this.run, {
      type: "agent",
      stepId: step.id,
      event: { kind: "tool_result", callId: step.id, output: result.output.slice(-8_000) || "(no output)", isError: !result.ok },
    });
    step.endedAt = Date.now();
    step.status = this.signal.aborted ? this.abortedStatus() : result.ok ? "done" : "failed";
    step.finalText = result.ok
      ? `Passed in ${Math.round(result.durationMs / 1000)}s${result.tests !== undefined ? ` (${result.tests} tests)` : ""}`
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
    let live = false;
    let wt = await this.remember("worktree", name, () => ((live = true), this.openWorktreeLive(name, fromRef)));
    if (!existsSync(wt.path)) {
      // Removed since it was recorded (e.g. archived): check the branch out again and set it up
      // like a new one — setup, copied files and context aren't in the branch.
      if (!(await branchExists(this.run.repo, wt.branch))) {
        throw new Error(`Branch ${wt.branch} was deleted, so the work in ${name} is gone. Start a new run instead.`);
      }
      const { wt: reopened, warning } = await openWorktree(this.run.repo, name, wt.path, wt.branch, fromRef, { signal: this.signal });
      wt = { ...reopened, base: wt.base };
      this.manager.emit(this.run, { type: "log", level: "info", text: `Re-attached ${name} at ${wt.path} (branch ${wt.branch})` });
      if (warning) this.log(warning, "warn");
      await this.prepareWorktree(wt);
    }
    if (!this.heads.has(name)) {
      // Replaying, the pattern starts from the base; otherwise from wherever the branch is.
      const replayed = !live && !this.followUpsOnly;
      this.heads.set(name, replayed ? wt.base : await resolveCommit(wt.path).catch(() => wt.base));
    }
    return wt;
  }

  private async openWorktreeLive(name: string, fromRef: string): Promise<Worktree> {
    const { wt, created, warning } = await openWorktree(
      this.run.repo,
      name,
      join(this.run.worktreeDir, name),
      `${this.run.branchPrefix}/${name}`,
      fromRef,
      { signal: this.signal },
    );
    if (!this.run.worktrees.some((w) => w.name === name)) {
      this.run.worktrees.push({ name: wt.name, branch: wt.branch, path: wt.path });
    }
    if (warning) this.log(warning, "warn");
    if (!created) {
      // Recorded only once it's set up, so an earlier attempt may have stopped mid-setup (a crash
      // during `npm ci`): agents would get a worktree without its dependencies.
      if (await isPrepared(wt)) {
        this.log(`Reusing existing worktree ${wt.path} (branch ${wt.branch})`);
        return wt;
      }
      this.log(`Reusing existing worktree ${wt.path} (branch ${wt.branch}); it was never fully set up, so setting it up now`);
      await this.prepareWorktree(wt);
      return wt;
    }
    this.log(`Created worktree ${wt.path} on branch ${wt.branch}`);
    await this.prepareWorktree(wt);
    return wt;
  }

  /**
   * Make a new (or re-attached) worktree work like your checkout: context, copied files, setup.
   * Then mark it prepared, so a worktree that stopped partway is set up again when reused.
   */
  private async prepareWorktree(wt: Worktree) {
    if (hasStagedFiles(this.run.context)) {
      // Git-excluded, so it is never committed and doesn't count as a change.
      await cp(join(this.run.worktreeDir, STAGE_DIR), join(wt.path, CONTEXT_DIR), { recursive: true });
    }
    if (this.run.loop.copy?.length) {
      const { copied, refused } = await copyIntoWorktree(this.run.repo, wt.path, this.run.loop.copy);
      if (copied.length) this.manager.log(this.run.id, `Copied ${copied.join(", ")} from your checkout into ${wt.name}`);
      for (const r of refused) this.manager.log(this.run.id, `Didn't copy ${r.path}: ${r.why}`, "warn");
    }
    if (this.run.loop.setup) {
      const setup = await this.command("setup", `Setup ${wt.name}`, wt, this.run.loop.setup);
      if (!setup.ok) throw new Error(`Setup command \`${this.run.loop.setup}\` failed in worktree ${wt.name}`);
      if (!(await isClean(wt.path))) this.manager.log(this.run.id, `Setup left changes in ${wt.name}; they'll appear in its diff`, "warn");
    }
    const marker = await preparedMarker(wt);
    const written = marker && (await writeFile(marker, `${new Date().toISOString()}\n`).then(() => true, () => false));
    if (!written) this.manager.log(this.run.id, `Couldn't mark ${wt.name} as set up; it will be set up again if it's reused`, "warn");
  }

  async commit(wt: Worktree, message: string): Promise<string | null> {
    this.checkCancelled();
    const sha = await this.remember(
      "commit",
      `${wt.name}|${message}`,
      async () => {
        const sha = (await commitAll(wt, message)) ?? (await this.recoverCommit(wt, message));
        if (sha) this.log(`Committed ${sha.slice(0, 8)} on ${wt.branch}: ${message}`);
        return sha;
      },
      // A recorded commit only stands if it's still in the branch's history.
      async (recorded) => recorded === null || (await isAncestor(wt.path, recorded)),
    );
    if (sha) this.heads.set(wt.name, sha);
    return sha;
  }

  /**
   * code-flow stopped between making a commit and recording it: the commit is there but the
   * journal doesn't know it, so committing again finds nothing. Recognize it by its message.
   */
  private async recoverCommit(wt: Worktree, message: string): Promise<string | null> {
    const known = this.heads.get(wt.name);
    const head = await resolveCommit(wt.path).catch(() => "");
    if (!head || !known || head === known) return null;
    const subject = (await git(["log", "-1", "--format=%s", head], wt.path)).stdout.trim();
    return subject === message && (await isAncestor(wt.path, known, head)) ? head : null;
  }

  /** Merge another branch into a worktree (the conflicts, if any, are left for an agent). */
  async merge(wt: Worktree, branch: string): Promise<MergeResult> {
    this.checkCancelled();
    const result = await this.remember("merge", branch, async (): Promise<MergeResult & { head?: string }> => {
      const merged = await mergeBranch(wt, branch);
      return { ...merged, head: merged.ok ? await resolveCommit(wt.path) : undefined };
    });
    if (result.head) this.heads.set(wt.name, result.head);
    return result;
  }

  /** Diff of the worktree against its base, fitted to a prompt (whole files first; see fitDiff). */
  async diff(wt: Worktree, base = wt.base): Promise<string> {
    const full = await diffSince(wt, base);
    if (!full.trim()) return "(no changes)";
    return fitDiff(full, MAX_DIFF_CHARS, base);
  }

  /**
   * Changes since `from` that could make the check pass without fixing anything: deleted or
   * skipped tests, weakened assertions, a changed test script or config, fewer tests running.
   */
  async testChanges(wt: Worktree, from = wt.base): Promise<IntegrityIssue[]> {
    const counts = this.testCounts.get(wt.name);
    return inspectChanges(wt.path, from, "HEAD", {
      check: this.run.loop.check,
      tests: counts ? { before: counts.first, after: counts.last } : undefined,
    }).catch((err: Error) => [unverifiedIssue(err.message)]); // not knowing isn't the same as no issues
  }

  /** Publish a result branch (replaces an earlier artifact with the same label). */
  async artifact(label: string, wt: Worktree) {
    const stat = await diffStat(wt, this.run.baseRef).catch((err: Error) => {
      this.log(`${label}: couldn't read its changes (${err.message})`, "warn");
      return "";
    });
    this.run.artifacts = this.run.artifacts.filter((a) => a.label !== label);
    this.run.artifacts.push({ label, branch: wt.branch, path: wt.path, stat });
    const issues = await this.testChanges(wt, this.run.baseRef);
    const integrity = { ...this.run.integrity };
    if (issues.length) integrity[wt.branch] = issues;
    else delete integrity[wt.branch];
    this.run.integrity = Object.keys(integrity).length ? integrity : undefined;
    if (issues.length) this.log(`${label}: changes to tests to look at before merging:\n${describeIssues(issues)}`, "warn");
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
    const inSession = first.ok && !!first.sessionId;
    const retry = await this.ask({
      ...params,
      title: `${params.title} (retry)`,
      identity: params.identity ? `${params.identity} (retry)` : undefined,
      resume: inSession ? first : params.resume,
      prompt:
        `Your previous answer did not contain a valid ${params.what}: ${firstRead.problem}.\n` +
        `Reply again with only a JSON object matching this schema:\n\`\`\`json\n${JSON.stringify(params.schema)}\n\`\`\`` +
        (inSession ? "" : `\n\nThe original request was:\n${params.prompt}`),
      // If that session turns out to be gone, a new one gets the whole original request.
      fresh: this.freshPrompt(params),
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
    return this.remember("ask", `${params.role}|${params.agent}|${params.cwd.name}|${params.identity ?? params.title}`, () => this.askLive(params));
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
    // Notes are picked up before the step is announced. Anything sent after it shows as running
    // goes into the turn itself if the turn takes input (Codex app-server), else to the next turn.
    this.takeNotes(params.agent, step.id);
    this.run.steps.push(step);
    this.manager.emit(this.run, { type: "step", step: { ...step } });

    const onEvent = (event: AgentEvent) => {
      if (event.kind === "session") step.sessionId = event.sessionId;
      if (event.kind === "quota") this.manager.recordQuota(params.agent, event.status, event.windows);
      if (event.kind === "usage") this.addTokens(step, params.agent, event);
      this.manager.emit(this.run, { type: "agent", stepId: step.id, event });
    };

    this.manager.noteActivity();
    // At most CODEFLOW_MAX_AGENTS agent CLIs run at once, across every run. A turn waiting to be
    // retried gives its slot back meanwhile.
    let release: (() => void) | undefined;
    const slot: AgentSlot = {
      take: async () => {
        if (agentSlots.busy >= agentSlots.size) onEvent({ kind: "status", text: `Waiting for a free agent slot (${agentSlots.size} agents run at once; CODEFLOW_MAX_AGENTS)` });
        release = await agentSlots.acquire(this.signal).catch(() => undefined);
        return !!release;
      },
      give: () => {
        release?.();
        release = undefined;
      },
    };
    let result: RunResult;
    try {
      if (await slot.take()) {
        step.startedAt = Date.now();
        result = await this.runAgent(params, step, onEvent, slot);
      } else {
        result = { ok: false, finalText: "", error: "Cancelled before it started", errorKind: "cancelled" };
      }
    } catch (err) {
      // An adapter (or git) that throws instead of reporting a failed turn still ends the step.
      result = { ok: false, finalText: "", error: (err as Error)?.message ?? String(err), errorKind: "other" };
    } finally {
      slot.give();
      this.manager.setSteerer(this.run, step.id, params.agent, undefined);
    }

    const kind = failureKind(result, !!params.resume);
    // Out of plan usage steers "Auto" away from this agent; a per-minute 429 was just retried.
    const usageLimit = kind === "usage_limit";
    if (usageLimit) this.manager.recordLimit(params.agent, result.resetsAt);
    if (kind === "auth") {
      this.manager.recordQuota(params.agent, "signed_out", {});
      result = { ...result, error: `${adapters[params.agent].displayName} isn't signed in. Sign in to it in a terminal, then resume the run. (${firstLine(result.error)})` };
    }

    step.endedAt = Date.now();
    // A conversation that couldn't be resumed is gone: nothing may try to continue it later.
    step.sessionId = kind === "session_not_found" ? undefined : result.sessionId;
    step.finalText = result.finalText;
    step.error = result.error;
    step.status = this.signal.aborted ? this.abortedStatus() : result.ok ? "done" : "failed";
    if (this.signal.aborted && !this.controller.signal.aborted) step.error = "Stopped: a step running alongside it failed";
    const agentUsage = this.agentUsage(params.agent);
    agentUsage.steps++;
    if (params.mode === "write") agentUsage.writeSteps++;
    if (step.status === "failed") agentUsage.failures++;
    agentUsage.ms += step.endedAt - step.startedAt;
    this.manager.emit(this.run, { type: "step", step: { ...step } });
    // Your notes didn't land in a turn that finished: they go to the next one (its retry, or the resumed run).
    if (step.status !== "done") this.manager.requeueNotes(this.run, step.id);

    // Out of plan usage: retrying won't help for hours. Stop (resumable) instead of failing.
    if (usageLimit && !params.allowFailure && !this.signal.aborted) {
      this.stop(`usage limit of ${adapters[params.agent].displayName}`);
    }
    this.checkCancelled();
    if (!result.ok && !params.allowFailure) {
      throw new Error(`${params.title} (${params.agent}) failed: ${result.error ?? "unknown error"}`);
    }
    return { ...result, stepId: step.id, agent: params.agent };
  }

  /**
   * A turn that ended normally but produced nothing usable (a worker that changed nothing):
   * show it as failed, saying why, so the run and Insights don't count it as a success.
   */
  failStep(outcome: StepOutcome, error: string) {
    const step = this.run.steps.find((s) => s.id === outcome.stepId);
    if (step?.status !== "done") return; // already marked on an earlier pass, or not a success
    step.status = "failed";
    step.error = error;
    this.agentUsage(outcome.agent).failures++;
    this.manager.emit(this.run, { type: "step", step: { ...step } });
  }

  /**
   * The agent turn itself: read-only enforced by snapshot and restore (for every agent, not
   * just trusted to each CLI's flags), and passing failures (overloaded, network) retried.
   */
  private async runAgent(params: AskParams, step: Step, onEvent: (e: AgentEvent) => void, slot: AgentSlot): Promise<RunResult> {
    // The worktree as the step found it: read-only puts it back afterwards, and a write step
    // retried without a session to continue starts over from it.
    let start: Snapshot | undefined;
    try {
      start = await snapshot(params.cwd.path);
    } catch (err) {
      // Read-only can't be enforced without it: don't run the agent at all (fail closed).
      if (params.mode === "read") {
        return { ok: false, finalText: "", errorKind: "other", error: `Couldn't record the worktree's state, so read-only mode can't be enforced: ${(err as Error).message}` };
      }
    }
    let restore: { undone: string[] } | { error: Error } | undefined;
    let result: RunResult;
    try {
      result = await this.attempts(params, step, onEvent, slot, start);
    } finally {
      // Also when the adapter threw: a read-only step never leaves changes behind.
      if (params.mode === "read" && start) {
        restore = await restoreSnapshot(params.cwd.path, start).then((undone) => ({ undone }), (error: Error) => ({ error }));
      }
    }
    if (restore && "error" in restore) {
      return { ...result, ok: false, errorKind: "other", error: `Couldn't undo what this read-only step changed: ${restore.error.message}` };
    }
    if (restore?.undone.length) {
      this.log(`${params.title} (${params.agent}) modified files in read-only mode; changes were reverted (${restore.undone.join(", ")})`, "warn");
    }
    return result;
  }

  /**
   * Run the turn, again after a passing failure (overloaded, network, a stalled CLI) — at most
   * RETRY_DELAYS_MS.length times. A write step doesn't redo its prompt on top of the edits the
   * failed attempt left: it continues that attempt's session, or else starts over from the
   * worktree as the step found it. A conversation to resume that's gone gets one new session
   * with the whole task instead.
   */
  private async attempts(params: AskParams, step: Step, onEvent: (e: AgentEvent) => void, slot: AgentSlot, start?: Snapshot): Promise<RunResult> {
    const name = adapters[params.agent].displayName;
    // Only a turn that worked left a conversation worth continuing.
    let resume = params.resume?.ok !== false ? params.resume?.sessionId : undefined;
    let prompt = params.resume && !resume ? this.freshPrompt(params) : params.prompt;
    /** What starting over runs: the step's own request. */
    let initial = { resume, prompt };
    let freshSession = false;
    for (let retries = 0; ; ) {
      const result = await adapters[params.agent].run(
        {
          prompt: this.notesFor(step.id) + prompt,
          cwd: params.cwd.path,
          mode: params.mode,
          resumeSessionId: resume,
          model: this.run.roleSettings?.[params.role]?.[params.agent]?.model || this.run.agentSettings[params.agent]?.model,
          effort: this.run.roleSettings?.[params.role]?.[params.agent]?.effort || this.run.agentSettings[params.agent]?.effort,
          jsonSchema: params.schema,
          trust: params.trust ?? this.run.trust,
          signal: this.signal,
          timeoutMs: STEP_TIMEOUT_MS,
          idleTimeoutMs: STEP_IDLE_MS,
          onSteerable: (steer) => this.manager.setSteerer(this.run, step.id, params.agent, steer),
        },
        onEvent,
      );
      if (result.ok || this.signal.aborted) return result;
      const kind = failureKind(result, !!resume);
      if (kind === "session_not_found" && resume && !freshSession) {
        // An earlier attempt of this write step may have edited files before failing: the whole
        // task again starts from the worktree as the step found it, or not at all.
        if (params.mode === "write" && retries > 0) {
          if (!start || (await isMerging(params.cwd.path)) || !(await restoreSnapshot(params.cwd.path, start).then(() => true, () => false))) return result;
        }
        freshSession = true;
        onEvent({ kind: "status", text: `The ${name} conversation to continue no longer exists; starting a new one with the whole task` });
        resume = undefined;
        prompt = this.freshPrompt(params);
        initial = { resume, prompt };
        continue;
      }
      if (!RETRYABLE.has(kind) || retries >= RETRY_DELAYS_MS.length) return result;
      let startOver = false;
      if (params.mode === "write") {
        if (result.sessionId) {
          resume = result.sessionId;
          // The request again, for reference: the conversation may hold none of it (a Codex
          // thread can start and its first turn then fail).
          prompt =
            `Your previous attempt at this stopped with an error (${firstLine(result.error)}). ` +
            "Continue from the current state of the worktree: finish what was asked, then reply as asked.\n\n" +
            `For reference, the request was:\n${initial.prompt}`;
        } else if (start && !(await isMerging(params.cwd.path))) {
          // (Not mid-merge: resetting would drop the merge, and its commit would lose a parent.)
          startOver = true;
          ({ resume, prompt } = initial);
        } else {
          return result; // nothing to continue, and its partial edits can't be undone
        }
      }
      const wait = RETRY_DELAYS_MS[retries]!;
      step.retries = ++retries;
      onEvent({ kind: "status", text: `${name} failed (${firstLine(result.error).slice(0, 160)}); trying again in ${Math.round(wait / 1000)}s` });
      slot.give();
      if (!(await sleep(wait, this.signal)) || !(await slot.take())) return result;
      if (startOver && !(await restoreSnapshot(params.cwd.path, start!).then(() => true, () => false))) return result;
    }
  }

  /** The request for a new conversation, when the one it was meant to continue is gone. */
  private freshPrompt(params: AskParams): string {
    if (params.fresh) return params.fresh;
    if (!params.resume) return params.prompt;
    return (
      `You are working in a git worktree for this task:\n${this.task}\n\n` +
      "(Your earlier conversation about it can't be continued, so this is a new one. The files and `git log` show what has been done so far.)\n\n" +
      params.prompt
    );
  }

  private agentUsage(agent: AgentId): AgentUsage {
    const byAgent = (this.run.usage.byAgent ??= {});
    return (byAgent[agent] ??= { steps: 0, failures: 0, writeSteps: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 });
  }

  private addTokens(step: Step, agent: AgentId, event: Extract<AgentEvent, { kind: "usage" }>) {
    const add = (u: Partial<TokenUsage>) => {
      u.inputTokens = (u.inputTokens ?? 0) + (event.inputTokens ?? 0);
      u.outputTokens = (u.outputTokens ?? 0) + (event.outputTokens ?? 0);
      u.cacheReadTokens = (u.cacheReadTokens ?? 0) + (event.cacheReadTokens ?? 0);
      u.costUsd = (u.costUsd ?? 0) + (event.costUsd ?? 0);
    };
    step.usage ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    add(step.usage);
    add(this.run.usage);
    add(this.agentUsage(agent));
  }
}

/** How your notes are put to an agent: before its turn, or into the turn while it runs. */
function noteMessage(texts: string[], midTurn = false): string {
  const when = midTurn ? "Sent while you were working on this — take it into account from here on." : "Sent while the team was working — take it into account.";
  return `## A message from the user\n(${when})\n${texts.map((t) => `- ${t}`).join("\n")}`;
}

/** An agent slot a turn holds, given back while it waits to be retried. */
interface AgentSlot {
  take(): Promise<boolean>;
  give(): void;
}

/** Plan usage used up: hours until it resets. */
const USAGE_LIMIT = /usage limit|limit reached|quota (?:exceeded|reached|exhausted)|exceeded (?:your|the) [\w -]{0,30}quota|RESOURCE_EXHAUSTED|out of credits|credit balance is too low/i;
/**
 * Worth another try in a minute. An HTTP status only counts with words around it ("status 503",
 * "HTTP 502", "error 529", "500 Internal Server Error"): a bare 500 in a test log is not one.
 */
const TRANSIENT = new RegExp(
  [
    "overloaded",
    "too many requests",
    "rate.?limit",
    String.raw`\b(?:status|code|http(?:/[\d.]+)?|error)\b[\s:=#]*(?:429|50[0234]|529)\b`,
    String.raw`\b(?:429|50[0234]|529)\s+(?:too many requests|internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)`,
    "temporar(?:il)?y unavailable",
    "ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error",
    "connection (?:reset|closed|error)",
  ].join("|"),
  "i",
);
/** The conversation a turn was to resume doesn't exist (any more). */
const SESSION_GONE = /no conversation found|(?:session|thread|conversation)\b[^\n]{0,40}\bnot found/i;
/** Failures a retry in a minute can fix. */
const RETRYABLE = new Set<ErrorKind | undefined>(["transient", "rate_limit", "stalled"]);

/**
 * Why a turn failed: the adapter's own `errorKind` when it set one; otherwise read from the error
 * text (for adapters that don't say).
 */
export function failureKind(result: RunResult, resumed: boolean): ErrorKind | undefined {
  if (result.ok) return undefined;
  if (result.errorKind) return result.errorKind;
  const error = result.error ?? "";
  if (USAGE_LIMIT.test(error)) return "usage_limit";
  if (TRANSIENT.test(error)) return "transient";
  if (resumed && SESSION_GONE.test(error)) return "session_not_found";
  return undefined;
}

/** The first line of an error, for a status line or a message. */
function firstLine(text?: string): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "unknown error";
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** Wait `ms`; false if `signal` aborted first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The repo's conventions and recurring review problems, as prompt sections. */
function knowledgePrompt(run: Run): string {
  const parts: string[] = [];
  if (run.conventions) {
    parts.push(`\n\n## Project conventions\nThe repository's own instructions for contributors (its AGENTS.md, CLAUDE.md and similar files). Follow them.\n\n${run.conventions}`);
  }
  if (run.lessons?.length) {
    parts.push(
      `\n\n## Problems reviewers keep finding in this repo\nEarlier code-flow runs here were sent back for these more than once. Don't repeat them:\n${run.lessons.map((l) => `- ${l}`).join("\n")}`,
    );
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Run manager
// ---------------------------------------------------------------------------

export interface StartRunInput {
  pattern: Pattern;
  task: string;
  repo: string;
  /** The project to start it in; by default the project of the run it continues, or the repo's. */
  project?: string;
  /** Branch, tag or commit to start from; defaults to the repo's current HEAD. */
  baseRef?: string;
  /** Defaults to `codeflow/<run id>`. */
  branchPrefix?: string;
  context?: ContextInput;
  agentSettings?: AgentSettings;
  loop?: Partial<LoopSettings>;
  approvals?: { plan?: boolean };
  parentRunId?: string;
  roleSettings?: Record<string, AgentSettings>;
  trust?: Trust;
  /** Start from a GitHub issue or PR (a PR's branch becomes the base). */
  source?: SourceInput;
  /** How "Auto" roles were resolved, for the log. */
  routing?: string[];
  /** Set when an automation starts the run. */
  trigger?: Run["trigger"];
  /** Part of a comparison: runs of the same task with different setups. */
  group?: Run["group"];
  /**
   * The source is untrusted but you chose to run its checks on this machine anyway (without
   * Docker). Agents are still locked down to Safe mode.
   */
  allowUntrusted?: boolean;
  roles: Record<string, AgentId[]>;
  options: Record<string, number | boolean>;
}

const QUOTA_FILE = join(CODEFLOW_HOME, "quota.json");

export class RunManager {
  private readonly runs = new Map<string, Run>();
  /** Event history of running runs (finished runs are read back from disk when needed). */
  private readonly history = new Map<string, RunEvent[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly active = new Map<string, Promise<void>>();
  /** Runs between "resume requested" and "running": a second request must not start them twice. */
  private readonly starting = new Set<string>();
  /** Stop was pressed while a resume was starting: it doesn't start. */
  private readonly stoppedWhileStarting = new Set<string>();
  private readonly bus = new EventEmitter();
  private seq = 0;
  private shuttingDown = false;

  constructor(
    private readonly findPattern: (id: string) => Pattern | undefined = () => undefined,
    /** Where runs are grouped; without it runs record no project. */
    readonly projects?: Projects,
  ) {
    this.bus.setMaxListeners(0);
  }

  get isShuttingDown() {
    return this.shuttingDown;
  }

  /** Called whenever code-flow is about to start an agent or run a command (see server auth). */
  noteActivity() {
    this.bus.emit("activity");
  }

  onActivity(listener: () => void): () => void {
    this.bus.on("activity", listener);
    return () => this.bus.off("activity", listener);
  }

  /** How busy code-flow is: processes running and waiting across all runs. */
  get busy() {
    return { agents: { running: agentSlots.busy, waiting: agentSlots.queued, max: agentSlots.size }, checks: { running: checkSlots.busy, waiting: checkSlots.queued, max: checkSlots.size } };
  }

  /** Rebuild runs from their event logs; runs that were mid-flight become "interrupted". */
  async load(): Promise<void> {
    await this.loadQuota();
    const ids = (await listRunIds()).filter((id) => !this.runs.has(id));
    // A few logs at a time: one by one is slow with hundreds of runs, all at once opens too many files.
    const logs = await mapLimit(ids, 8, (id) =>
      readJsonLines<RunEvent>(`${id}.jsonl`).catch((err: Error) => {
        logWarn(`Couldn't read the log of run ${id}; it's left out`, { error: err.message });
        return [] as RunEvent[];
      }),
    );
    ids.forEach((id, i) => {
      const events = logs[i]!;
      for (const e of events) if (typeof e.seq === "number" && e.seq > this.seq) this.seq = e.seq;
      const run = rebuildRun(events);
      if (!run) {
        if (events.length) logWarn(`The log of run ${id} has no run snapshot; it's left out`, { events: events.length });
        return;
      }
      if (this.runs.has(id)) return;
      this.runs.set(id, run);
      const wasRunning = run.status === "running";
      if (wasRunning) {
        run.status = "interrupted";
        run.error = "code-flow stopped while this run was in progress. Resume to continue.";
        run.endedAt = run.endedAt ?? Date.now();
        run.seen = false;
        // Nobody can answer a checkpoint now; resuming asks again.
        run.awaiting = undefined;
      }
      // No step is still running in a run that isn't, whatever left it open (a crash, an error
      // an older code-flow didn't catch).
      let closed = false;
      for (const step of run.steps) {
        if (step.status !== "running") continue;
        step.status = "interrupted";
        step.endedAt ??= run.endedAt ?? Date.now();
        step.error ??= "code-flow stopped before this step finished";
        this.emit(run, { type: "step", step: { ...step } });
        closed = true;
      }
      if (wasRunning || closed) {
        requeueNotes(run);
        this.emitRun(run);
      }
    });
    void this.tidyWorktrees().catch((err: Error) => logWarn("Couldn't tidy worktrees at startup", { error: err.message }));
  }

  /**
   * Startup housekeeping: folders in a worktree root that no known run owns are logged. Nothing
   * is deleted, and git's worktree list isn't pruned here: that would also drop your own
   * worktrees on a drive that isn't mounted right now.
   */
  private async tidyWorktrees() {
    const runs = [...this.runs.values()];
    const roots = new Set(runs.filter((r) => existsSync(r.repo)).map((r) => dirname(r.worktreeDir)));
    for (const root of roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const orphans = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !this.runs.has(e.name)).map((e) => join(root, e.name));
      if (orphans.length) logWarn("Worktree folders no run owns (left alone; remove them if you don't need them)", { folders: orphans });
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
    // A resume still waiting for the last attempt to wrap up: that controller is the old one.
    if (this.starting.has(id)) this.stoppedWhileStarting.add(id);
    const controller = this.controllers.get(id);
    if (!controller) return this.starting.has(id);
    controller.abort();
    return true;
  }

  setSeen(id: string, seen = true) {
    const run = this.runs.get(id);
    if (!run || run.seen === seen) return;
    run.seen = seen;
    this.emitRun(run);
  }

  /** Running, or claimed by a resume that's about to start it. */
  private busyRun(run: Run): boolean {
    return run.status === "running" || this.starting.has(run.id);
  }

  setArchived(id: string, archived: boolean) {
    const run = this.require(id);
    if (this.busyRun(run)) throw new Error("Stop the run before archiving it");
    run.archived = archived;
    if (archived) run.seen = true;
    this.emitRun(run);
  }

  /** Move a run to another project; its repo joins that project if it isn't in it yet. */
  async setProject(id: string, projectId: string) {
    const run = this.require(id);
    const { project, added } = await this.requireProjects().include(projectId, run.repo);
    if (run.project === project.id) return project;
    run.project = project.id;
    this.emit(run, { type: "log", level: "info", text: `Moved to the project “${project.name}”${added ? `, which now includes ${basename(run.repo)}` : ""}` });
    this.emitRun(run);
    return project;
  }

  /**
   * Rename a project or change its repos. Runs from before projects record none: they belong to
   * the first project holding their repo, so taking the repo out would move them elsewhere. The
   * project is recorded on them first, so the runs already in a project stay in it.
   */
  async updateProject(id: string, patch: { name?: unknown; repos?: unknown[] }) {
    const projects = this.requireProjects();
    const before = projects.list();
    const updated = await projects.update(id, patch);
    this.keepInProject(id, before, (repo) => !updated.repos.includes(repo));
    return updated;
  }

  /** Delete a project. Its runs stay, in no project; older runs too, rather than moving to another project with their repo. */
  async removeProject(id: string) {
    const projects = this.requireProjects();
    const before = projects.list();
    await projects.remove(id);
    this.keepInProject(id, before, () => true);
  }

  /** Record `id` on the runs that belonged to it only through their repo (as of `before`). */
  private keepInProject(id: string, before: Project[], affected: (repo: string) => boolean) {
    for (const run of this.runs.values()) {
      if (run.project || !affected(run.repo) || projectOf(run, before) !== id) continue;
      run.project = id;
      this.emitRun(run);
    }
  }

  private requireProjects(): Projects {
    if (!this.projects) throw new Error("Projects aren't available here");
    return this.projects;
  }

  /**
   * Archive a run and, optionally, remove its worktrees (branches are kept unless asked).
   * A later Resume re-attaches kept branches, so nothing committed is lost.
   */
  async archive(id: string, opts: { cleanup?: boolean; deleteBranches?: boolean } = {}) {
    const run = this.require(id);
    this.setArchived(id, true);
    this.devServers.stopMatching(`${id}/`);
    if (!opts.cleanup) return { removed: [], deletedBranches: [] };
    const result = await removeWorktrees(run.repo, run.worktrees, !!opts.deleteBranches);
    this.emit(run, {
      type: "log",
      level: "info",
      text: `Archived: removed ${result.removed.length} worktree(s)${result.deletedBranches.length ? ` and ${result.deletedBranches.length} branch(es)` : "; branches kept"}`,
    });
    if (result.failed.length) this.emit(run, { type: "log", level: "warn", text: `Couldn't remove: ${result.failed.join("; ")}` });
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
  async followUp(
    id: string,
    input: {
      kind?: FollowUp["kind"];
      worktree: string;
      agent: AgentId;
      message?: string;
      mergeFrom?: string;
      from?: string;
      push?: string;
      watch?: string;
      trust?: Trust;
    },
  ) {
    const run = this.require(id);
    if (run.status !== "done" || this.starting.has(id)) throw new Error("Follow-ups can be sent once the run has finished");
    if (!run.worktrees.some((w) => w.name === input.worktree)) throw new Error(`Unknown worktree "${input.worktree}"`);
    const kind = input.kind ?? "comments";
    if (kind !== "resolve-conflicts" && !input.message?.trim()) throw new Error(kind === "reply" ? "Write a reply" : "Write at least one comment");
    if (kind === "resolve-conflicts" && !input.mergeFrom) throw new Error("Say which branch to merge");
    if (kind === "resolve-conflicts" && !(await validRef(run.repo, input.mergeFrom!))) throw new Error(`"${input.mergeFrom}" isn't a branch in this repository`);
    if (run.status !== "done" || this.starting.has(id)) throw new Error("Follow-ups can be sent once the run has finished");
    run.followUps.push({
      id: `f${run.followUps.length + 1}`,
      kind,
      worktree: input.worktree,
      agent: input.agent,
      message: input.message?.trim() ?? "",
      mergeFrom: input.mergeFrom,
      from: input.from,
      push: input.push,
      watch: input.watch,
      trust: input.trust,
      status: "pending",
      at: Date.now(),
    });
    return this.resume(id);
  }

  /** Merge a result branch into one of your branches (see `mergeInto` for how it stays safe). */
  async merge(id: string, input: { branch: string; into: string; archiveAfter?: boolean }) {
    const run = this.require(id);
    if (this.busyRun(run)) throw new Error("Wait for the run to finish before merging");
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
      run.source?.kind === "issue" ? `\nCloses #${run.source.number}` : run.source?.kind === "alert" ? `\nFixes ${run.source.url}` : "",
      "",
      "---",
      `Made by a code-flow team (${this.findPattern(run.pattern)?.name ?? run.pattern}; agents: ${agents}).`,
      run.loop.check ? `Check: \`${run.loop.check}\` — ${run.verdict === "passed" ? "passing" : run.verdict === "failing" ? "failing" : run.checkCantRun ? `can't run here (${run.checkCantRun.reason})` : "not run"}.` : "",
      "",
      run.summary ?? "",
    ].join("\n");
    const { url, caughtUp, note } = await openPullRequest(run.repo, input.branch, input.into, title, body, run.baseRef);
    if (note) this.emit(run, { type: "log", level: "warn", text: note });
    if (caughtUp) {
      this.emit(run, {
        type: "log",
        level: "info",
        text: `Merged origin/${input.into} into ${input.branch} (${caughtUp.slice(0, 8)}): the run started from ${run.baseRef.slice(0, 7)}, which ${input.into} already has as a squash merge, so the pull request shows only this run's changes`,
      });
    }
    run.prs[input.branch] = url;
    this.emit(run, { type: "log", level: "info", text: `Opened pull request ${url}` });
    this.emitRun(run);
    return url;
  }

  /** The branch a result's pull request should go into (see `pullRequestTarget`). */
  async pullRequestTarget(id: string): Promise<string> {
    const run = this.require(id);
    const startedFrom = run.baseLabel === "HEAD" ? await currentBranch(run.repo) : run.baseLabel;
    return pullRequestTarget(run.repo, startedFrom);
  }

  /** Push a result branch to the pull request the run started from (fast-forward only). */
  async pushToPr(id: string, input: { branch: string }) {
    const run = this.require(id);
    if (this.busyRun(run)) throw new Error("Wait for the run to finish before pushing");
    const source = run.source;
    if (source?.kind !== "pr") throw new Error("This run didn't start from a pull request");
    if (source.isCrossRepository) throw new Error("This pull request comes from a fork, so code-flow can't push to it");
    if (!run.worktrees.some((w) => w.branch === input.branch)) throw new Error("That branch doesn't belong to this run");
    const sha = await pushBranch(run.repo, input.branch, source.headRefName!);
    run.prs[input.branch] = source.url;
    this.emit(run, { type: "log", level: "info", text: `Pushed ${input.branch} to ${source.headRefName} (${sha.slice(0, 8)}), updating ${source.url}` });
    this.emitRun(run);
    return { url: source.url, sha };
  }

  /** Post the review council's review as a comment on the pull request the run started from. */
  async postReview(id: string) {
    const run = this.require(id);
    if (!run.review) throw new Error("This run has no review to post");
    if (run.source?.kind !== "pr") throw new Error("This run didn't start from a pull request");
    await commentOnPr(run.repo, String(run.source.number), run.review.markdown);
    run.review.postedTo = run.source.url;
    run.review.postedAt = Date.now();
    this.emit(run, { type: "log", level: "info", text: `Posted the review to ${run.source.url}` });
    this.emitRun(run);
    return run.source.url;
  }

  /**
   * Keep an eye on a branch's open PR: fix failing CI and act on new comments from you (or the
   * people in `allow`), push the fixes, never merge.
   */
  watchPr(id: string, input: { branch: string; agent: AgentId; maxFixes?: number; allow?: string[] }): PrWatch {
    const run = this.require(id);
    const url = run.prs[input.branch];
    if (!url) throw new Error("Open a pull request for this branch first");
    if (!run.worktrees.some((w) => w.branch === input.branch)) throw new Error("That branch doesn't belong to this run");
    const allow = [...new Set((input.allow ?? []).map((a) => a.trim().replace(/^@/, "")).filter(Boolean))];
    const bad = allow.find((a) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(a));
    if (bad) throw new Error(`"${bad}" isn't a GitHub username`);
    const fromSource = run.source?.kind === "pr" && run.source.url === url;
    const watch: PrWatch = {
      branch: input.branch,
      pr: url,
      remoteBranch: fromSource ? run.source!.headRefName! : input.branch,
      agent: input.agent,
      allow: allow.length ? allow : undefined,
      maxFixes: Math.min(10, Math.max(1, Math.round(input.maxFixes ?? 3))),
      fixes: 0,
      state: "watching",
      detail: "Starting to watch",
      fixedHeads: [],
      startedAt: Date.now(),
    };
    run.watches[input.branch] = watch;
    this.emit(run, {
      type: "log",
      level: "info",
      text: `Watching ${url}: failing CI and new comments from you${allow.length ? ` and ${allow.map((a) => `@${a}`).join(", ")}` : ""} go to ${input.agent} (up to ${watch.maxFixes} fixes), and fixes are pushed. code-flow never merges.`,
    });
    this.emitRun(run);
    return watch;
  }

  unwatchPr(id: string, branch: string) {
    const run = this.require(id);
    const watch = run.watches[branch];
    if (!watch) throw new Error("That branch isn't being watched");
    this.updateWatch(id, branch, { state: "stopped", detail: "You stopped watching" });
  }

  /** Runs that have at least one watch, for the PR watcher. */
  watchedRuns(): Run[] {
    return [...this.runs.values()].filter((r) => Object.keys(r.watches).length);
  }

  updateWatch(id: string, branch: string, patch: Partial<PrWatch>) {
    const run = this.require(id);
    const watch = run.watches[branch];
    if (!watch) return;
    const wasNeedsYou = watch.state === "needs-you";
    const before = JSON.stringify({ ...watch, lastPolled: 0 });
    Object.assign(watch, patch);
    if (watch.state === "needs-you" && !wasNeedsYou) {
      run.seen = false;
      this.emit(run, { type: "log", level: "warn", text: `PR watch needs you: ${watch.detail}` });
    }
    // A poll that found nothing new isn't worth a run snapshot (one a minute per open PR).
    if (JSON.stringify({ ...watch, lastPolled: 0 }) !== before) this.emitRun(run);
  }

  log(id: string, text: string, level: "info" | "warn" = "info") {
    this.emit(this.require(id), { type: "log", level, text });
  }

  private readonly waiters = new Map<string, (answer: ApprovalAnswer) => void>();
  /** Turns that take input while they run, by run and step: where notes can go right away. */
  private readonly steerers = new Map<string, Map<string, { agent: AgentId; steer: (text: string) => Promise<boolean> }>>();
  /** Latest plan-usage signal per vendor (Claude reports windows; others only "limited"). */
  readonly quota: Partial<Record<AgentId, { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number }>> = {};
  /** "Run app" dev servers, keyed `${runId}/${worktree}`. */
  readonly devServers = new DevServers();

  recordQuota(agent: AgentId, status: string, windows: Record<string, { utilization?: number; resetsAt?: number }>) {
    this.quota[agent] = { status, windows, at: Date.now() };
    this.saveQuota();
  }

  /**
   * A plan ran out of usage: limited until `resetsAt` when the CLI said. Otherwise the reset times
   * already known (Claude's windows) still say when it ends, so they're kept rather than replaced
   * by nothing — which "Auto" would read as "an hour".
   */
  recordLimit(agent: AgentId, resetsAt?: number) {
    const now = Date.now();
    const known = Object.fromEntries(Object.entries(this.quota[agent]?.windows ?? {}).filter(([, w]) => !!w.resetsAt && w.resetsAt > now));
    this.recordQuota(agent, "limited", resetsAt ? { limit: { resetsAt } } : known);
  }

  private quotaSave?: ReturnType<typeof setTimeout>;
  /** Kept on disk so a restart doesn't forget a plan that's out of usage. */
  private saveQuota() {
    if (this.quotaSave) return;
    this.quotaSave = setTimeout(() => {
      this.quotaSave = undefined;
      // Written whole and renamed into place: a crash mid-write can't leave half a file.
      const tmp = `${QUOTA_FILE}.${process.pid}.tmp`;
      void mkdir(CODEFLOW_HOME, { recursive: true })
        .then(() => writeFile(tmp, JSON.stringify(this.quota)))
        .then(() => rename(tmp, QUOTA_FILE))
        .catch((err: Error) => logWarn("Couldn't save quota.json", { error: err.message }));
    }, 1_000);
    this.quotaSave.unref?.();
  }

  private async loadQuota() {
    try {
      const saved = JSON.parse(await readFile(QUOTA_FILE, "utf8"));
      for (const [agent, q] of Object.entries(saved ?? {})) {
        if (agent in adapters && q && typeof q === "object" && !(agent in this.quota)) this.quota[agent as AgentId] = q as never;
      }
    } catch {
      // nothing saved yet
    }
  }

  /** Resolves when the user answers the run's checkpoint; rejects if the run is stopped. */
  waitForAnswer(id: string, signal: AbortSignal): Promise<ApprovalAnswer> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CancelledError());
      const onAbort = () => {
        this.waiters.delete(id);
        reject(new CancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(id, (answer) => {
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(id);
        resolve(answer);
      });
    });
  }

  /** Your answer to a checkpoint: approve, ask for changes (with a note), or reject. */
  answer(id: string, answer: ApprovalAnswer) {
    const run = this.require(id);
    const waiter = this.waiters.get(id);
    if (!run.awaiting || !waiter) throw new Error("This run isn't waiting for a decision");
    if (answer.decision === "revise" && !answer.note?.trim()) throw new Error("Say what should change");
    waiter({ decision: answer.decision, note: answer.note?.trim() || undefined });
  }

  /**
   * Send a message to the running team: into the running turn of `agent` (or of anyone) when that
   * turn takes input, otherwise queued for its next turn.
   */
  addNote(id: string, text: string, agent?: AgentId): Note {
    const run = this.require(id);
    if (run.status !== "running") throw new Error("The run has finished — use Reply instead");
    if (!text.trim()) throw new Error("Write a message");
    const note: Note = { id: `n${run.notes.length + 1}`, text: text.trim(), agent, status: "queued", at: Date.now() };
    run.notes.push(note);
    this.deliverMidTurn(run);
    if (note.status === "queued") this.emit(run, { type: "log", level: "info", text: `Message queued for ${agent ?? "the next agent"}: ${note.text}` });
    this.emitRun(run);
    return note;
  }

  /** A step's turn started (or stopped) taking input while it runs. */
  setSteerer(run: Run, stepId: string, agent: AgentId, steer: ((text: string) => Promise<boolean>) | undefined) {
    let live = this.steerers.get(run.id);
    if (steer) {
      if (!live) this.steerers.set(run.id, (live = new Map()));
      live.set(stepId, { agent, steer });
      this.deliverMidTurn(run); // notes sent while the turn was starting
    } else if (live?.delete(stepId) && !live.size) {
      this.steerers.delete(run.id);
    }
  }

  /** Notes handed to a step that didn't finish (failed, stopped) go back in the queue for the next turn. */
  requeueNotes(run: Run, stepId: string) {
    let changed = false;
    for (const note of run.notes) {
      if (note.status !== "delivered" || note.deliveredTo?.stepId !== stepId) continue;
      note.status = "queued";
      note.deliveredTo = undefined;
      changed = true;
    }
    if (!changed) return;
    this.deliverMidTurn(run);
    this.emitRun(run);
  }

  /**
   * Queued notes go into a running turn that takes input and is the note's agent's (or anyone's,
   * for an untargeted note). They're marked delivered before the turn confirms, so a turn that
   * starts meanwhile can't take them too; if the turn ended first they're queued again.
   */
  private deliverMidTurn(run: Run) {
    const live = this.steerers.get(run.id);
    if (!live) return;
    let changed = false;
    for (const note of run.notes) {
      if (note.status !== "queued") continue;
      const target = [...live].find(([, s]) => !note.agent || note.agent === s.agent);
      if (!target) continue;
      const [stepId, { agent, steer }] = target;
      note.status = "delivered";
      note.deliveredTo = { stepId, agent, midTurn: true };
      changed = true;
      void steer(noteMessage([note.text], true)).then((ok) => {
        if (ok) {
          this.emit(run, { type: "agent", stepId, event: { kind: "status", text: `Your message reached this turn: ${note.text}` } });
          this.emit(run, { type: "log", level: "info", text: `Message delivered to ${agent} mid-turn: ${note.text}` });
        } else {
          if (this.steerers.get(run.id)?.get(stepId)?.steer === steer) this.setSteerer(run, stepId, agent, undefined);
          if (note.deliveredTo?.stepId === stepId && note.deliveredTo.midTurn) {
            note.status = "queued";
            note.deliveredTo = undefined;
            this.deliverMidTurn(run);
            if (note.status === "queued") this.emit(run, { type: "log", level: "info", text: `Message queued for ${note.agent ?? "the next agent"}: ${note.text}` });
          }
        }
        this.emitRun(run);
      });
    }
    if (changed) this.emitRun(run);
  }

  private require(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    return run;
  }

  /**
   * The minute the run starts plus random hex, checked against every known run, log and worktree
   * folder: a sweep starts many runs in the same minute, and two must never share a log.
   */
  private newRunId(repo: string): string {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
    for (;;) {
      const id = `${stamp}-${randomBytes(4).toString("hex")}`;
      const taken =
        this.runs.has(id) || existsSync(join(RUNS_DIR, `${id}.jsonl`)) || existsSync(join(RUNS_DIR, `${id}.journal.jsonl`)) || existsSync(join(worktreeRoot(repo), id));
      if (!taken) return id;
    }
  }

  async start(input: StartRunInput): Promise<Run> {
    // .codeflow/config.json supplies defaults; anything the request sets explicitly wins.
    const { config } = await readRepoConfig(await repoRoot(input.repo).catch(() => input.repo));
    const given = input.loop ?? {};
    const loop: LoopSettings = {
      ...DEFAULT_LOOP,
      ...Object.fromEntries(
        Object.entries({ maxMinutes: config.limits?.maxMinutes, maxSteps: config.limits?.maxSteps, copy: config.copy }).filter(([, v]) => v !== undefined),
      ),
      ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined && v !== "")),
    };
    if (given.check === undefined) loop.check = config.check;
    if (given.setup === undefined) loop.setup = config.setup;
    loop.check = loop.check?.trim() || undefined;
    loop.setup = loop.setup?.trim() || undefined;
    // Budgets are positive numbers; anything else (0, "abc", a negative) falls back to the default.
    // Very long ones are clamped where the timers are set.
    loop.maxMinutes = positive(loop.maxMinutes) ?? DEFAULT_LOOP.maxMinutes;
    loop.maxSteps = Math.max(1, Math.round(positive(loop.maxSteps) ?? DEFAULT_LOOP.maxSteps));
    loop.checkTimeoutMin = positive(loop.checkTimeoutMin) ?? DEFAULT_LOOP.checkTimeoutMin;
    if (input.pattern.requiresCheck && !loop.check) {
      throw new Error(`${input.pattern.name} needs a check command (Settings → Done when), e.g. "npm test"`);
    }
    if (loop.container && !(await commandExists("docker"))) {
      throw new Error("Isolation runs checks in a Docker container, but Docker isn't installed or not on PATH");
    }
    const repo = await repoRoot(input.repo);
    // A PR's own branch is the base; its changes are reviewed against the PR's target.
    const fromGitHub = input.source ? await loadSource(repo, input.source) : undefined;
    const baseLabel = fromGitHub?.branch ?? (input.baseRef?.trim() || "HEAD");
    const baseRef = await resolveCommit(repo, baseLabel).catch(() => {
      throw new Error(`Base branch "${baseLabel}" not found in ${repo}`);
    });
    const source = fromGitHub?.source;
    const reviewBase = source?.kind === "pr" ? await mergeBase(repo, `origin/${source.baseRefName}`, baseRef) : undefined;

    // Text from outside the repo's maintainers can carry instructions aimed at the agents, and
    // its code (a fork's PR) runs when the check does. Lock the run down: Safe mode, no .env
    // files copied in, and checks in a container without network — or on this machine only if
    // you said so.
    let trust: Trust = input.trust ?? config.trust ?? "standard";
    let lockdown: string | undefined;
    let lockdownOnHost: boolean | undefined;
    if (source && source.trusted === false) {
      const who = source.author ? `@${source.author}` : "someone the repository doesn't know";
      const relation = source.isCrossRepository ? "from a fork" : `who isn't one of its maintainers (${(source.association ?? "unknown").toLowerCase()})`;
      lockdown = `${source.kind === "issue" ? "Issue" : source.kind === "pr" ? "Pull request" : "Alert"} #${source.number} comes from ${who}, ${relation}`;
      trust = "safe";
      loop.copy = undefined;
      if (loop.container) {
        // Whoever configured the container (an automation, the composer) may have allowed network;
        // a locked-down run's checks never get it.
        loop.container = { ...loop.container, network: false };
      } else if (await commandExists("docker")) {
        // Even without a check: a pattern can run commands of its own (test-first runs the
        // tester's test command), and every command code-flow runs for this run goes in it.
        loop.container = { image: config.image ?? "node:22", network: false };
      } else if (input.allowUntrusted) {
        lockdownOnHost = true;
      } else if (loop.check || loop.setup) {
        throw new UntrustedSourceError(lockdown);
      }
    }
    // An untrusted PR's branch can rewrite AGENTS.md too: read conventions from where it started.
    const conventions = await readConventions(repo, lockdown && reviewBase ? reviewBase : baseRef).catch(() => "");
    const learn = config.learn !== false;
    const lessons = learn ? (await recurringLessons(repo).catch(() => [])).map((l) => `${l.problem}${l.file ? ` (${l.file})` : ""}`) : [];
    const id = this.newRunId(repo);
    const branchPrefix = input.branchPrefix?.trim().replace(/^\/+|\/+$/g, "") || `codeflow/${id}`;
    await validateBranchPrefix(repo, branchPrefix);
    await ensureCodeflowExcludes(repo);

    const worktreeDir = join(worktreeRoot(repo), id);
    const context = await prepareContext(repo, baseRef, input.context, join(worktreeDir, STAGE_DIR)).catch(async (err) => {
      await rm(worktreeDir, { recursive: true, force: true });
      throw err;
    });
    // An automation's saved project may have been deleted since: then the repo's project takes its
    // runs. With projects off (projects.json unreadable), runs still start and record none.
    const parent = input.parentRunId ? this.runs.get(input.parentRunId) : undefined;
    const placed = await (this.projects?.available ? this.projects : undefined)?.place(repo, { requested: input.project, parent: parent?.project, lenient: !!input.trigger }).catch(async (err) => {
      await rm(worktreeDir, { recursive: true, force: true });
      throw err;
    });

    const run: Run = {
      id,
      pattern: input.pattern.id,
      task: input.task,
      repo,
      project: placed?.project.id,
      baseRef,
      baseLabel,
      branchPrefix,
      worktreeDir,
      context,
      agentSettings: { ...(config.models ?? {}), ...(input.agentSettings ?? {}) },
      roleSettings: input.roleSettings ?? {},
      trust,
      lockdown,
      lockdownOnHost,
      conventions: conventions || undefined,
      lessons: lessons.length ? lessons : undefined,
      learn,
      group: input.group,
      app: config.run,
      roles: input.roles,
      options: input.options,
      loop,
      usage: { agentSteps: 0, checks: 0 },
      worktrees: [],
      followUps: [],
      notes: [],
      // Nobody is watching an automation: it doesn't pause; you triage the result instead.
      approvals: input.trigger ? {} : input.approvals ?? {},
      trigger: input.trigger,
      parentRunId: input.parentRunId,
      merges: [],
      prs: {},
      source,
      reviewBase,
      watches: {},
      routing: input.routing?.length ? input.routing : undefined,
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
    for (const note of input.routing ?? []) this.emit(run, { type: "log", level: "info", text: note });
    if (placed?.created) this.emit(run, { type: "log", level: "info", text: `No project held ${basename(repo)} yet, so it has one of its own now: “${placed.project.name}”` });
    if (placed?.added) this.emit(run, { type: "log", level: "info", text: `${basename(repo)} is now part of the project “${placed.project.name}”` });
    if (lockdown) {
      const checks = loop.container
        ? `checks run in Docker ${loop.container.network === false ? "without" : "with"} network`
        : loop.check || loop.setup
          ? "checks run on this machine because you allowed it"
          : "";
      this.emit(run, { type: "log", level: "warn", text: `${lockdown}: agents run in Safe mode and files like .env aren't copied in${checks ? `; ${checks}` : ""}.` });
    }
    if (conventions) this.emit(run, { type: "log", level: "info", text: "Agents get the repository's conventions (AGENTS.md, CLAUDE.md…)" });
    if (lessons.length) this.emit(run, { type: "log", level: "info", text: `Agents are told about ${lessons.length} problem(s) reviewers keep finding in this repo` });
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
    if (run.status === "running" || this.starting.has(id)) throw new Error("This run is already running");
    const pattern = this.findPattern(run.pattern);
    if (!pattern) throw new Error(`Unknown pattern "${run.pattern}"`);
    if (!existsSync(run.repo)) throw new Error(`Repository ${run.repo} no longer exists`);

    // Claimed before the first await, so a double click (or a PR watch and you) can't start it twice.
    this.starting.add(id);
    this.stoppedWhileStarting.delete(id);
    try {
      // The last attempt may still be wrapping up (listing its work, the inbox): let it finish.
      await this.active.get(id)?.catch(() => undefined);
      if (this.stoppedWhileStarting.has(id)) return run; // you pressed Stop meanwhile
      return await this.resumeClaimed(run, pattern);
    } finally {
      this.starting.delete(id);
      this.stoppedWhileStarting.delete(id);
    }
  }

  private async resumeClaimed(run: Run, pattern: Pattern): Promise<Run> {
    const id = run.id;
    if (!this.history.has(id)) this.history.set(id, await this.events(id));
    const journal = await loadJournal(id);
    requeueNotes(run);
    // The pattern already finished: only the follow-ups run. Replaying the whole pattern would
    // redo any step whose code changed since (a code-flow update) for nothing.
    const followUpsOnly = !!run.patternDone;
    run.status = "running";
    run.error = undefined;
    run.stopReason = undefined;
    run.summary = undefined;
    run.verdict = undefined;
    // Replaying the pattern settles it again; follow-ups alone keep what the run found.
    if (!followUpsOnly) run.checkCantRun = undefined;
    run.endedAt = undefined;
    run.seen = false;
    run.archived = false;
    run.resumes = (run.resumes ?? 0) + 1;
    run.artifacts = run.artifacts.filter((a) => !a.label.startsWith("Work so far"));
    this.emitRun(run);
    if (!followUpsOnly) {
      this.emit(run, {
        type: "log",
        level: "info",
        text: journal.size
          ? `Resuming: replaying ${journal.size} recorded results, then continuing with a fresh budget`
          : "Resuming from the start: no completed steps were recorded (existing worktrees are reused)",
      });
    }
    this.execute(run, pattern, journal, followUpsOnly);
    return run;
  }

  private execute(run: Run, pattern: Pattern, journal: Map<string, unknown>, followUpsOnly = false) {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const ctx = new TeamContext(run, controller, this, journal, followUpsOnly);
    ctx.startClock(run.loop.maxMinutes);

    const patternDone = followUpsOnly
      ? Promise.resolve(run.patternSummary ?? withoutFollowUps(run.summary ?? ""))
      : pattern.run(ctx).then((summary) => {
          run.patternDone = true;
          run.patternSummary = summary;
          return summary;
        });
    const done = patternDone
      .then(async (summary) => {
        run.summary = summary;
        await runFollowUps(ctx, run);
        run.status = "done";
      })
      .catch((err: Error) => {
        const aborted = controller.signal.aborted || err instanceof CancelledError;
        if (err instanceof RejectedError) {
          run.status = "cancelled";
          run.error = err.message;
        } else if (aborted && this.shuttingDown && !run.stopReason) {
          run.status = "interrupted";
          run.error = "code-flow was shut down while this run was in progress. Resume to continue.";
        } else {
          run.status = run.stopReason ? "stopped" : aborted ? "cancelled" : "failed";
          run.error = run.stopReason ? `Stopped at the ${run.stopReason}.` : err.message;
        }
      })
      .then(() => (run.status === "done" || run.status === "interrupted" ? undefined : collectUnfinishedWork(run)))
      .catch(() => undefined)
      .then(() => (run.trigger ? this.toInbox(run) : undefined))
      .catch(() => undefined)
      .finally(() => {
        ctx.stopClock();
        // The controller is this execution's token: if the run was resumed meanwhile, the new
        // execution owns its controller, history and timestamps, and this one leaves them alone.
        if (this.controllers.get(run.id) !== controller) return;
        run.awaiting = undefined;
        run.endedAt = Date.now();
        run.seen = run.status === "cancelled" || run.triage?.state === "empty"; // nothing to review
        this.controllers.delete(run.id);
        this.active.delete(run.id);
        this.emitRun(run);
        // Finished runs don't keep their event history in memory; it's read back from disk.
        this.history.delete(run.id);
      });
    this.active.set(run.id, done);
  }

  /**
   * An automation finished: results wait in the inbox for you to approve, revise or reject. A
   * run that changed nothing is archived (worktrees and branches removed) so the inbox stays
   * about real work. Nothing is ever merged automatically.
   */
  private async toInbox(run: Run) {
    if (run.status === "cancelled" || run.status === "interrupted") return;
    if (run.triage && run.triage.state !== "pending") return; // you already decided
    // A check that can't run is news even when nothing changed: you need to set it up. A run
    // with no result branches (a design-only debate) has its result in the summary.
    const empty = run.status === "done" && !run.review && !run.checkCantRun && run.artifacts.length > 0 && (await unchanged(run));
    if (empty) {
      run.triage = { state: "empty", at: Date.now() };
      run.archived = true;
      const removed = await removeWorktrees(run.repo, run.worktrees, true).catch((err: Error) => ({ removed: [], deletedBranches: [], failed: [err.message] }));
      const clean = !removed.failed.length;
      this.emit(run, { type: "log", level: clean ? "info" : "warn", text: `No changes, so the run was archived${clean ? " and its worktrees and branches removed" : `; couldn't remove: ${removed.failed.join("; ")}`}` });
      return;
    }
    run.triage = { state: "pending", at: Date.now(), note: run.triage?.note };
  }

  /**
   * Your decision on an automation's or sweep's result. Approving never merges; it can open a
   * PR, or push to the PR the run started from (a Dependabot PR, say).
   */
  async triage(id: string, input: { decision: "approve" | "revise" | "reject"; note?: string; openPr?: boolean; pushPr?: boolean }) {
    const run = this.require(id);
    if (!run.trigger) throw new Error("Only automation and sweep runs go through the inbox");
    if (this.busyRun(run)) throw new Error("Wait for the run to finish");
    if (input.decision === "revise") {
      const note = input.note?.trim();
      if (!note) throw new Error("Say what should change");
      const artifact = run.artifacts.find((a) => a.stat?.trim()) ?? run.artifacts[0];
      const wt = run.worktrees.find((w) => w.branch === artifact?.branch) ?? run.worktrees[0];
      if (!wt) throw new Error("This run has no worktree to revise");
      const writer = [...run.steps].reverse().find((s) => s.kind === "agent" && s.worktree === wt.name && s.mode === "write")?.agent;
      const agent = writer ?? Object.values(run.roles).flat()[0]!;
      run.triage = { state: "pending", at: Date.now(), note };
      if (run.status !== "done") {
        // A failed or stopped run continues first; the reply is queued behind it.
        run.followUps.push({ id: `f${run.followUps.length + 1}`, kind: "reply", worktree: wt.name, agent, message: note, status: "pending", at: Date.now() });
        return this.resume(id);
      }
      return this.followUp(id, { kind: "reply", worktree: wt.name, agent, message: note });
    }
    if (input.decision === "reject") {
      run.triage = { state: "rejected", at: Date.now(), note: input.note?.trim() || undefined };
      await this.archive(id, { cleanup: true, deleteBranches: true });
      return run;
    }
    let pr: string | undefined;
    if (input.pushPr) {
      const artifact = run.artifacts.find((a) => a.stat?.trim());
      if (!artifact) throw new Error("There's no change to push");
      pr = (await this.pushToPr(id, { branch: artifact.branch })).url;
    } else if (input.openPr) {
      const artifact = run.artifacts.find((a) => a.stat?.trim());
      if (!artifact) throw new Error("There's no change to open a pull request for");
      pr = await this.pullRequest(id, { branch: artifact.branch, into: await this.pullRequestTarget(id) });
    }
    run.triage = { state: "approved", at: Date.now(), note: input.note?.trim() || undefined };
    run.seen = true;
    this.emit(run, { type: "log", level: "info", text: `You approved the result${pr ? (input.pushPr ? ` and pushed it to ${pr}` : ` and opened ${pr}`) : ""}` });
    this.emitRun(run);
    return run;
  }

  /** Stop every running run as "interrupted" (resumable) and make sure the logs are on disk. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.shuttingDown = true;
    this.devServers.stopAll();
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
    // A finished run's last snapshot is synced: after a power cut it must not reload as running.
    appendLine(`${run.id}.jsonl`, event, { sync: event.type === "run" && event.run.status !== "running" });
  }
}

/** Work the user sent back after the run: each follow-up is one agent turn, then the check. */
async function runFollowUps(ctx: TeamContext, run: Run) {
  for (const f of run.followUps) {
    if (f.status !== "pending") continue;
    try {
      await runFollowUp(ctx, run, f);
    } catch (err) {
      // One follow-up going wrong (its worktree is gone, git failed) doesn't undo a finished run;
      // stopping or cancelling still ends it.
      if (ctx.signal.aborted || err instanceof CancelledError) throw err;
      f.status = "failed";
      f.result = (err as Error).message;
      ctx.log(`Follow-up ${f.id} couldn't run: ${f.result}`, "warn");
      const watch = f.watch ? run.watches[f.watch] : undefined;
      if (watch?.state === "fixing") {
        Object.assign(watch, { state: "needs-you", detail: `The fix couldn't run: ${f.result}` });
        run.seen = false;
      }
      ctx.publish();
    }
  }
  // The latest follow-up's check is the current truth about the result, and the summary
  // should say what happened after the run.
  const lastChecked = [...run.followUps].reverse().find((f) => f.status === "done" && f.checkPassed !== undefined);
  if (lastChecked) ctx.setVerdict(lastChecked.checkPassed ? "passed" : "failing");
  const finished = run.followUps.filter((f) => f.status !== "pending");
  if (finished.length) {
    run.summary += `\n\n## Follow-ups\n${finished
      .map((f) => {
        const what =
          f.kind === "resolve-conflicts"
            ? `resolved conflicts with \`${f.mergeFrom}\``
            : f.kind === "reply"
              ? "followed up on your reply"
              : f.kind === "ci-fix"
                ? "fixed failing CI"
                : f.from
                  ? `addressed comments from ${f.from}`
                  : "addressed your review comments";
        const pushed = f.pushed ? `, pushed to ${f.push}` : f.pushError ? ` (not pushed: ${f.pushError})` : "";
        const check = f.checkPassed === undefined ? "" : f.checkPassed ? " — check passes" : " — check still fails";
        const tests = f.integrity?.length ? ` — ⚠ changed tests (${f.integrity.map((i) => i.detail).join("; ")})` : "";
        return `- ${f.agent} ${f.status === "done" ? what : "couldn't finish"} in ${f.worktree}${pushed}${check}${tests}`;
      })
      .join("\n")}`;
  }
}

async function runFollowUp(ctx: TeamContext, run: Run, f: FollowUp) {
  const wt = await ctx.worktree(f.worktree);
  const before = await ctx.remember("head", `before ${f.id}`, () => resolveCommit(wt.path));
  if (f.kind === "resolve-conflicts" && f.mergeFrom) {
    // code-flow starts the merge; the agent only resolves the conflict markers.
    await ctx.remember("merge-start", `${f.id}|${f.mergeFrom}`, () => mergeBranch(wt, f.mergeFrom!));
  }
  // Continue the agent's own session in this worktree when it has one — from a turn that worked:
  // a failed or stopped turn's session may never have existed, or may be gone.
  const previous = [...run.steps].reverse().find((s) => s.kind === "agent" && s.agent === f.agent && s.worktree === f.worktree && s.status === "done" && s.sessionId);
  const outcome = await ctx.ask({
    title:
      f.kind === "resolve-conflicts"
        ? `Resolve conflicts with ${f.mergeFrom}`
        : f.kind === "reply"
          ? "Your reply"
          : f.kind === "ci-fix"
            ? "Fix failing CI"
            : f.from
              ? "Address PR comments"
              : "Address review comments",
    // Titles repeat (a second reply); the follow-up's id keeps each one its own step on resume.
    identity: `follow-up ${f.id}`,
    role: "follow-up",
    agent: f.agent,
    mode: "write",
    cwd: wt,
    allowFailure: true,
    trust: f.trust,
    resume: previous ? { ok: true, finalText: previous.finalText ?? "", sessionId: previous.sessionId, stepId: previous.id, agent: f.agent } : undefined,
    prompt:
      (previous ? "" : `You are working in a git worktree for this task:\n${ctx.task}\n\n`) +
      (f.kind === "resolve-conflicts"
        ? `code-flow merged \`${f.mergeFrom}\` into this branch and it has conflicts. Resolve every conflict so both sides' intent is kept, ` +
          "remove all conflict markers, make sure it builds, and summarize. Don't run git merge --abort or commit."
        : f.kind === "reply"
          ? `The user replied to your work:\n\n${f.message}\n\nDo what they ask (or answer their question), run the relevant tests if you change code, and summarize. Don't commit; code-flow does.`
          : f.kind === "ci-fix"
            ? `CI fails on the pull request for this branch.\n\n${f.message}\n\nFind and fix the cause in the code — don't disable, skip or weaken tests or CI steps. ` +
              "Run what you can locally to confirm, then summarize. Don't commit or push; code-flow does."
            : `${f.from ? `${f.from} left these comments` : "The user reviewed your changes and left these comments"}:\n\n${f.message}\n\n` +
              "Address each one, run the relevant tests, and summarize what you changed. Don't commit; code-flow does."),
  });
  const sha = await ctx.commit(
    wt,
    f.kind === "resolve-conflicts"
      ? `Merge ${f.mergeFrom} (conflicts resolved by ${f.agent})`
      : f.kind === "reply"
        ? `${f.agent}: follow-up to your reply (${f.id})`
        : f.kind === "ci-fix"
          ? `${f.agent}: fix failing CI (${f.id})`
          : `${f.agent}: address review comments (${f.id})`,
  );
  // A merge brings in someone else's test changes; anything else is this agent's.
  const issues = sha && f.kind !== "resolve-conflicts" ? await ctx.testChanges(wt, before) : [];
  f.integrity = issues.length ? issues : undefined;
  if (issues.length) ctx.log(`Follow-up ${f.id} (${f.agent}) changed tests:\n${describeIssues(issues)}`, "warn");
  const check = await ctx.check(wt, `Check after follow-up ${f.id}`);
  f.status = outcome.ok ? "done" : "failed";
  f.result = outcome.ok ? outcome.finalText : outcome.error;
  f.checkPassed = check ? check.ok : undefined;
  // Nobody reviews an unattended fix before it's pushed, so one that weakens tests isn't pushed.
  const blocked = !!f.watch && issues.some((i) => i.severity === "high");
  if (blocked) f.pushError = "it changes tests in ways that could hide the failure";
  if (f.push && outcome.ok && sha && !blocked) {
    try {
      f.pushed = await ctx.remember("push", `${f.id}|${f.push}`, () => pushBranch(run.repo, wt.branch, f.push!));
      ctx.log(`Pushed ${f.pushed.slice(0, 8)} to ${f.push}`);
    } catch (err) {
      f.pushError = (err as Error).message;
      ctx.log(`Couldn't push: ${f.pushError}`, "warn");
    }
  }
  const watch = f.watch ? run.watches[f.watch] : undefined;
  if (watch?.state === "fixing") {
    const ok = outcome.ok && sha && f.pushed;
    Object.assign(watch, {
      state: ok ? "watching" : "needs-you",
      detail: ok
        ? `Pushed a fix (${sha!.slice(0, 8)}); waiting for CI`
        : !outcome.ok
          ? `${f.agent} couldn't finish the fix`
          : !sha
            ? `${f.agent} didn't change anything`
            : blocked
              ? `${f.agent}'s fix changes tests (${issues.map((i) => i.detail).join("; ")}); not pushed — review it`
              : `Couldn't push: ${f.pushError}`,
    });
    if (!ok) run.seen = false;
  }
  const artifact = run.artifacts.find((a) => a.branch === wt.branch);
  if (artifact) await ctx.artifact(artifact.label, wt);
  ctx.publish();
}

/**
 * True only when git confirms that no result branch differs from the run's base. Anything git
 * can't answer counts as changed: a run is never cleaned up (worktrees and branches deleted)
 * because of an error.
 */
async function unchanged(run: Run): Promise<boolean> {
  for (const a of run.artifacts) {
    if (a.stat?.trim()) return false;
    if ((await git(["diff", "--quiet", run.baseRef, a.branch, "--"], run.repo)).code !== 0) return false;
  }
  return true;
}

/** When a run doesn't finish, list each worktree that holds work so you can still use it. */
async function collectUnfinishedWork(run: Run) {
  const listed = new Set(run.artifacts.map((a) => a.branch));
  for (const wt of run.worktrees) {
    if (listed.has(wt.branch)) continue;
    // Listed when git can't say, too: better a "Work so far" that's empty than work you can't find.
    const unreadable = "(couldn't read its changes)";
    const stat = await diffStat({ ...wt, base: run.baseRef }, run.baseRef).catch(() => (existsSync(wt.path) ? unreadable : ""));
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
    // Runs saved before patternDone existed: a finished run's pattern finished.
    patternDone: legacy.patternDone ?? (legacy.status === "done" ? true : undefined),
    patternSummary: legacy.patternSummary ?? (legacy.status === "done" && legacy.summary ? withoutFollowUps(legacy.summary) : undefined),
    worktrees: legacy.worktrees ?? [],
    baseLabel: legacy.baseLabel ?? "HEAD",
    branchPrefix: legacy.branchPrefix ?? `codeflow/${legacy.id}`,
    worktreeDir: legacy.worktreeDir ?? join(worktreeRoot(legacy.repo), legacy.id),
    followUps: legacy.followUps ?? [],
    notes: legacy.notes ?? [],
    roleSettings: legacy.roleSettings ?? {},
    trust: legacy.trust ?? "standard",
    approvals: legacy.approvals ?? {},
    merges: legacy.merges ?? [],
    prs: legacy.prs ?? {},
    watches: legacy.watches ?? {},
    seen: legacy.seen ?? true,
    archived: legacy.archived ?? false,
    artifacts: legacy.artifacts ?? [],
    steps: [...steps.values()],
  };
}

function strip(run: Run): RunSummary {
  const { steps: _steps, ...rest } = run;
  // A copy: the snapshot in the event history must not change as the run goes on.
  return structuredClone(rest);
}

/** The summary as the pattern wrote it, without the follow-ups section added after it. */
function withoutFollowUps(summary: string): string {
  return summary.split("\n\n## Follow-ups\n")[0]!;
}

/**
 * Notes handed to a turn that never finished (interrupted, cancelled) go to the next one instead.
 * (A turn that failed gave its notes back as it ended; see `RunManager.requeueNotes`.)
 */
function requeueNotes(run: Run) {
  const unfinished = new Set(run.steps.filter((s) => s.status === "interrupted" || s.status === "cancelled" || s.status === "running").map((s) => s.id));
  for (const note of run.notes) {
    if (note.status === "delivered" && note.deliveredTo && unfinished.has(note.deliveredTo.stepId)) {
      note.status = "queued";
      note.deliveredTo = undefined;
    }
  }
}

/** The source of a run is untrusted and Docker isn't available to run its checks safely. */
export class UntrustedSourceError extends Error {
  readonly code = "untrusted-source";
  constructor(readonly lockdown: string) {
    super(
      `${lockdown}. Its tests would run that person's code on this machine. Install Docker so code-flow can run checks in a container, ` +
        "or confirm that you want to run them here anyway (agents are still limited to Safe mode).",
    );
  }
}

/** The branch checked out in `repo`, if any (not a detached HEAD). */
async function currentBranch(repo: string): Promise<string | undefined> {
  const res = await git(["symbolic-ref", "--short", "HEAD"], repo);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/** A positive number from a setting (a number, or a string a config file held), else undefined. */
function positive(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `fn` over `items`, at most `limit` at a time; results in order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The file in a worktree's private git dir (never in the files agents see) that says it's set up. */
async function preparedMarker(wt: Worktree): Promise<string | undefined> {
  const res = await git(["rev-parse", "--git-dir"], wt.path);
  const dir = res.stdout.trim();
  return res.code === 0 && dir ? join(resolve(wt.path, dir), "codeflow-prepared") : undefined;
}

async function isPrepared(wt: Worktree): Promise<boolean> {
  const marker = await preparedMarker(wt);
  return !!marker && existsSync(marker);
}
