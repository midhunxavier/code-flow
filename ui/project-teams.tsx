import { scrollBehavior } from "./lib.js";
import { pollVisible } from "./polling.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, post, showToast, showError, ApiError, baseName } from "./lib.js";
import { route, loadModels, agents, projects } from "./state.js";
import { ModelRow } from "./composer.js";
import { subscribe } from "./stream.js";
import { ScheduleEditor, SchedulePreview } from "./automations.js";
import { localTimezone } from "./schedule-draft.js";
import { confirmAction } from "./confirm-state.js";
import type { AgentTeamSnapshot, ProjectTeam, ProjectOpportunity, ProjectTeamMission } from "../src/project-team-model.js";
import type { ProjectTeamFault } from "../src/project-team-store.js";
import type { AutomationPreview } from "../src/automation.js";
import { AgentTeamLibrary, type TeamProvider } from "./agent-team-library.js";
import { PROJECT_TEAM_BUDGET_RANGES, allowance, defaultProjectTeamBudget, projectTeamUsage } from "../src/project-team-budget.js";
import { CHECK_REQUIRED, buildRefusal, candidateProblem, taskAdmissionProblem } from "../src/project-team-admission.js";
import { projectTeamInboxSummary, projectTeamNeedsOwner } from "./project-team-inbox.js";
import type { MissionDefaults, MissionDraft } from "../src/mission-draft.js";
import { missionDraftInput } from "./mission-draft-input.js";

