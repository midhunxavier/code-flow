import { pollVisible } from "./polling.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, post, showToast, ApiError } from "./lib.js";
import { route, loadModels, agents } from "./state.js";
import { ModelRow } from "./composer.js";
import { subscribe } from "./stream.js";
import { ScheduleEditor, SchedulePreview } from "./automations.js";
import type { AgentTeamSnapshot, ProjectTeam, ProjectOpportunity, ProjectTeamMission } from "../src/project-team-model.js";
import type { AutomationPreview } from "../src/automation.js";
import { AgentTeamLibrary, type TeamProvider } from "./agent-team-library.js";
import { allowance, projectTeamUsage } from "../src/project-team-budget.js";

type Provider = TeamProvider;
type Inventory = { enabled: boolean; revision: number; autoTeamEnabled: boolean; source: string; teams: ProjectTeam[]; definitions?: AgentTeamSnapshot[]; definitionFaults?: Record<string, string>; providers: Provider[]; faults: Record<string, string> };
const key = () => crypto.randomUUID();
const lines = (value: string) => value.split("\n").map((s) => s.trim()).filter(Boolean);
export function ProjectTeamsPanel({ projectId, repos }: { projectId: string; repos: string[] }) {
  const [data, setData] = useState<Inventory>(), [error, setError] = useState<{ message: string; status?: number }>(), [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initialDefinition, setInitialDefinition] = useState<AgentTeamSnapshot>();
  const [featureBusy, setFeatureBusy] = useState(false), [featureError, setFeatureError] = useState("");
  const load = async () => {
    setLoading(true);
    try { setData(await api<Inventory>(`/api/project-teams?project=${encodeURIComponent(projectId)}`)); setError(undefined); }
    catch (e) { setError({ message: (e as Error).message, status: e instanceof ApiError ? e.status : undefined }); }
    finally { setLoading(false); }
  };
  const toggle = async () => {
    if (!data || featureBusy) return; setFeatureBusy(true); setFeatureError("");
    try { await post("/api/project-teams/settings", { enabled: !data.enabled, revision: data.revision }); setCreating(false); await load(); }
    catch (error) { setFeatureError((error as Error).message); await load(); }
    finally { setFeatureBusy(false); }
  };
  useEffect(() => { void load(); const refresh = () => { void load(); }; window.addEventListener("focus", refresh); const off = subscribe(`project-teams:${projectId}`, (event) => { if (event.type === "snapshot") setData((prior) => prior ? { ...prior, teams: event.teams, definitions: event.definitions, definitionFaults: event.definitionFaults, enabled: event.enabled, revision: event.revision, source: event.source, autoTeamEnabled: event.autoTeamEnabled } : prior); }); return () => { off(); window.removeEventListener("focus", refresh); }; }, [projectId]);
  if (error) return <section class="pp-card pp-unavailable" aria-label="Project missions">
    <div class="pp-card-head"><h2>Project missions</h2><span class="badge">Unavailable</span><button class="btn small" disabled={loading} onClick={() => void load()}>{loading ? "Retrying…" : "Retry"}</button></div>
    <div class="pp-unavailable-body" role="alert">
      <p>{error.status === 404 ? "Project missions aren’t available on this computer." : "Couldn’t load project missions."}</p>
      <p class="help">{error.status === 404 ? "The connected server doesn’t provide this feature. It may need an update." : error.message}</p>
    </div>
  </section>;
  if (!data) return null;
  return <section class="pp-card standing-teams" aria-label="Project missions">
    <ProjectBriefing teams={data.teams} />
    <div class="pp-card-head"><h2>Project missions</h2><button class="btn small" disabled={!data.enabled || !data.autoTeamEnabled || !repos.length} onClick={() => { setInitialDefinition(undefined); setCreating(!creating); }}>Create a mission</button></div>
    <p class="help">Assign an agent team to this project. Give it tasks directly or enable recurring discovery to prepare improvements for your review.</p>
    <div class="settings-actions"><button class="btn small" disabled={featureBusy || data.source === "unavailable"} onClick={() => void toggle()}>{featureBusy ? "Saving…" : data.enabled ? "Disable project missions" : "Enable project missions"}</button><span class="help">{data.enabled ? "Enabled on this host" : "Off on this host"} · saved across restarts</span></div>
    <p class="help">This setting applies to all projects on this host. New missions need separate activation. Enabling it resumes schedules for missions already active; stop active cycles before disabling it.</p>
    {!data.autoTeamEnabled && <p class="help">Auto team execution is disabled by this host’s configuration. Project missions can run once the host permits Auto team execution.</p>}
    {featureError && <p role="alert">{featureError}</p>}
    {Object.entries(data.faults).map(([id, reason]) => <p role="alert" key={id}>Mission storage needs repair ({id}): {reason}</p>)}
    {Object.entries(data.definitionFaults ?? {}).map(([id, reason]) => <p role="alert" key={id}>Reusable team storage needs repair ({id}): {reason}</p>)}
    <AgentTeamLibrary definitions={data.definitions ?? []} providers={data.providers} canAssign={data.enabled && data.autoTeamEnabled && !!repos.length} assign={(definition) => { setInitialDefinition(definition); setCreating(true); }} changed={load} />
    {creating && data.enabled && data.autoTeamEnabled && (initialDefinition
      ? <AssignmentForm key={`${initialDefinition.id}:${initialDefinition.revision}`} definition={initialDefinition} projectId={projectId} repos={repos} assignments={data.teams} providers={data.providers} definitions={data.definitions ?? []} saved={() => { setCreating(false); void load(); }} />
      : <TeamForm projectId={projectId} repos={repos} providers={data.providers} definitions={data.definitions ?? []} saved={() => { setCreating(false); void load(); }} />)}
    {data.teams.map((t) => <TeamCard key={t.id} team={t} enabled={data.enabled && data.autoTeamEnabled} providers={data.providers} definitions={data.definitions ?? []} changed={load} />)}
  </section>;
}
function AssignmentForm({ definition, projectId, repos, assignments, providers, definitions, saved }: { definition: AgentTeamSnapshot; projectId: string; repos: string[]; assignments: ProjectTeam[]; providers: Provider[]; definitions: AgentTeamSnapshot[]; saved: () => void }) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const existing = assignments.find((team) => team.repo === repo && team.status !== "archived");
  return <section aria-label="Assign agent team to project">
    <label>Repository for team assignment<select class="field" aria-label="Repository for team assignment" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>{repos.map((path) => <option key={path}>{path}</option>)}</select></label>
    {existing && <p class="help">This updates the team configuration of {existing.name}. Its mission history and charged usage stay with this assignment.</p>}
    <TeamForm key={repo} projectId={projectId} repos={[repo]} providers={providers} definitions={definitions} initialDefinition={definition} team={existing} saved={saved} />
  </section>;
}
function TeamForm({ projectId, repos, providers, definitions, initialDefinition, team, saved }: { projectId: string; repos: string[]; providers: Provider[]; definitions: AgentTeamSnapshot[]; initialDefinition?: AgentTeamSnapshot; team?: ProjectTeam; saved: () => void }) {
  useEffect(() => { void loadModels(); }, []);
  const eligible = providers.filter((p) => p.available && !p.reason);
  const [definition, setDefinition] = useState(initialDefinition ?? team?.definition);
  const [scheduleEnabled, setScheduleEnabled] = useState(team ? team.scheduleEnabled !== false : !initialDefinition);
  const [name, setName] = useState(team?.name ?? "Product mission"), [repo, setRepo] = useState(team?.repo ?? repos[0] ?? ""), [mission, setMission] = useState(team?.mission.mission ?? ""), [users, setUsers] = useState(team?.mission.users ?? ""), [branch, setBranch] = useState(team?.mission.baseBranch ?? "main"), [check, setCheck] = useState(team?.mission.check ?? ""), [mode, setMode] = useState(team?.mission.mode ?? "build-within-scope"), [coordinator, setCoordinator] = useState(team?.mission.coordinator ?? eligible[0]?.id ?? ""), [pool, setPool] = useState<string[]>(team?.mission.pool ?? eligible.map((p) => p.id)), [paths, setPaths] = useState(team?.mission.paths.join("\n") ?? "*"), [priorities, setPriorities] = useState(team?.mission.priorities.join("\n") ?? ""), [exclusions, setExclusions] = useState(team?.mission.exclusions.join("\n") ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [advanced, setAdvanced] = useState({ excludedPaths: team?.mission.excludedPaths ?? [".codeflow", ".github/workflows"], maxFiles: team?.mission.maxFiles ?? 8, maxLines: team?.mission.maxLines ?? 400, rescanDays: team?.mission.rescanDays ?? 28, budget: team?.mission.budget ?? { discoveryCalls: 8, discoveryMinutes: 15, buildCalls: 16, buildMinutes: 45, weeklyCalls: 48, weeklyMinutes: 120 }, schedule: team?.schedule ?? team?.mission.schedule ?? { at: "09:00", days: [1], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, categories: team?.mission.categories ?? ["bug", "usability", "performance", "tests", "docs"], trust: team?.mission.trust ?? "standard", setup: team?.mission.setup ?? "", agentSettings: team?.mission.agentSettings ?? {} });
  const submit = async (event: Event) => { event.preventDefault(); setBusy(true); setError(""); try { const value = { ...advanced, ...(team?.mission.verification && check === team.mission.check ? { verification: team.mission.verification } : {}), ...(team?.mission.roleSettings ? { roleSettings: team.mission.roleSettings } : {}), mission, users, baseBranch: branch, mode, check, coordinator, pool, paths: lines(paths), priorities: lines(priorities), exclusions: lines(exclusions) }; await post(team ? `/api/project-teams/${team.id}` : "/api/project-teams", { operationId: key(), ...(team ? { revision: team.revision } : { projectId, repo }), ...(definition ? { definition: { id: definition.id, revision: definition.revision } } : team ? { definition: null } : {}), scheduleEnabled, name, mission: value }); saved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <form class="pt-form" onSubmit={submit}>
    <label>Mission name<input class="field" required value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
    {!team && <label>Repository<select class="field" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>{repos.map((r) => <option key={r}>{r}</option>)}</select></label>}
    <label>Agent team<select class="field" aria-label="Agent team" value={definition ? `${definition.id}:${definition.revision}` : ""} onChange={(e) => setDefinition(definitions.find((entry) => `${entry.id}:${entry.revision}` === e.currentTarget.value))}><option value="">Custom team for this assignment</option>{definition && !definitions.some((entry) => entry.id === definition.id && entry.revision === definition.revision) && <option value={`${definition.id}:${definition.revision}`}>{definition.name} · pinned version {definition.revision}</option>}{definitions.map((entry) => <option key={entry.id} value={`${entry.id}:${entry.revision}`}>{entry.name} · version {entry.revision}</option>)}</select></label>
    {definition && <p class="help">Using {definition.name}, version {definition.revision}. Its coordinator, provider pool and model settings are pinned to this assignment.</p>}
    <label>Mission<textarea class="field" required rows={3} value={mission} placeholder="What should the agents improve, and why?" onInput={(e) => setMission(e.currentTarget.value)} /></label>
    <label>Intended users<textarea class="field" required value={users} onInput={(e) => setUsers(e.currentTarget.value)} /></label>
    <label>Priorities, one per line<textarea class="field" value={priorities} onInput={(e) => setPriorities(e.currentTarget.value)} /></label>
    <label>Things to avoid, one per line<textarea class="field" value={exclusions} onInput={(e) => setExclusions(e.currentTarget.value)} /></label>
    <label>Base branch<input class="field" required value={branch} onInput={(e) => setBranch(e.currentTarget.value)} /></label>
    <label>Autonomy<select class="field" value={mode} onChange={(e) => setMode(e.currentTarget.value as typeof mode)}><option value="propose">Propose improvements for me to choose</option><option value="build-within-scope">Also build one eligible draft per cycle</option></select></label>
    <label>Required check command<input class="field" value={check} placeholder="npm test" required={mode === "build-within-scope"} onInput={(e) => setCheck(e.currentTarget.value)} /></label>
    <label>Allowed paths, one per line<textarea class="field" value={paths} onInput={(e) => setPaths(e.currentTarget.value)} /></label>
    {!definition && <><label>Coordinator<select class="field" value={coordinator} required onChange={(e) => setCoordinator(e.currentTarget.value)}>{eligible.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
    <fieldset><legend>Workers and independent reviewer</legend>{providers.map((p) => <label key={p.id}><input type="checkbox" checked={pool.includes(p.id)} disabled={!p.available || !!p.reason} onChange={(e) => setPool(e.currentTarget.checked ? [...pool, p.id] : pool.filter((id) => id !== p.id))} /> {p.name}{p.reason ? ` — ${p.reason}` : !p.available ? " — unavailable" : ""}</label>)}</fieldset></>}
    <label><input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.currentTarget.checked)} />Run recurring discovery</label>
    <details><summary>Schedule, budget and scope limits</summary>
      <ScheduleEditor automation={{ name, schedule: advanced.schedule }} save={(patch) => { const value = (patch as { schedule: ProjectTeamMission["schedule"] | null }).schedule; if (value === null) setScheduleEnabled(false); else setAdvanced({ ...advanced, schedule: value }); }} />
      <p class="help">Budget is reserved before each phase. Outstanding work stays charged until its usage is known.</p>
      {([ ["discoveryCalls", "Calls per discovery"], ["discoveryMinutes", "Minutes per discovery"], ["buildCalls", "Calls per implementation"], ["buildMinutes", "Minutes per implementation"], ["weeklyCalls", "Calls per rolling week"], ["weeklyMinutes", "Minutes per rolling week"] ] as const).map(([field, label]) => <label key={field}>{label}<input class="field" type="number" min={1} value={advanced.budget[field]} onInput={(e) => setAdvanced({ ...advanced, budget: { ...advanced.budget, [field]: Number(e.currentTarget.value) } })} /></label>)}
      <label>Maximum changed files<input class="field" type="number" min={1} max={100} value={advanced.maxFiles} onInput={(e) => setAdvanced({ ...advanced, maxFiles: Number(e.currentTarget.value) })} /></label>
      <label>Maximum changed lines<input class="field" type="number" min={1} max={10000} value={advanced.maxLines} onInput={(e) => setAdvanced({ ...advanced, maxLines: Number(e.currentTarget.value) })} /></label>
      <label>Rescan unchanged repositories after this many days<input class="field" type="number" min={1} max={90} value={advanced.rescanDays} onInput={(e) => setAdvanced({ ...advanced, rescanDays: Number(e.currentTarget.value) })} /></label>
      <label>Excluded paths, one per line<textarea class="field" value={advanced.excludedPaths.join("\n")} onInput={(e) => setAdvanced({ ...advanced, excludedPaths: lines(e.currentTarget.value) })} /></label>
      <fieldset><legend>Allowed work categories</legend>{(["bug", "usability", "performance", "tests", "docs", "experiment"] as const).map((category) => <label key={category}><input type="checkbox" checked={advanced.categories.includes(category)} onChange={(e) => setAdvanced({ ...advanced, categories: e.currentTarget.checked ? [...advanced.categories, category] : advanced.categories.filter((c) => c !== category) })} />{category}</label>)}</fieldset>
      <label>Execution permissions<select class="field" value={advanced.trust} onChange={(e) => setAdvanced({ ...advanced, trust: e.currentTarget.value as ProjectTeamMission["trust"] })}><option value="safe">Safe</option><option value="standard">Standard</option><option value="trusted">Trusted</option></select></label>
      <label>Setup command<input class="field" value={advanced.setup} onInput={(e) => setAdvanced({ ...advanced, setup: e.currentTarget.value })} /></label>
      {!definition && <fieldset><legend>Models and reasoning</legend>{agents.value.filter((a) => eligible.some((p) => p.id === a.id)).map((agent) => <ModelRow key={agent.id} agent={agent} used={pool.includes(agent.id) || coordinator === agent.id} settings={advanced.agentSettings[agent.id] ?? {}} onChange={(patch) => setAdvanced({ ...advanced, agentSettings: { ...advanced.agentSettings, [agent.id]: { ...advanced.agentSettings[agent.id], ...patch } } })} />)}</fieldset>}
    </details>
    {error && <p role="alert">{error}</p>}<button class="btn primary" disabled={busy || !eligible.length}>{busy ? "Saving…" : team ? "Save mission" : "Save draft mission"}</button><button type="button" class="btn" onClick={saved}>Cancel</button>
  </form>;
}
function TeamCard({ team: t, enabled, providers, definitions, changed }: { team: ProjectTeam; enabled: boolean; providers: Provider[]; definitions: AgentTeamSnapshot[]; changed: () => unknown }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [preview, setPreview] = useState<AutomationPreview>();
  const [givingTask, setGivingTask] = useState(false), [savingTeam, setSavingTeam] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<boolean>();
  const act = async (suffix: string, body: object) => { setBusy(true); try { await post(`/api/project-teams/${t.id}${suffix}`, { operationId: key(), revision: t.revision, ...body }); await changed(); return true; } catch (e) { showToast((e as Error).message, 7000); await changed(); return false; } finally { setBusy(false); } };
  const latest = definitions.find((entry) => entry.id === t.definition?.id);
  const running = t.cycles.find((c) => ["requested", "discovering", "selecting", "building", "unknown"].includes(c.status));
  const { calls, minutes, reservedMinutes } = projectTeamUsage(t), remaining = allowance(t);
  const taskBudgetAvailable = remaining.calls >= t.mission.budget.buildCalls && remaining.minutes >= t.mission.budget.buildMinutes;
  return <article class="pt-team"><h3>{t.name} <span class="help">{t.status} · mission {t.missionRevision}</span></h3><p>{t.mission.mission}</p><p class="help">{t.repo} · {t.mission.baseBranch} · {t.mission.mode === "propose" ? "Proposals" : "Build within scope"}</p><p class="help">Rolling week: {calls}/{t.mission.budget.weeklyCalls} calls used or reserved · {minutes}/{t.mission.budget.weeklyMinutes} minutes used or reserved{reservedMinutes > 0 ? ` (${reservedMinutes} reserved)` : ""}</p>
    {!running && !taskBudgetAvailable && <p class="help">The remaining weekly allowance cannot cover another task's full limit. Completed runs release unused allocations when their final usage is recorded; unknown launches stay reserved.</p>}
    {t.error && <p role="alert">{t.error}</p>}
    <p class="help">{t.definition ? `${t.definition.name} · team version ${t.definition.revision}` : "Custom agent team"} · {t.scheduleEnabled === false ? "Manual tasks only" : "Recurring discovery enabled"}</p>
    {t.status !== "archived" && <div class="pt-actions"><button class="btn small primary" disabled={busy || !enabled || !!running || t.status !== "active" || !taskBudgetAvailable} onClick={() => setGivingTask(!givingTask)}>Give team a task</button><button class="btn small" disabled={busy} onClick={() => setSavingTeam(!savingTeam)}>Save as reusable team</button>{latest && latest.revision !== t.definition?.revision && <button class="btn small" disabled={busy || !!running} onClick={() => act("", { definition: { id: latest.id, revision: latest.revision } })}>Use team version {latest.revision}</button>}<label><input type="checkbox" checked={pendingSchedule ?? t.scheduleEnabled !== false} disabled={busy || pendingSchedule !== undefined} onChange={async (e) => { const next = e.currentTarget.checked; setPendingSchedule(next); await act("", { scheduleEnabled: next }); setPendingSchedule(undefined); }} />Run recurring discovery</label></div>}
    {givingTask && <OwnerTaskForm team={t} saved={() => { setGivingTask(false); void changed(); }} refresh={changed} cancel={() => setGivingTask(false)} />}
    {savingTeam && <SaveAssignmentTeam team={t} saved={() => { setSavingTeam(false); void changed(); }} cancel={() => setSavingTeam(false)} />}
    {t.status !== "archived" && <div class="pt-actions"><button class="btn small" disabled={busy || !enabled && t.status !== "active"} onClick={() => act("", { status: t.status === "active" ? "paused" : "active" })}>{t.status === "active" ? "Pause" : "Activate"}</button><button class="btn small" disabled={busy || !enabled || !!running || t.status !== "active"} onClick={() => { setBusy(true); post(`/api/project-teams/${t.id}/cycle`, { operationId: key() }).then(changed, (e) => showToast(e.message)).finally(() => setBusy(false)); }}>Run cycle now</button><button class="btn small" disabled={busy || !running} onClick={() => act("/stop", {})}>Stop cycle</button><button class="btn small" disabled={!!running} onClick={() => setEditing(!editing)}>Edit mission</button><button class="btn small" disabled={busy || !!running} onClick={() => act("", { status: "archived" })}>Archive mission</button><button class="btn small" onClick={() => api<AutomationPreview>(`/api/project-teams/${t.id}/preview`).then(setPreview, (e) => showToast(e.message))}>Preview next cycle</button></div>}
    {preview && <div role="status"><p>{preview.ready ? "Ready to discover" : preview.busy ? "A cycle is active" : "Not ready"}</p>{preview.warnings.map((w) => <p key={w}>{w}</p>)}{t.scheduleEnabled !== false && <SchedulePreview schedule={t.schedule ?? t.mission.schedule} />}</div>}
    {editing && <TeamForm projectId={t.projectId} repos={[t.repo]} providers={providers} definitions={definitions} team={t} saved={() => { setEditing(false); void changed(); }} />}
    {t.status !== "archived" && t.scheduleEnabled !== false && <ScheduleEditor key={JSON.stringify(t.schedule ?? t.mission.schedule)} automation={{ name: t.name, schedule: t.schedule ?? t.mission.schedule }} save={async (patch) => { await act("", patch); }} />}
    <div class="pt-opportunities">{[...t.opportunities].reverse().map((o) => <Opportunity key={o.id} opportunity={o} busy={busy || t.status === "archived"} decide={(body) => act(`/opportunities/${o.id}`, { opportunityRevision: o.revision, ...body })} />)}</div>
    <details><summary>Cycle history ({t.cycles.length})</summary>{[...t.cycles].reverse().map((c) => <article key={c.id}><b>{new Date(c.at).toLocaleString()} · {c.status}</b><p>{c.summary ?? c.reason}</p>{c.summary && c.reason && <p>{c.reason}</p>}{c.selection?.reasons.map((r) => <p class="help" key={r.id}>{t.opportunities.find((o) => o.id === r.id)?.title}: {r.reason}</p>)}{c.launches.map((l) => <p key={l.claimId}>{l.phase}: {l.state} · {l.usage?.calls ?? l.usedCalls ?? l.calls} calls · {l.usage ? `${Math.ceil(l.usage.durationMs / 60_000)} minutes used` : `${l.minutes} minutes reserved`} {l.runId && <button class="btn small" onClick={() => { route.value = { view: "run", id: l.runId! }; }}>Open team run</button>}</p>)}</article>)}</details>
  </article>;
}
function OwnerTaskForm({ team, saved, refresh, cancel }: { team: ProjectTeam; saved: () => void; refresh: () => unknown; cancel: () => void }) {
  const [title, setTitle] = useState(""), [instructions, setInstructions] = useState(""), [acceptance, setAcceptance] = useState(""), [category, setCategory] = useState(team.mission.categories[0]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // Keep the exact receipt request after an ambiguous network failure. Retrying cannot spend twice.
  const request = useRef<Record<string, unknown>>();
  const submit = async (event: Event) => {
    event.preventDefault(); setBusy(true); setError("");
    request.current ??= { operationId: key(), revision: team.revision, title, instructions, acceptance: lines(acceptance), category };
    try { await post(`/api/project-teams/${team.id}/tasks`, request.current); saved(); }
    catch (error) { setError((error as Error).message); if (error instanceof ApiError && error.status >= 400 && error.status < 500) request.current = undefined; void refresh(); }
    finally { setBusy(false); }
  };
  const locked = busy || !!request.current;
  return <form class="pt-form" aria-label="Give team a task" onSubmit={submit}>
    <label>Task title<input class="field" required maxLength={180} disabled={locked} value={title} onInput={(e) => setTitle(e.currentTarget.value)} /></label>
    <label>Task instructions<textarea class="field" required maxLength={3000} disabled={locked} rows={3} value={instructions} onInput={(e) => setInstructions(e.currentTarget.value)} /></label>
    <label>Acceptance criteria, one per line<textarea class="field" required disabled={locked} value={acceptance} onInput={(e) => setAcceptance(e.currentTarget.value)} /></label>
    <label>Task category<select class="field" aria-label="Task category" disabled={locked} value={category} onChange={(e) => setCategory(e.currentTarget.value as typeof category)}>{team.mission.categories.map((value) => <option key={value}>{value}</option>)}</select></label>
    <p class="help">Uses this assignment's scope, checks and implementation budget: up to {team.mission.budget.buildCalls} calls and {team.mission.budget.buildMinutes} minutes. The result comes back for your review.</p>
    {error && <p role="alert">{error}</p>}
    <div class="pt-actions"><button class="btn primary" disabled={busy}>{busy ? "Starting…" : request.current ? "Retry task request" : "Start assigned task"}</button><button type="button" class="btn" disabled={busy} onClick={cancel}>Cancel task</button></div>
  </form>;
}
function SaveAssignmentTeam({ team, saved, cancel }: { team: ProjectTeam; saved: () => void; cancel: () => void }) {
  const [name, setName] = useState(`${team.name} team`.slice(0, 80)), [busy, setBusy] = useState(false), [error, setError] = useState(""), [operationId] = useState(key);
  return <form class="pt-form" aria-label="Save assignment as reusable team" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await post("/api/project-teams/definitions", { operationId, name, sourceTeamId: team.id }); saved(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }}><label>Reusable team name<input class="field" required maxLength={80} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
    <p class="help">Saves provider and model preferences. This project's mission, memory, history and budget stay with the assignment.</p>
    {error && <p role="alert">{error}</p>}<div class="pt-actions"><button class="btn primary" disabled={busy}>Save team configuration</button><button class="btn" type="button" disabled={busy} onClick={cancel}>Cancel saving team</button></div>
  </form>;
}
function Opportunity({ opportunity: o, busy, decide }: { opportunity: ProjectOpportunity; busy: boolean; decide: (body: object) => unknown }) {
  const [note, setNote] = useState("");
  return <article class="pt-opportunity" id={`opportunity-${o.id}`}><h4>{o.title} <span class="help">{o.status}</span></h4><p>{o.problem}</p>{o.origin !== "owner" && <p>{o.proposal}</p>}<p class="help">{o.origin === "owner" ? "Owner-assigned task" : `${o.benefit} · ${o.risk} risk · ${o.kind} · ${o.evidenceVerified ? "Code evidence verified" : "Evidence needs review"}`}</p>
    <details><summary>Evidence and acceptance criteria</summary>{o.evidence.map((e, i) => <blockquote key={i}><code>{e.path}</code><pre>{e.quote}</pre></blockquote>)}<ul>{o.acceptance.map((a) => <li key={a}>{a}</li>)}</ul><p>{o.rationale}</p><p>Paths: {o.paths.join(", ")}</p></details>
    {o.reason && <p>{o.reason}</p>}{o.result && <><code>{o.result.head.slice(0, 12)}</code> <button class="btn small" onClick={() => { route.value = { view: "run", id: o.result!.runId }; }}>Review diff and checks</button></>}
    {!["shipped", "implementing"].includes(o.status) && <><label>Feedback<textarea class="field" value={note} onInput={(e) => setNote(e.currentTarget.value)} /></label><div class="pt-actions">{o.status === "ready" && <button class="btn small primary" disabled={busy} onClick={() => decide({ action: "approve", note })}>Approve this commit</button>}<button class="btn small" disabled={busy || o.status === "accepted"} onClick={() => decide({ action: o.result ? "revise" : "build", note })}>{o.result ? "Request revision" : "Build proposal"}</button><button class="btn small" disabled={busy} onClick={() => decide({ action: "defer", note, deferUntil: Date.now() + 7 * 86400000 })}>Defer one week</button><button class="btn small" disabled={busy} onClick={() => decide({ action: "reject", note })}>Reject</button></div></>}
    {o.status === "accepted" && <p class="help">Approved. Open the result to publish a PR or merge using the existing review controls.</p>}
  </article>;
}

/** Compact owner inbox; detailed evidence stays on the project page. No separate EventSource. */
export function ProjectTeamsInbox({ projectId }: { projectId?: string }) {
  const [teams, setTeams] = useState<ProjectTeam[]>([]);
  useEffect(() => { let active = true; const load = () => api<Inventory>(`/api/project-teams${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`).then((data) => { if (active) setTeams(data.teams); }, () => undefined); const stop = pollVisible(load, 15000); return () => { active = false; stop(); }; }, [projectId]);
  const actionable = teams.filter((t) => t.status !== "archived" && (t.opportunities.some((o) => ["proposed", "ready", "blocked"].includes(o.status)) || t.cycles.at(-1)?.status === "unknown"));
  if (!actionable.length) return null;
  return <section class="pp-card standing-teams"><h2>Project team opportunities</h2>{actionable.map((t) => <article key={t.id}><h3>{t.name}</h3><p>{t.opportunities.filter((o) => o.status === "ready").length} verified drafts · {t.opportunities.filter((o) => o.status === "proposed").length} proposals{t.cycles.at(-1)?.status === "unknown" ? " · launch needs reconciliation" : ""}</p><button class="btn" onClick={() => { route.value = { view: "project", id: t.projectId, section: "automation", kind: "missions" }; }}>Review opportunities</button></article>)}</section>;
}

function ProjectBriefing({ teams }: { teams: ProjectTeam[] }) {
  const entries = teams.filter(team => team.status !== "archived").flatMap(team => team.opportunities.filter(opportunity => ["ready", "proposed", "blocked", "accepted"].includes(opportunity.status)).map(opportunity => ({ team, opportunity })));
  const ordered = [...entries].sort((a, b) => Number(b.opportunity.status === "ready") - Number(a.opportunity.status === "ready") || b.opportunity.impact - a.opportunity.impact || b.opportunity.createdAt - a.opportunity.createdAt).slice(0, 3);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const dismiss = async (team: ProjectTeam, opportunity: ProjectOpportunity) => { setBusy(opportunity.id); setError(""); try { await post(`/api/project-teams/${team.id}/opportunities/${opportunity.id}`, { operationId: key(), revision: team.revision, opportunityRevision: opportunity.revision, action: "reject", note: "Dismissed from the project briefing" }); } catch (error) { setError((error as Error).message); } finally { setBusy(""); } };
  return <section class="project-briefing" aria-label="Project briefing"><div class="experience-kicker">PROJECT BRIEFING</div><h2>{ordered.length ? "Worth your attention" : "No new opportunities to review"}</h2><p class="help">{teams.some(team => team.status === "active") ? "Your team's assigned tasks and discovered improvements appear here for review." : "Assign and activate an agent team below to start work on this project."}</p><div class="briefing-grid">{ordered.map(({ team, opportunity: o }) => <article key={o.id}><span class="badge">{o.status === "ready" ? "Verified draft" : o.status}</span><h3>{o.title}</h3><p>{o.benefit}</p><p class="help">{o.origin === "owner" ? "Owner-assigned task" : `${o.users} · ${o.risk} risk · ${o.evidenceVerified ? "Source quotes checked" : "Evidence needs review"}`}</p><details><summary>Why this matters</summary><p>{o.problem}</p><p>{o.rationale}</p>{o.evidence.slice(0, 3).map((e, index) => <blockquote key={index}><code>{e.path}</code><pre>{e.quote}</pre></blockquote>)}<p class="help">Source commit {o.baseCommit.slice(0, 12)}</p></details><div class="experience-actions">{o.result ? <a class="btn small primary" href={`#/run/${o.result.runId}`}>Try and review draft</a> : <button class="btn small" onClick={() => document.getElementById(`opportunity-${o.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>Review proposal</button>}<button class="btn ghost small" disabled={!!busy} onClick={() => void dismiss(team, o)}>Dismiss opportunity</button></div></article>)}</div>{entries.length > 3 ? <p class="help">{entries.length - 3} more opportunities are available in the team details below.</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
