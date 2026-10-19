import { useEffect, useRef, useState } from "preact/hooks";
import type { Board, BoardProject, RepoRef, RunnerPublic } from "../src/collab/model.js";
import { ApiError, api, copy, enc, post, showToast, usePoll } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { executionHost } from "./ssh-projects.js";
import { repo } from "./state.js";
import { type TeamLinkInfo, ago, board, boardError, del, loadBoard, loadTeamLink, memberName, put, teamLink, teamLinkError, teamServerAddress, teamTick } from "./collab-state.js";

/**
 * Settings → Team: this computer's link to a team server, where its repository keys live on disk, the
 * team server's own settings (its address, accounts, your name, the repository keys per project) and the
 * runners the hub knows. Each card is a plain settings-card like the rest of Settings.
 */
export function TeamSettings() {
  const host = executionHost.value;
  usePoll(() => { void loadBoard(); void loadTeamLink(); }, 15_000, [teamTick.value]);
  const link = teamLink.value, b = board.value;
  return <>
    {host.kind === "local" ? <ThisComputerCard link={link} /> : <section class="settings-card"><h3>This computer</h3><p class="help">A team link belongs to the computer whose agents run the work. Connect from the code-flow on your own computer; this workspace runs on {host.kind === "ssh" ? host.name : "a remote server"}.</p>{host.kind === "ssh" ? <a class="btn" href="/#/settings/team">Back to this computer</a> : null}</section>}
    {host.kind === "local" ? <RepositoriesCard link={link} b={b} /> : null}
    <TeamServerCard link={link} b={b} />
    <RunnersCard b={b} />
  </>;
}

