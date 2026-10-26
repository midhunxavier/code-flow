import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, enc, post, safeHref, showToast } from "./lib.js";
import { projects, openComposer, applyExternalIssue, applyTemplate, templates, navigate, draftsReady, composerLoading } from "./state.js";
import { confirmAction } from "./confirm-state.js";
import { publishReviewIntent } from "./publish-review-intent.js";
import { ConnectionSetup, SERVICE_NAMES, SERVICE_ACTIONS } from "./connection-setup.js";
import { CodeHostsPanel } from "./code-hosts.js";
import { NotificationsView } from "./notifications.js";
import { Icon, type IconName } from "./icons.js";
import { Menu, MenuItem } from "./panel-bits.js";
import type { ConnectionProvider, ConnectionSummary, ConnectionBinding } from "../src/integration-connections.js";
import type { ExternalSource, ExternalSourceItem, ExternalSourcePage } from "../src/integrations.js";
import type { PullRequest, Check } from "../src/github.js";
import type { RunSummary } from "./types.js";
import { checksLabel, runPassed } from "../src/run-status.js";

interface ConnectionPage { connections: ConnectionSummary[]; warnings?: string[]; bindings?: ConnectionBinding[]; suggestion?: { provider?: ConnectionProvider; scope: string; host: string } }
type ConnectionAction = "test" | "disconnect" | "attach" | "detach";
const notification = (provider: string) => provider === "slack" || provider === "webhook";
const SERVICE_ICONS: Record<ConnectionProvider, IconName> = { github: "pull", gitlab: "pull", bitbucket: "pull", linear: "issue", jira: "issue", slack: "chat", webhook: "globe" };