type Provider = TeamProvider;
type Owner = { name: string; projectId: string; repair?: true };
type Inventory = { enabled: boolean; revision: number; autoTeamEnabled: boolean; source: string; teams: ProjectTeam[]; definitions?: AgentTeamSnapshot[]; definitionFaults?: Record<string, string>; providers: Provider[]; faults: Record<string, string>; faultDetails?: Record<string, ProjectTeamFault>; creationBlocked?: string; repositoryOwners?: Record<string, Owner> };
type TaskDraft = { id: string; title: string; instructions: string; acceptance: string; category?: ProjectTeamMission["categories"][number] };
const key = () => crypto.randomUUID();
const lines = (value: string) => value.split("\n").map((s) => s.trim()).filter(Boolean);
const ownedProblem = (owner: Owner, projectId: string) => owner.repair ? `Its mission “${owner.name}” needs repair before another can be created.` : `It already has a mission${owner.projectId === projectId ? "" : " in another project"}: “${owner.name}”. Archive that mission first.`;
/** Names the file and the way back, since there is no in-app repair for unreadable or held records. */
function faultText(id: string, reason: string, fault?: ProjectTeamFault) {
  if (fault?.kind === "settings") return `The project missions setting can’t be read: ${reason}. Fix or remove ${fault.file}, then restart Code Flow. Removing it returns to this host’s default.`;
  if (fault?.kind === "storage") return `Mission storage can’t be read: ${reason}. Check the folder ${fault.file} and its permissions, then restart Code Flow.`;
  if (fault?.kind === "ownership") return `Mission “${fault.name}” (${fault.repo}) is on hold: ${reason}. Its history is kept in ${fault.file}. It can’t run, and no other mission can be created for this repository, until that is resolved. If the repository was replaced on purpose, move the file out of that folder and restart Code Flow.`;
  if (fault) return `Mission record ${id} can’t be read: ${reason}. Restore ${fault.file} from a backup, or move it out of that folder and restart Code Flow. Until then its repository is unknown, so no new mission can be created on this host.`;
  return `Mission storage needs repair (${id}): ${reason}`;
}
function MissionRepair({ id, reason, fault, projectId, refresh }: { id: string; reason: string; fault?: ProjectTeamFault; projectId: string; refresh: () => Promise<void> }) {
  const ownership = fault?.kind === "ownership";
  return <div class="mission-repair" role="alert">
    <p><strong>{ownership ? `“${fault.name}” needs a repository review.` : "A saved mission needs repair."}</strong> {ownership ? "The repository changed since this mission was saved. Work is paused and its history is retained." : "Work is paused until the saved record can be read."}</p>
    <details><summary>Review repair</summary>
      <p>{ownership ? "Review the repository linked to this project before restoring or replacing the mission record." : "Restore the saved record from a backup, then restart Code Flow and check again."}</p>
      <div class="settings-actions"><a class="btn small" href={`#/project/${encodeURIComponent(projectId)}/repositories`}>Review repository</a><button class="btn small" onClick={() => void refresh()}>Check again</button></div>
      <details><summary>Technical details</summary><p class="help">{faultText(id, reason, fault)}</p></details>
    </details>
  </div>;
}
export function ProjectTeamsPanel({ projectId, repos }: { projectId: string; repos: string[] }) {
  const [data, setData] = useState<Inventory>(), [error, setError] = useState<{ message: string; status?: number }>(), [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const loads = useRef(0), snapshots = useRef(0);
  const latestSnapshot = useRef<Partial<Inventory>>();
  const [initialDefinition, setInitialDefinition] = useState<AgentTeamSnapshot>();
  const [featureBusy, setFeatureBusy] = useState(false), [featureError, setFeatureError] = useState("");
  const load = async () => {
    const request = ++loads.current, before = snapshots.current; setLoading(true);
    try {
      const inventory = await api<Inventory>(`/api/project-teams?project=${encodeURIComponent(projectId)}`);
      if (request !== loads.current) return;
      // Live snapshots can arrive before the initial inventory (or a refresh) finishes.
      setData(snapshots.current !== before ? { ...inventory, ...latestSnapshot.current } : inventory); setError(undefined);
    } catch (e) { if (request === loads.current) setError({ message: (e as Error).message, status: e instanceof ApiError ? e.status : undefined }); }
    finally { if (request === loads.current) setLoading(false); }
  };
  const toggle = async () => {
    if (!data || featureBusy) return; setFeatureBusy(true); setFeatureError("");
    try { await post("/api/project-teams/settings", { enabled: !data.enabled, revision: data.revision }); setCreating(false); await load(); }
    catch (error) { setFeatureError((error as Error).message); await load(); }
    finally { setFeatureBusy(false); }
  };
  useEffect(() => {
    latestSnapshot.current = undefined; setData(undefined); void load();
    const refresh = () => { void load(); }; window.addEventListener("focus", refresh);
    const off = subscribe(`project-teams:${projectId}`, event => {
      if (event.type !== "snapshot") return;
      const snapshot = { teams: event.teams, definitions: event.definitions, definitionFaults: event.definitionFaults, enabled: event.enabled, revision: event.revision, source: event.source, autoTeamEnabled: event.autoTeamEnabled };
      latestSnapshot.current = snapshot; snapshots.current++;
      setData(prior => prior ? { ...prior, ...snapshot } : prior);
    });
    return () => { loads.current++; off(); window.removeEventListener("focus", refresh); };
  }, [projectId]);
  if (error) return <section class="pp-card pp-unavailable" aria-label="Project missions">
    <div class="pp-card-head"><h2>Project missions</h2><span class="badge">Unavailable</span><button class="btn small" disabled={loading} onClick={() => void load()}>{loading ? "Retrying…" : "Retry"}</button></div>
    <div class="pp-unavailable-body" role="alert">
      <p>{error.status === 404 ? "Project missions aren’t available on this computer." : "Couldn’t load project missions."}</p>
      <p class="help">{error.status === 404 ? "The connected server doesn’t provide this feature. It may need an update." : error.message}</p>
    </div>
  </section>;
  if (!data) return null;
  const ready = data.enabled && data.autoTeamEnabled;
  const assigned = (repo: string) => data.teams.find((t) => t.status !== "archived" && t.projectId === projectId && t.repo === repo);
  // This project's own missions come from the live list; the server adds other projects', linked worktrees' and held ones.
  const ownerOf = (repo: string): Owner | undefined => { const team = assigned(repo); return team ? { name: team.name, projectId } : data.repositoryOwners?.[repo]; };
  const free = repos.filter((repo) => !ownerOf(repo));
  const createProblem = data.creationBlocked ? "Repair the damaged mission record below first. Until then its repository is unknown, so no new mission can be created." : repos.length && !free.length ? `Every repository here already has a mission. ${repos.map((repo) => `${baseName(repo)}: ${ownedProblem(ownerOf(repo)!, projectId)}`).join(" ")}` : undefined;
  return <section class="pp-card standing-teams" aria-label="Project missions">
    <ProjectBriefing teams={data.teams.filter((t) => t.projectId === projectId)} faulty={Object.keys(data.faults).length > 0} changed={load} />
    <div class="pp-card-head"><h2>Project missions</h2><button class="btn small" disabled={!ready || !repos.length || !!createProblem} aria-describedby={ready && createProblem ? `create-mission-help-${projectId}` : undefined} onClick={() => { setInitialDefinition(undefined); setCreating(!creating); }}>Create a mission</button></div>
    <p class="help">Assign an agent team to this project. Give it tasks directly or enable recurring discovery to prepare improvements for your review.</p>
    {ready && createProblem && <p class="help" id={`create-mission-help-${projectId}`}>{createProblem}</p>}
    <div class="settings-actions"><button class="btn small" disabled={featureBusy || data.source === "unavailable"} onClick={() => void toggle()}>{featureBusy ? "Saving…" : data.enabled ? "Disable project missions" : "Enable project missions"}</button><span class="help">{data.source === "unavailable" ? "Unavailable · the saved setting can’t be read" : `${data.enabled ? "Enabled on this host" : "Off on this host"} · saved across restarts`}</span></div>
    <p class="help">This setting applies to all projects on this host. New missions need separate activation. Enabling it resumes schedules for missions already active; stop active cycles before disabling it.</p>
    {!data.autoTeamEnabled && <p class="help">Auto team execution is disabled by this host’s configuration. Project missions can run once the host permits Auto team execution.</p>}
    {featureError && <p role="alert">{featureError}</p>}
    {Object.entries(data.faults).map(([id, reason]) => <MissionRepair key={id} id={id} reason={reason} fault={data.faultDetails?.[id]} projectId={projectId} refresh={load} />)}
    {Object.entries(data.definitionFaults ?? {}).map(([id, reason]) => <div class="mission-repair" role="alert" key={id}><p>A saved team can’t be loaded.</p><details><summary>Review repair</summary><p>Restore its saved record from a backup, then restart Code Flow.</p><details><summary>Technical details</summary><p class="help">{id}: {reason}</p></details></details></div>)}
    <AgentTeamLibrary definitions={data.definitions ?? []} providers={data.providers} canAssign={ready && repos.some((repo) => !!assigned(repo) || !ownerOf(repo) && !data.creationBlocked)} assign={(definition) => { setInitialDefinition(definition); setCreating(true); }} changed={load} />
    {creating && ready && (initialDefinition
      ? <AssignmentForm key={`${initialDefinition.id}:${initialDefinition.revision}`} definition={initialDefinition} projectId={projectId} repos={repos} assignments={data.teams} ownerOf={ownerOf} creationBlocked={!!data.creationBlocked} providers={data.providers} definitions={data.definitions ?? []} saved={() => { setCreating(false); void load(); }} refresh={load} />
      : <TeamForm projectId={projectId} repos={free} providers={data.providers} definitions={data.definitions ?? []} blocked={createProblem} saved={() => { setCreating(false); void load(); }} />)}
    {data.teams.map((t) => <TeamCard key={t.id} team={t} projectId={projectId} enabled={data.enabled && data.autoTeamEnabled} providers={data.providers} definitions={data.definitions ?? []} changed={load} />)}
  </section>;
}
function AssignmentForm({ definition, projectId, repos, assignments, ownerOf, creationBlocked, providers, definitions, saved, refresh }: { definition: AgentTeamSnapshot; projectId: string; repos: string[]; assignments: ProjectTeam[]; ownerOf: (repo: string) => Owner | undefined; creationBlocked: boolean; providers: Provider[]; definitions: AgentTeamSnapshot[]; saved: () => void; refresh: () => unknown }) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const existing = assignments.find((team) => team.repo === repo && team.projectId === projectId && team.status !== "archived");
  const owner = existing ? undefined : ownerOf(repo);
  const blocked = owner ? `This repository can’t take a new assignment. ${ownedProblem(owner, projectId)}` : !existing && creationBlocked ? "Repair the damaged mission record above before assigning a team to this repository." : undefined;
  return <section aria-label="Assign agent team to project">
    <label>Repository for team assignment<select class="field" aria-label="Repository for team assignment" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>{repos.map((path) => <option key={path}>{path}</option>)}</select></label>
    {existing && <p class="help">This updates the team configuration of {existing.name}. Its mission history and charged usage stay with this assignment.</p>}
    {blocked && <p class="help">{blocked}</p>}
    <TeamForm key={repo} projectId={projectId} repos={[repo]} repoChosen providers={providers} definitions={definitions} initialDefinition={definition} team={existing} blocked={blocked} saved={saved} refresh={refresh} />
  </section>;
}
type TeamFormProps = { projectId: string; repos: string[]; repoChosen?: boolean; providers: Provider[]; definitions: AgentTeamSnapshot[]; initialDefinition?: AgentTeamSnapshot; team?: ProjectTeam; blocked?: string; saved: () => void; refresh?: () => unknown };
const edited = (t: ProjectTeam) => JSON.stringify([t.name, t.mission, t.scheduleEnabled, t.schedule, t.definition]);
/**
 * An open editor is bound to the revision it was opened from, so it can never save over a newer
 * change. Updates to what it doesn't edit (decisions, usage receipts) can't be lost and are adopted.
 */
