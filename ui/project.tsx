import { onPhone, ownerOnLocalListener } from "./lib.js";
import type { ChatSummary } from "../src/conversational/chats.js";
import { ProjectContextEditor } from "./chat-context-editor.js";
import { ProjectRunSettings } from "./project-run-settings.js";
import { chatAllowed, openChat } from "./chat-state.js";
import { executionLabel } from "./run-experience.js";
import { lazyView } from "./lazy-view.js";
import type { ProjectReport, HistoryPage } from "../src/project-report.js";
import { runSearchText } from "../src/run-history.js";
import { checksLabel, type ProjectSection as HistorySection } from "../src/run-status.js";
import { SchedulingView } from "./scheduling.js";
import { TeamBoardView } from "./collab-board.js";
import { IntegrationsScreen } from "./integration-connections.js";
import { ProjectShare } from "./project-share.js";
import { TeamPeopleView } from "./collab-people.js";
import { OutcomeMetrics } from "./experience.js";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, enc, usePoll, fmtCost, ago, baseName, isFolderMirror, shownPath, STATUS_TEXT, collaborationHref, selectedTeamConnection } from "./lib.js";
import { editProject, patternName, projectFor, projects, projectsLoaded, route, runs, isRunDeleted, runState, openComposer, composerProject, composerLoading, draftsReady, task, savedDraftTask, takeDraftTask, draftTo } from "./state.js";
import { hashFor, type ProjectSection, type RepositoryTool } from "./navigation.js";
import { computerLabel, executionHost } from "./ssh-projects.js";
import { addRepositoryToProject } from "./projects.js";
import { WorkbenchView } from "./workbench.js";
import type { RunSummary } from "./types.js";

export function ProjectView({ id, section, repository, tool, kind }: { id: string; section?: ProjectSection; repository?: string; tool?: RepositoryTool; kind?: string }) {
  const [contextOpen, setContextOpen] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current, active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const bounds = nav.getBoundingClientRect(), tab = active.getBoundingClientRect();
    if (tab.left < bounds.left) nav.scrollLeft += tab.left - bounds.left;
    else if (tab.right > bounds.right) nav.scrollLeft += tab.right - bounds.right;
  }, [id, section, projects.value]);
  const [savedTask, setSavedTask] = useState("");
  useEffect(() => { let live = true; setSavedTask(""); if (draftsReady.value) void savedDraftTask(id).then(value => { if (live) setSavedTask(value); }, () => {}); return () => { live = false; }; }, [id, draftsReady.value, composerProject.value]);
  const draftTask = composerProject.value === id ? task.value : savedTask;
  // A draft that is only its text continues in the chat; one with files, context or a workflow keeps its form.
  const continueDraft = async () => {
    const text = chatAllowed() ? await takeDraftTask(id).catch(() => null) : null;
    if (text === null) { void openComposer(id); return; }
    draftTo("composer", text); openChat(id);
  };
  const p = projects.value.find(item => item.id === id);
  if (!p) return <div class="project-page"><p role="status">{projectsLoaded.value ? "This project is unavailable. Its existing runs and saved draft are retained." : "Loading project…"}</p><a class="btn" href="#/">New chat</a></div>;
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
      <div class="page-head-actions"><ProjectShare key={id} project={p} /><button class="btn primary" disabled={!draftsReady.value || composerLoading.value} onClick={() => openChat(id)}><Icon name="compose" />New chat</button>
      </div>
    </header>
    <nav ref={navigation} class="project-tabs" aria-label="Project navigation">
      {/* The work first (what is happening, what happened, what runs by itself), then how the project is set up. */}
      {([[undefined, "Overview"], ["board", "Board"], ["runs", "History"], ["automation", "Automation"], "setup", ["repositories", "Repositories"], ["connections", "Connections"], ["people", "People"], ["settings", "Project settings"]] as const)
        .map(entry => entry === "setup" ? <span key="setup" class="project-tabs-divider" aria-hidden="true" /> : <a key={entry[0] ?? "overview"} class={`btn ${section === entry[0] ? "primary" : ""}`} href={destination(entry[0])} aria-current={section === entry[0] ? "page" : undefined}>{entry[1]}</a>)}
    </nav>
    {!section ? <>
      <section class="project-start pp-card" aria-label="Start work"><h2>{draftTask.trim() ? "Continue your draft" : "What would you like to work on?"}</h2><p>{p.repos.length ? "Describe the outcome, choose your agents, and review the result here." : "Add a repository to work with code in this project."}</p>
        {draftTask.trim() ? <p class="draft-preview">{draftTask.slice(0, 240)}</p> : null}
        <button class="btn primary" disabled={!draftsReady.value || composerLoading.value} onClick={() => p.repos.length ? draftTask.trim() ? void continueDraft() : openChat(id) : addRepositoryToProject(id)}>{p.repos.length ? draftTask.trim() ? "Continue draft" : "Describe a task" : "Add repository"}</button>
      </section>
      <ProjectOverview key={id} id={id} />
      <a class="btn" href={destination("runs")}>View history</a>
    </> : section === "board" ? <TeamBoardView project={id} embedded navigate={navigateTeam} /> : section === "people" ? <TeamPeopleView project={id} embedded navigate={navigateTeam} /> : section === "connections" ? <IntegrationsScreen key={id} projectId={id} /> : section === "automation" ? <SchedulingView key={id} projectId={id} kind={kind} /> : section === "runs" ? <><ProjectChatHistory key={`chats:${id}`} projectId={id}/><ProjectRuns key={id} projectId={id} /></> : section === "repositories" ? <>
      <div class="project-repository-head"><h2>Repositories</h2><button class="btn" onClick={() => addRepositoryToProject(id)}><Icon name="plus" />Add repository</button></div>
      {!p.repos.length ? <p class="help">No repositories yet. Add a repository from {computerLabel()} to use its files and tools.</p> : <div class="project-repository-list">{p.repos.map(folder => <a class={`pp-card project-repository ${selectedRepository === folder ? "selected" : ""}`} href={hashFor({ view: "project", id, section: "repositories", repository: folder, tool: "code" })}><strong>{baseName(folder)}</strong><code>{shownPath(folder)}</code><span>{isFolderMirror(folder) ? "Folder · not a Git repository. Open its tools →" : "Open repository tools →"}</span></a>)}</div>}
      {selectedRepository ? <WorkbenchView key={`${id}:${selectedRepository}`} projectId={id} initialFolder={selectedRepository} initialTool={tool} onNavigate={(folder, nextTool) => { route.value = { view: "project", id, section: "repositories", repository: folder, tool: nextTool }; }} /> : p.repos.length ? <p class="help">Choose a repository to inspect its files, checks, services and history.</p> : null}
    </> : <>
      <section class="pp-card project-start"><h2>Project settings</h2><p>Manage the project's name and repository membership.</p><button class="btn" onClick={() => editProject(id)}>Edit project</button></section>
      <section class="pp-card project-settings-card"><h2>Defaults</h2><p>Optional instructions, files, check commands, permissions and limits for future work. Each approach shows the settings it will use.</p><button class="btn" disabled={!p.repos.length} onClick={() => setContextOpen(true)}>Edit project defaults</button><p class="help">Provider connections and authentication live in <a href="#/settings/providers">App settings → Providers</a>.</p></section>
      <ProjectContextEditor project={id} repo={p.repos[0] ?? ""} open={contextOpen} onClose={() => setContextOpen(false)}/>
      <details class="pp-card project-advanced"><summary>Advanced · run defaults and repository configuration</summary><ProjectRunSettings projectId={id} repositories={p.repos}/><OutcomeMetrics project={id}/></details>
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
        count={page.total} runs={page.runs} attention={section === "waiting"} empty="No results yet. Start a chat to begin."
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
  const read = async (next?: string, background = false) => {
    const current = ++generation.current;
    if (!background) setLoading(true);
    reading.current = true; setError("");
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
      if (current !== generation.current) return false;
      if (next) retainedPages.current++;
      setHistory(previous => next ? [...previous, ...page.runs] : page.runs); setHistoryQuery(query.trim()); setCursor(page.nextCursor ?? null); setTotal(page.total); setArchivedMatches(page.archivedMatches ?? 0);
    } catch (error) { if (current === generation.current) setError((error as Error).message); }
    finally { if (current === generation.current) { setLoading(false); reading.current = false; } }
    return current === generation.current;
  };
  useEffect(() => { retainedPages.current = 1; setCursor(null); setTotal(null); setArchivedMatches(0); const timer = setTimeout(() => void read(), 150); return () => { clearTimeout(timer); generation.current++; }; }, [projectId, query, archived]);
  const liveRuns = runs.value;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const refresh = async () => {
      // A foreground page request can supersede a live refresh. Refresh again
      // after it finishes so the new page and the live update are both kept.
      if (!reading.current && await read(undefined, true)) return;
      if (active) timer = setTimeout(refresh, 250);
    };
    timer = setTimeout(refresh, 250);
    return () => { active = false; clearTimeout(timer); };
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
  const pattern = patternName(run.pattern);
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
          ? pill(run.status, executionLabel(run))
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


