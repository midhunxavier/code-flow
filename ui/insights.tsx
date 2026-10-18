import { useEffect, useState } from "preact/hooks";
import { AgentTag } from "./bits.js";
import { api, baseName, duration, fmtCost, fmtSize, fmtTokens, pct, post, showToast, STATUS_TEXT } from "./lib.js";
import { activeProject, currentProject, NONE, patterns, repo, route, runState } from "./state.js";
import type { AgentId, Stats } from "./types.js";
import { ProjectButton } from "./projects.js";
import { TeamEvaluations } from "./team-evaluation.js";

const patternName = (id: string) => patterns.value.find((p) => p.id === id)?.name ?? id;
const PERIODS = { "7": 7, "30": 30, all: 0 } as const;

/**
 * Insights: what runs cost and how they went — per agent, per pattern, and side by side for
 * comparisons — plus how much disk the worktrees take.
 */
export function InsightsView({ group }: { group?: string }) {
  // The project you're in (or the runs in none), one repo, or everything.
  const project = activeProject.value;
  const inProject = !!project || currentProject.value === NONE;
  // A repo is worth its own button when it isn't simply the whole project.
  const repoScope = !!repo.value && !(project?.repos.length === 1 && project.repos[0] === repo.value);
  const [chosen, setScope] = useState<"project" | "repo" | "all">(inProject ? "project" : repo.value ? "repo" : "all");
  // Switching projects shows the new project's runs (as does the project arriving after a reload).
  useEffect(() => setScope(inProject ? "project" : repo.value ? "repo" : "all"), [currentProject.value, inProject]);
  const scope = chosen === "project" && !inProject ? "all" : chosen === "repo" && !repoScope ? (inProject ? "project" : "all") : chosen;
  const [period, setPeriod] = useState<keyof typeof PERIODS>("30");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const scopeQuery = () => {
    const q = new URLSearchParams();
    if (scope === "project") q.set("project", currentProject.value);
    if (scope === "repo" && repo.value) q.set("repo", repo.value);
    return q;
  };
  const query = () => {
    const q = scopeQuery();
    if (PERIODS[period]) q.set("since", String(Date.now() - PERIODS[period] * 86_400_000));
    return q.toString();
  };
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Stats>(`/api/stats?${query()}`).then(
        (s) => alive && (setStats(s), setError("")),
        (e) => alive && setError((e as Error).message),
      );
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scope, period, repo.value, currentProject.value]);

  const groups = stats ? [...stats.groups].sort((a, b) => (a.id === group ? -1 : b.id === group ? 1 : 0)) : [];
  return (
    <div class="insights">
      <div class="ins-head">
        <h1>Insights</h1>
        <ProjectButton />
        <div class="segmented" role="group" aria-label="Which runs">
          {inProject ? (
            <button class={scope === "project" ? "on" : ""} aria-pressed={scope === "project"} title="Runs in this project" onClick={() => setScope("project")}>
              {project ? project.name : "No project"}
            </button>
          ) : null}
          {repoScope || !inProject ? (
            <button class={scope === "repo" ? "on" : ""} aria-pressed={scope === "repo"} disabled={!repo.value} title="Runs in this repository" onClick={() => setScope("repo")}>
              {repo.value ? baseName(repo.value) : "This repo"}
            </button>
          ) : null}
          <button class={scope === "all" ? "on" : ""} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
            Everything
          </button>
        </div>
        <div class="segmented" role="group" aria-label="Period">
          {(Object.keys(PERIODS) as (keyof typeof PERIODS)[]).map((k) => (
            <button key={k} class={period === k ? "on" : ""} aria-pressed={period === k} onClick={() => setPeriod(k)}>
              {k === "all" ? "All time" : `${k} days`}
            </button>
          ))}
        </div>
      </div>
      {error ? <div class="msg err">{error}</div> : null}
      <TeamEvaluations />
      {!stats ? <div class="help">Loading…</div> : null}
      {stats && !stats.runs ? <div class="banner"><p>No runs in this period yet. Start one, or compare setups from the composer.</p></div> : null}
      {stats && stats.runs ? (
        <>
          <div class="ins-cards">
            <Card label="Runs" value={String(stats.runs)} />
            <Card label="Time" value={duration(stats.ms)} note="wall-clock, finished runs" />
            <Card label="Tokens" value={fmtTokens(stats.tokens)} note="input + output" />
            <Card label="API-equivalent cost" value={fmtCost(stats.costUsd)} note="as Claude Code reports it; your plan isn't billed per token" />
          </div>

          {groups.length ? (
            <section class="ins-section" aria-labelledby="ins-compare">
              <h2 id="ins-compare">Comparisons</h2>
              <p class="help">The same task with different setups, started together. Lower is better for time, steps and tokens; “Tests changed” means the result touched tests in ways that could hide failures.</p>
              {groups.map((g) => (
                <div key={g.id} class={`ins-group ${g.id === group ? "focus" : ""}`}>
                  <div class="ig-title">{g.task.split("\n")[0]}</div>
                  <div class="table-wrap">
                    <table class="ins-table">
                      <thead>
                        <tr>
                          <th>Setup</th>
                          <th>Result</th>
                          <th class="num">Time</th>
                          <th class="num">Steps</th>
                          <th class="num">Tokens</th>
                          <th class="num">Cost</th>
                          <th>Tests changed</th>
                          <th>Proven</th>
                          <th>Changes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.runs.map((r) => {
                          const state = runState(r);
                          const best = (key: "ms" | "steps" | "tokens") => {
                            const done = g.runs.filter((x) => x.status === "done" && x[key] !== undefined);
                            return done.length > 1 && r.status === "done" && r[key] === Math.min(...done.map((x) => x[key] as number));
                          };
                          return (
                            <tr key={r.id} class="clickable" tabIndex={0} onClick={() => (route.value = { view: "run", id: r.id })} onKeyDown={(e) => e.key === "Enter" && (route.value = { view: "run", id: r.id })}>
                              <td>
                                <b>{r.label}</b>
                                <div class="help">
                                  {patternName(r.pattern)} ·{" "}
                                  {[...new Set(Object.values(r.roles).flat())].map((a) => (
                                    <AgentTag key={a} id={a} />
                                  ))}
                                </div>
                              </td>
                              <td>
                                <span class={`status-pill ${state}`}>{state === "failing" ? "Check failing" : state === "unchecked" ? "Check can't run" : r.verdict === "passed" ? "Passed" : STATUS_TEXT[r.status] ?? r.status}</span>
                              </td>
                              <td class={`num ${best("ms") ? "best" : ""}`}>{r.ms !== undefined ? duration(r.ms) : "…"}</td>
                              <td class={`num ${best("steps") ? "best" : ""}`}>{r.steps}</td>
                              <td class={`num ${best("tokens") ? "best" : ""}`}>{fmtTokens(r.tokens)}</td>
                              <td class="num">{r.costUsd ? fmtCost(r.costUsd) : "–"}</td>
                              <td>{r.flagged ? <span class="badge warn">⚠ {r.flagged}</span> : <span class="help">no</span>}</td>
                              <td title={PROOF_TITLE}>
                                {r.proof === "proven" ? (
                                  <span class="badge ok">✓ yes</span>
                                ) : r.proof === "weak" ? (
                                  <span class="badge warn" title="The tests fail without the change only because they can't load">⚠ weak</span>
                                ) : r.proof === "unproven" ? (
                                  <span class="badge warn">⚠ no</span>
                                ) : (
                                  <span class="help">–</span>
                                )}
                              </td>
                              <td class="help">{r.stat ?? "–"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          <section class="ins-section" aria-labelledby="ins-agents">
            <h2 id="ins-agents">Agents</h2>
            <p class="help">
              <b>Passed</b>: finished runs with a check where the agent wrote code, and how many of those passed. “Auto” routing prefers the agent that passes most often in a repo once
              each has a few runs there.
            </p>
            <div class="table-wrap">
              <table class="ins-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th class="num">Runs</th>
                    <th class="num">Passed</th>
                    <th class="num">Race wins</th>
                    <th class="num">Loops it got green</th>
                    <th class="num">Review findings</th>
                    <th class="num">Steps</th>
                    <th class="num">Failed steps</th>
                    <th class="num">Tokens</th>
                    <th class="num">Cost</th>
                    <th class="num">Time per step</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.agents.map((a) => (
                    <tr key={a.agent}>
                      <td>
                        <AgentTag id={a.agent as AgentId} />
                      </td>
                      <td class="num">{a.runs}</td>
                      <td class="num" title={`${a.passed} of ${a.judged}`}>
                        {a.judged ? `${pct(a.passed, a.judged)} (${a.passed}/${a.judged})` : "–"}
                      </td>
                      <td class="num">{a.raceEntries ? `${a.raceWins}/${a.raceEntries}` : "–"}</td>
                      <td class="num">{a.loopSolves || "–"}</td>
                      <td class="num" title="Findings, and how many another reviewer also raised">
                        {a.findings ? `${a.findings} (${a.agreedFindings} agreed)` : "–"}
                      </td>
                      <td class="num">{a.steps}</td>
                      <td class={`num ${a.failures ? "warn" : ""}`}>{a.steps ? pct(a.failures, a.steps) : "–"}</td>
                      <td class="num" title={`${a.inputTokens.toLocaleString()} in · ${a.outputTokens.toLocaleString()} out · ${a.cacheReadTokens.toLocaleString()} cached`}>
                        {fmtTokens(a.inputTokens + a.outputTokens)}
                      </td>
                      <td class="num">{a.costUsd ? fmtCost(a.costUsd) : "–"}</td>
                      <td class="num">{a.steps ? duration(a.ms / a.steps) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section class="ins-section" aria-labelledby="ins-patterns">
            <h2 id="ins-patterns">Patterns</h2>
            <div class="table-wrap">
              <table class="ins-table">
                <thead>
                  <tr>
                    <th>Pattern</th>
                    <th class="num">Runs</th>
                    <th class="num">Passed</th>
                    <th class="num">Check failing</th>
                    <th class="num">Failed or stopped</th>
                    <th class="num">Tests changed</th>
                    <th class="num" title={PROOF_TITLE}>Proven</th>
                    <th class="num">Avg time</th>
                    <th class="num">Avg steps</th>
                    <th class="num">Tokens</th>
                    <th class="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.patterns.map((p) => (
                    <tr key={p.pattern}>
                      <td>{patternName(p.pattern)}</td>
                      <td class="num">{p.runs}</td>
                      <td class="num">{p.passed ? `${p.passed} (${pct(p.passed, p.runs)})` : "–"}</td>
                      <td class={`num ${p.failing ? "warn" : ""}`}>{p.failing || "–"}</td>
                      <td class={`num ${p.failed + p.stopped ? "warn" : ""}`}>{p.failed + p.stopped || "–"}</td>
                      <td class={`num ${p.flagged ? "warn" : ""}`}>{p.flagged || "–"}</td>
                      <td
                        class={`num ${p.unproven + p.weak ? "warn" : ""}`}
                        title={p.proven + p.weak + p.unproven ? `${p.proven} proven, ${p.weak} weakly (tests that only fail to load), ${p.unproven} not proven` : undefined}
                      >
                        {p.proven + p.weak + p.unproven ? `${p.proven}/${p.proven + p.weak + p.unproven}` : "–"}
                      </td>
                      <td class="num">{p.ended ? duration(p.ms / p.ended) : "–"}</td>
                      <td class="num">{(p.steps / p.runs).toFixed(1)}</td>
                      <td class="num">{fmtTokens(p.tokens)}</td>
                      <td class="num">{p.costUsd ? fmtCost(p.costUsd) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
      <DiskPanel scope={scopeQuery()} />
    </div>
  );
}

const PROOF_TITLE = "Proven: a test in the result fails on the base code without the change (code-flow ran the change's tests there)";

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div class="ins-card">
      <div class="ic-label">{label}</div>
      <div class="ic-value">{value}</div>
      {note ? <div class="help">{note}</div> : null}
    </div>
  );
}

interface Disk {
  total: number;
  runs: { id: string; task: string; repo: string; status: string; archived: boolean; endedAt?: number; bytes: number }[];
}

/** Every worktree is a full checkout (often with its own node_modules): see what they take, clean up. */
function DiskPanel({ scope }: { scope: URLSearchParams }) {
  const key = scope.toString();
  const [disk, setDisk] = useState<Disk | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(7);
  const measure = async () => {
    setBusy(true);
    try {
      setDisk(await api<Disk>(`/api/disk${key ? `?${key}` : ""}`));
    } catch (err) {
      showToast((err as Error).message, 5000);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => setDisk(null), [key]);
  return (
    <section class="ins-section" aria-labelledby="ins-disk">
      <h2 id="ins-disk">Disk</h2>
      <div class="row-inline">
        <button class="btn small" disabled={busy} onClick={measure}>
          {busy ? "Measuring…" : disk ? "Measure again" : "Measure worktrees"}
        </button>
        {disk ? (
          <span>
            <b>{fmtSize(disk.total)}</b> in {disk.runs.length} run{disk.runs.length === 1 ? "" : "s"}' worktrees
          </span>
        ) : (
          <span class="help">Adds up the worktrees of every run; this can take a few seconds.</span>
        )}
        <span class="spacer" />
        <span>Remove worktrees of finished runs older than</span>
        <input class="field inline num" type="number" min={0} max={365} value={days} aria-label="Days" onInput={(e) => setDays(Number(e.currentTarget.value) || 0)} />
        <span>days</span>
        <button
          class="btn small"
          onClick={async () => {
            if (!confirm(`Remove the worktrees of runs that finished more than ${days} days ago and need nothing from you? Branches are kept, so you can still merge or resume them.`)) return;
            try {
              const result = await post<{ runs: number; worktrees: number }>("/api/cleanup", { olderThanDays: days, repo: scope.get("repo") ?? undefined, project: scope.get("project") ?? undefined });
              showToast(result.worktrees ? `Removed ${result.worktrees} worktree(s) from ${result.runs} run(s)` : "Nothing to clean up", 4000);
              if (disk) void measure();
            } catch (err) {
              showToast((err as Error).message, 5000);
            }
          }}
        >
          Clean up
        </button>
      </div>
      {disk?.runs.length ? (
        <div class="table-wrap">
          <table class="ins-table">
            <tbody>
              {disk.runs.slice(0, 10).map((r) => (
                <tr key={r.id} class="clickable" tabIndex={0} onClick={() => (route.value = { view: "run", id: r.id })} onKeyDown={(e) => e.key === "Enter" && (route.value = { view: "run", id: r.id })}>
                  <td>{r.task}</td>
                  <td class="help">{baseName(r.repo)}</td>
                  <td class="help">{r.archived ? "archived" : STATUS_TEXT[r.status] ?? r.status}</td>
                  <td class="num">{fmtSize(r.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
