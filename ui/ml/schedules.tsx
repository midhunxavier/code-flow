import { cycleTerminal, type Cycle } from "../../src/ml/cycle-model.js";
import type { TrainingSchedule } from "../../src/ml/schedule-model.js";
export interface ScheduleDraft { checkKind: "interval" | "daily" | "weekdays"; checkMinutes: number; checkTime: string; checkTimezone: string; stableMinutes: number; maxScheduledRuns: number }
export const scheduleDefaults = (): ScheduleDraft => ({ checkKind: "interval", checkMinutes: 60, checkTime: "02:00", checkTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, stableMinutes: 1, maxScheduledRuns: 10 });
interface Props {
  draft: ScheduleDraft; edit: (patch: Partial<ScheduleDraft>) => void; disabled: boolean; busy: boolean; ready: boolean;
  source: string; location: string; target: string; iterations: number; trainMinutes: number; elapsedMinutes: number;
  schedules: TrainingSchedule[]; cycles: Cycle[];
  save: () => void; action: (s: TrainingSchedule, action: "pause" | "resume" | "check", stopActive?: boolean) => void;
}
const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
export function SchedulePanel(p: Props) {
  const d = p.draft;
  return <section class="pp-card" aria-label="Scheduled retraining"><h3>Retrain when data changes</h3>
    <p>Check a dataset on a schedule and start a bounded search when a stable new version appears. Works for model training and LoRA fine-tuning on your selected computer.</p>
    <p>Source: <code>{p.source || "Choose and prepare a dataset above"}</code> · {p.location === "controller" ? "Code Flow host" : p.target}. Training: {p.target}.</p>
    <div class="ml-grid">
      <label>Check frequency<select value={d.checkKind} disabled={p.disabled} onChange={e => p.edit({ checkKind: e.currentTarget.value as ScheduleDraft["checkKind"] })}><option value="interval">At an interval</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option></select></label>
      {d.checkKind === "interval" ? <label>Check every (minutes)<input type="number" min="5" max="10080" value={d.checkMinutes} disabled={p.disabled} onInput={e => p.edit({ checkMinutes: Number(e.currentTarget.value) })} /></label> : <><label>Check at<input type="time" value={d.checkTime} disabled={p.disabled} onInput={e => p.edit({ checkTime: e.currentTarget.value })} /></label><label>Schedule time zone<input value={d.checkTimezone} disabled={p.disabled} onInput={e => p.edit({ checkTimezone: e.currentTarget.value })} /></label></>}
      <label>Data stability window (minutes)<input type="number" min="1" max="60" value={d.stableMinutes} disabled={p.disabled} onInput={e => p.edit({ stableMinutes: Number(e.currentTarget.value) })} /></label>
      <label>Maximum scheduled runs<input type="number" min="1" max="100" value={d.maxScheduledRuns} disabled={p.disabled} onInput={e => p.edit({ maxScheduledRuns: Number(e.currentTarget.value) })} /></label>
    </div>
    <p>Each run uses the settings above: at most {count(p.iterations, "iteration")}, {count(p.trainMinutes, "training minute")} and {count(p.elapsedMinutes, "elapsed minute")}. Across {count(d.maxScheduledRuns, "run")}, at most {count(d.maxScheduledRuns * p.trainMinutes, "training minute")} can be reserved.</p>
    <p>The prepared dataset is the starting version; saving does not train it again. Keep the Code Flow host running for checks and new trials. After downtime, one check reads the latest file. Exports stay available for review; schedules do not deploy models.</p>
    <button class="btn primary" disabled={p.disabled || !p.ready || !p.source.trim()} onClick={p.save}>Save retraining schedule</button>
    {p.schedules.map(s => {
      const running = s.runs.some(r => { const c = p.cycles.find(c => c.id === r.cycleId); return c && !cycleTerminal(c); });
      return <article class="ml-detail" key={s.id} aria-label={`${s.name} retraining schedule`}><h4>{s.name} · {s.state}</h4>
        <p><code>{s.source.path}</code> · {s.source.location === "controller" ? "Code Flow host" : s.template.target.name} → {s.template.target.name}</p>
        <p>{"every" in s.cadence ? `Check every ${s.cadence.every} minutes` : `${s.cadence.days ? "Selected weekdays" : "Daily"} at ${s.cadence.at} (${s.cadence.timezone})`} · {s.runs.length} / {s.maxCycles} runs started · {s.stabilitySeconds / 60} minute stability window</p>
        <p>Per run: {count(s.limits.iterations, "iteration")} · {count(s.limits.trainSeconds / 60, "training minute")} · {count(s.limits.elapsedSeconds / 60, "elapsed minute")}. Lifetime training cap: {count(s.maxCycles * s.limits.trainSeconds / 60, "minute")}.</p>
        {s.state === "enabled" ? <p>Next check: {new Date(s.nextAt).toLocaleString()}</p> : null}
        {s.lastCheckedAt ? <p>Last data check: {new Date(s.lastCheckedAt).toLocaleString()}</p> : null}
        <p role="status">{s.pending ? "Checking and preparing data…" : s.reason ?? s.lastOutcome}</p>
        {running ? <p>A scheduled search is active or needs attention. Pausing future checks leaves it running within its original limits.</p> : null}
        <div class="ml-actions">
          {s.state === "enabled" ? <><button class="btn" disabled={p.busy} onClick={() => p.action(s, "pause")}>Pause future runs</button><button class="btn" disabled={p.disabled || !!s.pending} onClick={() => p.action(s, "check")}>Check data now</button></> : null}
          {s.state === "paused" ? <button class="btn" disabled={p.disabled} onClick={() => p.action(s, "resume")}>Resume schedule</button> : null}
          {running ? <button class="btn" disabled={p.busy} onClick={() => p.action(s, "pause", true)}>Pause and stop current search</button> : null}
        </div>
        {s.runs.length ? <details><summary>Scheduled run history</summary><ul>{s.runs.slice().reverse().map(r => { const c = p.cycles.find(c => c.id === r.cycleId); return <li key={r.occurrence}><a href={`#ml-cycle-${r.cycleId}`}>{new Date(r.at).toLocaleString()} · {c?.state ?? "Recorded"}</a> · Data <code>{r.hash.slice(0, 12)}</code></li>; })}</ul></details> : null}
      </article>;
    })}
  </section>;
}
