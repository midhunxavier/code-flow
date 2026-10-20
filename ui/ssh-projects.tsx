import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, localApi, workspaceId, workspaceUrl, showToast } from "./lib.js";
import { Menu, MenuItem, MenuTitle } from "./panel-bits.js";
import { Icon } from "./icons.js";
import { projectEdit, projectsOpen, route } from "./state.js";

type HostContext = { kind: "local" | "host" } | { kind: "ssh"; id: string; name: string; connected: boolean; error?: string };
export const executionHost = signal<HostContext>({ kind: "local" });
const localPost = <T = any>(path: string, body: unknown = {}) => localApi<T>(path, { method: "POST", body: JSON.stringify(body) });
export async function loadExecutionHost() {
  executionHost.value = await api<HostContext>("/api/ssh-context");
  const host = executionHost.value;
  // Opening a saved remote project after a restart restores its connection automatically.
  if (host.kind === "ssh" && (!host.connected || host.error)) {
    await localPost(`/api/ssh-hosts/${host.id}/connect`);
    executionHost.value = await api<HostContext>("/api/ssh-context");
  }
}
interface SavedHost { id: string; name: string; sshHost: string; port?: number; identityFile?: string; state: string; error?: string }

export const newProjectDraft = signal<{ name: string } | null>(null);
const projectHash = (name: string) => `#new-project=${encodeURIComponent(name.slice(0, 60))}`;
export function readConnectionIntent() {
  if (!location.hash.startsWith("#new-project=")) return false;
  let name = "";
  try { name = decodeURIComponent(location.hash.slice(13)).slice(0, 60); } catch { /* empty draft */ }
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  newProjectDraft.value = { name }; projectEdit.value = "new"; projectsOpen.value = true;
  return true;
}
const hostLabel = () => executionHost.value.kind === "ssh" ? executionHost.value.name : executionHost.value.kind === "host" ? "Remote server" : "This computer";

export function HostControl({ projectName }: { projectName?: string }) {
  return <Menu label={projectName === undefined ? "SSH connections" : "Project computer"} icon="chevron" class="host-switcher" trigger={<><span>{hostLabel()}</span><Icon name="chevron" /></>}>
    {(close) => <HostChoices close={close} projectName={projectName} />}
  </Menu>;
}
function HostChoices({ close, projectName }: { close: () => void; projectName?: string }) {
  const context = executionHost.value;
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const [hosts, setHosts] = useState<SavedHost[]>([]);
  const [loading, setLoading] = useState(context.kind !== "host");
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const refresh = async () => {
    setLoading(true); setError("");
    try { setHosts((await localApi<{ hosts: SavedHost[] }>("/api/ssh-hosts")).hosts); }
    catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (context.kind !== "host") void refresh(); }, []);
  const choose = async (id: string, name: string) => {
    if (id === (workspaceId ?? "local")) return close();
    setBusy(`Opening ${name}…`); setError("");
    try {
      if (id !== "local") await localPost(`/api/ssh-hosts/${id}/connect`);
      if (active.current) location.assign(workspaceUrl(id, projectName === undefined ? "#/" : projectHash(projectName)));
    } catch (error) { setError((error as Error).message); setBusy(""); }
  };
  return <>
    <MenuTitle>{projectName === undefined ? "Computer" : "Project location"}</MenuTitle>
    {context.kind !== "host" ? <>
      <MenuItem on={!workspaceId} disabled={!!busy} onClick={() => void choose("local", "This computer")} sub={!workspaceId ? "Current" : undefined}>This computer</MenuItem>
      {loading ? <p class="host-feedback" role="status">Loading connections…</p> : hosts.map((host) => <MenuItem key={host.id} on={host.id === workspaceId} disabled={!!busy} onClick={() => void choose(host.id, host.name)} sub={host.id === workspaceId ? "Current" : host.state}>{host.name}</MenuItem>)}
      {!loading && !hosts.length && !error ? <p class="host-feedback help">Save a remote connection in Settings to use it here.</p> : null}
      <MenuItem disabled={!!busy} onClick={() => { close(); projectsOpen.value = false; projectEdit.value = null; route.value = { view: "settings", section: "connections", group: "workspace" }; }}>Manage connections…</MenuItem>
    </> : <p class="host-feedback help">Open the app on your computer to manage connections.</p>}
    {busy ? <p class="host-feedback" role="status">{busy}</p> : null}
    {error ? <><p class="host-feedback msg err" role="alert">{error}</p><MenuItem onClick={() => void refresh()}>Refresh connections</MenuItem></> : null}
  </>;
}

