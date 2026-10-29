import { EXECUTION_BUDGET_PRESETS, budgetDuration } from "../src/execution-budget.js";
import { teamApprovalProblem } from "./task-team-choices.js";
import { composerCheckMode, checkExplanation, type CheckMode } from "./composer-checks.js";
import { modelIdProblem } from "../src/model-id.js";
import { providerProblem, providerSetupProblem } from "./provider-readiness.js";
import { startBranchLabel } from "./start-branch.js";
import { BrowserDraftCards } from "./browser-context-cards.js";
import { browserImageNames, editBrowserText, parseBrowserMessage } from "./browser-context.js";
import { TaskTeamControl, defaultTaskTeam } from "./task-team.js";
import type { TaskTeamConfig } from "../src/task-team.js";
import { WorkerModelCatalog, discoveredCatalogs } from "./model-catalog.js";
import { runProviderProblem, supportsRunPermissions, type PermissionRequirement } from "../src/run-permissions.js";
import { TeamTemplateLibrary } from "./team-template-library.js";
import { selectedTeamTemplate } from "./team-template-state.js";
import { confirmAction } from "./confirm-state.js";
import { intentDraft, WorkflowRecommendation } from "./experience.js";
import { journeyDraft } from "./journeys.js";
import { composerRunBody } from "./composer-body.js";
import { NumberField, numberInputProblem } from "./number-field.js";
import { EXECUTION_LIMITS, MAX_COMPARE_RUNS, acceptanceCriteriaProblem, executionLimitsProblem, numberProblem, taskTeamLimitsProblem } from "../src/start-input-validation.js";
import { SCHEDULE_KINDS, type ScheduleKind } from "./scheduling.js";
import { improveSettings } from "./improve-settings.js";
import { IMPROVE_NAMES } from "../src/improve-settings.js";
import { ModelSelect } from "./model-select.js";
import { freeModelsFirst, isFreeModel } from "./model-order.js";
import type { ComponentChildren } from "preact";
import { ChatControls, PermissionMenu, type ChatPermissions } from "./chat-controls.js";
import { canAskForApproval, toolApprovalState } from "./composer-permissions.js";
import type { VerificationProfile } from "../src/verification.js";
import { batch, effect } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { AgentTag } from "./bits.js";
import { api, showToast, ApiError, baseName, enc, fmtSize, post, readBase64, SHORT, store, useLatest, plural } from "./lib.js";
import { useDialog } from "./app.js";
import { AcceptanceEditor, ContextInspector, EffectiveSettings, ProviderSetupPrompt, RepositoryReadiness, SaveTaskTemplateDialog, UseTaskTemplateDialog } from "./onboarding.js";
import { rerunDraft } from "./rerun-draft.js";
import { RemoteWorkerSelect, type WorkerChoice } from "./remote-workers.js";
import type { WorkerCapabilities } from "../src/remote-workers/protocol.js";
import { DeferredRunsPanel } from "./deferred-runs.js";
import { contextBudget } from "./context-budget.js";
import {
  agents,
  executionPaused,
  composerProject,
  composerLoading,
  composerRunOptions,
  draftError,
  draftUnavailable,
  unreadableDrafts,
  projectsLoaded,
  projectsStatus,
  projectPickerPurpose,
  projectsOpen,
  saveComposerDraft,
  chooseComposerRepository,
  projects,
  repositoryChoice,
  openComposer,
  acceptanceCriteria,
  setAcceptanceCriteria,
  configChecking,
  agentSettings,
  planApprovalFor,
  health,
  healthError,
  repoConfig,
  roleModels,
  setRoleModel,
  setTrust,
  trust,
  CHECKPOINTS,
  setApprovePlan,
  attachments,
  baseRef,
  branchPrefix,
  catalogs,
  checkCmd,
  checkWarning,
  contextError,
  contextPaths,
  currentProject,
  openSide,
  limits,
  optionsFor,
  pattern,
  patterns,
  teamRollout,
  pickerOpen,
  refreshRuns,
  repo,
  repoChecking,
  repoError,
  repoInfo,
  rolesFor,
  route,
  setProviderDefault,
  providerDefaults,
  setRunCheck,
  setRunSetup,
  setRunLimits,
  forgetChoices,
  composerOrigins,
  RERUN_ORIGIN,
  rememberBase,
  knownBase,
  baseNotice,
  loadCheck,
  setOption,
  setPattern,
  setRoles,
  setTask,
  setupCmd,
  source,
  externalSource,
  task,
  ghPicker,
  afterStart,
  loadProjects,
  target,
  chatDrafts,
  takeDrafts,
  type RoleValue,
} from "./state.js";
import { ProjectButton, openRepository } from "./projects.js";
import { computerLabel } from "./ssh-projects.js";
import { readProjectDefaults, projectDefaultsVersion } from "./project-defaults.js";
import { TeamRolloutNotice } from "./team-evaluation.js";
import { SourceChip } from "./github.js";
import { SaveAutomationDialog } from "./automations.js";
import { Icon } from "./icons.js";
import { Menu, MenuItem, MenuTitle } from "./panel-bits.js";
import { POLICY_PAUSED, PolicyPauseNotice } from "./policy-pause.js";
import type { AgentId, AgentInfo, ContextItem, ModelCatalog, PatternInfo, TreeEntry } from "./types.js";

const DRAG_TYPE = "application/x-codeflow-path";
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
/** The Permissions choice this browser remembers; undefined until one is made. */
const storedToolApprovals = () => { const value = store.get("interactiveApprovals"); return value === null ? undefined : value === "1"; };

