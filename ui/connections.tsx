import { SshConnections, executionHost } from "./ssh-projects.js";
import { RemoteWorkersView } from "./remote-workers.js";
import { RemoteAccess } from "./remote-access.js";
import { TeamSettings } from "./collab-settings.js";
import { SharedAccountsPanel } from "./shared.js";
import { projects } from "./state.js";
import { peopleEnabled, setPeopleEnabled } from "./preferences.js";

export const CONNECTION_PURPOSES = [
  { id: "workspace", label: "Work on another computer", description: "Open a complete workspace over SSH, with files, terminals and agents on that computer." },
  { id: "execution", label: "Delegate execution", description: "Send individual agent turns to a provisioned SSH worker while keeping this workspace here." },
  { id: "sharing", label: "Share access", description: "Open this computer from another device or collaborate with people." },
] as const;
export function ConnectionsView({ purpose = "workspace" }: { purpose?: string }) {
  const selected = CONNECTION_PURPOSES.find(item => item.id === purpose) ?? CONNECTION_PURPOSES[0];
  const host = executionHost.value;
  return <div class="connections-hub">
    <nav class="purpose-nav" aria-label="Connection purpose">{CONNECTION_PURPOSES.map(item => <a class={`btn ${selected.id === item.id ? "primary" : ""}`} href={`#/settings/connections/${item.id}`} aria-current={selected.id === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
    <p class="help">{selected.description}</p>
    {selected.id === "workspace" ? <SshConnections /> : null}
    {selected.id === "execution" ? <><RemoteWorkersView /><p class="help">To run shared tasks on a teammate’s computer or grant host execution, configure <a href="#/settings/connections/sharing">Board and People under Share access</a>.</p></> : null}
    {selected.id === "sharing" ? <>
      {host.kind === "local" ? <RemoteAccess /> : <p class="help">Device access is configured on your local computer. {host.kind === "ssh" ? <a href="/#/settings/connections/sharing">Open local access settings</a> : null}</p>}
      <section class="settings-card"><h3>People</h3><p>Shared boards, reviews and handovers. Manage project membership in Project → More → People.</p><label class="checkpoint"><input type="checkbox" checked={peopleEnabled.value} onChange={event => setPeopleEnabled(event.currentTarget.checked)} /><span>Show Board in the app menu</span></label><p class="help">Show an unused Board shortcut in this browser. Configured collaboration remains visible; access is controlled by project roles and grants.</p></section>
      {<><a class="btn" href="#/team">{host.kind === "ssh" ? "Open computer board" : "Open Board"}</a><TeamSettings />{host.kind !== "ssh" ? <SharedAccountsPanel projects={projects.value} /> : null}</>}
    </> : null}
  </div>;
}