function ProjectChatHistory({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<ChatSummary[]>([]), [error, setError] = useState(""), [query, setQuery] = useState(""), [archived, setArchived] = useState(false), [limit, setLimit] = useState(20);
  const allowed = !onPhone && ownerOnLocalListener.value && executionHost.value.kind === "local";
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(); setLoaded(false);
    const timer = setTimeout(() => { void api<{ items: ChatSummary[] }>(`/api/chats?${new URLSearchParams({ project: projectId, q: query, archived: String(archived) })}`, { signal: controller.signal }).then(value => { if (controller.signal.aborted) return; setItems(value.items); setError(""); setLimit(20); setLoaded(true); }).catch(e => { if (!controller.signal.aborted) setError(e.message); }); }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, query, archived, allowed]);
  if (!allowed) return null;
  return <section class="pp-card project-chat-history" aria-label="Project chat history"><h2>Chats</h2><div class="project-history-controls"><label>Search chats<input class="field" type="search" value={query} onInput={e => setQuery(e.currentTarget.value)}/></label><label class="check"><input type="checkbox" checked={archived} onChange={e => setArchived(e.currentTarget.checked)}/>Archived chats</label></div>{error ? <p role="alert">{error}</p> : !loaded ? <p class="help" role="status">Loading chats…</p> : items.length ? <div class="pp-list">{items.slice(0,limit).map(chat => <a class="pp-row" href={`#/chat/${encodeURIComponent(chat.id)}`} key={chat.id}><span class="t">{chat.title}</span><span>{chat.status}</span><span class="m">{ago(chat.updatedAt)}</span></a>)}</div> : <p class="help">No chats match this view.</p>}{items.length > limit ? <button class="btn" onClick={() => setLimit(limit+20)}>Show more chats</button> : null}</section>;
}