export function IntegrationsScreen({ projectId }: { projectId?: string }) {
  const project = projects.value.find(p => p.id === projectId);
  const [repository, setRepository] = useState(project?.repos[0] ?? "");
  const [data, setData] = useState<ConnectionPage>({ connections: [] }), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const [actionErrors, setActionErrors] = useState<Record<string, { action: ConnectionAction; message: string }>>({});
  const [setup, setSetup] = useState<{ provider: ConnectionProvider; existing?: ConnectionSummary }>();
  const [active, setActive] = useState<string>(), [revision, setRevision] = useState(0);
  const endpoint = projectId && repository ? `/api/integration-connections/projects/${enc(projectId)}?repository=${enc(repository)}` : "/api/integration-connections";
  const reload = async () => { const next = await api<ConnectionPage>(endpoint); setData(next); setRevision(n => n + 1); };
  useEffect(() => { let current = true; setError(""); setActive(undefined); void api<ConnectionPage>(endpoint).then(next => { if (current) setData(next); }, error => { if (current) setError(error.message); }); return () => { current = false; }; }, [endpoint]);
  const connected = (connection: ConnectionSummary) => !projectId || data.bindings?.some(b => b.connectionId === connection.id && b.repository === repository);
  const act = async (connection: ConnectionSummary, action: ConnectionAction) => {
    if (busy) return;
    if (action === "disconnect") {
      const names = (connection.projectIds ?? []).map(id => projects.value.find(project => project.id === id)?.name ?? id);
      if (!await confirmAction(`Disconnect ${connection.name}? This deletes its saved credential from this server and removes it from ${names.length} project${names.length === 1 ? "" : "s"}${names.length ? `: ${names.join(", ")}` : ""}. ${notification(connection.provider) ? `Pending deliveries are cancelled${connection.unavailable ? " when notification storage is available again" : ""}. ` : ""}It does not revoke the token or sign out at the service. Use Remove from project to keep it for other projects.`, { title: `Disconnect ${connection.name}?`, confirmLabel: "Disconnect", danger: true })) return;
    }
    setBusy(connection.id);
    try {
      if (action === "test") { const result = await post<{ message: string }>(`/api/integration-connections/${enc(connection.id)}/test`); showToast(result.message, 5000); }
      else if (action === "disconnect") await api(`/api/integration-connections/${enc(connection.id)}`, { method: "DELETE" });
      else await api(`/api/integration-connections/projects/${enc(projectId!)}`, { method: action === "attach" ? "PUT" : "DELETE", body: JSON.stringify({ repository, connectionId: connection.id }) });
      setActionErrors(current => { const next = { ...current }; delete next[connection.id]; return next; });
      if (action === "disconnect" || action === "detach") setActive(undefined);
      if (action === "disconnect") showToast(`Disconnected ${connection.name}`);
      await reload().catch(error => setError(error.message));
    } catch (error) { setActionErrors(current => ({ ...current, [connection.id]: { action, message: (error as Error).message } })); } finally { setBusy(""); }
  };
  const selected = data.connections.find(c => c.id === active && connected(c));
  const notificationIds = data.connections.filter(c => notification(c.provider) && connected(c)).map(c => c.id.replace(/^notification:/, ""));
  return <section class="integrations-screen" aria-label={projectId ? "Project connections" : "Integrations"}>
    <header class="connections-heading">
      <div><div class="collaboration-eyebrow">{projectId ? "Project services" : "Your services"}</div><h2>{projectId ? "Connections" : "Integrations"}</h2><p class="help">Bring issues, pull requests and updates into your work.</p></div>
      {project ? <label class="connection-repository">Repository<select class="field" value={repository} onChange={e => setRepository(e.currentTarget.value)}>{project.repos.map(repo => <option value={repo} key={repo}>{repo.split("/").pop()}</option>)}</select></label> : null}
    </header>
    {!project ? <p class="help">Add services here, then use a project’s Connections page to choose its repository and start work. Coding-agent accounts stay under <a href="#/settings/agents">Agents</a>.</p> : null}
    {project && !repository ? <p class="msg warn">Add a repository to this project before connecting services.</p> : null}
    {data.suggestion?.provider && !data.connections.some(c => c.provider === data.suggestion?.provider && c.configured && connected(c)) ? <p class="connection-suggestion">Suggested for this repository: <b>{SERVICE_NAMES[data.suggestion.provider]}</b> · {data.suggestion.scope}</p> : null}
    {error ? <p class="msg err" role="alert">{error} <button class="btn small" onClick={() => void reload().then(() => setError(""), error => setError(error.message))}>Retry</button></p> : null}
    {data.warnings?.map(warning => <p key={warning} class="msg warn" role="status">{warning}</p>)}
    <div class="integration-grid">{(Object.keys(SERVICE_NAMES) as ConnectionProvider[]).map(provider => {
      const connections = data.connections.filter(c => c.provider === provider);
      return <article class={`settings-card integration-card${connections.some(c => c.configured && !c.unavailable && connected(c)) ? " is-connected" : ""}`} key={provider} aria-label={`${SERVICE_NAMES[provider]} connections`}>
        <header class="integration-card-heading"><span class="integration-service-icon"><Icon name={SERVICE_ICONS[provider]} /></span><h3>{SERVICE_NAMES[provider]}</h3></header>
        <p class="help integration-description">{SERVICE_ACTIONS[provider]}</p>
        <div class="integration-accounts">{!connections.length ? <p class="integration-empty"><span />Not connected</p> : connections.map(c => <div class="integration-connection" key={c.id}>
          <div class="integration-connection-heading">
            <span class={`badge${c.configured && !c.unavailable && connected(c) ? " ok" : ""}`}>{c.unavailable ? "Unavailable" : !c.configured ? "Credentials unavailable" : connected(c) ? "Connected" : "Available to connect"}</span>
            <Menu label={`Manage ${c.name} connection`} icon="more" class="integration-manage">{close => <>
              <MenuItem disabled={!!busy} onClick={() => { close(); void act(c, "test"); }}>Test connection</MenuItem>
              {!c.administratorManaged ? <MenuItem disabled={!!busy} onClick={() => { close(); setSetup({ provider, existing: c }); }}>Reconnect</MenuItem> : null}
              {projectId && connected(c) ? <MenuItem disabled={!!busy} onClick={() => { close(); void act(c, "detach"); }}>Remove from project</MenuItem> : null}
              {!c.administratorManaged ? <MenuItem disabled={!!busy} onClick={() => { close(); void act(c, "disconnect"); }}><span class="integration-disconnect">Disconnect</span></MenuItem> : null}
            </>}</Menu>
          </div>
          <strong class="integration-scope">{c.scope || c.name}</strong>
          {c.scope && c.name !== SERVICE_NAMES[provider] && c.name !== c.scope ? <p class="help integration-account-name">{c.name}</p> : null}
          {c.administratorManaged ? <p class="help integration-account-name">Administrator-managed</p> : null}
          {c.unavailable ? <p class="msg warn" role="status">{c.unavailable}</p> : null}
          {busy === c.id ? <p class="help" role="status">Working…</p> : null}
          {actionErrors[c.id] ? <p class="msg err" role="alert">Could not {actionErrors[c.id]!.action} {c.name}: {actionErrors[c.id]!.message} <button class="btn small" disabled={!!busy} onClick={() => void act(c, actionErrors[c.id]!.action)}>Retry</button></p> : null}
          <div class="integration-primary-actions">
            {projectId && !connected(c) ? <button class="btn small primary" disabled={!!busy || !repository || !c.configured} onClick={() => void act(c, "attach")}>Use in this project</button> : null}
            {projectId && connected(c) && !notification(provider) ? <button class="btn small primary" disabled={!c.configured || !!busy} onClick={() => setActive(c.id)}>{c.capabilities.includes("Pull requests") ? "Choose issue or PR" : "Choose issue"}</button> : null}
          </div>
        </div>)}</div>
        <footer class="integration-card-footer"><button class={`btn small${connections.length ? " ghost" : ""}`} disabled={!!projectId && !repository || !!busy} onClick={() => setSetup({ provider })}><Icon name="plus" />{connections.length ? "Connect another" : "Connect"}</button></footer>
      </article>;
    })}</div>
    {selected && project && repository ? <ProjectConnectionActions key={`${selected.id}:${repository}`} connection={selected} projectId={project.id} repository={repository} /> : null}
    {notificationIds.length || !projectId ? <NotificationsView key={`notifications:${revision}`} destinationIds={projectId ? notificationIds : undefined} projectId={projectId} /> : null}
    <details class="integration-advanced"><summary>Advanced · server configuration</summary><p class="help">Existing CODEFLOW_INTEGRATIONS_FILE / CODEFLOW_INTEGRATIONS_JSON and CODEFLOW_NOTIFICATIONS_FILE / CODEFLOW_NOTIFICATIONS_JSON configurations remain administrator-managed. Update or remove them on the server, then restart. App-managed connections can be reconnected or disconnected here without restarting.</p><a href="/docs/configuration.html" target="_blank" rel="noreferrer">Server configuration reference</a></details>
    {setup ? <ConnectionSetup key={`${setup.provider}:${setup.existing?.id ?? "new"}`} {...setup} projectId={projectId} repository={repository || undefined} suggestion={data.suggestion} close={() => setSetup(undefined)} connected={reload} /> : null}
  </section>;
}

