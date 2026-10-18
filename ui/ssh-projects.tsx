import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { api, post } from "./lib.js";
import { useDialog } from "./app.js";

type HostContext = { kind: "local" | "host" } | { kind: "ssh"; name: string; returnUrl: string; error?: string };
export const executionHost = signal<HostContext>({ kind: "local" });
export async function loadExecutionHost() { executionHost.value = await api<HostContext>("/api/ssh-context"); }
interface SavedHost { id: string; name: string; sshHost: string; state: string; error?: string }

export function HostControl() {
  const [open, setOpen] = useState(false);
  const host = executionHost.value;
  return <>
    <button class="btn small host-control" onClick={() => setOpen(true)} aria-label="SSH connections" title="Choose where projects and commands run">{host.kind === "ssh" ? `SSH · ${host.name}` : host.kind === "host" ? "Remote server" : "This computer"}</button>
    {open ? <HostDialog close={() => setOpen(false)} /> : null}
  </>;
}
function HostDialog({ close }: { close: () => void }) {
  const ref = useDialog(true, close), context = executionHost.value;
  const [hosts, setHosts] = useState<SavedHost[]>([]), [aliases, setAliases] = useState<string[]>([]);
  const [sshHost, setSshHost] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const refresh = async () => { const data = await api<{ hosts: SavedHost[]; aliases: string[] }>("/api/ssh-hosts"); setHosts(data.hosts); setAliases(data.aliases); };
  useEffect(() => { if (context.kind === "local") void refresh().catch((error) => setError(error.message)); }, []);
  const act = async (label: string, work: () => Promise<unknown>) => { setBusy(label); setError(""); try { await work(); } catch (error) { setError((error as Error).message); } finally { setBusy(""); } };
  const connect = async (id: string) => { const result = await post<{ url: string }>(`/api/ssh-hosts/${id}/connect`, {}); location.assign(result.url); };
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="ssh-title"><div class="picker-inner">
    <div class="picker-head"><h3 id="ssh-title">SSH connections</h3>
      <p class="help">Open a server's project folders and run agents, terminals, Git, builds, and tests on that server.</p>
    </div>
    <div class="ssh-connections">
      {context.kind === "ssh" ? <>
        <p><strong>Working on {context.name}</strong></p>
        <p class="help">Your projects and running work stay on this server when you leave. Reconnecting restores the workspace without repeating commands.</p>
        <button class="btn" disabled={!!busy} onClick={() => void act("Reconnecting…", async () => { await post("/api/ssh-reconnect", {}); location.reload(); })}>Reconnect</button>{" "}
        <a class="btn primary" href={context.returnUrl}>Back to this computer</a>
      </> : context.kind === "host" ? <p>Manage SSH connections in the app on your computer.</p> : <>
        {hosts.map((host) => <article class="section" key={host.id}>
          <p><strong>{host.name}</strong> <span class="help">{host.sshHost} · {host.state}</span></p>
          {host.error ? <p class="msg err">{host.error}</p> : null}
          <div class="ssh-actions">
            <button class="btn primary" disabled={!!busy} onClick={() => void act(`Connecting to ${host.name}…`, () => connect(host.id))}>Open {host.name}</button>
            {host.state === "connected" ? <>
              <button class="btn" disabled={!!busy} onClick={() => void act("Disconnecting…", async () => { await post(`/api/ssh-hosts/${host.id}/disconnect`, {}); await refresh(); })}>Disconnect</button>
              <button class="btn" disabled={!!busy} title="Stops an idle backend; running work and open terminals must finish first" onClick={() => void act("Stopping backend…", async () => { await post(`/api/ssh-hosts/${host.id}/stop`, {}); await refresh(); })}>Stop backend</button>
            </> : null}
            <button class="btn" disabled={!!busy} onClick={() => void act("Removing connection…", async () => { await api(`/api/ssh-hosts/${host.id}`, { method: "DELETE" }); await refresh(); })}>Remove</button>
          </div>
        </article>)}
        <form onSubmit={(event) => { event.preventDefault(); void act(`Connecting to ${name || sshHost}…`, async () => { const host = await post<SavedHost>("/api/ssh-hosts", { sshHost: sshHost.trim(), name: name.trim() || sshHost.trim() }); await refresh(); setSshHost(""); setName(""); await connect(host.id); }); }}>
          <label>SSH host<input class="field" list="ssh-aliases" value={sshHost} onInput={(event) => setSshHost(event.currentTarget.value)} placeholder="devbox or user@server" required disabled={!!busy} /></label>
          <datalist id="ssh-aliases">{aliases.map((alias) => <option key={alias} value={alias} />)}</datalist>
          <label>Display name<input class="field" value={name} onInput={(event) => setName(event.currentTarget.value)} placeholder="Development server" maxLength={80} disabled={!!busy} /></label>
          <p class="help">Use a Linux or macOS server with Node.js 20+ and Git. Install and sign in to your agent CLIs there. Python 3 enables interactive terminals.</p>
          <p class="help">Uses your SSH config and keys. First verify the host with SSH in a terminal; unlock protected keys in your SSH agent. Connecting installs the backend under ~/.codeflow/ssh-host on the server.</p>
          <button class="btn primary" disabled={!!busy || !sshHost.trim()}>Connect and open</button>
        </form>
      </>}
      {busy ? <p role="status">{busy} Initial setup can take a minute.</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="help">Disconnecting or removing a connection leaves remote work running.</span><button class="btn" onClick={close}>Close</button></div>
  </div></dialog>;
}
