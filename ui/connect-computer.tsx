import { useState } from "preact/hooks";
import { api, copy } from "./lib.js";
import { useDialog } from "./app.js";
import { computerSetupLink, teamConnectionLink, DEFAULT_LOCAL_CODEFLOW } from "./team-join-link.js";

export function ConnectComputer({ project, label = "Set up this computer for coding" }: { project: { id: string; name: string }; label?: string }) {
  const [open, setOpen] = useState(false);
  return <><button class="btn" onClick={() => setOpen(true)}>{label}</button>{open ? <ComputerSetup project={project} onClose={() => setOpen(false)} /> : null}</>;
}

function ComputerSetup({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const [local, setLocal] = useState(DEFAULT_LOCAL_CODEFLOW), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState("");
  const prepare = async () => {
    const identity = await api<{ username: string }>("/api/auth/self");
    const hint = teamConnectionLink(location.origin, identity.username, project.id);
    setConnection(hint); return hint;
  };
  const open = async (event: Event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { const hint = connection || await prepare(); location.assign(computerSetupLink(local, hint)); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return <dialog class="picker project-share-dialog" ref={ref} aria-labelledby="computer-setup-title"><form class="picker-inner" onSubmit={event => void open(event)}>
    <div class="picker-head"><h3 id="computer-setup-title">Connect this computer</h3><p class="help">Code Flow will connect to {project.name} on {location.host}.</p></div>
    <div class="dialog-body computer-setup-fields"><ol class="setup-guide"><li>Start Code Flow on the computer with your repository and coding agents.</li><li>Open it below. Your team server, username, and project will be filled in.</li><li>Confirm your account password and choose your repository folder.</li></ol>
      <label>Local Code Flow address<input class="field" type="url" required value={local} onInput={event => setLocal(event.currentTarget.value)} /></label>
      <p class="help">Use the address printed when Code Flow starts. If it uses another port, change it here. Your project is already available for discussion and review.</p>
      <details><summary>Use another computer or troubleshoot</summary><p class="help">If the local page cannot open, start Code Flow there and retry. You can also paste this connection link into Connect this computer on that installation. Repository access and an existing clone are required for coding.</p><button class="btn" type="button" onClick={async () => { try { await copy(connection || await prepare(), "Connection link copied"); } catch (err) { setError((err as Error).message); } }}>Copy connection link</button>{connection ? <label>Your connection link<input class="field mono" readOnly value={connection} /></label> : null}</details>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div><div class="picker-foot"><button class="btn" type="button" onClick={onClose}>Later</button><button class="btn primary" disabled={busy} type="submit">Open local Code Flow</button></div>
  </form></dialog>;
}