function ProjectConnectionActions({ connection, projectId, repository }: { connection: ConnectionSummary; projectId: string; repository: string }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.scrollIntoView({ block: "start" }); section.current?.focus({ preventScroll: true }); }, []);
  const [kind, setKind] = useState<"issue" | "pr">("issue"), [items, setItems] = useState<ExternalSourceItem[]>([]), [cursor, setCursor] = useState<string>();
  const [truncated, setTruncated] = useState(false), request = useRef(0);
  // Show loading on the first paint, but let the user change kind during a slow request.
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [preview, setPreview] = useState<{ project: string; repository: string; github?: PullRequest & { kind: "issue" | "pr" }; source?: ExternalSource; checks?: Check[] }>();
  const [codeHostKey, setCodeHostKey] = useState<string>(), [publish, setPublish] = useState(false);
  const restoringDraft = !draftsReady.value || composerLoading.value;
  const codeHost = ["github", "gitlab", "bitbucket"].includes(connection.provider);
  const base = `/api/integration-connections/projects/${enc(projectId)}/${enc(connection.id)}`;
  const load = async (next?: string) => {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const result = await api<ExternalSourcePage>(`${base}/items?repository=${enc(repository)}&kind=${kind}${next ? `&cursor=${enc(next)}` : ""}`);
      if (current !== request.current) return;
      const values = [...new Map((next ? [...items, ...result.items] : result.items).map(item => [`${item.kind}:${item.key}`, item])).values()];
      setItems(values.slice(0, 1000)); setCursor(result.nextCursor); setTruncated(result.truncated || values.length > 1000);
    } catch (error) { if (current === request.current) setError((error as Error).message); } finally { if (current === request.current) setBusy(false); }
  };
  useLayoutEffect(() => { setItems([]); setCursor(undefined); setTruncated(false); setPreview(undefined); setCodeHostKey(undefined); void load(); return () => { ++request.current; }; }, [kind]);
  const pick = async (item: ExternalSourceItem) => {
    const current = ++request.current;
    setBusy(true); setError("");
    try {
      if (item.kind === "pr" && connection.provider !== "github") { setCodeHostKey(item.key); setPreview(undefined); }
      else { setCodeHostKey(undefined); const value = await post<typeof preview>(`${base}/import`, { repository, kind: item.kind, key: item.key }); if (current === request.current) setPreview(value); }
    } catch (error) { if (current === request.current) setError((error as Error).message); } finally { if (current === request.current) setBusy(false); }
  };
  const start = async (fixCi = false) => {
    if (!preview || !draftsReady.peek() || composerLoading.peek()) return; setBusy(true); setError("");
    try {
      if (!await openComposer(projectId, { repository })) throw new Error("The project draft is still loading. Try again.");
      if (preview.github) {
        const item = preview.github, template = templates.value.find(t => t.id === (item.kind === "issue" ? "fix-issue" : fixCi ? "fix-ci" : "review-pr"));
        if (!template) throw new Error("The task template is unavailable. Reload and try again.");
        applyTemplate(template, { kind: item.kind, number: item.number, title: item.title, url: item.url, headRefName: item.headRefName, baseRefName: item.baseRefName, isCrossRepository: item.isCrossRepository });
      } else if (preview.source) applyExternalIssue(preview.source);
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <section ref={section} tabIndex={-1} class="settings-card connection-work" aria-label="Connected project actions"><h2>Start work from {connection.name}</h2><p class="help">{repository.split("/").pop()} · Imported content stays source material. You choose the agents and send the task before work starts.</p>
    <div class="integration-actions"><button class={`btn ${kind === "issue" ? "primary" : ""}`} aria-pressed={kind === "issue"} onClick={() => setKind("issue")}>Start task from issue</button>{codeHost ? <><button class={`btn ${kind === "pr" ? "primary" : ""}`} aria-pressed={kind === "pr"} onClick={() => setKind("pr")}>Review pull request</button><button class="btn" onClick={() => setPublish(!publish)}>Create pull request from completed work</button></> : null}<button class="btn" disabled={busy} onClick={() => void load()}>Refresh list</button></div>
    {kind === "pr" ? <p class="help">{connection.provider === "github" ? "Review starts in your selected project using its configured agent permissions. Fork PRs remain read-only; posting a review or publishing changes is a separate action." : "Code reviews require a prepared agent container with its own login and a verification command. Load a preview, fetch the code, then start the isolated review. GitLab and Bitbucket CI-log diagnosis is not available yet."}</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {busy ? <p role="status">Loading…</p> : null}
    {!busy && !items.length ? <p>No open {kind === "issue" ? "issues" : "pull requests"} found. <button class="btn small" onClick={() => void load()}>Refresh</button></p> : null}
    <div class="connection-items">{items.map(item => <article key={item.key} class="connection-item"><div><strong>{item.key} · {item.title}</strong>{item.body ? <p class="help">{item.body.slice(0, 240)}</p> : null}</div><button class="btn small" disabled={busy} onClick={() => void pick(item)}>{kind === "issue" ? "Choose issue" : "Load PR preview"}</button></article>)}</div>
    {cursor && items.length < 1000 ? <button class="btn" disabled={busy} onClick={() => void load(cursor)}>Load more</button> : null}
    {truncated || cursor && items.length >= 1000 ? <p class="help" role="status">The listing reached its limit. Showing {items.length.toLocaleString()} {kind === "issue" ? "issues" : "pull requests"}. Narrow the project or open {SERVICE_NAMES[connection.provider as ConnectionProvider]} to see the rest.</p> : null}
    {preview ? <article class="connection-preview" aria-label="Source preview"><h3>{preview.github?.title ?? preview.source?.title}</h3><p class="connection-source-body">{preview.github?.body ?? preview.source?.body}</p>{safeHref(preview.github?.url ?? preview.source?.url) ? <a href={safeHref(preview.github?.url ?? preview.source?.url)} target="_blank" rel="noreferrer">Open source</a> : null}
      {preview.github?.kind === "pr" ? <><p>{preview.github.headRefName} → {preview.github.baseRefName}</p><ul>{preview.checks?.map(check => <li key={check.name}>{check.name}: {check.state}</li>)}</ul></> : null}
      {restoringDraft ? <p class="help" role="status">Restoring your project draft…</p> : null}
      <div class="integration-actions"><button class="btn primary" disabled={busy || restoringDraft} onClick={() => void start()}>{kind === "issue" ? "Start task from issue" : "Review pull request"}</button>{preview.github?.kind === "pr" ? <button class="btn" disabled={busy || restoringDraft || !preview.checks?.some(c => c.bucket === "fail")} onClick={() => void start(true)}>Fix failing checks</button> : null}</div>
    </article> : null}
    {codeHostKey ? <CodeHostsPanel key={codeHostKey} projects={projects.value} context={{ project: projectId, repository, integration: connection.id, number: codeHostKey }} /> : null}
    {publish ? <CompletedPullRequest connection={connection} projectId={projectId} repository={repository} /> : null}
  </section>;
}

function CompletedPullRequest({ connection, projectId, repository }: { connection: ConnectionSummary; projectId: string; repository: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([]), [selected, setSelected] = useState(""), [error, setError] = useState("");
  useEffect(() => { let current = true; void api<{ runs: RunSummary[] }>(`/api/runs?project=${enc(projectId)}&repo=${enc(repository)}&status=passed&limit=100`).then(result => { if (current) setRuns(result.runs.filter(run => run.project === projectId && run.repo === repository && runPassed(run) && !run.archived && run.artifacts.length)); }, error => current && setError(error.message)); return () => { current = false; }; }, [projectId, repository]);
  const results = runs.filter(run => connection.provider !== "github" || run.source?.kind !== "pr").flatMap(run => run.artifacts.filter(artifact => checksLabel(run, false, artifact.branch) === "Passed").map(artifact => ({ run, artifact, id: `${run.id}:${artifact.branch}` })));
  const choice = results.find(result => result.id === selected);
  return <section class="connection-publish" aria-label="Publish completed work"><h3>Create a pull request</h3><p class="help">Choose completed work with passing checks. The server revalidates the result before publishing. Nothing is pushed when selecting it.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!results.length ? <p>No completed, verified result is available in this repository yet.</p> : <label>Completed result<select class="field" value={selected} onChange={e => setSelected(e.currentTarget.value)}><option value="">Choose completed work</option>{results.map(result => <option value={result.id} key={result.id}>{result.run.task.slice(0, 100)} · {result.artifact.label}</option>)}</select></label>}
    {connection.provider === "github" ? <button class="btn primary" disabled={!choice} onClick={() => { if (choice) { publishReviewIntent.value = { runId: choice.run.id, branch: choice.artifact.branch }; navigate({ view: "review", id: choice.run.id, branch: choice.artifact.branch }); } }}>Review result and create PR</button> : choice ? <CodeHostsPanel key={choice.id} projects={projects.value} context={{ project: projectId, repository, integration: connection.id, result: { runId: choice.run.id, branch: choice.artifact.branch } }} /> : null}
    <p class="help">Publishing, comments and merges always require an explicit action.</p>
  </section>;
}
