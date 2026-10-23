import { useEffect, useState } from "preact/hooks";
import type { SharedRole } from "../src/shared-accounts.js";
import { copy, localApi } from "./lib.js";
import { roleAtLeast, roleLabel, SHARED_ROLE_HELP } from "./shared-roles.js";
import { teamConnectionLink } from "./team-join-link.js";

interface Invitation { project: { id: string; name: string }; role: SharedRole; expiresAt: number }
export function JoinProject({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [existing, setExisting] = useState(false);
  const [username, setUsername] = useState(""), [name, setName] = useState(""), [password, setPassword] = useState("");
  const [joined, setJoined] = useState<{ projectId: string; user: { username: string; roles: Record<string, SharedRole> } } | null>(null);
  const preview = async () => {
    setBusy(true); setError("");
    try { setInvitation(await localApi<Invitation>("/api/auth/invitations/preview", { method: "POST", body: JSON.stringify({ token }) })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { void preview(); }, [token]);
  const accept = async (event: Event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      const result = await localApi<NonNullable<typeof joined>>("/api/auth/invitations/accept", { method: "POST", body: JSON.stringify({ token, existing, username, displayName: name, password }) });
      setJoined(result); history.replaceState(null, "", `/#/team/project/${encodeURIComponent(result.projectId)}`);
    } catch (err) { setError((err as Error).message); } finally { setPassword(""); setBusy(false); }
  };
  return <main class="shared-surface shared-login"><div class="shared-card join-project"><div class="shared-brand">code<span>-flow</span></div>
    {joined && invitation ? <>
      <span class="badge ok">Connected to the project</span><h1>You’re in {invitation.project.name}</h1>
      <p>Your account is ready. Open the board to see tasks, discuss work and review progress with your team.</p>
      <a class="btn primary" href={`/#/team/project/${encodeURIComponent(joined.projectId)}`} onClick={event => { event.preventDefault(); location.reload(); }}>Open project board</a>
      {roleAtLeast(joined.user.roles[joined.projectId], "contributor") ? <section class="join-next"><h2>Want to run tasks on your computer?</h2><ol><li>Open CodeFlow on the computer with your repository and signed-in coding agents.</li><li>Choose Settings → Connections → Share access → Join a team.</li><li>Paste the connection link below and sign in with the account you just used. Choose your local repository folder to start working.</li></ol><label>Your connection link<input class="field mono" readOnly value={teamConnectionLink(location.origin, joined.user.username)} /></label><button class="btn" onClick={() => void copy(teamConnectionLink(location.origin, joined.user.username), "Connection link copied")}>Copy connection link</button><p class="help">The team server holds your shared board. Your computer runs the tasks you start there, using your own agent logins. This link contains no password or access token.</p></section> : null}
    </> : <>
      <h1>{invitation ? `Join ${invitation.project.name}` : "Join a project"}</h1><p class="help">Team server: <code>{location.host}</code></p>
      {invitation ? <><p>You’ll join as a <b>{roleLabel(invitation.role)}</b>. {roleLabel(invitation.role)} {SHARED_ROLE_HELP[invitation.role]}.</p><p class="help">Access applies to {invitation.project.name}. The owner manages any additional permission to run work or open terminals on the server.</p>
        <form class="shared-form" onSubmit={event => void accept(event)}><fieldset disabled={busy} class="team-setup-fields"><legend class="sr-only">Your account</legend>
          <label>Account option<select class="field" value={existing ? "existing" : "new"} onChange={event => { setExisting(event.currentTarget.value === "existing"); setPassword(""); setError(""); }}><option value="new">Create my account</option><option value="existing">Sign in with an existing account</option></select></label>
          {!existing ? <label>Your name<input class="field" required maxLength={120} autoComplete="name" value={name} onInput={event => setName(event.currentTarget.value)} /></label> : null}
          <label>Username<input class="field" required minLength={3} maxLength={64} autoComplete="username" value={username} onInput={event => setUsername(event.currentTarget.value)} /></label>
          <label>Password<input class="field" type="password" required minLength={existing ? undefined : 15} autoComplete={existing ? "current-password" : "new-password"} value={password} onInput={event => setPassword(event.currentTarget.value)} /></label>
          {!existing ? <p class="help">Choose at least 15 characters. Your teammates never see your password.</p> : null}
          <button class="btn primary" type="submit">{busy ? "Joining…" : "Join project"}</button>
        </fieldset></form></> : busy ? <p role="status">Checking your invitation…</p> : <button class="btn" onClick={() => void preview()}>Check invitation again</button>}
    </>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {!joined ? <p class="help">Already joined? <a href="/">Sign in to your projects</a>. If the server is unreachable, connect to your team’s Wi-Fi or Tailscale network and try again.</p> : null}
  </div></main>;
}
