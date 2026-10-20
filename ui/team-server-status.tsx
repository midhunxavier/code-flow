import { useState } from "preact/hooks";
import { copy, localApi, usePoll } from "./lib.js";
import { confirmAction } from "./confirm-state.js";

interface TeamServerStatus {
  state: "running" | "not-installed" | "unavailable";
  access?: "disabled" | "error" | "ready" | "incomplete";
  address?: string;
  network?: string;
}

export function SshTeamServerCard({ host, onManage }: { host: { id: string; name: string }; onManage?: () => void }) {
  const [info, setInfo] = useState<TeamServerStatus | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState("");
  usePoll(async current => {
    setChecking(true);
    try {
      const next = await localApi<TeamServerStatus>(`/api/ssh-hosts/${encodeURIComponent(host.id)}/team-server/status`);
      if (current()) { setInfo(next); setError(""); }
    } catch (err) { if (current()) { setInfo(null); setError((err as Error).message); } }
    finally { if (current()) setChecking(false); }
  }, 60_000, [host.id, revision]);
  const ready = info?.state === "running" && info.access === "ready" && !!info.address;
  const state = error ? "Status unavailable" : !info ? "Checking…" : info.state === "not-installed" ? "Not set up"
    : info.state === "unavailable" ? "Not responding" : "Running";
  const access = !info || info.state !== "running" ? "Not verified" : ready ? "HTTPS enabled"
    : info.access === "disabled" ? "Not enabled" : info.access === "error" ? "Needs attention" : "Setup incomplete";
  const remove = async () => {
    if (deleting || !await confirmAction(`Permanently delete the team server on ${host.name}?\n\nThis stops the server and erases its shared projects, tasks, accounts, certificates and settings. Automatic startup is removed. This cannot be undone.\n\nRepository folders and the SSH workspace stay in place.`, { title: `Delete team server on ${host.name}?`, confirmLabel: "Delete permanently", danger: true })) return;
    setDeleting(true); setActionError("");
    try {
      await localApi(`/api/ssh-hosts/${encodeURIComponent(host.id)}/team-server/installation`, { method: "DELETE" });
      setInfo({ state: "not-installed" }); setRevision(value => value + 1);
    } catch (err) { setActionError((err as Error).message); }
    finally { setDeleting(false); }
  };
  return <section class="settings-card ssh-team-status" aria-label={`Team server on ${host.name}`}>
    <div class="ssh-team-status-head"><div><p class="ssh-team-eyebrow">Team hosting</p><h2>Team server on {host.name}</h2></div><span class={`badge ${info?.state === "running" ? "ok" : "warn"}`} role="status">{state}</span></div>
    <p class="help">Teammates connect to the team server on {host.name}. Your own computer does not need incoming access.</p>
    <dl class="ssh-team-status-facts">
      <div><dt>Secure access</dt><dd><span class={`badge ${ready ? "ok" : "warn"}`}>{access}</span></dd></div>
      <div><dt>Network</dt><dd>{info?.network ?? "Not verified"}</dd></div>
      <div class="ssh-team-status-address"><dt>Team address</dt><dd>{ready ? <><code>{info!.address}</code><button class="btn small" onClick={() => void copy(info!.address!, "Team address copied")}>Copy address</button></> : "Not available"}</dd></div>
    </dl>
    <p class="help">{ready ? "Teammates need access to this network and their own team account. HTTPS is enabled on the server; connectivity from a teammate’s computer has not been tested."
      : info?.state === "not-installed" ? "Set up a team server here to share projects and create teammate accounts."
      : info?.state === "running" ? "Open team server setup to configure secure access on this server."
      : "The team server’s access status could not be verified. Check the SSH connection and refresh. Checking status does not start or change the server."}</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {actionError ? <p class="msg err" role="alert">{actionError}</p> : null}
    <div class="settings-actions">
      {onManage ? <button class="btn primary" disabled={deleting} onClick={onManage}>{info?.state === "running" ? "Manage team server" : "Set up team server"}</button> : <a class="btn primary" href="#/settings/connections/sharing">Manage team server</a>}
      <button class="btn" disabled={checking || deleting} onClick={() => setRevision(value => value + 1)}>{checking ? "Checking…" : "Refresh status"}</button>
      {onManage && info && info.state !== "not-installed" ? <button class="btn danger" disabled={deleting || checking} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete team server"}</button> : null}
    </div>
    {onManage && info?.state !== "not-installed" ? <p class="help">Manage team server to edit projects, repositories, secure access and accounts. To restart it, stop the server in setup, then start it again.</p> : null}
  </section>;
}
