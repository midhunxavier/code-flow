import { useEffect, useState } from "preact/hooks";
import { api, enc, store } from "./lib.js";
import { checkCmd, setupCmd, repo, pattern } from "./state.js";
import { ComposerLibraryEditor, RepositoryReadiness } from "./onboarding.js";
import { readProjectDefaults, saveProjectDefaults, type ProjectRunDefaults } from "./project-defaults.js";
import { ProjectMemory } from "./memory.js";

export function ProjectRunSettings({ projectId, repositories }: { projectId?: string; repositories: string[] }) {
  const [selected, setSelected] = useState("");
  const repository = repositories.includes(selected) ? selected : repositories.includes(repo.value) ? repo.value : repositories[0] ?? "";
  const [scope, setScope] = useState("project");
  const libraryKey = projectId && scope === "project" ? `composerLibrary:${projectId}` : "composerLibrary";
  return <section class="project-run-settings" aria-label="Project run defaults">
    <h2>Run defaults</h2>
    <p class="help">Configure each repository once. New runs inherit these defaults; run options can override them. These preferences are saved in this browser for the current workspace.</p>
    {repositories.length > 1 ? <label class="lbl">Repository<select class="field" aria-label="Project settings repository" value={repository} onChange={(event) => setSelected(event.currentTarget.value)}>{repositories.map((path) => <option key={path} value={path}>{path}</option>)}</select></label> : null}
    {repository ? <RepositoryRunDefaults key={repository} repository={repository} /> : <p class="help">Add a repository to configure its defaults.</p>}
    {pattern.value ? <><h2>Template library</h2><p class="help">Use the Template library in New run for built-in tasks, saved workflows and complete run templates. Manage imports and older workflow revisions below.</p>{projectId ? <label class="lbl">Library<select class="field" aria-label="Library scope" value={scope} onChange={(event) => setScope(event.currentTarget.value)}><option value="project">This project</option><option value="personal">Personal library (all projects)</option></select></label> : null}<ComposerLibraryEditor key={libraryKey} libraryKey={libraryKey} p={pattern.value} /></> : null}
    {projectId && repository ? <ProjectMemory key={`${projectId}:${repository}`} projectId={projectId} repo={repository} /> : null}
  </section>;
}

function RepositoryRunDefaults({ repository }: { repository: string }) {
  const [defaults, setDefaults] = useState(() => readProjectDefaults(repository));
  const [commands, setCommands] = useState({ check: "", setup: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true; setLoading(true); setError("");
    void Promise.all([
      api<{ config: { check?: string; setup?: string } }>(`/api/repo-config?repo=${enc(repository)}`),
      api<{ command?: string; setup?: string }>(`/api/check?repo=${enc(repository)}`),
    ]).then(([configuration, detected]) => {
      if (alive) setCommands({ check: store.get(`check:${repository}`) ?? configuration.config.check ?? detected.command ?? "", setup: store.get(`setup:${repository}`) ?? configuration.config.setup ?? detected.setup ?? "" });
    }).catch((err) => { if (alive) { setCommands({ check: store.get(`check:${repository}`) ?? "", setup: store.get(`setup:${repository}`) ?? "" }); setError(`Could not load repository defaults: ${err.message}`); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [repository, retry]);
  const change = (value: ProjectRunDefaults) => { setDefaults(value); setSaved(false); };
  const save = () => {
    store.set(`check:${repository}`, commands.check);
    store.set(`setup:${repository}`, commands.setup);
    if (repo.value === repository) { checkCmd.value = commands.check; setupCmd.value = commands.setup; }
    saveProjectDefaults(repository, defaults);
    setSaved(true);
  };
  return <div class="project-default-fields">
    <p class="help mono">{repository}</p>
    <label class="lbl">Default check command<input class="field mono" aria-label="Default check command" disabled={loading} value={commands.check} placeholder="e.g. npm test" onInput={(event) => { setCommands({ ...commands, check: event.currentTarget.value }); setSaved(false); }} /></label>
    <label class="lbl">Worktree setup command<input class="field mono" aria-label="Worktree setup command" disabled={loading} value={commands.setup} placeholder="e.g. npm ci" onInput={(event) => { setCommands({ ...commands, setup: event.currentTarget.value }); setSaved(false); }} /></label>
    <label class="lbl">Default verification profile<select class="field" aria-label="Default verification profile" value={defaults.verification} onChange={(event) => change({ ...defaults, verification: event.currentTarget.value })}><option value="">Single configured check</option><option value="lightweight">Lightweight</option><option value="standard">Standard</option><option value="thorough">Thorough</option></select></label>
    <label class="checkpoint"><input type="checkbox" checked={defaults.container.enabled} onChange={(event) => change({ ...defaults, container: { ...defaults.container, enabled: event.currentTarget.checked } })} /><span>Use Docker isolation by default</span></label>
    {defaults.container.enabled ? <><label class="lbl">Default container image<input class="field mono" aria-label="Default container image" value={defaults.container.image} onInput={(event) => change({ ...defaults, container: { ...defaults.container, image: event.currentTarget.value } })} /></label><label class="lbl">Default authentication volume<input class="field mono" aria-label="Default authentication volume" value={defaults.container.authVolume} onInput={(event) => change({ ...defaults, container: { ...defaults.container, authVolume: event.currentTarget.value } })} /></label><p class="help">Use a prebuilt image with compatible, authenticated provider CLIs. Host credentials are not mounted.</p></> : null}
    <div class="settings-actions"><button class="btn primary" disabled={loading || !!error || (defaults.container.enabled && !defaults.container.image.trim())} onClick={save}>Save project defaults</button>{saved ? <span role="status">Project defaults saved.</span> : null}</div>
    {error ? <div class="msg err" role="alert">{error}<button class="btn" onClick={() => setRetry(retry + 1)}>Retry loading defaults</button></div> : null}
    <RepositoryReadiness repository={repository} setup={commands.setup} check={commands.check} base="" loading={loading} />
  </div>;
}
