import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc, store } from "./lib.js";
import { checkCmd, forgetChoices, setupCmd, repo, pattern, projects, settingsProject } from "./state.js";
import { ComposerLibraryEditor, RepositoryReadiness } from "./onboarding.js";
import { readProjectDefaults, saveProjectDefaults, type ProjectRunDefaults } from "./project-defaults.js";
import { ProjectMemory } from "./memory.js";

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
    <p class="help">Configure each repository once. New runs inherit these defaults; run options can override them. These preferences are saved in this browser for the current workspace.</p>
    {repositories.length > 1 ? <label class="lbl">Repository<select class="field" aria-label="Project settings repository" value={repository} onChange={(event) => setSelected(event.currentTarget.value)}>{repositories.map((path) => <option key={path} value={path}>{path}</option>)}</select></label> : null}
    {repository ? <RepositoryRunDefaults key={repository} repository={repository} projectId={projectId} /> : <p class="help">Add a repository to configure its defaults.</p>}
    {pattern.value ? <><h2>Template library</h2><p class="help">Use the Template library in New run for built-in tasks, saved workflows and complete run templates. Manage imports and older workflow revisions below.</p>{projectId ? <label class="lbl">Library<select class="field" aria-label="Library scope" value={scope} onChange={(event) => setScope(event.currentTarget.value)}><option value="project">This project</option><option value="personal">Personal library (all projects)</option></select></label> : null}<ComposerLibraryEditor key={libraryKey} libraryKey={libraryKey} p={pattern.value} /></> : null}
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
      const remembered = store.get(`check:${repository}`);
      // Commands typed before a retry stay; the repository's values fill the rest.
      if (!edited.current) setCommands({ check: remembered ?? config.check ?? found.command ?? "", setup: store.get(`setup:${repository}`) ?? config.setup ?? found.setup ?? "" });
      if (configuration.status === "rejected") setError(`Could not load repository defaults: ${(configuration.reason as Error).message}`);
      // Detection only suggests a command, so failing to detect one never stops you saving your own.
      if (detected.status === "rejected") setNote(`Couldn't detect a check command: ${(detected.reason as Error).message}. Enter one above.`);
      else if (detected.value.warning && remembered === null && !config.check) setNote(`Detection: ${detected.value.warning}.`);
    }).finally(() => { if (alive && !isPaused()) setLoading(false); });
    return () => { alive = false; };
  }, [repository, retry, paused]);
  const change = (value: ProjectRunDefaults) => { setDefaults(value); setSaved(false); };
  const save = () => {
    store.set(`check:${repository}`, commands.check);
    store.set(`setup:${repository}`, commands.setup);
    // The open draft takes them now; other drafts take them when they open (loadRepoCheck).
    if (repo.value === repository) { checkCmd.value = commands.check; setupCmd.value = commands.setup; forgetChoices(["check", "setup"]); }
    saveProjectDefaults(repository, defaults);
    setSaved(true);
  };
  return <div class="project-default-fields">
    <p class="help mono">{repository}</p>
    {policyProject ? <p class="msg warn" role="status">Repository defaults discovery is paused by filesystem restrictions in {restricted.map(project => `“${project.name}”`).join(", ")}. Your browser defaults remain editable. <a href="#/settings/projects" onClick={() => { if (policyProject.id !== projectId) pendingPolicyReview = { projectId: policyProject.id, repository, commands: { ...commands }, defaults: structuredClone(defaults), edited: edited.current, saved }; settingsProject.value = policyProject.id; }}>Review the filesystem policy</a></p> : null}
    <label class="lbl">Default check command<input class="field mono" aria-label="Default check command" disabled={loading} value={commands.check} placeholder="e.g. npm test" onInput={(event) => { edited.current = true; setCommands({ ...commands, check: event.currentTarget.value }); setSaved(false); }} /></label>
    {note ? <p class="msg warn" role="status">{note}</p> : null}
    <label class="lbl">Worktree setup command<input class="field mono" aria-label="Worktree setup command" disabled={loading} value={commands.setup} placeholder="e.g. npm ci" onInput={(event) => { edited.current = true; setCommands({ ...commands, setup: event.currentTarget.value }); setSaved(false); }} /></label>
    <label class="lbl">Default verification profile<select class="field" aria-label="Default verification profile" value={defaults.verification} onChange={(event) => change({ ...defaults, verification: event.currentTarget.value })}><option value="">Single configured check</option><option value="lightweight">Lightweight</option><option value="standard">Standard</option><option value="thorough">Thorough</option></select></label>
    <label class="checkpoint"><input type="checkbox" checked={defaults.container.enabled} onChange={(event) => change({ ...defaults, container: { ...defaults.container, enabled: event.currentTarget.checked } })} /><span>Use Docker isolation by default</span></label>
    {defaults.container.enabled ? <><label class="lbl">Default container image<input class="field mono" aria-label="Default container image" value={defaults.container.image} onInput={(event) => change({ ...defaults, container: { ...defaults.container, image: event.currentTarget.value } })} /></label><label class="lbl">Default authentication volume<input class="field mono" aria-label="Default authentication volume" value={defaults.container.authVolume} onInput={(event) => change({ ...defaults, container: { ...defaults.container, authVolume: event.currentTarget.value } })} /></label><p class="help">Use a prebuilt image with compatible, authenticated provider CLIs. Host credentials are not mounted.</p></> : null}
    <div class="settings-actions"><button class="btn primary" disabled={loading || (defaults.container.enabled && !defaults.container.image.trim())} onClick={save}>Save project defaults</button>{saved ? <span role="status">Project defaults saved.</span> : null}</div>
    {!paused && error ? <div class="msg err" role="alert">{error}<button class="btn" onClick={() => setRetry(retry + 1)}>Retry loading defaults</button></div> : null}
    <RepositoryReadiness repository={repository} setup={commands.setup} check={commands.check} base="" loading={loading || paused} />
  </div>;
}
