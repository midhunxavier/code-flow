import { EventEmitter } from "node:events";
import { appendFile, cp, mkdir, rm } from "node:fs/promises";
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
import { CODEFLOW_HOME, MAX_DIFF_CHARS, STEP_TIMEOUT_MS } from "./config.js";
import { runCheck, type CheckResult } from "./checks.js";
import { contextPrompt, hasStagedFiles, prepareContext, type ContextInput, type RunContext } from "./context.js";
import {
  CONTEXT_DIR,
  commitAll,
  createWorktree,
  diffSince,
  diffStat,
  discardChanges,
  ensureCodeflowExcludes,
  isClean,
  repoRoot,
  resolveCommit,
  uncommittedCount,
  validateBranchPrefix,
  worktreeRoot,
  type Worktree,
} from "./git.js";

/** Per-run staging folder (inside the run's worktree folder) for context files. */
const STAGE_DIR = ".context";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/** "stopped" = ended by a budget (time or step limit), not by the user or an error. */
export type Status = "running" | "done" | "failed" | "cancelled" | "stopped";

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
  status: Status;
  createdAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  steps: Step[];
  artifacts: Artifact[];
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
  | { type: "run"; run: Omit<Run, "steps"> }
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
  /** Runs the team; returns a markdown summary. */
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

  constructor(
    readonly run: Run,
    private readonly controller: AbortController,
    private readonly manager: RunManager,
  ) {
    this.signal = controller.signal;
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

  /** Record whether the final result passes its check (shown in the result header). */
  setVerdict(verdict: "passed" | "failing") {
    this.run.verdict = verdict;
  }

  /**
   * Run the "done when" check in a worktree — code-flow runs it, not an agent, so the result
   * can be trusted. Returns null when no check is configured.
   */
  async check(wt: Worktree, title = "Check", command = this.run.loop.check): Promise<CheckResult | null> {
    if (!command) return null;
    const result = await this.command("check", title, wt, command);
    this.run.usage.checks++;
    this.run.lastCheck = { ok: result.ok, command, worktree: wt.name, at: Date.now() };
    this.manager.emitRun(this.run);
    return result;
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
    step.status = this.signal.aborted ? "cancelled" : result.ok ? "done" : "failed";
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
    this.manager.emit(this.run, { type: "log", level, text });
  }

  checkCancelled() {
    if (this.signal.aborted) throw new CancelledError();
  }

  async worktree(name: string, fromRef = this.run.baseRef): Promise<Worktree> {
    this.checkCancelled();
    const wt = await createWorktree(
      this.run.repo,
      name,
      join(this.run.worktreeDir, name),
      `${this.run.branchPrefix}/${name}`,
      fromRef,
    );
    this.log(`Created worktree ${wt.path} on branch ${wt.branch}`);
    this.run.worktrees.push({ name: wt.name, branch: wt.branch, path: wt.path });
    if (hasStagedFiles(this.run.context)) {
      // Git-excluded, so it is never committed and doesn't count as a change.
      await cp(join(this.run.worktreeDir, STAGE_DIR), join(wt.path, CONTEXT_DIR), { recursive: true });
    }
    if (this.run.loop.setup) {
      const setup = await this.command("setup", `Setup ${name}`, wt, this.run.loop.setup);
      if (!setup.ok) throw new Error(`Setup command \`${this.run.loop.setup}\` failed in worktree ${name}`);
      // Setup output (e.g. node_modules) should be ignored; anything else it changed is not the agents' work.
      if (!(await isClean(wt.path))) this.log(`Setup left changes in ${name}; they'll appear in its diff`, "warn");
    }
    return wt;
  }

  async commit(wt: Worktree, message: string): Promise<string | null> {
    const sha = await commitAll(wt, message);
    if (sha) this.log(`Committed ${sha.slice(0, 8)} on ${wt.branch}: ${message}`);
    return sha;
  }

  /** Diff of the worktree against its base, truncated to fit in a prompt. */
  async diff(wt: Worktree, base = wt.base): Promise<string> {
    const full = await diffSince(wt, base);
    if (!full.trim()) return "(no changes)";
    return full.length > MAX_DIFF_CHARS
      ? `${full.slice(0, MAX_DIFF_CHARS)}\n… diff truncated (${full.length} chars total); run \`git diff ${base}..HEAD\` to see all of it.`
      : full;
  }

  async artifact(label: string, wt: Worktree) {
    const stat = await diffStat(wt, this.run.baseRef).catch(() => "");
    this.run.artifacts.push({ label, branch: wt.branch, path: wt.path, stat });
    this.manager.emitRun(this.run);
  }

  /** Run one agent turn as a visible step in this run. */
  async ask(params: AskParams): Promise<StepOutcome> {
    this.checkCancelled();
    if (params.resume && params.resume.agent !== params.agent) {
      throw new Error(`Cannot resume a ${params.resume.agent} session with ${params.agent}`);
    }
    if (this.run.usage.agentSteps >= this.run.loop.maxSteps) {
      this.stop(`step limit (${this.run.loop.maxSteps} agent steps)`);
      this.checkCancelled();
    }
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
        signal: this.signal,
        timeoutMs: STEP_TIMEOUT_MS,
      },
      (event) => this.manager.emit(this.run, { type: "agent", stepId: step.id, event }),
    );

    if (guardReadOnly && !(await isClean(params.cwd.path))) {
      await discardChanges(params.cwd.path);
      this.log(`${params.title} (${params.agent}) modified files in read-only mode; changes were reverted`, "warn");
    }

    step.endedAt = Date.now();
    step.sessionId = result.sessionId;
    step.finalText = result.finalText;
    step.error = result.error;
    step.status = this.signal.aborted ? "cancelled" : result.ok ? "done" : "failed";
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
  private readonly bus = new EventEmitter();
  private seq = 0;

  constructor() {
    this.bus.setMaxListeners(0);
  }

  list(): Omit<Run, "steps">[] {
    return [...this.runs.values()].map(strip).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  events(id: string): RunEvent[] {
    return this.history.get(id) ?? [];
  }

  subscribe(id: string, listener: (e: RunEvent) => void): () => void {
    this.bus.on(id, listener);
    return () => this.bus.off(id, listener);
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
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
      status: "running",
      createdAt: Date.now(),
      steps: [],
      artifacts: [],
    };
    const controller = new AbortController();
    this.runs.set(run.id, run);
    this.history.set(run.id, []);
    this.controllers.set(run.id, controller);
    this.emitRun(run);

    const ctx = new TeamContext(run, controller, this);
    const timeBudget = setTimeout(() => ctx.stop(`time limit (${loop.maxMinutes} min)`), loop.maxMinutes * 60_000);
    timeBudget.unref?.();

    void input.pattern
      .run(ctx)
      .then((summary) => {
        run.summary = summary;
        run.status = "done";
      })
      .catch((err: Error) => {
        const aborted = controller.signal.aborted || err instanceof CancelledError;
        run.status = run.stopReason ? "stopped" : aborted ? "cancelled" : "failed";
        run.error = run.stopReason ? `Stopped at the ${run.stopReason}.` : err.message;
      })
      .then(() => (run.status === "done" ? undefined : collectUnfinishedWork(run)))
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeBudget);
        run.endedAt = Date.now();
        this.controllers.delete(run.id);
        this.emitRun(run);
      });

    return run;
  }

  emitRun(run: Run) {
    this.emit(run, { type: "run", run: strip(run) });
  }

  emit(run: Run, body: RunEventBody) {
    const event = { seq: ++this.seq, ts: Date.now(), runId: run.id, ...body } as RunEvent;
    this.history.get(run.id)?.push(event);
    this.bus.emit(run.id, event);
    void persist(event);
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

function strip(run: Run): Omit<Run, "steps"> {
  const { steps: _steps, ...rest } = run;
  return { ...rest, artifacts: [...rest.artifacts] };
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

const runsDir = join(CODEFLOW_HOME, "runs");
let writeQueue: Promise<unknown> = mkdir(runsDir, { recursive: true }).catch(() => undefined);

/** Append-only JSONL log per run, for auditing what each agent did. Writes are queued so lines stay in order. */
function persist(event: RunEvent) {
  const line = `${JSON.stringify(event)}\n`;
  writeQueue = writeQueue
    .then(() => appendFile(join(runsDir, `${event.runId}.jsonl`), line))
    .catch(() => undefined); // logging must never break a run
}
