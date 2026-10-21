import { confirmAction } from "./confirm-state.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { HostControl, newProjectDraft } from "./ssh-projects.js";
import { useDialog } from "./app.js";
import { Icon } from "./icons.js";
import { api, baseName, post, showToast } from "./lib.js";
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
  inScope,
  loadProjects,
  needsYou,
  pickerChoose,
  pickerOpen,
  projectFor,
  projectEdit,
  projects,
  projectsOpen,
  repo,
  runs,
  selectProject,
} from "./state.js";
import type { Project, RepoInfo, RunSummary } from "./types.js";

const byName = (list: Project[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
const reposText = (p: Project) => (p.repos.length ? p.repos.map(baseName).join(", ") : "no repositories yet");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Shortened from the left: the end of a path tells repos apart. The marks keep its slashes where they belong. */
const Tail = ({ text }: { text: string }) => <span class="pr-path">{`\u200E${text}\u200E`}</span>;

/**
 * The project picker, where its choice is used: in the composer it names the project the run
 * goes in (the repo's own, while you haven't picked one); on Insights and Automations, what they show.
 */
export function ProjectButton({ composer = false }: { composer?: boolean }) {
  const p = composer ? projects.value.find(item => item.id === composerProject.value) : activeProject.value;
  const label = composer ? p?.name ?? "Choose project" : p ? p.name : currentProject.value === NONE ? "Unassigned" : "All projects";
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
  const all = [...runs.value.values()];
  const counts = (scope: string) => {
    const list = all.filter((r) => inScope(r, scope));
    return { runs: list.filter((r) => !r.archived).length, archived: list.filter((r) => r.archived).length, waiting: list.filter(needsYou).length };
  };
  const choose = async (id: string) => {
    if (projectPickerPurpose.value === "composer") await openComposer(id);
    else selectProject(id);
    close();
  };
  const row = (id: string, name: string, detail: string, p?: Project) => {
    const c = counts(id);
    const on = (projectPickerPurpose.value === "composer" ? composerProject.value : currentProject.value) === id;
    return (
      <div key={id || "all"} class={`project-row ${on ? "on" : ""}`} role="listitem">
        <button type="button" class="pr-main" aria-current={on ? "true" : undefined} onClick={() => choose(id)}>
          <span class="pr-name">
            {name}
            {c.waiting ? (
              <span class="count" title={`${plural(c.waiting, "run")} need you`}>
                {c.waiting}
              </span>
            ) : null}
          </span>
          <span class="pr-detail">
            {detail} · {plural(c.runs, "run")}
            {c.archived ? ` (+${c.archived} archived)` : ""}
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
            <div class="picker-list" role="list">
              {row(ALL, projectPickerPurpose.value === "composer" ? "Unassigned draft" : "All projects", projectPickerPurpose.value === "composer" ? "Recover a draft that needs a destination" : "show all projects on this computer")}
              {byName(projects.value).map((p) => row(p.id, p.name, reposText(p), p))}
              {projectPickerPurpose.value !== "composer" && (orphans.runs || orphans.archived) ? row(NONE, "Unassigned", "runs whose project was deleted") : null}
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inProject = project ? [...runs.value.values()].filter((r) => projectFor(r)?.id === project.id) : [];
  const leaving = project ? project.repos.filter((r) => !repos.includes(r) && inProject.some((run) => run.repo === r)) : [];

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const saved = await post<Project>(project ? `/api/projects/${project.id}` : "/api/projects", { name, repos });
      await loadProjects();
      if (project) return onDone();
      if (projectPickerPurpose.value === "composer") await openComposer(saved.id);
      else route.value = { view: "project", id: saved.id };
      onCreated();
      showToast(`Created the project ${saved.name}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!project) return;
    if (!await confirmAction(`Delete the project “${project.name}”? ${inProject.length ? `Its ${plural(inProject.length, "run")} stay, in no project.` : "It has no runs."}`, {"title":"Delete this project?","confirmLabel":"Delete project","danger":true})) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      await loadProjects();
      showToast(`Deleted the project ${project.name}`);
      onDone();
    } catch (err) {
      setError((err as Error).message);
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
        <div class="help">{project ? `${plural(inProject.length, "run")} in this project.` : "Name it and add the repositories its runs work in."}</div>
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
        <button type="button" class="btn primary" disabled={busy || !name.trim()} onClick={save}>
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
          <div class="help">The run, its branches and its worktrees stay where they are; only the project it's listed under changes.</div>
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
  pickerChoose.value = { title: "Open repository", choose: path => { void pickRepo(path, project ?? ""); } };
  pickerOpen.value = true;
}

export function RepositoryChoiceDialog() {
  const choice = repositoryChoice.value!;
  const [name, setName] = useState(baseName(choice.repository).slice(0, 60));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const close = () => { if (!busy) repositoryChoice.value = null; };
  const ref = useDialog(true, close);
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
