import { confirmAction } from "./confirm-state.js";
import { TeamTerminalSettings } from "./team-terminals.js";
import { HostExecutionSettings, HostQueue } from "./host-execution.js";
import { lazyView } from "./lazy-view.js";
const TeamServerWizard = lazyView(() => import("./team-server-wizard.js").then(module => module.TeamServerWizard));
import { SshTeamServerCard } from "./team-server-status.js";
import { TeamConnectionPicker, selectTeamConnection } from "./team-connections.js";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Board, BoardProject, RepoRef, RunnerPublic } from "../src/collab/model.js";
import { ApiError, api, copy, enc, post, showToast, usePoll, ownerOnLocalListener, selectedTeamConnection } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { executionHost } from "./ssh-projects.js";
import { repositoryChoice } from "./team-repository-choice.js";
import { parseTeamAddress, savedConnectionFor } from "./team-join-link.js";
import { collaborationHref } from "./lib.js";
import { repo, projects as localProjects, pickerChoose, pickerOpen } from "./state.js";
import { type TeamLinkInfo, STALE_REVISION, ago, board, boardError, del, loadBoard, loadTeamLink, memberName, put, teamLink, teamLinkError, teamServerAddress, teamTick } from "./collab-state.js";

/**
 * Connections → Share access: this computer's link to a team server, where its repository keys live on disk, the
 * team server's own settings (its address, accounts, your name, the repository keys per project) and the
 * runners the hub knows. Each card is a plain settings-card like the rest of Settings.
 */
export function TeamSettings() {
  const host = executionHost.value;
  const [setup, setSetup] = useState(false);
  usePoll(() => { void loadBoard(); void loadTeamLink(); }, 15_000, [teamTick.value]);
  const link = teamLink.value, b = board.value;
  if (setup && host.kind !== "host" && ownerOnLocalListener.value) return <TeamServerWizard onClose={() => { setSetup(false); void loadBoard(); }} />;
  if (host.kind === "ssh") return <>
    <SshTeamServerCard key={host.id} host={host} onManage={() => setSetup(true)} />
    <section class="settings-card"><h3>SSH workspace · {host.name}</h3><p class="help">The workspace you opened over SSH has its own projects and task board. Manage the shared team server’s projects, accounts and HTTPS in the setup above.</p><a class="btn" href="/#/settings/connections/join">Connect your computer to a team</a></section>
  </>;
  return <>
    {host.kind !== "host" && ownerOnLocalListener.value ? <section class="settings-card"><h3>Host a team</h3><p class="help">Set up a shared board on this computer or a connected remote server, with secure access and teammate accounts in one guided flow. Existing team connections stay connected.</p><button class="btn primary" onClick={() => setSetup(true)}>Set up team server</button></section> : null}
    {host.kind === "local" ? <TeamConnectionPicker /> : null}
    {host.kind === "local" && ownerOnLocalListener.value ? <ThisComputerCard link={link} /> : <section class="settings-card"><h3>This computer</h3><p class="help">A team link belongs to the computer whose agents run the work. Connect from the code-flow on your own computer; team connections are managed in CodeFlow on that computer.</p>{ownerOnLocalListener.value ? <p class="help">Use Set up team server to install a separate team server on a connected SSH machine. The wizard configures its projects, HTTPS and teammate accounts.</p> : null}</section>}
    {host.kind === "local" && ownerOnLocalListener.value ? <RepositoriesCard link={link} b={b} /> : null}
    <TeamServerCard link={link} b={b} />
    {b?.me.userId === "owner" && link && !link.linked ? <><HostExecutionSettings board={b} /><HostQueue board={b} /><TeamTerminalSettings board={b} /></> : null}
    {host.kind === "local" && link?.linked ? <section class="settings-card" aria-label="Local host administration"><h3>This computer’s host controls</h3><p class="help">Host execution, the host queue and teammate terminals belong to this computer’s own board. This tab currently shows a linked team.</p><button class="btn" onClick={() => selectTeamConnection("local")}>Manage this computer’s own board</button></section> : null}
    <RunnersCard b={b} />
  </>;
}

