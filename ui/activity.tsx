import { openRepository } from "./projects.js";
import { computerLabel } from "./ssh-projects.js";
import { AutomationManagement, SchedulingView } from "./scheduling.js";
import { AutomationsView } from "./automations.js";
import { InsightsView } from "./insights.js";
import { WorkbenchView } from "./workbench.js";
import { projects, repo, type Route } from "./state.js";

/** Operational tools have their own destinations. A project's repository tools are its Repositories section (ProjectView). */
export function ActivityView({ current }: { current: Route }) {
  if (current.view !== "inbox" && current.view !== "automations" && current.view !== "workspace" && current.view !== "insights") return null;
  if (current.view === "automations" && !current.kind) return <SchedulingView />;
  return <div class="activity-page">
    <header class="page-head"><div class="page-head-text"><h1>{{ inbox: "Inbox", automations: "Automations", workspace: "Repository tools", insights: "Insights" }[current.view]}</h1></div></header>
    {current.view === "inbox" ? <AutomationsView mode="inbox" /> : null}
    {current.view === "automations" ? <AutomationManagement /> : null}
    {current.view === "workspace" && !repo.value ? <section><p>Choose a project or open a repository on {computerLabel()}.</p><div class="project-destinations">{projects.value.map(project => <a class="btn" href={`#/project/${encodeURIComponent(project.id)}/repositories`}>{project.name}</a>)}<button class="btn" onClick={() => openRepository()}>Open repository</button></div></section> : null}
    {current.view === "workspace" ? <WorkbenchView /> : null}
    {current.view === "insights" ? <InsightsView group={current.group} /> : null}
  </div>;
}
