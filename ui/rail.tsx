import { useState } from "preact/hooks";
import { Bell } from "./app.js";
import { inbox } from "./automations.js";
import { Icon } from "./icons.js";
import { ago, baseName, fmtCost, fmtTokens, STATUS_TEXT } from "./lib.js";
import {
  NONE,
  agents,
  editProject,
  filterActive,
  health,
  healthOpen,
  historyTotal,
  attentionTotal,
  attentionTruncated,
  historyNextCursor,
  historyLoading,
  historyLoadingMore,
  historyError,
  loadOlderRuns,
  refreshRuns,
  isFlagged,
  matchesFilter,
  needsYou,
  patterns,
  projectEdit,
  projectFor,
  projects,
  projectsOpen,
  railOpen,
  railView,
  repo,
  route,
  runFilter,
  runs,
  runState,
  selectProject,
  setRailView,
  setRunFilter,
  shortcutsOpen,
  type RunFilter,
} from "./state.js";
import type { Project, RunSummary } from "./types.js";
import { teamAwaitingAnswer, teamNeedsResume } from "./team-state.js";

const STATUS_FILTERS: [RunFilter["status"], string][] = [
  ["all", "All"],
  ["attention", "Needs you"],
  ["running", "Running"],
  ["passed", "Passed"],
  ["failing", "Failing"],
  ["flagged", "Tests changed"],
];
/** A project lists this many runs until you ask for the rest. */
const PER_PROJECT = 5;

/** What a run's dot means, in words: the dot alone says nothing to a screen reader. */
const statusText = (r: RunSummary) =>
  r.awaiting || teamAwaitingAnswer(r)
    ? "Waiting for you"
    : teamNeedsResume(r) ? "Unresolved work" : r.triage?.state === "pending"
      ? "In your inbox"
      : runState(r) === "failing"
        ? "Check failing"
        : runState(r) === "unchecked"
          ? "Check can't run"
          : STATUS_TEXT[r.status] ?? r.status;
const short = (ts: number) => ago(ts).replace(" ago", "").replace("just now", "now");

interface Group {
  key: string;
  project?: Project;
  name: string;
  runs: RunSummary[];
  /** The newest run in the project, whichever section it's listed in: projects sort by it. */
  last: number;
  archived: number;
}

/**
 * The sidebar, as in Claude's apps: new run and the app's pages on top, then what needs you, then
 * every project with its runs. Nothing in it depends on a project you picked somewhere else.
 */
