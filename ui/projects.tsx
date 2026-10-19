import { useEffect, useRef, useState } from "preact/hooks";
import { HostControl, newProjectDraft } from "./ssh-projects.js";
import { useDialog } from "./app.js";
import { Icon } from "./icons.js";
import { api, baseName, post, showToast } from "./lib.js";
import {
  ALL,
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
  target,
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
  const p = activeProject.value;
  const label = composer ? (p ?? target.value.project)?.name ?? "New project" : p ? p.name : currentProject.value === NONE ? "No project" : "All projects";
  return (
    <button type="button" class="repo-btn project-btn" title="Projects: switch, create or edit (p)" onClick={() => (projectsOpen.value = true)}>
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
  const choose = (id: string) => {
    selectProject(id);
    close();
  };
  const row = (id: string, name: string, detail: string, p?: Project) => {
    const c = counts(id);
    const on = currentProject.value === id;
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
              <div class="help">A project groups the runs in its repositories. New runs start in the project you pick, and Insights and Automations show it.</div>
            </div>
            <div class="picker-list" role="list">
              {row(ALL, "All projects", "new runs go in their repository's project")}
              {byName(projects.value).map((p) => row(p.id, p.name, reposText(p), p))}
              {orphans.runs || orphans.archived ? row(NONE, "No project", "runs whose project was deleted") : null}
            </div>
            <div class="picker-foot">
              <span class="ps">{projects.value.length ? null : "Your first run in a repository makes a project for it."}</span>
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
  const [repos, setRepos] = useState<string[]>(project?.repos ?? (draft ? [] : repo.value ? [repo.value] : []));
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
      selectProject(saved.id);
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
    if (!confirm(`Delete the project “${project.name}”? ${inProject.length ? `Its ${plural(inProject.length, "run")} stay, in no project.` : "It has no runs."}`)) return;
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
            {!repos.length ? <div class="help">None yet: the first run you start in this project adds its repository.</div> : null}
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

/** In the composer: where the run goes, when that isn't simply the project you're in. */
export function ProjectNote() {
  const t = target.value;
  const r = repo.value;
  if (!r) return null;
  const note = t.creates ? (
    <>
      No project holds <b>{baseName(r)}</b> yet: starting the run makes one named after it.
    </>
  ) : t.adds ? (
    <>
      Starting adds <b>{baseName(r)}</b> to the project <b>{t.project!.name}</b>.
    </>
  ) : !activeProject.value && t.project ? (
    <>
      Goes in the project <b>{t.project.name}</b>.
    </>
  ) : null;
  return note ? (
    <div class="config-note project-note">
      <Icon name="project" />
      <span>{note}</span>
    </div>
  ) : null;
}
