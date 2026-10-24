import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc, post, safeHref, showToast } from "./lib.js";
import { projects, openComposer, externalSource, source, setTask, applyTemplate, templates, route } from "./state.js";
import { ConnectionSetup, SERVICE_NAMES, SERVICE_ACTIONS } from "./connection-setup.js";
import { CodeHostsPanel } from "./code-hosts.js";
import { NotificationsView } from "./notifications.js";
import type { ConnectionProvider, ConnectionSummary, ConnectionBinding } from "../src/integration-connections.js";
import type { ExternalSource, ExternalSourceItem, ExternalSourcePage } from "../src/integrations.js";
import type { PullRequest, Check } from "../src/github.js";
import type { RunSummary } from "./types.js";
import { checksLabel, runPassed } from "../src/run-status.js";

interface ConnectionPage { connections: ConnectionSummary[]; bindings?: ConnectionBinding[]; suggestion?: { provider?: ConnectionProvider; scope: string; host: string } }
const notification = (provider: string) => provider === "slack" || provider === "webhook";

export function IntegrationsScreen({ projectId }: { projectId?: string }) {
  const project = projects.value.find(p => p.id === projectId);
  const [repository, setRepository] = useState(project?.repos[0] ?? "");
  const [data, setData] = useState<ConnectionPage>({ connections: [] }), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const [setup, setSetup] = useState<{ provider: ConnectionProvider; existing?: ConnectionSummary }>();
  const [active, setActive] = useState<string>(), [revision, setRevision] = useState(0);
  const endpoint = projectId && repository ? `/api/integration-connections/projects/${enc(projectId)}?repository=${enc(repository)}` : "/api/integration-connections";
  const reload = async () => { const next = await api<ConnectionPage>(endpoint); setData(next); setRevision(n => n + 1); };
  useEffect(() => { let current = true; setError(""); setActive(undefined); void api<ConnectionPage>(endpoint).then(next => { if (current) setData(next); }, error => { if (current) setError(error.message); }); return () => { current = false; }; }, [endpoint]);
  const connected = (connection: ConnectionSummary) => !projectId || data.bindings?.some(b => b.connectionId === connection.id && b.repository === repository);
  const act = async (connection: ConnectionSummary, action: "test" | "disconnect" | "attach" | "detach") => {
    setBusy(connection.id); setError("");
    try {
      if (action === "test") { const result = await post<{ message: string }>(`/api/integration-connections/${enc(connection.id)}/test`); showToast(result.message, 5000); }
      else if (action === "disconnect") await api(`/api/integration-connections/${enc(connection.id)}`, { method: "DELETE" });
      else await api(`/api/integration-connections/projects/${enc(projectId!)}`, { method: action === "attach" ? "PUT" : "DELETE", body: JSON.stringify({ repository, connectionId: connection.id }) });
      await reload(); if (action === "disconnect" || action === "detach") setActive(undefined);
    } catch (error) { setError((error as Error).message); } finally { setBusy(""); }
  };
  const selected = data.connections.find(c => c.id === active && connected(c));
  const notificationIds = data.connections.filter(c => notification(c.provider) && connected(c)).map(c => c.id.replace(/^notification:/, ""));
  return <section class="integrations-screen" aria-label={projectId ? "Project connections" : "Integrations"}>
    <h2>{projectId ? "Connections" : "Integrations"}</h2><p class="help">Connect the services you already use. Choose an issue or pull request to start work in your project.</p>
    {project ? <label class="connection-repository">Repository<select class="field" value={repository} onChange={e => setRepository(e.currentTarget.value)}>{project.repos.map(repo => <option value={repo} key={repo}>{repo.split("/").pop()}</option>)}</select></label> : <p class="help">Add services here, then use a project’s Connections page to choose its repository and start work. Coding-agent accounts stay under <a href="#/settings/agents">Agents</a>.</p>}
    {project && !repository ? <p class="msg warn">Add a repository to this project before connecting services.</p> : null}
    {data.suggestion?.provider ? <p class="connection-suggestion">Suggested from Git remote: <b>{SERVICE_NAMES[data.suggestion.provider]}</b> · {data.suggestion.scope}</p> : null}
    {error ? <p class="msg err" role="alert">{error} <button class="btn small" onClick={() => void reload().then(() => setError(""), error => setError(error.message))}>Retry</button></p> : null}
    <div class="integration-grid">{(Object.keys(SERVICE_NAMES) as ConnectionProvider[]).map(provider => {
      const connections = data.connections.filter(c => c.provider === provider);
      return <article class="settings-card integration-card" key={provider} aria-label={`${SERVICE_NAMES[provider]} connections`}>
        <h3>{SERVICE_NAMES[provider]}</h3><p class="help">{SERVICE_ACTIONS[provider]}</p>
        {!connections.length ? <p class="help">Not connected</p> : connections.map(c => <div class="integration-connection" key={c.id}>
          <strong>{c.name}</strong><span class={`badge${c.configured && connected(c) ? " ok" : ""}`}>{!c.configured ? "Credentials unavailable" : connected(c) ? "Connected" : "Available to connect"}</span><p class="help">{c.scope}{c.administratorManaged ? " · Administrator-managed" : ""}</p>
          <div class="integration-actions">
            {projectId && !connected(c) ? <button class="btn small primary" disabled={!!busy || !repository || !c.configured} onClick={() => void act(c, "attach")}>Use in this project</button> : null}
            {projectId && connected(c) && !notification(provider) ? <button class="btn small primary" disabled={!c.configured || !!busy} onClick={() => setActive(c.id)}>Choose issue or PR</button> : null}
            <button class="btn small" disabled={!!busy} onClick={() => void act(c, "test")}>{busy === c.id ? "Working…" : "Test connection"}</button>
            {!c.administratorManaged ? <><button class="btn small" disabled={!!busy} onClick={() => setSetup({ provider, existing: c })}>Reconnect</button><button class="btn small danger" disabled={!!busy} onClick={() => void act(c, "disconnect")}>Disconnect</button></> : null}
            {projectId && connected(c) ? <button class="btn small" disabled={!!busy} onClick={() => void act(c, "detach")}>Remove from project</button> : null}
          </div>
        </div>)}
        <button class="btn" disabled={!!projectId && !repository || !!busy} onClick={() => setSetup({ provider })}>{connections.length ? "Connect another" : "Connect"}</button>
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
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [preview, setPreview] = useState<{ project: string; repository: string; github?: PullRequest & { kind: "issue" | "pr" }; source?: ExternalSource; checks?: Check[] }>();
  const [codeHostKey, setCodeHostKey] = useState<string>(), [publish, setPublish] = useState(false);
  const codeHost = ["github", "gitlab", "bitbucket"].includes(connection.provider);
  const base = `/api/integration-connections/projects/${enc(projectId)}/${enc(connection.id)}`;
  const load = async (next?: string) => { setBusy(true); setError(""); try { const result = await api<ExternalSourcePage>(`${base}/items?repository=${enc(repository)}&kind=${kind}${next ? `&cursor=${enc(next)}` : ""}`); setItems(current => next ? [...current, ...result.items] : result.items); setCursor(result.nextCursor); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } };
  useEffect(() => { setItems([]); setCursor(undefined); setPreview(undefined); setCodeHostKey(undefined); void load(); }, [kind]);
  const pick = async (item: ExternalSourceItem) => {
    setBusy(true); setError("");
    try {
      if (item.kind === "pr" && connection.provider !== "github") { setCodeHostKey(item.key); setPreview(undefined); }
      else { setCodeHostKey(undefined); setPreview(await post(`${base}/import`, { repository, kind: item.kind, key: item.key })); }
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const start = async (fixCi = false) => {
    if (!preview) return; setBusy(true); setError("");
    try {
      if (!await openComposer(projectId, { repository })) throw new Error("The project draft is still loading. Try again.");
      if (preview.github) {
        const item = preview.github, template = templates.value.find(t => t.id === (item.kind === "issue" ? "fix-issue" : fixCi ? "fix-ci" : "review-pr"));
        if (!template) throw new Error("The task template is unavailable. Reload and try again.");
        applyTemplate(template, { kind: item.kind, number: item.number, title: item.title, url: item.url, headRefName: item.headRefName, baseRefName: item.baseRefName, isCrossRepository: item.isCrossRepository });
      } else if (preview.source) { source.value = null; externalSource.value = preview.source; setTask("Address the selected issue. Add appropriate checks and explain the result."); }
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  return <section ref={section} tabIndex={-1} class="settings-card connection-work" aria-label="Connected project actions"><h2>Start work from {connection.name}</h2><p class="help">{repository.split("/").pop()} · Imported content stays source material. You choose the agents and send the task before work starts.</p>
    <div class="integration-actions"><button class={`btn ${kind === "issue" ? "primary" : ""}`} disabled={busy} onClick={() => setKind("issue")}>Start task from issue</button>{codeHost ? <><button class={`btn ${kind === "pr" ? "primary" : ""}`} disabled={busy} onClick={() => setKind("pr")}>Review pull request</button><button class="btn" onClick={() => setPublish(!publish)}>Create pull request from completed work</button></> : null}</div>
    {kind === "pr" ? <p class="help">{connection.provider === "github" ? "Review starts in your selected project using its configured agent permissions. Fork PRs remain read-only; posting a review or publishing changes is a separate action." : "Code reviews require a prepared agent container with its own login and a verification command. Load a preview, fetch the code, then start the isolated review. GitLab and Bitbucket CI-log diagnosis is not available yet."}</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {busy ? <p role="status">Loading…</p> : null}
    {!busy && !items.length ? <p>No open {kind === "issue" ? "issues" : "pull requests"} found. <button class="btn small" onClick={() => void load()}>Refresh</button></p> : null}
    <div class="connection-items">{items.map(item => <article key={item.key} class="connection-item"><div><strong>{item.key} · {item.title}</strong>{item.body ? <p class="help">{item.body.slice(0, 240)}</p> : null}</div><button class="btn small" disabled={busy} onClick={() => void pick(item)}>{kind === "issue" ? "Choose issue" : "Load PR preview"}</button></article>)}</div>
    {cursor ? <button class="btn" disabled={busy || items.length >= 1000} onClick={() => void load(cursor)}>Load more</button> : null}
    {preview ? <article class="connection-preview" aria-label="Source preview"><h3>{preview.github?.title ?? preview.source?.title}</h3><p class="connection-source-body">{preview.github?.body ?? preview.source?.body}</p>{safeHref(preview.github?.url ?? preview.source?.url) ? <a href={safeHref(preview.github?.url ?? preview.source?.url)} target="_blank" rel="noreferrer">Open source</a> : null}
      {preview.github?.kind === "pr" ? <><p>{preview.github.headRefName} → {preview.github.baseRefName}</p><ul>{preview.checks?.map(check => <li key={check.name}>{check.name}: {check.state}</li>)}</ul></> : null}
      <div class="integration-actions"><button class="btn primary" disabled={busy} onClick={() => void start()}>{kind === "issue" ? "Start task from issue" : "Review pull request"}</button>{preview.github?.kind === "pr" ? <button class="btn" disabled={busy || !preview.checks?.some(c => c.bucket === "fail")} onClick={() => void start(true)}>Fix failing checks</button> : null}</div>
    </article> : null}
    {codeHostKey ? <CodeHostsPanel key={codeHostKey} projects={projects.value} context={{ project: projectId, repository, integration: connection.id, number: codeHostKey }} /> : null}
    {publish ? <CompletedPullRequest connection={connection} projectId={projectId} repository={repository} /> : null}
  </section>;
}

function CompletedPullRequest({ connection, projectId, repository }: { connection: ConnectionSummary; projectId: string; repository: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([]), [selected, setSelected] = useState(""), [error, setError] = useState("");
  useEffect(() => { let current = true; void api<{ runs: RunSummary[] }>(`/api/runs?project=${enc(projectId)}&repo=${enc(repository)}&status=passed&limit=100`).then(result => { if (current) setRuns(result.runs.filter(run => run.project === projectId && run.repo === repository && runPassed(run) && !run.archived && run.artifacts.length)); }, error => current && setError(error.message)); return () => { current = false; }; }, [projectId, repository]);
  const results = runs.flatMap(run => run.artifacts.filter(artifact => checksLabel(run, false, artifact.branch) === "Passed").map(artifact => ({ run, artifact, id: `${run.id}:${artifact.branch}` })));
  const choice = results.find(result => result.id === selected);
  return <section class="connection-publish" aria-label="Publish completed work"><h3>Create a pull request</h3><p class="help">Choose completed work with passing checks. The server revalidates the result before publishing. Nothing is pushed when selecting it.</p>
    {error ? <p role="alert">{error}</p> : null}
    {!results.length ? <p>No completed, verified result is available in this repository yet.</p> : <label>Completed result<select class="field" value={selected} onChange={e => setSelected(e.currentTarget.value)}><option value="">Choose completed work</option>{results.map(result => <option value={result.id} key={result.id}>{result.run.task.slice(0, 100)} · {result.artifact.label}</option>)}</select></label>}
    {connection.provider === "github" ? <button class="btn primary" disabled={!choice} onClick={() => { if (choice) route.value = { view: "run", id: choice.run.id }; }}>Review result and create PR</button> : choice ? <CodeHostsPanel key={choice.id} projects={projects.value} context={{ project: projectId, repository, integration: connection.id, result: { runId: choice.run.id, branch: choice.artifact.branch } }} /> : null}
    <p class="help">Publishing, comments and merges always require an explicit action.</p>
  </section>;
}
