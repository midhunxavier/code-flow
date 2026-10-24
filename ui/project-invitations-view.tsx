import { useEffect, useRef, useState } from "preact/hooks";
import type { ProjectInvitation, SharedRole } from "../src/shared-accounts.js";
import { api, copy, enc, localApi } from "./lib.js";
import { teamServerAddress, teamTick } from "./collab-state.js";
import { SHARED_ROLES, SHARED_ROLE_HELP, roleLabel } from "./shared-roles.js";
import { ProjectShareAccess } from "./project-share-access.js";
import type { RemoteInfo } from "./remote-access.js";
import { QrCode } from "./bits.js";

/** Also used by SSH setup: every request stays on the explicitly selected server. */
export function ProjectInvitations({ projects, projectId, prefix, address: suppliedAddress, compact = false, beforeCreate }: { projects: { id: string; name: string }[]; projectId?: string; prefix?: string; address?: string; compact?: boolean; beforeCreate?: () => Promise<void> }) {
  const roleField = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (compact) roleField.current?.focus(); }, []);
  const request = <T,>(path: string, init?: RequestInit) => prefix !== undefined ? localApi<T>(prefix + path, init) : api<T>(path, init);
  const [selected, setSelected] = useState(projectId ?? projects[0]?.id ?? ""), [role, setRole] = useState<SharedRole>("contributor");
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]), [address, setAddress] = useState(suppliedAddress ?? "");
  const [link, setLink] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [remote, setRemote] = useState<RemoteInfo | null>(null), [setup, setSetup] = useState(false);
  const [created, setCreated] = useState<ProjectInvitation | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const load = async (refresh = false) => {
    try {
      const [data, remote] = await Promise.all([request<{ invitations: ProjectInvitation[] }>("/api/accounts/invitations"), request<RemoteInfo>(`/api/remote${refresh ? "?refresh=1" : ""}`)]);
      setInvitations(data.invitations); setRemote(remote);
      setAddress(remote.enabled && remote.lan && !remote.lanError ? teamServerAddress(remote) ?? "" : "");
      setError("");
    } catch (err) { setError((err as Error).message); }
  };
  useEffect(() => { void load(); }, [prefix, teamTick.value]);
  useEffect(() => { setSelected(projectId ?? projects[0]?.id ?? ""); setLink(""); }, [projectId, projects.map(project => project.id).join(",")]);
  const saveAccess = async (body: object, path = "/api/remote") => {
    setBusy(true); setError("");
    try { setRemote(await request<RemoteInfo>(path, { method: "POST", body: JSON.stringify(body) })); await load(); return true; }
    catch (err) { setError((err as Error).message); return false; } finally { setBusy(false); }
  };
  const create = async (event: Event) => {
    event.preventDefault(); if (busy || !address || !selected) return; setBusy(true); setError(""); setLink("");
    try {
      await beforeCreate?.();
      const result = await request<{ invitation: ProjectInvitation; token: string }>("/api/accounts/invitations", { method: "POST", body: JSON.stringify({ projectId: selected, role }) });
      setCreated(result.invitation); setLink(`${address}/#/join/${result.token}`); await load(); teamTick.value++;
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError("");
    try { await request(`/api/accounts/invitations/${enc(id)}`, { method: "DELETE" }); if (created?.id === id) setLink(""); await load(); teamTick.value++; }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const active = invitations.filter(invite => (!projectId || invite.projectId === projectId) && !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > now);
  return <section class="settings-card project-invitations" aria-label="Project invitations">
    {!compact ? <h3>Invite a teammate</h3> : null}<p class="help">Share one link with one person. They choose their own password, or sign in with an existing account. Each invitation lasts 24 hours and can be used once.</p>
    <form class="team-setup-fields" onSubmit={event => void create(event)}>
      {!compact ? <label>Invite to project<select aria-label="Invite to project" class="field" value={selected} disabled={busy || !!projectId} onChange={event => { setSelected(event.currentTarget.value); setLink(""); }}><option value="" disabled>Choose a project</option>{projects.filter(project => !projectId || project.id === projectId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label> : null}
      <label>Invitation role<select ref={roleField} aria-label="Invitation role" class="field" value={role} disabled={busy} onChange={event => { setRole(event.currentTarget.value as SharedRole); setLink(""); }}>{SHARED_ROLES.map(role => <option key={role} value={role}>{({ viewer: "View", reviewer: "Review and comment", contributor: "Contribute", maintainer: "Manage project" })[role]}</option>)}</select></label>
      <p class="help">{roleLabel(role)} {SHARED_ROLE_HELP[role]}. Access applies only to this project.</p>
      {!address ? <p class="msg" role="status">Set up secure access so your teammate can reach this project. <button class="btn small" type="button" onClick={() => setSetup(true)}>Set up secure access</button></p> : <p class="help">Team server: <code>{address}</code>. Share this address only with people who can reach your server’s network.</p>}
      <div class="settings-actions"><button class="btn primary" type="submit" disabled={busy || !address || !selected}>{busy ? "Saving…" : "Create invitation"}</button>{!compact ? <button class="btn" type="button" disabled={busy} onClick={() => void load()}>Refresh invitations</button> : null}</div>
    </form>
    {!address && setup && remote ? <ProjectShareAccess info={remote} busy={busy} save={saveAccess} refresh={() => void load(true)} /> : null}
    <p class="help">Git repository access is separate. Running on the team server requires an owner grant.</p>
    {link && created && created.expiresAt > now && !invitations.some(invite => invite.id === created.id && (invite.acceptedAt || invite.revokedAt)) ? <div class="invitation-result" role="status"><b>Invitation ready</b><label>Invitation link<input class="field mono" readOnly value={link} /></label><div class="phone-qr"><QrCode text={link} /><p class="help">For {projects.find(project => project.id === created.projectId)?.name} · {roleLabel(created.role)}. Expires {new Date(created.expiresAt).toLocaleString()}. Copy it now; this secret link cannot be recovered after leaving this page.</p></div><button class="btn primary" onClick={() => void copy(link, "Invitation copied")}>Copy invitation link</button></div> : null}
    {active.length ? <details><summary>Pending invitations ({active.length})</summary><ul class="invitation-list">{active.map(invite => <li key={invite.id}><span>{projects.find(project => project.id === invite.projectId)?.name ?? "Unavailable project"} · {roleLabel(invite.role)}<small class="help">Expires {new Date(invite.expiresAt).toLocaleString()}</small></span><button class="btn small" disabled={busy} onClick={() => void revoke(invite.id)}>Revoke invitation</button></li>)}</ul></details> : null}
    {error ? <p class="msg err" role="alert">{error} <button class="btn small" disabled={busy} onClick={() => void load(true)}>Retry</button></p> : null}
  </section>;
}