function ThisComputerCard({ link }: { link: TeamLinkInfo | null }) {
  const [url, setUrl] = useState(""), [username, setUsername] = useState(""), [password, setPassword] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { if (link && !link.linked && !name && link.machineName) setName(link.machineName); }, [link?.machineName]);
  const connect = async (event: Event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { await post("/api/team-link/connect", { url: url.trim(), username: username.trim(), password, ...(name.trim() ? { name: name.trim() } : {}) }); setPassword(""); showToast("Connected to the team server"); await Promise.all([loadTeamLink(), loadBoard()]); }
    catch (err) { setPassword(""); setError((err as Error).message); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!link || !confirm(`Disconnect this computer from ${link.hubName || link.url || "the team server"}? Its runner credential is revoked; attempts you ran here stay on the board as they are.`)) return;
    setBusy(true); setError("");
    try { await del("/api/team-link"); showToast("Disconnected"); await Promise.all([loadTeamLink(), loadBoard()]); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <section class="settings-card" aria-busy={busy}>
    <h3>This computer</h3>
    {!link ? <p class="help">{teamLinkError.value ? `The team link could not be read: ${teamLinkError.value}` : "Loading…"}</p> : link.linked ? <>
      <p class="help">Linked to a team server: its board shows under Team, and tasks you start here publish their progress and checkpoints to it.</p>
      <dl class="team-kv">
        <dt>Team server</dt><dd><code>{link.url}</code>{link.hubName ? ` · ${link.hubName}` : ""}</dd>
        <dt>Signed in as</dt><dd>{link.user ? `${link.user.displayName} (${link.user.username})` : "unknown"}</dd>
        <dt>Machine name</dt><dd>{link.machineName ?? link.runner?.name ?? "—"}</dd>
        <dt>Runner</dt><dd>{link.runner ? <><span class={`badge ${link.runner.revokedAt ? "warn" : link.runner.online ? "ok" : ""}`}>{link.runner.revokedAt ? "Revoked" : link.runner.online ? "Online" : "Offline"}</span> <span class="help">last seen {ago(link.runner.lastSeenAt)}</span></> : <span class="help">Not reported yet</span>}</dd>
        {link.lastSync ? <><dt>Last sync</dt><dd>{ago(link.lastSync)}</dd></> : null}
      </dl>
      {link.error ? <p class="msg err" role="alert">{link.error}</p> : null}
      <div class="settings-actions"><button class="btn" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></div>
    </> : <form class="team-connect" onSubmit={(event) => void connect(event)}>
      <p class="help">Join a teammate's board: the team server is another code-flow reachable over Tailscale (HTTPS), and you sign in with the shared account its owner created for you with the contributor or maintainer role. This computer stays the only place your agents run. Linking is possible while this computer's own board holds no tasks.</p>
      <div class="settings-grid">
        <label>Team server URL<input class="field" type="url" required placeholder="https://hub.your-tailnet.ts.net:4318" value={url} disabled={busy} autoComplete="url" onInput={(event) => setUrl(event.currentTarget.value)} /></label>
        <label>Username<input class="field" required maxLength={64} value={username} disabled={busy} autoComplete="username" onInput={(event) => setUsername(event.currentTarget.value)} /></label>
        <label>Password<input class="field" type="password" required value={password} disabled={busy} autoComplete="current-password" onInput={(event) => setPassword(event.currentTarget.value)} /></label>
        <label>Machine name<input class="field" maxLength={80} value={name} disabled={busy} placeholder="How teammates see this computer" onInput={(event) => setName(event.currentTarget.value)} /></label>
      </div>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      <div class="settings-actions"><button type="submit" class="btn primary" disabled={busy || !url.trim() || !username.trim() || !password}>{busy ? "Connecting…" : "Connect this computer"}</button></div>
    </form>}
  </section>;
}

/** Repository keys are shared names; each computer says which of its folders a key means. */
function RepositoriesCard({ link, b }: { link: TeamLinkInfo | null; b: Board | null }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const rows = (b?.projects ?? []).flatMap((project) => project.repositories.map((ref) => ({ project, ref, key: `${project.id}/${ref.key}`, saved: link?.mappings[project.id]?.[ref.key] ?? "" })));
  const save = async (projectId: string, repository: string, path: string, key: string) => {
    if (busy) return; setBusy(key); setError("");
    try { await put("/api/team-link/mappings", { projectId, repository, path }); showToast("Repository mapped"); await loadTeamLink(); setDrafts((current) => { const next = { ...current }; delete next[key]; return next; }); } catch (err) { setError((err as Error).message); } finally { setBusy(""); }
  };
  return <section class="settings-card"><h3>Repositories</h3>
    <p class="help">Tasks name a repository by its key; map each key to your clone so attempts, hand-overs and fetched checkpoints land there. Paths stay on this computer and never reach the team server.</p>
    {!b ? <p class="help">{boardError.value || "Loading the board…"}</p> : !rows.length ? <p class="help">No repository keys yet. A maintainer defines them per project{link?.linked ? " on the team server" : " in the Team server card below"}.</p> : <div class="team-mappings">
      {rows.map(({ project, ref, key, saved }) => { const value = drafts[key] ?? saved, dirty = value !== saved, id = `team-map-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`; return <div key={key} class="team-mapping">
        <label for={id}>{project.name} · {ref.label} <code>{ref.key}</code>{ref.remote ? <span class="help"> {ref.remote}</span> : null}</label>
        <div class="row-inline"><input id={id} class="field mono" placeholder="/absolute/path/to/your/clone" value={value} disabled={!!busy} onInput={(event) => setDrafts({ ...drafts, [key]: event.currentTarget.value })} /><button type="button" class="btn small" disabled={!!busy || !repo.value} title={repo.value || "Choose a repository in the composer first"} onClick={() => setDrafts({ ...drafts, [key]: repo.value })}>Use current repository</button><button type="button" class="btn small primary" disabled={!!busy || !dirty || !value.trim()} onClick={() => void save(project.id, ref.key, value.trim(), key)}>{busy === key ? "Saving…" : "Save"}</button></div>
        {!saved && !dirty ? <span class="help">Not mapped on this computer.</span> : null}
      </div>; })}
    </div>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}

/** What GET /api/remote reports: `tailscaleUrl` is the phone link (with a secret path), `secure` whether the listener has TLS; the card shows only the origin, and only over HTTPS (see teamServerAddress). */
interface RemoteInfo { enabled?: boolean; lan?: boolean; transport?: string; tailscaleUrl?: string; secure?: boolean }
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
      <p class="help">This computer is a team server: teammates reach its board over Tailscale with shared accounts, and their own computers run the work.</p>
      <dl class="team-kv">
        <dt>Address</dt><dd>{address ? <><code>{address}</code> <button type="button" class="btn small" onClick={() => void copy(address, "Address copied")}>Copy</button><span class="help"> Teammates enter this address under Settings → Team → Connect this computer. Never share the phone link from Settings → Remote access: its path is a secret.</span></>
          : remote?.tailscaleUrl ? <span class="help">Remote access is on without HTTPS. <a href="#/settings/remote-access">Set up secure remote access in Settings → Remote access</a>: teammates sign in and connect their computers over https:// only.</span>
          : <span class="help"><a href="#/settings/remote-access">Turn on remote access over Tailscale in Settings → Remote access</a> so teammates can reach this computer.</span>}</dd>
        <dt>Accounts</dt><dd><a class="btn small" href="#/settings/projects">Accounts &amp; roles</a><span class="help"> Give teammates the contributor role to own and run tasks, maintainer to manage project repository keys. Only the hub owner manages other accounts’ runners.</span></dd>
      </dl>
      {b?.me.userId === "owner" ? <form class="team-inline" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); try { await put("/api/team/profile", { displayName: name.trim() }); showToast("Name saved"); void loadBoard(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><label>Your name on the board<input class="field" required maxLength={120} value={name} disabled={busy} onInput={(event) => setName(event.currentTarget.value)} /></label><button type="submit" class="btn small" disabled={busy || !name.trim() || name.trim() === b.me.displayName}>Save name</button></form> : null}
    </> : <p class="help">This computer is linked to {link.hubName || link.url}: the board, the accounts and the runners live there.{maintained.length ? " As a maintainer you can edit repository keys below." : ""}</p>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {b && maintained.map((project) => <RepoKeysEditor key={project.id} project={project} revision={b.revision} />)}
    {b && link && !maintained.length ? <p class="help">{hub ? "Create a project to define its repository keys." : "Repository keys are edited by project maintainers."}</p> : null}
  </section>;
}

/** The repository keys of one project: short names teammates map to their own clones. */
function RepoKeysEditor({ project, revision }: { project: BoardProject; revision: number }) {
  const [rows, setRows] = useState<RepoRef[]>(project.repositories.map((ref) => ({ ...ref })));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saved = JSON.stringify(project.repositories), dirty = JSON.stringify(rows) !== saved;
  // Someone else saved keys (or ours came back): an untouched draft follows; one being edited keeps its rows and may meet a 409.
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => { if (!dirtyRef.current) setRows(project.repositories.map((ref) => ({ ...ref }))); }, [saved]);
  const update = (index: number, patch: Partial<RepoRef>) => setRows(rows.map((row, at) => at === index ? { ...row, ...patch } : row));
  const save = async () => {
    if (busy) return; setBusy(true); setError("");
    const repositories = rows.map((row) => ({ key: row.key.trim(), label: row.label.trim() || row.key.trim(), ...(row.remote?.trim() ? { remote: row.remote.trim() } : {}), ...(row.defaultBranch?.trim() ? { defaultBranch: row.defaultBranch.trim() } : {}) }));
    try { await put(`/api/team/projects/${enc(project.id)}/repositories`, { repositories, revision }); showToast("Repository keys saved"); void loadBoard(); }
    catch (err) { if (err instanceof ApiError && err.status === 409) { showToast("Board changed; reloading", 3000); void loadBoard(); } else setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const id = (index: number, field: string) => `team-keys-${project.id}-${index}-${field}`;
  return <fieldset class="team-keys" disabled={busy}><legend>Repository keys · {project.name}</legend>
    <p class="help">A key is up to 64 lowercase letters, digits or dashes and starts with a letter; the remote and default branch are hints for teammates.</p>
    {rows.map((row, index) => <div key={index} class="team-key-row">
      <label for={id(index, "key")}>Key</label><input id={id(index, "key")} class="field mono" required pattern="[a-z][a-z0-9-]{0,63}" maxLength={64} value={row.key} onInput={(event) => update(index, { key: event.currentTarget.value })} />
      <label for={id(index, "label")}>Label</label><input id={id(index, "label")} class="field" maxLength={80} value={row.label} onInput={(event) => update(index, { label: event.currentTarget.value })} />
      <label for={id(index, "remote")}>Remote</label><input id={id(index, "remote")} class="field mono" maxLength={300} placeholder="git@github.com:org/repo.git" value={row.remote ?? ""} onInput={(event) => update(index, { remote: event.currentTarget.value })} />
      <label for={id(index, "branch")}>Default branch</label><input id={id(index, "branch")} class="field mono" maxLength={100} placeholder="main" value={row.defaultBranch ?? ""} onInput={(event) => update(index, { defaultBranch: event.currentTarget.value })} />
      <button type="button" class="btn small ghost" aria-label={`Remove repository key ${row.key || index + 1}`} onClick={() => setRows(rows.filter((_, at) => at !== index))}>Remove</button>
    </div>)}
    <div class="settings-actions">
      <button type="button" class="btn small" disabled={rows.length >= 50} onClick={() => setRows([...rows, { key: "", label: "" }])}>Add repository</button>
      <button type="button" class="btn small primary" disabled={!dirty || rows.some((row) => !/^[a-z][a-z0-9-]{0,63}$/.test(row.key.trim()))} onClick={() => void save()}>Save repository keys</button>
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
    if (!confirm(`Revoke the runner ${runner.name}? Its computer must connect again to work on the board. Active tasks stay reserved until execution is confirmed stopped.`)) return;
    setBusy(runner.id); setError("");
    try { await del(`/api/team/runners/${enc(runner.id)}`); showToast("Runner revoked"); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(""); }
  };
  const list = (runners ?? []).slice().sort((x, y) => Number(!!x.revokedAt) - Number(!!y.revokedAt) || y.lastSeenAt - x.lastSeenAt);
  return <section class="settings-card"><h3>Runners</h3>
    <p class="help">The computers connected to the board{b?.me.userId === "owner" ? " (every teammate's, as the team server's owner)" : " with your account"}. Revoking one ends its credential; the work it did stays.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {runners === null && !error ? <p class="help" role="status">Loading…</p> : null}
    {runners && !runners.length ? <p class="help">No runner has connected yet.</p> : null}
    {list.length ? <div class="pd-list">{list.map((runner) => <div key={runner.id} class="pd-row"><span class="pd-name">{runner.name}</span><span class={`badge ${runner.revokedAt ? "warn" : runner.online ? "ok" : ""}`}>{runner.revokedAt ? "Revoked" : runner.online ? "Online" : "Offline"}</span><span class="pd-when">{memberName(b, runner.userId)} · last seen {ago(runner.lastSeenAt)}</span>{runner.revokedAt ? null : <button type="button" class="btn small" disabled={!!busy} onClick={() => void revoke(runner)}>{busy === runner.id ? "Revoking…" : "Revoke"}</button>}</div>)}</div> : null}
  </section>;
}
