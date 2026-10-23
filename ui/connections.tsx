import { SshConnections, executionHost } from "./ssh-projects.js";
import { RemoteWorkersView } from "./remote-workers.js";
import { RemoteAccess } from "./remote-access.js";
import { TeamSettings, TeamJoinSettings } from "./collab-settings.js";
import { lazyView } from "./lazy-view.js";
const TeamServerWizard = lazyView(() => import("./team-server-wizard.js").then(module => module.TeamServerWizard));
import { SharedAccountsPanel } from "./shared.js";
import { projects } from "./state.js";
import { peopleEnabled, setPeopleEnabled } from "./preferences.js";

export const CONNECTION_PURPOSES = [
  { id: "workspace", label: "Work on another computer", description: "Open a complete workspace over SSH, with files, terminals and agents on that computer." },
  { id: "execution", label: "Delegate execution", description: "Send individual agent turns to a provisioned SSH worker while keeping this workspace here." },
  { id: "sharing", label: "Share access", description: "Open this computer from another device or collaborate with people." },
] as const;
export function ConnectionsView({ purpose = "workspace" }: { purpose?: string }) {
  const sharing = ["sharing", "devices", "join", "host", "manage"].includes(purpose);
  const selected = CONNECTION_PURPOSES.find(item => item.id === (sharing ? "sharing" : purpose)) ?? CONNECTION_PURPOSES[0];
  const host = executionHost.value;
  return <div class="connections-hub">
    <nav class="purpose-nav" aria-label="Connection purpose">{CONNECTION_PURPOSES.map(item => <a class={`btn ${selected.id === item.id ? "primary" : ""}`} href={`#/settings/connections/${item.id}`} aria-current={selected.id === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
    <p class="help">{selected.description}</p>
    {selected.id === "workspace" ? <SshConnections /> : null}
    {selected.id === "execution" ? <><RemoteWorkersView /><p class="help">To run shared tasks on a teammate’s computer or grant host execution, configure <a href="#/settings/connections/manage">Board and People under Share access</a>.</p></> : null}
    {selected.id === "sharing" ? <>
      <nav class="connection-journeys" aria-label="Share access options">
        {[
          { id: "devices", title: "Connect my devices", text: "Use your phone, tablet or another browser over Wi-Fi or Tailscale. Work stays on this computer." },
          { id: "join", title: "Join a team", text: "Open an invitation or connect to an existing team. Use your own account and local repositories." },
          { id: "host", title: "Host a team", text: "Set up a shared project on this computer or an SSH server, then invite your teammates." },
        ].map(item => <a class="connection-journey" key={item.id} href={`#/settings/connections/${item.id}`} aria-current={purpose === item.id ? "page" : undefined}><b>{item.title}</b><span>{item.text}</span><span class="connection-action">{purpose === item.id ? "Selected" : "Get started →"}</span></a>)}
      </nav>
      {purpose === "sharing" ? <section class="settings-card"><h3>One project, a clear place to work</h3><p>Connect your own devices to continue your work, or give teammates their own project access. A team server keeps tasks, reviews and handovers together; each person can connect their computer to run tasks with their own agents.</p><p class="help">Wi-Fi works on the same local network. Tailscale connects permitted devices across networks. Keep the host awake and CodeFlow running.</p></section> : null}
      {purpose === "devices" ? host.kind === "local" ? <RemoteAccess /> : <p class="help">Device access is configured on your local computer. {host.kind === "ssh" ? <a href="/#/settings/connections/devices">Open local access settings</a> : null}</p> : null}
      {purpose === "join" ? host.kind === "local" ? <TeamJoinSettings /> : <p class="help">Connect from CodeFlow on your own computer. <a href="/#/settings/connections/join">Open local team connections</a></p> : null}
      {purpose === "host" && host.kind !== "host" ? <TeamServerWizard onClose={() => { location.hash = "#/settings/connections/sharing"; }} /> : null}
      {purpose === "host" && host.kind === "host" ? <p class="help">Open CodeFlow on the server’s owner computer to set up project access and invite teammates.</p> : null}
      <a class="btn small" href="#/settings/connections/manage">Manage existing connections and access</a>
      {purpose === "manage" ? <>
      {host.kind === "local" ? <RemoteAccess /> : null}
      <section class="settings-card"><h3>People</h3><p>Shared boards, reviews and handovers. Manage project membership in Project → More → People.</p><label class="checkpoint"><input type="checkbox" checked={peopleEnabled.value} onChange={event => setPeopleEnabled(event.currentTarget.checked)} /><span>Show Board in the app menu</span></label><p class="help">Show an unused Board shortcut in this browser. Configured collaboration remains visible; access is controlled by project roles and grants.</p></section>
      {<><a class="btn" href="#/team">{host.kind === "ssh" ? "Open computer board" : "Open Board"}</a><TeamSettings />{host.kind !== "ssh" ? <SharedAccountsPanel projects={projects.value} /> : null}</>}
      </> : null}
    </> : null}
  </div>;
}
