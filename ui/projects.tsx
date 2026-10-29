import { automations, automationProject, loadAutomations } from "./automation-state.js";
import { confirmAction } from "./confirm-state.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { HostControl, newProjectDraft } from "./ssh-projects.js";
import { useDialog } from "./app.js";
import { Icon } from "./icons.js";
import { api, ApiError, baseName, post, showToast, showError, plural } from "./lib.js";
import {
  ALL,
  composerProject,
  composerLoading,
  openComposer,
  chooseComposerRepository,
  projectPickerPurpose,
  repositoryChoice,
  pickRepo,
  route,
  NONE,
  activeProject,
  currentProject,
  loadProjects,
  discardProjectDraft,
  pickerChoose,
  pickerOpen,
  projectFor,
  projectEdit,
  projects,
  projectsLoaded,
  projectsStatus,
  projectsOpen,
  repo,
  projectCounts,
  projectCountsError,
  refreshProjectCounts,
  selectProject,
} from "./state.js";
import type { Project, RepoInfo, RunSummary } from "./types.js";

const byName = (list: Project[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
const reposText = (p: Project) => (p.repos.length ? p.repos.map(baseName).join(", ") : "no repositories yet");
/** Shortened from the left: the end of a path tells repos apart. The marks keep its slashes where they belong. */
const Tail = ({ text }: { text: string }) => <span class="pr-path">{`\u200E${text}\u200E`}</span>;

export function ProjectsPage() {
  return <div class="project-page projects-page">
    <header class="page-head"><div><h1>Projects</h1><p>Choose a project, describe a task, and review the result.</p></div><button class="btn primary" onClick={() => { projectEdit.value = "new"; projectsOpen.value = true; }}>New project</button></header>
    {!projectsLoaded.value ? <p role="status">Loading projects…</p> : !projectsStatus.value.available ? <p role="alert">Projects couldn’t be loaded. <button class="btn" onClick={() => void loadProjects()}>Try again</button></p> : projects.value.length ? <div class="projects-grid">{byName(projects.value).map(project => <article class="pp-card" key={project.id}>
      <h2><a href={`#/project/${encodeURIComponent(project.id)}`}>{project.name}</a></h2><p class="help">{reposText(project)}</p>
      <div class="settings-actions"><button class="btn primary" disabled={composerLoading.value} onClick={() => void openComposer(project.id)}>Describe a task</button><a class="btn" href={`#/project/${encodeURIComponent(project.id)}/runs`}>View results</a></div>
    </article>)}</div> : <section class="pp-card"><h2>Your first project</h2><p>Create a project and add its repository to start a task.</p></section>}
  </div>;
}

/**
 * The project picker, where its choice is used: in the composer it names the project the run
 * goes in (the repo's own, while you haven't picked one); on Insights and Automations, what they show.
 */
export function ProjectButton({ composer = false }: { composer?: boolean }) {
  const p = composer ? projects.value.find(item => item.id === composerProject.value) : activeProject.value;
  const label = composer ? p?.name ?? "Choose project" : p ? p.name : currentProject.value === NONE ? "Without a project" : "All projects";
  return (
    <button type="button" class="repo-btn project-btn" disabled={composerLoading.value} title={composer ? "Choose the project's saved draft" : "Filter projects"} onClick={() => { projectPickerPurpose.value = composer ? "composer" : "filter"; projectsOpen.value = true; }}>
      <Icon name="project" />
      <span class="name">{label}</span>
      <Icon name="chevron" class="caret" />
    </button>
  );
}

/** Switch projects, and create, rename, re-scope or delete them. */
export function ProjectsDialog() {
  const close = () => {
    projectsOpen.value = false;
    projectEdit.value = null;
  };
  const ref = useDialog(true, close);
  // Opened from a project's menu in the sidebar (or its "new project" button): straight to the editor, and done when it is.
  const [direct] = useState<Project | "new" | null>(() => (projectEdit.value === "new" ? "new" : projects.value.find((p) => p.id === projectEdit.value) ?? null));
  const [editing, setEditing] = useState<Project | "new" | null>(direct);
  const doneEditing = () => (direct ? close() : setEditing(null));
  useEffect(() => { void refreshProjectCounts().catch(() => {}); }, []);
  const counts = (scope: string) => projectCounts.value?.[scope];
  const choose = async (id: string) => {
    if (projectPickerPurpose.value === "composer") await openComposer(id, { carryUnassigned: !!composerProject.value && !projects.value.some(item => item.id === composerProject.value) });
    else selectProject(id);
    close();
  };
  const row = (id: string, name: string, detail: string, p?: Project) => {
    const draftRow = projectPickerPurpose.value === "composer" && id === ALL;
    const c = draftRow ? undefined : counts(id);
    const on = (projectPickerPurpose.value === "composer" ? composerProject.value : currentProject.value) === id;
    return (
      <div key={id || "all"} class={`project-row ${on ? "on" : ""}`} role="listitem">
        <button type="button" class="pr-main" aria-current={on ? "true" : undefined} onClick={() => choose(id)}>
          <span class="pr-name">
            {name}
            {c?.waiting ? (
              <span class="count" title={`${plural(c.waiting, "run")} ${c.waiting === 1 ? "needs" : "need"} you`}>
                {c.waiting}
              </span>
            ) : null}
          </span>
          <span class="pr-detail">
            {detail}{draftRow ? "" : c ? ` · ${plural(c.live, "run")}${c.archived ? ` (+${c.archived} archived)` : ""}` : " · Counts unavailable"}
          </span>
        </button>
        {p ? (
          <button type="button" class="btn ghost small" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
            Edit
          </button>
        ) : null}
      </div>
    );
  };
  const orphans = counts(NONE);
  const orphanAutomations = automations.value.filter(a => !automationProject(a.run)).length;
  useEffect(() => { void loadAutomations(); }, []);
  return (
    <dialog class="picker small-dialog projects-dialog" ref={ref} aria-labelledby="projects-title">
      <div class="picker-inner">
        {editing ? (
          <ProjectEditor key={editing === "new" ? "new" : editing.id} project={editing === "new" ? undefined : editing} onDone={doneEditing} onCreated={close} />
        ) : (
          <>
            <div class="picker-head">
              <h3 id="projects-title">Projects</h3>
              <div class="help">{projectPickerPurpose.value === "composer" ? "Open a project's saved draft. Each project keeps its own task and run options." : "Choose which projects these lists show. Your saved run draft keeps its own destination."}</div>
            </div>
            {projectCountsError.value ? <p class="msg err" role="alert">Counts unavailable: {projectCountsError.value} <button class="btn small" onClick={() => void refreshProjectCounts().catch(() => {})}>Retry counts</button></p> : null}
            <div class="picker-list" role="list">
              {row(ALL, projectPickerPurpose.value === "composer" ? "Unassigned draft" : "All projects", projectPickerPurpose.value === "composer" ? "Recover a draft that needs a destination" : "show all projects on this computer")}
              {byName(projects.value).map((p) => row(p.id, p.name, reposText(p), p))}
              {projectPickerPurpose.value !== "composer" && (orphans?.live || orphans?.archived || orphanAutomations || currentProject.value === NONE) ? row(NONE, "Without a project", `${orphanAutomations} automation${orphanAutomations === 1 ? "" : "s"} without a project`) : null}
            </div>
            <div class="picker-foot">
              <span class="ps">{projects.value.length ? null : "Open a repository to create your first project."}</span>
              <button class="btn" type="button" onClick={() => setEditing("new")}>
                <Icon name="plus" /> New project
              </button>
              <button class="btn primary" type="button" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

function ProjectEditor({ project, onDone, onCreated }: { project?: Project; onDone: () => void; onCreated: () => void }) {
  const [draft] = useState(() => { const value = newProjectDraft.value; newProjectDraft.value = null; return value; });
  const [name, setName] = useState(project?.name ?? draft?.name ?? "");
  // The form replaces the list inside an open dialog, so autofocus alone wouldn't reach it.
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => nameField.current?.focus(), []);
  const [repos, setRepos] = useState<string[]>(project?.repos ?? []);
  const [revision, setRevision] = useState(project?.revision ?? 0);
  const [conflict, setConflict] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const counts = project ? projectCounts.value?.[project.id] : undefined;
  const total = counts ? counts.live + counts.archived : undefined;
  const leaving = project ? project.repos.filter(r => !repos.includes(r) && (!counts || counts.repositories[r])) : [];

  const save = async () => {
    if (busy || conflict || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const saved = await post<Project>(project ? `/api/projects/${project.id}` : "/api/projects", { name, repos, ...(project ? { revision } : {}) });
      await loadProjects();
      if (project) return onDone();
      if (projectPickerPurpose.value === "composer") await openComposer(saved.id);
      else route.value = { view: "project", id: saved.id };
      onCreated();
      showToast(`Created the project ${saved.name}`);
    } catch (err) {
      if (project && err instanceof ApiError && err.status === 409) {
        await loadProjects(); setConflict(projects.value.find(item => item.id === project.id) ?? null);
      }
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!project || busy) return;
    let count: number;
    try { const latest = (await refreshProjectCounts())[project.id]; if (!latest) throw new Error("Project counts are unavailable; retry before deleting"); count = latest.live + latest.archived; }
    catch (error) { setError((error as Error).message); return; }
    // Deleting archives the project's missions (see ProjectTeams.releaseProject), so name them first.
    const missions = await api<{ teams: { name: string; projectId: string; status: string }[] }>(`/api/project-teams?project=${encodeURIComponent(project.id)}`).then((data) => data.teams.filter((t) => t.projectId === project.id && t.status !== "archived").map((t) => `“${t.name}”`), () => []);
    await loadAutomations();
    const remaining = automations.value.filter(a => !a.target && automationProject(a.run)?.id === project.id).length;
    const automationWarning = remaining ? ` Its ${plural(remaining, "automation")} ${remaining === 1 ? "remains" : "remain"} saved with the current on/off settings. Future runs fall back to the repository's project (or create one if needed); saved automations will appear under Without a project.` : "";
    const archived = missions.length ? ` Its ${missions.length === 1 ? "mission" : "missions"} ${missions.join(", ")} will be archived: ${missions.length === 1 ? "its" : "their"} mission history and budget records are kept, and results waiting for approval can no longer be approved.` : "";
    if (!await confirmAction(`Delete the project “${project.name}”? ${count ? `${count === 1 ? "Its" : "All"} ${plural(count, "run")}, including archived runs and related chats, will be permanently deleted. This cannot be undone. Stop active runs before deleting. Git branches, worktrees and repository files are kept.` : "It has no runs."} Its saved draft and draft attachments will also be deleted.${archived}${automationWarning}`, {"title":"Delete this project?","confirmLabel":"Delete project","danger":true})) return;
    setBusy(true); setError("");
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      await discardProjectDraft(project.id);
      await loadProjects();
      showToast(`Deleted the project ${project.name}`);
      projectsOpen.value = false; projectEdit.value = null;
      route.value = { view: "projects" };
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addRepo = () => {
    pickerChoose.value = {
      title: `Add a repository to ${name.trim() || "the project"}`,
      // The repo's root, so a subfolder you picked counts as its repo.
      choose: (path) =>
        api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(path)}`).then(
          (info) => setRepos((list) => (list.includes(info.repo) ? list : [...list, info.repo])),
          () => setError(`${baseName(path)} isn't a git repository`),
        ),
    };
    pickerOpen.value = true;
  };

  return (
    <>
      <div class="picker-head">
        <h3 id="projects-title">{project ? `Edit ${project.name}` : "New project"}</h3>
        <div class="help">{project ? total === undefined ? "Loading project counts…" : `${plural(total, "run")} in this project.` : "Name it and add the repositories its runs work in."}</div>
      </div>
      <div class="dialog-body">
        {!project ? <div class="project-computer"><span class="lbl">Computer</span><HostControl projectName={name} /><p class="help">Choose where this project lives, then add repositories from that computer.</p></div> : null}
        <div>
          <label class="lbl" for="project-name">
            Name
          </label>
          <input
            id="project-name"
            ref={nameField}
            class="field"
            value={name}
            maxLength={60}
            placeholder="e.g. Web app"
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void save())}
          />
        </div>
        <div>
          <div class="lbl">Repositories</div>
          <div class="project-repos">
            {repos.map((r) => (
              <div key={r} class="dir" title={r}>
                <span class="di">
                  <Icon name="folder" />
                </span>
                <span class="dn">{baseName(r)}</span>
                <Tail text={r} />
                <button type="button" class="btn ghost small" aria-label={`Remove ${baseName(r)}`} onClick={() => setRepos(repos.filter((x) => x !== r))}>
                  Remove
                </button>
              </div>
            ))}
            {!repos.length ? <div class="help">Add a repository before starting a run. You can also keep an empty project for shared work.</div> : null}
          </div>
          <button type="button" class="btn ghost small add-repo" onClick={addRepo}>
            <Icon name="plus" /> Add repository…
          </button>
        </div>
        {leaving.length ? <div class="msg warn">Runs already in this project from {leaving.map(baseName).join(", ")} stay in it.</div> : null}
        {conflict ? <div class="msg warn" role="alert"><p>The current project is “{conflict.name}” with {reposText(conflict)}. Your edits are still shown above.</p><button class="btn small" onClick={() => { setName(conflict.name); setRepos(conflict.repos); setRevision(conflict.revision ?? 0); setConflict(null); setError(""); }}>Reload current project</button><p class="help">Reload replaces this form with the saved project so you can review and reapply your changes.</p></div> : null}
        {error ? <div class="msg err">{error}</div> : null}
      </div>
      <div class="picker-foot">
        {project ? (
          <button type="button" class="btn danger" onClick={remove}>
            Delete project
          </button>
        ) : null}
        <span class="ps" />
        <button type="button" class="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="button" class="btn primary" disabled={busy || !!conflict || !name.trim()} onClick={save}>
          {busy ? "Saving…" : project ? "Save" : "Create project"}
        </button>
      </div>
    </>
  );
}

/** Which project the run is in, as a chip that moves it to another one. */
export function ProjectChip({ run }: { run: RunSummary }) {
  const [moving, setMoving] = useState(false);
  const p = projectFor(run);
  return (
    <>
      <button type="button" class="project-chip" title="Move this run to another project" onClick={() => setMoving(true)}>
        <Icon name="project" /> {p ? p.name : "No project"}
      </button>
      {moving ? <MoveDialog run={run} onClose={() => setMoving(false)} /> : null}
    </>
  );
}

function MoveDialog({ run, onClose }: { run: RunSummary; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const current = projectFor(run)?.id;
  const [choice, setChoice] = useState(current ?? "");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = projects.value.find((p) => p.id === choice);
  const newField = useRef<HTMLInputElement>(null);
  useEffect(() => void (choice === "new" && newField.current?.focus()), [choice]);
  const move = async () => {
    setBusy(true);
    setError("");
    try {
      const id = choice === "new" ? (await post<Project>("/api/projects", { name: newName, repos: [run.repo] })).id : choice;
      const moved = await post<Project>(`/api/runs/${run.id}/project`, { project: id });
      await loadProjects();
      showToast(`Moved to ${moved.name}`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog class="picker small-dialog" ref={ref} aria-labelledby="move-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="move-title">Move to another project</h3>
          <div class="help">The conversation and its provider tabs, side chats and team executions move together. Branches and worktrees stay where they are.</div>
        </div>
        <div class="picker-list" role="radiogroup" aria-label="Project">
          {byName(projects.value).map((p) => (
            <label key={p.id} class="dir move-choice">
              <input type="radio" name="move-to" checked={choice === p.id} onChange={() => setChoice(p.id)} />
              <span class="dn">
                {p.name}
                {p.id === current ? <span class="help"> · now</span> : null}
              </span>
              <Tail text={reposText(p)} />
            </label>
          ))}
          <label class="dir move-choice">
            <input type="radio" name="move-to" checked={choice === "new"} onChange={() => setChoice("new")} />
            <span class="dn">New project</span>
            {choice === "new" ? (
              <input ref={newField} class="field" aria-label="New project's name" placeholder="Name" maxLength={60} value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
            ) : null}
          </label>
        </div>
        <div class="picker-foot">
          <span class="ps">
            {error ? <span class="msg err">{error}</span> : chosen && !chosen.repos.includes(run.repo) ? `${baseName(run.repo)} joins ${chosen.name}.` : null}
          </span>
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="btn primary" disabled={busy || !choice || choice === current || (choice === "new" && !newName.trim())} onClick={move}>
            Move
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** The same folder browser serves onboarding and explicit project membership changes. */
export function openRepository(project?: string) {
  pickerChoose.value = { title: "Open repository", choose: path => pickRepo(path, project ?? "") };
  pickerOpen.value = true;
}

/** Repository management adds membership without opening or replacing a composer draft. */
export function addRepositoryToProject(id: string) {
  pickerChoose.value = { title: "Add repository", choose: async path => {
    try {
      const info = await api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(path)}`);
      const project = projects.value.find(item => item.id === id);
      const existing = project?.repos.includes(info.repo);
      await post(`/api/projects/${encodeURIComponent(id)}/repositories`, { repo: info.repo });
      await loadProjects();
      route.value = { view: "project", id, section: "repositories", repository: info.repo, tool: "code" };
      showToast(existing ? `This repository is already in ${project?.name ?? "the project"}` : `Added repository to ${project?.name ?? "the project"}`);
    } catch (error) { showError((error as Error).message, 6000); }
  } };
  pickerOpen.value = true;
}

export function RepositoryChoiceDialog() {
  const choice = repositoryChoice.value!;
  const [name, setName] = useState(baseName(choice.repository).slice(0, 60));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const close = () => { if (!busy) repositoryChoice.value = null; };
  const ref = useDialog(true, close, () => !busy);
  const current = projects.value.find(item => item.id === choice.project);
  const matches = projects.value.filter(item => item.repos.includes(choice.repository));
  const choose = async (id?: string, add = false) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      let project = id;
      if (add && id) await post(`/api/projects/${encodeURIComponent(id)}/repositories`, { repo: choice.repository });
      if (!project) project = (await post<Project>("/api/projects", { name: name.trim(), repos: [choice.repository] })).id;
      await loadProjects();
      if (!await openComposer(project, { repository: choice.repository, carryUnassigned: true })) throw new Error("The project draft could not be opened. Try again.");
      await chooseComposerRepository(choice.repository);
      repositoryChoice.value = null;
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="repository-project-title">
    <div class="picker-inner"><div class="picker-head"><h3 id="repository-project-title">Open repository in a project</h3><p class="help"><code>{choice.repository}</code></p></div>
      <div class="dialog-body">
        {matches.length ? <div class="project-destinations"><p>Choose an existing project:</p>{matches.map(project => <button class="btn" disabled={busy} onClick={() => void choose(project.id)}>Open {project.name}</button>)}</div> : null}
        {current && !current.repos.includes(choice.repository) ? <div class="project-destinations"><button class="btn" disabled={busy} onClick={() => void choose(current.id, true)}>Add to {current.name}</button><p class="help">This repository becomes part of the project. Existing project access rules apply.</p></div> : null}
        <label class="lbl" for="repository-project-name">New project name</label><input id="repository-project-name" class="field" maxLength={60} value={name} disabled={busy} onInput={event => setName(event.currentTarget.value)} />
        <p class="help">The project keeps its own draft and run history. No agent starts until you select Start run.</p>
        {error ? <p class="msg err" role="alert">{error}</p> : null}
      </div><div class="picker-foot"><button class="btn" disabled={busy} onClick={close}>Cancel</button><button class="btn primary" disabled={busy || !name.trim()} onClick={() => void choose()}>{busy ? "Opening…" : "Create project"}</button></div>
    </div>
  </dialog>;
}
