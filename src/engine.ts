import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { adapters, type AccessMode, type AgentEvent, type AgentId, type RunResult } from "./adapters/index.js";
import { CODEFLOW_HOME, MAX_DIFF_CHARS, STEP_TIMEOUT_MS } from "./config.js";
import {
  commitAll,
  createWorktree,
  diffSince,
  diffStat,
  discardChanges,
  isClean,
  repoRoot,
  resolveCommit,
  type Worktree,
} from "./git.js";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type Status = "running" | "done" | "failed" | "cancelled";

export interface Step {
  id: string;
  title: string;
  role: string;
  agent: AgentId;
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
  baseRef: string;
  roles: Record<string, AgentId[]>;
  options: Record<string, number | boolean>;
  status: Status;
  createdAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  steps: Step[];
  artifacts: Artifact[];
}

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
  constructor(
    readonly run: Run,
    readonly signal: AbortSignal,
    private readonly manager: RunManager,
  ) {}

  get task() {
    return this.run.task;
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
    const wt = await createWorktree(this.run.repo, this.run.id, name, fromRef);
    this.log(`Created worktree ${wt.name} on branch ${wt.branch}`);
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
    const step: Step = {
      id: `s${this.run.steps.length + 1}`,
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
  baseRef?: string;
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
    const repo = await repoRoot(input.repo);
    const baseRef = await resolveCommit(repo, input.baseRef || "HEAD");
    const run: Run = {
      id: newRunId(),
      pattern: input.pattern.id,
      task: input.task,
      repo,
      baseRef,
      roles: input.roles,
      options: input.options,
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

    const ctx = new TeamContext(run, controller.signal, this);
    void input.pattern
      .run(ctx)
      .then((summary) => {
        run.summary = summary;
        run.status = "done";
      })
      .catch((err: Error) => {
        run.status = controller.signal.aborted || err instanceof CancelledError ? "cancelled" : "failed";
        run.error = err.message;
      })
      .finally(() => {
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

function strip(run: Run): Omit<Run, "steps"> {
  const { steps: _steps, ...rest } = run;
  return { ...rest, artifacts: [...rest.artifacts] };
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

const runsDir = join(CODEFLOW_HOME, "runs");
let runsDirReady: Promise<unknown> | undefined;

/** Append-only JSONL log per run, for auditing what each agent did. */
async function persist(event: RunEvent) {
  try {
    runsDirReady ??= mkdir(runsDir, { recursive: true });
    await runsDirReady;
    await appendFile(join(runsDir, `${event.runId}.jsonl`), `${JSON.stringify(event)}\n`);
  } catch {
    // Logging must never break a run.
  }
}
