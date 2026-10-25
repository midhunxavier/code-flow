import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { RunnerPublic } from "../src/collab/model.js";
import type { HostProjectPolicy } from "../src/collab/host-execution.js";
import type { ProjectInvitation } from "../src/shared-accounts.js";
import { SharedAccountsPanel } from "./shared.js";
import { RepoKeysEditor } from "./collab-settings.js";
import { HostExecutionSettings } from "./host-execution.js";
import { TeamTerminalSettings } from "./team-terminals.js";
import { TeamConnectionPicker } from "./team-connections.js";
import { ProjectInvitations } from "./project-invitations.js";
import { board, boardError, initials, loadBoard, teamTick, type TeamRoute } from "./collab-state.js";
import { Icon } from "./icons.js";
import { ago, api, enc, selectedTeamConnection, showToast, usePoll } from "./lib.js";
import { projects } from "./state.js";
import { roleAtLeast, roleLabel } from "./shared-roles.js";

/** Membership is project-scoped. Computer details remain visible only to their account or the owner. */
export function TeamPeopleView({ project, shared = false, embedded = false, navigate }: { project?: string; shared?: boolean; embedded?: boolean; navigate: (to: TeamRoute) => void }) {
  const [selected, setSelected] = useState("");
  const [computers, setComputers] = useState<RunnerPublic[] | null>(null), [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [execution, setExecution] = useState<{ available: boolean; policies: HostProjectPolicy[] } | null>(null), [error, setError] = useState("");
  const [administration, setAdministration] = useState(false);
  const [revoking, setRevoking] = useState(""), [revokeError, setRevokeError] = useState("");
  usePoll(() => void loadBoard(), shared ? 0 : 15_000, [teamTick.value, shared, administration]);
  const b = board.value;
  const owner = !shared && selectedTeamConnection === "local" && b?.me.userId === "owner";
  const revokeInvitation = async (id: string) => {
    if (!owner || revoking) return;
    setRevoking(id); setRevokeError("");
    try {
      await api(`/api/accounts/invitations/${enc(id)}`, { method: "DELETE" });
      setInvitations(current => current.filter(invite => invite.id !== id));
      teamTick.value++;
      showToast("Invitation revoked. The link no longer works.");
    } catch (err) { setRevokeError(`Could not revoke invitation: ${(err as Error).message}`); }
    finally { setRevoking(""); }
  };
  usePoll(async current => {
    if (!owner) return;
    const results = await Promise.allSettled([
      api<RunnerPublic[]>("/api/team/runners"), api<{ invitations: ProjectInvitation[] }>("/api/accounts/invitations"),
      api<{ available: boolean; policies: HostProjectPolicy[] }>("/api/host-execution"),
    ]);
    if (!current()) return;
    const [runners, invites, host] = results;
    setComputers(runners.status === "fulfilled" ? runners.value : null);
    setInvitations(invites.status === "fulfilled" ? invites.value.invitations : []);
    setExecution(host.status === "fulfilled" ? host.value : null);
    setError(results.some(r => r.status === "rejected") ? "Some setup details could not be refreshed. Membership is shown below; unavailable details are marked separately." : "");
  }, 15_000, [owner, teamTick.value, administration]);
  if (!b) return <p role={boardError.value ? "alert" : "status"}>{boardError.value || "Loading people…"}</p>;
  const visible = b.projects.filter(entry => !project || entry.id === project);
  if (!visible.length) return <p role="status">No accessible project here. Ask the project owner for access.</p>;
  const scoped = { ...b, projects: visible };
  return <section class="team-page project-people" aria-label="Project people">
    <header class="people-page-head">
      <div><div class="collaboration-eyebrow"><Icon name="people" /> Collaboration</div><h2>People and access</h2><p>Manage project access and see how your teammates connect.</p></div>
      <button class="btn people-board-link" onClick={() => navigate({ view: "team", ...(project ? { project } : {}) })}><Icon name="layers" /> Open Board <span aria-hidden="true">→</span></button>
    </header>
    {!shared && !embedded ? <TeamConnectionPicker compact /> : null}
    {error ? <p class="msg warn" role="status">{error}</p> : null}
    {revokeError ? <p class="msg err" role="alert">{revokeError}</p> : null}
    {visible.map(entry => <section class="settings-card people-project" key={entry.id} aria-label={`${entry.name} members`}>
      <header class="people-project-head"><div class="people-project-title"><span class="people-project-icon"><Icon name="folder" /></span><div><h3>{entry.name}</h3><p>Project members</p></div></div><span class="people-member-count">{entry.members.length} {entry.members.length === 1 ? "member" : "members"}</span></header>
      <div class="people-table-wrap"><table class="people-table" aria-label={`${entry.name} project access`}><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Membership</th><th scope="col">Work setup</th></tr></thead><tbody>
        {entry.members.map(member => {
          const key = `${entry.id}/${member.userId}`, mine = member.userId === b.me.userId;
          const list = owner ? computers?.filter(c => c.userId === member.userId) : mine ? b.me.runners : undefined;
          const connected = list?.filter(c => c.online && !c.revokedAt);
          const setup = member.userId === "owner" ? "Server owner" : member.role === "reviewer" ? "Ready to review" : member.role === "viewer" ? "Ready to view" : connected?.length ? `${connected.length} computer${connected.length === 1 ? "" : "s"} connected` : owner && !computers ? "Computer status unavailable" : member.online ? "Computer connected" : "No computer connected";
          const policy = execution?.policies.find(p => p.projectId === entry.id);
          const expanded = selected === key, detailsId = `person-${entry.id}-${member.userId}`;
          const online = member.userId !== "owner" && (connected?.length || member.online) && !["reviewer", "viewer"].includes(member.role);
          return <Fragment key={key}><tr class={`people-member-row${expanded ? " expanded" : ""}`}><td><button class="people-person" aria-label={`${member.displayName}${mine ? " (you)" : ""}`} aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setSelected(expanded ? "" : key)}><span class={`people-avatar${mine ? " mine" : ""}`} aria-hidden="true">{initials(member.displayName)}</span><span class="people-person-name">{member.displayName}{mine ? <span class="people-you">You</span> : null}</span><Icon name="chevron" class="people-person-chevron" /></button></td>
            <td><span class="people-mobile-label" aria-hidden="true">Role</span><span class="people-role">{roleLabel(member.role)}</span></td><td><span class="people-mobile-label" aria-hidden="true">Membership</span><span class="badge ok">Joined</span></td><td class="people-work-cell"><span class="people-mobile-label" aria-hidden="true">Work setup</span><span class={`people-work${online ? " connected" : ""}`}><span class="people-work-dot" aria-hidden="true" />{setup}</span></td></tr>
            {expanded ? <tr class="people-detail-row"><td colSpan={4}><div class="person-details" id={detailsId}>
              <section><h4>Connected computers</h4>{list ? list.length ? <ul>{list.map(computer => <li key={computer.id}>{computer.name} · {computer.revokedAt ? "Access revoked" : computer.online ? "Connected" : "Disconnected"}<span class="help">Last connection {ago(computer.lastSeenAt)}</span></li>)}</ul> : <p>No connected computers registered.</p> : <p>Computer details are visible to this person and the server owner.</p>}</section>
              <section><h4>Project permissions</h4><p>Project access granted · {roleLabel(member.role)}</p><p>{roleAtLeast(member.role, "contributor") ? "Can code on their own computer with a repository and signed-in agent." : "No computer setup needed for this role."}</p>
              {member.userId !== "owner" && roleAtLeast(member.role, "contributor") ? <><p>Repository selection is private to each computer; it has not been checked here.</p><p>{!owner || !execution ? "Team server access: ask the owner for the current permission." : policy?.enabled && policy.userIds.includes(member.userId) ? `Allowed to run on team server${execution.available ? "" : " · execution currently unavailable"}` : "Team server execution not granted"}</p></> : null}
              </section></div></td></tr> : null}</Fragment>;
        })}
        {owner ? invitations.filter(invite => invite.projectId === entry.id && !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > Date.now()).map(invite => <tr class="people-invitation-row" key={invite.id}><td><div class="people-invitation-name"><span class="people-avatar pending" aria-hidden="true"><Icon name="people" /></span><div>Invitation link<small class="help">Expires {new Date(invite.expiresAt).toLocaleString()}</small></div></div></td><td><span class="people-mobile-label" aria-hidden="true">Role</span><span class="people-role">{roleLabel(invite.role)}</span></td><td><span class="people-mobile-label" aria-hidden="true">Membership</span><div class="people-invitation-actions"><span class="badge warn">Invitation pending</span><button class="btn small danger" type="button" aria-label="Revoke invitation" disabled={!!revoking} onClick={() => void revokeInvitation(invite.id)}>{revoking === invite.id ? "Revoking…" : "Revoke"}</button></div></td><td class="people-work-cell"><span class="people-mobile-label" aria-hidden="true">Work setup</span><span class="people-work">Waiting to join</span></td></tr>) : null}
      </tbody></table></div>
      {roleAtLeast(entry.role, "maintainer") ? <details class="people-repositories"><summary>Project repositories</summary><RepoKeysEditor project={entry} revision={b.revision} /></details> : null}
    </section>)}
    {owner ? <><ProjectInvitations projects={visible} projectId={project} /><details class="people-administration" onToggle={event => setAdministration(event.currentTarget.open)}><summary>Advanced administration</summary><p class="help">Manage existing accounts, passwords, and permission to run agents or open terminals on this server.</p>{administration ? <><SharedAccountsPanel projects={projects.value} projectId={project} /><HostExecutionSettings board={scoped} /><TeamTerminalSettings board={scoped} /></> : null}</details></> : <p class="people-owner-note"><Icon name="people" /> The project owner manages invitations, accounts, and server permissions.</p>}
  </section>;
}
