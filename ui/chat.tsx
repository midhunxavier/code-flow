import { editableCandidate } from "../src/cli-teams/editable.js";
import { AutomationSetup } from "./automation-setup.js";
import { TaskInspector } from "./task-inspector.js";
import { ProjectContextEditor } from "./chat-context-editor.js";
import { MessageSettings } from "./chat-settings.js";
import { ChatResultPane } from "./chat-result.js";
import { subscribe } from "./stream.js";
import { activeChatContext } from "./chat-context.js";
import { chatDraftFiles } from "./chat-files.js";
import { PolicyPauseNotice } from "./policy-pause.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, post, enc, baseName, store, workspaceKey, onPhone, ownerOnLocalListener } from "./lib.js";
import { projects, composerProject, repo, route, openComposer, agents, catalogs, projectsOpen, projectEdit, projectPickerPurpose, providerDefaults, draftsReady, composerLoading, executionPaused } from "./state.js";
import { addRepositoryToProject } from "./projects.js";
import { executionHost } from "./ssh-projects.js";
import { Markdown } from "./bits.js";
import { Icon } from "./icons.js";
import { useDialog } from "./app.js";
import { ChatControls, PermissionMenu } from "./chat-controls.js";
import { Menu, MenuItem } from "./panel-bits.js";
import { ApproachEditor, Sequence, SourcePicker, TaskActivity, TaskResult } from "./task-conversation.js";
import { chatSearchTarget, refreshChats } from "./chat-state.js";
import { CHAT_OUTCOMES, type ChatDefaults, type ChatAttachment, type ChatEvent } from "../src/conversational/chat-model.js";
import type { ChatSnapshot } from "../src/conversational/chats.js";
import type { TaskSnapshot } from "../src/conversational/service.js";
import type { Candidate } from "../src/cli-teams/model.js";

const uuid = () => crypto.randomUUID();
type Draft = { discussion?: boolean; targetTask?: string | null; project: string; repo: string; message: string; defaults: ChatDefaults; attachments: (ChatAttachment & { sha256?: string })[]; source: "head" | "working_changes"; untracked: string[]; createId: string; messageId: string };
function initialDraft(project: string, id: string): Draft {
  const selected = projects.value.find(p => p.id === project);
  const preferred = selected?.defaults?.teams?.solo?.roles.agent?.[0];
  const provider = preferred && preferred !== "auto" ? preferred as ChatDefaults["provider"] : agents.value.find(a => a.available)?.id ?? "claude";
  const settings = selected?.defaults?.teams?.solo?.roleSettings?.agent?.[provider] ?? selected?.defaults?.agentSettings?.[provider] ?? providerDefaults.value[provider] ?? {};
  return store.json<Draft>(`chat-draft:${id === "new" ? project : id}`, { project, repo: selected?.repos.length === 1 ? selected.repos[0]! : selected?.repos.includes(repo.value) ? repo.value : "", message: "", defaults: { mode: "agent", provider, model: settings.model, effort: settings.effort, trust: "standard", tools: false, maxCalls: 12, maxMinutes: 30 }, attachments: [], source: "working_changes", untracked: [], createId: uuid(), messageId: uuid() });
}
const candidateFor = (task: TaskSnapshot): Candidate => editableCandidate(task.proposal!.definition);

