import { AutomationsView } from "./automations.js";
import { DeferredRunsPanel } from "./deferred-runs.js";
import { ProjectTeamsPanel } from "./project-teams.js";
import { ProjectButton } from "./projects.js";
import { Templates } from "./github.js";
import { activeProject, currentProject, NONE, repo, route } from "./state.js";

export const SCHEDULE_KINDS = [
  { id: "once", label: "Run once later", description: "Start a task at a chosen time or when its providers have capacity." },
  { id: "repeat", label: "Repeat", description: "Run a configured task on a schedule or from a webhook." },
  { id: "backlog", label: "Process a backlog", description: "Choose issues, dependency updates or security alerts, with one run per item." },
  { id: "missions", label: "Pursue a mission", description: "Give agents an ongoing goal and review their proposals and verified drafts." },
] as const;
export type ScheduleKind = typeof SCHEDULE_KINDS[number]["id"];
export function SchedulingView({ kind = "repeat" }: { kind?: string }) {
  const selected = SCHEDULE_KINDS.find(item => item.id === kind) ?? SCHEDULE_KINDS[1];
  const project = activeProject.value;
  return <div class="scheduling-hub">
    <nav class="purpose-nav" aria-label="Scheduling purpose">{SCHEDULE_KINDS.map(item => <a class={`btn ${selected.id === item.id ? "primary" : ""}`} href={`#/automations/${item.id}`} aria-current={selected.id === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
    <p>{selected.description}</p>
    <p class="help">The host must be running. Results return to the Inbox for review.</p>
    {selected.id === "once" ? <><ProjectButton /><p class="help">Configure a task in New run, then choose Schedule → Run once later.</p><button class="btn" onClick={() => { route.value = { view: "composer" }; }}>Configure a task</button><DeferredRunsPanel project={project?.id} unassigned={currentProject.value === NONE} /></> : null}
    {selected.id === "repeat" ? <><button class="btn" onClick={() => { route.value = { view: "composer" }; }}>Configure a repeating task</button><AutomationsView mode="automations" category="repeat" /></> : null}
    {selected.id === "backlog" ? <><ProjectButton />{repo.value ? <><p class="help">Repository: <code>{repo.value}</code></p><Templates only="backlog" /></> : <p class="help">Choose a repository in New run to select backlog items.</p>}<AutomationsView mode="automations" category="backlog" /></> : null}
    {selected.id === "missions" ? <><ProjectButton />{project ? <ProjectTeamsPanel key={project.id} projectId={project.id} repos={project.repos} /> : <p class="help">Choose a project to create or manage its missions.</p>}</> : null}
  </div>;
}
