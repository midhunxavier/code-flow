import { useEffect, useState } from "preact/hooks";
import { automationProject, automations, inbox, loadAutomations } from "./automations.js";
import { Icon } from "./icons.js";
import { ago, baseName, fmtCost, STATUS_TEXT } from "./lib.js";
import { editProject, needsYou, patterns, projectFor, projects, route, runs, runState, selectProject, setTask } from "./state.js";
import type { RunSummary } from "./types.js";

const WEEK = 7 * 86_400_000;
/** Recent results listed before "show all". */
const RECENT = 8;

/**
 * A project's page, opened from its name in the sidebar: what needs you, what's running, recent
 * results, its automations and the week's numbers. The side panel shows the project meanwhile.
 */
export function ProjectView({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => void loadAutomations(), []);
  const p = projects.value.find((x) => x.id === id);
  if (!p) {
    return (
      <div class="composer project-page">
        <p class="help">{projects.value.length ? "This project doesn't exist any more." : "Loading…"}</p>
      </div>
    );
  }
  const list = [...runs.value.values()].filter((r) => projectFor(r)?.id === id).sort((a, b) => b.createdAt - a.createdAt);
  const live = list.filter((r) => !r.archived);
  const waiting = live.filter(needsYou);
  const running = live.filter((r) => r.status === "running" && !needsYou(r));
  const results = live.filter((r) => r.status !== "running" && !needsYou(r));
  const week = list.filter((r) => r.createdAt > Date.now() - WEEK);
  const passed = week.filter((r) => r.status === "done" && r.verdict === "passed").length;
  const cost = week.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0);
  const autos = automations.value.filter((a) => automationProject(a.run)?.id === id);
  const pending = inbox().filter((r) => projectFor(r)?.id === id).length;
  const team = p.defaults ? patterns.value.find((x) => x.id === p.defaults!.pattern)?.name : undefined;

  /** The composer, in this project, with what you typed as the task. */
  const start = () => {
    selectProject(id);
    if (text.trim()) setTask(text.trim());
    route.value = { view: "composer" };
  };

  return (
    <div class="composer project-page">
      <div class="page-head">
        <div class="pp-title">
          <span class="eyebrow">Project</span>
          <h1>{p.name}</h1>
        </div>
        <button type="button" class="btn ghost" onClick={() => editProject(id)} title="Rename, repositories, delete">
          <Icon name="more" /> Edit
        </button>
        <button type="button" class="btn primary" onClick={start} title="A new run in this project">
          <Icon name="plus" /> New run
        </button>
      </div>
      <div class="pp-meta">
        {p.repos.map((r) => (
          <code key={r} title={r}>
            {baseName(r)}
          </code>
        ))}
        {team ? <span class="help">last team: {team}</span> : null}
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
        <Card label="Runs this week" value={String(week.length)} />
        <Card label="Checks passed" value={week.length ? `${passed} of ${week.length}` : "–"} />
        <Card label="API-equivalent" value={cost ? fmtCost(cost) : "–"} hint="Claude's cost, as a measure of size" />
      </div>

      {waiting.length ? <Section title="Needs you" count={waiting.length} runs={waiting} /> : null}
      {running.length ? <Section title="Running" runs={running} /> : null}
      <Section
        title="Recent results"
        runs={all ? results : results.slice(0, RECENT)}
        empty="No results yet. Start a run above."
        more={!all && results.length > RECENT ? () => setAll(true) : undefined}
        moreCount={results.length - RECENT}
      />

      <section class="pp-section">
        <div class="section-title">
          Automations
          {pending ? <span class="count">{pending}</span> : null}
        </div>
        {autos.length ? (
          autos.map((a) => (
            <button key={a.id} type="button" class={`pp-row ${a.enabled ? "" : "off"}`} onClick={() => (route.value = { view: "automations" })}>
              <Icon name="clock" />
              <span class="t">{a.name}</span>
              <span class="m">{a.enabled ? a.scheduleText || (a.webhook ? "webhook" : "") : "paused"}</span>
            </button>
          ))
        ) : (
          <p class="help">None in this project. Save a run as an automation from the composer to run it on a schedule or from a webhook.</p>
        )}
        {pending ? (
          <button type="button" class="btn small" onClick={() => (route.value = { view: "automations" })}>
            {pending} result{pending === 1 ? "" : "s"} in the inbox
          </button>
        ) : null}
      </section>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div class="ins-card" title={hint}>
      <div class="lbl">{label}</div>
      <div class="pp-value">{value}</div>
    </div>
  );
}

function Section({ title, runs, count, empty, more, moreCount = 0 }: { title: string; runs: RunSummary[]; count?: number; empty?: string; more?: () => void; moreCount?: number }) {
  return (
    <section class="pp-section" aria-label={title}>
      <div class="section-title">
        {title}
        {count ? <span class="count">{count}</span> : null}
      </div>
      {runs.length ? runs.map((r) => <RunRow key={r.id} run={r} />) : empty ? <p class="help">{empty}</p> : null}
      {more ? (
        <button type="button" class="rail-more" onClick={more}>
          Show {moreCount} more
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
  const verdict =
    run.awaiting ? (
      <span class="status-pill awaiting">waiting for you</span>
    ) : state === "failing" ? (
      <span class="status-pill failing">check fails</span>
    ) : run.status === "done" && run.verdict === "passed" ? (
      <span class="status-pill done">check passes</span>
    ) : run.status !== "done" ? (
      <span class={`status-pill ${run.status}`}>{STATUS_TEXT[run.status]?.toLowerCase() ?? run.status}</span>
    ) : null;
  return (
    <a class="pp-row" href={`#/run/${encodeURIComponent(run.id)}`} title={run.task}>
      <span class={`dot ${state}`} aria-hidden="true" />
      <span class="t">{run.task.split("\n")[0] || "(no task)"}</span>
      {verdict}
      {merged ? <span class="status-pill">merged</span> : pr ? <span class="status-pill">PR open</span> : null}
      <span class="m">
        {pattern} · {ago(run.createdAt)}
      </span>
    </a>
  );
}