export function ChatPage({ id, project: initialProject }: { id: string; project?: string }) {
  const [draft, setDraft] = useState(() => initialDraft(initialProject ?? composerProject.value, id));
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [details, setDetails] = useState(false);
  const [automating, setAutomating] = useState<TaskSnapshot>(), [inspectedTask, setInspectedTask] = useState<string>();
  const [contextOpen, setContextOpen] = useState(false), [compact, setCompact] = useState(false);
  const chatRoot = useRef<HTMLElement>(null);
  useEffect(() => { const el = chatRoot.current; if (!el) return; const observer = new ResizeObserver(() => setCompact(el.clientWidth < 600)); observer.observe(el); return () => observer.disconnect(); }, []);
  const [output, setOutput] = useState<string>(), [outputRun, setOutputRun] = useState<string>(), [earlier, setEarlier] = useState<{ events: ChatEvent[]; tasks: TaskSnapshot[]; hasOlder: boolean; before: number }>(), [loadingHistory, setLoadingHistory] = useState(false);
  const [sourceInfo, setSourceInfo] = useState<{ changed: string[]; untracked: string[] }>();
  const [target, setTarget] = useState<string | null>(draft.targetTask ?? null), [editing, setEditing] = useState<{ taskId: string; candidate: Candidate }>();
  const [allowCalls, setAllowCalls] = useState(24), [allowMinutes, setAllowMinutes] = useState(60), [away, setAway] = useState(false);
  const lock = useRef(false), follow = useRef(true), scroll = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), initialized = useRef(false), alive = useRef(true);
  const defaultsEdited = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null), scrollIntent = useRef(0);
  const dialog = useDialog(details, () => setDetails(false));
  const project = snapshot?.chat.project ?? draft.project, repository = snapshot?.chat.repo ?? draft.repo;
  useEffect(() => {
    if (id !== "new" || !project || !repository || hadSavedDraft.current) return;
    let live = true;
    void api<{ defaults?: import("../src/conversational/chat-model.js").ProjectExecutionDefaults }>(`/api/chats/context?project=${enc(project)}&repo=${enc(repository)}`).then(c => { if (live && !defaultsEdited.current && c.defaults) setDraft(old => ({ ...old, defaults: { ...old.defaults, trust: c.defaults!.trust ?? old.defaults.trust, maxCalls: c.defaults!.maxCalls ?? old.defaults.maxCalls, maxMinutes: c.defaults!.maxMinutes ?? old.defaults.maxMinutes } })); }).catch(() => {});
    return () => { live = false; };
  }, [project, repository, id]);
  const activeTask = snapshot?.tasks.find(t => t.task.id === (target ?? snapshot.chat.activeTask));
  const selectedTask = target ? snapshot?.tasks.find(t => t.task.id === target) : undefined;
  const key = `chat-draft:${id === "new" ? draft.project : id}`;
  const hadSavedDraft = useRef(!!store.get(key)), editedDraft = useRef(false);
  const seen = useRef(new Map<string, string>());
  const saveDraft = (next: Draft) => { try { localStorage.setItem(workspaceKey(`chat-draft:${id === "new" ? next.project : id}`), JSON.stringify({ ...next, attachments: next.attachments.map(file => file.sha256 ? { name: file.name, sha256: file.sha256 } : file) })); } catch { setError("Draft saving is unavailable. Keep this chat open until your message is sent."); } return next; };
  const update = (value: Partial<Draft>) => { editedDraft.current = true; if (value.defaults) defaultsEdited.current = true; setDraft(old => saveDraft({ ...old, ...value })); };
  const apply = (next: ChatSnapshot) => {
    setSnapshot(old => {
      if (old && (old.chat.version > next.chat.version || old.generation === next.generation && old.observation > next.observation)) return old;
      if (old && !follow.current) setEarlier(page => page ?? { events: old.chat.events, tasks: old.tasks, hasOlder: old.history.hasOlder, before: old.history.before });
      return next;
    });
    if (!initialized.current) { initialized.current = true; if (!hadSavedDraft.current && !editedDraft.current) setDraft(old => ({ ...old, project: next.chat.project, repo: next.chat.repo, defaults: next.chat.defaults })); }
    setDraft(old => next.chat.events.some(e => e.id === old.messageId && e.kind === "user") ? saveDraft({ ...old, message: "", attachments: [], messageId: uuid() }) : old);
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const selected = projects.value.find(p => p.id === draft.project); if (id === "new" && !draft.discussion && !draft.repo && selected?.repos.length === 1) setDraft(old => ({ ...old, repo: selected.repos[0]! })); }, [id, draft.project, draft.repo, projects.value]);
  useEffect(() => {
    let cancelled = false;
    const missing = draft.attachments.filter(file => file.sha256 && file.data === undefined);
    if (missing.length) void Promise.all(missing.map(async file => {
      const stored = await chatDraftFiles.read(workspaceKey(file.sha256!));
      if (!stored) throw new Error(`Could not restore ${file.name}. Remove its draft reference and attach it again before sending.`);
      return { ...file, data: stored.data };
    })).then(files => { if (!cancelled) setDraft(old => ({ ...old, attachments: old.attachments.map(file => files.find(found => found.sha256 === file.sha256) ?? file) })); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [draft.attachments.map(file => `${file.sha256}:${file.data === undefined}`).join(",")]);
  useEffect(() => {
    if (id === "new" || !ownerOnLocalListener.value || !agents.value.length || executionPaused.value) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, cursor = "", streamCursor: string | undefined, inFlight = false, dirty = false;
    const poll = async () => {
      if (inFlight) { dirty = true; return; } inFlight = true; clearTimeout(timer);
      try { const data = await api<ChatSnapshot | { cursor: string; unchanged: true }>(`/api/chats/${enc(id)}${cursor ? `?after=${enc(cursor)}` : ""}`, { signal: controller.signal }); if (!controller.signal.aborted) { cursor = data.cursor; if (!("unchanged" in data)) apply(data); } }
      catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { inFlight = false; if (!controller.signal.aborted) { if (dirty) { dirty = false; void poll(); } else timer = setTimeout(poll, 15000); } }
    };
    const off = subscribe(`chat:${id}`, data => { if (data.cursor) streamCursor = data.cursor; if (data.type === "changed" || data.type === "hello" && data.reset) void poll(); }, () => streamCursor);
    void poll(); return () => { controller.abort(); clearTimeout(timer); off(); };
  }, [id, agents.value.length, executionPaused.value, ownerOnLocalListener.value]);
  useEffect(() => { if (!draft.project || !draft.repo || id !== "new" && !!snapshot?.chat.repo || !ownerOnLocalListener.value || !agents.value.length || executionPaused.value) return; const controller = new AbortController(); setSourceInfo(undefined); void api<typeof sourceInfo>(`/api/task-conversations/source?project=${enc(draft.project)}&repo=${enc(draft.repo)}`, { signal: controller.signal }).then(setSourceInfo).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [draft.project, draft.repo, snapshot?.chat.repo, id, agents.value.length, executionPaused.value, ownerOnLocalListener.value]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [snapshot?.history.lastSequence, snapshot?.turn?.status, snapshot?.tasks.map(t => `${t.execution?.status}:${t.execution?.activity.length}`).join(",")]);
  useEffect(() => { const thread = scroll.current?.firstElementChild; if (!thread) return; const observer = new ResizeObserver(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }); observer.observe(thread); return () => observer.disconnect(); }, []);
  useEffect(() => {
    if (!follow.current || !snapshot) return;
    const latestByRun = new Map(snapshot.chat.events.filter(event => ["answer", "result"].includes(event.kind) && event.runId).map(event => [event.runId!, event]));
    for (const [runId, event] of latestByRun) {
      if (seen.current.get(runId) === event.id) continue;
      seen.current.set(runId, event.id);
      void post(`/api/runs/${enc(runId)}/seen`).catch(() => { if (seen.current.get(runId) === event.id) seen.current.delete(runId); });
    }
  }, [snapshot?.history.lastSequence, away]);
  async function perform(work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try { await work(); void refreshChats(); }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function chatAction(chatId: string, action: string, extra: object = {}, operationId: string = uuid()) {
    const fresh = await api<ChatSnapshot>(`/api/chats/${enc(chatId)}`), body = { action, operationId, expectedVersion: fresh.chat.version, ...extra };
    try { await post(`/api/chats/${enc(chatId)}/actions`, body); }
    catch (e) { if (e instanceof TypeError) await post(`/api/chats/${enc(chatId)}/actions`, body); else throw e; }
    const next = await api<ChatSnapshot>(`/api/chats/${enc(chatId)}`); if (alive.current && id !== "new") apply(next); return next;
  }
  useEffect(() => {
    const latestAgent = snapshot?.chat.agentRuns.at(-1), latestTask = activeTask?.execution?.id;
    const lastResult = snapshot?.chat.events.filter(event => event.kind === "result" || event.kind === "answer" && event.runId === latestAgent).at(-1);
    const runId = snapshot?.turn?.mode === "agent" ? snapshot.turn.runId : activeTask?.execution?.status === "running" ? latestTask : lastResult?.runId === latestAgent ? latestAgent : latestTask ?? latestAgent;
    activeChatContext.value = { id, project, repo: repository, runId, appendText: text => { setDraft(old => saveDraft({ ...old, message: [old.message, text].filter(Boolean).join("\n\n"), messageId: uuid() })); input.current?.focus(); } };
    return () => { if (activeChatContext.value?.id === id) activeChatContext.value = null; };
  }, [id, project, repository, snapshot?.history.lastSequence, snapshot?.turn?.runId, activeTask?.execution?.id, activeTask?.execution?.status]);
  const taskAction = (task: TaskSnapshot, action: string, extra: object = {}) => perform(async () => {
    if (["start", "resume", "answer"].includes(action)) latestMessages();
    const fresh = await api<TaskSnapshot>(`/api/task-conversations/${enc(task.task.id)}`);
    if (["start", "edit"].includes(action) && fresh.proposal?.hash !== task.proposal?.hash) throw new Error("The approach changed in another view. Review the current card before continuing; your edits are preserved.");
    await chatAction(id, "task", { taskId: task.task.id, input: { action, expectedVersion: fresh.task.version, ...extra } }); setEditing(undefined);
  });
  useEffect(() => {
    const target = chatSearchTarget.value;
    if (target?.id !== id || !snapshot) return;
    follow.current = false;
    const controller = new AbortController();
    void api<ChatSnapshot>(`/api/chats/${enc(id)}?before=${target.sequence + 1}`, { signal: controller.signal }).then(page => {
      chatSearchTarget.value = undefined;
      setEarlier({ events: page.chat.events, tasks: page.tasks, hasOlder: page.history.hasOlder, before: page.history.before });
      requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight }));
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id, !!snapshot, chatSearchTarget.value]);
  async function olderMessages() {
    if (loadingHistory || !snapshot) return; setLoadingHistory(true);
    try {
      const current = earlier?.events ?? snapshot.chat.events, before = earlier?.before ?? snapshot.history.before;
      const page = await api<ChatSnapshot>(`/api/chats/${enc(id)}?before=${before}`);
      const element = scroll.current, anchor = element?.querySelector(`[data-chat-sequence="${current[0]?.sequence}"]`), offset = anchor?.getBoundingClientRect().top;
      follow.current = false;
      setEarlier({ events: [...page.chat.events, ...current].slice(0, 150), tasks: [...page.tasks, ...(earlier?.tasks ?? [])].filter((t, i, all) => all.findIndex(other => other.task.id === t.task.id) === i && [...page.chat.events, ...current].slice(0, 150).some(e => e.taskId === t.task.id)), hasOlder: page.history.hasOlder, before: page.history.before });
      requestAnimationFrame(() => { if (element && anchor && offset !== undefined) element.scrollTop += anchor.getBoundingClientRect().top - offset; });
    } catch (e) { setError((e as Error).message); } finally { setLoadingHistory(false); }
  }
  function latestMessages() { setEarlier(undefined); scrollIntent.current = 0; follow.current = true; setAway(false); requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" })); }
  const newProject = () => { projectPickerPurpose.value = "chat"; projectEdit.value = "new"; projectsOpen.value = true; };
  function send() {
    if (executionPaused.value) { setError("Chat work is paused by the filesystem restriction. Review it in project settings before continuing."); return; }
    if (!draft.message.trim()) return;
    if (!repository && draft.defaults.provider !== "claude") { setError("Choose a repository for this provider. Tool-free discussion currently requires Claude."); return; }
    if (draft.attachments.some(file => file.data === undefined)) { setError("Wait for attached files to restore, or remove their references before sending."); return; }
    latestMessages();
    void perform(async () => {
      let chatId = id;
      if (id === "new") {
        const created = await post<{ id: string }>("/api/chats", { operationId: draft.createId, project: draft.project, repo: draft.repo, defaults: draft.defaults, source: draft.source, untracked: draft.untracked }); chatId = created.id;
        localStorage.setItem(workspaceKey(`chat-draft:${chatId}`), JSON.stringify({ ...draft, attachments: draft.attachments.map(file => file.sha256 ? { name: file.name, sha256: file.sha256 } : file) }));
        store.remove(key); route.value = { view: "chat", id: chatId };
      } else if (JSON.stringify(snapshot?.chat.defaults) !== JSON.stringify(draft.defaults)) await chatAction(id, "defaults", { defaults: draft.defaults });
      await chatAction(chatId, "send", { message: draft.message.trim(), attachments: draft.attachments.map(({ name, data }) => ({ name, data })), targetTask: target }, draft.messageId);
      update({ message: "", attachments: [], messageId: uuid() });
      if (id === "new") { store.remove(key); route.value = { view: "chat", id: chatId }; }
    });
  }
  async function attach(files: FileList | null) {
    if (!files?.length) return;
    await perform(async () => {
      if (draft.attachments.length + files.length > 10) throw new Error("Attach up to ten files");
      const attachments = [...draft.attachments]; let total = attachments.reduce((n, f) => n + (f.data?.length ?? 0) * .75, 0);
      for (const file of Array.from(files)) {
        if (file.size > 1024 * 1024 || (total += file.size) > 4 * 1024 * 1024) throw new Error("Attach files up to 1 MB each and 4 MB in total");
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file); });
        const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join("");
        await chatDraftFiles.write(workspaceKey(sha256), { data }); attachments.push({ name: file.name, data, sha256 });
      }
      update({ attachments, messageId: uuid() });
    });
  }
  if (executionHost.value.kind !== "local" || onPhone || !ownerOnLocalListener.value) return <div class="composer"><h1>Chat on this computer</h1><p>Remote and container workflows remain available in the workflow composer.</p><button class="btn" onClick={() => void openComposer(project)}>Open workflows</button></div>;
  const pending = snapshot?.turn;
  const providerName = agents.value.find(a => a.id === draft.defaults.provider)?.displayName ?? draft.defaults.provider;
  const catalog = catalogs.value[draft.defaults.provider];
  const modelName = draft.defaults.model ? catalog && !("error" in catalog) ? catalog.models.find(m => m.id === draft.defaults.model)?.label ?? draft.defaults.model : draft.defaults.model : `${providerName.replace(/ Code$/, "")} · Default`;
  const visibleTasks = [...(snapshot?.tasks ?? []), ...(earlier?.tasks ?? []).filter(t => !snapshot?.tasks.some(current => current.task.id === t.task.id))];
  const taskCard = (task: TaskSnapshot) => <ManagedTask key={task.task.id} task={task} busy={busy || executionPaused.value} onAction={(action, extra) => taskAction(task, action, extra)} onEdit={() => { setEditing({ taskId: task.task.id, candidate: candidateFor(task) }); setDetails(true); }} onOutput={() => { setOutputRun(undefined); setOutput(task.task.id); }} onReply={() => { setTarget(task.task.id); update({ targetTask: task.task.id }); input.current?.focus(); }} />;
  return <div class={`chat-workspace ${output ? "has-output" : ""}`}><section ref={chatRoot} class={`task-conversation unified-chat ${id === "new" ? "chat-is-new" : ""} ${compact ? "chat-is-compact" : ""}`} aria-label="Chat conversation">
    <header class="task-page-heading"><div class="task-heading-name"><span class="task-heading-mark"><Icon name="chat" /></span><div><p class="task-kicker">{projects.value.find(p => p.id === project)?.name ?? "Code Flow"}{repository ? ` / ${baseName(repository)}` : ""}</p><h1>{snapshot?.chat.title ?? "New chat"}</h1></div></div><div class="task-page-tools">{id !== "new" ? <button class="btn small" aria-expanded={details} onClick={() => setDetails(true)}><Icon name="sliders" />Task details</button> : null}</div></header>
    <div class="task-chat-scroll-wrap"><div class="task-chat-scroll" ref={scroll} aria-label="Conversation" tabIndex={0} onWheel={() => { scrollIntent.current = Date.now(); }} onTouchMove={() => { scrollIntent.current = Date.now(); }} onPointerDown={() => { scrollIntent.current = Date.now(); }} onKeyDown={e => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) scrollIntent.current = Date.now(); }} onScroll={e => { const el = e.currentTarget, away = el.scrollHeight - el.clientHeight - el.scrollTop > 100; if (!away && !earlier) follow.current = true; else if (Date.now() - scrollIntent.current < 1500) follow.current = false; setAway(away && !follow.current); }}><div class="task-chat-thread"><PolicyPauseNotice what="Chat work is paused"/>
      {(earlier?.hasOlder ?? snapshot?.history.hasOlder) ? <button type="button" class="btn ghost small chat-history-more" disabled={loadingHistory} onClick={() => void olderMessages()}>{loadingHistory ? "Loading earlier messages…" : "Load earlier messages"}</button> : null}
      {earlier ? <p class="chat-history-notice">Viewing earlier messages <button class="btn ghost small" type="button" onClick={latestMessages}>Back to latest</button></p> : null}
      {(earlier?.events ?? snapshot?.chat.events)?.map(event => <div class="chat-event" key={event.id} data-chat-sequence={event.sequence}>{event.kind === "task" ? visibleTasks.find(t => t.task.id === event.taskId) ? taskCard(visibleTasks.find(t => t.task.id === event.taskId)!) : <a class="btn" href={`#/task/${enc(event.taskId!)}`}>Inspect preserved task</a> : event.kind === "result" ? <article class="task-turn chat-deliverable" key={event.id}><div class="task-message-meta"><span class="task-avatar"><Icon name="check" /></span><b>Code Flow</b><span>Result</span></div><div class="task-turn-body"><h2>{event.body}</h2><p class="help">{visibleTasks.find(t => t.task.id === event.taskId)?.view.notice}</p><button class="btn" type="button" onClick={() => { setOutputRun(event.runId); setOutput(event.taskId); }}>{visibleTasks.find(t => t.task.id === event.taskId)?.view.resultLabel ?? "View result"}</button><a class="btn ghost small" href={`#/run/${enc(event.runId!)}`}>Inspect execution and changes</a></div></article> : event.kind === "receipt" ? <p class="chat-receipt" role="status" key={event.id}><Icon name="check" />{event.body}</p> : <article class={`task-message ${event.kind === "user" ? "user" : "system"}`} key={event.id}><div class="task-message-meta"><b>{event.kind === "user" ? "You" : "Code Flow"}</b><time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{event.mode ? <span>{event.mode === "team" ? "Team" : "Agent"}</span> : null}</div><div class="task-message-content">{event.kind === "error" ? <div><p role="alert">{event.body}</p>{event.errorKind === "auth" || event.errorKind === "cli_incompatible" ? <a class="btn small" href="#/settings/agents">Reconnect provider</a> : null}{event.runId ? <a class="btn ghost small" href={`#/run/${enc(event.runId)}`}>Inspect preserved turn</a> : null}</div> : <Markdown text={event.body ?? ""}/>} {event.projectContext?.revision ? <span class="chat-file">Project context · revision {event.projectContext.revision}</span> : null}{event.attachments?.map(file => <span class="chat-file" key={file.name}><Icon name="files" />{file.name}</span>)}</div></article>}</div>)}
      {pending ? <div class="chat-turn-progress" role="status"><span class="task-working-dots" aria-hidden="true"><i /><i /><i /></span><span>{pending.error ? pending.error : pending.queued ? "Queued · waiting for the current writer to settle" : pending.status === "interrupted" ? "Interrupted · work preserved" : pending.paused ? "Paused" : pending.mode === "team" ? "The lead is responding…" : "Your agent is working…"}</span><button class="btn ghost small" disabled={busy} onClick={() => void perform(async () => { await chatAction(id, "control", { control: pending.status === "interrupted" && pending.mode === "team" ? "resume" : "cancel" }); })}>{pending.status === "interrupted" && pending.mode === "team" ? "Resume lead" : "Cancel turn"}</button>{pending.error && !pending.runId ? <button class="btn small" onClick={() => setDetails(true)}>Review settings and allowance</button> : null}{pending.runId ? <a href={`#/run/${enc(pending.runId)}`}>Inspect turn</a> : null}</div> : null}
      {error ? <div class="msg err" role="alert">{error}</div> : null}
    </div></div>{away || earlier ? <button class="btn task-jump-latest" onClick={latestMessages}><Icon name="chevron" />New updates</button> : null}</div>
    {activeTask?.proposal ? <div class="chat-task-shortcuts"><button class="btn ghost small" onClick={() => { setInspectedTask(activeTask.task.id); setDetails(true); }}>View details</button><button class="btn ghost small" onClick={() => setAutomating(activeTask)}>Automate this</button></div> : null}
    <form class="task-followup" aria-label="Chat composer" onSubmit={e => { e.preventDefault(); if (!busy) send(); }}>
      {id === "new" ? <div class="task-new-chat"><div class="task-new-intro"><h1>What would you like to build?</h1><p>Start with a question. Go further with a team.</p></div></div> : null}
      <div class="task-composer-box">
      {selectedTask ? <div class="chat-target"><span>Replying to: {selectedTask.task.request.slice(0, 70)} · Team lead</span><button type="button" class="btn ghost small" aria-label="Switch to new work" onClick={() => { setTarget(null); update({ targetTask: null }); }}>New work</button></div> : null}
      {draft.attachments.length ? <div class="chat-files">{draft.attachments.map((file, i) => <button type="button" class="btn small" key={i} aria-label={`Remove ${file.name}`} onClick={() => update({ attachments: draft.attachments.filter((_, j) => i !== j) })}><Icon name="files" />{file.name}<Icon name="close" /></button>)}</div> : null}
      <label class="sr-only" for="chat-message">Message</label><textarea class="field" id="chat-message" ref={input} value={draft.message} maxLength={12000} placeholder={selectedTask ? "Ask about this task or add guidance…" : "Ask a question or describe what you want to do…"} onInput={e => update({ message: e.currentTarget.value, messageId: uuid() })} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(); } }}/>
      <div class="chat-composer-controls">
        <Menu above label="Add files or context" icon="plus" class="chat-add">{close => <>
          <MenuItem onClick={() => { close(); fileInput.current?.click(); }}><Icon name="attach" />Attach files</MenuItem>
          <MenuItem onClick={() => { close(); setContextOpen(true); }}><Icon name="files" />Project context</MenuItem>
          <MenuItem onClick={() => { close(); setDetails(true); requestAnimationFrame(() => document.getElementById("chat-source-settings")?.scrollIntoView({ block: "start" })); }}><Icon name="folder" />Project and source</MenuItem>
        </>}</Menu>
        <input hidden type="file" tabIndex={-1} ref={fileInput} aria-label="Attach files" multiple onChange={e => { void attach(e.currentTarget.files); e.currentTarget.value = ""; }}/>
        <div class="chat-mode" role="group" aria-label="How new work runs">{(["agent", "team"] as const).map(mode => <button key={mode} type="button" class="btn small" aria-pressed={draft.defaults.mode === mode} onClick={() => { if (mode === "team" && !["claude", "codex"].includes(draft.defaults.provider)) { setError("Choose Claude or Codex to prepare a Team approach."); return; } update({ defaults: { ...draft.defaults, mode } }); }}>{mode === "agent" ? "Agent" : "Team"}</button>)}</div>
        <span class="chat-composer-spacer" />
        <MessageSettings title={draft.defaults.mode === "team" ? "Team lead" : "Agent settings"} summary={<><span class="chat-model-name">{draft.defaults.mode === "team" ? "Lead · " : ""}{modelName}</span>{draft.defaults.effort ? <span class="chat-effort">{draft.defaults.effort}</span> : null}</>}><ChatControls agent={draft.defaults.provider} settings={draft.defaults} onAgent={provider => update({ defaults: { ...draft.defaults, provider, model: undefined, effort: undefined } })} onSettings={settings => update({ defaults: { ...draft.defaults, model: settings.model, effort: settings.effort } })} permissions={draft.defaults} onPermissions={permissions => update({ defaults: { ...draft.defaults, ...permissions } })} providers={draft.defaults.mode === "team" ? agents.value.filter(a => ["claude", "codex"].includes(a.id)) : undefined} showPermissions={false}/><p class="help">{!repository ? "Repository-free discussion uses Claude with all tools disabled. Attach a project repository for code work or other providers." : draft.defaults.mode === "team" ? "The lead prepares approaches and answers questions. Worker models and effort are reviewed in each approach." : providerName}</p></MessageSettings>
        {repository && draft.defaults.mode === "agent" ? <PermissionMenu agent={draft.defaults.provider} permissions={draft.defaults} onPermissions={permissions => update({ defaults: { ...draft.defaults, ...permissions } })}/> : null}
        <button class="btn primary chat-send" type="submit" aria-label="Send" title="Send message" disabled={busy || executionPaused.value || (snapshot?.chat.queue?.length ?? 0) >= 20 || !draft.message.trim() || !!repository && (!project || id === "new" && !sourceInfo) || !repository && draft.defaults.provider !== "claude"}><Icon name="send" /></button>
      </div>
    </div>
    {id === "new" ? <div class="chat-project-context" aria-label="Chat project and repository">
      <label title="Project"><Icon name="folder"/><span class="sr-only">Project</span><select aria-label="Project" value={draft.project} onChange={e => e.currentTarget.value === "__new" ? newProject() : setDraft(initialDraft(e.currentTarget.value, "new"))}><option value="">No project · discussion</option><option value="__new">New project…</option>{projects.value.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <span class="chat-context-divider" aria-hidden="true">/</span>
      <label title="Repository"><Icon name="terminal"/><span class="sr-only">Repository</span><select aria-label="Repository" value={draft.repo} onChange={e => update({ repo: e.currentTarget.value, discussion: !e.currentTarget.value, untracked: [] })}><option value="">Discussion only · no repository</option>{projects.value.find(p => p.id === draft.project)?.repos.map(path => <option key={path} value={path}>{baseName(path)}</option>)}</select></label>
      {!projects.value.length ? <button type="button" class="btn ghost small" onClick={newProject}>Create project</button> : draft.project && !projects.value.find(p => p.id === draft.project)?.repos.length ? <button type="button" class="btn ghost small" onClick={() => addRepositoryToProject(draft.project)}>Add repository</button> : null}
    </div> : null}
    <p class="chat-composer-note"><span>{!repository ? draft.defaults.provider === "claude" ? "Discussion · tools disabled · up to 5 min" : "Choose a repository to use this provider" : selectedTask ? "Replying to the task lead" : draft.defaults.mode === "team" ? "Review the approach before starting work." : ""}</span><span>Enter to send · Shift + Enter for a new line</span></p>
    </form>
    <ProjectContextEditor project={project} repo={repository} open={contextOpen} onClose={() => setContextOpen(false)}/>
    <dialog class="task-details-dialog task-details-drawer" ref={dialog} aria-labelledby="chat-details-title"><div class="task-details-heading"><div><p class="task-kicker">Context, settings and execution evidence</p><h2 id="chat-details-title">Task details</h2></div><button class="icon-btn" aria-label="Close task details" onClick={() => { setDetails(false); setEditing(undefined); }}><Icon name="close" /></button></div><div class="task-details-body">
      {snapshot?.tasks.length ? <><label>Task<select class="field" aria-label="Inspect task" value={inspectedTask ?? activeTask?.task.id ?? snapshot.tasks.at(-1)!.task.id} onChange={e => { setInspectedTask(e.currentTarget.value); setEditing(undefined); }}>{snapshot.tasks.map(t => <option value={t.task.id}>{t.task.request.slice(0,70)} · {t.view.label}</option>)}</select></label>{(() => { const t = snapshot.tasks.find(t => t.task.id === (inspectedTask ?? activeTask?.task.id)) ?? snapshot.tasks.at(-1)!; return <><TaskInspector task={t} onOutput={() => { setDetails(false); setOutputRun(undefined); setOutput(t.task.id); }} onAdjust={() => setEditing({ taskId: t.task.id, candidate: candidateFor(t) })}/>{t.proposal ? <button class="btn" onClick={() => { setDetails(false); setAutomating(t); }}>Automate this</button> : null}</>; })()}</> : null}
      {editing ? <section><h3>Edit proposed approach</h3><ApproachEditor value={editing.candidate} onChange={candidate => setEditing({ ...editing, candidate })} catalogUrl={`/api/task-conversations/models?project=${enc(project)}&repo=${enc(repository)}`}/><button class="btn primary" disabled={busy || executionPaused.value} onClick={() => { const task = snapshot?.tasks.find(t => t.task.id === editing.taskId); if (task) void taskAction(task, "edit", { candidate: editing.candidate }); }}>Save revised approach</button></section> : null}
      <details open={!snapshot?.tasks.length}><summary>Chat context and defaults</summary><section class="task-detail-group" id="chat-source-settings"><h3>Project and source</h3><p>{repository || "Discussion only. Attach a repository when you want the team to inspect, plan or change code."}</p>{!repository && id !== "new" ? <><label>Project<select class="field" aria-label="Project" value={draft.project} disabled={!!snapshot?.chat.project} onChange={e => update({ project: e.currentTarget.value, repo: "" })}><option value="">Choose project</option>{projects.value.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Repository<select class="field" aria-label="Repository" value={draft.repo} onChange={e => update({ repo: e.currentTarget.value, untracked: [] })}><option value="">Choose repository</option>{projects.value.find(p => p.id === draft.project)?.repos.map(path => <option key={path} value={path}>{baseName(path)}</option>)}</select></label><SourcePicker value={draft.source} untracked={draft.untracked} info={sourceInfo} onChange={(source, untracked) => update({ source, untracked })}/><button type="button" class="btn primary" disabled={busy || !!pending || !sourceInfo || !draft.repo || !draft.project} onClick={() => void perform(async () => { await chatAction(id, "repository", { project: draft.project, repo: draft.repo, source: draft.source, untracked: draft.untracked }); setDetails(false); })}>Attach repository</button></> : id === "new" && repository ? <SourcePicker value={draft.source} untracked={draft.untracked} info={sourceInfo} onChange={(source, untracked) => update({ source, untracked })}/> : <p class="help">Each task keeps its reviewed source. Completed implementation is preserved for continuations.</p>}</section>
      <section class="task-detail-group"><h3>Agent allowance for new work</h3>{!repository ? <p class="help">Discussion uses one call and up to five minutes per message. These allowances apply after attaching a repository.</p> : null}<p class="help">Send starts the next Agent turn within these limits. Changing them leaves active work unchanged.</p><div class="task-target-grid"><label>Managed calls<input class="field" type="number" min="1" max="256" value={draft.defaults.maxCalls ?? 12} onInput={e => update({ defaults: { ...draft.defaults, maxCalls: Number(e.currentTarget.value) } })}/></label><label>Execution minutes<input class="field" type="number" min="1" max="720" value={draft.defaults.maxMinutes ?? 30} onInput={e => update({ defaults: { ...draft.defaults, maxMinutes: Number(e.currentTarget.value) } })}/></label></div></section>{snapshot?.chat.queue?.length ? <section class="task-detail-group"><h3>Queued messages</h3>{snapshot.chat.queue.map(queued => <div class="chat-context-file" key={queued.eventId}><p>{snapshot.chat.events.find(event => event.id === queued.eventId)?.body}</p><p class="help">{queued.mode} · {queued.defaults.provider} · {queued.defaults.model || "Default model"} · {queued.defaults.effort || "Default effort"}</p><button class="btn small" disabled={busy} onClick={() => void perform(async () => { await chatAction(id, "cancel_message", { messageId: queued.eventId }); })}>Cancel queued message</button></div>)}</section> : null}<section class="task-detail-group"><h3>Project context</h3><p class="help">Shared instructions and files · revision {snapshot?.projectContext.revision ?? 0}. Each message and accepted task pins its own copy.</p><button type="button" class="btn small" onClick={() => { setDetails(false); setContextOpen(true); }}>Manage project context</button></section><section class="task-detail-group"><h3>Chat files</h3><p class="help">Files stay available across modes. Accepted tasks keep their own pinned copies.</p>{snapshot?.chat.files?.length ? snapshot.chat.files.map(file => <div class="chat-context-file" key={file.sha256}><span>{file.name} · {(file.bytes / 1024).toFixed(1)} KB</span><button class="btn ghost small" disabled={busy || !!pending} onClick={() => void perform(async () => { await chatAction(id, "remove_file", { sha256: file.sha256 }); })}>Remove from future context</button></div>) : <p class="help">No files attached.</p>}</section><section class="task-detail-group"><h3>Lead usage and allowance</h3><p>{snapshot?.leadUsage.calls ?? 0}/{snapshot?.chat.leadAllowance.maxCalls ?? 12} total calls · {((snapshot?.leadUsage.ms ?? 0) / 60000).toFixed(1)}/{snapshot?.chat.leadAllowance.maxMinutes ?? 30} execution minutes</p><p class="help">Each lead reply uses up to three calls and five execution minutes. Retries share the total. Worker execution has its own reviewed allowance.</p>{id !== "new" ? <details><summary>Change total lead allowance</summary><label>Total calls<input class="field" type="number" min={snapshot?.chat.leadAllowance.maxCalls} max="100" value={allowCalls} onInput={e => setAllowCalls(Number(e.currentTarget.value))}/></label><label>Total minutes<input class="field" type="number" min={snapshot?.chat.leadAllowance.maxMinutes} max="240" value={allowMinutes} onInput={e => setAllowMinutes(Number(e.currentTarget.value))}/></label><button class="btn" disabled={busy || !!pending?.runId} onClick={() => void perform(async () => { await chatAction(id, "allowance", { maxCalls: allowCalls, maxMinutes: allowMinutes }); })}>Approve new total allowance</button></details> : null}</section>
      {snapshot?.chat.agentRuns.length ? <section class="task-detail-group"><h3>Agent sessions</h3>{snapshot.chat.agentRuns.map(runId => <a class="task-history-link" href={`#/run/${enc(runId)}`} key={runId}>Inspect session · {runId}</a>)}</section> : null}
    </details></div></dialog>
    {automating ? <AutomationSetup chatId={id} task={automating} onClose={() => setAutomating(undefined)}/> : null}
  </section>{output && visibleTasks.find(t => t.task.id === output) ? <ChatResultPane key={`${output}:${outputRun}`} runId={outputRun} task={visibleTasks.find(t => t.task.id === output)!} onClose={() => setOutput(undefined)}/> : null}</div>;
}

function ManagedTask({ task, busy, onAction, onEdit, onReply, onOutput }: { task: TaskSnapshot; busy: boolean; onAction: (action: string, extra?: object) => void; onEdit: () => void; onReply: () => void; onOutput: () => void }) {
  const proposal = task.proposal, run = task.execution, started = !!proposal?.runId;
  if (!proposal) return <p class="help">{task.task.error ?? "Preparing the approach…"}</p>;
  return <article class="task-turn chat-task-card" aria-label="Task card"><div class="task-message-meta"><span class="task-avatar"><Icon name="layers" /></span><b>Code Flow</b><span>Team task</span></div><div class="task-turn-body"><div class="chat-task-top"><h2>{task.task.request.split("\n")[0]!.slice(0, 100)}</h2><span class="task-state" role="status">{task.view.label}</span></div><p class="help">{proposal.definition.scope === "write" ? "Implement and verify" : proposal.definition.scope === "review" ? "Review changes · no code edits" : "Plan only · no code edits"}</p>
    {!started ? <><div class="task-participants">{proposal.definition.participants.map(p => <div key={p.id}><b>{p.id}</b><span>{p.provider} · {p.model ?? "Provider default"} · {p.effort ?? "Default effort"}</span></div>)}</div><h3>Done when</h3><ul>{proposal.definition.completion.map(c => <li key={c}>{c}</li>)}</ul><details><summary>Approach, source and commands</summary><Sequence steps={proposal.definition.steps}/><p>Source: <code>{proposal.source.commit.slice(0, 12)}</code> · {proposal.context.continueRunId ? "retained Team work" : proposal.context.sourceRunId ? "retained Agent work" : proposal.source.source}</p><p>Check: <code>{proposal.definition.check || "No code check required for this scope"}</code></p><p>Setup: <code>{proposal.definition.setup || "None"}</code></p></details><p class="help">Up to {proposal.definition.limits.maxInvocations} managed calls · {proposal.definition.limits.maxMinutes} minutes. Retries and review passes share this allowance.</p>{task.task.changes.map(c => <p class="help" key={c}>{c}</p>)}<div class="task-actions"><button class="btn primary" disabled={busy} onClick={() => onAction("start", { proposalId: proposal.id, revision: proposal.revision, hash: proposal.hash })}>{task.view.startLabel}<Icon name="play" /></button><button class="btn" disabled={busy} onClick={onEdit}>Adjust approach</button><button class="btn ghost small" disabled={busy} onClick={() => onAction("edit", { candidate: candidateFor(task) })}>Refresh source</button></div></> : <>{run?.status === "running" ? <><p class="chat-current-stage" role="status">{task.view.stage}</p><TaskActivity execution={run} compact/><div class="task-actions"><button class="btn small" disabled={busy || run.pausePending} onClick={() => onAction(run.paused ? "resume" : "pause")}>{run.paused ? "Resume accepted work" : "Pause"}</button><button class="btn ghost small" disabled={busy} onClick={() => onAction("cancel")}>Cancel task</button></div></> : null}{run?.recoveryRequired ? <p class="msg err">An interrupted write needs inspection. Open the preserved execution before proposing a continuation.</p> : null}{run?.error || run?.detail ? <p class="help">{(run.error ?? run.detail)?.split("\n")[0]}</p> : null}{run?.questions.map(q => <div class="task-question" key={q.id}><h3>{q.question}</h3>{q.inputs?.length ? <TaskResult taskId={task.task.id} execution={run} preferredId={q.inputs[0]} label="Decision evidence"/> : null}<div class="task-actions">{q.options.map(option => <button class="btn" disabled={busy} key={option} onClick={() => onAction("answer", { questionId: q.id, message: option })}>{option}</button>)}</div></div>)}</>}
    <div class="task-actions"><button class="btn small" type="button" onClick={onOutput}>{started ? task.view.resultLabel : "View approach"}</button><button class="btn ghost small" onClick={onReply}>Ask about this task</button>{task.view.recovery === "reconnect" ? <a class="btn small" href="#/settings/agents">Reconnect provider</a> : task.view.recovery === "inspect" ? <a class="btn small" href={`#/run/${enc(run!.id)}`}>Inspect preserved work</a> : task.view.recovery === "allowance" || task.view.recovery === "revise" ? <button type="button" class="btn small" onClick={onReply}>Review a continuation</button> : null}</div></div></article>;
}
