import { automationTiming } from "../src/conversational/automation-intent.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { api, post, copy, enc } from "./lib.js";
import { Icon } from "./icons.js";
import { connection, executionPaused, projects } from "./state.js";
import { computerLabel, HostControl } from "./ssh-projects.js";
import { ScheduleEditor } from "./automations.js";
import { loadAutomations, type Automation } from "./automation-state.js";
import { localTimezone } from "./schedule-draft.js";
import { Sequence, TaskResult } from "./task-conversation.js";
import type { Schedule } from "../src/schedule-rules.js";
import type { TaskSnapshot } from "../src/conversational/service.js";

export function AutomationHostStatus() {
  const ready = connection.value.state === "connected" && !executionPaused.value;
  return <div class={`automation-host ${ready ? "ready" : "unavailable"}`} role="status"><span class="automation-host-icon" aria-hidden="true"><Icon name={ready ? "check" : "clock"}/></span><div><b>{computerLabel()} {ready ? "is ready" : executionPaused.value ? "is paused by policy" : "is offline"}</b><p class="help">Scheduled work runs while Code Flow is running.</p></div>{!ready ? <HostControl/> : null}</div>;
}

/** Saving a setup is not execution authority. Test and enable are separate explicit actions. */
export function AutomationSetup({ chatId, task, mode = "team", onClose }: { chatId: string; task: TaskSnapshot; mode?: "agent" | "team"; onClose: () => void }) {
  const ref = useDialog(true, onClose), creation = useRef(crypto.randomUUID()), testId = useRef(crypto.randomUUID());
  const [name, setName] = useState(task.task.request.split("\n")[0]!.slice(0, 80));
  const suggested = automationTiming(task.task.request, localTimezone());
  const [timing, setTiming] = useState<"once" | "repeat" | "event">(suggested.timing), [schedule, setSchedule] = useState<Schedule>(suggested.schedule);
  const [once, setOnce] = useState(""), [list, setList] = useState(/one at a time|work through/i.test(task.task.request) ? /dependabot|dependency (?:updates|prs|pull requests)/i.test(task.task.request) ? "dependabot" : /security alerts/i.test(task.task.request) ? "alerts" : /issues/i.test(task.task.request) ? "issues" : "" : ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [saved, setSaved] = useState<Automation>(), [evidence, setEvidence] = useState<TaskSnapshot>();
  const [timingProblem, setTimingProblem] = useState<string>();
  const [ready, setReady] = useState(false);
  const p = task.proposal!;
  const fromChat = { chatId, taskId: task.task.id, proposalHash: p.hash };
  useEffect(() => { let alive = true; void post("/api/automations/prepare", fromChat).then(() => { if (alive) setReady(true); }, e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [p.hash]);
  useEffect(() => {
    if (!saved?.id) return; let alive = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => { try { const value = await api<{ snapshot?: TaskSnapshot }>(`/api/automations/${enc(saved.id)}/test-evidence`); if (alive) setEvidence(value.snapshot); } catch (e) { if (alive) setError((e as Error).message); } finally { if (alive) timer = setTimeout(read, 2000); } };
    void read(); return () => { alive = false; clearTimeout(timer); };
  }, [saved?.id]);
  const save = async () => {
    if (saved) return saved;
    const a = await post<Automation>("/api/automations", { operationId: creation.current, name, fromChat, enabled: false, ...(timing === "repeat" ? { schedule } : timing === "event" ? { webhook: true } : { onceAt: new Date(once).getTime() }), ...(list ? { sweep: { kind: list } } : {}) });
    setSaved(a); void loadAutomations(); return a;
  };
  const act = async (kind: "save" | "test" | "enable") => {
    if (busy) return; setBusy(true); setError("");
    try { const a = await save(); if (kind === "test") { await post(`/api/automations/${a.id}/test`, { operationId: testId.current, revision: a.revision }); }
      if (kind === "enable") { await post(`/api/automations/${a.id}`, { enabled: true, revision: a.revision }); void loadAutomations(); onClose(); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const invalid = timing === "repeat" && !!timingProblem || !name.trim() || timing === "once" && (!once || new Date(once).getTime() <= Date.now());
  const run = evidence?.execution;
  const hook = saved?.webhook ? `${location.origin}${saved.hookPath}` : "";
  return <dialog class="automation-setup-dialog" ref={ref} aria-labelledby="automation-setup-title"><header><div><p class="task-kicker">Review setup → Test → Enable</p><h2 id="automation-setup-title">Schedule task</h2></div><button class="icon-btn" aria-label="Close automation setup" onClick={onClose}><Icon name="close"/></button></header>
    <span class="chat-file">{projects.value.find(p => p.id === task.task.project)?.name ?? task.task.project}</span>
    <div class="automation-setup-card"><label>Name<input class="field" value={name} disabled={!!saved} maxLength={80} onInput={e => setName(e.currentTarget.value)}/></label>
    <fieldset disabled={!!saved}><legend>When</legend><div class="automation-timing">{([["once", "Once"], ["repeat", "Repeating"], ["event", "On an event"]] as const).map(([id,label]) => <button type="button" class={`btn ${timing === id ? "primary" : ""}`} aria-pressed={timing === id} onClick={() => setTiming(id)}>{label}</button>)}</div>
    {timing === "repeat" ? <p class="help">{"every" in schedule ? `Every ${schedule.every} minutes` : `${schedule.days?.join(",") === "1,2,3,4,5" ? "Weekdays" : schedule.days?.length ? schedule.days.map(d => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join(", ") : "Daily"} at ${schedule.at} · ${schedule.timezone ?? localTimezone()}`}</p> : null}
    {timing === "repeat" ? <ScheduleEditor automation={{ name, schedule }} zoneRequired onChange={setSchedule} onValidityChange={setTimingProblem} allowOff={false}/> : timing === "once" ? <label>Run at · {localTimezone()}<input class="field" type="datetime-local" value={once} onInput={e => setOnce(e.currentTarget.value)}/></label> : <p class="help">A private webhook starts this exact task. Your endpoint and test request appear after saving.</p>}</fieldset>
    <dl class="automation-summary"><dt>Task</dt><dd>{p.task}</dd><dt>Mode</dt><dd>{mode === "agent" ? "Agent" : "Team"}</dd><dt>Agents</dt><dd>{p.definition.participants.map(agent => <p key={agent.id}>{agent.id} · {agent.provider} · {agent.model || "Provider default"} · {agent.effort || "Default effort"}</p>)}</dd><dt>Outcome</dt><dd>{p.definition.completion.join(" · ")}</dd><dt>Source</dt><dd>Fresh committed HEAD for each occurrence</dd><dt>Checks</dt><dd>{p.definition.check || "No command check in this approach"}</dd><dt>Runs on</dt><dd>{computerLabel()}</dd></dl>
    <details><summary>More options and execution details</summary><label>Work through a list<select class="field" value={list} disabled={!!saved} onChange={e => setList(e.currentTarget.value)}><option value="">No list</option><option value="issues">Open issues, one at a time</option><option value="dependabot">Dependency updates, one at a time</option><option value="alerts">Security alerts, one at a time</option></select></label><p class="help">One item per occurrence. Pausing stops future items and lets current work finish.</p><p class="help">Missed schedules: run once when this computer returns. No replay of every missed occurrence.</p><p class="help">Up to {p.definition.limits.maxInvocations} calls · {p.definition.limits.maxMinutes} minutes · {p.definition.limits.concurrency} simultaneous assignments · {p.definition.limits.maxAttempts} attempts per assignment. Standard managed tools. PR publication and merging require a separate explicit action.</p><p class="help">To change workers, checks, permissions or limits, use Adjust approach in the chat and review a new setup.</p><code>{task.task.repo}</code><Sequence steps={p.definition.steps}/>{p.context.notes || p.context.attachments?.length ? <details><summary>Pinned instructions and files</summary><p class="help">These stay with this setup even if project defaults change.</p><pre class="automation-context">{p.context.notes}</pre>{p.context.attachments?.map(f => <p key={f.name}>{f.name} · {f.bytes} bytes</p>)}</details> : null}</details></div>
    {/\b(?:merge|publish|push|pull requests?|PRs?)\b/i.test(task.task.request) ? <p class="help">Publishing and merging PRs require a separate explicit action.</p> : null}
    <AutomationHostStatus/>
    {saved ? <p class="help" role="status">Setup saved · Paused. You can close this window and return from Automations.</p> : null}
    {run ? <section class="automation-test-result" aria-label="Automation test evidence"><h3>Test · {evidence!.view.label}</h3><p>{evidence!.task.request}</p>{evidence!.view.participants.map(a => <p key={a.id}><b>{a.id}</b> · {a.model} · {a.effort}<br/>{a.participation}</p>)}<p>{run.usage.calls}/{run.limits?.maxInvocations} calls · {(run.usage.ms/60000).toFixed(1)}/{run.limits?.maxMinutes} minutes</p>{run.error ? <p role="alert">{run.error}</p> : null}{run.artifacts.length ? <TaskResult taskId={evidence!.task.id} execution={run}/> : <p class="help">Results appear as agents finish.</p>}<a href={`#/run/${enc(run.id)}`}>Inspect execution evidence</a></section> : null}
    {hook ? <section><h3>Webhook</h3><code>{hook}</code><button class="btn small" onClick={() => copy(hook, "Endpoint copied")}>Copy endpoint</button><button class="btn small" onClick={() => copy(`curl -X POST '${hook}' -H 'Authorization: Bearer ${saved!.token}' -H 'Content-Type: application/json' -d '{"details":"Test event"}'`, "Test request copied")}>Copy test request</button><p class="help">External events are accepted after enabling. The test below runs the saved setup while it stays paused.</p></section> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}<footer class="task-actions"><button class="btn" disabled={busy || invalid || !ready || !!run && run.status === "running"} onClick={() => { if (run && run.status !== "running") testId.current = crypto.randomUUID(); void act("test"); }}>{busy ? "Working…" : timing === "event" ? "Send test event" : "Test now"}</button>{!saved ? <button class="btn ghost" disabled={busy || invalid || !ready} onClick={() => void act("save")}>Save paused</button> : null}<button class="btn primary" disabled={busy || invalid || !ready || run?.status === "running"} onClick={() => void act("enable")}>Enable automation</button></footer><p class="help">Test now starts real bounded work using this approach. Enabling authorizes future occurrences with these settings.</p>
  </dialog>;
}
