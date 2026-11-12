import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc, store } from "./lib.js";
import { checkCmd, forgetChoices, loadCheck, setupCmd, repo, pattern, projects, settingsProject } from "./state.js";
import { ComposerLibraryEditor, RepositoryReadiness } from "./onboarding.js";
import { readProjectDefaults, saveProjectDefaults, type ProjectRunDefaults } from "./project-defaults.js";
import { ProjectMemory } from "./memory.js";

type CommandOrigin = "config" | "browser" | "detected" | "";
type PolicyReviewDraft = { projectId: string; repository: string; commands: { check: string; setup: string }; defaults: ProjectRunDefaults; edited: boolean; saved: boolean };
// Only the policy-review link transfers unsaved browser fields. Consume the handoff
// once in the destination repository; ordinary project/repository switches do not restore it.
let pendingPolicyReview: PolicyReviewDraft | undefined;

export function ProjectRunSettings({ projectId, repositories }: { projectId?: string; repositories: string[] }) {
  const [selected, setSelected] = useState(() => pendingPolicyReview && pendingPolicyReview.projectId === projectId ? pendingPolicyReview.repository : "");
  const repository = repositories.includes(selected) ? selected : repositories.includes(repo.value) ? repo.value : repositories[0] ?? "";
  const [scope, setScope] = useState("project");
  const libraryKey = projectId && scope === "project" ? `composerLibrary:${projectId}` : "composerLibrary";
  return <section class="project-run-settings" aria-label="Project run defaults">
    <h2>Run defaults</h2>
    <p class="help">Configure each repository once. New runs inherit these defaults; run options can override them. The check and setup commands are saved in the repository’s <code>.codeflow/config.json</code>, so every run and teammate uses the same ones. The verification profile and Docker options are saved in this browser.</p>
    {repositories.length > 1 ? <label class="lbl">Repository<select class="field" aria-label="Project settings repository" value={repository} onChange={(event) => setSelected(event.currentTarget.value)}>{repositories.map((path) => <option key={path} value={path}>{path}</option>)}</select></label> : null}
    {repository ? <RepositoryRunDefaults key={repository} repository={repository} projectId={projectId} /> : <p class="help">Add a repository to configure its defaults.</p>}
    {pattern.value ? <><h2>Browser template library</h2><p class="help">Workflows and task templates saved in this browser. Apply, export or delete them below. Team templates, shared through this computer, are in Workflow run → Advanced.</p>{projectId ? <label class="lbl">Library<select class="field" aria-label="Library scope" value={scope} onChange={(event) => setScope(event.currentTarget.value)}><option value="project">This project</option><option value="personal">Personal library (all projects)</option></select></label> : null}<ComposerLibraryEditor key={libraryKey} libraryKey={libraryKey} p={pattern.value} /></> : null}
    {projectId && repository ? <ProjectMemory key={`${projectId}:${repository}`} projectId={projectId} repo={repository} /> : null}
  </section>;
}

