import { SharedAccountsPanel } from "./shared.js";
import { RepoKeysEditor } from "./collab-settings.js";
import { HostExecutionSettings } from "./host-execution.js";
import { TeamTerminalSettings } from "./team-terminals.js";
import { TeamConnectionPicker } from "./team-connections.js";
import { board, boardError, loadBoard, teamTick, type TeamRoute } from "./collab-state.js";
import { selectedTeamConnection, usePoll } from "./lib.js";
import { projects } from "./state.js";
import { roleAtLeast, roleLabel } from "./shared-roles.js";

/** Shared principals use only the board's authorized projection, including empty projects. */
export function TeamPeopleView({ project, shared = false, embedded = false, navigate }: { project?: string; shared?: boolean; embedded?: boolean; navigate: (to: TeamRoute) => void }) {
  usePoll(() => void loadBoard(), shared ? 0 : 15_000, [teamTick.value, shared]);
  const b = board.value;
  if (!b) return <p role={boardError.value ? "alert" : "status"}>{boardError.value || "Loading people…"}</p>;
  const visible = b.projects.filter(entry => !project || entry.id === project);
  if (!visible.length) return <p role="status">No accessible project here. Ask the project owner for access.</p>;
  // A linked maintainer never gets owner account, terminal-grant or execution-grant controls.
  const owner = !shared && selectedTeamConnection === "local" && b.me.userId === "owner";
  const scoped = { ...b, projects: visible };
  return <section class="team-page project-people" aria-label="Project people">
    {!shared && !embedded ? <TeamConnectionPicker /> : null}
    <h2>People</h2><p class="help">Project members and access. Task ownership and progress are on the Board.</p>
    <button class="btn" onClick={() => navigate({ view: "team", ...(project ? { project } : {}) })}>Open Board</button>
    {visible.map(entry => <section class="settings-card" key={entry.id}><h3>{entry.name}</h3><ul>{entry.members.map(member => <li key={member.userId}>{member.displayName} · {roleLabel(member.role)}</li>)}</ul>
      {roleAtLeast(entry.role, "maintainer") ? <RepoKeysEditor project={entry} revision={b.revision} /> : null}
    </section>)}
    {owner ? <><SharedAccountsPanel projects={projects.value} projectId={project} /><HostExecutionSettings board={scoped} /><TeamTerminalSettings board={scoped} /></> : <p class="help">The project owner manages accounts and grants. Your role controls the actions available here.</p>}
  </section>;
}
