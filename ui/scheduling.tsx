import { api, post, enc, store, baseName } from "./lib.js";
import { agents, route, providerDefaults, executionPaused } from "./state.js";
import { AutomationHostStatus } from "./automation-setup.js";
import { useRef } from "preact/hooks";
import type { ChatSnapshot } from "../src/conversational/chats.js";
import { Icon } from "./icons.js";
import { useState } from "preact/hooks";
import { hashFor, AUTOMATION_KINDS } from "./navigation.js";
import { computerLabel } from "./ssh-projects.js";
import { AutomationsView } from "./automations.js";
import { DeferredRunsPanel } from "./deferred-runs.js";
import { ProjectTeamsPanel } from "./project-teams.js";
import { ProjectButton } from "./projects.js";
import { Templates } from "./github.js";
import { activeProject, currentProject, NONE, openComposer, projects, draftsReady, composerLoading } from "./state.js";

const SCHEDULE_DETAILS = [
  { id: "once", label: "Run once later", description: "Start a task at a chosen time or when its providers have capacity." },
  { id: "repeat", label: "Repeat", description: "Run a configured task on a schedule or from a webhook." },
  { id: "backlog", label: "Process a backlog", description: "Choose issues, dependency updates or security alerts, with one run per item." },
  { id: "missions", label: "Pursue a mission", description: "Give agents an ongoing goal and review their proposals and verified drafts." },
] as const;
export const SCHEDULE_KINDS = AUTOMATION_KINDS.map(id => SCHEDULE_DETAILS.find(item => item.id === id)!);
export type ScheduleKind = typeof AUTOMATION_KINDS[number];
function LegacySchedulingView({ kind = "repeat", projectId }: { kind?: string; projectId?: string }) {
  const selected = SCHEDULE_KINDS.find(item => item.id === kind) ?? SCHEDULE_KINDS[1]!;
  const project = projectId ? projects.value.find(p => p.id === projectId) : activeProject.value;
  const [repository, setRepository] = useState("");
  const chosen = project?.repos.includes(repository) ? repository : project?.repos.length === 1 ? project.repos[0] : "";
  const scope = projectId ?? project?.id;
  const configure = () => openComposer(scope ?? (currentProject.value === NONE ? "" : undefined), chosen ? { repository: chosen } : {});
  if (projectId && !project) return <p role="alert">This project is unavailable. Choose an existing project to manage automation.</p>;
  return <div class="scheduling-hub">
    <nav class="purpose-nav" aria-label="Scheduling purpose">{SCHEDULE_KINDS.map(item => <a class={`btn ${selected.id === item.id ? "primary" : ""}`} href={hashFor(projectId ? { view: "project", id: projectId, section: "automation", kind: item.id } : { view: "automations", kind: item.id })} aria-current={selected.id === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
    <p>{selected.description}</p>
    <p class="help">{project ? `${project.name} · ` : "Across projects · "}Computer: {computerLabel()}. The host must be running. Results return to the Inbox for review.</p>
    {!projectId ? <ProjectButton /> : null}
    {project && selected.id !== "missions" ? <label>Automation repository<select class="field" value={chosen} onChange={event => setRepository(event.currentTarget.value)}><option value="" disabled>Choose a repository</option>{project.repos.map(folder => <option value={folder} key={folder}>{folder}</option>)}</select></label> : null}
    {selected.id === "once" ? <><p class="help">Configure a task in Saved workflows, then choose Schedule → Run once later.</p><button class="btn" disabled={!draftsReady.value || composerLoading.value || !!project && !chosen} onClick={() => void configure()}>Configure a task</button><DeferredRunsPanel project={scope} unassigned={!projectId && currentProject.value === NONE} /></> : null}
    {selected.id === "repeat" ? <><button class="btn" disabled={!draftsReady.value || composerLoading.value || !!project && !chosen} onClick={() => void configure()}>Configure a repeating task</button><AutomationsView mode="automations" category="repeat" projectId={projectId} showScope={false} /></> : null}
    {selected.id === "backlog" ? <>{project && chosen ? <><p class="help">Next backlog: {project.name} · <code>{chosen}</code>. Choose a single agent, team pattern or saved template before starting.</p><Templates only="backlog" disabled={!draftsReady.value || composerLoading.value} prepare={() => openComposer(project.id, { repository: chosen, stay: true })} /></> : <p class="help">Choose a project and repository here to select backlog items.</p>}<AutomationsView mode="automations" category="backlog" projectId={projectId} showScope={false} /></> : null}
    {selected.id === "missions" ? <>{project ? <ProjectTeamsPanel key={project.id} projectId={project.id} repos={project.repos} /> : <p class="help">Choose a project to create or manage its missions.</p>}</> : null}
  </div>;
}

export function SchedulingView({ kind, projectId }: { kind?: string; projectId?: string }) {
  const [selected, setSelected] = useState(projectId ?? activeProject.value?.id ?? "");
  const project = projects.value.find(p => p.id === (projectId ?? (selected || (projects.value.length === 1 ? projects.value[0]!.id : ""))));
  const [repository, setRepository] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const operation = useRef<{ key: string; create: string; send: string }>();
  const repo = project?.repos.includes(repository) ? repository : project?.repos.length === 1 ? project.repos[0]! : "";
  async function prepare() {
    if (!message.trim() || !repo || !project || busy) return;
    setBusy(true); setError("");
    try {
      const key = JSON.stringify([project.id, repo, message]);
      if (operation.current?.key !== key) operation.current = { key, create: crypto.randomUUID(), send: crypto.randomUUID() };
      const provider = agents.value.find(a => a.available && ["claude", "codex"].includes(a.id))?.id;
      if (!provider) throw new Error("Connect Claude or Codex in App settings → Providers first.");
      const defaults = { mode: "team", provider, ...providerDefaults.value[provider], trust: "standard", tools: false };
      const made = await post<{ id: string }>("/api/chats", { operationId: operation.current.create, project: project.id, repo, source: "head", purpose: "automation", defaults });
      const chat = await api<ChatSnapshot>(`/api/chats/${enc(made.id)}`);
      await post(`/api/chats/${enc(made.id)}/actions`, { action: "send", operationId: operation.current.send, expectedVersion: chat.chat.version, message: message.trim() });
      store.set(`automation-chat:${made.id}`, "true");
      route.value = { view: "chat", id: made.id };
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (kind) return <><a class="btn ghost" href="#/settings/automations">Back to automation settings</a><LegacySchedulingView kind={kind} projectId={projectId}/></>;
  return <div class="scheduling-hub automation-home">
    <section class="automation-start">
      <header class="automation-intro"><span class="task-heading-mark"><Icon name="clock"/></span><h1>What would you like to automate?</h1><p>Describe the work and when it should happen.</p></header>
      <form onSubmit={e => { e.preventDefault(); void prepare(); }}>
        <textarea ref={input} class="field" aria-label="Automation task" rows={4} maxLength={10000} value={message} onInput={e => setMessage(e.currentTarget.value)} placeholder={`Review new ${project?.name ?? "repository"} issues every weekday morning…`}/>
        <div class="automation-start-footer"><div class="automation-context-picker">
          <label title={repo || "Choose project"}><Icon name="folder"/><select aria-label="Automation project" disabled={busy || !!projectId} value={project?.id ?? ""} onChange={e => { setSelected(e.currentTarget.value); setRepository(""); }}><option value="" disabled>Choose project</option>{projects.value.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
          {project && project.repos.length > 1 ? <label><Icon name="terminal"/><select aria-label="Automation repository" value={repo} disabled={busy} onChange={e => setRepository(e.currentTarget.value)}><option value="" disabled>Choose repository</option>{project.repos.map(path => <option key={path} value={path}>{baseName(path)}</option>)}</select></label> : null}
        </div><button class="btn primary" type="submit" disabled={busy || !repo || !message.trim() || executionPaused.value}>{busy ? "Preparing…" : "Create automation"}<Icon name="send"/></button></div>
      </form>
      <div class="automation-examples" role="group" aria-label="Automation ideas">
        {([
          {icon:"check", title:"Daily review", detail:"Review changes every morning", prompt:"Review repository changes every morning"},
          {icon:"terminal", title:"Event checks", detail:"Run checks when a webhook arrives", prompt:"Run checks when a webhook arrives"},
          {icon:"layers", title:"Issue queue", detail:"Work through issues one at a time", prompt:"Work through open issues one at a time"},
        ] as const).map(example => <button key={example.title} type="button" class="automation-example" disabled={busy} onClick={() => { setMessage(example.prompt); input.current?.focus(); }}><Icon name={example.icon}/><span><strong>{example.title}</strong><span>{example.detail}</span></span><Icon name="chevron"/></button>)}
      </div>
      {project && !project.repos.length ? <p class="help">Add a repository in <a href={hashFor({view:"project", id:project.id, section:"repositories"})}>Repositories</a> to start an automation.</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      <AutomationHostStatus/>
    </section>
    <div class="automation-manage-link"><a class="btn ghost small" href="#/settings/automations"><Icon name="sliders"/>Manage automations</a></div>
  </div>;
}

/** Saved work and advanced controls live away from the creation surface. */
export function AutomationManagement() {
  return <div class="automation-management">
    <div class="page-head"><ProjectButton/><a class="btn" href="#/automations">Create automation</a></div>
    <AutomationsView mode="automations" showScope={false}/>
    <details class="automation-legacy"><summary>Advanced scheduling tools</summary><p class="help">Manage existing schedules, deferred work and issue queues.</p><nav class="purpose-nav" aria-label="Advanced scheduling">{SCHEDULE_KINDS.map(item => <a key={item.id} class="btn" href={hashFor({view:"automations", kind:item.id})}>{item.label}</a>)}</nav></details>
  </div>;
}