function RepositoryRunDefaults({ repository, projectId }: { repository: string; projectId?: string }) {
  // These endpoints read a repository, so any owning project's restriction applies.
  // Another project's unrelated restriction does not block these two read-only APIs.
  const restricted = projects.value.filter(project => project.filesystemRestricted && project.repos.includes(repository));
  const paused = restricted.length > 0;
  const isPaused = () => projects.peek().some(project => project.filesystemRestricted && project.repos.includes(repository));
  const policyProject = restricted.find(project => project.id === projectId) ?? restricted[0];
  const [reviewDraft] = useState(() => {
    if (!pendingPolicyReview || pendingPolicyReview.projectId !== projectId || pendingPolicyReview.repository !== repository) return undefined;
    const draft = pendingPolicyReview; pendingPolicyReview = undefined; return draft;
  });
  const [defaults, setDefaults] = useState(() => reviewDraft?.defaults ?? readProjectDefaults(repository));
  const [commands, setCommands] = useState(() => reviewDraft?.commands ?? ({ check: store.get(`check:${repository}`) ?? "", setup: store.get(`setup:${repository}`) ?? "" }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(reviewDraft?.saved ?? false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // Where each shown command came from: the repository's file, an older browser setting, or detection.
  const [origin, setOrigin] = useState<{ check: CommandOrigin; setup: CommandOrigin; detectedFrom?: string }>({ check: "", setup: "" });
  // Only a command you typed (or an older browser setting being moved) is written to the file: a detected guess is never saved for you.
  const typed = useRef({ check: false, setup: false });
  const [retry, setRetry] = useState(0);
  const edited = useRef(reviewDraft?.edited ?? false);
  useEffect(() => {
    let alive = true; setError(""); setNote("");
    if (paused) { setLoading(false); return () => { alive = false; }; }
    setLoading(true);
    void Promise.allSettled([
      api<{ config: { check?: string; setup?: string } }>(`/api/repo-config?repo=${enc(repository)}`),
      api<{ command?: string | null; setup?: string; warning?: string }>(`/api/check?repo=${enc(repository)}`),
    ]).then(([configuration, detected]) => {
      if (!alive || isPaused()) return;
      const config = configuration.status === "fulfilled" ? configuration.value.config : {};
      const found = detected.status === "fulfilled" ? detected.value : {};
      // The repository's file comes first. A command saved in this browser by an older version fills in only where the file has none.
      const remembered = store.get(`check:${repository}`) || null, rememberedSetup = store.get(`setup:${repository}`) || null;
      // Commands typed before a retry stay; the repository's values fill the rest.
      if (!edited.current) setCommands({ check: config.check ?? remembered ?? found.command ?? "", setup: config.setup ?? rememberedSetup ?? found.setup ?? "" });
      setOrigin({ check: config.check ? "config" : remembered ? "browser" : found.command ? "detected" : "", setup: config.setup ? "config" : rememberedSetup ? "browser" : found.setup ? "detected" : "", detectedFrom: (found as { source?: string }).source });
      if (configuration.status === "rejected") setError(`Could not load repository defaults: ${(configuration.reason as Error).message}`);
      // Detection only suggests a command, so failing to detect one never stops you saving your own.
      if (detected.status === "rejected") setNote(`Couldn't detect a check command: ${(detected.reason as Error).message}. Enter one above.`);
      else if (detected.value.warning && remembered === null && !config.check) setNote(`Detection: ${detected.value.warning}.`);
    }).finally(() => { if (alive && !isPaused()) setLoading(false); });
    return () => { alive = false; };
  }, [repository, retry, paused]);
  const change = (value: ProjectRunDefaults) => { setDefaults(value); setSaved(false); };
  const save = async () => {
    setSaveError("");
    saveProjectDefaults(repository, defaults);
    // With repository access paused the file can't be written: a typed command waits in this
    // browser, and moves into the file by saving again once access is back.
    if (paused) for (const key of ["check", "setup"] as const) if (typed.current[key]) store.set(`${key}:${repository}`, commands[key]);
    const write = (key: "check" | "setup") => !paused && (typed.current[key] || origin[key] === "browser");
    if (write("check") || write("setup")) {
      setSaving(true);
      try {
        await api(`/api/repo-config`, { method: "PUT", body: JSON.stringify({ repo: repository, ...(write("check") ? { check: commands.check } : {}), ...(write("setup") ? { setup: commands.setup } : {}) }) });
      } catch (err) {
        setSaveError(`Could not save the commands to .codeflow/config.json: ${(err as Error).message}`);
        return;
      } finally { setSaving(false); }
      for (const key of ["check", "setup"] as const) if (write(key)) {
        // The file holds it now, so the older copy in this browser goes.
        store.remove(`${key}:${repository}`);
        typed.current[key] = false;
      }
      setOrigin(current => ({ ...current, ...(write("check") ? { check: commands.check.trim() ? "config" : "" } : {}), ...(write("setup") ? { setup: commands.setup.trim() ? "config" : "" } : {}) }));
      edited.current = false;
      // The open draft takes them now; other drafts take them when they open (loadRepoCheck).
      if (repo.value === repository) { checkCmd.value = commands.check.trim(); setupCmd.value = commands.setup.trim(); forgetChoices(["check", "setup"]); void loadCheck(); }
    }
    setSaved(true);
  };
  const originNote = (key: "check" | "setup") => paused || loading ? null : typed.current[key] ? null
    : origin[key] === "config" ? <p class="help">Saved in <code>.codeflow/config.json</code>.</p>
    : origin[key] === "browser" ? <p class="help">From an older setting saved in this browser. Save to move it into <code>.codeflow/config.json</code>.</p>
    : origin[key] === "detected" ? <p class="help">Detected{origin.detectedFrom ? ` from ${origin.detectedFrom}` : ""}, not saved. Edit it and save to set your own.</p>
    : null;
  return <div class="project-default-fields">
    <p class="help mono">{repository}</p>
    {policyProject ? <p class="msg warn" role="status">Repository defaults discovery is paused by filesystem restrictions in {restricted.map(project => `“${project.name}”`).join(", ")}. Until then, commands you save stay in this browser; save again afterwards to move them into the repository’s file. <a href="#/settings/projects" onClick={() => { if (policyProject.id !== projectId) pendingPolicyReview = { projectId: policyProject.id, repository, commands: { ...commands }, defaults: structuredClone(defaults), edited: edited.current, saved }; settingsProject.value = policyProject.id; }}>Review the filesystem policy</a></p> : null}
    <label class="lbl">Default check command<input class="field mono" aria-label="Default check command" disabled={loading} value={commands.check} placeholder="e.g. npm test" onInput={(event) => { edited.current = true; typed.current.check = true; setCommands({ ...commands, check: event.currentTarget.value }); setSaved(false); }} /></label>
    {originNote("check")}
    {note ? <p class="msg warn" role="status">{note}</p> : null}
    <label class="lbl">Worktree setup command<input class="field mono" aria-label="Worktree setup command" disabled={loading} value={commands.setup} placeholder="e.g. npm ci" onInput={(event) => { edited.current = true; typed.current.setup = true; setCommands({ ...commands, setup: event.currentTarget.value }); setSaved(false); }} /></label>
    {originNote("setup")}
    <label class="lbl">Default verification profile<select class="field" aria-label="Default verification profile" value={defaults.verification} onChange={(event) => change({ ...defaults, verification: event.currentTarget.value })}><option value="">Single configured check</option><option value="lightweight">Lightweight</option><option value="standard">Standard</option><option value="thorough">Thorough</option></select></label>
    <label class="checkpoint"><input type="checkbox" checked={defaults.container.enabled} onChange={(event) => change({ ...defaults, container: { ...defaults.container, enabled: event.currentTarget.checked } })} /><span>Use Docker isolation by default</span></label>
    {defaults.container.enabled ? <><label class="lbl">Default container image<input class="field mono" aria-label="Default container image" value={defaults.container.image} onInput={(event) => change({ ...defaults, container: { ...defaults.container, image: event.currentTarget.value } })} /></label><label class="lbl">Default authentication volume<input class="field mono" aria-label="Default authentication volume" value={defaults.container.authVolume} onInput={(event) => change({ ...defaults, container: { ...defaults.container, authVolume: event.currentTarget.value } })} /></label><p class="help">Use a prebuilt image with compatible, authenticated provider CLIs. Host credentials are not mounted.</p></> : null}
    <div class="settings-actions"><button class="btn primary" disabled={loading || saving || (defaults.container.enabled && !defaults.container.image.trim())} onClick={() => void save()}>Save project defaults</button>{saved ? <span role="status">Project defaults saved.</span> : null}</div>
    {saveError ? <p class="msg err" role="alert">{saveError}</p> : null}
    {!paused && error ? <div class="msg err" role="alert">{error}<button class="btn" onClick={() => setRetry(retry + 1)}>Retry loading defaults</button></div> : null}
    <RepositoryReadiness repository={repository} setup={commands.setup} check={commands.check} base="" loading={loading || paused} />
  </div>;
}
