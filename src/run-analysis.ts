import type { Step } from "./engine.js";
import type { TeamState, TeamTask } from "./teams.js";

export interface WorkflowNode { id: string; title: string; owner: string; status: string; layer: number; durationMs?: number; critical: boolean }
export interface WorkflowEdge { from: string; to: string; kind: "completion" | "artifact" | "knowledge" }
export interface WorkflowAnalysis { nodes: WorkflowNode[]; edges: WorkflowEdge[]; layers: string[][]; criticalPath: string[]; measuredCriticalPathMs: number; timedTasks: number; completeTiming: boolean; warnings: string[] }
type TimedStep = Pick<Step, "id" | "startedAt" | "endedAt" | "status" | "kind" | "role" | "coordination" | "taskId">;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function interval(start: unknown, end: unknown): [number, number] | undefined { return finite(start) && finite(end) && end >= start ? [start, end] : undefined; }
function stepInterval(step: TimedStep, now: number) { return interval(step.startedAt, step.status === "running" ? now : step.endedAt); }
function unionMs(intervals: Array<[number, number]>): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0; let start: number | undefined; let end = 0;
  for (const [a, b] of sorted) {
    if (start === undefined) { start = a; end = b; }
    else if (a > end) { total += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  return total + (start === undefined ? 0 : end - start);
}

/** Dependency graph and longest measured chain. Untimed work is explicitly unknown, not estimated. */
export function analyzeWorkflow(team: Pick<TeamState, "tasks">, input: { now?: number; steps?: TimedStep[] } = {}): WorkflowAnalysis {
  const now = input.now ?? Date.now();
  const tasks = new Map<string, TeamTask>(); const warnings: string[] = [];
  for (const task of team.tasks) { if (tasks.has(task.id)) warnings.push(`Duplicate task ID: ${task.id}`); else tasks.set(task.id, task); }
  const edges: WorkflowEdge[] = [];
  const indegree = new Map<string, number>(); const children = new Map<string, string[]>();
  for (const task of tasks.values()) {
    const dependencies = [...new Set(task.dependsOn)];
    indegree.set(task.id, dependencies.filter((id) => tasks.has(id)).length);
    for (const dependency of dependencies) {
      if (!tasks.has(dependency)) { warnings.push(`${task.id} depends on missing task ${dependency}`); continue; }
      edges.push({ from: dependency, to: task.id, kind: task.dependencyTypes?.[dependency] ?? "completion" });
      children.set(dependency, [...(children.get(dependency) ?? []), task.id]);
    }
  }
  const queue = [...tasks.keys()].filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = []; const layer = new Map<string, number>();
  while (queue.length) {
    const id = queue.shift()!; order.push(id);
    layer.set(id, Math.max(0, ...tasks.get(id)!.dependsOn.filter((dep) => layer.has(dep)).map((dep) => layer.get(dep)! + 1)));
    for (const child of children.get(id) ?? []) { indegree.set(child, indegree.get(child)! - 1); if (indegree.get(child) === 0) { queue.push(child); queue.sort(); } }
  }
  if (order.length < tasks.size) warnings.push("Dependencies contain a cycle. Edit the plan before dispatch.");
  const durations = new Map<string, number>();
  for (const task of tasks.values()) {
    const steps = input.steps?.filter((step) => step.taskId === task.id);
    if (steps?.length) {
      const intervals = steps.map((step) => stepInterval(step, now));
      if (intervals.every((value) => value !== undefined)) durations.set(task.id, intervals.reduce((sum, value) => sum + value![1] - value![0], 0));
    } else {
      const observed = interval(task.startedAt, task.status === "running" ? now : task.finishedAt);
      if (observed) durations.set(task.id, observed[1] - observed[0]);
      if ((task.attempts ?? 0) > 1) warnings.push(`${task.id}: task timestamps describe the latest attempt; earlier attempts are not included.`);
    }
  }
  const scores = new Map<string, number>(); const chains = new Map<string, string[]>();
  for (const id of order) {
    const predecessors = tasks.get(id)!.dependsOn.filter((dep) => scores.has(dep)).sort((a, b) => scores.get(b)! - scores.get(a)! || chains.get(b)!.length - chains.get(a)!.length || a.localeCompare(b));
    const previous = predecessors[0];
    scores.set(id, (previous ? scores.get(previous)! : 0) + (durations.get(id) ?? 0));
    chains.set(id, [...(previous ? chains.get(previous)! : []), id]);
  }
  const last = [...order].sort((a, b) => scores.get(b)! - scores.get(a)! || chains.get(b)!.length - chains.get(a)!.length || a.localeCompare(b))[0];
  const criticalPath = last ? chains.get(last)! : [];
  const cycleLayer = Math.max(-1, ...layer.values()) + 1;
  const nodes = [...tasks.values()].map((task): WorkflowNode => ({ id: task.id, title: task.title, owner: task.owner, status: task.status ?? "pending", layer: layer.get(task.id) ?? cycleLayer, ...(durations.has(task.id) ? { durationMs: durations.get(task.id)! } : {}), critical: criticalPath.includes(task.id) }));
  const layers: string[][] = [];
  for (const node of nodes) (layers[node.layer] ??= []).push(node.id);
  return { nodes, edges, layers, criticalPath, measuredCriticalPathMs: last ? scores.get(last)! : 0, timedTasks: durations.size, completeTiming: durations.size === tasks.size && order.length === tasks.size && [...tasks.values()].every((task) => ["completed", "submitted"].includes(task.status ?? "") && !task.evidenceStale), warnings };
}

/** Cumulative process time can overlap. Unattributed elapsed time includes queues and user approvals. */
export function analyzeRunTiming(run: { createdAt: number; endedAt?: number; status: string; team?: TeamState }, steps: TimedStep[], now = Date.now()) {
  const end = run.status === "running" ? now : run.endedAt ?? now;
  const elapsedMs = Math.max(0, end - run.createdAt);
  const unique = [...new Map(steps.map((step) => [step.id, step])).values()];
  const records = unique.flatMap((step) => { const observed = stepInterval(step, end); return observed ? [{ step, observed }] : []; });
  const total = (predicate: (step: TimedStep) => boolean) => records.filter(({ step }) => predicate(step)).reduce((sum, { observed }) => sum + observed[1] - observed[0], 0);
  const occupiedMs = unionMs(records.map(({ observed }) => [Math.max(run.createdAt, observed[0]), Math.min(end, observed[1])] as [number, number]).filter(([start, finish]) => finish >= start));
  const waits = (run.team?.waits ?? []).flatMap((wait) => { const observed = interval(wait.createdAt, wait.resolvedAt ?? end); return observed ? [[Math.max(run.createdAt, observed[0]), Math.min(end, observed[1])] as [number, number]] : []; }).filter(([start, finish]) => finish >= start);
  return { elapsedMs, occupiedMs, unattributedMs: Math.max(0, elapsedMs - occupiedMs), workerMs: total((step) => step.kind === "agent" && !step.coordination && step.role !== "coordinator"), coordinationMs: total((step) => step.kind === "agent" && (step.coordination === true || step.role === "coordinator")), checksMs: total((step) => step.kind !== "agent"), waitingMs: unionMs(waits), timedSteps: records.length, untimedSteps: unique.length - records.length, overlaps: total(() => true) > occupiedMs };
}
