import { useState } from "preact/hooks";
import { hashFor, AUTOMATION_KINDS } from "./navigation.js";
import { computerLabel } from "./ssh-projects.js";
import { AutomationsView } from "./automations.js";
import { DeferredRunsPanel } from "./deferred-runs.js";
import { ProjectTeamsPanel } from "./project-teams.js";
import { ProjectButton } from "./projects.js";
import { Templates } from "./github.js";
import { activeProject, currentProject, NONE, openComposer, projects, draftsReady, composerLoading } from "./state.js";

const SCHEDULE_DETAILS = [
  { id: "once", label: "Run once later", description: "Start a task at a chosen time or when its providers have capacity." },
  { id: "repeat", label: "Repeat", description: "Run a configured task on a schedule or from a webhook." },
  { id: "backlog", label: "Process a backlog", description: "Choose issues, dependency updates or security alerts, with one run per item." },
  { id: "missions", label: "Pursue a mission", description: "Give agents an ongoing goal and review their proposals and verified drafts." },
] as const;
export const SCHEDULE_KINDS = AUTOMATION_KINDS.map(id => SCHEDULE_DETAILS.find(item => item.id === id)!);
export type ScheduleKind = typeof AUTOMATION_KINDS[number];
export function SchedulingView({ kind = "repeat", projectId }: { kind?: string; projectId?: string }) {
  const selected = SCHEDULE_KINDS.find(item => item.id === kind) ?? SCHEDULE_KINDS[1]!;
  const project = projectId ? projects.value.find(p => p.id === projectId) : activeProject.value;
  const [repository, setRepository] = useState("");
  const chosen = project?.repos.includes(repository) ? repository : project?.repos.length === 1 ? project.repos[0] : "";
  const scope = projectId ?? project?.id;
  const configure = () => openComposer(scope ?? (currentProject.value === NONE ? "" : undefined), chosen ? { repository: chosen } : {});
  if (projectId && !project) return <p role="alert">This project is unavailable. Choose an existing project to manage automation.</p>;
  return <div class="scheduling-hub">
    <nav class="purpose-nav" aria-label="Scheduling purpose">{SCHEDULE_KINDS.map(item => <a class={`btn ${selected.id === item.id ? "primary" : ""}`} href={hashFor(projectId ? { view: "project", id: projectId, section: "automation", kind: item.id } : { view: "automations", kind: item.id })} aria-current={selected.id === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
    <p>{selected.description}</p>
    <p class="help">{project ? `${project.name} · ` : "Across projects · "}Computer: {computerLabel()}. The host must be running. Results return to the Inbox for review.</p>
    {!projectId ? <ProjectButton /> : null}
    {project && selected.id !== "missions" ? <label>Automation repository<select class="field" value={chosen} onChange={event => setRepository(event.currentTarget.value)}><option value="" disabled>Choose a repository</option>{project.repos.map(folder => <option value={folder} key={folder}>{folder}</option>)}</select></label> : null}
    {selected.id === "once" ? <><p class="help">Configure a task in New run, then choose Schedule → Run once later.</p><button class="btn" disabled={!draftsReady.value || composerLoading.value || !!project && !chosen} onClick={() => void configure()}>Configure a task</button><DeferredRunsPanel project={scope} unassigned={!projectId && currentProject.value === NONE} /></> : null}
    {selected.id === "repeat" ? <><button class="btn" disabled={!draftsReady.value || composerLoading.value || !!project && !chosen} onClick={() => void configure()}>Configure a repeating task</button><AutomationsView mode="automations" category="repeat" projectId={projectId} showScope={false} /></> : null}
    {selected.id === "backlog" ? <>{project && chosen ? <><p class="help">Next backlog: {project.name} · <code>{chosen}</code>. Choose a single agent, team pattern or saved template before starting.</p><Templates only="backlog" disabled={!draftsReady.value || composerLoading.value} prepare={() => openComposer(project.id, { repository: chosen, stay: true })} /></> : <p class="help">Choose a project and repository here to select backlog items.</p>}<AutomationsView mode="automations" category="backlog" projectId={projectId} showScope={false} /></> : null}
    {selected.id === "missions" ? <>{project ? <ProjectTeamsPanel key={project.id} projectId={project.id} repos={project.repos} /> : <p class="help">Choose a project to create or manage its missions.</p>}</> : null}
  </div>;
}