/** Connection setup lives in Settings. */
export function SshConnections() {
  const context = executionHost.value;

  const [hosts, setHosts] = useState<SavedHost[]>([]), [aliases, setAliases] = useState<string[]>([]);
  const [sshHost, setSshHost] = useState(""), [name, setName] = useState("");
  const [port, setPort] = useState(""), [identityFile, setIdentityFile] = useState("");
  const [loading, setLoading] = useState(context.kind !== "host");
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const refresh = async () => { const data = await localApi<{ hosts: SavedHost[]; aliases: string[] }>("/api/ssh-hosts"); setHosts(data.hosts); setAliases(data.aliases); };
  useEffect(() => { if (context.kind !== "host") void refresh().catch((error) => setError(error.message)).finally(() => setLoading(false)); }, []);
  const act = async (label: string, work: () => Promise<unknown>) => { setBusy(label); setError(""); try { await work(); } catch (error) { setError((error as Error).message); } finally { setBusy(""); } };
  const connect = async (id: string) => { const result = await localPost<{ url: string }>(`/api/ssh-hosts/${id}/connect`, {}); location.assign(result.url); };
  const save = (open: boolean) => act(open ? `Connecting to ${name || sshHost}…` : "Saving connection…", async () => {
    const host = await localPost<SavedHost>("/api/ssh-hosts", { sshHost: sshHost.trim(), name: name.trim() || sshHost.trim(), ...(port ? { port: Number(port) } : {}), ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}) });
    // Keep the saved connection visible even if opening it fails, so retry never creates a duplicate.
    setHosts((current) => [...current, { ...host, state: "disconnected" }]);
    setSshHost(""); setName(""); setPort(""); setIdentityFile("");
    if (open) await connect(host.id); else showToast("SSH connection saved");
  });
  return <div class="ssh-connections" aria-busy={!!busy || loading}>
      {context.kind === "host" ? <p>Manage SSH connections in the app on your computer.</p> : <>
        <div class="ssh-local"><strong>This computer</strong><span class="badge ok">Local workspace</span></div>
        <div class="ssh-saved-heading"><h3>Saved connections</h3><button class="btn small" disabled={!!busy || loading} onClick={() => void act("Refreshing…", refresh)}>Refresh connections</button></div>
        {loading ? <p role="status">Loading connections…</p> : !hosts.length ? <p class="help">No remote machines yet. Connect your first VM below.</p> : null}
        {hosts.map((host) => <article class="section" key={host.id}>
          <p><strong>{host.name}</strong> <span class="help">{host.sshHost}{host.port ? `:${host.port}` : ""} · {host.state}</span></p>
          {host.identityFile ? <p class="help">Key: <code>{host.identityFile}</code></p> : null}
          {host.error ? <p class="msg err">{host.error}</p> : null}
          <div class="ssh-actions">
            <button class="btn primary" disabled={!!busy} onClick={() => void act(`Connecting to ${host.name}…`, () => connect(host.id))}>Open {host.name}</button>
            {host.state === "connected" ? <>
              <button class="btn" disabled={!!busy} onClick={() => void act("Disconnecting…", async () => { await localPost(`/api/ssh-hosts/${host.id}/disconnect`, {}); await refresh(); })}>Disconnect</button>
              <button class="btn" disabled={!!busy} title="Stops an idle backend; running work and open terminals must finish first" onClick={() => void act("Stopping backend…", async () => { await localPost(`/api/ssh-hosts/${host.id}/stop`, {}); await refresh(); })}>Stop backend</button>
            </> : null}
            <button class="btn" disabled={!!busy} onClick={() => void act("Removing connection…", async () => { await localApi(`/api/ssh-hosts/${host.id}`, { method: "DELETE" }); await refresh(); })}>Remove</button>
          </div>
        </article>)}
        <form class="ssh-new" onSubmit={(event) => { event.preventDefault(); const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null; void save(submitter?.value !== "save"); }}>
          <h3>Add a remote machine</h3>
          <p class="help">Your repository, agents, terminal, builds and tests run on the VM.</p>
          <label>SSH host<input class="field" list="ssh-aliases" value={sshHost} onInput={(event) => setSshHost(event.currentTarget.value)} placeholder="devbox or user@server" maxLength={200} required disabled={!!busy} /></label>
          <datalist id="ssh-aliases">{aliases.map((alias) => <option key={alias} value={alias} />)}</datalist>
          <label>Display name<input class="field" value={name} onInput={(event) => setName(event.currentTarget.value)} placeholder="Development server" maxLength={80} disabled={!!busy} /></label>
          <div class="settings-grid">
            <label>SSH port<input class="field" type="number" min={1} max={65535} step={1} value={port} onInput={(event) => setPort(event.currentTarget.value)} placeholder="From SSH config (usually 22)" disabled={!!busy} /></label>
            <label>Identity file<input class="field" value={identityFile} onInput={(event) => setIdentityFile(event.currentTarget.value)} placeholder="~/.ssh/id_ed25519 (optional)" maxLength={4096} disabled={!!busy} /></label>
          </div>
          <p class="help">Leave port and key blank to use your SSH config and agent. Jump hosts are read from ~/.ssh/config. Only the key path is saved; key contents stay on this computer.</p>
          <p class="help">Use a Linux or macOS server with Node.js 22.13+ and Git. Install and sign in to your agent CLIs there. Python 3 enables interactive terminals.</p>
          <p class="help">Uses your SSH config and keys. First verify the host with SSH in a terminal; unlock protected keys in your SSH agent. Connecting installs the backend under ~/.codeflow/ssh-host on the server.</p>
          <div class="ssh-actions"><button class="btn" type="submit" value="save" disabled={!!busy || loading || !sshHost.trim()}>Save connection</button><button class="btn primary" type="submit" value="connect" disabled={!!busy || loading || !sshHost.trim()}>Connect and open</button></div>
        </form>
      </>}
      {busy ? <p role="status">{busy}{busy.startsWith("Connecting") ? " Initial setup can take a minute." : ""}</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    <p class="help">Disconnecting or removing a connection leaves remote work running.</p>
  </div>;
}
