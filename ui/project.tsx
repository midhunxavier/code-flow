import { lazyView } from "./lazy-view.js";
const MlWorkspace = lazyView(() => import("./ml/workspace.js").then(module => module.MlWorkspace));
import type { ProjectReport, HistoryPage } from "../src/project-report.js";
import { runSearchText } from "../src/run-history.js";
import { checksLabel, type ProjectSection as HistorySection } from "../src/run-status.js";
import { SchedulingView } from "./scheduling.js";
import { TeamBoardView } from "./collab-board.js";
import { IntegrationsScreen } from "./integration-connections.js";
import { ProjectShare } from "./project-share.js";
import { TeamPeopleView } from "./collab-people.js";
import { useProjectFeatures } from "./project-features.js";
import { OutcomeMetrics } from "./experience.js";
import { ScenarioLibrary } from "./journeys.js";
import { ProjectTeamsInbox } from "./project-teams.js";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, enc, usePoll, fmtCost, ago, baseName, STATUS_TEXT, collaborationHref, selectedTeamConnection } from "./lib.js";
import { editProject, patterns, projectFor, projects, projectsLoaded, route, runs, isRunDeleted, runState, openComposer, composerProject, composerLoading, draftsReady, task, savedDraftTask } from "./state.js";
import { hashFor, type ProjectSection, type RepositoryTool } from "./navigation.js";
import { computerLabel } from "./ssh-projects.js";
import { addRepositoryToProject } from "./projects.js";
import { WorkbenchView } from "./workbench.js";
import { Menu, MenuItem } from "./panel-bits.js";
import type { RunSummary } from "./types.js";

