import { lazyView } from "./lazy-view.js";
const ChatPage = lazyView(() => import("./chat.js").then(module => module.ChatPage));
import { useEffect, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { shownPath } from "./lib.js";
import { hashFor, AUTOMATION_MANAGEMENT } from "./navigation.js";
import { computerLabel } from "./ssh-projects.js";
import { AutomationsView, SaveAutomationDialog } from "./automations.js";
import { DeferredRunsPanel } from "./deferred-runs.js";
import { ProjectButton } from "./projects.js";
import { Templates } from "./github.js";
import { activeProject, currentProject, NONE, openComposer, projects, draftsReady, composerLoading, scheduleRequest } from "./state.js";

/** The three ways to automate, in the order the Automations page presents them. */
const SCHEDULE_DETAILS = [
  { id: "once", label: "Run once later", description: "Start a task at a chosen time or when its providers have capacity." },
  { id: "repeat", label: "Repeat on a schedule or event", description: "Run a configured task on a schedule or from a webhook." },
  { id: "backlog", label: "Work through a GitHub backlog", description: "Choose issues, dependency updates or security alerts, with one run per item." },
] as const;

function ScheduleRunDialog({ body, onClose }: { body: Record<string, any>; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  return <dialog ref={ref} class="picker" aria-labelledby="schedule-run-title"><div class="picker-inner"><div class="picker-head"><h3 id="schedule-run-title">Run once later</h3></div><div class="dialog-body"><DeferredRunsPanel runRequest={body} project={body.project} repo={body.repo} /></div><div class="picker-foot"><button class="btn" onClick={onClose}>Close</button></div></div></dialog>;
}

export function SchedulingView({ projectId }: { projectId?: string }) {
  return <ChatPage id="new" project={projectId} automation />;
}

/** Everything scheduled, in one place: the three ways to automate, the queue of one-off runs and the saved automations. */
export function AutomationManagement({ projectId }: { projectId?: string }) {
  const request = scheduleRequest.value;
  const project = projectId ? projects.value.find(p => p.id === projectId) : activeProject.value;
  const [repository, setRepository] = useState("");
  const [dialog, setDialog] = useState<"once" | "repeat" | null>(null);
  // A handed-over run is offered once: leaving the page drops it, and the run form keeps the draft.
  useEffect(() => () => { scheduleRequest.value = null; }, []);
  const preferred = repository || request?.repo;
  const chosen = project?.repos.includes(preferred) ? preferred as string : project?.repos.length === 1 ? project.repos[0] : "";
  const scope = projectId ?? project?.id;
  const blocked = !draftsReady.value || composerLoading.value || !!project && !chosen;
  const configure = () => openComposer(scope ?? (currentProject.value === NONE ? "" : undefined), chosen ? { repository: chosen } : {});
  if (projectId && !project) return <p role="alert">This project is unavailable. Choose an existing project to manage automation.</p>;
  const [once, repeat, backlog] = SCHEDULE_DETAILS;
  return <div class="automation-management">
    <div class="page-head">{!projectId ? <ProjectButton /> : <a class="btn ghost" href={hashFor({ view: "automations", kind: AUTOMATION_MANAGEMENT })}>Automations in every project</a>}<a class="btn" href={hashFor(projectId ? { view: "project", id: projectId, section: "automation" } : { view: "automations" })}>Create automation</a></div>
    <p class="help">{project ? `${project.name} · ` : "Across projects · "}Computer: {computerLabel()}. The host must be running. Results return to the Inbox for review.</p>
    {request ? <div class="msg" role="status">Scheduling the workflow run you configured: <b>{String(request.task ?? "").split("\n")[0]!.slice(0, 120) || "(no task)"}</b>. Choose how to automate it below. <a class="btn small" href={hashFor({ view: "composer", legacy: true })}>Back to the run form</a> <button type="button" class="btn small" onClick={() => (scheduleRequest.value = null)}>Discard</button></div> : null}
    <section class="section automation-ways" aria-labelledby="automation-ways-title">
      <h2 class="section-title" id="automation-ways-title">Ways to automate</h2>
      {project ? <label>Automation repository<select class="field" value={chosen} onChange={event => setRepository(event.currentTarget.value)}><option value="" disabled>Choose a repository</option>{project.repos.map(folder => <option value={folder} key={folder}>{shownPath(folder)}</option>)}</select></label> : null}
      <div class="wb-list">
        <article class="wb-item" aria-labelledby="automation-way-once"><h3 id="automation-way-once">{once.label}</h3><p class="help">{once.description} {request ? "Queued runs are listed below." : "Configure a task in a workflow run, then choose Run actions → Schedule…"}</p><div class="wb-actions">{request ? <button type="button" class="btn primary" onClick={() => setDialog("once")}>{once.label}</button> : <button type="button" class="btn" disabled={blocked} onClick={() => void configure()}>Configure a task</button>}</div></article>
        <article class="wb-item" aria-labelledby="automation-way-repeat"><h3 id="automation-way-repeat">{repeat.label}</h3><p class="help">{repeat.description} {request ? "Saved automations are listed below." : "Describe it in chat with Create automation, or configure a workflow run."}</p><div class="wb-actions">{request ? <button type="button" class="btn primary" onClick={() => setDialog("repeat")}>{repeat.label}</button> : <button type="button" class="btn" disabled={blocked} onClick={() => void configure()}>Configure a repeating task</button>}</div></article>
        <article class="wb-item" aria-labelledby="automation-way-backlog"><h3 id="automation-way-backlog">{backlog.label}</h3><p class="help">{backlog.description}</p>{project && chosen ? <><p class="help">Next backlog: {project.name} · <code>{chosen}</code>. Choose a single agent, team pattern or saved template before starting.</p><Templates only="backlog" disabled={!draftsReady.value || composerLoading.value} prepare={() => openComposer(project.id, { repository: chosen, stay: true })} /></> : <p class="help">Choose a project and repository here to select backlog items.</p>}</article>
      </div>
    </section>
    <DeferredRunsPanel project={scope} unassigned={!projectId && currentProject.value === NONE} />
    <AutomationsView mode="automations" projectId={projectId} showScope={false} />
    {request && dialog === "once" ? <ScheduleRunDialog body={request} onClose={() => setDialog(null)} /> : null}
    {request && dialog === "repeat" ? <SaveAutomationDialog body={request} onClose={() => setDialog(null)} /> : null}
  </div>;
}