function TeamForm(props: TeamFormProps) {
  const { team } = props;
  const [opened, setOpened] = useState(team), [revision, setRevision] = useState(team?.revision);
  const changedElsewhere = !!team && !!opened && edited(team) !== edited(opened);
  useEffect(() => { if (team && !changedElsewhere) setRevision(team.revision); }, [team?.revision, changedElsewhere]);
  return <MissionForm key={opened?.revision} {...props} team={opened} revision={revision} reload={changedElsewhere ? () => { setOpened(team); setRevision(team!.revision); } : undefined} />;
}
function MissionForm({ projectId, repos, repoChosen, providers, definitions, initialDefinition, team, blocked, saved, refresh, revision, reload }: TeamFormProps & { revision?: number; reload?: () => void }) {
  useEffect(() => { void loadModels(); }, []);
  const eligible = providers.filter((p) => p.available && !p.reason);
  const [definition, setDefinition] = useState(initialDefinition ?? team?.definition);
  const [scheduleEnabled, setScheduleEnabled] = useState(team ? team.scheduleEnabled !== false : false);
  const [name, setName] = useState(team?.name ?? "Product mission"), [repo, setRepo] = useState(team?.repo ?? repos[0] ?? ""), [mission, setMission] = useState(team?.mission.mission ?? ""), [users, setUsers] = useState(team?.mission.users ?? ""), [branch, setBranch] = useState(team?.mission.baseBranch ?? "main"), [check, setCheck] = useState(team?.mission.check ?? ""), [mode, setMode] = useState(team?.mission.mode ?? "propose"), [coordinator, setCoordinator] = useState(team?.mission.coordinator ?? eligible[0]?.id ?? ""), [pool, setPool] = useState<string[]>(team?.mission.pool ?? eligible.map((p) => p.id)), [paths, setPaths] = useState(team?.mission.paths.join("\n") ?? "*"), [priorities, setPriorities] = useState(team?.mission.priorities.join("\n") ?? ""), [exclusions, setExclusions] = useState(team?.mission.exclusions.join("\n") ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [advanced, setAdvanced] = useState({ excludedPaths: team?.mission.excludedPaths ?? [".codeflow", ".github/workflows"], maxFiles: team?.mission.maxFiles ?? 8, maxLines: team?.mission.maxLines ?? 400, rescanDays: team?.mission.rescanDays ?? 28, budget: team?.mission.budget ?? defaultProjectTeamBudget(), schedule: team?.schedule ?? team?.mission.schedule ?? { at: "09:00", days: [1], timezone: localTimezone() }, categories: team?.mission.categories ?? ["bug", "usability", "performance", "tests", "docs"], trust: team?.mission.trust ?? "standard", setup: team?.mission.setup ?? "", agentSettings: team?.mission.agentSettings ?? {} });
  const [detailsOpen, setDetailsOpen] = useState(!!team || !!initialDefinition), [drafting, setDrafting] = useState(false), [drafted, setDrafted] = useState(false), [questions, setQuestions] = useState<string[]>([]);
  const [draftError, setDraftError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({}), [appliedAnswers, setAppliedAnswers] = useState<Record<string, string>>({});
  const pendingAnswers = Object.entries(answers).some(([question, answer]) => answer.trim() && answer.trim() !== appliedAnswers[question]);
  const [defaults, setDefaults] = useState<MissionDefaults>(), [defaultsBusy, setDefaultsBusy] = useState(false), [defaultsError, setDefaultsError] = useState("");
  const touched = useRef({ check: false, setup: false, branch: false });
  const draftController = useRef<AbortController>();
  useEffect(() => () => draftController.current?.abort(), []);
  useEffect(() => {
    if (team || !repo) return;
    let live = true; setDefaults(undefined); setDefaultsBusy(true); setDefaultsError("");
    void api<MissionDefaults>(`/api/project-teams/defaults?project=${encodeURIComponent(projectId)}&repo=${encodeURIComponent(repo)}`).then(value => {
      if (!live) return;
      setDefaults(value);
      if (!touched.current.check) setCheck(value.check);
      if (!touched.current.branch) setBranch(value.baseBranch);
      if (!touched.current.setup) setAdvanced(current => ({ ...current, setup: value.setup }));
    }, error => { if (live) setDefaultsError((error as Error).message); }).finally(() => { if (live) setDefaultsBusy(false); });
    return () => { live = false; };
  }, [repo, projectId]);
  const generate = async () => {
    if (!mission.trim() || drafting) return;
    const controller = new AbortController(); draftController.current = controller;
    setDrafting(true); setError(""); setDraftError("");
    try {
      const text = drafted ? missionDraftInput({ name, mission, users, priorities: lines(priorities), exclusions: lines(exclusions), questions }, answers) : mission;
      const result = await api<{ draft: MissionDraft }>("/api/project-teams/draft", { method: "POST", body: JSON.stringify({ projectId, repo, text, agent: definition?.configuration.coordinator ?? coordinator }), signal: controller.signal });
      if (controller.signal.aborted) return;
      setName(result.draft.name); setMission(result.draft.mission); setUsers(result.draft.users); setPriorities(result.draft.priorities.join("\n")); setExclusions(result.draft.exclusions.join("\n")); setQuestions(result.draft.questions); setDrafted(true); setDetailsOpen(true);
      setAppliedAnswers(Object.fromEntries(Object.entries(answers).filter(([, answer]) => answer.trim()).map(([question, answer]) => [question, answer.trim()])));
    } catch (error) { if (!controller.signal.aborted) setDraftError((error as Error).message); }
    finally { if (!controller.signal.aborted) setDrafting(false); }
  };
  const hasCheck = !!check.trim() || !!team?.mission.verification?.checks.some(c => c.required) && check === team.mission.check;
  const submit = async (event: Event) => { event.preventDefault(); if (busy || drafting || pendingAnswers) return; if (mode === "build-within-scope" && !hasCheck) { setError("Add a verification command before enabling automatic builds, or choose proposals only."); setDetailsOpen(true); return; } setBusy(true); setError(""); try { const value = { ...advanced, ...(team?.mission.verification && check === team.mission.check ? { verification: team.mission.verification } : {}), ...(team?.mission.roleSettings ? { roleSettings: team.mission.roleSettings } : {}), mission, users, baseBranch: branch, mode, check, coordinator, pool, paths: lines(paths), priorities: lines(priorities), exclusions: lines(exclusions) }; await post(team ? `/api/project-teams/${team.id}` : "/api/project-teams", { operationId: key(), ...(team ? { revision } : { projectId, repo }), ...(definition ? { definition: { id: definition.id, revision: definition.revision } } : team ? { definition: null } : {}), scheduleEnabled, name, mission: value }); saved(); } catch (e) { setError((e as Error).message); if (e instanceof ApiError && e.status === 409) void refresh?.(); } finally { setBusy(false); } };
  // A server error describes the values that were submitted; editing them makes it stale.
  return <form class="pt-form" aria-label={team ? "Edit mission" : "Create mission"} aria-busy={drafting || busy} onSubmit={submit} onInput={() => { setError(""); setDraftError(""); }}>
    <fieldset class="pt-fields" disabled={busy || drafting}>
    {!team && !repoChosen && <label>Repository<select class="field" value={repo} onChange={(e) => { touched.current = { check: false, setup: false, branch: false }; setCheck(""); setBranch(""); setAdvanced(current => ({ ...current, setup: "" })); setDrafted(false); setQuestions([]); setAnswers({}); setAppliedAnswers({}); setRepo(e.currentTarget.value); }}>{repos.map((r) => <option key={r}>{r}</option>)}</select></label>}
    <label>Mission<textarea class="field" required rows={3} value={mission} placeholder="What should the agents improve, and why?" onInput={(e) => setMission(e.currentTarget.value)} /></label>
    {!team && <div class="pt-draft-assist"><p class="help">Describe the outcome. AI can draft the mission details for you to review. Saving a draft does not start work.</p><div class="pt-actions"><button class="btn primary" type="button" disabled={!mission.trim() || !eligible.length || !!blocked || defaultsBusy} onClick={() => void generate()}>{drafting ? "Drafting mission…" : drafted ? "Redraft with AI" : "Draft with AI"}</button><button class="btn" type="button" onClick={() => setDetailsOpen(true)}>Configure manually</button></div></div>}
    {draftError && <p role="alert">{draftError}</p>}
    {drafted && !draftError && !drafting && <p class="help" role="status">{pendingAnswers ? "Update the draft with your answers before saving." : "Draft ready. Review the mission and intended users before saving."}</p>}
    {questions.length > 0 && <section class="pt-draft-questions" aria-label="Clarify your mission"><h3>To clarify</h3><p class="help">Answer what you know, then update the draft. You can leave a question blank if you’re unsure.</p>{questions.map((question, index) => <label key={`${index}:${question}`}>{question}<textarea class="field" rows={2} maxLength={2000} value={Object.hasOwn(answers, question) ? answers[question] : ""} placeholder="Your answer" onInput={(e) => setAnswers(current => ({ ...current, [question]: e.currentTarget.value }))} /></label>)}<button class="btn" type="button" disabled={!pendingAnswers || !mission.trim() || !eligible.length || !!blocked || defaultsBusy} onClick={() => void generate()}>{drafting ? "Updating draft…" : "Update draft with answers"}</button></section>}
    <details open={detailsOpen} onToggle={(e) => setDetailsOpen(e.currentTarget.open)}><summary>Mission details</summary><div class="pt-fields">
    <label>Mission name<input class="field" required value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
    <label>Agent team<select class="field" aria-label="Agent team" value={definition ? `${definition.id}:${definition.revision}` : ""} onChange={(e) => setDefinition(definitions.find((entry) => `${entry.id}:${entry.revision}` === e.currentTarget.value))}><option value="">Custom team for this assignment</option>{definition && !definitions.some((entry) => entry.id === definition.id && entry.revision === definition.revision) && <option value={`${definition.id}:${definition.revision}`}>{definition.name} · pinned version {definition.revision}</option>}{definitions.map((entry) => <option key={entry.id} value={`${entry.id}:${entry.revision}`}>{entry.name} · version {entry.revision}</option>)}</select></label>
    {definition && <p class="help">Using {definition.name}, version {definition.revision}. Its coordinator, provider pool and model settings are pinned to this assignment.</p>}
    <label>Intended users<textarea class="field" required value={users} onInput={(e) => setUsers(e.currentTarget.value)} /></label>
    <label>Priorities, one per line<textarea class="field" value={priorities} onInput={(e) => setPriorities(e.currentTarget.value)} /></label>
    <label>Things to avoid, one per line<textarea class="field" value={exclusions} onInput={(e) => setExclusions(e.currentTarget.value)} /></label>
    <label>Base branch<input class="field" required value={branch} onInput={(e) => { touched.current.branch = true; setBranch(e.currentTarget.value); }} /></label>
    <label>Autonomy<select class="field" value={mode} onChange={(e) => setMode(e.currentTarget.value as typeof mode)}><option value="propose">Propose improvements for me to choose</option><option value="build-within-scope">Also build one eligible draft per cycle</option></select></label>
    <label>Verification command<input class="field" value={check} placeholder="Optional for proposals" onInput={(e) => { touched.current.check = true; setCheck(e.currentTarget.value); }} /></label>
    <p class="help">{defaultsBusy ? "Finding repository defaults…" : defaults?.source && check === defaults.check ? `Detected from ${defaults.source}. ` : ""}{mode === "propose" ? "Not required to propose improvements. Add a check before asking the team to build changes." : "Required before the team can build changes automatically."}</p>
    {defaultsError && <p class="help" role="alert">Couldn’t load repository defaults: {defaultsError}. You can enter them manually.</p>}{defaults?.warning && <p class="help">{defaults.warning}</p>}
    <label>Allowed paths, one per line<textarea class="field" value={paths} onInput={(e) => setPaths(e.currentTarget.value)} /></label>
    {!definition && <><label>Coordinator<select class="field" value={coordinator} required onChange={(e) => setCoordinator(e.currentTarget.value)}>{eligible.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
    <fieldset><legend>Workers and independent reviewer</legend>{providers.map((p) => <label key={p.id}><input type="checkbox" checked={pool.includes(p.id)} disabled={!p.available || !!p.reason} onChange={(e) => setPool(e.currentTarget.checked ? [...pool, p.id] : pool.filter((id) => id !== p.id))} /> {p.name}{p.reason ? ` — ${p.reason}` : !p.available ? " — unavailable" : ""}</label>)}</fieldset></>}
    <label><input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.currentTarget.checked)} />Run recurring discovery</label>
    <details><summary>Schedule, budget and scope limits</summary>
      {/* Part of this form: Save mission saves the schedule shown. "Run recurring discovery" turns it off. */}
      <ScheduleEditor automation={{ name, schedule: advanced.schedule }} zoneRequired onChange={(schedule) => setAdvanced((current) => ({ ...current, schedule }))} />
      <p class="help">Budget is reserved before each phase. Outstanding work stays charged until its usage is known.</p>
      {([ ["discoveryCalls", "Calls per discovery"], ["discoveryMinutes", "Minutes per discovery"], ["buildCalls", "Calls per implementation"], ["buildMinutes", "Minutes per implementation"], ["weeklyCalls", "Calls per rolling week"], ["weeklyMinutes", "Minutes per rolling week"] ] as const).map(([field, label]) => { const range = PROJECT_TEAM_BUDGET_RANGES[field]; return <label key={field}>{label} <span class="help">{range.min}–{range.max}</span><input class="field" type="number" min={range.min} max={range.max} step={1} value={advanced.budget[field]} onInput={(e) => setAdvanced({ ...advanced, budget: { ...advanced.budget, [field]: Number(e.currentTarget.value) } })} /></label>; })}
      <label>Maximum changed files<input class="field" type="number" min={1} max={100} value={advanced.maxFiles} onInput={(e) => setAdvanced({ ...advanced, maxFiles: Number(e.currentTarget.value) })} /></label>
      <label>Maximum changed lines<input class="field" type="number" min={1} max={10000} value={advanced.maxLines} onInput={(e) => setAdvanced({ ...advanced, maxLines: Number(e.currentTarget.value) })} /></label>
      <label>Rescan unchanged repositories after this many days<input class="field" type="number" min={1} max={90} value={advanced.rescanDays} onInput={(e) => setAdvanced({ ...advanced, rescanDays: Number(e.currentTarget.value) })} /></label>
      <label>Excluded paths, one per line<textarea class="field" value={advanced.excludedPaths.join("\n")} onInput={(e) => setAdvanced({ ...advanced, excludedPaths: lines(e.currentTarget.value) })} /></label>
      <fieldset><legend>Allowed work categories</legend>{(["bug", "usability", "performance", "tests", "docs", "experiment"] as const).map((category) => <label key={category}><input type="checkbox" checked={advanced.categories.includes(category)} onChange={(e) => setAdvanced({ ...advanced, categories: e.currentTarget.checked ? [...advanced.categories, category] : advanced.categories.filter((c) => c !== category) })} />{category}</label>)}</fieldset>
      <label>Execution permissions<select class="field" value={advanced.trust} onChange={(e) => setAdvanced({ ...advanced, trust: e.currentTarget.value as ProjectTeamMission["trust"] })}><option value="safe">Safe</option><option value="standard">Standard</option><option value="trusted">Trusted</option></select></label>
      <label>Setup command<input class="field" value={advanced.setup} onInput={(e) => { touched.current.setup = true; setAdvanced({ ...advanced, setup: e.currentTarget.value }); }} /></label>
      {!definition && <fieldset><legend>Models and reasoning</legend>{agents.value.filter((a) => eligible.some((p) => p.id === a.id)).map((agent) => <ModelRow key={agent.id} agent={agent} used={pool.includes(agent.id) || coordinator === agent.id} settings={advanced.agentSettings[agent.id] ?? {}} onChange={(patch) => setAdvanced({ ...advanced, agentSettings: { ...advanced.agentSettings, [agent.id]: { ...advanced.agentSettings[agent.id], ...patch } } })} />)}</fieldset>}
    </details>
    </div></details>
    </fieldset>
    {reload && <div role="alert"><p>This mission was changed elsewhere after you opened this form, so saving it here is refused. Reload the form to edit the latest version; your unsaved changes here are discarded.</p><button type="button" class="btn small" onClick={reload}>Reload form</button></div>}
    {error && <p role="alert">{error}</p>}{detailsOpen && <button class="btn primary" disabled={busy || drafting || pendingAnswers || defaultsBusy || !eligible.length || !!blocked || !!reload}>{busy ? "Saving…" : team ? "Save mission" : "Save draft mission"}</button>}<button type="button" class="btn" disabled={busy} onClick={saved}>Cancel</button>
  </form>;
}
function TeamCard({ team: t, projectId, enabled, providers, definitions, changed }: { team: ProjectTeam; projectId: string; enabled: boolean; providers: Provider[]; definitions: AgentTeamSnapshot[]; changed: () => unknown }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [preview, setPreview] = useState<AutomationPreview>();
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(), [savingTeam, setSavingTeam] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<boolean>();
  const act = async (suffix: string, body: object) => { setBusy(true); try { await post(`/api/project-teams/${t.id}${suffix}`, { operationId: key(), revision: t.revision, ...body }); await changed(); return true; } catch (e) { showError((e as Error).message, 7000); await changed(); return false; } finally { setBusy(false); } };
  const latest = definitions.find((entry) => entry.id === t.definition?.id);
  const running = t.cycles.find((c) => ["requested", "discovering", "selecting", "building", "unknown"].includes(c.status));
  const { calls, minutes, reservedMinutes } = projectTeamUsage(t), remaining = allowance(t);
  const taskBudgetAvailable = remaining.calls >= t.mission.budget.buildCalls && remaining.minutes >= t.mission.budget.buildMinutes;
  const taskRefusal = taskAdmissionProblem(t);
  const archive = async () => {
    const waiting = t.opportunities.filter((o) => ["ready", "accepted"].includes(o.status)).length;
    if (!await confirmAction(`Archiving can’t be undone. Scheduling stops and the mission becomes read-only; its history, budget records, runs and branches are kept.${waiting ? `\n\n${waiting === 1 ? "1 result awaiting approval or shipping" : `${waiting} results awaiting approval or shipping`} can no longer be approved, published or merged from this mission.` : ""}\n\nYou can create a new mission for this repository afterwards.`, { title: "Archive this mission?", confirmLabel: "Archive mission", danger: true })) return;
    await act("", { status: "archived" });
  };
  // Listed here because this project now holds its repository; it can't run, only release it.
  if (t.projectId !== projectId) return <article class="pt-team"><h3>{t.name} <span class="help">{t.status} · from a deleted project</span></h3><p>{t.mission.mission}</p><p class="help">{t.repo} · {t.mission.baseBranch}</p>
    <p class="help">The project this mission belonged to was deleted, so it can't run. Archive it to keep its history and budget records and let this repository take a new mission.</p>
    {t.error && <p role="alert">{t.error}</p>}{t.recoveryError && <p role="alert">{t.recoveryError}</p>}
    <div class="pt-actions">{running && <button class="btn small" disabled={busy} onClick={() => act("/stop", {})}>Stop cycle</button>}<button class="btn small" disabled={busy || !!running} onClick={() => void archive()}>Archive mission</button></div>
  </article>;
  return <article class="pt-team"><h3>{t.name} <span class="help">{t.status} · mission {t.missionRevision}</span></h3><p>{t.mission.mission}</p><p class="help">{t.repo} · {t.mission.baseBranch} · {t.mission.mode === "propose" ? "Proposals" : "Build within scope"}</p><p class="help">Rolling week: {calls}/{t.mission.budget.weeklyCalls} calls used or reserved · {minutes}/{t.mission.budget.weeklyMinutes} minutes used or reserved{reservedMinutes > 0 ? ` (${reservedMinutes} reserved)` : ""}</p>
    {!running && !taskBudgetAvailable && <p class="help">The remaining weekly allowance cannot cover another task's full limit. Completed runs release unused allocations when their final usage is recorded; unknown launches stay reserved.</p>}
    {t.status !== "archived" && taskRefusal && (running || taskBudgetAvailable) && <p class="help" id={`task-refusal-${t.id}`}>Give team a task: {taskRefusal}.</p>}
    {t.error && <p role="alert">{t.error}</p>}{t.recoveryError && <p role="alert">{t.recoveryError}</p>}
    <p class="help">{t.definition ? `${t.definition.name} · team version ${t.definition.revision}` : "Custom agent team"} · {t.status === "archived" ? "Archived · read-only history" : t.scheduleEnabled === false ? "Manual tasks only" : !enabled ? "Recurring discovery is off on this host" : t.status !== "active" ? "Recurring discovery once active" : "Recurring discovery enabled"}</p>
    {t.status !== "archived" && <div class="pt-actions"><button class="btn small primary" disabled={busy || !enabled || !!taskRefusal} aria-describedby={taskRefusal && (running || taskBudgetAvailable) ? `task-refusal-${t.id}` : undefined} onClick={() => setTaskDraft(taskDraft ? undefined : { id: key(), title: "", instructions: "", acceptance: "" })}>Give team a task</button><button class="btn small" disabled={busy} onClick={() => setSavingTeam(!savingTeam)}>Save as reusable team</button>{latest && latest.revision !== t.definition?.revision && <button class="btn small" disabled={busy || !!running} onClick={() => act("", { definition: { id: latest.id, revision: latest.revision } })}>Use team version {latest.revision}</button>}<label><input type="checkbox" checked={pendingSchedule ?? t.scheduleEnabled !== false} disabled={busy || pendingSchedule !== undefined} onChange={async (e) => { const next = e.currentTarget.checked; setPendingSchedule(next); await act("", { scheduleEnabled: next }); setPendingSchedule(undefined); }} />Run recurring discovery</label></div>}
    {taskDraft && <OwnerTaskForm key={taskDraft.id} team={t} draft={taskDraft} saved={() => { setTaskDraft(undefined); void changed(); }} refresh={changed} cancel={() => setTaskDraft(undefined)} />}
    {savingTeam && <SaveAssignmentTeam team={t} saved={() => { setSavingTeam(false); void changed(); }} cancel={() => setSavingTeam(false)} />}
    {t.status !== "archived" && <div class="pt-actions"><button class="btn small" disabled={busy || !enabled && t.status !== "active"} onClick={() => act("", { status: t.status === "active" ? "paused" : "active" })}>{t.status === "active" ? "Pause" : "Activate"}</button><button class="btn small" disabled={busy || !enabled || !!running || t.status !== "active"} onClick={() => { setBusy(true); post(`/api/project-teams/${t.id}/cycle`, { operationId: key() }).then(changed, (e) => showError(e.message)).finally(() => setBusy(false)); }}>Run cycle now</button><button class="btn small" disabled={busy || !running} onClick={() => act("/stop", {})}>Stop cycle</button><button class="btn small" disabled={!!running} onClick={() => setEditing(!editing)}>Edit mission</button><button class="btn small" disabled={busy || !!running} onClick={() => void archive()}>Archive mission</button><button class="btn small" onClick={() => api<AutomationPreview>(`/api/project-teams/${t.id}/preview`).then(setPreview, (e) => showError(e.message))}>Preview next cycle</button></div>}
    {preview && <div role="status"><p>{preview.ready ? "Ready to discover" : preview.busy ? "A cycle is active" : "Not ready"}</p>{preview.warnings.map((w) => <p key={w}>{w}</p>)}{enabled && t.status === "active" && preview.nextTimes.length ? <SchedulePreview schedule={t.schedule ?? t.mission.schedule} /> : t.scheduleEnabled !== false && (t.status === "draft" || t.status === "paused") ? <p class="help">{t.status === "draft" ? "No runs are scheduled until you activate this mission." : "No runs are scheduled while this mission is paused."}</p> : null}</div>}
    {editing && <TeamForm projectId={t.projectId} repos={[t.repo]} providers={providers} definitions={definitions} team={t} saved={() => { setEditing(false); void changed(); }} refresh={changed} />}
    {t.status !== "archived" && t.scheduleEnabled !== false && <fieldset class="pt-schedule" disabled={busy}><ScheduleEditor key={JSON.stringify(t.schedule ?? t.mission.schedule)} automation={{ name: t.name, schedule: t.schedule ?? t.mission.schedule }} zoneRequired save={async (patch) => { await act("", patch); }} /></fieldset>}
    <div class="pt-opportunities">{[...t.opportunities].reverse().map((o) => <Opportunity key={o.id} team={t} opportunity={o} runId={t.cycles.filter((c) => c.opportunityId === o.id).at(-1)?.launches.at(-1)?.runId} busy={busy || t.status === "archived"} decide={(body) => act(`/opportunities/${o.id}`, { opportunityRevision: o.revision, ...body })} assign={(draft) => setTaskDraft({ ...draft, id: key() })} />)}</div>
    <details><summary>Cycle history ({t.cycles.length})</summary>{[...t.cycles].reverse().map((c) => <article key={c.id}><b>{new Date(c.at).toLocaleString()} · {c.status}</b><p>{c.summary ?? c.reason}</p>{c.summary && c.reason && <p>{c.reason}</p>}{c.selection?.reasons.map((r) => <p class="help" key={r.id}>{t.opportunities.find((o) => o.id === r.id)?.title}: {r.reason}</p>)}{c.launches.map((l) => <p key={l.claimId}>{l.phase}: {l.state} · {l.usage?.calls ?? l.usedCalls ?? l.calls} calls · {l.usage ? `${Math.ceil(l.usage.durationMs / 60_000)} minutes used` : `${l.minutes} minutes reserved`} {l.runId && <button class="btn small" onClick={() => { route.value = { view: "run", id: l.runId! }; }}>Open team run</button>}</p>)}</article>)}</details>
  </article>;
}
function OwnerTaskForm({ team, draft, saved, refresh, cancel }: { team: ProjectTeam; draft: TaskDraft; saved: () => void; refresh: () => unknown; cancel: () => void }) {
  const [title, setTitle] = useState(draft.title), [instructions, setInstructions] = useState(draft.instructions), [acceptance, setAcceptance] = useState(draft.acceptance), [category, setCategory] = useState(draft.category ?? team.mission.categories[0]);
  const form = useRef<HTMLFormElement>(null);
  // A task prefilled from an opportunity opens above that card, out of view.
  useEffect(() => { if (draft.title) { form.current?.scrollIntoView({ block: "center" }); form.current?.querySelector("input")?.focus(); } }, []);
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
  return <form ref={form} class="pt-form" aria-label="Give team a task" onSubmit={submit}>
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
function Opportunity({ team, opportunity: o, runId, busy, decide, assign }: { team: ProjectTeam; opportunity: ProjectOpportunity; runId?: string; busy: boolean; decide: (body: object) => unknown; assign: (draft: Omit<TaskDraft, "id">) => void }) {
  const [note, setNote] = useState("");
  // The server refuses these anyway; saying why up front saves filling in feedback for nothing.
  const refusal = buildRefusal(team, o), policy = candidateProblem(o, team.mission);
  const build = o.result ? "Request revision" : o.origin === "owner" ? "Run task again" : "Build proposal";
  const asTask = !o.result && o.origin !== "owner" && !!policy && policy !== CHECK_REQUIRED && !taskAdmissionProblem(team);
  const help = o.status === "accepted" || team.status === "archived" ? "" : refusal ? `${build}: ${refusal}` : o.result && !note.trim() ? "Describe the change you want in Feedback to request a revision." : "";
  const reject = async () => {
    if (o.result && !await confirmAction("It can no longer be approved, published or merged, and the team won’t propose this problem again. Its run and branch are kept; getting it back needs a new revision, which uses another implementation allocation.", { title: "Reject this result?", confirmLabel: "Reject result", danger: true })) return;
    await decide({ action: "reject", note });
  };
  return <article class="pt-opportunity" id={`opportunity-${o.id}`}><h4>{o.title} <span class="help">{o.status}</span></h4><p>{o.problem}</p>{o.origin !== "owner" && <p>{o.proposal}</p>}<p class="help">{o.origin === "owner" ? "Owner-assigned task" : `${o.benefit} · ${o.risk} risk · ${o.kind} · ${o.evidenceVerified ? "Code evidence verified" : "Evidence needs review"}`}</p>
    <details><summary>Evidence and acceptance criteria</summary>{o.evidence.map((e, i) => <blockquote key={i}><code>{e.path}</code><pre>{e.quote}</pre></blockquote>)}<ul>{o.acceptance.map((a) => <li key={a}>{a}</li>)}</ul><p>{o.rationale}</p><p>Paths: {o.paths.join(", ")}</p></details>
    {o.reason && <p>{o.reason}{o.status === "blocked" && !o.result && runId ? <> <button class="btn small" onClick={() => { route.value = { view: "run", id: runId }; }}>Open team run</button></> : null}</p>}{o.result && <><code>{o.result.head.slice(0, 12)}</code> <button class="btn small" onClick={() => { route.value = { view: "run", id: o.result!.runId }; }}>Review diff and checks</button></>}
    {!["shipped", "implementing"].includes(o.status) && <><label>Feedback<textarea class="field" value={note} onInput={(e) => setNote(e.currentTarget.value)} /></label><div class="pt-actions">{o.status === "ready" && <button class="btn small primary" disabled={busy} onClick={() => decide({ action: "approve", note })}>Approve this commit</button>}<button class="btn small" disabled={busy || o.status === "accepted" || !!refusal || !!o.result && !note.trim()} aria-describedby={help ? `opportunity-help-${o.id}` : undefined} onClick={() => decide({ action: o.result ? "revise" : "build", note })}>{build}</button>{asTask && <button class="btn small" disabled={busy} onClick={() => assign({ title: o.title.slice(0, 180), instructions: `${o.problem}\n\n${o.proposal}`.slice(0, 3000), acceptance: o.acceptance.join("\n"), category: team.mission.categories.includes(o.category) ? o.category : undefined })}>Give as a task</button>}<button class="btn small" disabled={busy} onClick={() => decide({ action: "defer", note, deferUntil: Date.now() + 7 * 86400000 })}>Defer one week</button><button class="btn small" disabled={busy} onClick={() => void reject()}>Reject</button></div>
      {help && <p class="help" id={`opportunity-help-${o.id}`}>{help}</p>}</>}
    {o.status === "accepted" && <p class="help">Approved. Open the result to publish a PR or merge using the existing review controls.</p>}
  </article>;
}

/** Compact owner inbox; detailed evidence stays on the project page. No separate EventSource. */
export function ProjectTeamsInbox({ projectId }: { projectId?: string }) {
  const [teams, setTeams] = useState<ProjectTeam[]>([]);
  useEffect(() => { let active = true; const load = () => api<Inventory>(`/api/project-teams${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`).then((data) => { if (active) setTeams(data.teams); }, () => undefined); const stop = pollVisible(load, 15000); return () => { active = false; stop(); }; }, [projectId]);
  const actionable = teams.filter((t) => projectTeamNeedsOwner(t) && (projectId ? t.projectId === projectId : projects.value.some((p) => p.id === t.projectId)));
  if (!actionable.length) return null;
  return <section class="pp-card standing-teams"><h2>Mission opportunities</h2>{actionable.map((t) => <article key={t.id}><h3>{t.name}</h3><p>{projectTeamInboxSummary(t)}</p><button class="btn" onClick={() => { route.value = { view: "project", id: t.projectId, section: "automation", kind: "missions" }; }}>Review opportunities</button></article>)}</section>;
}

function ProjectBriefing({ teams, faulty, changed }: { teams: ProjectTeam[]; faulty: boolean; changed: () => unknown }) {
  const entries = teams.filter(team => team.status !== "archived").flatMap(team => team.opportunities.filter(opportunity => ["ready", "proposed", "blocked", "accepted"].includes(opportunity.status)).map(opportunity => ({ team, opportunity })));
  const ordered = [...entries].sort((a, b) => Number(b.opportunity.status === "ready") - Number(a.opportunity.status === "ready") || b.opportunity.impact - a.opportunity.impact || b.opportunity.createdAt - a.opportunity.createdAt).slice(0, 3);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  /** Rejecting is permanent for a verified draft, so the owner confirms what it costs first. */
  const dismiss = async (team: ProjectTeam, opportunity: ProjectOpportunity) => {
    const draft = !!opportunity.result && ["ready", "accepted"].includes(opportunity.status);
    const message = draft ? "The verified draft can no longer be approved, published or merged, and the team won’t propose this problem again. Its run and branch are kept; getting it back needs a new revision, which uses another implementation allocation." : "This records your decision, and the team won’t propose this problem again.";
    if (!await confirmAction(message, { title: draft ? "Reject this verified draft?" : "Reject this opportunity?", confirmLabel: draft ? "Reject draft" : "Reject opportunity", danger: true })) return;
    setBusy(opportunity.id); setError("");
    try { await post(`/api/project-teams/${team.id}/opportunities/${opportunity.id}`, { operationId: key(), revision: team.revision, opportunityRevision: opportunity.revision, action: "reject", note: "Dismissed from the project briefing" }); showToast("Rejected. The team won’t propose this again.", 4000); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(""); void changed(); }
  };
  return <section class="project-briefing" aria-label="Project briefing"><div class="experience-kicker">PROJECT BRIEFING</div><h2>{ordered.length ? "Worth your attention" : "No new opportunities to review"}</h2><p class="help">{teams.some(team => team.status === "active") ? "Your team's assigned tasks and discovered improvements appear here for review." : faulty ? "A mission record needs repair; see the notice below." : "Assign and activate an agent team below to start work on this project."}</p><div class="briefing-grid">{ordered.map(({ team, opportunity: o }) => <article key={o.id}><span class="badge">{o.status === "ready" ? "Verified draft" : o.status}</span><h3>{o.title}</h3><p>{o.benefit}</p><p class="help">{o.origin === "owner" ? "Owner-assigned task" : `${o.users} · ${o.risk} risk · ${o.evidenceVerified ? "Source quotes checked" : "Evidence needs review"}`}</p><details><summary>Why this matters</summary><p>{o.problem}</p><p>{o.rationale}</p>{o.evidence.slice(0, 3).map((e, index) => <blockquote key={index}><code>{e.path}</code><pre>{e.quote}</pre></blockquote>)}<p class="help">Source commit {o.baseCommit.slice(0, 12)}</p></details><div class="experience-actions">{o.result ? <a class="btn small primary" href={`#/run/${o.result.runId}`}>Try and review draft</a> : <button class="btn small" onClick={() => document.getElementById(`opportunity-${o.id}`)?.scrollIntoView({ block: "center", behavior: scrollBehavior() })}>Review proposal</button>}<button class="btn ghost small" disabled={!!busy} onClick={() => void dismiss(team, o)}>{o.result ? "Reject draft…" : "Reject opportunity…"}</button></div></article>)}</div>{entries.length > 3 ? <p class="help">{entries.length - 3} more opportunities are available in the team details below.</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
