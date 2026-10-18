import type { VerificationProfile } from "../src/verification.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { AgentTag } from "./bits.js";
import { api, ApiError, baseName, enc, fmtSize, FLOWS, post, readBase64, SHORT, store } from "./lib.js";
import { useDialog } from "./app.js";
import { AcceptanceEditor, ComposerLibraryEditor, ContextInspector, EffectiveSettings, FirstRunGuide, RepositoryReadiness } from "./onboarding.js";
import { DeferredRunsPanel } from "./deferred-runs.js";
import { contextBudget } from "./context-budget.js";
import { taskWithCriteria } from "./composer-tools.js";
import {
  agents,
  acceptanceCriteria,
  setAcceptanceCriteria,
  configChecking,
  agentSettings,
  planApprovalFor,
  health,
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
  checkHint,
  contextError,
  contextPaths,
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
  setAgentSetting,
  setCheck,
  setLimits,
  setOption,
  setPattern,
  setRoles,
  setSetup,
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
import { ProjectButton, ProjectNote } from "./projects.js";
import { ProjectMemory } from "./memory.js";
import { TeamRolloutNotice } from "./team-evaluation.js";
import { SourceChip, Templates } from "./github.js";
import { SaveAutomationDialog } from "./automations.js";
import { Icon } from "./icons.js";
import type { AgentId, AgentInfo, ContextItem, ModelCatalog, PatternInfo, TreeEntry } from "./types.js";

const DRAG_TYPE = "application/x-codeflow-path";
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
const fileIcon = (type: string) => (type === "dir" ? "📁" : "📄");

// ================================================================= composer
export function Composer() {
  const [containerEnabled, setContainerEnabled] = useState(false);
  const [containerImage, setContainerImage] = useState("");
  const [containerVolume, setContainerVolume] = useState("");
  const [verificationProfile, setVerificationProfile] = useState<VerificationProfile | null>(null);
  const [verificationPreset, setVerificationPreset] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const profileRequest = useRef(0);
  const [toolApprovals, setToolApprovals] = useState(store.get("interactiveApprovals") === "1");
  const p = pattern.value;
  useEffect(() => { ++profileRequest.current; setVerificationProfile(null); setVerificationPreset(""); setProfileLoading(false); }, [repo.value]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  // Pins sent from the side panel's Browser: their text joins the task, their snapshots its attachments.
  useEffect(() => {
    const drafts = takeDrafts("composer");
    if (!drafts.length) return;
    setTask([task.value.trim(), ...drafts.map((d) => d.text)].filter(Boolean).join("\n\n"));
    attachments.value = [...attachments.value, ...drafts.flatMap((d) => d.images)];
  }, [chatDrafts.value]);
  const roles = rolesFor(p);
  const problem = startProblem(p, roles) || (profileLoading ? "Loading verification profile…" : "");

  const [saving, setSaving] = useState(false);
  const runBody = (p: PatternInfo) => ({
    repo: repo.value,
    project: target.value.project?.id,
    task: taskWithCriteria(task.value, acceptanceCriteria.value),
    pattern: p.id,
    roles,
    options: optionsFor(p),
    baseRef: baseRef.value,
    source: source.value ? { kind: source.value.kind, number: source.value.number, ciLogs: !!source.value.ciLogs, tool: source.value.tool, numbers: source.value.numbers } : undefined,
    branchPrefix: branchPrefix.value.trim(),
    externalSourceId: externalSource.value?.id,
    context: {
      paths: [...contextPaths.value.values()].map((c) => ({ path: c.path })),
      attachments: attachments.value.map((a) => ({ name: a.name, data: a.data })),
    },
    agentSettings: agentSettings.value,
    approvals: { plan: !!CHECKPOINTS[p.id] && planApprovalFor(p.id), tools: toolApprovals },
    trust: trust.value,
    roleSettings: roleModels.value[p.id] ?? {},
    loop: {
      check: checkCmd.value.trim(),
      setup: setupCmd.value.trim(),
      maxMinutes: limits.value.maxMinutes,
      maxSteps: limits.value.maxSteps,
      maxTokens: limits.value.maxTokens,
      maxCostUsd: limits.value.maxCostUsd,
      contextBudget: contextBudget.value,
      verification: verificationProfile,
      agentContainer: containerEnabled ? { image: containerImage.trim(), authVolume: containerVolume.trim() || undefined, network: true } : undefined,
      copy: repoConfig.value?.config.copy,
    },
  });
  const [comparing, setComparing] = useState(false);
  const start = async () => {
    if (problem || !p || starting || profileLoading) return;
    if (containerEnabled && !containerImage.trim()) { setError("Choose a prebuilt agent image"); return; }
    setStarting(true);
    setError("");
    try {
      const { id, project } = await postConfirmed<{ id: string; project?: string }>("/api/runs", { ...runBody(p), remember: true });
      resetComposer();
      await Promise.all([afterStart(project), refreshRuns()]);
      route.value = { view: "run", id };
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };
  // Fresh composer for the next run; "Edit & run again" brings these back.
  const resetComposer = () => {
    store.set("baseRef", baseRef.value);
    setTask("");
    setAcceptanceCriteria([]);
    branchPrefix.value = "";
    source.value = null;
    externalSource.value = null;
    contextPaths.value = new Map();
    attachments.value = [];
  };

  return (
    <div class="composer">
      <div class="eyebrow">New run</div>
      <h1>What should the team build?</h1>
      <p class="lede">Describe the task, add the files that matter, and pick how your agents work together.</p>
      <div class="where" role="group" aria-label="Where the run works">
        <ProjectButton composer />
        <RepoButton />
      </div>
      <FirstRunGuide />
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

      {repoConfig.value?.found ? (
        <div class={`config-note ${repoConfig.value.error ? "bad" : ""}`}>
          {repoConfig.value.error ? (
            <>⚠ {repoConfig.value.error}</>
          ) : (
            <>
              ⚙ Using <code>.codeflow/config.json</code>
              {configSummary(repoConfig.value.config)}
            </>
          )}
        </div>
      ) : null}
      <ProjectNote />
      {externalSource.value ? <div class="banner"><p>External context: {externalSource.value.provider} {externalSource.value.kind} {externalSource.value.key} · {externalSource.value.title}</p><p class="help">This source remains untrusted. The run uses Safe permissions and isolated checks.</p><button class="btn small" onClick={() => { externalSource.value = null; }}>Remove source</button></div> : null}
      {p?.id === "auto-team" ? <TeamRolloutNotice /> : null}
      {p?.id === "auto-team" && target.value.project && repo.value ? <ProjectMemory key={`${target.value.project.id}:${repo.value}`} projectId={target.value.project.id} repo={repo.value} /> : null}
      {repoInfo.value ? <Templates /> : null}
      <TaskBox onStart={start} />
      <AcceptanceEditor />
      {contextError.value ? <div class="msg err">{contextError.value}</div> : null}

      <div class="section">
        <label class="lbl" for="workflow-select">Workflow</label>
        <select class="field" id="workflow-select" aria-label="Workflow" value={p?.id ?? ""} onChange={(e) => setPattern(e.currentTarget.value)}>
          {patterns.value.map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === "pipeline" ? " · recommended for most changes" : ""}</option>)}
        </select>
        {p ? <p class="pattern-why">{teamSentence(p, roles)}</p> : null}
        {trust.value === "full" ? <p class="full-warn" role="alert"><b>Full access: no sandbox.</b> Agents can run commands and change files outside their worktree with your credentials. Review permissions in Advanced team controls.</p> : null}
        {p && CHECKPOINTS[p.id] && (p.id !== "debate" || roles.builder?.length) ? (
          <label class="checkpoint">
            <input type="checkbox" checked={planApprovalFor(p.id)} onChange={(e) => setApprovePlan(e.currentTarget.checked, p.id)} />
            <span><b>Let me approve {CHECKPOINTS[p.id]}</b> before agents build.</span>
          </label>
        ) : null}
        <div class={`donewhen ${p?.requiresCheck && !checkCmd.value.trim() ? "required" : ""}`}>
          <label class="lbl" for="checkCmd">Done when this passes</label>
          <div class="dw-row"><span class="dw-prompt">$</span><input class="field" id="checkCmd" placeholder="e.g. npm test" spellcheck={false} autocomplete="off" value={checkCmd.value} onInput={(e) => setCheck(e.currentTarget.value)} /></div>
          <div class="help">{configChecking.value ? "Loading repository configuration… " : checkHint.value ? `${checkHint.value} ` : ""}code-flow runs this itself after changes. A run without a passing automated check is unchecked.</div>
        </div>
      </div>

      <details class="settings advanced-controls" open={store.get("composerAdvanced") === "1"} onToggle={(e) => store.set("composerAdvanced", e.currentTarget.open ? "1" : "0")}>
        <summary><span class="st">Advanced team controls</span><span class="ss">Roles, models, permissions and limits</span></summary>
        <div class="settings-body">
        <div class="patterns">
          {patterns.value.map((x) => (
            <button key={x.id} type="button" class={`pattern ${x.id === p?.id ? "selected" : ""}`} aria-pressed={x.id === p?.id} onClick={() => setPattern(x.id)}>
              <span class="pn">{x.name}</span>
              <span class="pf">{FLOWS[x.id] ?? x.summary}</span>
            </button>
          ))}
        </div>
        {p ? <p class="pattern-why">{p.description}</p> : null}
        {p ? <Team p={p} roles={roles} /> : null}
        <div class="section"><label class="lbl" for="verification-profile">Verification gates</label><select class="field" id="verification-profile" value={verificationPreset} disabled={!repo.value} onChange={async (event) => { const selected = event.currentTarget.value; const request = ++profileRequest.current; setVerificationPreset(selected); if (!selected) { setVerificationProfile(null); setProfileLoading(false); return; } const current = repo.value; setProfileLoading(true); try { const profile = await api<VerificationProfile>(`/api/verification/profile?repo=${enc(current)}&preset=${selected}`); if (repo.value === current && request === profileRequest.current) setVerificationProfile(profile); } catch (error) { if (repo.value === current && request === profileRequest.current) { setError((error as Error).message); setVerificationPreset(""); setVerificationProfile(null); } } finally { if (request === profileRequest.current) setProfileLoading(false); } }}><option value="">Single configured check</option><option value="lightweight">Lightweight profile</option><option value="standard">Standard profile</option><option value="thorough">Thorough profile</option></select>{verificationProfile ? <p class="help">Required gates: {verificationProfile.checks.map((gate) => gate.command).join(" · ") || "No runnable gates detected"}. Each gate appears in the run's evidence.</p> : null}</div>
      {p ? <Settings p={p} roles={roles} /> : null}
        </div>
      </details>
      <RepositoryReadiness />
      {p ? <ComposerLibraryEditor p={p} onToolApprovalsChange={setToolApprovals} /> : null}
      {p ? <EffectiveSettings p={p} verificationProfile={verificationProfile} container={{ enabled: containerEnabled, image: containerImage, authVolume: containerVolume }} /> : null}
      <ContextInspector />
      {p && repo.value && task.value.trim() ? <details class="settings"><summary>Start later or wait for provider capacity</summary><div class="settings-body"><DeferredRunsPanel runRequest={runBody(p)} project={target.value.project?.id} repo={repo.value} /></div></details> : null}

      <details class="settings"><summary>Agent isolation</summary><div class="settings-body"><label class="checkpoint"><input type="checkbox" checked={containerEnabled} onChange={(event) => setContainerEnabled(event.currentTarget.checked)} /><span>Run agents in a prebuilt Docker image</span></label>{containerEnabled ? <><label>Image<input class="field" placeholder="Your prepared image:tag" value={containerImage} onInput={(event) => setContainerImage(event.currentTarget.value)} /></label><label>Authentication volume<input class="field" placeholder="Optional explicitly named Docker volume" value={containerVolume} onInput={(event) => setContainerVolume(event.currentTarget.value)} /></label><p class="help">The image must contain compatible official CLIs and be authenticated inside the image or selected volume. Host credential folders are never mounted. Agents receive their worktree and read-only Git metadata; network access is enabled for inference. Live team bridges use structured turn-boundary replies in containers.</p></> : null}</div></details>
      <label class="checkpoint"><input type="checkbox" checked={toolApprovals} onChange={(event) => { setToolApprovals(event.currentTarget.checked); store.set("interactiveApprovals", event.currentTarget.checked ? "1" : "0"); }} /><span><b>Ask me for tool permissions</b> · Supported Codex requests appear in an approval inbox. Unattended and locked-down runs always decline them.</span></label>
      <div class="start-row">
        <button class="btn primary" disabled={!!problem || starting} onClick={start}>
          {starting ? "Starting…" : "Start run"} <span class="kbd">⌘↵</span>
        </button>
        <button class="btn secondary-run-action" disabled={!!problem} title="Run this task with several patterns or teams at once and see them side by side" onClick={() => setComparing(true)}>
          <Icon name="compare" /> Compare setups…
        </button>
        <button class="btn secondary-run-action" disabled={!!problem} title="Run this task with this team on a schedule or from a webhook" onClick={() => setSaving(true)}>
          <Icon name="clock" /> Save as automation…
        </button>
        <span class="why">{problem}</span>
      </div>
      {error ? <div class="msg err">{error}</div> : null}
      {saving && p ? <SaveAutomationDialog body={runBody(p)} onClose={() => setSaving(false)} /> : null}
      {comparing && p ? (
        <CompareDialog
          base={{ ...runBody(p), approvals: {} }}
          onClose={() => setComparing(false)}
          onStarted={(group) => {
            resetComposer();
            void refreshRuns();
            void loadProjects();
            route.value = { view: "insights", group };
          }}
        />
      ) : null}
    </div>
  );
}

/** The repository (and its current branch) the run works in. */
function RepoButton() {
  const info = repoInfo.value;
  return (
    <button type="button" class={`repo-btn ${info ? "" : "empty"} ${repoError.value ? "bad" : ""}`} title={info ? info.repo : "Choose repository"} onClick={() => (pickerOpen.value = true)}>
      <Icon name="folder" />
      <span class="name">{info ? baseName(info.repo) : repoChecking.value ? "Checking…" : repoError.value || "Choose repository…"}</span>
      {info ? <span class="branch">{info.current || "detached"}</span> : null}
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
    if (!confirm(`${err.message}\n\nRun its checks on this machine anyway?`)) throw new Error("Not started: the source isn't trusted and Docker isn't available.");
    return post<T>(path, { ...body, allowUntrusted: true });
  }
}

/** Start the same task with several patterns (each with the team you last set for it). */
function CompareDialog({ base, onClose, onStarted }: { base: Record<string, any>; onClose: () => void; onStarted: (group: string) => void }) {
  const ref = useDialog(true, onClose);
  const current = pattern.value?.id;
  const [picked, setPicked] = useState<Set<string>>(new Set(current ? [current] : []));
  const [repeat, setRepeat] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = patterns.value.map((p) => {
    const roles = rolesFor(p);
    return { p, roles, problem: startProblem(p, roles) };
  });
  const runs = picked.size * repeat;
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const variants = choices
        .filter((c) => picked.has(c.p.id))
        .map((c) => ({ label: c.p.name, pattern: c.p.id, roles: c.roles, options: optionsFor(c.p), roleSettings: roleModels.value[c.p.id] ?? {} }));
      const { group } = await postConfirmed<{ group: string }>("/api/compare", { run: base, variants, repeat });
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
            tests. Each pattern uses the team you last picked for it — select a pattern in the composer to change its team.
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
            {runs > 9 ? " — at most 9" : ""}; they share code-flow's agent slots, so some may wait their turn.
          </span>
          <button class="btn" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={busy || picked.size < 2 || runs > 9} onClick={go} title={picked.size < 2 ? "Pick at least two setups" : ""}>
            {busy ? "Starting…" : `Start ${runs} runs`}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Why the run can't start yet ("" when it can); `needsTask: false` for sweeps, whose items bring their tasks. */
export function startProblem(p: PatternInfo | undefined, roles: Record<string, RoleValue[]>, needsTask = true): string {
  if (p?.id === "auto-team" && teamRollout.value?.enabled === false) return "New Auto teams are disabled. Existing teams can still be resumed.";
  if (repoChecking.value) return "Checking repository…";
  if (!repo.value) return "Choose a repository first";
  if (configChecking.value) return "Loading repository configuration…";
  if (needsTask && !task.value.trim()) return "Describe the task to start";
  if (!p) return "Pick how the agents work together";
  for (const role of p.roles) if (!role.optional && !roles[role.id]?.length) return `Pick an agent for ${role.label}`;
  if (p.id === "race" && (roles.contestants?.length ?? 0) < 2) return "A race needs at least two contestants";
  if (p.id === "debate" && (roles.debaters?.length ?? 0) < 2) return "A debate needs at least two debaters";
  if (p.id === "auto-team" && !(roles.pool?.length)) return "Keep at least one provider in the pool";
  if (p.id === "auto-team" && limits.value.maxSteps < 4) return "An Auto team needs at least 4 steps: planning, work, review and recovery";
  if (p.requiresCheck && !checkCmd.value.trim()) return `${p.name} needs a “Done when” command, e.g. npm test`;
  // An Auto pool is permission to choose from these providers; availability is checked by
  // the coordinator before building its roster, so one signed-out candidate needn't block it.
  const used = new Set<RoleValue>(p.id === "auto-team" ? roles.coordinator ?? [] : Object.values(roles).flat());
  const signedOut = health.value?.find((h) => used.has(h.id) && h.installed && h.signedIn === false);
  if (signedOut) return `${signedOut.name} isn't signed in — open Health in the top bar`;
  return "";
}

// ---------------------------------------------------------------- task box
function TaskBox({ onStart }: { onStart: () => void }) {
  const [over, setOver] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
      <textarea
        ref={area}
        aria-label="Task"
        placeholder="e.g. Add rate limiting to the /login endpoint, with tests…"
        value={task.value}
        onInput={(e) => setTask(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onStart();
          }
        }}
      />
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
        <span class="hint">
          {count ? `${count} item${count === 1 ? "" : "s"} of context — agents read these before starting` : "Drag files here from the file list or Finder to give the agents context"}
        </span>
      </div>
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
        <span key={c.path} class="chip-ctx" title={c.path}>
          <span class="n">
            {fileIcon(c.type)} {c.path}
            {c.type === "dir" ? "/" : ""}
          </span>
          <button type="button" title="Remove" aria-label={`Remove ${c.path}`} onClick={() => remove(c.path)}>
            ×
          </button>
        </span>
      ))}
      {attachments.value.map((a, i) => (
        <span key={`a${i}`} class="chip-ctx" title={a.name}>
          <span class="n">
            📎 {a.name} · {fmtSize(a.size)}
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
  next.set(item.path, { path: item.path, type: item.type });
  contextPaths.value = next;
}
function toggleContext(item: ContextItem) {
  const next = new Map(contextPaths.value);
  if (next.has(item.path)) next.delete(item.path);
  else next.set(item.path, { path: item.path, type: item.type });
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
function Team({ p, roles }: { p: PatternInfo; roles: Record<string, RoleValue[]> }) {
  return (
    <div class="team">
      {p.roles.map((role) => {
        const selected = roles[role.id] ?? [];
        return (
          <div class="role" key={role.id}>
            <div>
              <div class="rl">
                {role.label}
                {role.multiple ? <span class="rd"> · pick several</span> : null}
              </div>
              <div class="rd">{role.description}</div>
            </div>
            <div class="role-pick">
              <div class="pills">
                {agents.value.map((a) => {
                  const on = selected.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      class="pill"
                      aria-pressed={on}
                      disabled={!a.available}
                      title={a.available ? `${role.multiple ? "Toggle" : "Choose"} ${a.displayName}` : `${a.displayName} isn't installed`}
                      onClick={() => setRoles(p.id, role.id, role.multiple ? (on ? selected.filter((x) => x !== a.id) : [...selected, a.id]) : [a.id])}
                    >
                      <span class={`agent ${a.id}`}>{a.displayName}</span>
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
              {selected.some((id) => id !== "auto") ? (
                <RoleModels p={p} roleId={role.id} roleLabel={role.label.toLowerCase()} agents={selected.filter((id): id is AgentId => id !== "auto")} />
              ) : null}
            </div>
          </div>
        );
      })}
      <div class="team-summary">
        <span>▶</span>
        <span>{teamSentence(p, roles)}</span>
      </div>
    </div>
  );
}

/** What agents may do while building, from least to most. */
const TRUST = {
  safe: { label: "Safe", help: "Edit files only. Claude can't run commands; Codex stays sandboxed." },
  standard: { label: "Standard", help: "Edit files and run common build/test commands (npm, node, pytest, uv, poetry, cargo, go, make…)." },
  trusted: { label: "Trusted", help: "Any command for Claude; network access inside Codex's sandbox. Use on repos you trust." },
  full: {
    label: "Full access",
    help: "Every agent can run any command, use the network and change files outside its worktree, with your credentials. Only for repos and tasks you trust completely.",
  },
} as const;

/** What the team will do, in one sentence; `checkpoints: false` leaves out plan approval (sweeps don't pause). */
export function teamSentence(p: PatternInfo, roles: Record<string, RoleValue[]>, checkpoints = true): string {
  const one = (r: string) => (roles[r]?.[0] ? SHORT[roles[r]![0]!] : "—");
  const many = (r: string) => {
    const n = (roles[r] ?? []).map((id) => SHORT[id]);
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
      return `${one("agent")} works on it in its own branch; reply to keep going, like a chat${check ? ` · code-flow runs “${check}” after every turn` : ""}`;
    case "loop": {
      const w = roles.workers ?? [];
      const handoff = w.length > 1 ? `, handing over to ${w.slice(1).map((id) => SHORT[id]).join(", then ")} if stuck` : "";
      return `${w.length ? SHORT[w[0]!] : "—"} fixes and code-flow re-runs “${check || "your check"}” until it passes${handoff} (max ${opts.maxRounds} rounds)`;
    }
    default:
      return p.summary;
  }
}

function configSummary(config: Record<string, any>): string {
  const parts = [
    config.check && `check “${config.check}”`,
    config.setup && `setup “${config.setup}”`,
    config.copy?.length && `copies ${config.copy.join(", ")}`,
    config.run?.command && `runs the app with “${config.run.command}”`,
    config.trust && `${config.trust} permissions`,
  ].filter(Boolean);
  return parts.length ? `: ${parts.join(" · ")}` : "";
}

/**
 * Model and effort for each agent in a role, right under its pills (e.g. Opus to plan, Sonnet to
 * review). Empty means the agent's own setting from Settings, or the CLI's default.
 */
function RoleModels({ p, roleId, roleLabel, agents: ids }: { p: PatternInfo; roleId: string; roleLabel: string; agents: AgentId[] }) {
  const current = roleModels.value[p.id]?.[roleId] ?? {};
  return (
    <div class="role-models">
      {ids.map((id) => {
        const cat = catalogs.value[id];
        if (!cat) return null; // still loading
        if ("error" in cat) {
          return (
            <span key={id} class="mpick off">
              <AgentTag id={id} /> <span class="help">CLI defaults</span>
            </span>
          );
        }
        const c = cat as ModelCatalog;
        const s = current[id] ?? {};
        const base = agentSettings.value[id] ?? {};
        const labelOf = (mid?: string) => c.models.find((m) => m.id === mid)?.label ?? mid;
        const baseModel = base.model || c.defaultModel;
        const model = c.models.find((m) => m.id === (s.model || base.model));
        const efforts = model?.efforts?.length ? model.efforts : c.efforts;
        const baseEffort = base.effort || model?.defaultEffort || c.defaultEffort;
        return (
          <span key={id} class="mpick">
            <AgentTag id={id} />
            <select
              aria-label={`${SHORT[id]} model for the ${roleLabel}`}
              value={s.model ?? ""}
              onChange={(e) => {
                const next = e.currentTarget.value;
                const nextModel = c.models.find((m) => m.id === (next || base.model));
                const allowed = nextModel?.efforts?.length ? nextModel.efforts : c.efforts;
                setRoleModel(p.id, roleId, id, { model: next, effort: s.effort && allowed.includes(s.effort) ? s.effort : "" });
              }}
            >
              <option value="">{baseModel ? `Default · ${labelOf(baseModel)}` : "Default model"}</option>
              {c.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {s.model && !c.models.some((m) => m.id === s.model) ? <option value={s.model}>{s.model}</option> : null}
            </select>
            <span class="sep" aria-hidden="true" />
            <select aria-label={`${SHORT[id]} effort for the ${roleLabel}`} value={s.effort ?? ""} onChange={(e) => setRoleModel(p.id, roleId, id, { effort: e.currentTarget.value })}>
              <option value="">{baseEffort ? `Default · ${baseEffort}` : "Default effort"}</option>
              {efforts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- settings
function Settings({ p, roles }: { p: PatternInfo; roles: Record<string, RoleValue[]> }) {
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
  return (
    <details class="settings">
      <summary>
        <span class="st">Settings</span>
        <span class="ss">
          from {baseLabel} · {models.length ? models.join(", ") : "default models"} · stops after {limits.value.maxMinutes} min or {limits.value.maxSteps} steps
          {trust.value === "full" ? <span class="full-access"> · ⚠ full access</span> : null}
        </span>
      </summary>
      <div class="settings-body">
        <div class="settings-grid">
          <div>
            <label class="lbl" for="baseRef">
              Start from branch
            </label>
            <select class="field" id="baseRef" value={baseRef.value} disabled={!!fromPr} title={fromPr ? `Runs from a PR start from the PR's branch (${fromPr.headRefName})` : undefined} onChange={(e) => (baseRef.value = e.currentTarget.value)}>
              <option value="">{info?.current ? `Current HEAD (${info.current})` : "Current HEAD"}</option>
              {(
                [
                  ["local", "Branches"],
                  ["run", "Results of earlier runs"],
                  ["remote", "Remote branches"],
                ] as const
              ).map(([kind, label]) => {
                const items = info?.branches.filter((b) => b.kind === kind) ?? [];
                return items.length ? (
                  <optgroup key={kind} label={label}>
                    {items.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name} · {b.updated}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </div>
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
                <input class="field" type="number" id={`opt-${o.id}`} min={o.min} max={o.max} value={String(opts[o.id])} onInput={(e) => setOption(p, o.id, Number(e.currentTarget.value))} />
              )}
            </div>
          ))}
        </div>
        <div>
          <span class="lbl">Limits — the run stops when it reaches either</span>
          <div class="settings-grid">
            <div>
              <label class="lbl" for="maxMinutes">
                Minutes
              </label>
              <input class="field" type="number" id="maxMinutes" min={1} max={720} value={String(limits.value.maxMinutes)} onInput={(e) => setLimits({ maxMinutes: Number(e.currentTarget.value) || 60 })} />
            </div>
            <div>
              <label class="lbl" for="maxSteps">
                Agent steps
              </label>
              <input class="field" type="number" id="maxSteps" min={1} max={200} value={String(limits.value.maxSteps)} onInput={(e) => setLimits({ maxSteps: Number(e.currentTarget.value) || 40 })} />
            </div>
            <div><label class="lbl" for="maxTokens">Reported token ceiling</label><input class="field" id="maxTokens" type="number" min={1} placeholder="Optional" value={limits.value.maxTokens ?? ""} onInput={(event) => setLimits({ maxTokens: Number(event.currentTarget.value) || undefined })} /></div>
            <div><label class="lbl" for="maxCostUsd">Reported API-equivalent ceiling ($)</label><input class="field" id="maxCostUsd" type="number" min={0.001} step={0.01} placeholder="Optional" value={limits.value.maxCostUsd ?? ""} onInput={(event) => setLimits({ maxCostUsd: Number(event.currentTarget.value) || undefined })} /></div>
            <div>
              <label class="lbl" for="setupCmd">
                Setup each worktree
              </label>
              <input class="field mono" id="setupCmd" placeholder="optional, e.g. npm ci" spellcheck={false} autocomplete="off" value={setupCmd.value} onInput={(e) => setSetup(e.currentTarget.value)} />
            </div>
          </div>
          <div class="help">Ceilings use reported usage; they cannot count missing provider data and are checked between operations. API-equivalent cost is not your subscription bill. Work done before a limit is kept on its branch. Setup runs once in every new worktree before the agents start.</div>
        </div>
        <div>
          <span class="lbl">What agents may do while building</span>
          <div class="segmented" role="radiogroup" aria-label="Agent permissions">
            {(Object.keys(TRUST) as (keyof typeof TRUST)[]).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={trust.value === value}
                class={`${trust.value === value ? "on" : ""} ${value === "full" ? "full" : ""}`}
                title={TRUST[value].help}
                onClick={() => setTrust(value)}
              >
                {TRUST[value].label}
              </button>
            ))}
          </div>
          {trust.value === "full" ? (
            <div class="full-warn" role="alert">
              <b>⚠ Full access: no sandbox.</b> {TRUST.full.help} Automations and sweeps run with Trusted instead, and fixes for watched pull requests with Standard.
            </div>
          ) : (
            <div class="help">
              {TRUST[trust.value].help} Antigravity always runs with its sandbox (writes stay in the worktree). code-flow never merges or pushes on its own.
            </div>
          )}
        </div>
        <div>
          <span class="lbl">Models &amp; effort</span>
          {Object.keys(catalogs.value).length ? (
            [...agents.value]
              .filter((a) => a.available)
              .sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)))
              .map((a) => <ModelRow key={a.id} agent={a} used={used.has(a.id)} />)
          ) : (
            <div class="help">Loading models…</div>
          )}
        </div>
        {info ? <div class="help">Each run works in git worktrees under {info.worktreeRoot}/ — your checkout is never touched.</div> : null}
      </div>
    </details>
  );
}

function ModelRow({ agent, used }: { agent: AgentInfo; used: boolean }) {
  const cat = catalogs.value[agent.id];
  const s = agentSettings.value[agent.id] ?? {};
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
      <select
        class="field"
        aria-label={`${agent.displayName} model`}
        value={custom ? "__custom" : s.model ?? ""}
        onChange={(e) => {
          const v = e.currentTarget.value;
          setCustom(v === "__custom");
          const next = v === "__custom" ? "" : v;
          const nextModel = catalog.models.find((m) => m.id === next);
          const allowed = nextModel?.efforts?.length ? nextModel.efforts : catalog.efforts;
          setAgentSetting(agent.id, { model: next, effort: s.effort && allowed.includes(s.effort) ? s.effort : "" });
        }}
      >
        <option value="">{catalog.defaultModel ? `Default (${catalog.defaultModel})` : "Default model"}</option>
        {catalog.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {catalog.allowCustom ? <option value="__custom">Other…</option> : null}
      </select>
      <select class="field" aria-label={`${agent.displayName} effort`} value={s.effort ?? ""} onChange={(e) => setAgentSetting(agent.id, { effort: e.currentTarget.value })}>
        <option value="">{fallbackEffort ? `Default (${fallbackEffort})` : "Default effort"}</option>
        {efforts.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      {custom ? (
        <input class="field custom" type="text" placeholder="model id or alias" aria-label={`${agent.displayName} custom model`} value={s.model ?? ""} onInput={(e) => setAgentSetting(agent.id, { model: e.currentTarget.value.trim() })} />
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

  useEffect(() => {
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
        setEntries(d.entries);
        setTruncated(d.truncated);
        setMessage("");
      })
      .catch((err) => setMessage((err as Error).message));
  }, [root]);

  useEffect(() => {
    const q = query.trim();
    if (!q || !root) return setResults(null);
    const timer = setTimeout(async () => {
      try {
        setResults(await api<TreeEntry[]>(`/api/search?repo=${enc(root)}&q=${enc(q)}`));
      } catch (err) {
        setMessage((err as Error).message);
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
        {results
          ? results.length
            ? results.map((r) => <TreeNode key={r.path} entry={r} depth={0} sub={r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : ""} root={root} onOpen={onOpen} context={inComposer} />)
            : <div class="tree-empty">No matching files</div>
          : entries?.map((e) => <TreeNode key={e.path} entry={e} depth={0} root={root} onOpen={onOpen} context={inComposer} />)}
        {!results && truncated ? <div class="tree-empty">Showing the first 1000 — use search</div> : null}
      </div>
      {inComposer ? (
        <div class="files-foot">
          Click a file to read it; <b>+</b> or drag adds it to the task. <b style="color:var(--warn)">M</b> changed · <b style="color:var(--ok)">U</b> new
        </div>
      ) : null}
    </>
  );
}

function TreeNode({ entry, depth, sub, root, onOpen, context }: { entry: TreeEntry; depth: number; sub?: string; root: string; onOpen: (path: string) => void; context: boolean }) {
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const added = context && contextPaths.value.has(entry.path);
  const statusName = entry.status ? ({ M: "changed", U: "new, not committed", A: "added" } as const)[entry.status] : "";
  const toggle = async () => {
    if (entry.type !== "dir") return onOpen(entry.path);
    if (open) return setOpen(false);
    setOpen(true);
    if (children) return;
    setMessage("Loading…");
    try {
      const d = await api<{ entries: TreeEntry[] }>(`/api/tree?repo=${enc(root)}&path=${enc(entry.path)}`);
      setChildren(d.entries);
      setMessage(d.entries.length ? "" : "Empty folder");
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  return (
    <div>
      <div
        class={`node ${added ? "added" : ""}`}
        draggable={context}
        title={`${entry.path}${statusName ? ` — ${statusName}` : ""}${context ? "\nDrag into the task, or click +" : ""}`}
        style={`padding-left:${2 + depth * 14}px`}
        onClick={toggle}
        onDblClick={() => context && entry.type === "file" && addContext(entry)}
        onDragStart={(e) => {
          e.dataTransfer!.setData(DRAG_TYPE, JSON.stringify({ path: entry.path, type: entry.type }));
          e.dataTransfer!.setData("text/plain", entry.path);
          e.dataTransfer!.effectAllowed = "copy";
          e.currentTarget.classList.add("dragging");
        }}
        onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
      >
        <span class="tw">{entry.type === "dir" ? (open ? "▼" : "▶") : ""}</span>
        <span class={`lb ${entry.type}`}>
          {fileIcon(entry.type)} {entry.name}
        </span>
        {sub ? <span class="sub">{sub}</span> : null}
        <span class={`st ${entry.status ?? ""}`}>{entry.status ?? ""}</span>
        {context ? (
          <button
            type="button"
            class="add"
            title={`Add ${entry.path} to the task`}
            aria-label={`Add ${entry.path} to the task`}
            onClick={(e) => {
              e.stopPropagation();
              toggleContext(entry);
            }}
          >
            +
          </button>
        ) : null}
      </div>
      {open ? (
        <div>
          {message ? (
            <div class="tree-empty" style={`padding-left:${22 + depth * 14}px`}>
              {message}
            </div>
          ) : null}
          {children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} root={root} onOpen={onOpen} context={context} />)}
        </div>
      ) : null}
    </div>
  );
}