export function ProjectView({ id, section, repository, tool, kind }: { id: string; section?: ProjectSection; repository?: string; tool?: RepositoryTool; kind?: string }) {
  const features = useProjectFeatures(id);
  const [savedTask, setSavedTask] = useState("");
  useEffect(() => { let live = true; setSavedTask(""); if (draftsReady.value) void savedDraftTask(id).then(value => { if (live) setSavedTask(value); }, () => {}); return () => { live = false; }; }, [id, draftsReady.value, composerProject.value]);
  const draftTask = composerProject.value === id ? task.value : savedTask;
  const p = projects.value.find(item => item.id === id);
  if (!p) return <div class="project-page"><p role="status">{projectsLoaded.value ? "This project is unavailable. Its existing runs and saved draft are retained." : "Loading project…"}</p><a class="btn" href="#/">Open new run</a></div>;
  const destination = (section?: ProjectSection) => {
    const hash = hashFor({ view: "project", id, ...(section ? { section } : {}) });
    return section === "board" || section === "people" ? collaborationHref(hash, "local") : hash;
  };
  const navigateTeam = (to: import("./collab-state.js").TeamRoute) => {
    if (to.view === "team" && to.project === id) route.value = { view: "project", id, section: "board" };
    else if (to.view === "team-people" && to.project === id) route.value = { view: "project", id, section: "people" };
    else route.value = to;
  };
  // Rendering must be guarded too: a direct route assignment can render before navigation reloads.
  if ((section === "board" || section === "people") && selectedTeamConnection !== "local") return <p role="status">Opening this project's board on {computerLabel()}… <a href={destination(section)}>Continue</a></p>;
  const selectedRepository = repository ?? (p.repos.length === 1 ? p.repos[0] : undefined);
  return <div class="project-page">
    <header class="page-head"><div class="page-head-text pp-title"><h1>{p.name}</h1><p class="project-computer-label"><Icon name="terminal" />Computer: {computerLabel()}</p></div>
      <div class="page-head-actions"><ProjectShare key={id} project={p} /><button class="btn primary" disabled={!draftsReady.value || composerLoading.value} onClick={() => void openComposer(id)}><Icon name="plus" />New run</button>
        <Menu label="Project actions" icon="more">{close => <>
          <MenuItem onClick={() => { close(); editProject(id); }}>Edit project</MenuItem>
          <MenuItem onClick={() => { close(); route.value = { view: "project", id, section: "settings" }; }}>Project settings</MenuItem>
        </>}</Menu>
      </div>
    </header>
    <nav class="project-tabs" aria-label="Project navigation">{([[undefined, "Overview"], ["runs", "Runs"], ["repositories", "Repositories"], ["connections", "Connections"]] as const).map(([value, label]) => <a class={`btn ${section === value ? "primary" : ""}`} href={destination(value)} aria-current={section === value ? "page" : undefined}>{label}</a>)}{features.board || section === "board" ? <a class="btn" href={destination("board")} aria-current={section === "board" ? "page" : undefined}>Board</a> : null}{features.automation || section === "automation" ? <a class="btn" href={destination("automation")} aria-current={section === "automation" ? "page" : undefined}>Automation</a> : null}{features.ml || section === "ml" ? <a class="btn" href={destination("ml")} aria-current={section === "ml" ? "page" : undefined}>ML</a> : null}<a class="btn" href={destination("settings")} aria-current={section === "settings" ? "page" : undefined}>Project settings</a><Menu label="More project tools" icon="more" trigger={<span>More</span>} class="project-more">{close => <>{(["board", "people", "automation", "ml"] as const).filter(value => value !== "ml" || features.ml || section === "ml").map(value => <MenuItem onClick={() => { close(); if (value === "board" || value === "people") location.assign(destination(value)); else route.value = { view: "project", id, section: value }; }}>{({ board: "Board", people: "People", automation: "Automation", ml: "ML" })[value]}</MenuItem>)}</>}</Menu></nav>
    {!section ? <>
      <section class="project-start pp-card" aria-label="Start work"><h2>{draftTask.trim() ? "Continue your draft" : "What would you like to work on?"}</h2><p>{p.repos.length ? "Describe the outcome, choose your agents, and review the result here." : "Add a repository to start a run in this project."}</p>
        {draftTask.trim() ? <p class="draft-preview">{draftTask.slice(0, 240)}</p> : null}
        <button class="btn primary" disabled={!draftsReady.value || composerLoading.value} onClick={() => p.repos.length ? void openComposer(id) : addRepositoryToProject(id)}>{p.repos.length ? draftTask.trim() ? "Continue draft" : "Describe a task" : "Add repository"}</button>
      </section>
      <ProjectTeamsInbox projectId={id} />
      <ProjectOverview key={id} id={id} />
      <a class="btn" href={destination("runs")}>View run history</a>
    </> : section === "ml" ? <MlWorkspace key={id} project={p} /> : section === "board" ? <TeamBoardView project={id} embedded navigate={navigateTeam} /> : section === "people" ? <TeamPeopleView project={id} embedded navigate={navigateTeam} /> : section === "connections" ? <IntegrationsScreen key={id} projectId={id} /> : section === "automation" ? <SchedulingView key={id} projectId={id} kind={kind} /> : section === "runs" ? <ProjectRuns key={id} projectId={id} /> : section === "repositories" ? <>
      <div class="project-repository-head"><h2>Repositories</h2><button class="btn" onClick={() => addRepositoryToProject(id)}><Icon name="plus" />Add repository</button></div>
      {!p.repos.length ? <p class="help">No repositories yet. Add a repository from {computerLabel()} to use its files and tools.</p> : <div class="project-repository-list">{p.repos.map(folder => <a class={`pp-card project-repository ${selectedRepository === folder ? "selected" : ""}`} href={hashFor({ view: "project", id, section: "repositories", repository: folder, tool: "code" })}><strong>{baseName(folder)}</strong><code>{folder}</code><span>Open repository tools →</span></a>)}</div>}
      {selectedRepository ? <WorkbenchView key={`${id}:${selectedRepository}`} projectId={id} initialFolder={selectedRepository} initialTool={tool} onNavigate={(folder, nextTool) => { route.value = { view: "project", id, section: "repositories", repository: folder, tool: nextTool }; }} /> : p.repos.length ? <p class="help">Choose a repository to inspect its files, checks, services and history.</p> : null}
    </> : <>
      <section class="pp-card project-start"><h2>Project settings</h2><p>Manage the project's name and repository membership.</p><button class="btn" onClick={() => editProject(id)}>Edit project</button></section>
      <OutcomeMetrics project={id} />
      {p.repos.map(folder => <ScenarioLibrary key={folder} repository={folder} />)}
      <a class="btn" href={hashFor({ view: "project", id, section: "automation", kind: "missions" })}>Manage project missions</a>
    </>}
  </div>;
}

/** Counts and paged results cover the project, independently of sidebar history. */
function ProjectOverview({ id }: { id: string }) {
  const [report, setReport] = useState<ProjectReport | null>(null);
  const [error, setError] = useState("");
  const [limits, setLimits] = useState({ waiting: 100, running: 100, results: 8 });
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
  const more = (section: HistorySection) => setLimits(value => ({ ...value, [section]: value[section] + 100 }));
  return <>
    <div class="ins-cards pp-numbers">
      <Card label="Runs this week" value={report ? String(report.week.runs) : "–"} />
      <Card label="Checks passed" value={report?.week.runs ? `${report.week.passed} of ${report.week.runs}` : "–"} />
      <Card label="API-equivalent" value={report?.week.costUsd ? fmtCost(report.week.costUsd) : "–"} hint="Claude's cost, as a measure of size" />
    </div>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {!report ? <p class="help">Loading project history…</p> : (["waiting", "running", "results"] as const).map(section => {
      const page = report.sections[section];
      if (section !== "results" && !page.total) return null;
      return <Section key={section} title={{ waiting: "Needs you", running: "Running", results: "Recent results" }[section]}
        count={page.total} runs={page.runs} attention={section === "waiting"} empty="No results yet. Start a run above."
        more={page.nextCursor ? () => more(section) : undefined} moreCount={Math.max(0, page.total - page.runs.length)} loading={loading} />;
    })}
  </>;
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div class="ins-card" title={hint}>
      <div class="ic-label">{label}</div>
      <div class="ic-value">{value}</div>
    </div>
  );
}

