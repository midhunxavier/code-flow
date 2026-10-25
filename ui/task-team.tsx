import { useEffect, useState } from "preact/hooks";
import type { TaskTeamConfig } from "../src/task-team.js";
import type { TeamTemplate } from "../src/team-templates.js";
import { chatTaskId } from "../src/chat-family.js";
import { useDialog } from "./app.js";
import { ModelSelect } from "./model-select.js";
import { ChatControls } from "./chat-controls.js";
import { api, post, store, SHORT } from "./lib.js";
import { agents, runs, catalogs, health, composerRunOptions } from "./state.js";
import type { AgentId, RunSummary } from "./types.js";

function teamProviderProblem(id: AgentId, nativeAgy: boolean): string | undefined {
  if (!agents.value.find(agent => agent.id === id)?.available) return "CLI is not installed";
  const diagnostic = health.value?.find(entry => entry.id === id);
  if (diagnostic?.signedIn === false) return "Sign in to this provider first";
  if (diagnostic?.compatible === false) return "Update this provider's CLI";
  if (id === "agy" && !nativeAgy && diagnostic?.managedCompatible !== true) {
    return diagnostic ? "This Antigravity version or login is not compatible with AI teams" : "Checking Antigravity compatibility…";
  }
}

export function defaultTaskTeam(lead: AgentId): TaskTeamConfig {
  const saved = store.json<TaskTeamConfig | null>("taskTeamPreferences", null);
  return saved ? { ...saved, enabled: false, coordinator: lead } : { enabled: false, preset: "adaptive", coordinator: lead, providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 20, maxMinutes: 30, approvePlan: false };
}

export function TaskTeamControl({ run, config, lead, project, onChange, disabledReason, toolApprovals }: { run?: RunSummary; config?: TaskTeamConfig; lead: AgentId; project?: string; onChange?: (config: TaskTeamConfig) => void; disabledReason?: string; toolApprovals?: boolean }) {
  const [open, setOpen] = useState(false);
  const owner = run ? runs.value.get(chatTaskId(run)) ?? run : undefined;
  const value = owner?.taskTeam ?? config;
  const active = run ? [...runs.value.values()].find(child => child.taskExecution?.taskId === chatTaskId(run) && child.status === "running") : undefined;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (run && (run.chatLink?.kind === "side" || run.checkpointOnFinish || run.trigger || run.loop.remoteWorker || run.loop.agentContainer)) return null;
  const save = async (next: TaskTeamConfig) => {
    setBusy(true); setError("");
    try {
      if (run) { const updated = await post<RunSummary>(`/api/runs/${run.id}/task-team`, next); runs.value = new Map(runs.value).set(updated.id, updated); }
      else onChange?.(next);
      store.set("taskTeamPreferences", JSON.stringify(next));
    } catch (error) { setError((error as Error).message); throw error; }
    finally { setBusy(false); }
  };
  const enabled = !!value?.enabled && !disabledReason;
  const next = value ?? defaultTaskTeam(lead);
  const nativeAgy = (owner ? owner.permissions?.antigravityExecution : composerRunOptions.value.antigravityExecution) === "native";
  const options = agents.value.filter(agent => !teamProviderProblem(agent.id, nativeAgy) && ["claude", "codex", "agy"].includes(agent.id)).flatMap(agent => {
    const catalog = catalogs.value[agent.id];
    return [{ id: `${agent.id}:`, label: `${SHORT[agent.id]} · Default model` }, ...catalog && !("error" in catalog) ? catalog.models.map(model => ({ id: `${agent.id}:${model.id}`, label: `${SHORT[agent.id]} · ${model.label}` })) : []];
  });
  return <>
    <button class={`btn ghost task-team-toggle ${enabled ? "on" : ""}`} type="button" role="switch" aria-label="AI team" aria-checked={enabled} disabled={!!disabledReason || busy} title={disabledReason ?? (enabled ? "Turn AI team off" : "Turn AI team on")} onClick={() => { void save({ ...next, enabled: !enabled }).catch(() => {}); }}><span class="team-switch-track" aria-hidden="true"><span /></span>AI team <span class="team-state">{active ? enabled ? "Working" : "Stopping…" : enabled ? "On" : "Off"}</span></button>
    {enabled ? <><ModelSelect compact label="Lead model" title="Team lead model" value={`${next.coordinator}:${next.settings[next.coordinator]?.model ?? ""}`} options={options} disabled={busy} onChange={value => {
      const colon = value.indexOf(":"), coordinator = value.slice(0, colon) as AgentId, model = value.slice(colon + 1);
      void save({ ...next, coordinator, settings: { ...next.settings, [coordinator]: { model } } }).catch(() => {});
    }} /><button type="button" class="btn ghost small task-team-advanced" onClick={() => setOpen(true)}>Advanced</button></> : null}
    {error ? <span class="help" role="alert">{error}</span> : null}
    {open ? <TaskTeamDialog value={next} project={project ?? run?.project} nativeAgy={nativeAgy} toolApprovals={toolApprovals ?? !!run?.approvals.tools} running={run?.status === "running"} onClose={() => setOpen(false)} onSave={async next => { await save(next); setOpen(false); }} /> : null}
  </>;
}

