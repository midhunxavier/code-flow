import { StoppedResult } from "./stopped-result.js";
import { editableCandidate as editable } from "../src/cli-teams/editable.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, post, enc, baseName, store, workspaceKey, onPhone, sendOnEnter } from "./lib.js";
import { projects, composerProject, repo, route, openComposer } from "./state.js";
import { executionHost } from "./ssh-projects.js";
import { Markdown } from "./bits.js";
import { Icon } from "./icons.js";
import { useDialog } from "./app.js";
import type { ComponentChildren } from "preact";
import type { Candidate, Definition, Node, Participant } from "../src/cli-teams/model.js";
import type { ModelCatalog } from "./types.js";
import type { TaskSnapshot } from "../src/conversational/service.js";
const ROOT = "/api/task-conversations";
const op = () => crypto.randomUUID();
type Draft = {
    project: string;
    repo: string;
    request: string;
    source: "head" | "working_changes";
    untracked: string[];
    coordinator: Participant;
    coordinatorSelected?: boolean;
};
function draftFor(project = composerProject.value, repository = repo.value): Draft { return store.json<Draft>(`task-draft:${project}`, { project, repo: repository, request: "", source: "working_changes", untracked: [], coordinator: { id: "coordinator", provider: "claude" } }); }
const OUTCOMES: Record<string, string> = { plan_ready: "Plan ready", agreed_plan: "Plan agreed", verified_changes: "Changes verified", review_complete: "Review complete", stopped_limit: "Stopped · partial work preserved", blocked: "Needs attention · partial work preserved" };
export function TaskConversationPage({ id }: {
    id: string;
}) {
    const [requestEdit, setRequestEdit] = useState("");
    const [sourceError, setSourceError] = useState(""), [sourceReload, setSourceReload] = useState(0);
    const [draft, setDraft] = useState<Draft>(() => { const entry = store.json("task-entry", { project: composerProject.value, repo: repo.value }); return draftFor(entry.project, entry.repo); });
    const [snapshot, setSnapshot] = useState<TaskSnapshot>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [sourceInfo, setSourceInfo] = useState<{
        changed: string[];
        untracked: string[];
        defaultProvider?: "claude" | "codex";
    }>(), [recent, setRecent] = useState<{
        id: string;
        request: string;
    }[]>([]);
    const [sourceEdit, setSourceEdit] = useState<{
        source: Draft["source"];
        untracked: string[];
    }>(), [edited, setEdited] = useState<Candidate>(), [allowCalls, setAllowCalls] = useState(6), [allowMinutes, setAllowMinutes] = useState(10);
    const busyRef = useRef(false), createAttempt = useRef<{
        operationId: string;
        body: object;
    }>(), actionAttempt = useRef<{
        body: any;
        hash: string;
    }>();
    const task = snapshot?.task, proposal = snapshot?.proposal, execution = snapshot?.execution;
    const resultRef = useRef<HTMLElement>(null), lastResult = useRef("");
    const chatRef = useRef<HTMLDivElement>(null), followChat = useRef(true);
    const [awayFromLatest, setAwayFromLatest] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
    const detailsRef = useDialog(detailsOpen, () => setDetailsOpen(false));
    const project = task?.project ?? draft.project, repository = task?.repo ?? draft.repo;
    const active = execution?.status === "running", preparing = !!task?.preparation.active;
    const applySnapshot = (data: TaskSnapshot) => setSnapshot(old => old && (old.task.version > data.task.version || old.generation === data.generation && old.observation > data.observation) ? old : data);
    const catalogUrl = project && repository ? `${ROOT}/models?project=${enc(project)}&repo=${enc(repository)}` : "";
    useEffect(() => { if (execution && execution.status !== "running")
        void post(`/api/runs/${enc(execution.id)}/seen`).catch(() => { }); }, [execution?.id, execution?.status]);
    useEffect(() => {
        const chat = chatRef.current;
        if (id === "new" || !chat || !followChat.current) return;
        if (execution && execution.status !== "running" && execution.artifacts.length && lastResult.current !== execution.id) {
            lastResult.current = execution.id;
            (resultRef.current?.closest(".task-turn") ?? resultRef.current)?.scrollIntoView({ block: "start", behavior: "auto" });
        } else chat.scrollTop = chat.scrollHeight;
    }, [task?.messages.length, preparing, task?.question?.question, execution?.id, execution?.status, execution?.activity.length, execution?.questions.length]);
    useEffect(() => {
        const chat = chatRef.current;
        if (id === "new" || !chat) return;
        const observer = new ResizeObserver(() => { if (followChat.current) chat.scrollTop = chat.scrollHeight; });
        observer.observe(chat);
        return () => observer.disconnect();
    }, [id]);
    useEffect(() => {
        if (id !== "new")
            return;
        try {
            localStorage.setItem(workspaceKey(`task-draft:${draft.project}`), JSON.stringify(draft));
        }
        catch {
            setError("Draft saving is unavailable. Keep this page open until the task is created.");
        }
    }, [draft, id]);
    useEffect(() => {
        if (id === "new")
            return;
        const controller = new AbortController();
        let cursor = "";
        const poll = async () => {
            while (!controller.signal.aborted) {
                try {
                    const data = await api<TaskSnapshot>(`${ROOT}/${enc(id)}${cursor ? `?after=${enc(cursor)}&wait=25000` : ""}`, { signal: controller.signal });
                    if (controller.signal.aborted)
                        return;
                    cursor = data.cursor;
                    applySnapshot(data);
                }
                catch (e) {
                    if (controller.signal.aborted)
                        return;
                    setError((e as Error).message);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        };
        void poll();
        return () => controller.abort();
    }, [id]);
    useEffect(() => {
        if (!project || !repository)
            return;
        const controller = new AbortController();
        setSourceInfo(undefined); setSourceError("");
        void api<typeof sourceInfo>(id === "new" ? `${ROOT}/source?project=${enc(project)}&repo=${enc(repository)}` : `${ROOT}/${enc(id)}/source`, { signal: controller.signal }).then(setSourceInfo).catch(e => { if (!controller.signal.aborted) setSourceError(e.message); });
        void api<typeof recent>(`${ROOT}?project=${enc(project)}`, { signal: controller.signal }).then(setRecent).catch(() => { });
        return () => controller.abort();
    }, [project, repository, id, execution?.status, sourceReload]);
    async function action(action: string, extra: object = {}) {
        if (busyRef.current || !snapshot)
            return;
        busyRef.current = true;
        setBusy(true);
        setError("");
        try {
            const source = sourceEdit && ["prepare", "edit"].includes(action) ? { source: sourceEdit.source, untracked: sourceEdit.untracked } : {};
            const hash = JSON.stringify({ action, ...extra, ...source });
            const attempt = actionAttempt.current?.hash === hash ? actionAttempt.current : { hash, body: { operationId: op(), expectedVersion: snapshot.task.version, action, ...extra, ...source } };
            actionAttempt.current = attempt;
            try {
                await post(`${ROOT}/${enc(id)}/actions`, attempt.body);
            }
            catch (e) {
                // A lost response is reconciled with the same operation ID and exact arguments.
                if (e instanceof TypeError)
                    await post(`${ROOT}/${enc(id)}/actions`, attempt.body);
                else
                    throw e;
            }
            actionAttempt.current = undefined;
            setMessage("");
            setEdited(undefined);
            setSourceEdit(undefined);
            applySnapshot(await api<TaskSnapshot>(`${ROOT}/${enc(id)}`));
        }
        catch (e) {
            setError((e as Error).message);
            applySnapshot(await api<TaskSnapshot>(`${ROOT}/${enc(id)}`).catch(() => snapshot));
            actionAttempt.current = undefined;
        }
        finally {
            busyRef.current = false;
            setBusy(false);
        }
    }
    async function create() {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setBusy(true);
        setError("");
        let created: {
            id: string;
            version: number;
        } | undefined;
        try {
            const { id: _, binding: __, ...coordinator } = draft.coordinator;
            const { coordinatorSelected: _selected, ...draftBody } = draft;
            const body = { ...draftBody, coordinator: draft.coordinatorSelected ? coordinator : sourceInfo?.defaultProvider ? { provider: sourceInfo.defaultProvider } : undefined };
            if (!createAttempt.current || JSON.stringify(createAttempt.current.body) !== JSON.stringify(body))
                createAttempt.current = { body, operationId: op() };
            const attempt = createAttempt.current;
            created = await post(ROOT, { ...attempt.body, operationId: attempt.operationId });
            await post(`${ROOT}/${created!.id}/actions`, { action: "prepare", expectedVersion: created!.version, operationId: `prepare-${attempt.operationId}` });
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            busyRef.current = false;
            setBusy(false);
            if (created)
                route.value = { view: "task", id: created.id };
        }
    }
    function send() {
        const body = message.trim();
        if (!body)
            return;
        followChat.current = true;
        const control = /^(pause|resume|cancel|stop)[.!]?$/i.exec(body);
        if (control)
            return void action(control[1]!.toLowerCase() === "stop" ? "cancel" : control[1]!.toLowerCase());
        if (/^(what|why|how|status|explain|summari[sz]e)\b/i.test(body) && !/\b(and|then|also)\b.*\b(fix|change|implement|build|use)\b/i.test(body))
            return void action("status", { message: body });
        const material = /\b(model|effort|provider|reviewer|passes|allowance|budget|more calls|implement|build this|deploy|push|merge)\b/i.test(body);
        void action(active && !material ? "message" : "prepare", { message: body });
    }
    const finished = !!execution && execution.status !== "running" && execution.artifacts.length > 0;
    const phase = preparing ? "Preparing approach" : task?.question ? "Your answer is needed" : proposal && !proposal.runId ? "Ready for your review" : execution ? execution.questions.length ? "Waiting for your answer" : execution.paused ? execution.pausePending ? "Pausing" : "Paused" : execution.waitingForSlot ? "Waiting for a slot" : execution.status === "running" ? "Working" : execution.outcome ? OUTCOMES[execution.outcome] ?? "Work preserved" : execution.status === "done" ? "Completed" : "Needs attention" : "Prepare an approach to begin";
    // Keep follow-up messages after the result they discuss. Older records without activity retain their order.
    const resultAt = finished && execution.activity.length ? Math.max(...execution.activity.map(a => a.endedAt ?? a.startedAt)) : Infinity;
    const beforeResult = task?.messages.filter(m => m.at <= resultAt) ?? [], afterResult = task?.messages.filter(m => m.at > resultAt) ?? [];
    const projectName = projects.value.find(p => p.id === project)?.name ?? "New task";
    const approachCard = proposal || task?.draftCandidate ? <details class="task-approach" open={!proposal?.runId || !!edited} aria-label="Proposed approach">
      <summary><Icon name="layers" />{proposal?.runId ? "View approved approach" : "Review proposed approach"}</summary>
      <div class="task-card-heading"><div><p class="lbl">{proposal ? `Approach · revision ${proposal.revision}` : "Approach needs correction"}</p><h2>{(edited?.scope ?? proposal?.definition.scope ?? task!.draftCandidate?.scope) === "write" ? "Implement and verify" : (edited?.scope ?? proposal?.definition.scope ?? task!.draftCandidate?.scope) === "review" ? "Review changes · no code edits" : "Produce a plan · no code edits"}</h2></div>{!edited ? <button class="btn small" disabled={busy || preparing} onClick={() => setEdited(proposal ? editable(proposal.definition) : structuredClone(task!.draftCandidate!))}>Edit approach</button> : null}</div>
      <SourcePicker retained={!!task!.continuation || !!task!.sourceRunId || !!execution} value={sourceEdit?.source ?? task!.source} untracked={sourceEdit?.untracked ?? task!.untracked} info={sourceInfo} onChange={(source, untracked) => setSourceEdit({ source, untracked })}/>
      {sourceEdit ? <p class="help" role="status">Source selection changed. Refresh source or save the approach before starting.</p> : null}
      {task!.changes.length ? <div class="task-changes" role="status">{task!.changes.map(change => <p key={change}>{change}</p>)}</div> : null}
      {edited ? <><ApproachEditor value={edited} onChange={setEdited} catalogUrl={catalogUrl}/><div class="task-actions"><button class="btn primary" disabled={busy} onClick={() => void action("edit", { candidate: edited })}>Save revised approach</button><button class="btn ghost" onClick={() => setEdited(undefined)}>Discard edits</button></div></> : proposal ? <>
        <div class="task-participants">{proposal.definition.participants.map(p => <div key={p.id}><b>{p.id}</b><span>{p.provider} · {p.model ?? "provider default"} · {p.effort ?? "default effort"}</span><small>Independent managed context</small></div>)}</div>
        <Sequence steps={proposal.definition.steps}/>
        <h3>Complete when</h3><ul>{proposal.definition.completion.map(c => <li key={c}>{c}</li>)}</ul>
        <p><b>Execution allowance:</b> {proposal.definition.limits.maxInvocations} managed calls · {proposal.definition.limits.maxMinutes} minutes · {proposal.definition.limits.concurrency} concurrent workers.</p><p class="help">Review passes share this allowance. Retries consume calls and can stop the process before its pass limit.</p>
        <details><summary>Source, commands, and attempt limits</summary><p>Source: {proposal.context.continueRunId ? "retained execution work" : proposal.source.source === "head" ? "committed code" : "working copy"} · <code>{proposal.source.commit.slice(0, 12)}</code></p><p>Selected new files: {proposal.source.untracked.join(", ") || "none"}</p><p>Setup: <code>{proposal.definition.setup || "none"}</code></p><p>Check: <code>{proposal.definition.check || "none"}</code></p><p>{proposal.definition.limits.maxAttempts} attempts per assignment; {proposal.definition.limits.attemptTimeoutMs / 60000} minutes per attempt. No automatic merge, push, or deployment.</p></details>
        {!proposal.runId ? <div class="task-approach-start"><button class="btn primary" disabled={busy || preparing || active || !!sourceEdit} onClick={() => void action("start", { proposalId: proposal.id, revision: proposal.revision, hash: proposal.hash })}>{busy ? "Checking whether the task started…" : "Start task"}<Icon name="play" /></button><button class="btn ghost small" disabled={busy || preparing} onClick={() => void action("edit", { candidate: editable(proposal.definition) })}>Refresh source and review again</button></div> : <p class="help">This revision started execution {proposal.runId}. Changes require another reviewed approach.</p>}
      </> : null}
    </details> : null;
    const pendingWork = snapshot ? <>
      {preparing ? <ChatTurn meta="Preparing approach"><div class="task-progress" role="status"><div class="task-working-title"><span class="task-working-dots" aria-hidden="true"><i /><i /><i /></span><b>{snapshot.preparing?.status === "interrupted" ? "Preparation interrupted · work preserved" : "Preparing your approach"}</b></div><p>{snapshot.preparing?.steps.at(-1)?.title ?? "Checking available models and repository context"}</p>{snapshot.preparing?.status === "interrupted" ? <button class="btn small" disabled={busy} onClick={() => void action("prepare")}>Resume preparation</button> : <button class="btn ghost small" disabled={busy} onClick={() => void action("cancel")}>Cancel preparation</button>}</div></ChatTurn> : null}
      {task?.question ? <ChatTurn meta="A quick question"><div class="task-question"><h2>{task.question.question}</h2><div class="task-actions">{task.question.options.map(option => <button key={option} class="btn" disabled={busy} onClick={() => void action("prepare", { message: option })}>{option}</button>)}</div><p class="help">Choose an option or answer in the reply box.</p></div></ChatTurn> : null}
      {!proposal?.runId && approachCard ? <ChatTurn meta="Proposed approach">{approachCard}</ChatTurn> : null}
    </> : null;
    if (executionHost.value.kind !== "local" || onPhone)
        return <div class="composer"><h1>Conversational tasks</h1><p>This preview runs on This computer. Existing remote workflows remain available.</p><button class="btn" onClick={() => void openComposer(project)}>Back to existing workflows</button></div>;
    return <section class={`task-conversation ${id === "new" ? "task-is-new" : ""}`} aria-label="Task conversation">
      <header class="task-page-heading">
        <div class="task-heading-name"><span class="task-heading-mark"><Icon name="chat" /></span><div><p class="task-kicker">Task conversation <span>Preview</span></p><h1 title={repository}>{projectName}{repository && baseName(repository) !== projectName ? <span> / {baseName(repository)}</span> : null}</h1></div></div>
        <div class="task-page-tools">{task ? <span class={`task-state ${active || preparing ? "working" : ""}`} role="status"><i />{phase}</span> : null}<button class="btn ghost small" aria-label="Back to existing workflows" title="Back to existing workflows" onClick={() => void openComposer(project)}><Icon name="layers" /><span>Workflows</span></button>{task ? <button class="btn small task-details-trigger" aria-expanded={detailsOpen} aria-controls="task-details" onClick={() => setDetailsOpen(true)}><Icon name="sliders" />Task details</button> : null}</div>
      </header>
      <div class="task-chat-scroll-wrap">
        <div class="task-chat-scroll" ref={chatRef} tabIndex={0} role="region" aria-label="Conversation" onScroll={e => { const el = e.currentTarget, away = el.scrollHeight - el.clientHeight - el.scrollTop > 100; followChat.current = !away; setAwayFromLatest(away); }}>
          <div class="task-chat-thread">
            {id === "new" ? <div class="task-new-chat">
              <div class="task-new-intro"><span class="task-intro-mark"><Icon name="sparkle" /></span><h2>What would you like to work on?</h2><p>Describe the outcome. Your agents’ approach, work, and results will stay in this conversation.</p></div>
              <div class="task-target-grid"><label>Project<select class="field" value={draft.project} onChange={e => { const next = e.currentTarget.value, p = projects.value.find(p => p.id === next); setDraft(draftFor(next, p?.repos.length === 1 ? p.repos[0]! : "")); }}><option value="">Choose project</option>{projects.value.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Repository<select class="field" value={draft.repo} onChange={e => setDraft({ ...draft, repo: e.currentTarget.value, untracked: [] })}><option value="">Choose repository</option>{projects.value.find(p => p.id === draft.project)?.repos.map(path => <option key={path} value={path}>{baseName(path)}</option>)}</select></label></div>
              <div class="task-new-composer"><label class="sr-only" for="conversation-request">What would you like to do?</label><textarea id="conversation-request" class="field task-request" value={draft.request} maxLength={12000} placeholder="Fix a bug, explore an idea, or plan what to build next…" onInput={e => setDraft({ ...draft, request: e.currentTarget.value })}/><div class="task-new-send"><span>Review the approach before work starts.</span><button class="btn primary" disabled={busy || !draft.project || !draft.repo || !draft.request.trim() || !sourceInfo} onClick={() => void create()}>{busy ? "Preparing…" : "Prepare approach"}<Icon name="send" /></button></div></div>
              <div class="task-new-settings"><SourcePicker value={draft.source} untracked={draft.untracked} info={sourceInfo} onChange={(source, untracked) => setDraft({ ...draft, source, untracked })}/><details><summary>Coordinator and preparation allowance</summary><p>Preparation uses up to 3 coordinator calls and 5 execution minutes, including retries and revisions. It prepares the process; the requested work starts after your review.</p><p class="help">Coordinator: {draft.coordinatorSelected ? draft.coordinator.provider : sourceInfo?.defaultProvider ?? "checking project defaults"}. You can choose an explicit override below.</p><ParticipantPicker value={draft.coordinatorSelected ? draft.coordinator : { id: "coordinator", provider: sourceInfo?.defaultProvider ?? "claude" }} catalogUrl={catalogUrl} onChange={coordinator => setDraft({ ...draft, coordinator, coordinatorSelected: true })}/></details></div>
              <p class="task-preparation-note">Preparation allowance: 3 calls · 5 minutes</p>
            </div> : !snapshot ? <p role="status">Restoring your conversation…</p> : <>
              <div class="task-thread-start"><span>{projectName}</span><span>{task!.continuation ? "Retained execution work" : task!.source === "head" ? "Committed code" : "Working copy"}</span></div>
              <div class="task-messages" aria-label="Conversation messages">{beforeResult.map(m => <TaskChatMessage key={m.id} message={m} execution={execution}/>)}</div>
              {!finished ? pendingWork : null}
              {execution ? <ChatTurn meta={finished ? "Result" : "Agent activity"}>
                {finished ? <section class="task-final" ref={resultRef}><h2>{proposal && !proposal.runId ? "Previous result · revised approach awaiting review" : execution.outcome ? OUTCOMES[execution.outcome] ?? "Work preserved" : "Stopped · partial work preserved"}</h2><TaskResult taskId={id} execution={execution}/></section> : <div class="task-execution" aria-label="Execution progress"><h2>{phase}</h2><p class="help">{execution.usage.calls}/{execution.limits?.maxInvocations ?? "?"} calls · {(execution.usage.ms / 60000).toFixed(1)} execution minutes</p><TaskActivity execution={execution} compact />{active ? <div class="task-actions"><button class="btn small" disabled={busy} onClick={() => void action(execution.paused ? "resume" : "pause")}>{execution.paused ? "Continue accepted work" : "Pause"}</button><button class="btn ghost small" disabled={busy} onClick={() => void action("cancel")}>Cancel execution</button></div> : execution.status !== "done" && !execution.outcome && !execution.recoveryRequired && execution.usage.calls < (execution.limits?.maxInvocations ?? 0) ? <button class="btn" disabled={busy} onClick={() => void action("resume")}>Retry accepted work within allowance</button> : null}</div>}
                {execution.error || execution.detail || execution.stopReason ? <p class="task-execution-note" role="status">{execution.error ?? execution.detail ?? execution.stopReason}</p> : null}
                {execution.questions.map(q => <div class="task-question" key={q.id}><h3>{q.question}</h3>{q.inputs?.length ? <TaskResult taskId={id} execution={execution} preferredId={q.inputs[0]} label="Decision evidence"/> : null}<div class="task-actions">{q.options.map(option => <button key={option} class="btn" disabled={busy} onClick={() => void action("answer", { questionId: q.id, message: option })}>{option}</button>)}</div></div>)}
                {active && execution.artifacts.length ? <details class="task-work-so-far"><summary>Work so far</summary><TaskResult taskId={id} execution={execution}/></details> : null}
                <div class="task-result-actions"><button class="btn ghost small" disabled={busy} onClick={() => void action("status", { message: "What remains unresolved?" })}><Icon name="chat" />What remains unresolved?</button><a class="btn ghost small" href={`#/run/${enc(execution.id)}`}><Icon name="diff" />Inspect execution and changes</a></div>
              </ChatTurn> : null}
              {afterResult.length ? <div class="task-messages" aria-label="Follow-up messages">{afterResult.map(m => <TaskChatMessage key={m.id} message={m} execution={execution}/>)}</div> : null}
              {finished ? pendingWork : null}
              {task!.error ? <div class="msg err" role="alert"><p>{task!.error}</p><button class="btn" disabled={busy} onClick={() => void action("prepare")}>Retry preparation within remaining allowance</button></div> : null}
            </>}
            {error && error !== task?.error ? <div class="msg err" role="alert">{error}</div> : null}
            {sourceError ? <div class="msg err" role="alert"><p>{sourceError}</p><button class="btn" onClick={() => setSourceReload(value => value + 1)}>Retry source discovery</button></div> : null}
          </div>
        </div>
        {awayFromLatest && task ? <button class="btn task-jump-latest" onClick={() => { followChat.current = true; chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }); }}><Icon name="chevron" />Latest message</button> : null}
      </div>
      {task ? <form class="task-followup" aria-label="Reply to task" onSubmit={e => { e.preventDefault(); if (!busy && !preparing) send(); }}>
        <div class="task-composer-box"><label class="sr-only" for="task-message">Continue this task</label><textarea id="task-message" class="field" value={message} maxLength={8000} placeholder={task.question ? "Your answer…" : "Reply, ask a question, or describe what to change…"} onInput={e => setMessage(e.currentTarget.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && sendOnEnter()) { e.preventDefault(); if (!busy && !preparing) send(); } }}/><div class="task-composer-toolbar"><button type="button" class="btn ghost small" aria-label="Prepare revised approach" disabled={busy || preparing || !message.trim()} onClick={() => void action("prepare", { message: message.trim() })}><Icon name="refresh" />Revise approach</button><button type="submit" class="btn primary task-send" aria-label="Send" title="Send message" disabled={busy || preparing || !message.trim()}><Icon name="send" /></button></div></div>
        <div class="task-composer-hint"><span>{preparing ? "Preparing the approach. Your draft stays here." : "Changes to scope or team require a new approach for review."}</span><span>Use Send to submit your reply</span></div>
      </form> : null}
      {task ? <dialog id="task-details" class="task-details-dialog" ref={detailsRef} aria-labelledby="task-details-title"><div class="task-details-heading"><div><p class="task-kicker">Everything behind this task</p><h2 id="task-details-title">Task details</h2></div><button class="icon-btn" aria-label="Close task details" onClick={() => setDetailsOpen(false)}><Icon name="close" /></button></div><div class="task-details-body">
        <section class="task-detail-group"><h3>Project and source</h3><p><b>{projectName}</b></p><p class="help">{repository}</p><p class="help">{task.continuation ? "Retained execution work" : task.source === "head" ? "Committed code" : "Working copy"}</p></section>
        {execution?.participation?.length ? <section class="task-detail-group" aria-label="Agent participation"><h3>Agent participation</h3>{execution.participation.map(p => <details class="task-participation" key={p.id}><summary><span><b>{p.id}</b><small>{p.provider} · {p.model ?? "default model"} · {p.effort ?? "default effort"}</small></span><span>{p.assignments.filter(a => a.status === "done").length}/{p.assignments.length} done</span></summary>{p.assignments.length ? p.assignments.map(a => <p class="task-participation-receipt" key={a.id}><b>{a.id} · {a.status} · {a.invocations} launch{a.invocations === 1 ? "" : "es"}</b><small>{a.sessionId ? `CLI session: ${a.sessionId}` : "No native session receipt recorded"}</small></p>) : <p class="help">No assignment dispatched yet.</p>}</details>)}<p class="help">From recorded CLI dispatches and sessions. Model and effort identify the configured settings; worker prose does not determine participation.</p></section> : null}
        <section class="task-detail-group"><h3>Usage and allowances</h3><p class="help">Preparation: {snapshot!.preparationUsage.calls}/{task.preparation.maxCalls} calls · {(snapshot!.preparationUsage.ms / 60000).toFixed(1)}/{task.preparation.maxMinutes} min</p>{execution ? <p class="help">Execution: {execution.usage.calls}/{execution.limits?.maxInvocations ?? "?"} calls · {(execution.usage.ms / 60000).toFixed(1)} min<br/>{snapshot!.executionTotals.calls} calls across this task</p> : null}<details><summary>Change preparation allowance</summary><div class="task-target-grid"><label>Total calls<input class="field" type="number" min={task.preparation.maxCalls} max="20" value={allowCalls} onInput={e => setAllowCalls(Number(e.currentTarget.value))}/></label><label>Total minutes<input class="field" type="number" min={task.preparation.maxMinutes} max="60" value={allowMinutes} onInput={e => setAllowMinutes(Number(e.currentTarget.value))}/></label></div><button class="btn" disabled={busy || preparing} onClick={() => void action("allow_preparation", { maxCalls: allowCalls, maxMinutes: allowMinutes })}>Approve new total preparation allowance</button></details></section>
        <section class="task-detail-group"><details open><summary>Previous executions and worktrees</summary>{task.executions.length ? task.executions.map((runId, i) => <a class="task-history-link" key={runId} href={`#/run/${enc(runId)}`}><Icon name="terminal" /><span>Execution {i + 1}<small>{runId}</small></span><span aria-hidden="true">↗</span></a>) : <p class="help">No execution has started yet.</p>}{execution?.worktrees.map(w => <p class="task-worktree-path" key={w.path}><b>{w.branch}</b><code>{w.path}</code></p>)}</details></section>
        <section class="task-detail-group"><details open><summary>Approach history</summary><ol class="task-approach-history">{task.approaches?.map(p => <li key={`${p.id}:${p.revision}`}><HistoricalApproach taskId={id} proposalId={p.id} revision={p.revision} scope={p.scope}/></li>)}</ol></details></section>
        {proposal?.runId ? <section class="task-detail-group">{approachCard}</section> : null}
        {execution ? <section class="task-detail-group"><details><summary>Execution activity</summary><TaskActivity execution={execution}/></details></section> : null}
        <section class="task-detail-group"><details><summary>Edit the complete task request</summary><p class="help">A replacement request keeps this conversation as history and prepares a new approach for review.</p><textarea class="field" aria-label="Complete task request" value={requestEdit} maxLength={12000} placeholder={proposal?.task ?? task.request} onInput={e => setRequestEdit(e.currentTarget.value)}/><button class="btn" disabled={busy || preparing || !requestEdit.trim()} onClick={() => void action("prepare", { request: requestEdit })}>Prepare replacement request</button></details></section>
        {recent.length ? <section class="task-detail-group"><details><summary>Other task conversations in this project</summary>{recent.filter(t => t.id !== id).map(t => <a class="task-related-link" key={t.id} href={`#/task/${enc(t.id)}`}><Icon name="chat" />{t.request}</a>)}</details></section> : null}
      </div></dialog> : null}
    </section>;
}
function ChatTurn({ children, meta }: { children: ComponentChildren; meta: string }) {
    return <article class="task-turn"><div class="task-message-meta"><span class="task-avatar"><Icon name="layers" /></span><b>Code Flow</b><span>{meta}</span></div><div class="task-turn-body">{children}</div></article>;
}
function TaskChatMessage({ message: m, execution }: { message: TaskSnapshot["task"]["messages"][number]; execution?: TaskSnapshot["execution"] }) {
    return <article class={`task-message ${m.role}`}><div class="task-message-meta">{m.role === "system" ? <span class="task-avatar"><Icon name="layers" /></span> : null}<b>{m.role === "user" ? "You" : "Code Flow"}</b><time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><div class="task-message-content"><Markdown text={m.body}/>{m.noteId ? <p class="task-delivery"><Icon name="check" />{execution?.notes.find(n => n.id === m.noteId)?.status === "delivered" ? "Delivered to an assignment · see its result for completion." : "Recorded · waiting for the next assignment."}</p> : null}</div></article>;
}
export function TaskActivity({ execution, compact = false }: { execution: NonNullable<TaskSnapshot["execution"]>; compact?: boolean }) {
    const items = execution.activity.filter(a => !["parallel", "loop", "join"].includes(a.type)).slice(compact ? -3 : -30);
    return <ol class={`task-milestones ${compact ? "compact" : ""}`}>{items.map(a => <li class={a.status} key={a.path}><span aria-hidden="true">{a.status === "completed" ? "✓" : a.status === "working" ? "●" : "!"}</span><div>{compact ? <span class="task-activity-title" title={a.title}>{a.title}</span> : <details><summary>{a.title.length > 90 ? `${a.title.slice(0, 90)}…` : a.title}</summary><p>{a.title}</p></details>}<small>{a.participant ? `${a.participant} · ` : ""}{a.status.replaceAll("_", " ")}{a.path.split("/").find(v => /^\d+$/.test(v)) ? ` · pass ${a.path.split("/").find(v => /^\d+$/.test(v))}` : ""}</small></div></li>)}</ol>;
}
export function SourcePicker({ value, untracked, info, onChange, retained = false }: {
    retained?: boolean;
    value: Draft["source"];
    untracked: string[];
    info?: {
        changed: string[];
        untracked: string[];
    };
    onChange: (source: Draft["source"], files: string[]) => void;
}) {
    if (retained)
        value = "working_changes";
    return <details class="task-source"><summary>Source: {retained ? `retained work · ${info?.changed.length ?? 0} changed files` : value === "head" ? "committed code" : `working copy · ${info?.changed.length ?? 0} edited files`}</summary><label>Starting code<select class="field" disabled={retained} value={value} onChange={e => onChange(e.currentTarget.value as Draft["source"], untracked)}><option value="working_changes">Current working copy</option><option value="head">Committed code only</option></select></label>{value === "working_changes" ? <><p class="help">{retained ? "Continuations retain this execution’s code. Open a new task to choose a different starting point. " : "Tracked edits are included. "}New files enter the snapshot only when selected. Your files and staging index are preserved.</p>{info?.untracked.map(path => <label class="task-file"><input type="checkbox" checked={untracked.includes(path)} onChange={e => onChange(value, e.currentTarget.checked ? [...untracked, path] : untracked.filter(p => p !== path))}/>{path}</label>)}</> : null}</details>;
}
export function ParticipantPicker({ value, catalogUrl, onChange }: {
    value: Participant;
    catalogUrl: string;
    onChange: (p: Participant) => void;
}) {
    const [catalog, setCatalog] = useState<ModelCatalog>(), [error, setError] = useState("");
    useEffect(() => { const controller = new AbortController(); setCatalog(undefined); setError(""); if (!catalogUrl)
        return; void api<ModelCatalog>(`${catalogUrl}&provider=${value.provider}`, { signal: controller.signal }).then(setCatalog).catch(e => { if (!controller.signal.aborted)
        setError(e.message); }); return () => controller.abort(); }, [catalogUrl, value.provider]);
    const model = catalog?.models.find(m => m.id === (value.model ?? catalog.defaultModel)), efforts = model?.efforts ?? catalog?.efforts ?? [];
    return <div class="task-model-fields"><label>Provider<select aria-label="Provider" class="field" value={value.provider} onChange={e => onChange({ id: value.id, provider: e.currentTarget.value as Participant["provider"], binding: "managed" })}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>Model<select aria-label="Model" class="field" value={value.model ?? ""} onChange={e => onChange({ ...value, model: e.currentTarget.value || undefined, effort: undefined })}><option value="">Project / provider default</option>{value.model && !catalog?.models.some(m => m.id === value.model) ? <option value={value.model}>{value.model} · checking availability</option> : null}{catalog?.models.map(m => <option value={m.id}>{m.label}</option>)}</select></label><label>Effort<select aria-label="Effort" class="field" value={value.effort ?? ""} onChange={e => onChange({ ...value, effort: e.currentTarget.value || undefined })}><option value="">Default effort</option>{value.effort && !efforts.includes(value.effort) ? <option value={value.effort}>{value.effort} · requires validation</option> : null}{efforts.map(e => <option value={e}>{e}</option>)}</select></label>{error ? <p class="help" role="status">{error}</p> : null}</div>;
}
export function Sequence({ steps }: {
    steps: Node[];
}) { return <ol class="task-sequence">{steps.map(n => <li key={n.id}>{n.type === "task" ? <>{n.participant ? <><b>{n.participant}</b>{": "}</> : ""}{n.instructions}</> : n.type === "loop" ? <>Up to {n.maxIterations} complete review passes<Sequence steps={n.steps}/></> : n.type === "parallel" ? <>Independent parallel work<Sequence steps={n.tasks}/></> : n.type === "gate" ? n.policy === "verified" ? `Require a passing check on this code${n.reviews.length ? ` and ${n.reviews.length} approving review(s)` : "; no independent review was requested"}` : `Require ${n.reviews.length} review(s) to approve the same plan` : n.type === "user_decision" ? `Pause and ask you: ${n.question}${n.continueOn ? ` · only “${n.continueOn}” continues; other answers stop for revision` : ""}` : n.type === "finish" ? `Return ${n.outcome.replaceAll("_", " ")}` : "Combine prior outputs"}</li>)}</ol>; }
export function ApproachEditor({ value, onChange, catalogUrl }: {
    value: Candidate;
    onChange: (c: Candidate) => void;
    catalogUrl: string;
}) {
    const loops: {
        id: string;
        maxIterations: number;
    }[] = [];
    const find = (steps: Node[]) => steps.forEach(n => { if (n.type === "loop") {
        loops.push(n);
        find(n.steps);
    } });
    find(value.steps);
    return <div class="task-editor">{value.participants.map((p, i) => <fieldset><legend>{p.id} · independent participant</legend><ParticipantPicker value={p} catalogUrl={catalogUrl} onChange={p => onChange({ ...value, participants: value.participants.map((old, j) => i === j ? p : old) })}/></fieldset>)}<div class="task-target-grid"><label>Maximum managed calls<input class="field" type="number" min="1" max="256" value={value.limits?.maxInvocations ?? 12} onInput={e => onChange({ ...value, limits: { ...value.limits, maxInvocations: Number(e.currentTarget.value) } })}/></label><label>Execution minutes<input class="field" type="number" min="1" max="720" value={value.limits?.maxMinutes ?? 30} onInput={e => onChange({ ...value, limits: { ...value.limits, maxMinutes: Number(e.currentTarget.value) } })}/></label></div>{loops.map(loop => <label>Maximum passes · {loop.id}<input class="field" type="number" min="1" max="5" value={loop.maxIterations} onInput={e => { const next = structuredClone(value); const update = (steps: Node[]) => steps.forEach(n => { if (n.type === "loop") {
        if (n.id === loop.id)
            n.maxIterations = Number(e.currentTarget.value);
        update(n.steps);
    } }); update(next.steps); onChange(next); }}/></label>)}{value.scope === "write" ? <><label>Setup command<input class="field" value={value.setup ?? ""} onInput={e => onChange({ ...value, setup: e.currentTarget.value || undefined })}/></label><label>Required check command<textarea class="field" value={value.check ?? ""} onInput={e => onChange({ ...value, check: e.currentTarget.value || undefined })}/></label></> : null}<p class="help">These edits use validation without coordinator inference. Describe scope or work-sequence changes in the conversation.</p></div>;
}
export function TaskResult({ taskId, execution, preferredId, label = "Task result", artifactOnly = false }: {
    taskId: string;
    execution: { id: string; artifacts: { id: string; kind: string; sha256: string }[] };
    preferredId?: string;
    label?: string;
    artifactOnly?: boolean;
}) {
    const artifacts = execution.artifacts.filter(a => artifactOnly ? a.id === preferredId : ["result", "plan", "review", "verification"].includes(a.kind));
    const preferred = artifacts.find(a => a.id === preferredId) ?? artifacts.filter(a => a.kind === "result").at(-1) ?? artifacts.at(-1);
    const [selected, setSelected] = useState(""), [body, setBody] = useState<string>(), [error, setError] = useState("");
    const artifact = artifacts.find(a => a.id === selected) ?? preferred;
    useEffect(() => { if (!artifact)
        return; const controller = new AbortController(); setBody(undefined); setError(""); void (async () => { try {
        let cursor: number | undefined = 0, text = "";
        do {
            const page: {
                body: string;
                nextCursor?: number;
            } = await api(`${ROOT}/${enc(taskId)}/artifacts?runId=${enc(execution.id)}&artifactId=${enc(artifact.id)}&sha256=${enc(artifact.sha256)}&cursor=${cursor}`, { signal: controller.signal });
            text += page.body;
            cursor = page.nextCursor;
        } while (cursor !== undefined && !controller.signal.aborted);
        if (!controller.signal.aborted)
            setBody(text);
    }
    catch (e) {
        if (!controller.signal.aborted)
            setError((e as Error).message);
    } })(); return () => controller.abort(); }, [taskId, execution.id, artifact?.id, artifact?.sha256]);
    if (!artifact)
        return null;
    return <section class="task-result" aria-label={label}>{error ? <p role="alert">{error}</p> : body === undefined ? <p role="status">Loading the complete artifact…</p> : !body ? <p class="help">No output text was recorded.</p> : artifact.kind === "result" ? <StoppedResult body={body}/> : <Markdown text={body}/>} {!artifactOnly ? <details class="task-result-options"><summary><Icon name="files" />Result and evidence <span>{artifacts.length}</span></summary><label>Show artifact<select class="field" value={artifact.id} onChange={e => setSelected(e.currentTarget.value)}>{artifacts.map(a => <option key={a.id} value={a.id}>{a.kind.replaceAll("_", " ")} · {a.id.slice(-8)}</option>)}</select></label><p class="help">Agreement records reviewer verdicts on a specific version. Passing checks apply to their recorded code snapshot.</p></details> : null}</section>;
}
function HistoricalApproach({ taskId, proposalId, revision, scope }: {
    taskId: string;
    proposalId: string;
    revision: number;
    scope: string;
}) {
    const [value, setValue] = useState<{
        definition: Definition;
        source: {
            commit: string;
        };
    }>(), [error, setError] = useState("");
    return <details onToggle={e => { if (e.currentTarget.open && !value)
        void api<{
            definition: Definition;
            source: {
                commit: string;
            };
        }>(`${ROOT}/${enc(taskId)}/approach?proposalId=${enc(proposalId)}&revision=${revision}`).then(setValue).catch(e => setError(e.message)); }}><summary>Revision {revision} · {scope}</summary>{error ? <p role="alert">{error}</p> : value ? <><p>Source: {value.source.commit.slice(0, 12)} · read-only history</p>{value.definition.participants.map(p => <p>{p.id}: {p.provider} · {p.model ?? "default"} · {p.effort ?? "default"}</p>)}<Sequence steps={value.definition.steps}/><p>Check: {value.definition.check ?? "none"}</p></> : <p>Loading saved revision…</p>}</details>;
}
