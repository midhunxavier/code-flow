import { useEffect, useState } from "preact/hooks";
import type { SharedRole } from "../src/shared-accounts.js";
import { localApi } from "./lib.js";
import { roleLabel, SHARED_ROLE_HELP } from "./shared-roles.js";

interface Invitation { project: { id: string; name: string }; role: SharedRole; expiresAt: number }
export function JoinProject({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [existing, setExisting] = useState(false);
  const [username, setUsername] = useState(""), [name, setName] = useState(""), [password, setPassword] = useState("");
  const preview = async () => {
    setBusy(true); setError("");
    try { setInvitation(await localApi<Invitation>("/api/auth/invitations/preview", { method: "POST", body: JSON.stringify({ token }) })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { void preview(); }, [token]);
  const accept = async (event: Event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      const result = await localApi<{ projectId: string; granted: boolean; user: { roles: Record<string, SharedRole> } }>("/api/auth/invitations/accept", { method: "POST", body: JSON.stringify({ token, existing, username, displayName: name, password }) });
      if (!result.granted) try { sessionStorage.setItem("sharedJoinNotice", `You already have ${roleLabel(result.user.roles[result.projectId]!)} access to ${invitation?.project.name ?? "this project"}. Your other sessions remain signed in.`); } catch {}
      history.replaceState(null, "", `/#/team/project/${encodeURIComponent(result.projectId)}`); location.reload();
    } catch (err) { setError((err as Error).message); } finally { setPassword(""); setBusy(false); }
  };
  return <main class="shared-surface shared-login"><div class="shared-card join-project"><div class="shared-brand">code<span>-flow</span></div>
      <h1>{invitation ? `Join ${invitation.project.name}` : "Join a project"}</h1><p class="help">Team server: <code>{location.host}</code></p>
      {invitation ? <><p>You’ve been invited as a <b>{roleLabel(invitation.role)}</b>. {roleLabel(invitation.role)} {SHARED_ROLE_HELP[invitation.role]}.</p><p class="help">Your account can access this project’s tasks, discussions, and results. This is a Code Flow account on this team server, separate from your Git or coding-agent accounts.</p>
        <form class="shared-form" onSubmit={event => void accept(event)}><fieldset disabled={busy} class="team-setup-fields"><legend class="sr-only">Your account</legend>
          <label>Account option<select class="field" value={existing ? "existing" : "new"} onChange={event => { setExisting(event.currentTarget.value === "existing"); setPassword(""); setError(""); }}><option value="new">Create my account</option><option value="existing">Sign in with an existing account</option></select></label>
          {!existing ? <label>Your name<input class="field" required maxLength={120} autoComplete="name" value={name} onInput={event => setName(event.currentTarget.value)} /></label> : null}
          <label>Username<input class="field" required minLength={3} maxLength={64} autoComplete="username" value={username} onInput={event => setUsername(event.currentTarget.value)} /></label>
          <label>Password<input class="field" type="password" required minLength={existing ? undefined : 15} autoComplete={existing ? "current-password" : "new-password"} value={password} onInput={event => setPassword(event.currentTarget.value)} /></label>
          {!existing ? <p class="help">Choose at least 15 characters. Your teammates never see your password.</p> : null}
          <button class="btn primary" type="submit">{busy ? "Joining…" : "Join project"}</button>
        </fieldset></form></> : busy ? <p role="status">Checking your invitation…</p> : <button class="btn" onClick={() => void preview()}>Check invitation again</button>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <p class="help">Need a new invitation? Ask the project owner for a fresh link. Already joined? <a href="/">Sign in to your projects</a>. If the server is unreachable, connect to your team’s Wi-Fi or Tailscale network and try again.</p>
  </div></main>;
}
