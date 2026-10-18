import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { automationProject, automations, inbox, loadAutomations } from "./automations.js";
import { Icon } from "./icons.js";
import { ago, baseName, fmtCost, STATUS_TEXT } from "./lib.js";
import { editProject, needsYou, patterns, projectFor, projects, projectsLoaded, route, runs, runState, selectProject, setTask } from "./state.js";
import type { RunSummary } from "./types.js";

const WEEK = 7 * 86_400_000;
/** Recent results listed before "show all". */
const RECENT = 8;
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

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
      <div class="project-page">
        <p class="help">{projectsLoaded.value ? "This project doesn't exist any more." : "Loading…"}</p>
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
  const archived = list.length - live.length;

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
        <Card label="Runs this week" value={String(week.length)} />
        <Card label="Checks passed" value={week.length ? `${passed} of ${week.length}` : "–"} />
        <Card label="API-equivalent" value={cost ? fmtCost(cost) : "–"} hint="Claude's cost, as a measure of size" />
      </div>

      <div class="pp-layout">
        <div class="pp-main">
          {waiting.length ? <Section title="Needs you" count={waiting.length} runs={waiting} attention /> : null}
          {running.length ? <Section title="Running" count={running.length} runs={running} /> : null}
          <Section
            title="Recent results"
            runs={all ? results : results.slice(0, RECENT)}
            empty="No results yet. Start a run above."
            more={!all && results.length > RECENT ? () => setAll(true) : undefined}
            moreCount={results.length - RECENT}
          />
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
              <dt>Last team</dt>
              <dd>{team ?? <span class="muted">None yet</span>}</dd>
              <dt>Runs</dt>
              <dd>
                {plural(live.length, "run")}
                {archived ? <span class="muted"> · {archived} archived</span> : null}
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
                  <button key={a.id} type="button" class={`pp-row ${a.enabled ? "" : "off"}`} onClick={() => (route.value = { view: "settings", section: "automations" })}>
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
                <button type="button" class="btn small" onClick={() => (route.value = { view: "settings", section: "automations" })}>
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

function Section({ title, runs, count, empty, more, moreCount = 0, attention = false }: { title: string; runs: RunSummary[]; count?: number; empty?: string; more?: () => void; moreCount?: number; attention?: boolean }) {
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
        <button type="button" class="pp-more" onClick={more}>
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
  const pill = (cls: string, text: ComponentChildren) => <span class={`status-pill ${cls}`}>{text}</span>;
  const verdict = run.awaiting
    ? pill("awaiting", "Waiting for you")
    : state === "failing"
      ? pill("failing", "Check fails")
      : run.status === "done" && run.verdict === "passed"
        ? pill("done", "Check passes")
        : run.status !== "done"
          ? pill(run.status, STATUS_TEXT[run.status] ?? run.status)
          : null;
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
