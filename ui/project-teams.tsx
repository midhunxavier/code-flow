import { pollVisible } from "./polling.js";
import { useEffect, useState } from "preact/hooks";
import { api, post, showToast, ApiError } from "./lib.js";
import { route, loadModels, agents } from "./state.js";
import { ModelRow } from "./composer.js";
import { subscribe } from "./stream.js";
import { ScheduleEditor, SchedulePreview } from "./automations.js";
import type { ProjectTeam, ProjectOpportunity, ProjectTeamMission } from "../src/project-team-model.js";
import type { AutomationPreview } from "../src/automation.js";

type Provider = { id: string; name: string; available: boolean; reason?: string };
type Inventory = { enabled: boolean; revision: number; autoTeamEnabled: boolean; source: string; teams: ProjectTeam[]; providers: Provider[]; faults: Record<string, string> };
const key = () => crypto.randomUUID();
const lines = (value: string) => value.split("\n").map((s) => s.trim()).filter(Boolean);
export function ProjectTeamsPanel({ projectId, repos }: { projectId: string; repos: string[] }) {
  const [data, setData] = useState<Inventory>(), [error, setError] = useState<{ message: string; status?: number }>(), [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
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
  useEffect(() => { void load(); const refresh = () => { void load(); }; window.addEventListener("focus", refresh); const off = subscribe(`project-teams:${projectId}`, (event) => { if (event.type === "snapshot") setData((prior) => prior ? { ...prior, teams: event.teams, enabled: event.enabled, revision: event.revision, source: event.source, autoTeamEnabled: event.autoTeamEnabled } : prior); }); return () => { off(); window.removeEventListener("focus", refresh); }; }, [projectId]);
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
    <div class="pp-card-head"><h2>Project missions</h2><button class="btn small" disabled={!data.enabled || !data.autoTeamEnabled || !repos.length} onClick={() => setCreating(!creating)}>Create a mission</button></div>
    <p class="help">Give agents a mission and a schedule. It investigates your repository, proposes improvements and can prepare one verified draft per cycle for your decision.</p>
    <div class="settings-actions"><button class="btn small" disabled={featureBusy || data.source === "unavailable"} onClick={() => void toggle()}>{featureBusy ? "Saving…" : data.enabled ? "Disable project missions" : "Enable project missions"}</button><span class="help">{data.enabled ? "Enabled on this host" : "Off on this host"} · saved across restarts</span></div>
    <p class="help">This setting applies to all projects on this host. New missions need separate activation. Enabling it resumes schedules for missions already active; stop active cycles before disabling it.</p>
    {!data.autoTeamEnabled && <p class="help">Auto team execution is disabled by this host’s configuration. Project missions can run once the host permits Auto team execution.</p>}
    {featureError && <p role="alert">{featureError}</p>}
    {Object.entries(data.faults).map(([id, reason]) => <p role="alert" key={id}>Mission storage needs repair ({id}): {reason}</p>)}
    {creating && data.enabled && data.autoTeamEnabled && <TeamForm projectId={projectId} repos={repos} providers={data.providers} saved={() => { setCreating(false); void load(); }} />}
    {data.teams.map((t) => <TeamCard key={t.id} team={t} enabled={data.enabled && data.autoTeamEnabled} providers={data.providers} changed={load} />)}
  </section>;
}
function TeamForm({ projectId, repos, providers, team, saved }: { projectId: string; repos: string[]; providers: Provider[]; team?: ProjectTeam; saved: () => void }) {
  useEffect(() => { void loadModels(); }, []);
  const eligible = providers.filter((p) => p.available && !p.reason);
  const [name, setName] = useState(team?.name ?? "Product mission"), [repo, setRepo] = useState(team?.repo ?? repos[0] ?? ""), [mission, setMission] = useState(team?.mission.mission ?? ""), [users, setUsers] = useState(team?.mission.users ?? ""), [branch, setBranch] = useState(team?.mission.baseBranch ?? "main"), [check, setCheck] = useState(team?.mission.check ?? ""), [mode, setMode] = useState(team?.mission.mode ?? "build-within-scope"), [coordinator, setCoordinator] = useState(team?.mission.coordinator ?? eligible[0]?.id ?? ""), [pool, setPool] = useState<string[]>(team?.mission.pool ?? eligible.map((p) => p.id)), [paths, setPaths] = useState(team?.mission.paths.join("\n") ?? "*"), [priorities, setPriorities] = useState(team?.mission.priorities.join("\n") ?? ""), [exclusions, setExclusions] = useState(team?.mission.exclusions.join("\n") ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [advanced, setAdvanced] = useState({ excludedPaths: team?.mission.excludedPaths ?? [".codeflow", ".github/workflows"], maxFiles: team?.mission.maxFiles ?? 8, maxLines: team?.mission.maxLines ?? 400, rescanDays: team?.mission.rescanDays ?? 28, budget: team?.mission.budget ?? { discoveryCalls: 8, discoveryMinutes: 15, buildCalls: 16, buildMinutes: 45, weeklyCalls: 48, weeklyMinutes: 120 }, schedule: team?.mission.schedule ?? { at: "09:00", days: [1], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, categories: team?.mission.categories ?? ["bug", "usability", "performance", "tests", "docs"], trust: team?.mission.trust ?? "standard", setup: team?.mission.setup ?? "", agentSettings: team?.mission.agentSettings ?? {} });
  const submit = async (event: Event) => { event.preventDefault(); setBusy(true); setError(""); try { const value = { ...advanced, ...(team?.mission.verification && check === team.mission.check ? { verification: team.mission.verification } : {}), mission, users, baseBranch: branch, mode, check, coordinator, pool, paths: lines(paths), priorities: lines(priorities), exclusions: lines(exclusions) }; await post(team ? `/api/project-teams/${team.id}` : "/api/project-teams", { operationId: key(), ...(team ? { revision: team.revision } : { projectId, repo }), name, mission: value }); saved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <form class="pt-form" onSubmit={submit}>
    <label>Mission name<input class="field" required value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
    {!team && <label>Repository<select class="field" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>{repos.map((r) => <option key={r}>{r}</option>)}</select></label>}
    <label>Mission<textarea class="field" required rows={3} value={mission} placeholder="What should the agents improve, and why?" onInput={(e) => setMission(e.currentTarget.value)} /></label>
    <label>Intended users<textarea class="field" required value={users} onInput={(e) => setUsers(e.currentTarget.value)} /></label>
    <label>Priorities, one per line<textarea class="field" value={priorities} onInput={(e) => setPriorities(e.currentTarget.value)} /></label>
    <label>Things to avoid, one per line<textarea class="field" value={exclusions} onInput={(e) => setExclusions(e.currentTarget.value)} /></label>
    <label>Base branch<input class="field" required value={branch} onInput={(e) => setBranch(e.currentTarget.value)} /></label>
    <label>Autonomy<select class="field" value={mode} onChange={(e) => setMode(e.currentTarget.value as typeof mode)}><option value="propose">Propose improvements for me to choose</option><option value="build-within-scope">Also build one eligible draft per cycle</option></select></label>
    <label>Required check command<input class="field" value={check} placeholder="npm test" required={mode === "build-within-scope"} onInput={(e) => setCheck(e.currentTarget.value)} /></label>
    <label>Allowed paths, one per line<textarea class="field" value={paths} onInput={(e) => setPaths(e.currentTarget.value)} /></label>
    <label>Coordinator<select class="field" value={coordinator} required onChange={(e) => setCoordinator(e.currentTarget.value)}>{eligible.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
    <fieldset><legend>Workers and independent reviewer</legend>{providers.map((p) => <label key={p.id}><input type="checkbox" checked={pool.includes(p.id)} disabled={!p.available || !!p.reason} onChange={(e) => setPool(e.currentTarget.checked ? [...pool, p.id] : pool.filter((id) => id !== p.id))} /> {p.name}{p.reason ? ` — ${p.reason}` : !p.available ? " — unavailable" : ""}</label>)}</fieldset>
    <details><summary>Schedule, budget and scope limits</summary>
      <ScheduleEditor automation={{ name, schedule: advanced.schedule }} save={(patch) => setAdvanced({ ...advanced, ...(patch as { schedule: ProjectTeamMission["schedule"] }) })} />
      <p class="help">Budget is reserved before each phase. Outstanding work stays charged until its usage is known.</p>
      {([ ["discoveryCalls", "Calls per discovery"], ["discoveryMinutes", "Minutes per discovery"], ["buildCalls", "Calls per implementation"], ["buildMinutes", "Minutes per implementation"], ["weeklyCalls", "Calls per rolling week"], ["weeklyMinutes", "Minutes per rolling week"] ] as const).map(([field, label]) => <label key={field}>{label}<input class="field" type="number" min={1} value={advanced.budget[field]} onInput={(e) => setAdvanced({ ...advanced, budget: { ...advanced.budget, [field]: Number(e.currentTarget.value) } })} /></label>)}
      <label>Maximum changed files<input class="field" type="number" min={1} max={100} value={advanced.maxFiles} onInput={(e) => setAdvanced({ ...advanced, maxFiles: Number(e.currentTarget.value) })} /></label>
      <label>Maximum changed lines<input class="field" type="number" min={1} max={10000} value={advanced.maxLines} onInput={(e) => setAdvanced({ ...advanced, maxLines: Number(e.currentTarget.value) })} /></label>
      <label>Rescan unchanged repositories after this many days<input class="field" type="number" min={1} max={90} value={advanced.rescanDays} onInput={(e) => setAdvanced({ ...advanced, rescanDays: Number(e.currentTarget.value) })} /></label>
      <label>Excluded paths, one per line<textarea class="field" value={advanced.excludedPaths.join("\n")} onInput={(e) => setAdvanced({ ...advanced, excludedPaths: lines(e.currentTarget.value) })} /></label>
      <fieldset><legend>Allowed work categories</legend>{(["bug", "usability", "performance", "tests", "docs", "experiment"] as const).map((category) => <label key={category}><input type="checkbox" checked={advanced.categories.includes(category)} onChange={(e) => setAdvanced({ ...advanced, categories: e.currentTarget.checked ? [...advanced.categories, category] : advanced.categories.filter((c) => c !== category) })} />{category}</label>)}</fieldset>
      <label>Execution permissions<select class="field" value={advanced.trust} onChange={(e) => setAdvanced({ ...advanced, trust: e.currentTarget.value as ProjectTeamMission["trust"] })}><option value="safe">Safe</option><option value="standard">Standard</option><option value="trusted">Trusted</option></select></label>
      <label>Setup command<input class="field" value={advanced.setup} onInput={(e) => setAdvanced({ ...advanced, setup: e.currentTarget.value })} /></label>
      <fieldset><legend>Models and reasoning</legend>{agents.value.filter((a) => eligible.some((p) => p.id === a.id)).map((agent) => <ModelRow key={agent.id} agent={agent} used={pool.includes(agent.id) || coordinator === agent.id} settings={advanced.agentSettings[agent.id] ?? {}} onChange={(patch) => setAdvanced({ ...advanced, agentSettings: { ...advanced.agentSettings, [agent.id]: { ...advanced.agentSettings[agent.id], ...patch } } })} />)}</fieldset>
    </details>
    {error && <p role="alert">{error}</p>}<button class="btn primary" disabled={busy || !eligible.length}>{busy ? "Saving…" : team ? "Save mission" : "Save draft mission"}</button><button type="button" class="btn" onClick={saved}>Cancel</button>
  </form>;
}
function TeamCard({ team: t, enabled, providers, changed }: { team: ProjectTeam; enabled: boolean; providers: Provider[]; changed: () => unknown }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [preview, setPreview] = useState<AutomationPreview>();
  const act = async (suffix: string, body: object) => { setBusy(true); try { await post(`/api/project-teams/${t.id}${suffix}`, { operationId: key(), revision: t.revision, ...body }); await changed(); } catch (e) { showToast((e as Error).message, 7000); await changed(); } finally { setBusy(false); } };
  const running = t.cycles.find((c) => ["requested", "discovering", "selecting", "building", "unknown"].includes(c.status));
  const reserved = t.cycles.flatMap((c) => c.launches).filter((l) => l.state !== "settled" || l.at > Date.now() - 7 * 86400000);
  const calls = reserved.reduce((sum, l) => sum + (l.state === "settled" ? l.usedCalls ?? l.calls : l.calls), 0), minutes = reserved.reduce((sum, l) => sum + l.minutes, 0);
  return <article class="pt-team"><h3>{t.name} <span class="help">{t.status} · mission {t.missionRevision}</span></h3><p>{t.mission.mission}</p><p class="help">{t.repo} · {t.mission.baseBranch} · {t.mission.mode === "propose" ? "Proposals" : "Build within scope"}</p><p class="help">Rolling week: {calls}/{t.mission.budget.weeklyCalls} calls used or reserved · {minutes}/{t.mission.budget.weeklyMinutes} minutes reserved</p>
    {t.error && <p role="alert">{t.error}</p>}
    {t.status !== "archived" && <div class="pt-actions"><button class="btn small" disabled={busy || !enabled && t.status !== "active"} onClick={() => act("", { status: t.status === "active" ? "paused" : "active" })}>{t.status === "active" ? "Pause" : "Activate"}</button><button class="btn small" disabled={busy || !enabled || !!running || t.status !== "active"} onClick={() => { setBusy(true); post(`/api/project-teams/${t.id}/cycle`, { operationId: key() }).then(changed, (e) => showToast(e.message)).finally(() => setBusy(false)); }}>Run cycle now</button><button class="btn small" disabled={busy || !running} onClick={() => act("/stop", {})}>Stop cycle</button><button class="btn small" disabled={!!running} onClick={() => setEditing(!editing)}>Edit mission</button><button class="btn small" disabled={busy || !!running} onClick={() => act("", { status: "archived" })}>Archive mission</button><button class="btn small" onClick={() => api<AutomationPreview>(`/api/project-teams/${t.id}/preview`).then(setPreview, (e) => showToast(e.message))}>Preview next cycle</button></div>}
    {preview && <div role="status"><p>{preview.ready ? "Ready to discover" : preview.busy ? "A cycle is active" : "Not ready"}</p>{preview.warnings.map((w) => <p key={w}>{w}</p>)}<SchedulePreview schedule={t.mission.schedule} /></div>}
    {editing && <TeamForm projectId={t.projectId} repos={[t.repo]} providers={providers} team={t} saved={() => { setEditing(false); void changed(); }} />}
    {!running && t.status !== "archived" && <ScheduleEditor automation={{ name: t.name, schedule: t.mission.schedule }} save={(patch) => act("", { mission: { ...t.mission, ...(patch as { schedule: ProjectTeamMission["schedule"] }) } })} />}
    <div class="pt-opportunities">{[...t.opportunities].reverse().map((o) => <Opportunity key={o.id} opportunity={o} busy={busy || t.status === "archived"} decide={(body) => act(`/opportunities/${o.id}`, { opportunityRevision: o.revision, ...body })} />)}</div>
    <details><summary>Cycle history ({t.cycles.length})</summary>{[...t.cycles].reverse().map((c) => <article key={c.id}><b>{new Date(c.at).toLocaleString()} · {c.status}</b><p>{c.summary ?? c.reason}</p>{c.summary && c.reason && <p>{c.reason}</p>}{c.selection?.reasons.map((r) => <p class="help" key={r.id}>{t.opportunities.find((o) => o.id === r.id)?.title}: {r.reason}</p>)}{c.launches.map((l) => <p key={l.claimId}>{l.phase}: {l.state} · {l.usedCalls ?? l.calls} calls {l.runId && <button class="btn small" onClick={() => { route.value = { view: "run", id: l.runId! }; }}>Open team run</button>}</p>)}</article>)}</details>
  </article>;
}
function Opportunity({ opportunity: o, busy, decide }: { opportunity: ProjectOpportunity; busy: boolean; decide: (body: object) => unknown }) {
  const [note, setNote] = useState("");
  return <article class="pt-opportunity" id={`opportunity-${o.id}`}><h4>{o.title} <span class="help">{o.status}</span></h4><p>{o.problem}</p><p>{o.proposal}</p><p class="help">{o.benefit} · {o.risk} risk · {o.kind} · {o.evidenceVerified ? "Code evidence verified" : "Evidence needs review"}</p>
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
  return <section class="project-briefing" aria-label="Project briefing"><div class="experience-kicker">PROJECT BRIEFING</div><h2>{ordered.length ? "Worth your attention" : "No new opportunities to review"}</h2><p class="help">{teams.some(team => team.status === "active") ? "From your standing teams' recorded investigations. New discoveries appear here when a cycle completes." : "Connect and activate a standing team below to investigate a mission on your schedule."}</p><div class="briefing-grid">{ordered.map(({ team, opportunity: o }) => <article key={o.id}><span class="badge">{o.status === "ready" ? "Verified draft" : o.status}</span><h3>{o.title}</h3><p>{o.benefit}</p><p class="help">{o.users} · {o.risk} risk · {o.evidenceVerified ? "Source quotes checked" : "Evidence needs review"}</p><details><summary>Why this matters</summary><p>{o.problem}</p><p>{o.rationale}</p>{o.evidence.slice(0, 3).map((e, index) => <blockquote key={index}><code>{e.path}</code><pre>{e.quote}</pre></blockquote>)}<p class="help">Source commit {o.baseCommit.slice(0, 12)}</p></details><div class="experience-actions">{o.result ? <a class="btn small primary" href={`#/run/${o.result.runId}`}>Try and review draft</a> : <button class="btn small" onClick={() => document.getElementById(`opportunity-${o.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>Review proposal</button>}<button class="btn ghost small" disabled={!!busy} onClick={() => void dismiss(team, o)}>Dismiss opportunity</button></div></article>)}</div>{entries.length > 3 ? <p class="help">{entries.length - 3} more opportunities are available in the team details below.</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