/** History has its own project-scoped cursor; sidebar search cannot change this list. */
function ProjectRuns({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState(""), [archived, setArchived] = useState(false);
  const [history, setHistory] = useState<RunSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null), [archivedMatches, setArchivedMatches] = useState(0);
  const [historyQuery, setHistoryQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), retainedPages = useRef(1), reading = useRef(false);
  const read = async (next?: string) => {
    const current = ++generation.current;
    setLoading(true); reading.current = true; setError("");
    try {
      const params = new URLSearchParams({ project: projectId, limit: "100", q: query.trim(), archived: archived ? "include" : "exclude" });
      if (next) params.set("cursor", next);
      let page = await api<HistoryPage>(`/api/runs?${params}`);
      // A live refresh preserves every history page the user already requested.
      for (let loaded = 1; !next && page.nextCursor && loaded < retainedPages.current && current === generation.current; loaded++) {
        params.set("cursor", page.nextCursor);
        const more = await api<HistoryPage>(`/api/runs?${params}`);
        page = { ...more, runs: [...page.runs, ...more.runs] };
      }
      if (current !== generation.current) return;
      if (next) retainedPages.current++;
      setHistory(previous => next ? [...previous, ...page.runs] : page.runs); setHistoryQuery(query.trim()); setCursor(page.nextCursor ?? null); setTotal(page.total); setArchivedMatches(page.archivedMatches ?? 0);
    } catch (error) { if (current === generation.current) setError((error as Error).message); }
    finally { if (current === generation.current) { setLoading(false); reading.current = false; } }
  };
  useEffect(() => { retainedPages.current = 1; setTotal(null); setArchivedMatches(0); const timer = setTimeout(() => void read(), 150); return () => { clearTimeout(timer); generation.current++; }; }, [projectId, query, archived]);
  const liveRuns = runs.value;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { if (reading.current) timer = setTimeout(refresh, 250); else void read(); };
    timer = setTimeout(refresh, 250);
    return () => clearTimeout(timer);
  }, [liveRuns, projectId, query, archived]);
  const merged = new Map(history.filter(run => !isRunDeleted(run.id)).map(run => [run.id, liveRuns.get(run.id) ?? run]));
  for (const run of runs.value.values()) if (projectFor(run)?.id === projectId) merged.set(run.id, run);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Cold summaries can omit text the server searched in the full run. Retain
  // those matches only for the query that actually returned this page.
  const serverMatches = new Set(historyQuery === query.trim() ? history.map(run => run.id) : []);
  const list = [...merged.values()].filter(run => projectFor(run)?.id === projectId && !run.deleted && (archived || !run.archived) &&
    (run.cold && serverMatches.has(run.id) || words.every(word => runSearchText(run).includes(word)))).sort((a,b) => b.createdAt - a.createdAt);
  return <section aria-label="Project run history"><div class="project-history-controls"><label>Search this project's runs<input class="field" type="search" value={query} onInput={event => setQuery(event.currentTarget.value)} /></label><label class="check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.currentTarget.checked)} />Include archived runs</label></div>
    {error ? <p class="msg err" role="alert">{error} <button class="btn small" onClick={() => void read()}>Retry</button></p> : null}
    <Section title="Run history" count={total === null ? undefined : Math.max(total, list.length)} runs={list} empty={loading ? "Loading runs…" : "No runs match this view."} />
    {total !== null ? <p class="help">{list.length} loaded of {Math.max(total, list.length)} matching runs</p> : null}
    {!archived && !list.length && archivedMatches ? <p class="help">{archivedMatches} archived {archivedMatches === 1 ? "run matches" : "runs match"}. Include archived runs to see {archivedMatches === 1 ? "it" : "them"}.</p> : null}
    {cursor ? <button class="btn" disabled={loading} onClick={() => void read(cursor)}>{loading ? "Loading…" : "Load older runs"}</button> : null}
  </section>;
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
        {run.archived ? pill("", "Archived") : null}
        {merged ? pill("", "Merged") : pr ? pill("", "PR open") : null}
      </span>
      <span class="m">
        {pattern} · {ago(run.createdAt)}
      </span>
    </a>
  );
}
