import { confirmAction } from "./confirm-state.js";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Board, RepoRef } from "../src/collab/model.js";
import type { SharedAccountState, SharedRole } from "../src/shared-accounts.js";
import type { Project } from "./types.js";
import { ApiError, copy, localApi, workspaceId } from "./lib.js";
import { loadProjects, repo } from "./state.js";
import { teamServerAddress } from "./collab-state.js";
import { SecureRemoteSetup, type RemoteInfo } from "./remote-access.js";
import { selectTeamConnection } from "./team-connections.js";
import { repositoryChoice } from "./team-repository-choice.js";

const STEPS = ["Project", "Repositories", "Secure access", "Teammates", "Share"];
const blankRepo = (): RepoRef => ({ key: "app", label: "App", defaultBranch: "main" });
const canRun = (role?: SharedRole) => role === "contributor" || role === "maintainer";

interface Autostart { supported: boolean; enabled: boolean; unitEnabled?: boolean; message: string; command?: string }
interface SetupHost { id: string; name: string; state: string }
export function TeamServerWizard({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<SetupHost[]>([]), [target, setTarget] = useState(workspaceId ?? "local");
  const [prepared, setPrepared] = useState("local"), [busy, setBusy] = useState(false), [childBusy, setChildBusy] = useState(false);
  const [error, setError] = useState(""), [port, setPort] = useState("4318"), [installed, setInstalled] = useState(false);
  const [autostart, setAutostart] = useState<Autostart | null>(null);
  const [startupError, setStartupError] = useState("");
  const [versionNote, setVersionNote] = useState("");
  const hostName = hosts.find((host) => host.id === target)?.name ?? "Remote server";
  const prefix = `/api/ssh-hosts/${target}/team-server`;
  const refresh = async () => { try { setHosts((await localApi<{ hosts: SetupHost[] }>("/api/ssh-hosts")).hosts); setError(""); } catch (err) { setError((err as Error).message); } };
  useEffect(() => { void refresh(); }, []);
  const startup = async (action = "status") => {
    setStartupError("");
    try { setAutostart(await localApi<Autostart>(prefix + "/autostart", action === "status" ? {} : { method: "POST", body: JSON.stringify({ action }) })); }
    catch (err) { setAutostart(null); setStartupError((err as Error).message); }
  };
  const changeStartup = async (action: string) => {
    if (busy || childBusy) return; setBusy(true);
    try { await startup(action); } finally { setBusy(false); }
  };
  const prepare = async () => {
    if (busy) return; setBusy(true); setError("");
    try {
      if (hosts.find((host) => host.id === target)?.state !== "connected") {
        await localApi(`/api/ssh-hosts/${target}/connect`, { method: "POST", body: "{}" });
        await refresh();
      }
      const result = await localApi<{ remotePort: number; currentVersion: boolean }>(prefix, { method: "POST", body: JSON.stringify({ remotePort: Number(port) }) });
      setPort(String(result.remotePort)); setInstalled(true);
      setVersionNote(result.currentVersion ? "" : "A newer Code Flow version is available. You can edit the current settings, or stop the server and start it again to update. Saved projects and accounts stay in place.");
      setPrepared(target);
      await startup();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (busy || !await confirmAction(`Stop the team server on ${hostName}? Teammates will lose access until it is started again. Saved projects and accounts stay in place. Automatic startup, if enabled, will still apply at the next reboot.`, {"title":"Stop team server?","confirmLabel":"Stop server","danger":true})) return;
    setBusy(true); setError("");
    try { await localApi(prefix, { method: "DELETE" }); setPrepared(""); setInstalled(false); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <>
    <section class="settings-card" aria-label="Team server location">
      <h3>Where should the team server run?</h3>
      <label>Server<select class="field" aria-label="Server" disabled={busy || childBusy} value={target} onChange={(event) => { setTarget(event.currentTarget.value); setPrepared("local"); setInstalled(false); setAutostart(null); setStartupError(""); setPort("4318"); setError(""); }}><option value="local">This computer</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}{host.state !== "connected" ? " · disconnected" : ""}</option>)}</select></label>
      <p class="help">Choose this computer or an existing SSH connection. <a href="/#/settings/connections/workspace">Manage SSH connections</a></p>
      <button class="btn small" disabled={busy || childBusy} onClick={() => void refresh()}>Refresh servers</button>
      {target !== "local" ? <>
        <p>Host the team on {hostName}. Setup installs a separate Code Flow server using your SSH connection. Its projects and accounts are separate from the SSH workspace.</p>
        <p class="help">It keeps running when SSH disconnects. After setup, enable automatic startup to bring it back after a reboot on Linux servers with systemd.</p>
        {prepared !== target ? <><label>Team HTTPS port<input class="field" aria-label="Team HTTPS port" type="number" min={1} max={65535} step={1} disabled={busy} value={port} onInput={(event) => setPort(event.currentTarget.value)} /></label><p class="help">Allow this port in the server’s firewall. HTTPS is configured in the next steps. A running server keeps its existing port.</p><button class="btn primary" disabled={busy || !hosts.some((host) => host.id === target) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={() => void prepare()}>{busy ? "Setting up server…" : hosts.find((host) => host.id === target)?.state === "connected" ? "Open or start team server" : "Connect and set up on this server"}</button><button class="btn" disabled={busy} onClick={onClose}>Close setup</button></> : <p role="status">Connected to the team server on {hostName} · port {port}</p>}
        {installed ? <div class="remote-status" aria-label="Automatic startup">
          <h4>Start automatically after reboot</h4>
          <p class="help">Uses a systemd service for your SSH account. Changing this setting leaves the running server in place.</p>
          <p role="status">{autostart?.message ?? (startupError ? "Automatic startup could not be checked." : "Checking automatic startup…")}</p>
          {autostart?.command ? <p><code>{autostart.command}</code></p> : null}
          {startupError ? <p class="msg err" role="alert">{startupError}</p> : null}
          <div class="settings-actions"><button class="btn" disabled={busy || childBusy} onClick={() => void changeStartup("status")}>Check startup status</button>
          {autostart?.supported && autostart.unitEnabled && !autostart.enabled ? <button class="btn" disabled={busy || childBusy} onClick={() => void changeStartup("disable")}>Disable automatic startup</button> : null}
          {autostart?.supported ? <button class="btn" disabled={busy || childBusy} onClick={() => void changeStartup(autostart.enabled ? "disable" : "enable")}>{autostart.enabled ? "Disable automatic startup" : "Enable automatic startup"}</button> : null}</div>
        </div> : null}
        {installed ? <button class="btn small" disabled={busy || childBusy} onClick={() => void stop()}>Stop team server</button> : null}
      </> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </section>
    {versionNote && installed ? <p class="help" role="status">{versionNote}</p> : null}
    {prepared === target ? <TeamServerSteps key={target} onClose={onClose} prefix={target === "local" ? "" : prefix} workspacePrefix={target === "local" ? "" : `/computer/${encodeURIComponent(target)}`} hostName={target === "local" ? "this computer" : hostName} onBusy={setChildBusy} /> : null}
  </>;
}

function TeamServerSteps({ onClose, prefix, workspacePrefix, hostName, onBusy }: { onClose: () => void; prefix: string; workspacePrefix: string; hostName: string; onBusy: (busy: boolean) => void }) {
  // Explicit target; never inherit the browser tab's team or workspace selection.
  const host = <T,>(path: string, body?: object, method = "POST") => localApi<T>(prefix + (path.startsWith("/api/team/") ? `${path}${path.includes("?") ? "&" : "?"}teamConnection=local` : path), body ? { method, body: JSON.stringify(body) } : {});
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const [projects, setProjects] = useState<Project[]>([]), [board, setBoard] = useState<Board | null>(null);
  const [accounts, setAccounts] = useState<SharedAccountState | null>(null), [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [projectId, setProjectId] = useState(""), [projectName, setProjectName] = useState(""), [folder, setFolder] = useState(prefix ? "" : repo.value);
  const [ownerName, setOwnerName] = useState(""), [rows, setRows] = useState<(RepoRef & { sourcePath?: string })[]>([blankRepo()]);
  const [person, setPerson] = useState(""), [username, setUsername] = useState(""), [displayName, setDisplayName] = useState(""), [password, setPassword] = useState(""), [role, setRole] = useState<SharedRole>("contributor");
  const [notice, setNotice] = useState("");
  const [transport, setTransport] = useState<"tailscale" | "lan">("tailscale");
  const project = projects.find((entry) => entry.id === projectId);
  const members = accounts?.users.filter((user) => user.enabled && user.roles[projectId]) ?? [];
  const address = remote?.enabled && remote.lan && !remote.lanError ? teamServerAddress(remote) : undefined;
  const configuredRepos = board?.projects.find((entry) => entry.id === projectId)?.repositories ?? [];
  const [workspaceProjects, setWorkspaceProjects] = useState<Project[]>([]);
  const [repositoryError, setRepositoryError] = useState("");
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const knownRepositories = [...new Set([...projects, ...workspaceProjects].flatMap(entry => entry.repos))];
  const refreshRepositories = async () => {
    setLoadingRepositories(true); setRepositoryError("");
    try { setWorkspaceProjects(await localApi<Project[]>(`${workspacePrefix}/api/projects`)); }
    catch (err) { setRepositoryError(`Could not load repositories from ${hostName}: ${(err as Error).message}`); }
    finally { setLoadingRepositories(false); }
  };
  useEffect(() => { void refreshRepositories(); }, []);
  const chooseRepository = (index: number, path: string) => {
    setRows(current => current.map((entry, at) => at !== index ? entry : path
      ? { ...entry, ...repositoryChoice(path, current.filter((_, other) => other !== index).map(row => row.key)), sourcePath: path, remote: undefined }
      : { ...entry, sourcePath: undefined }));
  };
  const ready = !!project && configuredRepos.length > 0 && !!address && members.some((user) => canRun(user.roles[projectId]));

  const run = async (action: () => Promise<void>) => {
    if (locked.current) return false; locked.current = true; setBusy(true); onBusy(true); setError("");
    try { await action(); return true; }
    catch (err) { setError((err as Error).message); return false; }
    finally { locked.current = false; setBusy(false); onBusy(false); }
  };
  const load = () => run(async () => {
    const [nextProjects, nextBoard, nextAccounts, nextRemote] = await Promise.all([host<Project[]>("/api/projects"), host<Board>("/api/team/board"), host<SharedAccountState>("/api/accounts"), host<RemoteInfo>("/api/remote")]);
    setProjects(nextProjects); setBoard(nextBoard); setAccounts(nextAccounts); setRemote(nextRemote); setOwnerName(nextBoard.me.displayName); setTransport(nextRemote.enabled && nextRemote.lan ? nextRemote.transport : "tailscale");
    if (!projectId && nextProjects.length) setProjectId(nextProjects[0]!.id);
  });
  useEffect(() => { void load(); }, []);
  useEffect(() => { heading.current?.focus(); setNotice(""); }, [step]);
  const next = async () => {
    await run(async () => {
      if (step === 0) {
        if (!ownerName.trim()) throw new Error("Enter your name as teammates should see it.");
        let chosen = project;
        if (!chosen) {
          if (!projectName.trim()) throw new Error("Enter a project name.");
          chosen = await host<Project>("/api/projects", { name: projectName.trim(), repos: folder.trim() ? [folder.trim()] : [] });
          setProjects((current) => [...current, chosen!]); setProjectId(chosen.id); if (!prefix) void loadProjects();
        }
        await host("/api/team/profile", { displayName: ownerName.trim() }, "PUT");
        const nextBoard = await host<Board>("/api/team/board"); setBoard(nextBoard);
        const existing = nextBoard.projects.find((entry) => entry.id === chosen!.id)?.repositories;
        setRows(existing?.length ? existing.map((entry) => ({ ...entry })) : [blankRepo()]);
      }
      if (step === 1) {
        if (!rows.length || rows.some((entry) => !/^[a-z][a-z0-9-]{0,63}$/.test(entry.key.trim())) || new Set(rows.map((entry) => entry.key.trim())).size !== rows.length) throw new Error("Add at least one repository, with a unique key using lowercase letters, numbers and dashes.");
        try { await host(`/api/team/projects/${encodeURIComponent(projectId)}/repositories`, { revision: board!.revision, repositories: rows.map((entry) => ({ key: entry.key.trim(), label: entry.label.trim() || entry.key.trim(), ...(entry.remote?.trim() ? { remote: entry.remote.trim() } : {}), ...(entry.defaultBranch?.trim() ? { defaultBranch: entry.defaultBranch.trim() } : {}) })) }, "PUT"); }
        catch (err) { if (err instanceof ApiError && err.status === 409) setBoard(await host<Board>("/api/team/board")); throw err; }
        setBoard(await host<Board>("/api/team/board"));
      }
      if (step >= 2) {
        const [nextRemote, nextAccounts, nextBoard, nextProjects] = await Promise.all([host<RemoteInfo>("/api/remote?refresh=1"), host<SharedAccountState>("/api/accounts"), host<Board>("/api/team/board"), host<Project[]>("/api/projects")]);
        setRemote(nextRemote); setAccounts(nextAccounts); setBoard(nextBoard); setProjects(nextProjects);
      }
      setStep(Math.min(step + 1, 4));
    });
  };
  const saveRemote = (body: object, path = "/api/remote") => run(async () => { setRemote(await host<RemoteInfo>(path, body)); });
  const addPerson = async () => {
    await run(async () => {
      if (!accounts) return;
      try {
        const existing = accounts.users.find((user) => user.id === person);
        if (person && (!existing || !existing.enabled)) throw new Error("Choose an enabled account.");
        const nextAccounts = existing
          ? await host<SharedAccountState>(`/api/accounts/${encodeURIComponent(existing.id)}`, { revision: accounts.revision, roles: { ...existing.roles, [projectId]: role } }, "PUT")
          : await host<SharedAccountState>("/api/accounts", { revision: accounts.revision, username: username.trim(), displayName: displayName.trim(), password, roles: { [projectId]: role } });
        setAccounts(nextAccounts); setPerson(""); setUsername(""); setDisplayName(""); setNotice(existing ? "Project access saved. Existing credentials still apply." : "Teammate saved. Share their initial password privately.");
      } catch (err) { if (err instanceof ApiError && err.status === 409) setAccounts(await host<SharedAccountState>("/api/accounts")); throw err; }
      finally { setPassword(""); }
    });
  };
  const shareText = address && project ? `Join ${project.name} in Code Flow\nTeam server: ${address}\n\n1. ${remote?.transport === "tailscale" ? "Connect your computer to our Tailscale network." : "Make sure your computer can reach the team server over HTTPS."}\n2. Open your own Code Flow → Settings → Team → Add team connection (or Connect this computer).\n3. Enter the server address and the account credentials shared with you separately.\n4. Map these repository keys to your local clones: ${configuredRepos.map((entry) => entry.key).join(", ")}.\nUse the same Code Flow version as the server.` : "";

  return <section class="settings-card team-server-wizard" aria-label="Team server setup" aria-busy={busy}>
    <div class="pp-card-head"><h3>Set up team server</h3><button class="btn small" disabled={busy} onClick={onClose}>Close setup</button></div>
    <p class="help">Edit the team server on {hostName}. Choose a section below. Saved settings stay in place when you close setup.</p>
    <ol class="team-setup-steps" aria-label="Setup progress">{STEPS.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><button type="button" disabled={busy || !board || (index > 0 && !project)} aria-current={step === index ? "step" : undefined} onClick={() => { if (index === 1 && step !== 1) setRows(configuredRepos.length ? configuredRepos.map(entry => ({ ...entry })) : [blankRepo()]); setStep(index); }}><span>{index + 1}</span>{label}</button></li>)}</ol>
    <h4 ref={heading} tabIndex={-1}>Step {step + 1} of 5: {STEPS[step]}</h4>
    {!board || !accounts || !remote ? <p class="help">{error ? "Setup could not load your current settings." : "Loading your current settings…"}<button class="btn small" disabled={busy} onClick={() => void load()}>Retry loading settings</button></p> : <>
      {step === 0 ? <form onSubmit={(event) => { event.preventDefault(); void next(); }}>
        <fieldset disabled={busy} class="team-setup-fields"><legend class="sr-only">Project and host</legend>
          <label>Your name on the team<input class="field" required maxLength={120} value={ownerName} onInput={(event) => setOwnerName(event.currentTarget.value)} /></label>
          <label>Project<select aria-label="Project" class="field" value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}><option value="">Create a new project…</option>{projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
          {!project ? <><label>Project name<input class="field" required maxLength={60} value={projectName} onInput={(event) => setProjectName(event.currentTarget.value)} /></label><label>Local repository folder (optional)<input class="field mono" value={folder} placeholder="/path/to/repository" onInput={(event) => setFolder(event.currentTarget.value)} /></label><p class="help">A server can host the board without a local clone. Teammates map their own clones after connecting.</p></> : <p class="help">Use {project.name} and keep its existing settings and members.</p>}
          <button class="btn primary" type="submit">Save and continue</button>
        </fieldset>
      </form> : null}
      {step === 1 ? <form onSubmit={(event) => { event.preventDefault(); void next(); }}><p class="help">Give each repository a shared name. Teammates use these keys to choose their own local clones.</p><fieldset disabled={busy} class="team-setup-fields"><legend class="sr-only">Shared repositories</legend>
        <div class="settings-actions"><button class="btn small" type="button" disabled={loadingRepositories} onClick={() => void refreshRepositories()}>{loadingRepositories ? "Loading repositories…" : "Refresh repositories"}</button></div>
        {repositoryError ? <p class="msg err" role="alert">{repositoryError}</p> : null}
        {rows.map((entry, index) => <div class="team-setup-repo" key={index}>
          <label class="team-setup-repo-source">Use an existing repository<select class="field" aria-label={`Existing repository ${index + 1}`} value={entry.sourcePath ?? ""} onChange={event => chooseRepository(index, event.currentTarget.value)}>
            <option value="">Enter repository details manually</option>
            {knownRepositories.map(path => <option key={path} value={path} disabled={rows.some((row, at) => at !== index && row.sourcePath === path)}>{path}</option>)}
          </select></label>
          <p class="help team-setup-repo-source">{knownRepositories.length ? `Choose a repository from the existing projects on ${hostName}${workspacePrefix ? ", including its SSH workspace" : ""}. This fills the shared key and label; add its Git URL and check the default branch below.` : `No repository folders were found in the projects on ${hostName}. Add the folder to a project on that computer and refresh repositories, or enter the shared details manually.`} Teammates still map the key to their own checkout after connecting.</p>
          {(["key", "label", "remote", "defaultBranch"] as const).map((field) => <label key={field}>{({ key: "Repository key", label: "Repository label", remote: "Git URL (optional)", defaultBranch: "Default branch" })[field]}<input class="field" required={field === "key"} maxLength={field === "key" ? 64 : field === "label" ? 80 : field === "remote" ? 300 : 100} pattern={field === "key" ? "[a-z][a-z0-9-]{0,63}" : undefined} value={entry[field] ?? ""} onInput={(event) => setRows(rows.map((row, at) => at === index ? { ...row, [field]: event.currentTarget.value } : row))} /></label>)}<button class="btn small" type="button" onClick={() => setRows(rows.filter((_, at) => at !== index))}>Remove repository {index + 1}</button></div>)}
        <div class="settings-actions"><button class="btn" type="button" disabled={rows.length >= 50} onClick={() => setRows([...rows, { key: "", label: "", defaultBranch: "main" }])}>Add repository</button><button class="btn primary" type="submit">Save repositories and continue</button></div>
      </fieldset></form> : null}
      {step === 2 ? <div class="team-setup-fields">
        <p>Teammates need an encrypted address they can reach. Keep {hostName} running with Code Flow active.</p>
        <label>Connection method<select class="field" aria-label="Connection method" disabled={busy} value={transport} onChange={(event) => setTransport(event.currentTarget.value as "tailscale" | "lan")}><option value="tailscale">Tailscale · recommended</option><option value="lan">Other HTTPS network</option></select></label>
        {transport === "tailscale" ? <><p class="help">{remote.tailscale.message} {remote.tailscale.dnsName ?? ""}</p>
          {remote.tailscale.state === "not-installed" ? <a class="btn" href="https://tailscale.com/download" target="_blank" rel="noreferrer">Install Tailscale</a> : null}
          <p class="help">Sign in to Tailscale on the server and teammates’ computers. Your network’s access rules must allow the server’s remote port.</p></> : <p class="help">Use a reachable server hostname and a certificate trusted by teammates’ computers. You manage DNS and network access. This option listens on the server’s network interfaces.</p>}
        <div class="settings-actions"><button class="btn" disabled={busy} onClick={() => void run(async () => setRemote(await host<RemoteInfo>("/api/remote?refresh=1")))}>Check connection</button>{!remote.enabled || !remote.lan || remote.transport !== transport ? <button class="btn primary" disabled={busy || transport === "tailscale" && remote.tailscale.state !== "connected"} onClick={() => void saveRemote({ enabled: true, lan: true, transport })}>{transport === "tailscale" ? "Enable team access over Tailscale" : "Enable team access on network"}</button> : null}</div>
        {remote.enabled && remote.lan && remote.transport === transport ? <SecureRemoteSetup key={transport} info={remote} busy={busy} save={(body) => saveRemote(body, "/api/remote/tls")} /> : null}
        {remote.lanError ? <p class="msg err" role="alert">{remote.lanError}</p> : null}
        {address ? <p role="status">Secure team address: <code>{address}</code></p> : <p class="help">Secure team access is not ready yet. You can finish this step later.</p>}
        <button class="btn primary" disabled={busy} onClick={() => void next()}>{address ? "Continue to teammates" : "Set up access later"}</button>
      </div> : null}
      {step === 3 ? <div>
        <p>Add accounts for people working on {project?.name}. Contributor lets them run tasks on their computers; Maintainer also lets them manage the project board.</p>
        {members.length ? <ul>{members.map((user) => <li key={user.id}>{user.displayName} ({user.username}) · {user.roles[projectId]}</li>)}</ul> : <p class="help">No teammates have access to this project yet.</p>}
        <form onSubmit={(event) => { event.preventDefault(); void addPerson(); }}><fieldset disabled={busy} class="team-setup-fields"><legend class="sr-only">Teammate account</legend>
          <label>Account<select aria-label="Account" class="field" value={person} onChange={(event) => { const id = event.currentTarget.value; setPerson(id); setPassword(""); setRole(accounts.users.find((user) => user.id === id)?.roles[projectId] ?? "contributor"); }}><option value="">Create a new account…</option>{accounts.users.filter((user) => user.enabled).map((user) => <option key={user.id} value={user.id}>{user.displayName} ({user.username})</option>)}</select></label>
          {!person ? <><label>Username<input class="field" required maxLength={64} value={username} autoComplete="off" onInput={(event) => setUsername(event.currentTarget.value)} /></label><label>Display name<input class="field" required maxLength={120} value={displayName} onInput={(event) => setDisplayName(event.currentTarget.value)} /></label><label>Initial password<input class="field" type="password" required minLength={15} autoComplete="new-password" value={password} onInput={(event) => setPassword(event.currentTarget.value)} /></label><p class="help">Use at least 15 characters. Share it privately; it is never included in copied connection instructions.</p></> : <p class="help">Only this project’s role will change. The account keeps its other project roles. Updated accounts must sign in again.</p>}
          <label>Project role<select aria-label="Project role" class="field" value={role} onChange={(event) => setRole(event.currentTarget.value as SharedRole)}><option value="contributor">Contributor — work on tasks</option><option value="maintainer">Maintainer — manage this project</option><option value="reviewer">Reviewer — review and comment</option><option value="viewer">Viewer — read only</option></select></label>
          <button class="btn" type="submit">{person ? "Save project access" : "Add teammate"}</button>
        </fieldset></form>
        {notice ? <p role="status">{notice}</p> : null}
        <button class="btn primary" disabled={busy} onClick={() => void next()}>{members.length ? "Review setup" : "Add teammates later"}</button>
      </div> : null}
      {step === 4 ? <div class="team-setup-fields">
        <h4>{ready ? "Ready to share with your team" : "Your setup is saved, with steps still to finish"}</h4>
        <ul><li>Project: {project?.name ?? "Unavailable — choose a project"}</li><li>Repositories: {configuredRepos.length ? configuredRepos.map((entry) => entry.key).join(", ") : "Add a repository key"}</li><li>Secure access: {address ?? "Finish secure access setup"}</li><li>Teammates: {members.length} with access{members.some((user) => canRun(user.roles[projectId])) ? " · task execution enabled" : " · add a contributor or maintainer to run tasks"}</li></ul>
        <div class="settings-actions"><button class="btn" disabled={busy} onClick={() => setStep(0)}>Edit project</button><button class="btn" disabled={busy} onClick={() => setStep(1)}>Edit repositories</button><button class="btn" disabled={busy} onClick={() => setStep(2)}>Edit secure access</button><button class="btn" disabled={busy} onClick={() => setStep(3)}>Edit teammates</button></div>
        {ready ? <><label>Connection instructions<textarea class="field" readOnly rows={8} value={shareText} /></label><button class="btn primary" onClick={() => void copy(shareText, "Connection instructions copied")}>Copy connection instructions</button><p class="help">Send each teammate’s username and password separately. Ask one teammate to connect and confirm access; network permissions still apply. Use the same Code Flow version on every computer.</p></> : null}
        <div class="settings-actions"><button class="btn" disabled={busy} onClick={() => void next()}>Check setup again</button><button class="btn primary" disabled={busy} onClick={() => { if (prefix) return onClose(); const url = new URL(location.href); url.hash = "#/team"; history.replaceState(history.state, "", url.href); selectTeamConnection("local"); }}>{prefix ? "Finish setup" : ready ? "Open team board" : "Finish for now"}</button></div>
      </div> : null}
      {step > 0 && step < 4 ? <button class="btn ghost" disabled={busy} onClick={() => { setError(""); setStep(step - 1); }}>Back</button> : null}
    </>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}
