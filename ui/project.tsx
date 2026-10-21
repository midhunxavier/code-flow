import type { ProjectReport, HistoryPage } from "../src/project-report.js";
import { checksLabel, type ProjectSection } from "../src/run-status.js";
import { OutcomeMetrics } from "./experience.js";
import { ScenarioLibrary } from "./journeys.js";
import { ProjectTeamsPanel } from "./project-teams.js";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { automationProject, automations, loadAutomations } from "./automations.js";
import { Icon } from "./icons.js";
import { api, enc, usePoll, ago, baseName, fmtCost, STATUS_TEXT } from "./lib.js";
import { editProject, patterns, projects, projectsLoaded, route, runState, selectProject, setTask } from "./state.js";
import type { RunSummary } from "./types.js";

/** First page of recent project results. */
const RECENT = 8;
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * A project's page, opened from its name in the sidebar: what needs you, what's running, recent
 * results, its automations and the week's numbers. The side panel shows the project meanwhile.
 */
export function ProjectView({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [report, setReport] = useState<ProjectReport | null>(null);
  const [error, setError] = useState("");
  const [limits, setLimits] = useState({ waiting: 100, running: 100, results: RECENT });
  const [loading, setLoading] = useState(false);
  usePoll(async current => {
    setLoading(true);
    try {
      const next = await api<ProjectReport>(`/api/projects/${enc(id)}/summary`);
      // Reload only pages the user has requested. Totals always cover the complete history.
      for (const section of ["waiting", "running", "results"] as const) {
        let page = next.sections[section];
        while (current() && page.nextCursor && page.runs.length < limits[section]) {
          const more = await api<HistoryPage>(`/api/runs?limit=${Math.min(100, limits[section] - page.runs.length)}&project=${enc(id)}&section=${section}&cursor=${enc(page.nextCursor)}`);
          page = { ...more, runs: [...page.runs, ...more.runs] };
        }
        next.sections[section] = page;
      }
      if (current()) { setReport(next); setError(""); }
    } catch (problem) { if (current()) setError((problem as Error).message); }
    finally { if (current()) setLoading(false); }
  }, 15_000, [id, limits.waiting, limits.running, limits.results]);
  const more = (section: ProjectSection) => setLimits(value => ({ ...value, [section]: value[section] + 100 }));
  useEffect(() => void loadAutomations(), []);
  const p = projects.value.find((x) => x.id === id);
  if (!p) {
    return (
      <div class="project-page">
        <p class="help">{projectsLoaded.value ? "This project doesn't exist any more." : "Loading…"}</p>
      </div>
    );
  }
  const autos = automations.value.filter((a) => automationProject(a.run)?.id === id);
  const pending = report?.pending ?? 0;
  const team = p.defaults ? patterns.value.find((x) => x.id === p.defaults!.pattern)?.name : undefined;

  /** The composer, in this project, with what you typed as the task. */
  const start = () => {
    selectProject(id);
    if (text.trim()) setTask(text.trim());
    route.value = { view: "composer" };
  };

  return (
    <div class="project-page">
      <div class="page-head">
        <div class="page-head-text pp-title">
          <h1>{p.name}</h1>
          <p>{p.repos.length ? `Runs in ${p.repos.map(baseName).join(", ")}: what needs you, what's running and how recent runs went.` : "What needs you, what's running and how recent runs went."}</p>
        </div>
        <div class="page-head-actions">
          <a class="btn" href={`#/project/${encodeURIComponent(id)}/workspace`}><Icon name="files" />Repository tools</a>
          <button type="button" class="btn" onClick={() => editProject(id)} title="Rename, repositories, delete">
            Edit
          </button>
          <button type="button" class="btn primary" onClick={start} title="A new run in this project">
            <Icon name="plus" /> New run
          </button>
        </div>
      </div>

      <div class="pp-task">
        <textarea
          class="field"
          rows={2}
          aria-label="Task"
          placeholder={`Describe a task for ${p.name}…`}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              start();
            }
          }}
        />
        <button type="button" class="btn primary" disabled={!text.trim()} onClick={start} title="Pick the team in the composer (⌘↵)">
          Continue
        </button>
      </div>

      <div class="ins-cards pp-numbers">
        <Card label="Runs this week" value={report ? String(report.week.runs) : "–"} />
        <Card label="Checks passed" value={report?.week.runs ? `${report.week.passed} of ${report.week.runs}` : "–"} />
        <Card label="API-equivalent" value={report?.week.costUsd ? fmtCost(report.week.costUsd) : "–"} hint="Claude's cost, as a measure of size" />
      </div>

      <OutcomeMetrics project={id} />
      {p.repos.map(repository => <ScenarioLibrary key={repository} repository={repository} />)}
      <ProjectTeamsPanel projectId={id} repos={p.repos} />

      <div class="pp-layout">
        <div class="pp-main">
          {error ? <p class="msg err" role="alert">{error}</p> : null}
          {!report ? <p class="help">Loading project history…</p> : (["waiting", "running", "results"] as const).map(section => {
            const page = report.sections[section];
            if (section !== "results" && !page.total) return null;
            return <Section key={section} title={{ waiting: "Needs you", running: "Running", results: "Recent results" }[section]}
              count={page.total} runs={page.runs} attention={section === "waiting"} empty="No results yet. Start a run above."
              more={page.nextCursor ? () => more(section) : undefined} moreCount={Math.max(0, page.total - page.runs.length)} loading={loading} />;
          })}
        </div>

        <div class="pp-aside">
          <section class="pp-card" aria-labelledby="pp-details">
            <div class="pp-card-head">
              <h2 id="pp-details">Details</h2>
            </div>
            <dl class="pp-kv">
              <dt>Repositories</dt>
              <dd class="pp-repos">
                {p.repos.length
                  ? p.repos.map((r) => (
                      <code key={r} title={r}>
                        {baseName(r)}
                      </code>
                    ))
                  : <span class="muted">None yet</span>}
              </dd>
              <dt>Last agent workflow</dt>
              <dd>{team ?? <span class="muted">None yet</span>}</dd>
              <dt>Runs</dt>
              <dd>
                {report ? plural(report.live, "run") : "–"}
                {report?.archived ? <span class="muted"> · {report.archived} archived</span> : null}
              </dd>
              <dt>Created</dt>
              <dd>{new Date(p.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</dd>
            </dl>
          </section>

          <section class="pp-card" aria-labelledby="pp-autos">
            <div class="pp-card-head">
              <h2 id="pp-autos">Automations</h2>
              {pending ? <span class="pp-count" title={`${plural(pending, "result")} waiting in the inbox`}>{pending}</span> : null}
            </div>
            {autos.length ? (
              <div class="pp-list">
                {autos.map((a) => (
                  <button key={a.id} type="button" class={`pp-row ${a.enabled ? "" : "off"}`} onClick={() => (route.value = { view: "automations" })}>
                    <Icon name="clock" />
                    <span class="t">{a.name}</span>
                    <span class="m">{a.enabled ? a.scheduleText || (a.webhook ? "Webhook" : "") : "Paused"}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p class="pp-empty">None in this project. Save a run as an automation from the composer to run it on a schedule or from a webhook.</p>
            )}
            {pending ? (
              <div class="pp-card-foot">
                <button type="button" class="btn small" onClick={() => (route.value = { view: "inbox" })}>
                  {plural(pending, "result")} in the inbox
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div class="ins-card" title={hint}>
      <div class="ic-label">{label}</div>
      <div class="ic-value">{value}</div>
    </div>
  );
}

function Section({ title, runs, count, empty, more, moreCount = 0, attention = false, loading = false }: { title: string; runs: RunSummary[]; count?: number; empty?: string; more?: () => void; moreCount?: number; attention?: boolean; loading?: boolean }) {
  return (
    <section class={`pp-card ${attention ? "attention" : ""}`} aria-label={title}>
      <div class="pp-card-head">
        <h2>{title}</h2>
        {count ? <span class={`pp-count ${attention ? "warn" : ""}`}>{count}</span> : null}
      </div>
      {runs.length ? (
        <div class="pp-list">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </div>
      ) : empty ? (
        <p class="pp-empty">{empty}</p>
      ) : null}
      {more ? (
        <button type="button" class="pp-more" disabled={loading} onClick={more}>
          Show {Math.min(100, moreCount)} more
        </button>
      ) : null}
    </section>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const state = runState(run);
  const pattern = patterns.value.find((x) => x.id === run.pattern)?.name ?? run.pattern;
  const merged = run.merges.length > 0;
  const pr = Object.keys(run.prs).length > 0;
  const pill = (cls: string, text: ComponentChildren) => <span class={`status-pill ${cls}`}>{text}</span>;
  const verdict = run.awaiting
    ? pill("awaiting", "Waiting for you")
    : state === "failing"
      ? pill("failing", "Check fails")
      : state === "done"
        ? pill("done", "Check passes")
        : run.status !== "done"
          ? pill(run.status, STATUS_TEXT[run.status] ?? run.status)
          : pill(state, checksLabel(run));
  return (
    <a class="pp-row" href={`#/run/${encodeURIComponent(run.id)}`} title={run.task}>
      <span class={`dot ${state}`} aria-hidden="true" />
      <span class="t">{run.task.split("\n")[0] || "(no task)"}</span>
      <span class="pills">
        {verdict}
        {merged ? pill("", "Merged") : pr ? pill("", "PR open") : null}
      </span>
      <span class="m">
        {pattern} · {ago(run.createdAt)}
      </span>
    </a>
  );
}
