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
import { copyIntoWorktree, readRepoConfig, type Trust } from "./repo-config.js";
import { DevServers } from "./serve.js";
import { commentOnPr, loadSource, mergeBase, pushBranch, sourcePrompt, type RunSource } from "./github.js";

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
  /** Messages you sent while the run was going; delivered at the start of an agent's next turn. */
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
  /** Deliver to this agent's next turn; undefined = whichever agent goes next. */
  agent?: AgentId;
  status: "queued" | "delivered";
  deliveredTo?: { stepId: string; agent: AgentId };
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

/** You rejected a checkpoint (e.g. the plan); the run ends without building. */
export class RejectedError extends Error {}

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

  private clock?: { timer?: ReturnType<typeof setTimeout>; remaining: number; startedAt: number };

  /** Start the run's time budget; it pauses while the run waits for you. */
  startClock(minutes: number) {
    this.clock = { remaining: minutes * 60_000, startedAt: Date.now() };
    this.armClock();
  }
  private armClock() {
    if (!this.clock) return;
    this.clock.startedAt = Date.now();
    this.clock.timer = setTimeout(() => this.stop(`time limit (${this.run.loop.maxMinutes} min)`), this.clock.remaining);
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

  /** Notes you queued for the agent that's about to take a turn. */
  private takeNotes(agent: AgentId, stepId: string): string {
    const due = this.run.notes.filter((n) => n.status === "queued" && (!n.agent || n.agent === agent));
    if (!due.length) return "";
    for (const n of due) {
      n.status = "delivered";
      n.deliveredTo = { stepId, agent };
    }
    this.manager.emitRun(this.run);
    return `## A message from the user\n(Sent while the team was working — take it into account.)\n${due.map((n) => `- ${n.text}`).join("\n")}\n\n`;
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

  /** The user's task plus its source (issue, PR) and attached context — what every agent is given. */
  get task() {
    return this.run.task + sourcePrompt(this.run.source) + contextPrompt(this.run.context);
  }

  /** Record a review council's result (shown as the run's review, postable to the PR). */
  setReview(review: CouncilReview) {
    const posted = this.run.review?.markdown === review.markdown ? this.run.review : undefined;
    this.run.review = { ...review, postedTo: posted?.postedTo, postedAt: posted?.postedAt };
    this.manager.emitRun(this.run);
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
    if (this.run.loop.copy?.length) {
      const copied = await copyIntoWorktree(this.run.repo, wt.path, this.run.loop.copy);
      if (copied.length) this.log(`Copied ${copied.join(", ")} from your checkout into ${name}`);
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
    // Notes are picked up before the step is announced: anything sent after it shows as
    // running goes to the next turn, never into a turn that already started.
    const notes = this.takeNotes(params.agent, step.id);
    this.run.steps.push(step);
    this.manager.emit(this.run, { type: "step", step: { ...step } });

    // Read-only is enforced here for every agent, not just trusted to each CLI's flags.
    const guardReadOnly = params.mode === "read" && (await isClean(params.cwd.path));

    const result = await adapters[params.agent].run(
      {
        prompt: notes + params.prompt,
        cwd: params.cwd.path,
        mode: params.mode,
        resumeSessionId: params.resume?.sessionId,
        model: this.run.roleSettings?.[params.role]?.[params.agent]?.model || this.run.agentSettings[params.agent]?.model,
        effort: this.run.roleSettings?.[params.role]?.[params.agent]?.effort || this.run.agentSettings[params.agent]?.effort,
        jsonSchema: params.schema,
        trust: this.run.trust,
        signal: this.signal,
        timeoutMs: STEP_TIMEOUT_MS,
      },
      (event) => {
        if (event.kind === "session") step.sessionId = event.sessionId;
        if (event.kind === "quota") this.manager.recordQuota(params.agent, event.status, event.windows);
        this.manager.emit(this.run, { type: "agent", stepId: step.id, event });
      },
    );

    if (!result.ok && /rate.?limit|usage limit|quota|too many requests/i.test(result.error ?? "")) {
      this.manager.recordQuota(params.agent, "limited", {});
    }
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
  approvals?: { plan?: boolean };
  parentRunId?: string;
  roleSettings?: Record<string, AgentSettings>;
  trust?: Trust;
  /** Start from a GitHub issue or PR (a PR's branch becomes the base). */
  source?: { kind: "issue" | "pr"; number: number; ciLogs?: boolean };
  /** How "Auto" roles were resolved, for the log. */
  routing?: string[];
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
    this.devServers.stopMatching(`${id}/`);
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
  async followUp(
    id: string,
    input: { kind?: FollowUp["kind"]; worktree: string; agent: AgentId; message?: string; mergeFrom?: string; from?: string; push?: string; watch?: string },
  ) {
    const run = this.require(id);
    if (run.status !== "done") throw new Error("Follow-ups can be sent once the run has finished");
    if (!run.worktrees.some((w) => w.name === input.worktree)) throw new Error(`Unknown worktree "${input.worktree}"`);
    const kind = input.kind ?? "comments";
    if (kind !== "resolve-conflicts" && !input.message?.trim()) throw new Error(kind === "reply" ? "Write a reply" : "Write at least one comment");
    if (kind === "resolve-conflicts" && !input.mergeFrom) throw new Error("Say which branch to merge");
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
      run.source?.kind === "issue" ? `\nCloses #${run.source.number}` : "",
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

  /** Push a result branch to the pull request the run started from (fast-forward only). */
  async pushToPr(id: string, input: { branch: string }) {
    const run = this.require(id);
    if (run.status === "running") throw new Error("Wait for the run to finish before pushing");
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

  /** Keep an eye on a branch's open PR: fix failing CI and collaborators' comments, push, never merge. */
  watchPr(id: string, input: { branch: string; agent: AgentId; maxFixes?: number }): PrWatch {
    const run = this.require(id);
    const url = run.prs[input.branch];
    if (!url) throw new Error("Open a pull request for this branch first");
    if (!run.worktrees.some((w) => w.branch === input.branch)) throw new Error("That branch doesn't belong to this run");
    const fromSource = run.source?.kind === "pr" && run.source.url === url;
    const watch: PrWatch = {
      branch: input.branch,
      pr: url,
      remoteBranch: fromSource ? run.source!.headRefName! : input.branch,
      agent: input.agent,
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
      text: `Watching ${url}: failing CI and new comments from collaborators go to ${input.agent} (up to ${watch.maxFixes} fixes), and fixes are pushed. code-flow never merges.`,
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
    Object.assign(watch, patch);
    if (watch.state === "needs-you" && !wasNeedsYou) {
      run.seen = false;
      this.emit(run, { type: "log", level: "warn", text: `PR watch needs you: ${watch.detail}` });
    }
    this.emitRun(run);
  }

  log(id: string, text: string, level: "info" | "warn" = "info") {
    this.emit(this.require(id), { type: "log", level, text });
  }

  private readonly waiters = new Map<string, (answer: ApprovalAnswer) => void>();
  /** Latest plan-usage signal per vendor (Claude reports windows; others only "limited"). */
  readonly quota: Partial<Record<AgentId, { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number }>> = {};
  /** "Run app" dev servers, keyed `${runId}/${worktree}`. */
  readonly devServers = new DevServers();

  recordQuota(agent: AgentId, status: string, windows: Record<string, { utilization?: number; resetsAt?: number }>) {
    this.quota[agent] = { status, windows, at: Date.now() };
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

  /** Queue a message for the running team; it reaches the next turn of `agent` (or of anyone). */
  addNote(id: string, text: string, agent?: AgentId): Note {
    const run = this.require(id);
    if (run.status !== "running") throw new Error("The run has finished — use Reply instead");
    if (!text.trim()) throw new Error("Write a message");
    const note: Note = { id: `n${run.notes.length + 1}`, text: text.trim(), agent, status: "queued", at: Date.now() };
    run.notes.push(note);
    this.emit(run, { type: "log", level: "info", text: `Message queued for ${agent ?? "the next agent"}: ${note.text}` });
    this.emitRun(run);
    return note;
  }

  private require(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    return run;
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
    if (input.pattern.requiresCheck && !loop.check) {
      throw new Error(`${input.pattern.name} needs a check command (Settings → Done when), e.g. "npm test"`);
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
      agentSettings: { ...(config.models ?? {}), ...(input.agentSettings ?? {}) },
      roleSettings: input.roleSettings ?? {},
      trust: input.trust ?? config.trust ?? "standard",
      app: config.run,
      roles: input.roles,
      options: input.options,
      loop,
      usage: { agentSteps: 0, checks: 0 },
      worktrees: [],
      followUps: [],
      notes: [],
      approvals: input.approvals ?? {},
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
    ctx.startClock(run.loop.maxMinutes);

    const done = pattern
      .run(ctx)
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
      .finally(() => {
        ctx.stopClock();
        run.awaiting = undefined;
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
    const check = await ctx.check(wt, `Check after follow-up ${f.id}`);
    f.status = outcome.ok ? "done" : "failed";
    f.result = outcome.ok ? outcome.finalText : outcome.error;
    f.checkPassed = check ? check.ok : undefined;
    if (f.push && outcome.ok && sha) {
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
              : `Couldn't push: ${f.pushError}`,
      });
      if (!ok) run.seen = false;
    }
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
        const pushed = f.pushed ? `, pushed to ${f.push}` : f.pushError ? " (push failed)" : "";
        const check = f.checkPassed === undefined ? "" : f.checkPassed ? " — check passes" : " — check still fails";
        return `- ${f.agent} ${f.status === "done" ? what : "couldn't finish"} in ${f.worktree}${pushed}${check}`;
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
  return {
    ...rest,
    artifacts: [...rest.artifacts],
    worktrees: [...rest.worktrees],
    followUps: rest.followUps.map((f) => ({ ...f })),
    watches: Object.fromEntries(Object.entries(rest.watches).map(([k, w]) => [k, { ...w }])),
    review: rest.review ? { ...rest.review } : undefined,
  };
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}
