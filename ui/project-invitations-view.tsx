import { useEffect, useState } from "preact/hooks";
import type { ProjectInvitation, SharedRole } from "../src/shared-accounts.js";
import { api, copy, enc, localApi } from "./lib.js";
import { teamServerAddress } from "./collab-state.js";
import { SHARED_ROLES, SHARED_ROLE_HELP, roleLabel } from "./shared-roles.js";
import { QrCode } from "./bits.js";

/** Also used by SSH setup: every request stays on the explicitly selected server. */
export function ProjectInvitations({ projects, projectId, prefix, address: suppliedAddress }: { projects: { id: string; name: string }[]; projectId?: string; prefix?: string; address?: string }) {
  const request = <T,>(path: string, init?: RequestInit) => prefix !== undefined ? localApi<T>(prefix + path, init) : api<T>(path, init);
  const [selected, setSelected] = useState(projectId ?? projects[0]?.id ?? ""), [role, setRole] = useState<SharedRole>("contributor");
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]), [address, setAddress] = useState(suppliedAddress ?? "");
  const [link, setLink] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [created, setCreated] = useState<ProjectInvitation | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const load = async () => {
    try {
      const [data, remote] = await Promise.all([request<{ invitations: ProjectInvitation[] }>("/api/accounts/invitations"), request<{ enabled: boolean; lan: boolean; secure: boolean; lanError?: string; transport: string; tailscaleUrl?: string; lanUrls?: string[] }>("/api/remote")]);
      setInvitations(data.invitations);
      setAddress(remote.enabled && remote.lan && !remote.lanError ? teamServerAddress(remote) ?? "" : "");
      setError("");
    } catch (err) { setError((err as Error).message); }
  };
  useEffect(() => { void load(); }, [prefix]);
  useEffect(() => { setSelected(projectId ?? projects[0]?.id ?? ""); setLink(""); }, [projectId, projects.map(project => project.id).join(",")]);
  const create = async (event: Event) => {
    event.preventDefault(); if (busy || !address || !selected) return; setBusy(true); setError(""); setLink("");
    try {
      const result = await request<{ invitation: ProjectInvitation; token: string }>("/api/accounts/invitations", { method: "POST", body: JSON.stringify({ projectId: selected, role }) });
      setCreated(result.invitation); setLink(`${address}/#/join/${result.token}`); await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError("");
    try { await request(`/api/accounts/invitations/${enc(id)}`, { method: "DELETE" }); if (created?.id === id) setLink(""); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const active = invitations.filter(invite => (!projectId || invite.projectId === projectId) && !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > now);
  return <section class="settings-card project-invitations" aria-label="Project invitations">
    <h3>Invite a teammate</h3><p class="help">Share one link with one person. They choose their own password, or sign in with an existing account. Each invitation lasts 24 hours and can be used once.</p>
    <form class="team-setup-fields" onSubmit={event => void create(event)}>
      <label>Invite to project<select class="field" value={selected} disabled={busy || !!projectId} onChange={event => { setSelected(event.currentTarget.value); setLink(""); }}><option value="" disabled>Choose a project</option>{projects.filter(project => !projectId || project.id === projectId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>Invitation role<select class="field" value={role} disabled={busy} onChange={event => { setRole(event.currentTarget.value as SharedRole); setLink(""); }}>{SHARED_ROLES.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
      <p class="help">{roleLabel(role)} {SHARED_ROLE_HELP[role]}. Access applies only to this project. Server execution and terminals need separate owner grants.</p>
      {!address ? <p class="msg" role="status">Finish secure network access before inviting people. Use Host a team → Secure access, then refresh here.</p> : <p class="help">Team server: <code>{address}</code>. Your teammate must be on the same Wi-Fi or permitted Tailscale network.</p>}
      <div class="settings-actions"><button class="btn primary" type="submit" disabled={busy || !address || !selected}>{busy ? "Saving…" : "Create invitation"}</button><button class="btn" type="button" disabled={busy} onClick={() => void load()}>Refresh invitations</button></div>
    </form>
    {link && created && created.expiresAt > now && !invitations.some(invite => invite.id === created.id && (invite.acceptedAt || invite.revokedAt)) ? <div class="invitation-result" role="status"><b>Invitation ready</b><label>Invitation link<input class="field mono" readOnly value={link} /></label><div class="phone-qr"><QrCode text={link} /><p class="help">For {projects.find(project => project.id === created.projectId)?.name} · {roleLabel(created.role)}. Expires {new Date(created.expiresAt).toLocaleString()}. Copy it now; this secret link cannot be recovered after leaving this page.</p></div><button class="btn primary" onClick={() => void copy(link, "Invitation copied")}>Copy invitation link</button></div> : null}
    {active.length ? <details><summary>Pending invitations ({active.length})</summary><ul class="invitation-list">{active.map(invite => <li key={invite.id}><span>{projects.find(project => project.id === invite.projectId)?.name ?? "Unavailable project"} · {roleLabel(invite.role)}<small class="help">Expires {new Date(invite.expiresAt).toLocaleString()}</small></span><button class="btn small" disabled={busy} onClick={() => void revoke(invite.id)}>Revoke invitation</button></li>)}</ul></details> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}