// ================================================================= composer
export function Composer() {
  const restored = rerunDraft.value?.repo === repo.value ? rerunDraft.value : null;
  const initialOptions = useRef(composerRunOptions.value);
  const [taskTeam, setTaskTeam] = useState<TaskTeamConfig | undefined>(initialOptions.current.taskTeam);
  const [remoteWorker, setRemoteWorker] = useState<WorkerChoice | undefined>(initialOptions.current.remoteWorker);
  const [remoteAgents, setRemoteAgents] = useState<AgentInfo[]>();
  const [remoteError, setRemoteError] = useState("");
  useEffect(() => { let alive = true; setRemoteAgents(undefined); setRemoteError(""); if (remoteWorker) void post<{ capabilities: WorkerCapabilities }>(`/api/remote-workers/${encodeURIComponent(remoteWorker.workerId)}/probe`, { repoMapping: remoteWorker.repoMapping }).then(({ capabilities }) => { if (alive) setRemoteAgents(agents.value.map((agent) => ({ ...agent, available: capabilities.providers.some((provider) => provider.id === agent.id && provider.available) }))); }, (error) => { if (alive) setRemoteError(error.message); }); return () => { alive = false; }; }, [remoteWorker?.workerId, remoteWorker?.repoMapping, agents.value]);
  const [containerEnabled, setContainerEnabled] = useState(initialOptions.current.container?.enabled ?? false);
  const [containerImage, setContainerImage] = useState(initialOptions.current.container?.image ?? "");
  const [containerVolume, setContainerVolume] = useState(initialOptions.current.container?.authVolume ?? "");
  const [verificationProfile, setVerificationProfile] = useState<VerificationProfile | null>(initialOptions.current.verificationProfile ?? null);
  const [verificationPreset, setVerificationPreset] = useState(initialOptions.current.verification ?? "");
  const [profileLoading, setProfileLoading] = useState(false);
  const profileRequest = useRef(0);
  const [nativeAntigravity, setNativeAntigravity] = useState(initialOptions.current.antigravityExecution === "native");
  const [permissionRequirements, setPermissionRequirements] = useState<PermissionRequirement[]>(initialOptions.current.permissionRequirements ?? []);
  // Only an explicit choice is kept (and saved with the draft); without one the default follows the workflow and provider.
  const [toolApprovals, setToolApprovals] = useState<boolean | undefined>(initialOptions.current.toolApprovals ?? storedToolApprovals());
  const improve = useImprove(remoteWorker ? "Improve uses a local provider. Choose This computer to rewrite this task." : containerEnabled ? "Improve uses a local provider. Turn off Docker isolation to rewrite this task." : "");
  const p = pattern.value;
  const single = p?.id === "solo";
  const checkMode = composerCheckMode(p?.id, { checkpointOnFinish: restored?.checkpointOnFinish, remote: !!remoteWorker, team: !!taskTeam?.enabled, container: containerEnabled });
  const automaticChecks = checkMode !== "conversation";
  const [moreOptions, setMoreOptions] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [budgetRevision, setBudgetRevision] = useState(0);
  const chooseBudget = (budget: typeof EXECUTION_BUDGET_PRESETS[number]) => {
    batch(() => {
      setRunLimits({ maxSteps: budget.maxSteps, maxMinutes: budget.maxMinutes });
      // Choosing a preset explicitly replaces a retry's original call ceiling too.
      if (rerunDraft.value) rerunDraft.value = { ...rerunDraft.value, loop: { ...rerunDraft.value.loop, maxInvocations: budget.maxSteps } };
    });
    if (single) setTaskTeam(previous => ({ ...(previous ?? defaultTaskTeam(soloAgent && soloAgent !== "auto" ? soloAgent : "claude")), maxCalls: budget.maxSteps, maxMinutes: budget.maxMinutes }));
    setBudgetRevision(value => value + 1);
  };
  const [advancedOpen, setAdvancedOpen] = useState(() => store.get("composerAdvanced") === "1");
  const selectVerification = async (selected: string) => {
    const request = ++profileRequest.current;
    const current = repo.value;
    setProfileError(""); setError(""); setVerificationPreset(selected); setVerificationProfile(null); setProfileLoading(!!selected);
    if (!selected) return;
    try {
      const profile = await api<VerificationProfile>(`/api/verification/profile?repo=${enc(current)}&preset=${selected}`);
      if (repo.value === current && request === profileRequest.current) setVerificationProfile(profile);
    } catch (error) {
      if (request === profileRequest.current) { setProfileError((error as Error).message); }
    } finally { if (request === profileRequest.current) setProfileLoading(false); }
  };
  const [profileError, setProfileError] = useState("");
  useLayoutEffect(() => {
    const defaults = readProjectDefaults(repo.value);
    const container = initialOptions.current.container ?? defaults.container;
    setContainerEnabled(container.enabled); setContainerImage(container.image); setContainerVolume(container.authVolume);
    setRemoteWorker(initialOptions.current.remoteWorker);
    setToolApprovals(initialOptions.current.toolApprovals ?? storedToolApprovals());
    setProfileError("");
    if (initialOptions.current.verification === "restored") {
      ++profileRequest.current;
      setProfileLoading(false);
      setVerificationPreset("restored");
      setVerificationProfile(initialOptions.current.verificationProfile ?? null);
    } else void selectVerification(initialOptions.current.verification ?? defaults.verification);
    return () => { ++profileRequest.current; };
  }, [repo.value, projectDefaultsVersion.value, restored]);

  useLayoutEffect(() => {
    // An option equal to the project's default isn't the draft's own: the draft follows a later default.
    const defaults = readProjectDefaults(repo.value), container = { enabled: containerEnabled, image: containerImage, authVolume: containerVolume };
    const ownContainer = container.enabled !== defaults.container.enabled || container.image !== defaults.container.image || container.authVolume !== defaults.container.authVolume;
    if (!composerLoading.value) composerRunOptions.value = { taskTeam, remoteWorker, container: ownContainer ? container : undefined, verification: verificationPreset === defaults.verification ? undefined : verificationPreset, verificationProfile, toolApprovals, antigravityExecution: nativeAntigravity ? "native" : "isolated", permissionRequirements };
  }, [taskTeam, remoteWorker, containerEnabled, containerImage, containerVolume, verificationPreset, verificationProfile, toolApprovals, nativeAntigravity, permissionRequirements]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const startError = useRef<HTMLDivElement>(null);
  useEffect(() => setError(""), [task.value, branchPrefix.value, contextPaths.value, baseRef.value, source.value, roleModels.value, agentSettings.value, containerEnabled, containerImage]);
  useLayoutEffect(() => { if (error) { startError.current?.scrollIntoView({ block: "nearest" }); startError.current?.focus({ preventScroll: true }); } }, [error]);
  // .codeflow/config.json may have changed since the draft last read it (when a run started, or
  // while you were in another tab): read it again on the way in. What the draft chose stays.
  useEffect(() => {
    const refresh = () => { if (!document.hidden && repo.value && !composerLoading.value) void loadCheck(); };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  // Pins sent from the side panel's Browser: their text joins the task, their snapshots its attachments.
  useEffect(() => {
    const drafts = takeDrafts("composer");
    if (!drafts.length) return;
    setTask([task.value.trim(), ...drafts.map((d) => d.text)].filter(Boolean).join("\n\n"));
    attachments.value = [...attachments.value, ...drafts.flatMap((d) => d.images)];
  }, [chatDrafts.value]);
  const roles = rolesFor(p);
  const soloAgent = roles.agent?.[0];
  const soloSettings = soloAgent && soloAgent !== "auto" ? { ...agentSettings.value[soloAgent], ...roleModels.value[p!.id]?.agent?.[soloAgent] } : {};
  // The Permissions control, Run details and the start request all use this one value.
  const runTrust = externalSource.value ? "safe" : trust.value;
  const approvals = toolApprovalState({ choice: toolApprovals, trust: runTrust, p, roles, remote: !!remoteWorker, container: containerEnabled, external: !!externalSource.value });
  const choosePermissions = (value: ChatPermissions) => { setTrust(value.trust); setToolApprovals(value.tools); store.set("interactiveApprovals", value.tools ? "1" : "0"); };
  // Both "Save as template…" and "Save task preset" save through one dialog, so they share one guard.
  const templateBlocked = verificationPreset === "restored" ? "Choose a verification preset before saving a template" : "";
  const canSaveTemplate = !!p && projectsLoaded.value && !!task.value.trim() && !templateBlocked;
  const problem = (p?.id === "auto-team" && teamRollout.value?.enabled === false ? "Team is disabled on this server. Choose Agent or a template in Advanced." : "") || (remoteWorker ? remoteError || (!remoteAgents ? "Checking remote worker…" : startProblem(p, roles, true, remoteAgents)) : startProblem(p, roles, true, undefined, nativeAntigravity ? "native" : "isolated")) || approvals.conflict || (containerEnabled && !remoteWorker && !containerImage.trim() ? "Choose a prebuilt agent image in Run options → Agent isolation." : "") || (automaticChecks && profileLoading ? "Loading verification profile…" : automaticChecks && profileError ? "Verification profile unavailable. Choose another profile in Run options." : "");

  const [scheduling, setScheduling] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [usingTemplate, setUsingTemplate] = useState(false);
  const [libraryScope, setLibraryScope] = useState("project");
  const runBody = composerRunBody;
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind | null>(null);
  const start = async () => {
    if (problem || !p || starting || automaticChecks && profileLoading) return;
    if (containerEnabled && !remoteWorker && !containerImage.trim()) { setError("Choose a prebuilt agent image"); return; }
    improve.stop();
    setStarting(true);
    setError("");
    try {
      const { id, project } = await postConfirmed<{ id: string; project?: string }>("/api/runs", { ...runBody(p), remember: true });
      route.value = { view: "run", id };
      resetComposer();
      void Promise.allSettled([saveComposerDraft(), afterStart(project), refreshRuns()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };
  // Fresh composer for the next run; "Edit & run again" brings these back.
  const resetComposer = () => batch(() => {
    const retry = rerunDraft.value;
    rerunDraft.value = null;
    // A retry's pinned commit and permissions were for that retry: the next run starts from the current branch.
    if (retry && !knownBase(baseRef.value)) baseRef.value = "";
    rememberBase();
    baseNotice.value = "";
    // Commands and limits typed for the run that just started go back to the defaults (loadCheck).
    forgetChoices(composerOrigins.value.trust === RERUN_ORIGIN ? ["check", "setup", "limits", "trust"] : ["check", "setup", "limits"]);
    setTask("");
    void loadCheck();
    setAcceptanceCriteria([]);
    branchPrefix.value = "";
    source.value = null;
    externalSource.value = null;
    contextPaths.value = new Map();
    attachments.value = [];
    journeyDraft.value = undefined;
    intentDraft.value = undefined;
    // Unrestricted Antigravity is an opt-in for the run just started, never a default for the next
    // one. Written straight to the run options too: the draft is saved before this composer renders again.
    setNativeAntigravity(false);
    composerRunOptions.value = { ...composerRunOptions.value, antigravityExecution: "isolated" };
  });

  if (projectsLoaded.value && projectsStatus.value.available && !projectsStatus.value.recovery && !composerProject.value && !Object.keys(unreadableDrafts.value).length && !projects.value.length && !repo.value && !task.value.trim()) return <div class="composer project-welcome">
    <div class="eyebrow">Your first project</div><h1>What would you like to work on?</h1><p class="lede">Open a repository to start a project, describe a task, and review your agents’ work.</p>
    <div class="project-welcome-actions"><button class="btn primary" onClick={() => openRepository()}>Open repository</button><a class="btn" href="#/settings/connections/join">Join shared project</a></div>
    <p class="help">Computer: {computerLabel()} · <a href="#/settings/connections/workspace">On another computer</a></p><ProviderSetupPrompt />
  </div>;
  return (
    <div class={`composer ${single ? "composer-single" : ""}`}>
      <div class="eyebrow">New run</div>
      <h1>{single ? "What would you like to work on?" : "What should the agents build?"}</h1>
      <p class="lede">{single ? "Choose a provider, describe your task, and start the conversation." : "Describe the task, add the files that matter, and pick how your agents work together."}</p>
      <div class="where" role="group" aria-label="Where the run works">
        <ProjectButton composer />
        {target.value.project?.repos.length === 1 && target.value.project.repos[0] === repo.value ? <span class="repo-btn" title={repo.value}><Icon name="folder" /><span class="name">{baseName(repo.value)}</span></span>
          : target.value.project && target.value.project.repos.length > 1 ? <label class="composer-repository">Repository<select class="field" aria-label="Run repository" value={repo.value} onChange={event => void chooseComposerRepository(event.currentTarget.value)}>{!target.value.project.repos.includes(repo.value) ? <option value="">Choose repository</option> : null}{target.value.project.repos.map(folder => <option value={folder}>{baseName(folder)} · {folder}</option>)}</select></label> : <RepoButton />}
        <button class="btn small ghost" onClick={() => openRepository(composerProject.value)}>Open another repository</button>
      </div>
      {projectsStatus.value.recovery ? <div class="banner" role="alert"><p>{projectsStatus.value.available ? `Project storage recovered: projects.json ${projectsStatus.value.recovery.reason}. The original file is retained as ${projectsStatus.value.recovery.aside} in CODEFLOW_HOME. Existing runs are retained. Restore the backup manually with Code Flow stopped, or continue with the recovered project list.` : `Projects are off: projects.json ${projectsStatus.value.reason}. Fix the file in CODEFLOW_HOME and restart Code Flow. You can still open a repository and start an unassigned run.`}</p>{!projectsStatus.value.available && composerProject.value ? <button class="btn" onClick={() => void openComposer("", { repository: repo.value })}>Open unassigned draft</button> : null}</div> : null}
      {Object.entries(unreadableDrafts.value).map(([id, message]) => <p class="msg warn" role="alert">{projects.value.find(item => item.id === id)?.name ?? (id || "Unassigned draft")}: {message} Choose another project's draft to continue. Restore the saved data in browser storage, then reload to retry.</p>)}
      {draftError.value && !Object.keys(unreadableDrafts.value).length ? <p class="msg warn" role="alert">{draftError.value} <button class="btn small" onClick={() => void saveComposerDraft()}>Retry saving</button></p> : null}
      {baseNotice.value ? <p class="msg warn" role="status">{baseNotice.value} <button class="btn small" onClick={() => { baseNotice.value = ""; }}>Dismiss</button></p> : null}
      {projectsLoaded.value && target.value.problem ? <div class="banner"><p>{target.value.problem}</p><button class="btn" onClick={() => { if (repo.value) repositoryChoice.value = { repository: repo.value, project: target.value.project?.id }; else { projectPickerPurpose.value = "composer"; projectsOpen.value = true; } }}>Choose destination</button></div> : null}
      <ProviderSetupPrompt />
      {!repoInfo.value ? (
        <div class={`banner ${repoError.value ? "bad" : ""}`}>
          <p>
            {!repoError.value
              ? "Choose the repository the agents should work in."
              : /isn't a git repository$/.test(repoError.value)
                ? `${repoError.value}. Pick the folder that contains your project's .git.`
                : repoError.value}
          </p>
          <button class="btn primary" onClick={() => (pickerOpen.value = true)}>
            Choose repository
          </button>
        </div>
      ) : null}

      {repoConfig.value?.found && repoConfig.value.error ? <div class="config-note bad" role="alert">⚠ {repoConfig.value.error}</div> : null}

      {externalSource.value ? <div class="banner"><p>External context: {externalSource.value.provider} {externalSource.value.kind} {externalSource.value.key} · {externalSource.value.title}</p><p class="help">This source remains untrusted. The run uses Safe permissions and isolated checks.</p><button class="btn small" onClick={() => { externalSource.value = null; }}>Remove source</button></div> : null}
      {p?.id === "auto-team" ? <TeamRolloutNotice /> : null}
      <PolicyPauseNotice what="Agent runs are paused" />
      {journeyDraft.value?.repo === repo.value ? <p class="help">Recorded scenario: {journeyDraft.value.title} <button class="btn ghost small" onClick={() => { journeyDraft.value = undefined; }}>Detach scenario</button></p> : null}
      <TaskBox onStart={start} improve={improve} controls={<>
        {single ? <TaskTeamControl config={taskTeam} lead={soloAgent && soloAgent !== "auto" ? soloAgent : "claude"} project={composerProject.value || undefined} toolApprovals={approvals.tools} disabledReason={remoteWorker || containerEnabled ? "Teams in this conversation require This computer without Docker isolation. Standalone workflows remain available in Advanced." : undefined} onChange={next => { setTaskTeam(next); if (next.enabled) { setRoles(p!.id, "agent", [next.coordinator]); setRoleModel(p!.id, "agent", next.coordinator, next.settings[next.coordinator] ?? {}); } }} /> : <button class="btn ghost" onClick={() => setPattern("solo")}>Back to Agent conversation</button>}
        {single ? taskTeam?.enabled && !remoteWorker && !containerEnabled ? null : <>
        {soloAgent && soloAgent !== "auto" ? <ChatControls
          agent={soloAgent} providers={remoteAgents}
          onAgent={(id) => setRoles(p!.id, "agent", [id])}
          settings={soloSettings}
          onSettings={(value) => setRoleModel(p!.id, "agent", soloAgent, value)}
          permissions={{ trust: runTrust, tools: approvals.tools }}
          onPermissions={choosePermissions}
          restricted={!!externalSource.value} approvalsAvailable={!remoteWorker && !containerEnabled}
          unrestricted={soloAgent === "agy" && nativeAntigravity}
        /> : <Menu above label="Provider" icon="layers" class="chat-choice" trigger={<><span>{soloAgent === "auto" ? "Auto provider" : "Choose provider"}</span><Icon name="chevron" /></>}>
          {(close) => <>{(remoteAgents ?? agents.value).map((entry) => <MenuItem key={entry.id} disabled={!!providerProblem(entry, remoteAgents ? null : health.value)} sub={providerProblem(entry, remoteAgents ? null : health.value) || undefined} onClick={() => { setRoles(p!.id, "agent", [entry.id]); close(); }}>{entry.displayName}</MenuItem>)}</>}
        </Menu>}
        </> : <span class="help">{selectedTeamTemplate.value ? `Template: ${selectedTeamTemplate.value.template.name} v${selectedTeamTemplate.value.template.version}` : p?.id === "auto-team" ? "Plans and delegates dynamically" : `Template: ${p?.name}`}</span>}
        {!single ? <><button type="button" class="btn ghost" onClick={() => { setMoreOptions(true); setAdvancedOpen(true); store.set("composerAdvanced", "1"); }}>Advanced</button><PermissionMenu permissions={{ trust: runTrust, tools: approvals.tools }} onPermissions={choosePermissions} restricted={!!externalSource.value} approvalsAvailable={!remoteWorker && !containerEnabled && Object.values(roles).flat().some(canAskForApproval)} agent={Object.values(roles).flat().find((id) => id.startsWith("acp:")) as AgentId | undefined} unrestricted={nativeAntigravity && Object.values(roles).flat().some(id => id === "agy" || id === "auto")} /></> : null}
        <button class="btn primary task-start" disabled={!!problem || starting} onClick={start} title={problem || "Start run (⌘↵)"}>{starting ? "Starting…" : single ? "Send" : "Start run"}<Icon name="send" /></button>
        <Menu above label="Run actions" icon="more" class="chat-choice">{(close) => <>
          <MenuItem disabled={!p || !projectsLoaded.value} onClick={() => { close(); setUsingTemplate(true); }}><Icon name="files" />Use template…</MenuItem>
          <MenuItem disabled={!canSaveTemplate} sub={templateBlocked || undefined} onClick={() => { close(); setSavingTemplate(true); }}><Icon name="files" />Save as template…</MenuItem>
          <MenuItem disabled={!!problem} onClick={() => { close(); setScheduleKind(null); setScheduling(true); }}><Icon name="clock" />Schedule…</MenuItem>
        </>}</Menu>
      </>} />
      {error ? <div ref={startError} class="msg err composer-start-error" role="alert" tabIndex={-1}>{error}</div> : null}
      <div class="composer-summary" aria-label="Run configuration summary">
        <span><b>Computer</b> {computerLabel()}{remoteWorker ? ` · Agent worker: ${remoteWorker.workerId}` : ""}</span>
        <span><b>Project</b> {target.value.project?.name ?? "Choose project"}</span>
        <span><b>Repository</b> {repo.value ? baseName(repo.value) : "Choose repository"} · {startBranchLabel(source.value, baseRef.value, repoInfo.value?.current)}</span>
        <div class="composer-budget">
          <b>Limit</b>
          <Menu above align="end" label="Run budget" icon="clock" class="budget-picker chat-choice" trigger={<>{plural(restored?.loop.maxInvocations ?? limits.value.maxSteps, "call")} · {budgetDuration(limits.value.maxMinutes)}<Icon name="chevron" /></>}>
            {close => <>
              <MenuTitle>Run budget</MenuTitle>
              {EXECUTION_BUDGET_PRESETS.map(budget => <MenuItem key={budget.id} on={limits.value.maxSteps === budget.maxSteps && limits.value.maxMinutes === budget.maxMinutes && (restored?.loop.maxInvocations ?? budget.maxSteps) === budget.maxSteps} sub={`${budget.maxSteps.toLocaleString()} calls · ${budgetDuration(budget.maxMinutes)}`} onClick={() => { chooseBudget(budget); close(); }}>{budget.label}{budget.id === "extended" ? " · default" : ""}</MenuItem>)}
              <MenuItem onClick={() => { close(); setMoreOptions(true); setLimitsOpen(true); }}>Custom limits…</MenuItem>
            </>}
          </Menu>
        </div>
        {problem ? <span class="composer-problem" role="status">{problem}{/Settings/.test(problem) ? <> <a href="#/settings/agents">Open provider settings</a></> : null}</span> : null}
        {trust.value === "full" ? <span class="warn">Full access · no provider sandbox</span> : null}
        {nativeAntigravity ? <span class="warn">Unrestricted Antigravity · no Code Flow sandbox</span> : null}
        <button class="btn small ghost" onClick={() => setMoreOptions(!moreOptions)} aria-expanded={moreOptions}>Edit run options</button>
      </div>
      <WorkflowRecommendation repository={repo.value} intent={journeyDraft.value?.repo === repo.value ? "bug" : intentDraft.value} />
      {contextError.value ? <div class="msg err">{contextError.value}</div> : null}
      <details class="composer-options compact" open={moreOptions} onToggle={(event) => setMoreOptions(event.currentTarget.open)}>
        <summary>Run options <span>Agents, context, checks and limits for this task</span></summary>
      {repoConfig.value?.found && !repoConfig.value.error ? <div class="config-note"><Icon name="sliders" />Using <code>.codeflow/config.json</code>{repoConfig.value.ref ? <> from <code>{repoConfig.value.ref}</code></> : null}{configSummary(repoConfig.value.config, !!repoConfig.value.ref)}</div> : null}
      <AcceptanceEditor />

      <div class="section">
        {p ? <p class="pattern-why">{teamSentence(p, roles, true, checkMode)}</p> : null}
        {trust.value === "full" ? <p class="full-warn" role="alert"><b>Full access: no sandbox.</b> Agents can run commands and change files outside their worktree with your credentials. Review permissions in Advanced agent settings.</p> : null}
        {p && CHECKPOINTS[p.id] && (p.id !== "debate" || roles.builder?.length) ? (
          <label class="checkpoint">
            <input type="checkbox" checked={planApprovalFor(p.id)} onChange={(e) => setApprovePlan(e.currentTarget.checked, p.id)} />
            <span><b>Let me approve {CHECKPOINTS[p.id]}</b> before agents build.</span>
          </label>
        ) : null}
        <div class={`donewhen ${p?.requiresCheck && !checkCmd.value.trim() ? "required" : ""}`}>
          <label class="lbl" for="checkCmd">{automaticChecks ? "Done when this passes" : "Check command for merge validation"}</label>
          <div class="dw-row"><span class="dw-prompt">$</span><input class="field" id="checkCmd" disabled={repoChecking.value} placeholder="e.g. npm test" spellcheck={false} autocomplete="off" aria-describedby={checkWarning.value ? "checkCmd-warning" : undefined} value={checkCmd.value} onInput={(e) => { setRunCheck(e.currentTarget.value); checkWarning.value = ""; }} /></div>
          {checkWarning.value ? <div class="msg warn" id="checkCmd-warning" role="status">{checkWarning.value}</div> : null}
          <div class="help">Override the project check for this run. {checkExplanation(checkMode, checkCmd.value)} A result without a passing check is unchecked.</div>
        </div>
        <div class="donewhen">
          <label class="lbl" for="setupCmd">Worktree setup command</label>
          <div class="dw-row"><span class="dw-prompt">$</span><input class="field" id="setupCmd" disabled={repoChecking.value} placeholder="e.g. npm ci" spellcheck={false} autocomplete="off" value={setupCmd.value} onInput={(event) => setRunSetup(event.currentTarget.value)} /></div>
          <div class="help">Runs once in each new worktree before agent work and checks. Override for this run; save reusable defaults in Settings → Projects.</div>
        </div>
        {!remoteWorker && !containerEnabled && !verificationProfile ? <RepositoryReadiness pattern={p?.id} roles={roles} /> : null}
      </div>

      {/* The optional controls read as one accordion: a card whose rows open in place. */}
      <div class="composer-more">
      <details class="settings advanced-controls" open={advancedOpen} onToggle={(e) => { setAdvancedOpen(e.currentTarget.open); store.set("composerAdvanced", e.currentTarget.open ? "1" : "0"); }}>
        <summary><span class="st">Advanced{nativeAntigravity ? " · Unrestricted Antigravity" : ""}</span><span class="ss">Templates, roles, models, permissions and limits</span></summary>
        <div class="settings-body">
        <label class="lbl" for="workflow-select">Built-in workflow templates</label>
        <select class="field" id="workflow-select" aria-label="Workflow" value={p?.id ?? "auto-team"} onChange={event => setPattern(event.currentTarget.value)}>
          <option value="auto-team">Team — dynamic plan</option><option value="solo">Agent — one agent</option>
          {patterns.value.filter(entry => !["solo", "auto-team"].includes(entry.id)).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        {advancedOpen ? <TeamTemplateLibrary /> : null}
        {p?.id === "auto-team" ? <WorkerModelCatalog remote={!!remoteWorker || containerEnabled} nativeAntigravity={nativeAntigravity} /> : null}
        <fieldset class="section"><legend>Antigravity execution</legend>
          <label class="checkpoint"><input type="checkbox" checked={nativeAntigravity} onChange={e => setNativeAntigravity(e.currentTarget.checked)} /><span>Use unrestricted Antigravity with my existing login</span></label>
          <p class="help">Opt-in for this run; the next run starts isolated again. Antigravity uses your normal profile without Code Flow's sandbox. Terminal, browser, MCP, hooks and native agents follow provider settings. Read-only requests are advisory and native child usage is outside the worker budget. Claude and Codex keep their run permissions. Requires a valid saved login, local attended execution, and no mandatory boundaries, Safe mode or tool approvals.</p>
        </fieldset>
        <fieldset class="section"><legend>Required permission enforcement</legend>
          {([ ["workspace-writes", "Require an agent workspace write boundary"], ["no-command-network", "Block network access from agent commands"], ["no-external-tools", "Disable external browser and MCP tools"] ] as [PermissionRequirement, string][]).map(([id, label]) => <label class="checkpoint" key={id}><input type="checkbox" checked={permissionRequirements.includes(id)} onChange={e => setPermissionRequirements(e.currentTarget.checked ? [...permissionRequirements, id] : permissionRequirements.filter(p => p !== id))} /><span>{label}</span></label>)}
          <p class="help">Only providers that enforce these requirements can run. Command network restrictions do not cover provider inference or external tools. With none selected, the existing provider-specific permission profile applies.</p>
        </fieldset>
        <div class="section"><button class="btn" disabled={!p || !projectsLoaded.value} onClick={() => setUsingTemplate(true)}>Browser task library</button>{" "}<button class="btn" disabled={!canSaveTemplate} aria-describedby={templateBlocked ? "save-preset-blocked" : undefined} onClick={() => setSavingTemplate(true)}>Save task preset</button>{templateBlocked ? <p class="help" id="save-preset-blocked">{templateBlocked}.</p> : null}<p class="help">Existing browser presets remain available. Applying a preset keeps this run's permissions and isolation.</p></div>
        <RemoteWorkerSelect value={remoteWorker} onChange={(value) => { improve.stop(); setRemoteWorker(value); }} disabled={starting} />
        {remoteWorker ? <p class="help">Provider availability comes from this worker. Checks and setup run on the application server. Copied workspace files and native interactive approvals are unavailable; use explicitly staged references.</p> : null}
        {p && !single ? <Team p={p} roles={roles} providers={remoteAgents} remote={!!remoteWorker} /> : null}
        <div class="section"><label class="lbl" for="verification-profile">Verification gates</label><select class="field" id="verification-profile" value={verificationPreset} disabled={!repo.value} onChange={(event) => void selectVerification(event.currentTarget.value)}><option value="">Single configured check</option>{verificationPreset === "restored" ? <option value="restored">From original run · {verificationProfile?.name}</option> : null}<option value="lightweight">Lightweight profile</option><option value="standard">Standard profile</option><option value="thorough">Thorough profile</option></select>{automaticChecks && profileError ? <p class="msg err" role="alert">{profileError}</p> : null}{!automaticChecks ? <p class="help">Verification gates are inactive for Agent conversations. Turn on AI team or choose a managed workflow to run them.</p> : verificationProfile ? <p class="help">Required gates: {verificationProfile.checks.map((gate) => gate.command).join(" · ") || "No runnable gates detected"}. Each gate appears in the run's evidence.</p> : null}</div>
        </div>
      </details>
      {p ? <Settings p={p} roles={roles} open={limitsOpen} onToggle={setLimitsOpen} budgetRevision={budgetRevision} /> : null}
      {p ? <EffectiveSettings p={p} checkMode={checkMode} toolApprovals={approvals} verificationProfile={verificationProfile} container={{ enabled: containerEnabled, image: containerImage, authVolume: containerVolume, network: restored?.loop.agentContainer?.network }} /> : null}
      <ContextInspector />

      <details class="settings agent-isolation"><summary><span class="st">Agent isolation</span><span class="ss">{containerEnabled && !remoteWorker ? `Prebuilt Docker image${containerImage.trim() ? ` · ${containerImage.trim()}` : ""}` : "Off · agents use this computer's CLIs"}</span></summary><div class="settings-body"><label class="checkpoint"><input type="checkbox" checked={containerEnabled} disabled={!!remoteWorker} onChange={(event) => { improve.stop(); setContainerEnabled(event.currentTarget.checked); }} /><span>Run agents in a prebuilt Docker image</span></label>{containerEnabled ? <><label class="iso-field">Image<input class="field mono" placeholder="Your prepared image:tag" spellcheck={false} value={containerImage} onInput={(event) => setContainerImage(event.currentTarget.value)} /></label><label class="iso-field">Authentication volume<input class="field mono" spellcheck={false} placeholder="Optional explicitly named Docker volume" value={containerVolume} onInput={(event) => setContainerVolume(event.currentTarget.value)} /></label><p class="help">The image must contain compatible official CLIs and be authenticated inside the image or selected volume. Host credential folders are never mounted. Agents receive their worktree and read-only Git metadata; network access is {restored?.loop.agentContainer?.network === false ? "disabled by the original run" : "enabled for inference"}. Live team bridges use structured turn-boundary replies in containers.</p></> : null}</div></details>

      </div>
      </details>

      {usingTemplate ? <UseTaskTemplateDialog initialScope={libraryScope} onConfigured={template => { if (template.runOptions) void selectVerification(template.runOptions.verification); }} onClose={() => setUsingTemplate(false)} onUsed={(scope) => { setLibraryScope(scope); setUsingTemplate(false); }} /> : null}
      {savingTemplate && p && !templateBlocked ? <SaveTaskTemplateDialog p={p} toolApprovals={approvals.tools} runOptions={{ verification: verificationPreset as "" | "lightweight" | "standard" | "thorough", container: { enabled: containerEnabled, image: containerImage, authVolume: containerVolume } }} initialScope={libraryScope} onClose={() => setSavingTemplate(false)} onSaved={(scope) => { setLibraryScope(scope); setSavingTemplate(false); }} /> : null}
      {scheduling && p && !scheduleKind ? <ScheduleChoiceDialog onClose={() => setScheduling(false)} onChoose={kind => { if (kind === "backlog" || kind === "missions") { setScheduling(false); route.value = { view: "automations", kind }; } else setScheduleKind(kind); }} /> : null}
      {scheduling && p && scheduleKind === "once" ? <ScheduleRunDialog body={runBody(p)} onClose={() => setScheduling(false)} /> : null}
      {scheduling && p && scheduleKind === "repeat" ? <SaveAutomationDialog body={runBody(p)} onClose={() => setScheduling(false)} /> : null}
    </div>
  );
}

function ScheduleChoiceDialog({ onClose, onChoose }: { onClose: () => void; onChoose: (kind: ScheduleKind) => void }) {
  const ref = useDialog(true, onClose);
  return <dialog ref={ref} class="picker" aria-labelledby="schedule-choice-title"><div class="picker-inner"><div class="picker-head"><h3 id="schedule-choice-title">Schedule work</h3></div><div class="dialog-body purpose-choices">{SCHEDULE_KINDS.map(item => <button class="settings-result" onClick={() => onChoose(item.id)}><span><strong>{item.label}</strong><span>{item.description}</span></span></button>)}</div><div class="picker-foot"><button class="btn" onClick={onClose}>Cancel</button></div></div></dialog>;
}

function ScheduleRunDialog({ body, onClose }: { body: Record<string, any>; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  return <dialog ref={ref} class="picker" aria-labelledby="schedule-run-title"><div class="picker-inner"><div class="picker-head"><h3 id="schedule-run-title">Start later</h3></div><div class="dialog-body"><DeferredRunsPanel runRequest={body} project={body.project} repo={body.repo} /></div><div class="picker-foot"><button class="btn" onClick={onClose}>Close</button></div></div></dialog>;
}

/** The repository (and its current branch) the run works in. */
function RepoButton() {
  const info = repoInfo.value;
  return (
    <button type="button" class={`repo-btn ${info ? "" : "empty"} ${repoError.value ? "bad" : ""}`} title={info ? info.repo : "Choose repository"} onClick={() => (pickerOpen.value = true)}>
      <Icon name="folder" />
      <span class="name">{info ? baseName(info.repo) : repoChecking.value ? "Checking…" : repoError.value || "Choose repository…"}</span>
      <Icon name="chevron" class="caret" />
    </button>
  );
}

/**
 * POST that asks you first when the server needs a decision: a task from someone outside the
 * repo whose checks would run on this machine without Docker.
 */
async function postConfirmed<T>(path: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await post<T>(path, body);
  } catch (err) {
    if (!(err instanceof ApiError) || err.confirm !== "allowUntrusted") throw err;
    if (!await confirmAction(`${err.message}\n\nRun its checks on this machine anyway?`, {"title":"Run checks locally?","confirmLabel":"Run checks","danger":true})) throw new Error("Not started: the source isn't trusted and Docker isn't available.");
    return post<T>(path, { ...body, allowUntrusted: true });
  }
}

/** Start the same task with several patterns (each with the team you last set for it). */
export function CompareDialog({ base, onClose, onStarted }: { base: Record<string, any>; onClose: () => void; onStarted: (group: string) => void }) {
  const ref = useDialog(true, onClose);
  const current = pattern.value?.id;
  const [picked, setPicked] = useState<Set<string>>(new Set(current ? [current] : []));
  const [repeat, setRepeat] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = patterns.value.map((p) => {
    const roles = rolesFor(p);
    return { p, roles, problem: startProblem(p, roles, true, undefined, base.antigravityExecution) };
  });
  const runs = picked.size * repeat;
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const variants = choices
        .filter((c) => picked.has(c.p.id))
        .map((c) => ({ label: c.p.name, pattern: c.p.id, roles: c.roles, options: optionsFor(c.p), roleSettings: roleModels.value[c.p.id] ?? {} }));
      const { group, failed } = await postConfirmed<{ group: string; failed?: { error: string } }>("/api/compare", { run: base, variants, repeat });
      if (failed) showToast(`Comparison partially started. ${failed.error}. Started runs are shown in this group.`, 10000);
      onClose();
      onStarted(group);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog class="picker" ref={ref} aria-labelledby="compare-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="compare-title">Compare setups</h3>
          <div class="help">
            Runs this task once per setup, at the same time, and shows the results side by side in Insights: did it pass, how long, how many steps and tokens, did it touch the
            tests. Each pattern uses the team you last picked for it — select a pattern in the composer to change its team. A custom result branch name gets a unique suffix for each run.
          </div>
        </div>
        <div class="dialog-body">
          {choices.map(({ p, roles, problem }) => (
            <label key={p.id} class={`compare-choice ${problem ? "off" : ""}`}>
              <input
                type="checkbox"
                checked={picked.has(p.id)}
                disabled={!!problem}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.currentTarget.checked) next.add(p.id);
                  else next.delete(p.id);
                  setPicked(next);
                }}
              />
              <span>
                <b>{p.name}</b>
                <span class="help">{problem || teamSentence(p, roles)}</span>
              </span>
            </label>
          ))}
          <label class="check">
            Run each
            <select class="field inline" value={repeat} onChange={(e) => setRepeat(Number(e.currentTarget.value))}>
              <option value={1}>once</option>
              <option value={2}>twice</option>
              <option value={3}>3 times</option>
            </select>
            (repeats show how consistent a setup is)
          </label>
          {error ? <div class="msg err">{error}</div> : null}
        </div>
        <div class="picker-foot">
          <span class="ps">
            {runs} run{runs === 1 ? "" : "s"}
            {runs > MAX_COMPARE_RUNS ? ` — at most ${MAX_COMPARE_RUNS}` : ""}; they share code-flow's agent slots, so some may wait their turn.
          </span>
          <button class="btn" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={busy || picked.size < 2 || runs > MAX_COMPARE_RUNS} onClick={go} title={picked.size < 2 ? "Pick at least two setups" : ""}>
            {busy ? "Starting…" : `Start ${runs} run${runs === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Why the run can't start yet ("" when it can); `needsTask: false` for sweeps, whose items bring their tasks. */
export function startProblem(p: PatternInfo | undefined, roles: Record<string, RoleValue[]>, needsTask = true, inventory?: AgentInfo[], antigravityExecution: "isolated" | "native" = "isolated"): string {
  const invalid = numberInputProblem("composer:") || numberInputProblem("context:") || executionLimitsProblem(limits.value) || (needsTask ? acceptanceCriteriaProblem(acceptanceCriteria.value) : "");
  if (invalid) return invalid;
  if (p?.id === "solo" && composerRunOptions.value.taskTeam?.enabled) { const problem = taskTeamLimitsProblem(composerRunOptions.value.taskTeam as unknown as Record<string, unknown>); if (problem) return problem; }
  for (const option of p?.options ?? []) if (option.type !== "boolean") {
    const problem = numberProblem(optionsFor(p)[option.id], { label: option.label, min: option.min ?? 0, max: option.max ?? Number.MAX_SAFE_INTEGER, integer: true });
    if (problem) return problem;
  }
  if (p?.id === "solo" && composerRunOptions.value.taskTeam?.enabled && !inventory && !composerRunOptions.value.remoteWorker && !composerRunOptions.value.container?.enabled) {
    if (teamRollout.value?.enabled === false) return "Team is disabled on this server. Turn AI team off to continue with one agent.";
    const approvals = toolApprovalState({ choice: composerRunOptions.value.toolApprovals, trust: externalSource.value ? "safe" : trust.value, p, roles, external: !!externalSource.value }).tools;
    const permission = teamApprovalProblem(composerRunOptions.value.taskTeam, approvals); if (permission) return permission;
  }
  if (p?.id === "auto-team" && teamRollout.value?.enabled === false) return "New teams are disabled. Existing teams can still be resumed.";
  // Before "Pick an agent": the providers are greyed out because the pause applies everywhere.
  if (executionPaused.value) return "Agent runs are paused by a project's filesystem restriction";
  if (composerLoading.value) return "Restoring project draft…";
  if (draftUnavailable.value) return "This saved draft is unreadable. Choose another project to continue.";
  if (target.value.unavailable && projectsLoaded.value) return target.value.problem;
  if (repoChecking.value) return "Checking repository…";
  if (!repo.value) return "Choose a repository first";
  if (target.value.problem) return target.value.problem;
  if (configChecking.value) return "Loading repository configuration…";
  if (needsTask && !task.value.trim()) return "Describe the task to start";
  if (!p) return "Pick how the agents work together";
  if (!inventory) { const readiness = providerSetupProblem(agents.value, health.value); if (readiness) return readiness; }
  for (const [role, ids] of Object.entries(roles)) for (const id of ids) {
    if (id === "auto") continue;
    const settings = { ...agentSettings.value[id], ...roleModels.value[p.id]?.[role]?.[id] };
    const invalid = [settings, ...(settings.variants ?? [])].find(value => modelIdProblem(id, value.model));
    if (invalid) return `${(inventory ?? agents.value).find(entry => entry.id === id)?.displayName ?? id}: ${modelIdProblem(id, invalid.model)}`;
  }
  const unsupported = (p.id === "auto-team" ? roles.coordinator ?? [] : Object.values(roles).flat()).find(id => id !== "auto" && !supportsRunPermissions(id));
  if (unsupported) return runProviderProblem(unsupported, (inventory ?? agents.value).find(agent => agent.id === unsupported)?.displayName)!;
  for (const role of p.roles) if (!role.optional && !roles[role.id]?.length) return p.roles.length === 1 ? "Choose a provider" : `Choose a provider for ${role.label}`;
  const unavailableHint = !inventory && health.value?.some(item => item.installed && item.signedIn === false) ? " Some providers are signed out; open Settings → Agents & models." : "";
  if (p.id === "race" && participantCount(p.id, "contestants", roles.contestants ?? []) < 2) return "A race needs at least two contestants." + unavailableHint;
  if (p.id === "debate" && participantCount(p.id, "debaters", roles.debaters ?? []) < 2) return "A debate needs at least two debaters." + unavailableHint;
  if (p.id === "auto-team" && !roles.pool?.some(supportsRunPermissions)) return "Keep at least one compatible provider in the pool (Claude Code, Codex or Antigravity)";
  if (p.id === "auto-team" && limits.value.maxSteps < 4) return "A team needs at least 4 steps: planning, work, review and recovery";
  if (p.requiresCheck && !checkCmd.value.trim()) return `${p.name} needs a “Done when” command, e.g. npm test`;
  // An Auto pool is permission to choose from these providers; availability is checked by
  // the coordinator before building its roster, so one signed-out candidate needn't block it.
  const used = new Set<RoleValue>(p.id === "auto-team" ? roles.coordinator ?? [] : Object.values(roles).flat());
  if (inventory) {
    const installed = new Set(inventory.filter((agent) => agent.available).map((agent) => agent.id));
    for (const id of used) if (id !== "auto" && !installed.has(id)) return `${SHORT[id]} is unavailable on the selected remote worker`;
    if (used.has("auto") && !installed.size) return "No configured provider CLI is available on this remote worker";
    return "";
  }
  const signedOut = health.value?.find((h) => used.has(h.id) && h.installed && h.signedIn === false);
  if (signedOut) return `${signedOut.name} isn't signed in — open Settings → Agents & models`;
  const unready = agents.value.find(entry => used.has(entry.id) && providerProblem(entry, health.value));
  if (unready) return `${unready.displayName}: ${providerProblem(unready, health.value)}`;
  // Runs use isolated Antigravity unless the run opts out; the doctor knows whether this computer can.
  const needsIsolation = used.has("agy") && antigravityExecution !== "native";
  const agyHealth = health.value?.find((h) => h.id === "agy");
  if (needsIsolation && !agyHealth) return healthError.value ? "Antigravity compatibility could not be checked. Refresh providers in Settings → Agents & models." : "Checking whether Antigravity can run isolated…";
  const isolatedAgy = needsIsolation && agyHealth?.installed && agyHealth.managedCompatible === false ? agyHealth : undefined;
  if (isolatedAgy) return `Antigravity${isolatedAgy.version ? ` ${isolatedAgy.version}` : ""} can't run isolated on this computer (it needs macOS, a verified CLI version and an existing Keychain login). Update Antigravity, or turn on Run options → Advanced → Use unrestricted Antigravity.`;
  return "";
}

// ---------------------------------------------------------------- task box
type ImproveMode = "quick" | "repo";

/**
 * Improve: one read-only agent turn rewrites the task so agents can act on it (src/improve.ts).
 * Quick works from the text alone; Repo reads a committed repository snapshot. Undo brings yours back
 * while the rewrite is still what's in the box.
 */
function useImprove(disabledReason: string) {
  const [busy, setBusy] = useState<{ mode: ImproveMode } | null>(null);
  const [done, setDone] = useState<{ before: string; note: string; revision: number; snapshot: ImproveSnapshot } | null>(null);
  const [error, setError] = useState<{ message: string; revision: number; snapshot: ImproveSnapshot } | null>(null);
  const [mode, setMode] = useState<ImproveMode>(improveSettings.value.defaultMode);
  const reason = useRef(disabledReason);
  reason.current = disabledReason;
  const capture = () => [task.value, repo.value, repoInfo.value, currentProject.value, target.value.project?.id, baseRef.value, contextPaths.value, attachments.value, source.value, externalSource.value, acceptanceCriteria.value, contextBudget.value, reason.current, improveSettings.value] as const;
  type ImproveSnapshot = ReturnType<typeof capture>;
  const same = (a: ImproveSnapshot, b: ImproveSnapshot) => a.every((value, index) => Object.is(value, b[index]));
  const observed = useRef(capture());
  const revision = useRef(0);
  const mounted = useRef(true);
  const live = useRef<{ stop: AbortController; revision: number; snapshot: ImproveSnapshot } | null>(null);
  const completed = useRef<typeof done>(null);
  const stop = () => {
    // Invalidate synchronously: an already resolved response or an older finally cannot win.
    const previous = live.current;
    live.current = null;
    previous?.stop.abort();
    completed.current = null;
    setBusy(null);
    setDone(null);
    setError(null);
  };
  const observe = () => {
    const next = capture();
    if (same(observed.current, next)) return;
    observed.current = next;
    revision.current++;
    stop();
  };
  // Signals observe every transition, including repo A → B → A or text edited then restored.
  // A layout effect installs this before the composer can receive input.
  useLayoutEffect(() => {
    const dispose = effect(observe);
    return () => { mounted.current = false; live.current?.stop.abort(); live.current = null; dispose(); };
  }, []);
  useLayoutEffect(observe, [disabledReason]);
  useEffect(() => setMode(improveSettings.value.defaultMode), [improveSettings.value.defaultMode]);
  const run = async (how: ImproveMode = mode) => {
    if (live.current) { stop(); return; }
    observe();
    const text = task.value;
    if (!mounted.current || reason.current || !text.trim() || !repo.value) return;
    const operation = { stop: new AbortController(), revision: revision.current, snapshot: capture() };
    live.current = operation;
    completed.current = null;
    setBusy({ mode: how }); setError(null); setDone(null);
    const current = () => mounted.current && live.current === operation && !operation.stop.signal.aborted && revision.current === operation.revision && same(operation.snapshot, capture());
    try {
      const result = await api<{ prompt: string; summary: string; agent: AgentId }>("/api/improve-prompt", {
        method: "POST", signal: operation.stop.signal,
        body: JSON.stringify({
          text, repo: repo.value, mode: how, execution: "local", settings: improveSettings.value,
          criteria: acceptanceCriteria.value.map(value => value.trim()).filter(Boolean),
          context: [...contextPaths.value.values()].map((item) => item.path).concat(attachments.value.map((item) => item.name)),
          source: source.value ? { kind: source.value.kind, number: source.value.number, title: source.value.title } : undefined,
        }),
      });
      if (!current()) return;
      live.current = null;
      setBusy(null);
      setTask(result.prompt);
      const name = agents.value.find((agent) => agent.id === result.agent)?.displayName ?? result.agent;
      const applied = { before: text, note: `${name}: ${result.summary}`, revision: revision.current, snapshot: capture() };
      completed.current = applied;
      setDone(applied);
    } catch (err) {
      if (current()) setError({ message: (err as Error).message, revision: revision.current, snapshot: capture() });
    } finally {
      if (mounted.current && live.current === operation) { live.current = null; setBusy(null); }
    }
  };
  const pick = (how: ImproveMode) => { setMode(how); void run(how); };
  const undo = () => {
    const result = completed.current;
    if (!result || result.revision !== revision.current || !same(result.snapshot, capture())) { stop(); return; }
    stop();
    setTask(result.before);
  };
  return {
    busy, mode, run, pick, undo, stop, disabledReason, agentName: IMPROVE_NAMES[improveSettings.value.agent],
    error: error && error.revision === revision.current && same(error.snapshot, capture()) ? error.message : "",
    done: done && done.revision === revision.current && same(done.snapshot, capture()) ? done : null,
  };
}

/** Escape restores the trigger; choosing a mode focuses its persistent Improve/Stop action. */
function ImproveMenu({ improve, disabled }: { improve: ReturnType<typeof useImprove>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusLast = useRef(false);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const items = wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    items?.[focusLast.current ? items.length - 1 : 0]?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div class="pop-wrap" ref={wrap} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) { if (!disabled) { focusLast.current = event.key === "ArrowUp" || event.key === "End"; setOpen(true); } return; }
    const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = items.findIndex((item) => item === document.activeElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
  }}>
    <button ref={trigger} type="button" class={`icon-btn ${open ? "on" : ""}`} aria-label="How Improve works" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "improve-mode-menu" : undefined} disabled={disabled} title="How Improve works" onClick={() => { focusLast.current = false; setOpen(!open); }}><Icon name="chevron" /></button>
    {open ? <div class="pop-menu" role="menu" id="improve-mode-menu" aria-label="Improve mode"><MenuTitle>Improve the task</MenuTitle>
      {([{ mode: "quick", title: "Quick rewrite", description: "From your text alone, using your configured model" }, { mode: "repo", title: "Use the repository", description: "Reads a committed repository snapshot. Skips local edits." }] as const).map((item) => <button key={item.mode} type="button" role="menuitemradio" tabIndex={-1} aria-checked={improve.mode === item.mode} class={`pop-item ${improve.mode === item.mode ? "on" : ""}`} onClick={() => { close(); improve.pick(item.mode); (wrap.current?.previousElementSibling as HTMLButtonElement | null)?.focus(); }}><span class="pi-main">{item.title}</span><span class="pi-sub">{item.description}</span></button>)}
    </div> : null}
  </div>;
}

function WorktreeBranchPicker() {
  const info = repoInfo.value;
  const pr = source.value?.kind === "pr" ? source.value : null;
  if (!info) return null;
  const value = pr ? "__pr" : baseRef.value;
  return <div class="task-branch"><span>Start from branch</span><ModelSelect label="Start from branch" title="Choose a branch" kind="branch" value={value} disabled={!!pr} onChange={value => { baseRef.value = value; baseNotice.value = ""; }} options={pr ? [{ id: "__pr", label: `PR #${pr.number} · ${pr.headRefName}` }] : [
    { id: "", label: info.current ? `Current branch · ${info.current}` : "Current HEAD", description: "Latest committed state. Uncommitted changes are not included." },
    ...(baseRef.value && !info.branches.some(branch => branch.name === baseRef.value) ? [{ id: baseRef.value, label: baseRef.value }] : []),
    ...info.branches.map(branch => ({ id: branch.name, label: branch.name, description: branch.kind === "local" ? "Local branch" : branch.kind === "remote" ? "Remote branch" : "Previous task branch" })),
  ]} /><span class="help worktree-snapshot">New worktree from the selected commit; uncommitted checkout changes are not included.</span></div>;
}

function TaskBox({ onStart, improve, controls }: { onStart: () => void; improve: ReturnType<typeof useImprove>; controls?: ComponentChildren }) {
  const [over, setOver] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canImprove = !!task.value.trim() && !!repo.value && !improve.disabledReason;
  const autosize = () => {
    const t = area.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(420, Math.max(120, t.scrollHeight))}px`;
  };
  useEffect(autosize, [task.value]);

  // A file dropped anywhere else would make the browser open it and lose your work.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".taskbox") && e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  const count = contextPaths.value.size + attachments.value.length;
  const ofContext = `${count} item${count === 1 ? "" : "s"} of context`;
  // Short enough to fit the toolbar beside the open side panel; the title keeps the full sentence
  const hint = count ? `${ofContext} — agents read these first` : "Drag files here to give the agents context";
  const hintFull = count ? `${ofContext} — agents read these before starting` : "Drag files here from the file list or Finder to give the agents context";
  return (
    <div
      class={`taskbox ${over ? "over" : ""}`}
      onDragOver={(e) => {
        const types = [...(e.dataTransfer?.types ?? [])];
        if (!types.includes(DRAG_TYPE) && !types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const internal = e.dataTransfer?.getData(DRAG_TYPE);
        if (internal) {
          e.preventDefault(); // don't also paste the path into the text
          addContext(JSON.parse(internal));
          return;
        }
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        // Read synchronously: the DataTransfer is emptied once this handler returns.
        const items = [...e.dataTransfer.items].filter((i) => i.kind === "file");
        const files: File[] = [];
        const folders: string[] = [];
        [...e.dataTransfer.files].forEach((file, i) => {
          if (items[i]?.webkitGetAsEntry?.()?.isDirectory) folders.push(file.name);
          else files.push(file);
        });
        void addAttachments(files, folders);
      }}
    >
      <WorktreeBranchPicker />
      <textarea
        ref={area}
        aria-label="Task"
        placeholder="e.g. Add rate limiting to the /login endpoint, with tests…"
        value={parseBrowserMessage(task.value).text}
        aria-busy={!!improve.busy}
        onInput={(e) => setTask(editBrowserText(task.value, e.currentTarget.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onStart();
          }
        }}
      />
      <BrowserDraftCards text={task.value} onText={setTask} images={attachments.value} onImages={value => { attachments.value = value; }} />
      <ContextChips />
      <div class="bar">
        <button class="btn ghost small" title="Attach files from your computer" onClick={() => fileInput.current?.click()}>
          <Icon name="attach" /> Attach
        </button>
        <button class="btn ghost small" title="Start from a GitHub issue or pull request" onClick={() => (ghPicker.value = { kind: source.value?.kind === "pr" ? "pr" : "issue" })}>
          <Icon name="pull" /> GitHub
        </button>
        <button class="btn ghost small" title="Show the repository's files in the side panel" onClick={() => openSide("files")}>
          <Icon name="files" /> Files
        </button>
        {improve.busy ? (
          <span class="hint status" role="status">{improve.busy.mode === "repo" ? "Reading the committed repository snapshot and rewriting the task…" : "Rewriting the task…"}</span>
        ) : improve.error ? (
          <span class="hint status bad" role="alert" title={improve.error}>{improve.error}</span>
        ) : improve.done ? (
          <span class="hint status" role="status" title={improve.done.note}>{improve.done.note}</span>
        ) : improve.disabledReason ? (
          <span class="hint status" id="improve-execution-note">{improve.disabledReason}</span>
        ) : (
          <span class="hint" title={hintFull}>
            {hint}
          </span>
        )}
        {improve.done ? (
          <button class="btn ghost small improve-undo" title="Put back the task as you wrote it" onClick={improve.undo}>
            Undo
          </button>
        ) : null}
        <div class="improve">
          <button
            class="btn ghost small"
            disabled={!improve.busy && !canImprove}
            aria-label={improve.busy ? "Stop" : `Improve · ${improve.agentName}`}
            aria-description={`Prompt improvement agent: ${improve.agentName}. Mode: ${improve.mode}. Configure in Settings, Agents & models.`}
            aria-describedby={improve.disabledReason ? "improve-execution-note" : undefined}
            title={improve.busy ? "Stop rewriting" : improve.disabledReason || (!repo.value ? "Choose a repository first" : improve.mode === "repo" ? "Rewrite the task using a committed repository snapshot" : "Rewrite the task so agents can act on it")}
            onClick={() => void improve.run()}
          >
            {improve.busy ? <span class="spin" /> : <Icon name="sparkle" />} {improve.busy ? "Stop" : <>Improve <span class="improve-agent" aria-hidden="true">· {improve.agentName}</span></>}
          </button>
          <ImproveMenu improve={improve} disabled={!!improve.busy || !canImprove} />
        </div>
      </div>
      {controls ? <div class="task-controls">{controls}</div> : null}
      <div class="overlay">Drop to add as context</div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void addAttachments([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}

function ContextChips() {
  const remove = (path: string) => {
    const next = new Map(contextPaths.value);
    next.delete(path);
    contextPaths.value = next;
  };
  return (
    <div class="chips">
      <SourceChip />
      {[...contextPaths.value.values()].map((c) => (
        <span key={c.path} class="chip-ctx" title={c.type === "dir" && c.status === "U" ? `${c.path}: has untracked files. Folders must exist on the start branch; add individual files for local changes.` : c.path}>
          <Icon name={c.type === "dir" ? "folder" : "note"} />
          <span class="n">
            {c.path}
            {c.type === "dir" ? "/" : ""}
            {c.type === "dir" && c.status === "U" ? " · untracked changes" : ""}
          </span>
          <button type="button" title="Remove" aria-label={`Remove ${c.path}`} onClick={() => remove(c.path)}>
            ×
          </button>
        </span>
      ))}
      {attachments.value.filter(a => !browserImageNames(task.value).has(a.name)).map((a, i) => (
        <span key={`a${i}`} class="chip-ctx" title={a.name}>
          <Icon name="attach" />
          <span class="n">
            {a.name} · {fmtSize(a.size)}
          </span>
          <button type="button" title="Remove" aria-label={`Remove ${a.name}`} onClick={() => (attachments.value = attachments.value.filter((x) => x !== a))}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export function addContext(item: ContextItem) {
  const next = new Map(contextPaths.value);
  next.set(item.path, { path: item.path, type: item.type, status: item.status });
  contextPaths.value = next;
}
function toggleContext(item: ContextItem) {
  const next = new Map(contextPaths.value);
  if (next.has(item.path)) next.delete(item.path);
  else next.set(item.path, { path: item.path, type: item.type, status: item.status });
  contextPaths.value = next;
}

/** Files from outside the repo (Finder, desktop, the Attach button). */
async function addAttachments(files: File[], folders: string[] = []) {
  contextError.value = folders.length ? `${folders.join(", ")} ${folders.length === 1 ? "is a folder" : "are folders"}. From outside the repo, add individual files.` : "";
  let total = attachments.value.reduce((sum, a) => sum + a.size, 0);
  const added = [];
  for (const file of files) {
    if (file.size > MAX_FILE) {
      contextError.value = `"${file.name}" is over 10 MB.`;
      continue;
    }
    if (total + file.size > MAX_TOTAL) {
      contextError.value = "Attached files must total under 25 MB.";
      break;
    }
    try {
      added.push({ name: file.name, size: file.size, data: await readBase64(file) });
      total += file.size;
    } catch {
      contextError.value = `Couldn't read "${file.name}".`;
    }
  }
  attachments.value = [...attachments.value, ...added];
}

// ---------------------------------------------------------------- team
function participantCount(pattern: string, role: string, selected: RoleValue[]) {
  return selected.reduce((total, agent) => total + 1 + (agent === "auto" ? 0 : roleModels.value[pattern]?.[role]?.[agent]?.variants?.length ?? 0), 0);
}

function Team({ p, roles, providers, remote }: { p: PatternInfo; roles: Record<string, RoleValue[]>; providers?: AgentInfo[]; remote?: boolean }) {
  return (
    <div class="team">
      {p.roles.map((role) => {
        const selected = roles[role.id] ?? [];
        const multipleModels = role.multiple;
        const freeProviders = remote ? [] : (providers ?? agents.value).filter(a => a.available && supportsRunPermissions(a.id)).flatMap(a => {
          const catalog = p.id === "auto-team" ? discoveredCatalogs.value[a.id] : catalogs.value[a.id];
          const free = catalog && !("error" in catalog) ? catalog.models.filter(isFreeModel) : [];
          return free.length ? [{ agent: a.id, models: free }] : [];
        });
        return (
          <div class="role" key={role.id}>
            <div class="role-heading">
              <div class="role-description">
                <div class="rl">{role.label}<span class="role-count">{participantCount(p.id, role.id, selected)} {p.id === "auto-team" && role.id === "pool" ? "choices" : "selected"}</span></div>
                <div class="rd">{role.description}</div>
              </div>
              {freeProviders.length ? <button type="button" class="btn small role-free-action" onClick={() => {
                const entries = multipleModels ? freeProviders : [freeProviders.find(entry => selected.includes(entry.agent)) ?? freeProviders[0]!];
                for (const entry of entries) setRoleModel(p.id, role.id, entry.agent, { model: entry.models[0]!.id, effort: "", variants: multipleModels ? entry.models.slice(1).map(m => ({ model: m.id })) : [] });
                setRoles(p.id, role.id, entries.map(entry => entry.agent));
              }}>{multipleModels ? "Select all free" : "Use free model"}</button> : null}
            </div>
            <div class="role-pick">
              <div class="pills" role="group" aria-label={`${role.label} providers`}>
                {(providers ?? agents.value).map((a) => {
                  const on = selected.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      class="pill"
                      aria-pressed={on}
                      disabled={!!providerProblem(a, providers ? null : health.value) && !on}
                      title={providerProblem(a, providers ? null : health.value) || `${role.multiple ? "Toggle" : "Choose"} ${a.displayName}`}
                      onClick={() => setRoles(p.id, role.id, role.multiple ? (on ? selected.filter((x) => x !== a.id) : [...selected, a.id]) : [a.id])}
                    >
                      <span class="provider-check" aria-hidden="true">{on ? "✓" : "+"}</span><span>{a.displayName}{providerProblem(a, providers ? null : health.value) ? ` · ${providerProblem(a, providers ? null : health.value).split(" — ")[0]}` : ""}</span>
                    </button>
                  );
                })}
                {p.id !== "auto-team" || role.id !== "pool" ? <button
                  type="button"
                  class="pill auto"
                  aria-pressed={selected.includes("auto")}
                  title="code-flow picks an installed agent when the run starts, skipping plans that are near their usage limit"
                  onClick={() => {
                    const on = selected.includes("auto");
                    setRoles(p.id, role.id, role.multiple ? (on ? selected.filter((x) => x !== "auto") : [...selected, "auto"]) : ["auto"]);
                  }}
                >
                  Auto
                </button> : null}
                {role.optional ? (
                  <button type="button" class="pill none" aria-pressed={!selected.length} onClick={() => setRoles(p.id, role.id, [])}>
                    Skip
                  </button>
                ) : null}
              </div>
              {multipleModels && participantCount(p.id, role.id, selected) > selected.length ? <span class="help">{participantCount(p.id, role.id, selected)} {p.id === "auto-team" ? "model choices · coordinator selects within the member limit" : "agents · each model runs separately"}</span> : null}
              {selected.some((id) => id !== "auto") ? (
                <RoleModels p={p} roleId={role.id} roleLabel={role.label.toLowerCase()} agents={selected.filter((id): id is AgentId => id !== "auto")} remote={remote} />
              ) : null}
            </div>
          </div>
        );
      })}
      <div class="team-summary">
        <Icon name="chevron" />
        <span>{teamSentence(p, roles)}</span>
      </div>
    </div>
  );
}

/** What agents may do while building, from least to most. */
export const TRUST = {
  safe: { label: "Safe", help: "Edit files only. Claude can't run commands; Codex stays sandboxed." },
  standard: { label: "Standard", help: "Edit files and run common build/test commands (npm, node, pytest, uv, poetry, cargo, go, make…)." },
  trusted: { label: "Trusted", help: "Any command for Claude; network access inside Codex's sandbox. Use on repos you trust." },
  full: {
    label: "Full access",
    help: "Every agent can run any command, use the network and change files outside its worktree, with your credentials. Only for repos and tasks you trust completely.",
  },
} as const;

/** What the team will do, in one sentence; `checkpoints: false` leaves out plan approval (sweeps don't pause). */
export function teamSentence(p: PatternInfo, roles: Record<string, RoleValue[]>, checkpoints = true, checkMode: CheckMode = "conversation"): string {
  const one = (r: string) => (roles[r]?.[0] ? SHORT[roles[r]![0]!] : "—");
  const many = (r: string) => {
    const n = (roles[r] ?? []).map((id) => { const count = id === "auto" ? 1 : 1 + (roleModels.value[p.id]?.[r]?.[id]?.variants?.length ?? 0); return `${SHORT[id]}${count > 1 ? ` × ${count}` : ""}`; });
    return n.length ? (n.length === 1 ? n[0]! : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`) : "—";
  };
  const opts = optionsFor(p);
  const check = checkCmd.value.trim();
  const doneWhen = (check ? ` · done when “${check}” passes` : "") + (checkpoints && CHECKPOINTS[p.id] && planApprovalFor(p.id) && (p.id !== "debate" || roles.builder?.length) ? ` · you approve ${CHECKPOINTS[p.id]} first` : "");
  switch (p.id) {
    case "auto-team":
      return `${one("coordinator")} assembles up to ${opts.maxMembers ?? 4} members from ${many("pool")} → the team works through dependencies → an independent member verifies the result${doneWhen}`;
    case "pipeline":
      return `${one("planner")} plans → ${one("builder")} builds → ${one("reviewer")} reviews (up to ${opts.maxRounds} rounds of fixes)${doneWhen}`;
    case "race":
      return `${many("contestants")} each solve it separately → ${many("judge")} ${(roles.judge?.length ?? 0) > 1 ? "vote" : "picks"} the best, blind${doneWhen}`;
    case "debate":
      return `${many("debaters")} propose and debate → ${one("synthesizer")} writes the final plan${roles.builder?.length ? ` → ${one("builder")} builds it${roles.reviewer?.length ? ` → ${one("reviewer")} reviews it` : ""}` : " (design only)"}${doneWhen}`;
    case "supervisor":
      return `${one("supervisor")} splits the work and sets the contracts → ${many("workers")} build the parts in parallel → ${one("supervisor")} merges${roles.reviewer?.length ? ` → ${one("reviewer")} reviews` : " and reviews its own work"}${doneWhen}`;
    case "tdd":
      return `${one("tester")} writes tests → ${one("builder")} makes them pass → ${one("tester")} tries to break it${doneWhen}`;
    case "council":
      return `${many("reviewers")} review on their own, read-only → ${one("chair")} merges what they found · nothing is changed or posted without you`;
    case "solo":
      return `${one("agent")} works on it in its own branch; reply to keep going, like a chat. ${checkExplanation(checkMode, check)}`;
    case "loop": {
      const w = roles.workers ?? [];
      const handoff = w.length > 1 ? `, handing over to ${w.slice(1).map((id) => SHORT[id]).join(", then ")} if stuck` : "";
      return `${w.length ? SHORT[w[0]!] : "—"} fixes and code-flow re-runs “${check || "your check"}” until it passes${handoff} (max ${opts.maxRounds} rounds)`;
    }
    default:
      return p.summary;
  }
}

/**
 * What the repository's file sets, and which of it this draft doesn't use (Run details says what it
 * uses instead). Read at a start branch, its permissions and copied files are still your checkout's.
 */
function configSummary(config: Record<string, any>, atBranch = false): string {
  const limit = config.limits ?? {};
  const unless = (used: boolean, text: string | false | undefined) => text && (used ? text : `${text} (overridden)`);
  const local = atBranch ? " (from your checkout)" : "";
  const parts = [
    unless(checkCmd.value.trim() === config.check, config.check && `check “${config.check}”`),
    unless(setupCmd.value.trim() === config.setup, config.setup && `setup “${config.setup}”`),
    config.copy?.length && `copies ${config.copy.join(", ")}${local}`,
    config.run?.command && `runs the app with “${config.run.command}”`,
    unless(trust.value === config.trust, config.trust && `${config.trust} permissions${local}`),
    unless((!limit.maxMinutes || limits.value.maxMinutes === limit.maxMinutes) && (!limit.maxSteps || limits.value.maxSteps === limit.maxSteps), (limit.maxMinutes || limit.maxSteps) && `limits ${[limit.maxMinutes && `${limit.maxMinutes} minutes`, limit.maxSteps && plural(limit.maxSteps, "step")].filter(Boolean).join(", ")}`),
    limit.checkTimeoutMin && `checks stop after ${limit.checkTimeoutMin} minutes`,
    Object.keys(config.models ?? {}).length && `models ${Object.entries(config.models as Record<string, { model?: string; effort?: string }>).map(([id, setting]) => `${SHORT[id as AgentId] ?? id} ${[setting?.model, setting?.effort].filter(Boolean).join(" ") || "default"}`).join(", ")}`,
  ].filter(Boolean);
  return parts.length ? `: ${parts.join(" · ")}` : "";
}

/**
 * Model and effort for each agent in a role, right under its pills (e.g. Opus to plan, Sonnet to
 * review). Empty means the agent's own setting from Settings, or the CLI's default.
 */
export function RoleModels({ p, roleId, roleLabel, agents: ids, remote }: { p: PatternInfo; roleId: string; roleLabel: string; agents: AgentId[]; remote?: boolean }) {
  const current = roleModels.value[p.id]?.[roleId] ?? {};
  return <div class="role-models">{ids.map(id => {
    const s = current[id] ?? {};
    const cat = p.id === "auto-team" ? discoveredCatalogs.value[id] : catalogs.value[id];
    if (remote) return <div key={id} class="provider-models">
      <div class="provider-model-heading"><AgentTag id={id} /></div>
      <div class="team-model-row">
        <label>Model<input class="field" aria-label={`${SHORT[id]} model for the ${roleLabel}`} placeholder="Worker CLI default model" value={s.model ?? ""} onChange={event => setRoleModel(p.id, roleId, id, { model: event.currentTarget.value })} /></label>
        <label>Effort<input class="field" aria-label={`${SHORT[id]} effort for the ${roleLabel}`} placeholder="Default effort" value={s.effort ?? ""} onChange={event => setRoleModel(p.id, roleId, id, { effort: event.currentTarget.value })} /></label>
      </div>
    </div>;
    if (!cat || "error" in cat) return <div key={id} class="provider-models"><div class="provider-model-heading"><AgentTag id={id} /><span class="help">{cat ? "Using CLI defaults · model list unavailable" : "Loading models…"}</span></div></div>;
    const c = cat as ModelCatalog;
    const base = p.id === "auto-team" && roleId === "pool" ? {} : agentSettings.value[id] ?? {};
    const baseModel = base.model || c.defaultModel;
    const multiple = p.roles.find(role => role.id === roleId)?.multiple;
    const rows = [{ model: s.model ?? "", effort: s.effort ?? "" }, ...(multiple ? s.variants ?? [] : [])];
    const available = freeModelsFirst(c.models).filter(model => model.id !== (s.model || baseModel) && !s.variants?.some(v => v.model === model.id));
    return <div key={id} class="provider-models">
      <div class="provider-model-heading">
        <div class="provider-model-name"><AgentTag id={id} />{rows.length > 1 ? <span class="role-count">{rows.length} models</span> : null}</div>
        {multiple ? <ModelSelect class="add-model" label={`Add ${SHORT[id]} model for the ${roleLabel}`} value="" placeholder="+ Add model" options={available} disabled={!available.length || rows.length >= 129} onChange={model => setRoleModel(p.id, roleId, id, { variants: [...(s.variants ?? []), { model }] })} /> : null}
      </div>
      {rows.map((row, index) => {
        const primary = index === 0;
        const model = c.models.find(m => m.id === (row.model || baseModel));
        const efforts = model?.efforts ?? c.efforts;
        const defaultEffort = primary ? base.effort || model?.defaultEffort || c.defaultEffort : model?.defaultEffort || c.defaultEffort;
        const label = (kind: string) => primary ? `${SHORT[id]} ${kind} for the ${roleLabel}` : `${SHORT[id]} additional ${kind} ${index} for the ${roleLabel}`;
        const choices = freeModelsFirst(c.models).filter(m => primary || m.id === row.model || m.id !== (s.model || baseModel) && !s.variants?.some(v => v.model === m.id));
        return <div class={`team-model-row ${primary ? "primary" : "additional"}`} key={index}>
          <div class="model-field"><span>Model{rows.length > 1 ? ` ${index + 1}` : ""}</span>
            <ModelSelect label={label("model")} value={row.model} options={[
              ...(primary ? [{ id: "", label: p.id === "auto-team" && roleId === "pool" ? "Automatic · coordinator chooses" : baseModel ? `Default · ${c.models.find(m => m.id === baseModel)?.label ?? baseModel}` : "Default model" }] : []),
              ...choices,
              ...(row.model && !c.models.some(m => m.id === row.model) ? [{ id: row.model, label: row.model }] : []),
            ]} onChange={next => {
              if (primary) {
                const nextModel = c.models.find(m => m.id === (next || baseModel));
                const allowed = nextModel?.efforts ?? c.efforts;
                setRoleModel(p.id, roleId, id, { model: next, effort: row.effort && allowed.includes(row.effort) ? row.effort : "", variants: s.variants?.filter(v => v.model !== (next || baseModel)) });
              } else setRoleModel(p.id, roleId, id, { variants: s.variants!.map((v, i) => i === index - 1 ? { model: next } : v) });
            }} />
          </div>
          <label>Effort<select class="field" aria-label={label("effort")} value={row.effort ?? ""} onChange={event => {
            const effort = event.currentTarget.value;
            if (primary) setRoleModel(p.id, roleId, id, { effort });
            else setRoleModel(p.id, roleId, id, { variants: s.variants!.map((v, i) => i === index - 1 ? { ...v, effort } : v) });
          }}><option value="">{defaultEffort ? `Default · ${defaultEffort}` : "Default effort"}</option>{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
          {!primary ? <button type="button" class="icon-btn remove-model" title="Remove model" aria-label={`Remove ${SHORT[id]} model ${row.model}`} onClick={() => setRoleModel(p.id, roleId, id, { variants: s.variants!.filter((_, i) => i !== index - 1) })}><Icon name="close" /></button> : <span class="model-remove-space" aria-hidden="true" />}
        </div>;
      })}
    </div>;
  })}</div>;
}

// ---------------------------------------------------------------- settings
function Settings({ p, roles, open, onToggle, budgetRevision }: { p: PatternInfo; roles: Record<string, RoleValue[]>; open: boolean; onToggle: (open: boolean) => void; budgetRevision: number }) {
  const info = repoInfo.value;
  const used = new Set(Object.values(roles).flat().filter((id): id is AgentId => id !== "auto"));
  const models = [...used]
    .map((id) => {
      const s = agentSettings.value[id];
      return s?.model || s?.effort ? `${SHORT[id]}: ${[s.model, s.effort].filter(Boolean).join(" ")}` : null;
    })
    .filter(Boolean);
  const fromPr = source.value?.kind === "pr" ? source.value : null;
  const baseLabel = fromPr ? `PR #${fromPr.number}'s branch` : baseRef.value || (info?.current ? `HEAD (${info.current})` : "HEAD");
  const opts = optionsFor(p);
  const setLimits = (patch: Partial<typeof limits.value>) => setRunLimits(patch);
  return (
    <details class="settings" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
      <summary>
        <span class="st">Branches and limits</span>
        <span class="ss">
          from {baseLabel} · {models.length ? models.join(", ") : "default models"} · stops after {budgetDuration(limits.value.maxMinutes)} or {plural(limits.value.maxSteps, "step")}
          {trust.value === "full" ? <span class="full-access"> · ⚠ full access</span> : null}
        </span>
      </summary>
      <div class="settings-body">
        <div class="settings-grid">
          <div>
            <label class="lbl" for="branchPrefix">
              Result branch name
            </label>
            <input class="field" id="branchPrefix" placeholder="codeflow/<run-id>" spellcheck={false} autocomplete="off" value={branchPrefix.value} onInput={(e) => (branchPrefix.value = e.currentTarget.value)} />
            <div class="help">
              Results land on <code>name/build</code>, <code>name/candidate-a</code>…
            </div>
          </div>
          {p.options.map((o) => (
            <div key={o.id}>
              <label class="lbl" for={`opt-${o.id}`}>
                {o.label}
              </label>
              {o.type === "boolean" ? (
                <input type="checkbox" id={`opt-${o.id}`} checked={!!opts[o.id]} onChange={(e) => setOption(p, o.id, e.currentTarget.checked)} />
              ) : (
                <NumberField id={`opt-${o.id}`} problemKey={`composer:option:${p.id}:${o.id}`} value={opts[o.id] as number} rule={{ label: o.label, min: o.min ?? 0, max: o.max ?? Number.MAX_SAFE_INTEGER, integer: true }} onChange={value => setOption(p, o.id, value!)} />
              )}
            </div>
          ))}
        </div>
        <div>
          <span class="lbl">Limits — the run stops when it reaches either</span>
          <p class="help">This is the maximum allowance, not a target. Runs finish sooner when the work is complete. Time waiting for approval or a free slot does not count.</p>
          <div class="settings-grid">
            <div>
              <label class="lbl" for="maxMinutes">
                Minutes
              </label>
              <NumberField key={`minutes:${budgetRevision}`} id="maxMinutes" problemKey="composer:maxMinutes" value={limits.value.maxMinutes} rule={EXECUTION_LIMITS.maxMinutes} onChange={value => setLimits({ maxMinutes: value! })} />
            </div>
            <div>
              <label class="lbl" for="maxSteps">
                Agent steps
              </label>
              <NumberField key={`steps:${budgetRevision}`} id="maxSteps" problemKey="composer:maxSteps" value={limits.value.maxSteps} rule={EXECUTION_LIMITS.maxSteps} onChange={value => setLimits({ maxSteps: value! })} />
            </div>
            <div><label class="lbl" for="maxTokens">Reported token ceiling</label><NumberField id="maxTokens" problemKey="composer:maxTokens" value={limits.value.maxTokens} rule={EXECUTION_LIMITS.maxTokens} optional placeholder="Optional" onChange={value => setLimits({ maxTokens: value })} /></div>
            <div><label class="lbl" for="maxCostUsd">Reported API-equivalent ceiling ($)</label><NumberField id="maxCostUsd" problemKey="composer:maxCostUsd" value={limits.value.maxCostUsd} rule={EXECUTION_LIMITS.maxCostUsd} optional placeholder="Optional" onChange={value => setLimits({ maxCostUsd: value })} /></div>

          </div>
          <div class="help">Ceilings use reported usage; they cannot count missing provider data and are checked between operations. API-equivalent cost is not your subscription bill. Work done before a limit is kept on its branch.</div>
          {rerunDraft.value?.loop.maxInvocations !== undefined ? <p class="help">Original invocation ceiling: {rerunDraft.value.loop.maxInvocations} CLI calls. This ceiling is retained separately from the agent-step limit.</p> : null}
        </div>
        {info ? <div class="help">Each run works in git worktrees under {info.worktreeRoot}/ — your checkout is never touched.</div> : null}
      </div>
    </details>
  );
}

export function ModelRow({ agent, used, settings, onChange }: { agent: AgentInfo; used: boolean; settings?: { model?: string; effort?: string }; onChange?: (patch: { model?: string; effort?: string }) => void }) {
  const cat = catalogs.value[agent.id];
  // Without its own settings, the row edits the saved provider defaults (Settings > Agents & models).
  const s = settings ?? providerDefaults.value[agent.id] ?? {};
  const changeSetting = (patch: { model?: string; effort?: string }) => onChange ? onChange(patch) : setProviderDefault(agent.id, patch);
  // Hooks before any early return; null = "derive from the saved model".
  const [customChoice, setCustom] = useState<boolean | null>(null);
  if (!cat || "error" in cat) {
    return (
      <div class={`model-row ${used ? "" : "unused"}`}>
        <AgentTag id={agent.id} />
        <div class="err">Uses the CLI's defaults (couldn't list models)</div>
      </div>
    );
  }
  const catalog = cat as ModelCatalog;
  const known = catalog.models.some((m) => m.id === s.model);
  const custom = customChoice ?? (!!s.model && !known);
  const model = catalog.models.find((m) => m.id === s.model);
  const efforts = model?.efforts?.length ? model.efforts : catalog.efforts;
  const fallbackEffort = model?.defaultEffort || catalog.defaultEffort;
  return (
    <div class={`model-row ${used ? "" : "unused"}`} title={used ? "" : "Not used by this team"}>
      <AgentTag id={agent.id} />
      <ModelSelect label={`${agent.displayName} model`} value={custom ? "__custom" : s.model ?? ""} options={[
        { id: "", label: catalog.defaultModel ? `Default (${catalog.defaultModel})` : "Default model" },
        ...freeModelsFirst(catalog.models),
        ...(catalog.allowCustom ? [{ id: "__custom", label: "Other…" }] : []),
      ]} onChange={value => {
        setCustom(value === "__custom");
        const next = value === "__custom" ? "" : value;
        const nextModel = catalog.models.find(m => m.id === next);
        const allowed = nextModel?.efforts?.length ? nextModel.efforts : catalog.efforts;
        changeSetting({ model: next, effort: s.effort && allowed.includes(s.effort) ? s.effort : "" });
      }} />
      <select class="field" aria-label={`${agent.displayName} effort`} value={s.effort ?? ""} onChange={(e) => changeSetting({ effort: e.currentTarget.value })}>
        <option value="">{fallbackEffort ? `Default (${fallbackEffort})` : "Default effort"}</option>
        {efforts.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      {custom ? (
        <input class="field custom" type="text" placeholder="model id or alias" aria-label={`${agent.displayName} custom model`} aria-invalid={!!modelIdProblem(agent.id, s.model)} title={modelIdProblem(agent.id, s.model)} value={s.model ?? ""} onInput={(e) => changeSetting({ model: e.currentTarget.value })} onBlur={(e) => changeSetting({ model: e.currentTarget.value.trim() })} />
      ) : null}
    </div>
  );
}

// ================================================================= files panel
/**
 * The repository's files, searchable, for the side panel's Files tab: a file opens in the viewer
 * (`onOpen`), and from the composer, drags into the task or is added to it with +. `root` is
 * the repository, or one of a run's worktrees.
 */
export function FileTree({ root, onOpen }: { root: string; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TreeEntry[] | null>(null);
  // Only the latest answer counts: a slow listing or search must not replace a newer one.
  const treeRequest = useLatest();
  const searchRequest = useLatest();

  // Reset the folder scope before it is interactive; a passive mount effect
  // could erase a search entered immediately after opening the panel.
  useLayoutEffect(() => {
    const current = treeRequest();
    setQuery("");
    setResults(null);
    if (!root) {
      setEntries(null);
      setMessage("Choose a repository to see its files.");
      return;
    }
    setMessage("Loading…");
    api<{ entries: TreeEntry[]; truncated: boolean }>(`/api/tree?repo=${enc(root)}&path=`)
      .then((d) => {
        if (!current()) return;
        setEntries(d.entries);
        setTruncated(d.truncated);
        setMessage("");
      })
      .catch((err) => current() && setMessage((err as Error).message));
  }, [root]);

  useEffect(() => {
    // Any change, clearing the box too, makes a search still on its way stale.
    const current = searchRequest();
    const q = query.trim();
    if (!q || !root) return setResults(null);
    const timer = setTimeout(async () => {
      try {
        const found = await api<TreeEntry[]>(`/api/search?repo=${enc(root)}&q=${enc(q)}`);
        if (current()) setResults(found);
      } catch (err) {
        if (current()) setMessage((err as Error).message);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query, root]);

  const inComposer = route.value.view === "composer" && root === repo.value;
  return (
    <>
      <input type="search" class="field files-search" placeholder="Search files…" aria-label="Search files" autocomplete="off" spellcheck={false} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      <div class="tree">
        {message ? <div class="tree-empty">{message}</div> : null}
        {/* a tree only once it has items: an empty one (loading, no matches) reads as a broken tree */}
        {(results ?? entries)?.length ? (
          <div role="tree" aria-label={results ? "Matching files" : "Files"}>
            {results
              ? results.map((r) => <TreeNode key={`s:${r.path}`} entry={r} depth={0} sub={r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : ""} root={root} onOpen={onOpen} context={inComposer} />)
              : entries?.map((e) => <TreeNode key={e.path} entry={e} depth={0} root={root} onOpen={onOpen} context={inComposer} />)}
          </div>
        ) : null}
        {results && !results.length ? <div class="tree-empty">No matching files</div> : null}
        {!results && truncated ? <div class="tree-empty">Showing the first 1000 — use search</div> : null}
      </div>
      {inComposer ? (
        <div class="files-foot">
          Click a file to read it; double-click, <b>+</b> or drag adds it to the task. <b>−</b> removes it. <b class="mark-m">M</b> changed · <b class="mark-u">U</b> new
        </div>
      ) : null}
    </>
  );
}

function TreeNode({ entry, depth, sub, root, onOpen, context }: { entry: TreeEntry; depth: number; sub?: string; root: string; onOpen: (path: string) => void; context: boolean }) {
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const request = useLatest();
  const [truncated, setTruncated] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  const added = context && contextPaths.value.has(entry.path);
  const statusName = entry.status ? ({ M: "changed", U: "new, not committed", A: "added" } as const)[entry.status] : "";
  const isDir = entry.type === "dir";
  const expand = async () => {
    setOpen(true);
    if (children) return;
    const current = request();
    setMessage("Loading…");
    try {
      const d = await api<{ entries: TreeEntry[]; truncated: boolean }>(`/api/tree?repo=${enc(root)}&path=${enc(entry.path)}`);
      if (!current()) return;
      setChildren(d.entries); setTruncated(d.truncated);
      setMessage(d.entries.length ? "" : "Empty folder");
    } catch (err) {
      if (current()) setMessage((err as Error).message);
    }
  };
  const toggle = () => {
    if (!isDir) return onOpen(entry.path);
    if (open) return setOpen(false);
    void expand();
  };
  /** Enter or Space opens; → and ← open and close a folder; ↓ and ↑ go to the next and previous item. */
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // the + button's own keys
    const node = e.currentTarget as HTMLElement;
    if (e.key === "Enter" || e.key === " ") toggle();
    else if (e.key === "ArrowRight" && isDir && !open) void expand();
    else if (e.key === "ArrowLeft" && isDir && open) setOpen(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...(node.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
      items[items.indexOf(node) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else return;
    e.preventDefault();
  };
  return (
    <div>
      <div
        class={`node ${added ? "added" : ""}`}
        role="treeitem"
        tabIndex={0}
        aria-level={depth + 1}
        aria-expanded={isDir ? open : undefined}
        aria-label={`${entry.name}${sub ? `, in ${sub}` : ""}${statusName ? `, ${statusName}` : ""}${added ? ", in the task" : ""}`}
        draggable={context}
        title={`${entry.path}${statusName ? ` — ${statusName}` : ""}${context ? "\nDrag into the task, or click +" : ""}`}
        style={`padding-left:${2 + depth * 14}px`}
        onClick={event => {
          if (!context || isDir || event.detail === 0) return toggle();
          clearTimeout(clickTimer.current);
          if (event.detail >= 2) { addContext(entry); onOpen(entry.path); }
          else clickTimer.current = setTimeout(() => onOpen(entry.path), 300);
        }}
        onKeyDown={onKey}
        onDblClick={event => { event.stopPropagation(); if (context && !isDir) { clearTimeout(clickTimer.current); addContext(entry); } }}
        onDragStart={(e) => {
          e.dataTransfer!.setData(DRAG_TYPE, JSON.stringify({ path: entry.path, type: entry.type }));
          e.dataTransfer!.setData("text/plain", entry.path);
          e.dataTransfer!.effectAllowed = "copy";
          e.currentTarget.classList.add("dragging");
        }}
        onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
      >
        <span class="tw">{entry.type === "dir" ? <Icon name="chevron" class={open ? "" : "shut"} /> : null}</span>
        <span class={`lb ${entry.type}`}>
          <Icon name={entry.type === "dir" ? "folder" : "file"} class="fi" /> {entry.name}
        </span>
        {sub ? <span class="sub">{sub}</span> : null}
        <span class={`st ${entry.status ?? ""}`}>{entry.status ?? ""}</span>
        {context ? (
          <button
            type="button"
            class="add"
            title={added ? `Remove ${entry.path} from the task` : `Add ${entry.path} to the task`}
            aria-label={added ? `Remove ${entry.path} from the task` : `Add ${entry.path} to the task`}
            onClick={(e) => {
              e.stopPropagation();
              toggleContext(entry);
            }}
          >
            {added ? "−" : "+"}
          </button>
        ) : null}
      </div>
      {open ? (
        <div role="group">
          {message ? (
            <div class="tree-empty" style={`padding-left:${22 + depth * 14}px`}>
              {message}
            </div>
          ) : null}
          {children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} root={root} onOpen={onOpen} context={context} />)}
          {truncated ? <div class="tree-empty" style={`padding-left:${22 + depth * 14}px`}>Showing the first 1000 — use search</div> : null}
        </div>
      ) : null}
    </div>
  );
}
