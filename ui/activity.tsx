import { openRepository } from "./projects.js";
import { computerLabel } from "./ssh-projects.js";
import { SchedulingView } from "./scheduling.js";
import { AutomationsView } from "./automations.js";
import { InsightsView } from "./insights.js";
import { WorkbenchView } from "./workbench.js";
import { projects, projectsLoaded, repo, repoError, requestedRepository, type Route } from "./state.js";

/** Operational tools have their own destinations. A project's repository tools are its Repositories section (ProjectView). */
export function ActivityView({ current }: { current: Route }) {
  if (current.view !== "inbox" && current.view !== "automations" && current.view !== "workspace" && current.view !== "insights") return null;
  if (current.view === "automations" && !current.kind) return <SchedulingView />;
  return <div class="activity-page">
    {current.view !== "automations" || current.kind ? <header class="page-head"><div class="page-head-text"><h1>{{ inbox: "Inbox", automations: "Scheduling", workspace: "Repository tools", insights: "Insights" }[current.view]}</h1></div></header> : null}
    {current.view === "inbox" ? <AutomationsView mode="inbox" /> : null}
    {current.view === "automations" ? <SchedulingView kind={current.kind} /> : null}
    {current.view === "workspace" && !repo.value && (!requestedRepository.value || !!repoError.value) && projectsLoaded.value ? <section><p>Choose a project or open a repository on {computerLabel()}.</p><div class="project-destinations">{projects.value.map(project => <a class="btn" href={`#/project/${encodeURIComponent(project.id)}/repositories`}>{project.name}</a>)}<button class="btn" onClick={() => openRepository()}>Open repository</button></div></section> : null}
    {current.view === "workspace" ? <WorkbenchView /> : null}
    {current.view === "insights" ? <InsightsView group={current.group} /> : null}
  </div>;
}
