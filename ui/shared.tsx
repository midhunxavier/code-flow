import { completeSentence } from "./lib.js";
import type { SharedStreamState } from "./shared-events.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { confirmAction } from "./confirm-state.js";
import { api, ApiError, enc, post, copy } from "./lib.js";
import { SHARED_ROLES, SHARED_ROLE_HELP, roleAtLeast, roleLabel } from "./shared-roles.js";
import { Icon } from "./icons.js";
import { teamConnectionLink } from "./team-join-link.js";
import { hashFor, parseRouteHash } from "./navigation.js";
import { TeamBoardView } from "./collab-board.js";
import { TeamPeopleView } from "./collab-people.js";
import { lazyView } from "./lazy-view.js";
// Loaded when a task opens, as in the owner's app (ui/app.tsx).
const TeamTaskView = lazyView(() => import("./collab-task.js").then((module) => module.TeamTaskView));
import { type TeamRoute, inboxOpen, inboxUnread, loadInbox, openTeamEvents } from "./collab-state.js";
import type { SharedAccountState, SharedPrincipal, SharedRole, SharedUser } from "../src/shared-accounts.js";

// Styled in ui/styles.css ("Shared-account pages"): the app's stylesheet is on the page for these too.
const reload = () => location.reload();
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed";

export function SharedLogin({ onSignedIn = reload }: { onSignedIn?: () => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const passwordInput = useRef<HTMLInputElement>(null);
  // The sign-in page's card (src/server.ts lockedPage): the wordmark, a Georgia heading, the form.
  return <main class="shared-surface shared-login"><div class="shared-card"><div class="shared-brand">code<span>-flow</span></div><h1>Sign in to shared projects</h1><p class="shared-lede">Sign in with the account you created from a project invitation, or the one your owner shared. Your project role determines what you can do on each project's team board.</p><form class="shared-form" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); try { await post("/api/auth/login", { username, password }); setPassword(""); onSignedIn(); } catch (error) { setPassword(""); setError(message(error)); passwordInput.current?.focus(); } finally { setBusy(false); } }}>
    <label for="shared-username">Username</label><input id="shared-username" class="field" value={username} maxLength={64} autoComplete="username" required onInput={(event) => setUsername(event.currentTarget.value)} />
    <label for="shared-password">Password</label><input ref={passwordInput} id="shared-password" class="field" type="password" value={password} autoComplete="current-password" required onInput={(event) => setPassword(event.currentTarget.value)} />
    {error ? <p class="shared-error" role="alert">{error}</p> : null}<button class="btn primary shared-submit" type="submit" disabled={busy || !username || !password}>{busy ? "Signing in…" : "Sign in"}</button>
  </form>{["localhost", "127.0.0.1"].includes(location.hostname) ? <p class="help">Came here from a link in Claude Code, Codex or Antigravity? You do not need an account. Ask that CLI to open the task in Code Flow, or run <code>codeflow open</code> with the proposal ID in your project folder; either signs this browser in.</p> : null}<p class="help">The owner can still use the recovery link printed in the server terminal. Network sign-in requires HTTPS.</p></div></main>;
}

export function SharedAccountsPanel({ projects, projectId }: { projects: Array<{ id: string; name: string }>; projectId?: string }) {
  const [state, setState] = useState<SharedAccountState | null>(null); const [selected, setSelected] = useState(""); const [username, setUsername] = useState(""); const [name, setName] = useState(""); const [password, setPassword] = useState(""); const [enabled, setEnabled] = useState(true); const [roles, setRoles] = useState<Record<string, SharedRole>>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const select = (user?: SharedUser) => { setSelected(user?.id ?? ""); setUsername(user?.username ?? ""); setName(user?.displayName ?? ""); setEnabled(user?.enabled ?? true); setRoles(user?.roles ?? {}); setPassword(""); setError(""); setNotice(""); };
  const load = async () => { setBusy(true); try { setState(await api<SharedAccountState>("/api/accounts")); setError(""); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, []);
  const save = async () => { if (!state) return; setBusy(true); setError(""); setNotice(""); try { const next = selected ? await api<SharedAccountState>(`/api/accounts/${enc(selected)}`, { method: "PUT", body: JSON.stringify({ revision: state.revision, displayName: name, enabled, roles, ...(password ? { password } : {}) }) }) : await post<SharedAccountState>("/api/accounts", { revision: state.revision, username, displayName: name, password, roles }); setState(next); const user = selected ? next.users.find((user) => user.id === selected) : next.users.find((user) => user.username === username.toLowerCase()); select(user); setNotice("Account saved. Updated accounts must sign in again."); } catch (error) { setError(completeSentence(message(error)) + (error instanceof ApiError && error.status === 409 ? " Your draft has been kept; reload accounts before retrying the save." : "")); } finally { setPassword(""); setBusy(false); } };
  if (!state) return <section class="shared-surface shared-accounts" aria-label="Shared project accounts"><h2>Shared project accounts</h2>{error ? <p role="alert" class="shared-error">{error}</p> : <p role="status">Loading accounts…</p>}<button type="button" class="btn" disabled={busy} onClick={() => void load()}>Reload accounts</button></section>;
  const remove = async () => {
    if (busy || !selected || !await confirmAction(`Delete ${username}? Its sessions, linked runners and execution grants will be revoked. Task and review history remain.`, { title: "Delete shared account?", confirmLabel: "Delete account", danger: true })) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api<SharedAccountState>(`/api/accounts/${enc(selected)}`, { method: "DELETE", body: JSON.stringify({ revision: state.revision }) }); setState(next); select(); setNotice("Account deleted. Its slot and username are available again."); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  // A workspace tool: the workspace draws the section; this lays out its fields, roles and actions.
  return <section class="shared-surface shared-accounts" aria-label="Shared project accounts"><h2>Shared project accounts</h2><p class="help">Viewers can read the team board of their assigned projects: tasks, checkpoints and discussion. Reviewers can also comment on tasks and record reviews of checkpoints. Contributors can also create and own team tasks and run them on their own computer; maintainers can also assign any task owner, define repository keys, delete tasks and checkpoints, revoke runners, cancel hand-overs and approve instructions to agents. Execution on this server, merges, terminals, secrets and system settings stay with the owner.</p>
    <label for="shared-account">Account</label><select id="shared-account" class="field" value={selected} disabled={busy} onChange={(event) => select(state?.users.find((user) => user.id === event.currentTarget.value))}><option value="">New account…</option>{state?.users.map((user) => <option key={user.id} value={user.id}>{user.displayName} ({user.username}){user.enabled ? "" : " · disabled"}</option>)}</select>
    <form class="shared-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><label for="account-username">Account username</label><input id="account-username" class="field" value={username} required maxLength={64} disabled={!!selected || busy} autoComplete="off" onInput={(event) => setUsername(event.currentTarget.value)} />
      <label for="account-name">Display name</label><input id="account-name" class="field" value={name} required maxLength={120} disabled={busy} onInput={(event) => setName(event.currentTarget.value)} />
      <label for="account-password">{selected ? "Replace password (leave empty to keep)" : "Initial password"}</label><input id="account-password" class="field" type="password" value={password} required={!selected} minLength={15} autoComplete="new-password" disabled={busy} onInput={(event) => setPassword(event.currentTarget.value)} /><p class="help">Use at least 15 characters. Passwords are not returned or stored in browser preferences.</p>
      {selected ? <label class="check"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.currentTarget.checked)} /> Account enabled</label> : null}
      <fieldset class="shared-roles-set" disabled={busy}><legend>Assigned project roles</legend><p id="shared-roles-help" class="help">{SHARED_ROLES.map((role) => `${roleLabel(role)} ${SHARED_ROLE_HELP[role]}`).join(" · ")}.</p><div class="shared-roles">{projects.filter(project => !projectId || project.id === projectId).map((project) => <><label for={`shared-role-${project.id}`} key={`${project.id}-label`}>{project.name}</label><select key={project.id} id={`shared-role-${project.id}`} class="field" aria-describedby="shared-roles-help" value={roles[project.id] ?? ""} onChange={(event) => { const next = { ...roles }; if (event.currentTarget.value) next[project.id] = event.currentTarget.value as SharedRole; else delete next[project.id]; setRoles(next); }}><option value="">No access</option>{SHARED_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></>)}</div>{Object.keys(roles).filter((id) => !projects.some((project) => project.id === id)).map((id) => <p key={id} class="help">Unavailable project {id} <button class="btn ghost" type="button" onClick={() => { const next = { ...roles }; delete next[id]; setRoles(next); }}>Remove assignment</button></p>)}</fieldset>
      <div class="shared-row"><button class="btn primary" type="submit" disabled={busy || !state}>{selected ? "Save account changes" : "Create account"}</button><button class="btn" type="button" disabled={busy} onClick={() => void load()}>Reload accounts</button>{selected ? <button class="btn" type="button" disabled={busy || !state} onClick={async () => { setBusy(true); setError(""); try { setState(await post<SharedAccountState>(`/api/accounts/${enc(selected)}/revoke-sessions`, { revision: state!.revision })); setNotice("All sessions for this account were revoked."); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}>Sign out all sessions</button> : null}</div>
    {selected ? <div><button class="btn danger" type="button" disabled={busy || state.users.find(user => user.id === selected)?.enabled !== false} onClick={() => void remove()}>Delete account</button><p class="help">To free an account slot, disable this account and save first, then delete it. History remains attributed to its original identity.</p></div> : null}
    </form>{error ? <p role="alert" class="shared-error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}</section>;
}

/** The dashboard's hash route: a task or people address opens that page; every other address, the default one included, is the Board. */
const teamRouteOf = (hash = location.hash): TeamRoute => { const parsed = parseRouteHash(hash); return parsed.view === "team" || parsed.view === "team-task" || parsed.view === "team-people" ? parsed : { view: "team" }; };
export function SharedDashboard({ identity, onSignOut = reload }: { identity: SharedPrincipal; onSignOut?: () => void }) {
  const [joinNotice] = useState(() => { try { const message = sessionStorage.getItem("sharedJoinNotice") ?? ""; sessionStorage.removeItem("sharedJoinNotice"); return message; } catch { return ""; } });
  const [team, setTeam] = useState<TeamRoute>(() => teamRouteOf());
  useLayoutEffect(() => { const onHash = () => setTeam(teamRouteOf()); window.addEventListener("hashchange", onHash); onHash(); return () => window.removeEventListener("hashchange", onHash); }, []);
  const go = (to: TeamRoute) => { const hash = hashFor(to); if (location.hash === hash) setTeam(to); else location.hash = hash; };
  // The bell's count: read once with the page (which signed the session in anyway), then kept live by the board's event
  // stream. No timer asks the server for it: every request renews a shared session, and a dashboard left open must still
  // expire after 30 minutes idle.
  useEffect(() => { void loadInbox().catch(() => undefined); }, []);
  const unread = inboxUnread.value;
  const [error, setError] = useState(""); const [connection, setConnection] = useState("Connecting");
  // A stream's error (the session ended, or someone else signed in): the page follows whoever the cookie is now.
  const checkIdentity = () => void api<SharedPrincipal>("/api/auth/self").then((current) => { if (current.kind !== "shared" || current.revision !== identity.revision) reload(); }, () => {});
  const [streamReason, setStreamReason] = useState(""), [streamRetry, setStreamRetry] = useState(0);
  const streamState = (state: SharedStreamState, reason = "") => { setConnection(state === "connected" ? "Connected" : state === "limited" ? "Updates paused" : "Reconnecting"); setStreamReason(reason); if (state === "reconnecting") checkIdentity(); };
  // A paper page: the wordmark bar (live updates, inbox, sign out), then the team board.
  const live = connection === "Connected" ? "connected" : connection === "Connecting" ? "connecting" : "reconnecting";
  return <main class="shared-surface shared-page"><header class="shared-top"><span class="shared-brand">code<span>-flow</span></span><span class="spacer" /><span class={`connection-status ${live}`} role="status"><span class="cs-dot" aria-hidden="true" /><span class="cs-label">{connection}</span></span><button type="button" class="btn small shared-bell" aria-label={`Team inbox${unread ? `, ${unread} unread` : ""}`} title="Team inbox" onClick={() => { inboxOpen.value = true; go({ view: "team" }); }}><Icon name="bell" />{unread ? <span class="team-badge" aria-hidden="true">{unread}</span> : null}</button><button class="btn small" onClick={async () => { try { await post("/api/auth/logout"); onSignOut(); } catch (error) { setError(message(error)); } }}>Sign out {identity.displayName}</button></header>
    {streamReason ? <p class="msg warn" role="status">{streamReason} <button class="btn small" onClick={() => setStreamRetry(value => value + 1)}>Retry live updates</button></p> : null}
    {joinNotice ? <p class="msg" role="status">{joinNotice}</p> : null}
    {error ? <p role="alert" class="shared-error">{error}</p> : null}
    {Object.values(identity.roles).some(role => roleAtLeast(role, "contributor")) ? <details class="shared-connect-help"><summary>Connect your computer to run team tasks</summary><p class="help">In your own Code Flow, open Settings → Connections → Share access → Join a team. Paste this link, sign in as {identity.username}, and choose your repository folders. Work runs on your computer using your own agents.</p><button class="btn small" onClick={() => void copy(teamConnectionLink(location.origin, identity.username), "Connection link copied")}>Copy connection link</button></details> : null}
    <SharedTeam key={streamRetry} route={team} go={go} onState={streamState} />
  </main>;
}

/** The board, a task or the people page in shared mode, with the dashboard's one event stream (to the team API). */
function SharedTeam({ route, go, onState }: { route: TeamRoute; go: (to: TeamRoute) => void; onState: (state: SharedStreamState, reason?: string) => void }) {
  const state = useRef(onState); state.current = onState;
  useEffect(() => openTeamEvents((next, reason) => state.current(next, reason)), []);
  return <div class="shared-team">{route.view === "team-task" ? <TeamTaskView key={route.id} id={route.id} shared navigate={go} /> : route.view === "team-people" ? <TeamPeopleView project={route.project} shared navigate={go} /> : <TeamBoardView project={route.project} shared navigate={go} />}</div>;
}
