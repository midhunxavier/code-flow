import { confirmAction } from "./confirm-state.js";
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { journeyAction, journeyPrompt, journeySpec, type Journey, type JourneyAction, type JourneyReplay } from "../src/journeys.js";
import { api, enc, post, showToast } from "./lib.js";
import { attachments, navigate, repo, route, projects, composerProject, openComposer, setPattern, setTask } from "./state.js";

import { intentDraft } from "./experience.js";

import { journeyDraft } from "./composer-draft-fields.js";
export { journeyDraft } from "./composer-draft-fields.js";
export const recording = signal<{ page: string; url: string; width: number; actions: JourneyAction[]; active: boolean; warning?: string } | undefined>();
export function recordAction(page: string, data: unknown) {
  const current = recording.value;
  if (!current || current.page !== page) return;
  try {
    const action = journeyAction(data);
    const actions = [...current.actions];
    if (action.kind === "fill" && actions.at(-1)?.kind === "fill" && actions.at(-1)?.selector === action.selector) actions[actions.length - 1] = action;
    else actions.push(action);
    recording.value = { ...current, actions: actions.slice(0, 30), active: current.active && actions.length < 30, warning: actions.length >= 30 ? "Reached the 30-interaction limit. Review and save this scenario." : current.warning };
  } catch (error) { recording.value = { ...current, warning: (error as Error).message }; }
}
export async function fixJourney(journey: Journey) {
  const view = route.value;
  const viewed = view.view === "project" ? view.id : view.view === "workspace" ? view.project : undefined;
  const matches = projects.value.filter(project => project.repos.includes(journey.repo));
  const destination = matches.find(project => project.id === viewed) ?? matches.find(project => project.id === composerProject.value) ?? (matches.length === 1 ? matches[0] : undefined);
  if (!await openComposer(destination?.id ?? "", { repository: journey.repo })) return;
  journeyDraft.value = journey;
  intentDraft.value = "bug";
  setPattern("pipeline"); setTask(journeyPrompt(journey));
  const text = journeySpec(journey), bytes = new TextEncoder().encode(text);
  attachments.value = [...attachments.value.filter(a => a.name !== "browser-scenario.spec.ts"), { name: "browser-scenario.spec.ts", size: bytes.length, data: btoa(Array.from(bytes, b => String.fromCharCode(b)).join("")) }];
  navigate({ view: "composer", project: destination?.id ?? "" });
}
export function downloadSpec(journey: Journey) {
  const url = URL.createObjectURL(new Blob([journeySpec(journey)], { type: "text/plain" }));
  const link = document.createElement("a"); link.href = url; link.download = "browser-scenario.spec.ts"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function JourneyRecorder({ pageKey, url, width, repository, ready, toggle }: { pageKey: string; url: string; width: number; repository: string; ready: boolean; toggle: (active: boolean) => void | Promise<unknown> }) {
  const [open, setOpen] = useState(false), [title, setTitle] = useState(""), [selector, setSelector] = useState("body"), [expected, setExpected] = useState("");
  const [saved, setSaved] = useState<Journey>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const current = recording.value?.page === pageKey ? recording.value : undefined;
  const change = async () => {
    if(busy) return;
    const active = !current?.active;
    setBusy(true);setError("");
    try {
      if(active) {
        if(!current) {recording.value={page:pageKey,url,width,actions:[],active:true};setSaved(undefined);}
        else recording.value={...current,active:true};
      }
      // Finish queued page input before stopping the recorder so the last click is retained.
      await toggle(active);
      if(!active && recording.value?.page===pageKey) recording.value={...recording.value,active:false};
      setOpen(!active);
    } catch(error) {setError((error as Error).message);}
    finally {setBusy(false);}
  };
  const save = async () => {
    if (!current || busy) return; setBusy(true); setError("");
    try { setSaved(await post<Journey>("/api/journeys", { repo: repository, title, url: current.url, width: current.width, actions: current.actions, expected: { selector, text: expected } })); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <section class="journey-recorder" aria-label="Record a browser scenario">
    <div class="experience-actions"><button class="btn small" disabled={(!ready && !current?.active) || !repository || busy} aria-pressed={!!current?.active} onClick={change}>{current?.active ? "Stop recording" : current?.actions.length ? "Resume recording" : "Record a bug"}</button><button class="btn ghost small" aria-expanded={open} onClick={() => setOpen(!open)}>Scenario {current?.actions.length ? `· ${current.actions.length} actions` : "details"}</button></div>
    {open ? <div class="journey-editor">
      <p class="help">Record clicks, form changes and Enter/Tab/Escape in this local app. Password and credential fields are excluded. Replays use a fresh signed-out browser and can change app data. Review recorded values before saving.</p>
      {current?.warning ? <p role="status">{current.warning}</p> : null}
      {current?.actions.length ? <ol class="journey-actions">{current.actions.map((action, i) => <li key={i}><code>{action.kind} {action.selector}{action.value !== undefined ? ` = ${action.value}` : ""}</code><button class="btn ghost small" disabled={current.active || busy || !!saved} aria-label={`Remove interaction ${i + 1}`} onClick={() => { recording.value = { ...current, actions: current.actions.filter((_, index) => index !== i) }; }}>Remove</button></li>)}</ol> : <p class="help">Start recording, then reproduce the issue in the page below.</p>}
      <label>Scenario title<input class="field" maxLength={160} value={title} onInput={e => setTitle(e.currentTarget.value)} disabled={!!saved} /></label>
      <label>Expected element (CSS selector)<input class="field" maxLength={500} value={selector} onInput={e => setSelector(e.currentTarget.value)} disabled={!!saved} /></label>
      <label>Expected visible text<input class="field" maxLength={2000} value={expected} onInput={e => setExpected(e.currentTarget.value)} disabled={!!saved} /></label>
      <div class="experience-actions"><button class="btn primary small" disabled={busy || !!saved || !!current?.active || !current?.actions.length || !title.trim() || !expected.trim()} onClick={save}>{busy ? "Saving…" : saved ? "Scenario saved" : "Save scenario"}</button>
      {saved ? <><button class="btn small" onClick={() => void fixJourney(saved).catch(e => setError(e.message))}>Prepare verified fix</button><button class="btn small" onClick={() => downloadSpec(saved)}>Export regression test</button></> : null}
      <button class="btn ghost small" disabled={busy} onClick={() => { toggle(false); recording.value = undefined; setSaved(undefined); setError(""); }}>New recording</button></div>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      {saved ? <ScenarioEvidence journey={saved} /> : null}
    </div> : null}
  </section>;
}
export function Walkthrough({ replay }: { replay: JourneyReplay }) {
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(false);
  useEffect(() => { setFrame(0); setPlaying(false); }, [replay.id]);
  useEffect(() => { if (!playing) return; const timer = setInterval(() => setFrame(value => { if (value >= replay.frames.length - 1) { setPlaying(false); return value; } return value + 1; }), 900); return () => clearInterval(timer); }, [playing, replay.id]);
  const current = replay.frames[frame];
  return <div class="walkthrough"><p><b>{replay.status === "passed" ? "Expected text appeared" : "Scenario failed"}</b> · {new Date(replay.at).toLocaleString()}</p>{replay.error ? <p class="msg err">{replay.error}</p> : null}{current ? <><img src={current.image} alt={current.label} /><p>{current.label}</p><div class="experience-actions"><button class="btn small" onClick={() => { setFrame(0); setPlaying(!playing); }}>{playing ? "Pause walkthrough" : "Play walkthrough"}</button><label>Recorded step<input type="range" min={0} max={replay.frames.length - 1} value={frame} onInput={event => { setPlaying(false); setFrame(Number(event.currentTarget.value)); }} /></label></div></> : <p class="help">No screenshots were retained.</p>}</div>;
}
export function ScenarioEvidence({ journey, runId, branch, appUrl }: { journey: Journey; runId?: string; branch?: string; appUrl?: string }) {
  const [replays, setReplays] = useState<JourneyReplay[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; api<{ replays: JourneyReplay[] }>(`/api/journeys/${journey.id}`).then(value => alive && setReplays(value.replays), error => alive && setError(error.message)); return () => { alive = false; }; }, [journey.id]);
  const replay = async () => { if (busy) return; setBusy(true); setError(""); try { const value = await post<JourneyReplay>(`/api/journeys/${journey.id}/replay`, { url: appUrl || journey.url, runId, branch }); setReplays(old => [...old.slice(-3), value]); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } };
  const baseline = replays.filter(item => !item.runId).at(-1), result = replays.filter(item => runId ? item.runId === runId && item.branch === branch : !item.runId).at(-1);
  return <section class="scenario-evidence" aria-label="Browser scenario evidence"><h4>{journey.title}</h4><p class="help">Expected “{journey.expected.text}” in <code>{journey.expected.selector}</code>.</p><div class="experience-actions"><button class="btn small" disabled={busy || !!runId && !appUrl} onClick={replay}>{busy ? "Replaying in Chrome…" : runId ? "Replay scenario on this result" : "Replay original scenario"}</button><button class="btn ghost small" onClick={() => downloadSpec(journey)}>Export regression test</button></div>
    <p class="help">Browser observations are separate from the run's code checks. A running app may include uncommitted changes or an older build. Only the tested assertion is checked; this does not certify the whole feature.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <div class="experience-columns">{runId && baseline ? <div><h4>Before</h4><Walkthrough replay={baseline} /></div> : null}{result ? <div><h4>{runId ? "Result" : "Recorded walkthrough"}</h4><Walkthrough replay={result} /></div> : null}</div>
  </section>;
}
export function ScenarioLibrary({ repository }: { repository: string }) {
  const [items, setItems] = useState<Journey[]>([]), [error, setError] = useState("");
  useEffect(() => { let alive = true; if (repository) api<Journey[]>(`/api/journeys?repo=${enc(repository)}`).then(items => alive && setItems(items), error => alive && setError(error.message)); return () => { alive = false; }; }, [repository]);
  return <details class="pp-card scenario-library"><summary>Recorded scenarios · {items.length}</summary>{error ? <p role="alert">{error}</p> : null}{!items.length ? <p class="help">Open a local app in Browser and choose Record a bug to save a reproducible scenario.</p> : items.map(item => <article key={item.id}><h4>{item.title}</h4><div class="experience-actions"><button class="btn small" onClick={() => void fixJourney(item).catch(e => showToast(e.message))}>Prepare verified fix</button><button class="btn small" onClick={() => downloadSpec(item)}>Export test</button><button class="btn ghost small" onClick={async () => { if (!await confirmAction(`Delete “${item.title}” and its replay screenshots?`, {"title":"Delete recorded scenario?","confirmLabel":"Delete scenario","danger":true})) return; try { await api(`/api/journeys/${item.id}`, { method: "DELETE" }); setItems(items.filter(value => value.id !== item.id)); } catch (e) { setError((e as Error).message); } }}>Delete scenario</button></div></article>)}</details>;
}
