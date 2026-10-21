import { openRepository } from "./projects.js";
import { computerLabel } from "./ssh-projects.js";
import { SchedulingView } from "./scheduling.js";
import { AutomationsView } from "./automations.js";
import { InsightsView } from "./insights.js";
import { WorkbenchView } from "./workbench.js";
import { projects, repo, type Route } from "./state.js";

/** Operational tools have their own destinations; project links retain their repository scope. */
export function ActivityView({ current }: { current: Route }) {
  if (current.view !== "inbox" && current.view !== "automations" && current.view !== "workspace" && current.view !== "insights") return null;
  const name = current.view === "workspace" && current.project ? projects.value.find(p => p.id === current.project)?.name : undefined;
  return <div class="activity-page">
    <header class="page-head"><div class="page-head-text"><h1>{name ? `${name} repositories` : { inbox: "Inbox", automations: "Scheduling", workspace: "Repository tools", insights: "Insights" }[current.view]}</h1></div>
      {current.view === "workspace" && current.project ? <a class="btn" href={`#/project/${encodeURIComponent(current.project)}`}>Back to project</a> : null}
    </header>
    {current.view === "inbox" ? <AutomationsView mode="inbox" /> : null}
    {current.view === "automations" ? <SchedulingView kind={current.kind} /> : null}
    {current.view === "workspace" && !current.project && !repo.value ? <section><p>Choose a project or open a repository on {computerLabel()}.</p><div class="project-destinations">{projects.value.map(project => <a class="btn" href={`#/project/${encodeURIComponent(project.id)}/repositories`}>{project.name}</a>)}<button class="btn" onClick={() => openRepository()}>Open repository</button></div></section> : null}
    {current.view === "workspace" ? <WorkbenchView projectId={current.project} /> : null}
    {current.view === "insights" ? <InsightsView group={current.group} /> : null}
  </div>;
}
