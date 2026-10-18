import type { AgentId } from "./adapters/index.js";
import type { Proof, RunSummary } from "./engine.js";

/**
 * Insights: what runs cost and how they went, per agent and per pattern, and side by side for
 * runs started together to compare setups. Everything is computed from saved runs.
 */

export interface AgentStats {
  agent: AgentId;
  /** Runs the agent took part in. */
  runs: number;
  steps: number;
  writeSteps: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  ms: number;
  /** Finished runs with a check verdict where this agent wrote code, and how many passed. */
  judged: number;
  passed: number;
  raceEntries: number;
  raceWins: number;
  /** Loop until green: rounds that turned the check green. */
  loopSolves: number;
  /** Review council findings this agent raised, and how many other reviewers agreed with. */
  findings: number;
  agreedFindings: number;
}

export interface PatternStats {
  pattern: string;
  runs: number;
  done: number;
  passed: number;
  failing: number;
  failed: number;
  stopped: number;
  /** Runs whose result changed tests in ways that could hide failures. */
  flagged: number;
  /**
   * Runs whose result was proven fail-to-pass (a test fails without it), ones whose tests failed
   * without it only because they couldn't load (weak), and ones that weren't.
   */
  proven: number;
  weak: number;
  unproven: number;
  /** Runs that ended, and their total wall-clock time. */
  ended: number;
  ms: number;
  steps: number;
  tokens: number;
  costUsd: number;
}

export interface GroupRun {
  id: string;
  label: string;
  pattern: string;
  roles: Record<string, AgentId[]>;
  status: string;
  verdict?: string;
  ms?: number;
  steps: number;
  tokens: number;
  costUsd: number;
  flagged: number;
  proof?: Proof["status"];
  stat?: string;
}

export interface Stats {
  runs: number;
  tokens: number;
  costUsd: number;
  ms: number;
  agents: AgentStats[];
  patterns: PatternStats[];
  groups: { id: string; task: string; createdAt: number; runs: GroupRun[] }[];
}

const tokensOf = (r: RunSummary) => (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0);
const lastLine = (stat?: string) => stat?.trim().split("\n").pop()?.trim();

export function computeStats(all: RunSummary[], filter: { repo?: string; since?: number } = {}): Stats {
  const runs = all.filter((r) => (!filter.repo || r.repo === filter.repo) && (!filter.since || r.createdAt >= filter.since));
  const agents = new Map<AgentId, AgentStats>();
  const patterns = new Map<string, PatternStats>();
  const agent = (id: AgentId) => {
    let a = agents.get(id);
    if (!a) {
      a = { agent: id, runs: 0, steps: 0, writeSteps: 0, failures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, ms: 0, judged: 0, passed: 0, raceEntries: 0, raceWins: 0, loopSolves: 0, findings: 0, agreedFindings: 0 };
      agents.set(id, a);
    }
    return a;
  };

  for (const r of runs) {
    const p = patterns.get(r.pattern) ?? { pattern: r.pattern, runs: 0, done: 0, passed: 0, failing: 0, failed: 0, stopped: 0, flagged: 0, proven: 0, weak: 0, unproven: 0, ended: 0, ms: 0, steps: 0, tokens: 0, costUsd: 0 };
    patterns.set(r.pattern, p);
    p.runs++;
    if (r.status === "done") p.done++;
    if (r.status === "failed") p.failed++;
    if (r.status === "stopped") p.stopped++;
    if (r.verdict === "passed") p.passed++;
    if (r.verdict === "failing") p.failing++;
    if (r.integrity && Object.keys(r.integrity).length) p.flagged++;
    if (r.facts?.proof === "proven") p.proven++;
    if (r.facts?.proof === "weak") p.weak++;
    if (r.facts?.proof === "unproven") p.unproven++;
    if (r.endedAt) {
      p.ended++;
      p.ms += r.endedAt - r.createdAt;
    }
    p.steps += r.usage.agentSteps;
    p.tokens += tokensOf(r);
    p.costUsd += r.usage.costUsd ?? 0;

    for (const [id, u] of Object.entries(r.usage.byAgent ?? {}) as [AgentId, NonNullable<RunSummary["usage"]["byAgent"]>[AgentId]][]) {
      if (!u) continue;
      const a = agent(id);
      a.runs++;
      a.steps += u.steps;
      a.writeSteps += u.writeSteps;
      a.failures += u.failures;
      a.inputTokens += u.inputTokens;
      a.outputTokens += u.outputTokens;
      a.cacheReadTokens += u.cacheReadTokens;
      a.costUsd += u.costUsd;
      a.ms += u.ms;
      if (u.writeSteps && r.verdict && r.status === "done") {
        a.judged++;
        if (r.verdict === "passed") a.passed++;
      }
    }
    for (const id of r.facts?.entrants ?? []) agent(id).raceEntries++;
    if (r.facts?.winner) agent(r.facts.winner).raceWins++;
    if (r.facts?.solvedBy) agent(r.facts.solvedBy).loopSolves++;
    for (const f of r.review?.findings ?? []) {
      for (const id of f.raisedBy) {
        agent(id).findings++;
        if (f.raisedBy.length > 1) agent(id).agreedFindings++;
      }
    }
  }

  const groups = new Map<string, Stats["groups"][number]>();
  for (const r of runs) {
    if (!r.group) continue;
    const g = groups.get(r.group.id) ?? { id: r.group.id, task: r.task, createdAt: r.createdAt, runs: [] };
    groups.set(r.group.id, g);
    g.createdAt = Math.min(g.createdAt, r.createdAt);
    g.runs.push({
      id: r.id,
      label: r.group.label,
      pattern: r.pattern,
      roles: r.roles,
      status: r.status,
      verdict: r.verdict,
      ms: r.endedAt ? r.endedAt - r.createdAt : undefined,
      steps: r.usage.agentSteps,
      tokens: tokensOf(r),
      costUsd: r.usage.costUsd ?? 0,
      flagged: Object.values(r.integrity ?? {}).flat().length,
      proof: r.facts?.proof,
      stat: lastLine(r.artifacts.find((a) => a.stat?.trim())?.stat),
    });
  }

  return {
    runs: runs.length,
    tokens: runs.reduce((n, r) => n + tokensOf(r), 0),
    costUsd: runs.reduce((n, r) => n + (r.usage.costUsd ?? 0), 0),
    ms: runs.reduce((n, r) => n + (r.endedAt ? r.endedAt - r.createdAt : 0), 0),
    agents: [...agents.values()].sort((a, b) => b.runs - a.runs),
    patterns: [...patterns.values()].sort((a, b) => b.runs - a.runs),
    groups: [...groups.values()].sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** Below this many judged runs per agent, past results say too little to route by. */
const MIN_SAMPLES = 3;

/**
 * Agents ordered by how often their code passed the check in this repo (smoothed, so a lucky
 * first run doesn't dominate), for "Auto" routing. Empty until at least two agents have enough
 * history to compare.
 */
export function rankAgents(runs: RunSummary[], repo: string): { order: AgentId[]; why: Record<string, string> } {
  const stats = computeStats(runs, { repo }).agents.filter((a) => a.judged >= MIN_SAMPLES);
  if (stats.length < 2) return { order: [], why: {} };
  const score = (a: AgentStats) => (a.passed + 1) / (a.judged + 2);
  const ranked = stats.sort((a, b) => score(b) - score(a));
  return {
    order: ranked.map((a) => a.agent),
    why: Object.fromEntries(ranked.map((a) => [a.agent, `${a.passed} of ${a.judged} runs passed in this repo`])),
  };
}