export function Rail() {
  const [showFilters, setShowFilters] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [long, setLong] = useState<Set<string>>(new Set());
  const view = railView.value;
  const f = runFilter.value;
  const filtering = filterActive.value;
  const r = route.value;
  const current = r.view === "run" || r.view === "review" ? r.id : undefined;
  /** The project whose page is open. */
  const page = r.view === "project" ? r.id : undefined;
  const all = [...runs.value.values()].sort((a, b) => b.createdAt - a.createdAt);
  // While you search or filter, archived runs that match show too: nothing is out of reach.
  const list = all.filter((r) => matchesFilter(r) && (!r.archived || view.archived || filtering));
  const archivedCount = all.filter((r) => r.archived).length;
  const waiting = list.filter(needsYou);
  const pending = inbox().length;

  const go = (to: typeof route.value) => {
    route.value = to;
    railOpen.value = false;
  };
  const newRunIn = (p: Project) => {
    selectProject(p.id);
    go({ view: "composer" });
  };
  const toggle = (key: string) =>
    setRailView({ collapsed: view.collapsed.includes(key) ? view.collapsed.filter((k) => k !== key) : [...view.collapsed, key] });

  const row = (r: RunSummary, meta: string) => {
    const tokens = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
    const p = projectFor(r);
    const details = [
      statusText(r),
      isFlagged(r) ? "tests changed in ways that could hide failures" : "",
      patterns.value.find((x) => x.id === r.pattern)?.name ?? r.pattern,
      p ? (p.repos.length > 1 ? `${p.name} · ${baseName(r.repo)}` : p.name) : baseName(r.repo),
      ago(r.createdAt),
      tokens ? `${fmtTokens(tokens)} tok` : "",
      r.usage?.costUsd ? fmtCost(r.usage.costUsd) : "",
    ].filter(Boolean);
    return (
      <button
        key={r.id}
        type="button"
        class={`run-item ${current === r.id ? "active" : ""} ${needsYou(r) ? "unseen" : ""} ${r.archived ? "archived" : ""}`}
        title={`${r.task.split("\n")[0]}\n${details.join(" · ")}`}
        aria-current={current === r.id ? "page" : undefined}
        onClick={() => go({ view: "run", id: r.id })}
      >
        <span class={`dot ${runState(r)}`} aria-hidden="true" />
        <span class="t">
          {/* how it started: the same marks as the Automations inbox */}
          {r.trigger ? <Icon name={r.trigger.via === "sweep" ? "layers" : r.trigger.via === "webhook" ? "globe" : "clock"} class="inline-icon" /> : null}
          {r.group ? <Icon name="compare" class="inline-icon" /> : null}
          {r.task.split("\n")[0] || "(no task)"}
        </span>
        <span class="m">
          {isFlagged(r) ? (
            <span class="flag">
              <Icon name="alert" />
            </span>
          ) : null}
          {meta}
        </span>
        <span class="sr-only">
          {" "}
          · {statusText(r)}
          {r.archived ? " · archived" : ""}
        </span>
      </button>
    );
  };

  const actions = (p: Project) => (
    <span class="proj-actions">
      <button type="button" class="icon-btn" aria-label={`New run in ${p.name}`} title={`New run in ${p.name}`} onClick={() => newRunIn(p)}>
        <Icon name="plus" />
      </button>
      <button type="button" class="icon-btn" aria-label={`Edit ${p.name}`} title="Rename, repositories, delete" onClick={() => editProject(p.id)}>
        <Icon name="more" />
      </button>
    </span>
  );

  /** One project: its header folds it; its runs, newest first, a few at a time. */
  const projectGroup = (g: Group) => {
    // A project with nothing to list is just its name: there's nothing to fold.
    if (!g.runs.length)
      return (
        <div key={g.key} class="proj quiet" role="group" aria-label={g.name}>
          <div class={`proj-head ${page && page === g.project?.id ? "here" : ""}`}>
            {g.project ? (
              <button type="button" class="proj-name" title={`Open ${g.name}: ${g.project.repos.join(", ")}`} aria-current={page === g.project.id ? "page" : undefined} onClick={() => go({ view: "project", id: g.project!.id })}>
                <span class="pn">{g.name}</span>
                {g.archived ? <span class="pc">{g.archived} archived</span> : null}
              </button>
            ) : (
              <span class="proj-name">
                <span class="pn">{g.name}</span>
              </span>
            )}
            {g.project ? actions(g.project) : null}
          </div>
        </div>
      );
    const folded = view.collapsed.includes(g.key);
    const showAll = long.has(g.key) || filtering;
    const shown = folded ? g.runs.filter((r) => r.id === current) : showAll ? g.runs : g.runs.slice(0, PER_PROJECT);
    const hidden = folded ? 0 : g.runs.length - shown.length;
    return (
      <div key={g.key} class="proj" role="group" aria-label={g.name}>
        <div class={`proj-head ${page && page === g.project?.id ? "here" : ""}`}>
          <button type="button" class="proj-fold" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} the runs in ${g.name}`} title={folded ? "Show its runs" : "Hide its runs"} onClick={() => toggle(g.key)}>
            <Icon name="chevron" class="caret" />
          </button>
          <button
            type="button"
            class="proj-toggle"
            aria-current={g.project && page === g.project.id ? "page" : undefined}
            title={g.project ? `Open ${g.name}: ${g.project.repos.join(", ")}` : "Runs whose project was deleted"}
            onClick={() => (g.project ? go({ view: "project", id: g.project.id }) : toggle(g.key))}
          >
            <span class="pn">{g.name}</span>
            {folded && g.runs.length ? <span class="pc">{g.runs.length}</span> : null}
          </button>
          {g.project ? actions(g.project) : null}
        </div>
        {shown.map((r) => row(r, short(r.createdAt)))}
        {hidden > 0 ? (
          <button type="button" class="rail-more" onClick={() => setLong(new Set([...long, g.key]))}>
            Show {hidden} more
          </button>
        ) : null}
      </div>
    );
  };

  let body;
  if (view.group === "status") {
    const sections: [string, RunSummary[]][] = [
      ["Needs you", waiting],
      ["Running", list.filter((r) => r.status === "running" && !needsYou(r))],
      ["Recent", list.filter((r) => !r.archived && r.status !== "running" && !needsYou(r))],
      ["Archived", list.filter((r) => r.archived)],
    ];
    const where = (r: RunSummary) => projectFor(r)?.name ?? baseName(r.repo);
    body = sections.map(([title, items]) =>
      items.length ? (
        <section key={title} aria-label={title}>
          <div class="rail-title rail-section">
            {title}
            {title === "Needs you" ? <span class="count">{items.length}</span> : null}
          </div>
          {items.map((r) => row(r, where(r)))}
        </section>
      ) : null,
    );
  } else {
    // Every project, the ones with the newest runs first; runs that need you are listed above them instead.
    const byKey = new Map<string, Group>(projects.value.map((p) => [p.id, { key: p.id, project: p, name: p.name, runs: [], last: 0, archived: 0 }]));
    const groupOf = (r: RunSummary) => {
      const key = projectFor(r)?.id ?? NONE;
      if (!byKey.has(key)) byKey.set(key, { key, name: "No project", runs: [], last: 0, archived: 0 });
      return byKey.get(key)!;
    };
    for (const r of all) {
      const g = groupOf(r);
      g.last = Math.max(g.last, r.createdAt);
      if (r.archived) g.archived++;
    }
    for (const r of list) if (!needsYou(r)) groupOf(r).runs.push(r);
    const groups = [...byKey.values()].sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
    const busy = groups.filter((g) => g.runs.length);
    // Projects with nothing to list fold into one line, unless you're searching (then they're simply left out).
    const quiet = filtering ? [] : groups.filter((g) => !g.runs.length && g.project);
    body = (
      <>
        {waiting.length ? (
          <section aria-label="Needs you">
            <div class="rail-title rail-section">
              Needs you <span class="count">{waiting.length}</span>
            </div>
            {waiting.map((r) => row(r, projectFor(r)?.name ?? baseName(r.repo)))}
          </section>
        ) : null}
        <section aria-label="Projects">
          <div class="rail-title rail-section">
            Projects
            <button
              type="button"
              class="icon-btn"
              aria-label="New project"
              title="New project"
              onClick={() => {
                projectEdit.value = "new";
                projectsOpen.value = true;
              }}
            >
              <Icon name="plus" />
            </button>
          </div>
          {busy.map(projectGroup)}
          {quiet.length ? (
            <>
              <button type="button" class="rail-more quiet" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
                <Icon name="chevron" class="caret" />
                {quiet.length} more project{quiet.length === 1 ? "" : "s"}
              </button>
              {showMore ? quiet.map(projectGroup) : null}
            </>
          ) : null}
        </section>
      </>
    );
  }
  const empty = !list.length;
  return (
    <nav class={`rail ${railOpen.value ? "open" : ""}`} aria-label="Runs">
      <div class="rail-head">
        <a class="brand" href="#/" aria-label="code-flow: new run" onClick={() => (railOpen.value = false)}>
          <span class="brand-name">
            code<span>-flow</span>
          </span>
        </a>
        <button type="button" class="icon-btn rail-close" aria-label="Close menu" onClick={() => (railOpen.value = false)}>
          <Icon name="close" />
        </button>
      </div>
      <button class="btn primary new-run" title="New run (n)" onClick={() => go({ view: "composer" })}>
        <Icon name="plus" /> New run
      </button>
      <div class="rail-search">
        <Icon name="search" />
        <input
          id="run-search"
          class="field"
          type="search"
          placeholder="Search runs"
          aria-label="Search runs (press / to focus)"
          value={f.q}
          onInput={(e) => setRunFilter({ q: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setRunFilter({ q: "" });
              e.currentTarget.blur();
            } else if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              (document.querySelector(".rail .run-item") as HTMLButtonElement | null)?.[e.key === "Enter" ? "click" : "focus"]();
            }
          }}
        />
        <button
          type="button"
          class={`icon-btn ${filtering && !f.q ? "on" : ""}`}
          aria-expanded={showFilters}
          aria-controls="rail-filters"
          aria-label="View and filter"
          title="Group, filter and show archived runs"
          onClick={() => setShowFilters(!showFilters)}
        >
          <Icon name="sliders" />
        </button>
      </div>
      {showFilters ? (
        <div class="rail-filters" id="rail-filters">
          <div class="rf-row">
            <span class="rf-label">Group by</span>
            <div class="segmented small" role="group" aria-label="Group by">
              {(["project", "status"] as const).map((g) => (
                <button key={g} type="button" class={view.group === g ? "on" : ""} aria-pressed={view.group === g} onClick={() => setRailView({ group: g })}>
                  {g === "project" ? "Project" : "Status"}
                </button>
              ))}
            </div>
          </div>
          <div class="chips" role="group" aria-label="Status">
            {STATUS_FILTERS.map(([id, label]) => (
              <button key={id} type="button" class="chip-tpl" aria-pressed={f.status === id} onClick={() => setRunFilter({ status: id })}>
                {label}
              </button>
            ))}
          </div>
          <select class="field" aria-label="Pattern" value={f.pattern} onChange={(e) => setRunFilter({ pattern: e.currentTarget.value })}>
            <option value="">Any pattern</option>
            {patterns.value.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select class="field" aria-label="Agent" value={f.agent} onChange={(e) => setRunFilter({ agent: e.currentTarget.value })}>
            <option value="">Any agent</option>
            {agents.value.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
          <label class="check">
            <input type="checkbox" checked={f.thisRepo} onChange={(e) => setRunFilter({ thisRepo: e.currentTarget.checked })} /> {repo.value ? `Only ${baseName(repo.value)}` : "Only the selected repository"}
          </label>
          <label class="check">
            <input type="checkbox" checked={view.archived} onChange={(e) => setRailView({ archived: e.currentTarget.checked })} /> Show archived runs
          </label>
        </div>
      ) : null}
      <div class="rail-nav">
        <button type="button" class="nav-item" aria-current={route.value.view === "workspace" ? "page" : undefined} title="Repository files, verification and operations" onClick={() => go({ view: "workspace" })}>
          <Icon name="files" /> <span class="t">Workspace</span>
        </button>
        <button type="button" class="nav-item auto-nav" aria-current={route.value.view === "automations" ? "page" : undefined} title="Scheduled and webhook runs, their inbox, and the phone view (a)" onClick={() => go({ view: "automations" })}>
          <Icon name="clock" /> <span class="t">Automations</span>
          {pending ? <span class="count">{pending}</span> : null}
        </button>
        <button type="button" class="nav-item" aria-current={route.value.view === "insights" ? "page" : undefined} title="What runs cost and how they went, per agent and pattern; comparisons; disk use (i)" onClick={() => go({ view: "insights" })}>
          <Icon name="chart" /> <span class="t">Insights</span>
        </button>
      </div>
      {filtering ? (
        <div class="rail-hint">
          {list.length} of {all.length} runs
          <button type="button" onClick={() => setRunFilter({ q: "", status: "all", pattern: "", agent: "", thisRepo: false })}>
            Clear
          </button>
        </div>
      ) : null}
      <div class="rail-list">
        {body}
        {empty ? <div class="rail-empty">{filtering ? "No runs match" : "No runs yet — start one on the right"}</div> : null}
      </div>
      <div class="rail-history" role="region" aria-label="Run history pages">
        <span class="help" role="status">{historyLoading.value ? "Searching history…" : historyTotal.value === null ? "Loading history…" : f.q.trim() ? `${list.length} loaded matches · ${historyTotal.value} in history` : runs.value.size > historyTotal.value ? `${runs.value.size} loaded · ${historyTotal.value} at last refresh` : `${runs.value.size} of ${historyTotal.value} runs loaded`}</span>
        {historyNextCursor.value ? <button type="button" class="btn small" disabled={historyLoading.value || historyLoadingMore.value} onClick={() => void loadOlderRuns()}>{historyLoadingMore.value ? "Loading…" : "Load older runs"}</button> : null}
        {attentionTruncated.value ? <span class="help" role="status">{attentionTotal.value} running or attention items at last refresh. Older attention is paged; use Load older runs to include more.</span> : null}
        {historyError.value ? <div class="help" role="alert">{historyError.value}<button class="btn small" onClick={() => void refreshRuns()}>Retry history</button></div> : null}
        {filtering && !f.q.trim() && historyNextCursor.value ? <span class="help">Filters apply to loaded pages. Load older runs to include more history.</span> : null}
      </div>
      <div class="rail-foot">
        <AgentDots />
        <span class="spacer" />
        <button
          type="button"
          class="btn ghost foot-btn"
          aria-pressed={view.archived}
          title={view.archived ? "Hide archived runs" : "Show archived runs in the list"}
          onClick={() => setRailView({ archived: !view.archived })}
        >
          <Icon name="archive" /> <span class="n">{archivedCount}</span>
          <span class="sr-only"> archived</span>
        </button>
        <Bell />
        <button type="button" class="btn ghost foot-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => (shortcutsOpen.value = true)}>
          <Icon name="keyboard" />
        </button>
      </div>
    </nav>
  );
}

/** The agents' health as dots: each one's color, dimmed when it's missing, warned when it's signed out. */
function AgentDots() {
  const problems: string[] = [];
  const dots = agents.value.map((a) => {
    const h = health.value?.find((x) => x.id === a.id);
    const problem = !a.available || h?.signedIn === false;
    if (problem) problems.push(`${a.displayName}: ${!a.available ? "not installed" : "signed out"}`);
    return <span key={a.id} class={`agent ${a.id} ${a.available ? "" : "off"} ${problem ? "problem" : ""}`} />;
  });
  return (
    <button
      type="button"
      class="agent-status"
      title={`Health: install, sign-in and quota for each CLI\n${agents.value.map((a) => a.displayName).join(", ")}`}
      onClick={() => (healthOpen.value = true)}
    >
      {dots}
      <span class={`as-label ${problems.length ? "bad" : ""}`}>{problems.length ? `${problems.length} ⚠` : "Agents"}</span>
      {problems.length ? <span class="sr-only">{problems.join("; ")}</span> : null}
    </button>
  );
}