export function TeamJoinSettings({ connection }: { connection?: string }) {
  const [checkingSaved, setCheckingSaved] = useState(!!connection), [hintError, setHintError] = useState("");
  useEffect(() => {
    let current = true;
    if (!connection) { setCheckingSaved(false); return; }
    setCheckingSaved(true); setHintError("");
    void api<{ connections: (TeamLinkInfo & { id: string })[] }>("/api/team-link/connections").then(data => {
      if (!current) return;
      const id = savedConnectionFor(data.connections, connection);
      if (id && id !== selectedTeamConnection) { selectTeamConnection(id); return; }
      setCheckingSaved(false);
    }).catch(error => { if (current) { setHintError(error.message); setCheckingSaved(false); } });
    return () => { current = false; };
  }, [connection]);
  let focusProject: string | undefined;
  try { focusProject = connection ? parseTeamAddress(connection).project : undefined; } catch { /* The connect form explains invalid hints. */ }
  usePoll(() => { void loadBoard(); void loadTeamLink(); }, 15_000, [teamTick.value]);
  const link = teamLink.value, b = board.value;
  return <div class="team-join-settings"><TeamConnectionPicker hideWhenEmpty />{checkingSaved ? <p role="status">Checking saved team connections…</p> : <ThisComputerCard key={connection ?? "default"} link={link} initialConnection={connection} />}
    {hintError ? <p class="msg err" role="alert">{hintError}</p> : null}
    {link?.linked ? <section class="settings-card" aria-label="Project readiness"><h3>Your team projects</h3><p class="help">Your account is connected. Choose a local repository folder for each project you want to work on. Tasks you start here run on this computer.</p>
      {!b ? <p role="status">{boardError.value || "Loading your projects…"}</p> : !b.projects.length ? <p role="status">No projects have been shared with this account yet. Ask the owner for a project invitation.</p> : <ul class="join-project-list">{b.projects.filter(project => !focusProject || project.id === focusProject).map(project => {
        const missing = project.repositories.filter(repository => !link.mappings[project.id]?.[repository.key]);
        const canRun = roleAtLeast(project.role, "contributor");
        return <li key={project.id}><div><b>{project.name}</b><span class="help">{roleAtLeast(project.role, "maintainer") ? "Maintainer" : canRun ? "Contributor" : "Review access"} · {!canRun ? "Ready to review" : !project.repositories.length ? "Ask a maintainer to add a repository" : missing.length ? `Choose ${missing.length} local ${missing.length === 1 ? "folder" : "folders"} below` : "Repository selected"}</span></div><a class="btn small" href={collaborationHref(`#/team/project/${encodeURIComponent(project.id)}`)}>Open project board</a></li>;
      })}</ul>}
    </section> : null}
    {link?.linked && b && focusProject && !b.projects.some(project => project.id === focusProject) ? <p class="msg" role="status">This account no longer has access to the requested project. Ask the owner for an invitation, or <a href="#/settings/connections/join">choose another project</a>.</p> : null}
    {link?.linked ? <RepositoriesCard link={link} b={b} projectId={focusProject} /> : null}
  </div>;
}

