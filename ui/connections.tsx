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
  { id: "sharing", label: "Share access", description: "Open this workspace from another device or collaborate with people." },
] as const;
export function ConnectionsView({ purpose = "workspace" }: { purpose?: string }) {
  const selected = CONNECTION_PURPOSES.find(item => item.id === purpose) ?? CONNECTION_PURPOSES[0];
  const host = executionHost.value;
  return <div class="connections-hub">
    <nav class="purpose-nav" aria-label="Connection purpose">{CONNECTION_PURPOSES.map(item => <a class={`btn ${selected.id === item.id ? "primary" : ""}`} href={`#/settings/connections/${item.id}`} aria-current={selected.id === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
    <p class="help">{selected.description}</p>
    {selected.id === "workspace" ? <SshConnections /> : null}
    {selected.id === "execution" ? <><RemoteWorkersView /><p class="help">To run shared tasks on a teammate’s computer or grant host execution, configure <a href="#/settings/connections/sharing">People under Share access</a>.</p></> : null}
    {selected.id === "sharing" ? <>
      {host.kind === "local" ? <RemoteAccess /> : <p class="help">Device access is configured on your local computer. {host.kind === "ssh" ? <a href="/#/settings/connections/sharing">Open local access settings</a> : null}</p>}
      <section class="settings-card"><h3>People</h3><p>Optional shared task boards, reviews and handovers. Enable these controls when you work with other people.</p><label class="checkpoint"><input type="checkbox" checked={peopleEnabled.value} onChange={event => setPeopleEnabled(event.currentTarget.checked)} /><span>Show People collaboration</span></label><p class="help">This changes navigation in this browser. Existing accounts, access grants and running tasks retain their settings.</p></section>
      {peopleEnabled.value ? <><a class="btn" href="#/team">{host.kind === "ssh" ? "Open workspace task board" : "Open People board"}</a><TeamSettings />{host.kind !== "ssh" ? <SharedAccountsPanel projects={projects.value} /> : null}</> : null}
    </> : null}
  </div>;
}
