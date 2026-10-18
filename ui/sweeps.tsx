import { useEffect, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { startProblem, teamSentence } from "./composer.js";
import { Icon } from "./icons.js";
import { api, enc, post, showToast } from "./lib.js";
import {
  agentSettings,
  baseRef,
  checkCmd,
  limits,
  optionsFor,
  patterns,
  refreshRuns,
  repo,
  repoConfig,
  roleModels,
  rolesFor,
  route,
  setPattern,
  setupCmd,
  sweepPicker,
  loadProjects,
  target,
  trust,
} from "./state.js";
import type { SweepItem, SweepList } from "./types.js";

/** Most runs one sweep starts (the server holds the same limit). */
const MAX_SWEEP = 25;

interface SweepOutcome {
  started: { key: string; id: string }[];
  skipped: { key: string; why: string }[];
  failed: { key: string; error: string }[];
  automation?: string;
}

const sevClass = (s?: string) => (/^(critical|high|error)$/i.test(s ?? "") ? "high" : /^(medium|warning)$/i.test(s ?? "") ? "medium" : "");

/**
 * A sweep: the open issues, Dependabot's PRs or the security alerts, each with a checkbox. The
 * picked ones start one run each with the team you set up in the composer, and their results
 * wait in the inbox.
 */
export function SweepDialog() {
  const t = sweepPicker.value;
  const ref = useDialog(!!t, () => (sweepPicker.value = null));
  const [list, setList] = useState<SweepList | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [at, setAt] = useState("07:00");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!t) return;
    setList(null);
    setError("");
    setFilter("");
    setRepeat(false);
    if (!repo.value) return setError("Choose a repository first");
    api<SweepList>(`/api/github/sweep?repo=${enc(repo.value)}&kind=${t.sweep}`).then(
      (l) => {
        setList(l);
        setPicked(new Set(l.items.filter((i) => i.selected).map((i) => i.key)));
      },
      (e) => setError(e.message),
    );
  }, [t]);

  const p = t ? patterns.value.find((x) => x.id === t.pattern) : undefined;
  const roles = rolesFor(p);
  const items = list?.items ?? [];
  const pickable = (i: SweepItem) => !i.manual && !!i.source && !!i.task;
  const chosen = items.filter((i) => picked.has(i.key) && pickable(i));
  const q = filter.trim().toLowerCase();
  const shown = items.filter((i) => !q || `${i.ref} ${i.title} ${i.detail} ${i.note ?? ""}`.toLowerCase().includes(q));
  const problem = !p ? "" : startProblem(p, roles, false) || (chosen.length > MAX_SWEEP ? `Pick at most ${MAX_SWEEP}; the rest can go in a later sweep` : "");

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };
  const pickShown = (on: boolean) => {
    const next = new Set(picked);
    for (const i of shown) if (pickable(i)) on ? next.add(i.key) : next.delete(i.key);
    setPicked(next);
  };

  const start = async () => {
    if (!t || !p || problem || !chosen.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const out = await post<SweepOutcome>("/api/sweeps", {
        kind: t.sweep,
        name: t.name,
        max: 5,
        schedule: repeat ? { at } : undefined,
        run: {
          repo: repo.value,
          project: target.value.project?.id,
          pattern: p.id,
          roles,
          options: optionsFor(p),
          baseRef: baseRef.value,
          agentSettings: agentSettings.value,
          roleSettings: roleModels.value[p.id] ?? {},
          trust: trust.value,
          loop: { check: checkCmd.value.trim(), setup: setupCmd.value.trim(), maxMinutes: limits.value.maxMinutes, maxSteps: limits.value.maxSteps, copy: repoConfig.value?.config.copy },
        },
        items: chosen.map((i) => ({ key: i.key, task: i.task, source: i.source })),
      });
      await Promise.all([refreshRuns(), loadProjects()]);
      const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
      showToast(
        [
          `Started ${n(out.started.length, "run")}`,
          out.skipped.length ? `${out.skipped.length} already had one` : "",
          out.failed.length ? `${out.failed.length} couldn't start (${out.failed[0]!.key}: ${out.failed[0]!.error})` : "",
          out.automation ? "saved as a daily sweep" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        out.failed.length ? 8000 : 5000,
      );
      sweepPicker.value = null;
      route.value = { view: "settings", section: "automations" };
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog class="picker sweep-dialog" ref={ref} aria-labelledby="sweep-title">
      {t ? (
        <div class="picker-inner">
          <div class="picker-head">
            <h3 id="sweep-title">
              <Icon name="layers" /> {t.name}
            </h3>
            <div class="help">{t.description}</div>
            <div class="row">
              <input class="field" placeholder="Filter by number, title, label, severity…" aria-label="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
            </div>
            {list ? (
              <div class="sweep-tools">
                <span>
                  <b>{chosen.length}</b> of {items.filter(pickable).length} picked
                </span>
                <button type="button" class="linkish" onClick={() => pickShown(true)}>
                  Pick all{q ? " shown" : ""}
                </button>
                <button type="button" class="linkish" onClick={() => pickShown(false)}>
                  None
                </button>
              </div>
            ) : null}
          </div>
          <div class="picker-list sweep-list">
            {error ? <div class="msg err pad">{error}</div> : null}
            {list?.notices.map((n) => (
              <div key={n} class="config-note bad">
                {n}
              </div>
            ))}
            {!list && !error ? <div class="help pad">Loading from GitHub…</div> : null}
            {list && !items.length ? <div class="help pad">Nothing open — all clear.</div> : null}
            {list && items.length && !shown.length ? <div class="help pad">Nothing matches.</div> : null}
            {shown.map((i) => (
              <label key={i.key} class={`sweep-item ${pickable(i) ? "" : "manual"} ${picked.has(i.key) && pickable(i) ? "on" : ""}`}>
                <input type="checkbox" checked={picked.has(i.key) && pickable(i)} disabled={!pickable(i)} onChange={() => toggle(i.key)} />
                <span class="si-main">
                  <span class="si-title">
                    <span class="si-ref">{i.ref}</span> {i.title}
                  </span>
                  <span class="si-detail">
                    {i.severity ? <span class={`sev ${sevClass(i.severity)}`}>{i.severity}</span> : null} {i.detail}
                  </span>
                  {i.note ? (
                    <span class={`si-note ${i.manual ? "warn" : ""}`}>
                      {i.note}
                      {i.existingRun ? (
                        <>
                          {" · "}
                          <a href={`#/run/${i.existingRun}`} onClick={() => (sweepPicker.value = null)}>
                            open it
                          </a>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </span>
                <a class="si-link" href={i.url} target="_blank" rel="noreferrer" title="Open on GitHub" onClick={(e) => e.stopPropagation()}>
                  ↗
                </a>
              </label>
            ))}
          </div>
          <div class="sweep-how">
            {p ? (
              <div class="help">
                Each runs <b>{p.name}</b>: {teamSentence(p, roles, false)}.{" "}
                <button
                  type="button"
                  class="linkish"
                  onClick={() => {
                    setPattern(p.id);
                    sweepPicker.value = null;
                  }}
                >
                  Change the team
                </button>
              </div>
            ) : null}
            <label class="check">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.currentTarget.checked)} /> Also check every day at{" "}
              <input class="field inline" type="time" value={at} aria-label="Time of day" disabled={!repeat} onInput={(e) => setAt(e.currentTarget.value || "07:00")} /> and start runs for new ones (up to 5 each time)
            </label>
          </div>
          <div class="picker-foot">
            <span class="ps">{problem || "Results wait in the inbox for you to approve. Nothing is merged automatically."}</span>
            <button class="btn" type="button" onClick={() => (sweepPicker.value = null)}>
              Cancel
            </button>
            <button class="btn primary" type="button" disabled={!!problem || !chosen.length || busy} onClick={start}>
              {busy ? "Starting…" : `Start ${chosen.length} run${chosen.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