function TaskTeamDialog({ value, project, running, toolApprovals, nativeAgy, onSave, onClose }: { value: TaskTeamConfig; project?: string; running?: boolean; toolApprovals: boolean; nativeAgy: boolean; onSave: (config: TaskTeamConfig) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(() => structuredClone(value));
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const ref = useDialog(true, () => { if (!busy) onClose(); });
  const choices = agents.value.filter(agent => ["claude", "codex", "agy"].includes(agent.id));
  useEffect(() => { let live = true; void api<{ templates: TeamTemplate[] }>(`/api/team-templates${project ? `?project=${encodeURIComponent(project)}` : ""}`).then(result => { if (live) setTemplates(result.templates.filter(t => t.workflow !== "solo")); }, error => { if (live) setError(error.message); }); return () => { live = false; }; }, [project]);
  const update = (patch: Partial<TaskTeamConfig>) => setDraft({ ...draft, ...patch });
  const selected = templates.find(template => template.id === draft.template?.id);
  const permissionProblem = draft.enabled && toolApprovals && (draft.coordinator === "agy" || draft.providers.includes("agy")) ? "This task requires interactive tool approvals, which Antigravity does not support. Choose Claude or Codex, or change the task's permissions before enabling Antigravity." : "";
  const blockedProvider = draft.enabled ? [draft.coordinator, ...draft.providers].find(id => teamProviderProblem(id, nativeAgy)) : undefined;
  const availabilityProblem = blockedProvider ? `${SHORT[blockedProvider]}: ${teamProviderProblem(blockedProvider, nativeAgy)}. Choose an available provider.` : "";
  const save = async () => { setBusy(true); setError(""); try { await onSave(draft); } catch (error) { setError((error as Error).message); setBusy(false); } };
  return <dialog ref={ref} class="picker task-team-dialog" aria-labelledby="task-team-title"><div class="picker-inner">
    <div class="picker-head"><div><h3 id="task-team-title">AI team setup</h3><p class="help">Your agent answers questions directly and brings in AI teammates for work.</p></div><label class="task-team-switch"><span>{draft.enabled ? "AI team enabled" : "AI team disabled"}</span><input type="checkbox" role="switch" aria-label="Enable AI team" disabled={busy} checked={draft.enabled} onChange={event => update({ enabled: event.currentTarget.checked })} /></label></div>
    <div class="dialog-body">
      <fieldset disabled={busy}>
        <label class="lbl">Template<select class="field" aria-label="Team template" value={draft.template ? `saved:${draft.template.id}` : draft.preset} onChange={event => {
          const id = event.currentTarget.value, template = templates.find(t => `saved:${t.id}` === id);
          if (!template) update({ preset: id as TaskTeamConfig["preset"], template: undefined });
          else {
            const prefs = template.preferences;
            update({ template: { id: template.id, version: template.version, inputs: {} }, ...(prefs ? { maxMembers: typeof prefs.options.maxMembers === "number" ? Math.max(3, Math.min(6, prefs.options.maxMembers)) : draft.maxMembers, coordinator: (prefs.roles.coordinator?.[0] ?? prefs.roles.planner?.[0] ?? draft.coordinator) as AgentId, providers: [...new Set(Object.values(prefs.roles).flat().filter(id => ["claude", "codex", "agy"].includes(id)))] as AgentId[], settings: { ...draft.settings, ...prefs.agentSettings, ...prefs.roleSettings.pool, ...prefs.roleSettings.coordinator } } : {}) });
          }
        }}><optgroup label="Built-in"><option value="adaptive">Adaptive team</option><option value="build-review">Build and review</option><option value="investigate">Research and investigate</option></optgroup>{templates.length ? <optgroup label="Saved teams and workflows">{templates.map(t => <option value={`saved:${t.id}`} key={t.id}>{t.name} · v{t.version}</option>)}</optgroup> : null}</select></label>
        <p class="help">{selected?.description ?? (draft.preset === "investigate" ? "Investigate and report findings without changing source files." : "Assign useful work to selected providers and review the combined result.")}</p>
        {selected?.parameters.filter(name => name !== "task").map(name => <label class="lbl" key={name}>{name}<input class="field" value={draft.template?.inputs[name] ?? ""} onInput={event => update({ template: { ...draft.template!, inputs: { ...draft.template!.inputs, [name]: event.currentTarget.value } } })} /></label>)}
        <label class="lbl">Team lead<select class="field" aria-label="Team lead" value={draft.coordinator} onChange={event => update({ coordinator: event.currentTarget.value as AgentId })}>{choices.map(agent => <option value={agent.id} disabled={!!teamProviderProblem(agent.id, nativeAgy)} key={agent.id}>{agent.displayName}{teamProviderProblem(agent.id, nativeAgy) ? " · unavailable" : ""}</option>)}</select></label>
        <p class="help">Coordinates this team and gives the final answer. If unavailable, another selected provider can continue with the conversation context.</p>
        <div class="task-team-members" role="group" aria-label="Team providers">{choices.map(agent => {
          const selected = draft.providers.includes(agent.id), needed = selected || draft.coordinator === agent.id;
          const problem = teamProviderProblem(agent.id, nativeAgy);
          return <div class="task-team-member" key={agent.id}><label><input type="checkbox" aria-label={`Use ${agent.displayName}`} checked={selected} disabled={!!problem && !selected} onChange={event => update({ providers: event.currentTarget.checked ? [...draft.providers, agent.id] : draft.providers.filter(id => id !== agent.id) })} /><b>{agent.displayName}</b><span class="help">{problem ?? (selected ? "Selected teammate" : draft.coordinator === agent.id ? "Team lead" : "Not selected")}</span></label>{needed && !problem ? <ChatControls agent={agent.id} settings={draft.settings[agent.id] ?? {}} onSettings={settings => update({ settings: { ...draft.settings, [agent.id]: settings } })} permissions={{ trust: "standard", tools: false }} onPermissions={() => {}} showPermissions={false} /> : null}</div>;
        })}</div>
        {draft.providers.includes("agy") || draft.coordinator === "agy" ? <p class="help">Antigravity supports workspace files, live teammate messages and the shared browser. Code Flow runs terminal checks. Computer actions require Full access; interactive tool approvals are unavailable. Side chats use enforced read-only isolation.</p> : null}
        <details class="task-team-limits"><summary>Limits and approval</summary><div class="task-team-limit-grid">{([['maxMembers', 'Maximum members', 3, 6], ['maxCalls', 'Maximum calls', 4, 200], ['maxMinutes', 'Maximum minutes', 1, 720]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input class="field" type="number" min={min} max={max} value={draft[key]} onInput={event => update({ [key]: Number(event.currentTarget.value) })} /></label>)}</div><label><input type="checkbox" checked={draft.approvePlan} onChange={event => update({ approvePlan: event.currentTarget.checked })} /> Let me approve the plan before teammates start</label></details>
        {running ? <p class="help" role="status">New settings apply on Resume or the next conversation turn. Turning AI team off stops its active execution, preserves partial work, and hands control back to your agent.</p> : <p class="help">Turning AI team off keeps these settings for next time. Existing task permissions stay in effect.</p>}
      </fieldset>
      {error || permissionProblem || availabilityProblem ? <p class="msg err" role="alert">{error || permissionProblem || availabilityProblem}</p> : null}
    </div><div class="picker-foot"><button class="btn" disabled={busy} onClick={onClose}>Cancel</button><button class="btn primary" disabled={busy || !draft.providers.length || !!permissionProblem || !!availabilityProblem} onClick={() => void save()}>{busy ? "Saving…" : "Apply team settings"}</button></div>
  </div></dialog>;
}

export function TaskTeamActivity({ run, turns = run.teamTurns ?? [] }: { run: RunSummary; turns?: NonNullable<RunSummary["teamTurns"]> }) {
  if (!turns.length) return null;
  return <section class="task-team-activity" aria-label="Team activity">{turns.map(turn => {
    const child = runs.value.get(turn.executionId);
    const active = child?.status === "running", members = child?.team?.members ?? [];
    const updating = run.notes.some(note => note.teamDelivery?.executionId === turn.executionId && ["received", "replanning"].includes(note.teamDelivery.state));
    const completed = child?.team?.tasks.filter(task => task.status === "completed" || task.status === "submitted").length ?? 0;
    return <div key={turn.key}><details class="task-team-disclosure"><summary><span class={`task-team-dot ${active ? "working" : ""}`} />{updating ? "Updating the team…" : turn.state === "stopping" ? "Handing back to your agent…" : active ? child?.awaiting ? "Plan needs approval" : child?.team?.status === "planning" ? "Planning" : "Working" : turn.resolutionReview?.approved === false ? "Changes applied · review needs attention" : turn.resolutionReview?.error ? "Changes applied · review needs refresh" : turn.resolutionCheck?.ok === false ? "Changes applied · check needs attention" : turn.state === "preserved" ? "Work preserved · needs attention" : child?.status === "done" ? turn.reviewStale ? "Changes applied · review needs refresh" : "Finished" : "Stopped · work preserved"}<span class="task-team-count">{child?.team?.tasks.length ? `${completed}/${child.team.tasks.length} complete` : ""}</span><span class="task-team-expand">View activity</span></summary><div class="task-team-progress">
      {members.length ? <div>{members.map(member => <span class="chip-ctx" key={member.id}>{member.name} · {SHORT[member.provider]} · {member.status ?? "idle"}</span>)}</div> : null}
      {child?.team?.tasks.map(task => <div key={task.id}>{task.title}<span class="help"> · {task.status ?? "planned"}</span></div>)}
      {child?.team?.providerChanges?.map(change => <p class="help">{change.role === "reviewer" ? "Review" : change.role === "coordinator" ? "Coordination" : "Assignment"} continued with {SHORT[change.to]} after {SHORT[change.from]} became unavailable.</p>)}
      {child?.error ? <p class="help">{child.error}</p> : null}
      <TaskConflictResolution run={run} execution={turn.executionId} />
      {turn.resolutionCheck ? <details><summary>Combined workspace check: {turn.resolutionCheck.ok ? "passed" : "failed"}</summary><pre class="task-check-output">{turn.resolutionCheck.output || "Check completed without output."}</pre></details> : null}
      {turn.resolutionReview ? <div class="help" role="status">{turn.resolutionReview.error ?? (turn.resolutionReview.approved === undefined ? "Reviewing combined changes…" : turn.resolutionReview.approved ? "Combined changes reviewed" : "Review found changes to address")}{turn.resolutionReview.issues?.map(issue => <p>{issue.file}: {issue.problem}</p>)}</div> : null}
      {turn.reviewStale ? <p class="help">Independent review covered the team's original result. Your combined edits need a fresh review; a passing check does not replace it.</p> : null}
      {child?.awaiting ? <p class="help">Review and approve the plan in Team details to continue.</p> : null}
      <a class="btn small" href={`#/run/${turn.executionId}`}>Team details</a>
    </div></details>{!active && run.status === "done" && run.teamTurns?.at(-1)?.key === turn.key ? <TaskTeamRecovery run={run} execution={turn.executionId} stopped={!!child && child.status !== "done"} reviewStale={!!turn.reviewStale || !!turn.resolutionReview?.error} checkFailed={turn.resolutionCheck?.ok === false} conflicts={!!turn.reconciliation} /> : null}</div>;
  })}</section>;
}

function TaskTeamRecovery({ run, execution, stopped, checkFailed, conflicts, reviewStale }: { run: RunSummary; execution: string; stopped: boolean; checkFailed: boolean; conflicts: boolean; reviewStale: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (conflicts || !stopped && !checkFailed && !reviewStale) return null;
  const act = async () => { setBusy(true); setError(""); try { await post(`/api/runs/${run.id}/${stopped ? "team-resume" : checkFailed ? "team-recheck" : "team-review"}`, { execution }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div class="task-team-recovery"><button class="btn small" disabled={busy} onClick={() => void act()}>{busy ? "Continuing…" : stopped ? "Resume team" : checkFailed ? "Check again" : "Refresh review"}</button>{error ? <span class="help" role="alert">{error}</span> : null}</div>;
}

type ConflictVersion = { exists: boolean; binary?: boolean; text: string };
type ConflictFile = { path: string; base: ConflictVersion; current: ConflictVersion; team: ConflictVersion };
function TaskConflictResolution({ run, execution }: { run: RunSummary; execution: string }) {
  const [open, setOpen] = useState(false);
  if (!open && !run.teamTurns?.find(turn => turn.executionId === execution)?.reconciliation) return null;
  return <><p class="help">Some of your edits overlap the team’s changes. Both versions are saved.</p><button class="btn small" disabled={run.status === "running"} onClick={() => setOpen(true)}>Resolve conflicts</button>{open ? <TaskConflictDialog run={run} execution={execution} close={() => setOpen(false)} /> : null}</>;
}
function TaskConflictDialog({ run, execution, close }: { run: RunSummary; execution: string; close: () => void }) {
  const endpoint = `/api/runs/${run.id}/team-resolution?execution=${encodeURIComponent(execution)}`;
  const [data, setData] = useState<{ current: string; files: ConflictFile[] }>();
  const [index, setIndex] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useDialog(true, () => { if (!busy) close(); });
  const [choices, setChoices] = useState<Record<string, { choice: "current" | "team" | "edited"; text?: string }>>({});
  const load = async () => { setBusy(true); try { setData(await api(endpoint)); setChoices({}); setIndex(0); setError(""); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, []);
  const file = data?.files[index], choice = file ? choices[file.path] : undefined;
  const apply = async () => { if (!data) return; setBusy(true); try { await post(endpoint, { current: data.current, choices: data.files.map(file => ({ path: file.path, ...choices[file.path] })) }); close(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <dialog ref={dialog} class="picker task-conflict-dialog" aria-label="Resolve team changes"><div class="picker-head"><h3>Resolve changes</h3><button class="icon-btn" aria-label="Close conflict resolution" disabled={busy} onClick={close}>×</button></div><div class="picker-body">
    <p>Your edits and the team’s work are preserved. Choose a version for each conflict, or edit the combined result. Other changes merge automatically.</p>
    {data?.files.length ? <select class="field" aria-label="Conflicting file" disabled={busy} value={index} onChange={event => setIndex(Number(event.currentTarget.value))}>{data.files.map((file, i) => <option value={i}>{choices[file.path] ? "✓ " : ""}{file.path}</option>)}</select> : data ? <p>No conflicts remain. Apply to merge the remaining changes.</p> : <p>Comparing changes…</p>}
    {file ? <><div class="task-conflict-versions">{([['base', 'Starting version'], ['current', 'Your version'], ['team', 'Team version']] as const).map(([key, title]) => <section><h3>{title}</h3><pre>{!file[key].exists ? "File deleted / absent" : file[key].binary ? "Binary file or symbolic link — choose a version" : file[key].text}</pre></section>)}</div><div class="row">{([['current', 'Keep yours'], ['team', 'Use team version'], ['edited', 'Edit result']] as const).map(([key, title]) => <button class={`btn small ${choice?.choice === key ? "primary" : ""}`} aria-pressed={choice?.choice === key} disabled={busy || key === "edited" && (file.current.binary || file.team.binary)} onClick={() => setChoices({ ...choices, [file.path]: { choice: key, ...(key === "edited" ? { text: choice?.text ?? file.current.text } : {}) } })}>{title}</button>)}</div>{choice?.choice === "edited" ? <textarea class="field task-conflict-editor" aria-label="Resolved file contents" disabled={busy} value={choice.text} onInput={event => setChoices({ ...choices, [file.path]: { choice: "edited", text: event.currentTarget.value } })} /> : null}</> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div><div class="picker-foot"><button class="btn" disabled={busy} onClick={() => void load()}>Refresh comparison</button><button class="btn primary" disabled={busy || !data || data.files.some(file => !choices[file.path])} onClick={() => void apply()}>{busy ? "Working…" : "Apply and check"}</button></div></dialog>;
}

/** Keep progress visible beside the composer even when the user has scrolled past the history. */
export function TaskTeamStatus({ run }: { run: RunSummary }) {
  if (run.chatLink?.kind === "side") return null;
  const active = [...runs.value.values()].find(child => child.taskExecution?.taskId === chatTaskId(run) && child.status === "running");
  if (!active) return null;
  const owner = runs.value.get(chatTaskId(run));
  const updating = run.notes.some(note => note.teamDelivery?.executionId === active.id && ["received", "replanning"].includes(note.teamDelivery.state));
  const working = active.team?.members.filter(member => member.status === "working").length ?? 0;
  return <div class="task-team-live" role="status"><span>{updating ? "Updating the team with your message…" : owner?.taskTeam?.enabled === false ? "Stopping team · preserving work…" : active.awaiting ? "Team plan needs your approval" : active.team?.awaitingRequestId ? "Team needs your answer" : active.team?.status === "planning" ? "Team is planning…" : working ? `Team · ${working} working` : "Team is checking the result…"}</span><a href={`#/run/${active.id}`}>Team details</a></div>;
}