function ThisComputerCard({ link, initialConnection = "" }: { link: TeamLinkInfo | null; initialConnection?: string }) {
  let initialUsername = ""; try { initialUsername = parseTeamAddress(initialConnection).username ?? ""; } catch { /* Validated before connection. */ }
  const [url, setUrl] = useState(initialConnection), [username, setUsername] = useState(initialUsername), [password, setPassword] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  let target: ReturnType<typeof parseTeamAddress> | undefined;
  try { if (url.trim()) target = parseTeamAddress(url); } catch { /* Explain validation on submit, not each keystroke. */ }
  useEffect(() => { if (link && !link.linked && !name && link.machineName) setName(link.machineName); }, [link?.machineName]);
  const connect = async (event: Event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { const address = parseTeamAddress(url); if (address.invitation) throw new Error("Open the invitation first to join the project and choose your account."); const connected = await post<{ id: string }>("/api/team-link/connect", { url: address.url, username: username.trim(), password, ...(name.trim() ? { name: name.trim() } : {}) }); setPassword(""); showToast("Connected to the team server"); location.hash = address.project ? `#/settings/connections/join?connection=${encodeURIComponent(url)}` : "#/settings/connections/join"; selectTeamConnection(connected.id); }
    catch (err) { setPassword(""); setError((err as Error).message); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!link || !await confirmAction(`Disconnect this computer from ${link.hubName || link.url || "the team server"}? Its runner credential is revoked; attempts you ran here stay on the board as they are.`, {"title":"Disconnect this computer?","confirmLabel":"Disconnect","danger":true})) return;
    setBusy(true); setError("");
    try { await del("/api/team-link"); showToast("Disconnected"); selectTeamConnection("local"); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <section class="settings-card" aria-busy={busy}>
    <h3>{link?.linked && !adding ? "This computer" : "Connect to your team"}</h3>
    {!link ? <p class="help">{teamLinkError.value ? `The team link could not be read: ${teamLinkError.value}` : "Loading…"}</p> : link.linked && !adding ? <>
      <p class="help">{link.revoked ? "This computer’s team access is no longer valid. Disconnect this saved connection, then connect again with an active team account." : "Connected to your team server. Choose your repository folder below, then open your project. Tasks use this computer’s coding agents."}</p>
      <dl class="team-kv">
        <dt>Connection</dt><dd><span class={`badge ${link.connection === "connected" ? "ok" : "warn"}`}>{link.revoked ? "Access revoked" : link.connection === "connected" ? "Connected" : link.connection === "reconnecting" ? "Reconnecting…" : link.connection === "offline" ? "Offline" : "Checking…"}</span></dd>
        <dt>Team server</dt><dd><code>{link.url}</code>{link.hubName ? ` · ${link.hubName}` : ""}</dd>
        <dt>Signed in as</dt><dd>{link.user ? `${link.user.displayName} (${link.user.username})` : "unknown"}</dd>
        <dt>Machine name</dt><dd>{link.machineName ?? link.runner?.name ?? "—"}</dd>
        <dt>Computer connection</dt><dd>{link.revoked ? <span class="badge warn">Access revoked</span> : link.runner ? <><span class={`badge ${link.runner.revokedAt ? "warn" : link.runner.online ? "ok" : ""}`}>{link.runner.revokedAt ? "Revoked" : link.runner.online ? "Online" : "Offline"}</span> <span class="help">last seen {ago(link.runner.lastSeenAt)}</span></> : <span class="help">Not reported yet</span>}</dd>
        {link.lastSync ? <><dt>Last sync</dt><dd>{ago(link.lastSync)}</dd></> : null}
      </dl>
      {link.error ? <p class="msg err" role="alert">{link.error}</p> : null}
      <div class="settings-actions">{!link.revoked ? <button class="btn primary" disabled={busy} onClick={() => setAdding(true)}>Add team connection</button> : null}<button class="btn" disabled={busy} onClick={() => void disconnect()}>{link.revoked ? "Disconnect to reconnect" : "Disconnect this team"}</button></div>
    </> : <form class="team-connect" onSubmit={(event) => void connect(event)}>
      <p class="help">Connect with the account you created from your invitation. Your coding agents and repository stay on this computer.</p>
      <div class="settings-grid">
        <label>Team server URL<input class="field" type="url" required placeholder="Paste a team address, invitation or connection link" value={url} disabled={busy} autoComplete="url" onInput={(event) => { const value = event.currentTarget.value; setUrl(value); try { const address = parseTeamAddress(value); if (address.username) setUsername(address.username); } catch { /* Validate on submit. */ } }} /></label>
        {!target?.invitation ? <><label>Username<input class="field" required maxLength={64} value={username} disabled={busy} autoComplete="username" onInput={(event) => setUsername(event.currentTarget.value)} /></label>
        <label>Password<input class="field" type="password" required value={password} disabled={busy} autoComplete="current-password" onInput={(event) => setPassword(event.currentTarget.value)} /></label>
        <label>Machine name<input class="field" maxLength={80} value={name} disabled={busy} placeholder="How teammates see this computer" onInput={(event) => setName(event.currentTarget.value)} /></label></> : null}
      </div>
      {target?.invitation ? <div><p class="help">First accept the invitation on {target.url}. Then return here with your account to connect this computer.</p><a class="btn primary" href={target.invitation} target="_blank" rel="noreferrer">Open invitation</a></div> : <><p class="help">Connect to your team’s Wi-Fi or Tailscale network first. After signing in, choose your local repository folders.</p><div class="settings-actions"><button type="submit" class="btn primary" disabled={busy || !url.trim() || !username.trim() || !password}>{busy ? "Connecting…" : "Connect this computer"}</button></div></>}
      {adding ? <button type="button" class="btn" onClick={() => setAdding(false)}>Cancel</button> : null}
    </form>}
    {error ? <><p class="msg err" role="alert">{error}</p><p class="help">Check the team server address and your account details. If the server cannot be reached, start it and connect to your team’s Wi-Fi or Tailscale network, then try again.</p></> : null}
  </section>;
}

/** Repository keys are shared names; each computer says which of its folders a key means. */
function RepositoriesCard({ link, b, projectId }: { link: TeamLinkInfo | null; b: Board | null; projectId?: string }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const rows = (b?.projects ?? []).filter(project => (!projectId || project.id === projectId) && roleAtLeast(project.role, "contributor")).flatMap((project) => project.repositories.map((ref) => ({ project, ref, key: `${project.id}/${ref.key}`, saved: link?.mappings[project.id]?.[ref.key] ?? "" })));
  const save = async (projectId: string, repository: string, path: string, key: string) => {
    if (busy) return; setBusy(key); setError("");
    try { await put("/api/team-link/mappings", { projectId, repository, path }); showToast("Repository selected"); await loadTeamLink(); setDrafts((current) => { const next = { ...current }; delete next[key]; return next; }); } catch (err) { setError((err as Error).message); } finally { setBusy(""); }
  };
  return <section class="settings-card"><h3>Repositories</h3>
    <p class="help">Choose your existing clone for each repository. Code Flow checks that the folder is a Git repository when you save it. Folder paths stay on this computer.</p>
    {!b ? <p class="help">{boardError.value || "Loading the board…"}</p> : !rows.length ? <p class="help">No coding repositories to connect here. A project maintainer can add repository details.</p> : <div class="team-mappings">
      {rows.map(({ project, ref, key, saved }) => { const value = drafts[key] ?? saved, dirty = value !== saved, id = `team-map-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`; return <div key={key} class="team-mapping">
        <label for={id}>{project.name} · {ref.label}{ref.remote ? <span class="help"> {ref.remote}</span> : null}</label>
        <div class="row-inline"><input id={id} class="field mono" placeholder="/absolute/path/to/your/clone" value={value} disabled={!!busy} onInput={(event) => setDrafts({ ...drafts, [key]: event.currentTarget.value })} /><button type="button" class="btn small" disabled={!!busy} onClick={() => { pickerChoose.value = { title: `Choose ${ref.label} repository`, choose: path => setDrafts(current => ({ ...current, [key]: path })) }; pickerOpen.value = true; }}>Choose repository folder</button><button type="button" class="btn small" disabled={!!busy || !repo.value} title={repo.value || "Choose a repository in the composer first"} onClick={() => setDrafts({ ...drafts, [key]: repo.value })}>Use current repository</button><button type="button" class="btn small primary" disabled={!!busy || !dirty || !value.trim()} onClick={() => void save(project.id, ref.key, value.trim(), key)}>{busy === key ? "Saving…" : "Save"}</button></div>
        {[...new Set(localProjects.value.flatMap(p => p.repos))].filter(path => path.split(/[\\/]/).pop()?.toLowerCase() === ref.label.toLowerCase() && path !== value).map(path => <button class="btn small" type="button" onClick={() => setDrafts(current => ({ ...current, [key]: path }))}>Use detected folder: {path}</button>)}
        {saved && !dirty ? <span class="help">Repository selected</span> : null}
        {!saved && !dirty ? <span class="help">Choose a repository folder on this computer.</span> : null}
      </div>; })}
    </div>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}

/** What GET /api/remote reports: `tailscaleUrl` is the phone link (with a secret path), `secure` whether the listener has TLS; the card shows only the origin, and only over HTTPS (see teamServerAddress). */
interface RemoteInfo { enabled?: boolean; lan?: boolean; transport?: string; tailscaleUrl?: string; lanUrls?: string[]; secure?: boolean }
function TeamServerCard({ link, b }: { link: TeamLinkInfo | null; b: Board | null }) {
  const hub = !!link && !link.linked;
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  usePoll(async (current) => { if (!hub) return; try { const info = await api<RemoteInfo>("/api/remote"); if (current()) setRemote(info); } catch { if (current()) setRemote(null); } }, 30_000, [hub], hub);
  useEffect(() => { if (b && b.me.userId === "owner") setName(b.me.displayName); }, [b?.me.displayName]);
  const maintained = (b?.projects ?? []).filter((project) => roleAtLeast(project.role, "maintainer"));
  const address = teamServerAddress(remote);
  return <section class="settings-card"><h3>Team server</h3>
    {!link ? <p class="help">Loading…</p> : hub ? <>
      <p class="help">This computer is a team server: teammates reach its board over HTTPS with shared accounts, and work runs on their own computers or through the host permissions below.</p>
      <dl class="team-kv">
        <dt>Address</dt><dd>{address ? <><code>{address}</code> <button type="button" class="btn small" onClick={() => void copy(address, "Address copied")}>Copy</button><span class="help"> Teammates enter this address under Connections → Share access → Join a team. Never share the phone link from Settings → Connections → Share access → Connect my devices: its path is a secret.</span></>
          : remote?.tailscaleUrl || remote?.lanUrls?.length ? <span class="help">Remote access is on without HTTPS. <a href="#/settings/connections/devices">Set up secure remote access in Settings → Connections → Share access → Connect my devices</a>: teammates sign in and connect their computers over https:// only.</span>
          : <span class="help"><a href="#/settings/connections/devices">Turn on secure remote access in Settings → Connections → Share access → Connect my devices</a> so teammates can reach this computer.</span>}</dd>
        <dt>Accounts</dt><dd><a class="btn small" href="#/settings/connections/manage">Accounts &amp; roles</a><span class="help"> Give teammates the contributor role to own and run tasks, maintainer to manage project repository keys. Only the hub owner manages other accounts’ runners.</span></dd>
      </dl>
      {b?.me.userId === "owner" ? <form class="team-inline" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); try { await put("/api/team/profile", { displayName: name.trim() }); showToast("Name saved"); void loadBoard(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><label>Your name on the board<input class="field" required maxLength={120} value={name} disabled={busy} onInput={(event) => setName(event.currentTarget.value)} /></label><button type="submit" class="btn small" disabled={busy || !name.trim() || name.trim() === b.me.displayName}>Save name</button></form> : null}
    </> : <p class="help">This computer is linked to {link.hubName || link.url}: the board, the accounts and the runners live there.{maintained.length ? " As a maintainer you can edit repository keys below." : ""}</p>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {b && maintained.map((project) => <RepoKeysEditor key={project.id} project={project} revision={b.revision} />)}
    {b && link && !maintained.length ? <p class="help">{hub ? "Create a project to define its repository keys." : "Repository keys are edited by project maintainers."}</p> : null}
  </section>;
}

/** The repository keys of one project: short names teammates map to their own clones. */
export function RepoKeysEditor({ project, revision }: { project: BoardProject; revision: number }) {
  const [rows, setRows] = useState<RepoRef[]>(project.repositories.map((ref) => ({ ...ref })));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saved = JSON.stringify(project.repositories), dirty = JSON.stringify(rows) !== saved;
  // Someone else saved keys (or ours came back): an untouched draft follows; one being edited keeps its rows and may meet a stale-revision 409, which reloads the board. Any other refusal (a key a task still uses) keeps the draft and says why.
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => { if (!dirtyRef.current) setRows(project.repositories.map((ref) => ({ ...ref }))); }, [saved]);
  const update = (index: number, patch: Partial<RepoRef>) => setRows(rows.map((row, at) => at === index ? { ...row, ...patch } : row));
  const save = async () => {
    if (busy) return; setBusy(true); setError("");
    const repositories = rows.map((row) => ({ key: row.key.trim(), label: row.label.trim() || row.key.trim(), ...(row.remote?.trim() ? { remote: row.remote.trim() } : {}), ...(row.defaultBranch?.trim() ? { defaultBranch: row.defaultBranch.trim() } : {}) }));
    try { await put(`/api/team/projects/${enc(project.id)}/repositories`, { repositories, revision }); showToast("Repositories saved"); void loadBoard(); }
    catch (err) { if (err instanceof ApiError && err.status === 409 && err.code === STALE_REVISION) { showToast("Board changed; reloading", 3000); void loadBoard(); } else { setError((err as Error).message); if (err instanceof ApiError && err.status === 409) void loadBoard(); } }
    finally { setBusy(false); }
  };
  const id = (index: number, field: string) => `team-keys-${project.id}-${index}-${field}`;
  return <fieldset class="team-keys" disabled={busy}><legend>Repositories · {project.name}</legend>
    <p class="help">Give each repository a name. Add its Git URL to help teammates find their clone.</p>
    {rows.map((row, index) => <div key={index} class="team-key-row">
      <label for={id(index, "label")}>Repository name</label><input id={id(index, "label")} class="field" required maxLength={80} value={row.label} onInput={event => update(index, { label: event.currentTarget.value, ...(!project.repositories.some(saved => saved.key === row.key) ? { key: repositoryChoice(event.currentTarget.value, rows.filter((_, at) => at !== index).map(row => row.key)).key } : {}) })} />
      <label for={id(index, "remote")}>Git URL</label><input id={id(index, "remote")} class="field mono" maxLength={300} placeholder="git@github.com:org/repo.git" value={row.remote ?? ""} onInput={(event) => update(index, { remote: event.currentTarget.value })} />
      <label for={id(index, "branch")}>Default branch</label><input id={id(index, "branch")} class="field mono" maxLength={100} placeholder="main" value={row.defaultBranch ?? ""} onInput={(event) => update(index, { defaultBranch: event.currentTarget.value })} />
      <details class="repository-identifier"><summary>Advanced repository identifier</summary><label for={id(index, "key")}>Key</label><input id={id(index, "key")} class="field mono" required pattern={"[a-z][a-z0-9\\-]{0,63}"} maxLength={64} value={row.key} onInput={event => update(index, { key: event.currentTarget.value })} /><p class="help">Changing an existing identifier requires teammates to select their repository folders again.</p></details>
      <button type="button" class="btn small ghost" aria-label={`Remove repository key ${row.key || index + 1}`} onClick={() => setRows(rows.filter((_, at) => at !== index))}>Remove</button>
    </div>)}
    <div class="settings-actions">
      <button type="button" class="btn small" disabled={rows.length >= 50} onClick={() => setRows([...rows, { key: "", label: "" }])}>Add repository</button>
      <button type="button" class="btn small primary" disabled={!dirty || rows.some((row) => !/^[a-z][a-z0-9-]{0,63}$/.test(row.key.trim()))} onClick={() => void save()}>Save repositories</button>
      {dirty ? <button type="button" class="btn small" onClick={() => setRows(project.repositories.map((ref) => ({ ...ref })))}>Discard</button> : null}
    </div>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </fieldset>;
}

function RunnersCard({ b }: { b: Board | null }) {
  const [runners, setRunners] = useState<RunnerPublic[] | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const load = async (current: () => boolean = () => true) => { try { const data = await api<RunnerPublic[] | { runners?: RunnerPublic[] }>("/api/team/runners"); if (current()) { setRunners(Array.isArray(data) ? data : data.runners ?? []); setError(""); } } catch (err) { if (current()) setError((err as Error).message); } };
  usePoll(load, 15_000, [teamTick.value]);
  const revoke = async (runner: RunnerPublic) => {
    if (!await confirmAction(`Revoke the runner ${runner.name}? Its computer must connect again to work on the board. Active tasks stay reserved until execution is confirmed stopped.`, {"title":"Revoke runner access?","confirmLabel":"Revoke access","danger":true})) return;
    setBusy(runner.id); setError("");
    try { await del(`/api/team/runners/${enc(runner.id)}`); showToast("Runner revoked"); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(""); }
  };
  const list = (runners ?? []).slice().sort((x, y) => Number(!!x.revokedAt) - Number(!!y.revokedAt) || y.lastSeenAt - x.lastSeenAt);
  return <section class="settings-card"><h3>Connected computers</h3>
    <p class="help">The computers connected to the board{b?.me.userId === "owner" ? " (every teammate's, as the team server's owner)" : " with your account"}. Revoking one ends its credential; the work it did stays.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {runners === null && !error ? <p class="help" role="status">Loading…</p> : null}
    {runners && !runners.length ? <p class="help">No computer has connected yet.</p> : null}
    {list.length ? <div class="pd-list">{list.map((runner) => <div key={runner.id} class="pd-row"><span class="pd-name">{runner.name}</span><span class={`badge ${runner.revokedAt ? "warn" : runner.online ? "ok" : ""}`}>{runner.revokedAt ? "Revoked" : runner.online ? "Online" : "Offline"}</span><span class="pd-when">{memberName(b, runner.userId)} · last seen {ago(runner.lastSeenAt)}</span>{runner.revokedAt ? null : <button type="button" class="btn small" disabled={!!busy} onClick={() => void revoke(runner)}>{busy === runner.id ? "Revoking…" : "Revoke"}</button>}</div>)}</div> : null}
  </section>;
}
