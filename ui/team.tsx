import { useEffect, useState } from "preact/hooks";
import { AgentTag, Markdown } from "./bits.js";
import { api, enc, duration, fmtCost, fmtTokens, post } from "./lib.js";
import { navigate } from "./state.js";
import { dependentTaskClosure } from "../src/team-rerun-graph.js";
import { memberProgress, requirementProgress, taskBlockers, teamAwaitingAnswer, teamNeedsResume } from "./team-state.js";
import { MemoryFeedback } from "./memory.js";
import { TeamCapabilities, TeamRunMetrics } from "./team-evaluation.js";
import { useDialog } from "./app.js";
import { showToast } from "./lib.js";
import { editableTeamPlan, teamPlanPolicy, validateTeamPlanEdit, type EditableTeamTask, type PendingTeamPlanEdit } from "../src/workflow-control.js";
import { analyzeRunTiming, analyzeWorkflow } from "../src/run-analysis.js";
import type { Note, RunSummary, Step, TeamMessage, TeamState } from "./types.js";

const STATUS: Record<TeamState["status"], string> = {
  planning: "Building the team", awaiting_approval: "Plan ready for approval", running: "Working", blocked: "Unresolved work", verifying: "Verifying the result", completed: "Finished",
};
const TASK_STATUS = { pending: "Planned", running: "Working", needs_info: "Waiting for information", submitted: "Ready for verification", completed: "Complete", failed: "Needs attention" };
const COVERAGE = { unassigned: "Not assigned", in_progress: "In progress", awaiting_verification: "Awaiting verification", reviewed_unchecked: "Reviewed · no check ran", verified: "Verified" };

/** Team-owned context and progress, kept current by the run's normal snapshot stream. */
export function AutoTeam({ run, steps }: { run: RunSummary; steps?: Step[] }) {
  const [inbox, setInbox] = useState("all");
  const [editing, setEditing] = useState(false);
  const team = run.team;
  if (!team) return null;
  const name = (id: string) => id === "user" ? "You" : team.members.find((member) => member.id === id)?.name ?? id;
  const metrics = team.metrics;
  const tokensKnown = metrics.coordinatorInputTokens !== undefined && metrics.coordinatorOutputTokens !== undefined;
  return (
    <section class="auto-team" aria-label="Auto team">
      <div class="at-head">
        <div><h3>Team and workflow</h3><span class="help">Revision {team.revision} · {team.scheduler === "event" ? "Ready work starts when dependencies resolve" : team.wave ? `${team.wave} waves so far · limit ${team.maxWaves} per execution` : "Before the first wave"}</span></div>
        <span class={`badge ${team.gaps.length || team.status === "blocked" ? "warn" : team.status === "completed" ? "ok" : ""}`}>{teamAwaitingAnswer(run) ? "Waiting for your answer" : STATUS[team.status]}</span>
      </div>
      <TeamRunMetrics runId={run.id} running={run.status === "running"} />
      <TeamCapabilities providers={[...new Set(team.members.map((member) => member.provider))]} />
      <div class="at-metrics" aria-label="Coordination usage">
        <span><b>{metrics.coordinatorInvocations}</b> coordinator calls (lifetime) · limit {team.coordinationLimit} per execution</span>
        <span><b>{metrics.invocations}</b> total calls (lifetime) · limit {team.invocationLimit} per execution</span>
        <span><b>{metrics.questionCount}</b> questions</span>
        {tokensKnown ? <span><b>{fmtTokens(metrics.coordinatorInputTokens! + metrics.coordinatorOutputTokens!)}</b> coordinator tokens</span> : <span>Coordinator tokens not reported</span>}
        {metrics.coordinatorMs !== undefined ? <span><b>{duration(metrics.coordinatorMs)}</b> coordinating</span> : null}
        {metrics.coordinatorCostUsd !== undefined ? <span title="Provider-reported API equivalent, not your subscription charge"><b>{fmtCost(metrics.coordinatorCostUsd)}</b> API equivalent</span> : null}
      </div>
      {team.rationale ? <p class="at-rationale">{team.rationale}</p> : null}
      {run.status === "running" && run.awaiting?.kind === "plan" && team.status === "awaiting_approval" && !run.teamRerun ? <div class="at-row"><button class="btn" disabled={!team.inventory} title={team.inventory ? "Edit tasks and contracts while keeping the selected members, requirements and permissions" : "Provider inventory is unavailable for this older plan"} onClick={() => setEditing(true)}>Edit pending plan</button><span class="help">Saving changes keeps the plan pending for your approval.</span></div> : null}
      {run.teamRerun ? <p class="at-notice">Selective rerun of {run.teamRerun.parentRunId} from <code>{run.teamRerun.baseCommit.slice(0, 12)}</code>. Executes {run.teamRerun.rerunTaskIds.join(", ")}; retained tasks are baseline inputs. All requirements need fresh final checks and independent review.</p> : null}
      {run.status !== "running" && run.worktrees.some((tree) => tree.name === "integration") && !["planning", "awaiting_approval"].includes(team.status) ? <TaskRerunPanel key={run.id} run={run} /> : null}
      <WorkflowGraph run={run} steps={steps} />
      {team.reviewFallback ? <div class="at-notice">{team.reviewFallback}</div> : null}
      {team.gaps.length ? <div class="at-notice"><b>Still unresolved</b><ul>{team.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div> : null}
      {teamNeedsResume(run) ? <p class="help">Resume continues this team's unfinished work with a fresh execution budget. Completed work and recorded answers are kept.</p> : null}
      <div class="at-roster" aria-label="Team members">
        {team.members.map((member) => (
          <article class="at-member" key={member.id}>
            <div class="at-row"><b>{member.name}</b><span class="badge">{member.role.charAt(0).toUpperCase() + member.role.slice(1)}</span></div>
            <AgentTag id={member.provider} note={[member.model, member.effort].filter(Boolean).join(" · ") || "CLI defaults"} />
            <div class="help">{memberProgress(team, member)} · <code>{member.id}</code></div>
            <button class="btn small" onClick={() => setInbox(member.id)}>Inbox · {team.messages.filter((message) => message.recipient === member.id && message.delivery?.status !== "context" && message.status !== "delivered").length} pending</button>
            <p>{member.reason}</p>
            {member.checkpoint ? <details><summary>Private checkpoint</summary><Markdown text={member.checkpoint} /></details> : null}
          </article>
        ))}
      </div>
      {team.tasks.length ? <div class="at-section"><h4>Workflow</h4><ol class="at-tasks">
        {team.tasks.map((task) => {
          const blockers = !task.status || task.status === "pending" || task.status === "needs_info" || task.status === "failed" ? taskBlockers(team, task) : [];
          return <li key={task.id} class="at-task" id={`team-task-${task.id}`}>
            <div class="at-row"><b>{task.title}</b><span class={`badge ${task.status === "completed" ? "ok" : task.status === "failed" ? "warn" : ""}`}>{TASK_STATUS[task.status ?? "pending"]}</span></div>
            <div class="help">{name(task.owner)} · {task.kind} · {task.attempts ?? 0} attempts</div>
            {task.retainedBaseline ? <p class="help">Retained baseline input from {task.retainedBaseline.sourceRunId} · <code>{task.retainedBaseline.sourceTaskHead.slice(0, 12)}</code>. This task was not executed again.</p> : null}
            {task.noNewDiff ? <p class="help">No new diff from this rerun turn. Acceptance requires a current-head check and independent review.</p> : null}
            {task.dependsOn.length ? <div class="help">Needs {task.dependsOn.map((id) => `${team.tasks.find((item) => item.id === id)?.title ?? id} (${task.dependencyTypes?.[id] ?? "completion"})`).join(", ")}</div> : null}
            {task.evidenceStale ? <p class="at-notice">The contract changed. This task's evidence needs verification again.</p> : null}
            {blockers.length ? <ul class="at-blockers">{blockers.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}
            <details><summary>Assignment and acceptance</summary><Markdown text={task.instructions} /><ul>{task.acceptance.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>{task.paths.length ? <div class="help">Paths: {task.paths.join(", ")}</div> : null}{task.checkpoint ? <Markdown text={task.checkpoint} /> : null}</details>
          </li>;
        })}
      </ol></div> : null}
      {team.waits?.some((wait) => wait.status !== "resolved") ? <div class="at-section"><h4>Waiting and escalation</h4><ul>{team.waits.filter((wait) => wait.status !== "resolved").map((wait) => <li key={wait.requestId}><b>{name(wait.memberId)}</b> · {wait.taskId} · {wait.status}{wait.status === "waiting" ? ` · deadline ${new Date(wait.deadlineAt).toLocaleTimeString()}` : ""}{wait.reason ? ` · ${wait.reason}` : ""}</li>)}</ul><p class="help">Waiting members release their agent slots. Expired requests and unavailable recipients are escalated to the coordinator.</p></div> : null}
      {team.requirements.length ? <div class="at-section"><h4>Requirement coverage</h4><ul class="at-coverage">
        {team.requirements.map((requirement) => {
          const progress = requirementProgress(team, requirement.id, run.status);
          const retained = team.tasks.filter((task) => task.requirements.includes(requirement.id) && task.retainedBaseline).length;
          return <li key={requirement.id}><span>{requirement.description}{retained ? <small class="help"> · {retained} retained baseline task(s)</small> : null}</span><span class={`badge ${progress === "verified" ? "ok" : progress === "unassigned" ? "warn" : ""}`}>{COVERAGE[progress]}</span></li>;
        })}
      </ul>{team.verification ? <p class="help">Checks: {team.verification.check.replaceAll("_", " ")} · Review: {team.verification.reviewed ? team.verification.approved ? "approved" : "changes requested" : "pending"} · Commit <code>{team.verification.head.slice(0, 12)}</code></p> : null}</div> : null}
      {team.messages.length ? <div class="at-section"><div class="at-row"><h4>Team messages</h4><label>Inbox <select class="field" aria-label="Member inbox" value={inbox} onChange={(event) => setInbox(event.currentTarget.value)}><option value="all">All members</option><option value="user">Questions for you</option>{team.members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label></div><div class="at-messages">
        {team.messages.filter((message) => inbox === "all" || message.recipient === inbox).map((message) => <article key={message.id} class={`at-message ${message.status}`}>
          <div class="at-row"><b>{name(message.sender)} → {name(message.recipient)}</b><span class="badge">{message.kind === "question" ? message.status === "open" ? "Open question" : "Answered" : message.kind[0]!.toUpperCase() + message.kind.slice(1)}</span></div>
          <Markdown text={message.body} />
          <div class="help">{message.origin === "user" ? "From you" : "From a team member"}{message.blocking ? message.status === "open" ? " · blocks dependent work" : " · blocker resolved" : ""}</div>
          <div class="help">{message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : ""}{message.delivery ? ` · ${message.delivery.status === "steered" ? "delivered during a turn" : message.delivery.status === "steering" ? "sent during a turn, acknowledgement pending" : message.delivery.status === "context" ? "included in member context" : "queued for the next turn"}` : ""}{message.originalRecipient ? ` · routed from ${name(message.originalRecipient)}` : ""}{message.deadlineAt && message.status === "open" ? ` · answer due ${new Date(message.deadlineAt).toLocaleTimeString()}` : ""}</div>
          {message.evidence.length ? <details><summary>Evidence</summary><ul>{message.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul></details> : null}
          {message.kind === "question" && message.recipient === "user" && message.status === "open" ? (teamAwaitingAnswer(run) && team.awaitingRequestId === message.id ? <p class="help">Answer it in the card under the run header.</p> : <QuestionReply run={run} message={message} />) : null}
        </article>)}
      </div></div> : null}
      {team.strategyInstances?.length ? <details class="at-section"><summary>Reusable workflow steps</summary><ul>{team.strategyInstances.map((strategy) => <li key={strategy.id}>{strategy.strategy} · revision {strategy.revision} · {strategy.taskIds.map((id) => team.tasks.find((task) => task.id === id)?.title ?? id).join(" → ")}</li>)}</ul></details> : null}
      {team.contracts.length ? <details class="at-section"><summary>Shared contracts</summary>{team.contracts.map((contract, i) => <Markdown key={i} text={contract} />)}</details> : null}
      {team.contextManifests.length ? <details class="at-section"><summary>Context used by each member</summary><p class="help">Each turn receives its assignment, relevant shared information, and its own checkpoint.</p><ul class="at-context">
        {team.contextManifests.map((context, i) => <li key={`${context.memberId}-${context.taskId}-${context.attempt}-${i}`}><b>{name(context.memberId)}</b> · {context.taskId} · attempt {context.attempt}<div class="help">Plan {context.revision} · commit <code>{context.inputHead.slice(0, 12)}</code> · {context.checkpoint ? "private checkpoint included" : "no private checkpoint"}</div><div class="help">Messages: {context.messageIds.join(", ") || "none"} · Memory: {context.memoryIds.join(", ") || "none"}</div></li>)}
      </ul></details> : null}
      {run.memoryManifest ? <details class="at-section"><summary>Why project memory was selected</summary><ul class="at-context">
        {run.memoryManifest.included.map((item) => <li key={`included-${item.id}`}><b>Included</b> · {item.id} · revision {item.revision}<div class="help">{item.reason}</div>{run.project ? <MemoryFeedback projectId={run.project} id={item.id} revision={item.revision} runId={run.id} /> : null}</li>)}
        {run.memoryManifest.omitted.map((item) => <li key={`omitted-${item.id}`}><b>Omitted</b> · {item.id} · revision {item.revision}<div class="help">{item.reason}</div></li>)}
      </ul>{!run.memoryManifest.included.length && !run.memoryManifest.omitted.length ? <p class="help">No applicable project knowledge was available for this run.</p> : null}</details> : null}
      {team.inventory?.providers.some((provider) => provider.blockedReason) ? <details class="at-section"><summary>Provider availability</summary><ul>{team.inventory.providers.filter((provider) => provider.blockedReason).map((provider) => <li key={provider.id}><AgentTag id={provider.id} />: {provider.blockedReason}</li>)}</ul></details> : null}
      {editing ? <TeamPlanEditor run={run} onClose={() => setEditing(false)} /> : null}
    </section>
  );
}

function TaskRerunPanel({ run }: { run: RunSummary }) {
  const team = run.team!;
  const [open, setOpen] = useState(false);
  const [head, setHead] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [calls, setCalls] = useState(Math.max(8, run.loop.maxSteps));
  const [minutes, setMinutes] = useState(run.loop.maxMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const branch = run.worktrees.find((tree) => tree.name === "integration")!.branch;
  useEffect(() => {
    if (!open) return;
    let current = true; setHead(""); setError("");
    api<{ head: string }>(`/api/runs/${enc(run.id)}/review-coverage?branch=${enc(branch)}`).then((value) => { if (current) setHead(value.head); }, (problem) => { if (current) setError((problem as Error).message); });
    return () => { current = false; };
  }, [open, run.id, branch, refresh]);
  const invalidated = dependentTaskClosure(team.tasks, selected);
  const retained = team.tasks.filter((task) => !invalidated.has(task.id));
  const unfinished = retained.filter((task) => !["completed", "submitted"].includes(task.status ?? "") || task.evidenceStale || !task.head);
  const minimum = Math.max(4, invalidated.size + 2);
  const start = async () => {
    setBusy(true); setError("");
    try {
      const replacements = Object.fromEntries(selected.filter((id) => instructions[id]?.trim()).map((id) => [id, instructions[id]!.trim()]));
      const child = await post<{ id: string }>(`/api/runs/${enc(run.id)}/rerun-tasks`, { expectedHead: head, taskIds: selected, instructions: replacements, budget: { maxSteps: calls, maxInvocations: calls, maxMinutes: minutes } });
      navigate({ view: "run", id: child.id });
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  };
  return <details class="at-section team-rerun" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Rerun selected tasks</summary>
    <p class="help">Creates a child at the committed integration result. Selected tasks and every downstream dependency execute again; other completed tasks become explicit baseline inputs. The original run and its worker checkouts stay available. The child requires fresh checks and independent review of all requirements.</p>
    <p class="help">Baseline: {head ? <code>{head.slice(0, 12)}</code> : "Loading current integration commit…"} <button class="btn ghost small" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Refresh rerun baseline</button></p>
    {head && (team.verification?.head !== head || !team.verification?.approved) ? <p class="at-notice">This baseline has no passing parent verification at its current commit. The child starts unverified.</p> : null}
    <fieldset disabled={busy}><legend>Tasks to execute again</legend>{team.tasks.map((task) => <div key={task.id}><label class="check"><input type="checkbox" checked={selected.includes(task.id)} onChange={(event) => setSelected(event.currentTarget.checked ? [...selected, task.id] : selected.filter((id) => id !== task.id))} />Rerun {task.title}</label>{selected.includes(task.id) ? <label>New instructions for {task.id}<textarea class="field" rows={2} maxLength={16000} placeholder="Leave blank to reuse the accepted instructions" value={instructions[task.id] ?? ""} onInput={(event) => setInstructions({ ...instructions, [task.id]: event.currentTarget.value })} /></label> : null}</div>)}</fieldset>
    <div aria-label="Task rerun preview"><p>Execute: {team.tasks.filter((task) => invalidated.has(task.id)).map((task) => task.id).join(", ") || "Choose a task"}</p><p>Retain as baseline inputs: {retained.map((task) => task.id).join(", ") || "None"}</p></div>
    {unfinished.length ? <p class="at-notice">Also select unfinished or stale tasks: {unfinished.map((task) => task.id).join(", ")}.</p> : null}
    <div class="at-row"><label>New invocation budget<input class="field" type="number" min={minimum} max="200" value={calls} disabled={busy} onInput={(event) => setCalls(Number(event.currentTarget.value))} /></label><label>Rerun time budget (minutes)<input class="field" type="number" min="1" max="720" value={minutes} disabled={busy} onInput={(event) => setMinutes(Number(event.currentTarget.value))} /></label></div>
    <p class="help">At least {minimum} calls fund invalidated work, independent review and one recovery allowance. Provider/model/permission settings stay pinned. An unchanged implementation must still pass the current check and independent review; it does not create new fail-to-pass proof.</p>
    <button class="btn primary" disabled={busy || !head || !selected.length || !!unfinished.length || !Number.isInteger(calls) || calls < minimum || calls > 200 || !Number.isFinite(minutes) || minutes < 1 || minutes > 720} onClick={start}>{busy ? "Starting child…" : "Start selected task rerun"}</button>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </details>;
}

function WorkflowGraph({ run, steps }: { run: RunSummary; steps?: Step[] }) {
  const team = run.team!;
  const graph = analyzeWorkflow(team, { steps });
  if (!graph.nodes.length) return null;
  const positions = new Map(graph.nodes.map((node) => [node.id, { x: 20 + node.layer * 240, y: 20 + (graph.layers[node.layer]?.indexOf(node.id) ?? 0) * 92 }]));
  const width = Math.max(240, graph.layers.length * 240);
  const height = Math.max(100, ...graph.layers.map((layer) => layer.length * 92 + 20));
  const timing = steps ? analyzeRunTiming(run, steps) : null;
  return <details class="at-section workflow-graph"><summary>Workflow graph and timing · {graph.nodes.length} tasks</summary>
    <p class="help">Arrows show dependencies. Highlighted tasks form the longest measured dependency chain. Untimed work, provider limits, shared files and queue delays can change the actual bottleneck.</p>
    <div class="workflow-dag-scroll"><svg role="img" aria-label={`Workflow dependencies: ${graph.edges.map((edge) => `${edge.from} to ${edge.to}`).join(", ") || "independent tasks"}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
      <defs><marker id={`dag-arrow-${run.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
      {graph.edges.map((edge) => { const from = positions.get(edge.from)!; const to = positions.get(edge.to)!; const x1 = from.x + 204; const x2 = to.x; const y1 = from.y + 31; const y2 = to.y + 31; return <path key={`${edge.from}-${edge.to}`} class={`dag-edge ${edge.kind}`} d={`M ${x1} ${y1} C ${x1 + 22} ${y1}, ${x2 - 22} ${y2}, ${x2} ${y2}`} marker-end={`url(#dag-arrow-${run.id})`}><title>{edge.from} → {edge.to} · {edge.kind}</title></path>; })}
      {graph.nodes.map((node) => { const position = positions.get(node.id)!; return <g key={node.id} class={`dag-node ${node.status} ${node.critical ? "critical" : ""}`} transform={`translate(${position.x} ${position.y})`}><title>{node.title} · {node.owner} · {node.status}{node.durationMs !== undefined ? ` · ${duration(node.durationMs)} measured` : " · no task timing"}</title><rect width="204" height="64" rx="10" /><text x="10" y="23" class="dag-title">{node.title.length > 25 ? `${node.title.slice(0, 24)}…` : node.title}</text><text x="10" y="43">{node.owner.slice(0, 20)} · {node.durationMs === undefined ? "untimed" : duration(node.durationMs)}</text><text x="10" y="58" class="dag-status">{TASK_STATUS[node.status as keyof typeof TASK_STATUS] ?? node.status}</text></g>; })}
    </svg></div>
    <p class="help">Observed chain: {graph.criticalPath.map((id) => team.tasks.find((task) => task.id === id)?.title ?? id).join(" → ") || "unavailable"}{graph.timedTasks ? ` · ${duration(graph.measuredCriticalPathMs)}` : " · timing unavailable"}. {graph.timedTasks}/{graph.nodes.length} tasks have timing.{!graph.completeTiming ? " This is partial timing, not a completion estimate." : ""}</p>
    {timing ? <dl class="workflow-timing"><div><dt>Since run creation</dt><dd>{duration(timing.elapsedMs)}</dd></div><div><dt>Worker process time</dt><dd>{duration(timing.workerMs)}</dd></div><div><dt>Coordination process time</dt><dd>{duration(timing.coordinationMs)}</dd></div><div><dt>Check and setup time</dt><dd>{duration(timing.checksMs)}</dd></div><div><dt>Recorded wait periods</dt><dd>{duration(timing.waitingMs)}</dd></div><div><dt>Other elapsed time</dt><dd>{duration(timing.unattributedMs)}</dd></div></dl> : null}
    {timing ? <p class="help">Process time sums recorded steps and can overlap. Other elapsed time includes queues, approvals and time between executions. {timing.untimedSteps ? `${timing.untimedSteps} steps have incomplete timing.` : ""}</p> : null}
    {graph.warnings.length ? <ul class="at-notice">{graph.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
  </details>;
}

function cleanDraft(draft: PendingTeamPlanEdit): PendingTeamPlanEdit {
  const lines = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
  return { ...draft, contracts: lines(draft.contracts), tasks: draft.tasks.map((task) => ({ ...task, paths: lines(task.paths), acceptance: lines(task.acceptance), dependsOn: lines(task.dependsOn), requirements: lines(task.requirements) })) };
}
export function TeamPlanEditor({ run, onClose }: { run: RunSummary; onClose: () => void }) {
  const team = run.team!;
  const ref = useDialog(true, onClose);
  const [draft, setDraft] = useState(() => editableTeamPlan(team));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  let problem = "";
  let maxTasks = 24;
  try { const policy = teamPlanPolicy(team, run); maxTasks = policy.maxTasks; validateTeamPlanEdit(cleanDraft(draft), team, policy); }
  catch (err) { problem = (err as Error).message; }
  const changed = team.revision !== draft.revision;
  const updateTask = (id: string, patch: Partial<EditableTeamTask>) => setDraft({ ...draft, tasks: draft.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) });
  const save = async () => {
    if (problem || busy) return;
    setBusy(true); setError("");
    try { await post<{ team: TeamState }>(`/api/runs/${encodeURIComponent(run.id)}/team-plan`, cleanDraft(draft)); showToast("Plan changes saved. Review them before approving.", 4000); onClose(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const exportDraft = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(cleanDraft(draft), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `team-plan-${run.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <dialog class="picker team-plan-editor" ref={ref} aria-labelledby="team-plan-editor-title"><div class="picker-inner">
    <div class="picker-head"><h3 id="team-plan-editor-title">Edit pending team plan</h3><p class="help">Members, requirements, model settings, permissions and execution limits stay fixed. Edit assignments, dependencies, paths, acceptance and contracts before dispatch.</p></div>
    <div class="dialog-body">
      {changed ? <div class="at-notice" role="alert">The saved plan changed. Your draft is kept. Export or copy your changes before replacing it with the current plan.<button class="btn" onClick={() => { setDraft(editableTeamPlan(team)); setError(""); }}>Replace draft with latest plan</button><details><summary>Latest plan for comparison</summary><pre class="template-preview">{JSON.stringify(editableTeamPlan(team), null, 2)}</pre></details></div> : null}
      <label class="lbl" for="team-plan-rationale">Rationale</label><textarea class="field" id="team-plan-rationale" rows={3} maxLength={4000} value={draft.rationale} onInput={(event) => setDraft({ ...draft, rationale: event.currentTarget.value })} />
      <div class="at-row"><h4>Tasks · {draft.tasks.length}/{maxTasks}</h4><button class="btn small" disabled={draft.tasks.length >= maxTasks} onClick={() => setDraft({ ...draft, tasks: [...draft.tasks, { id: `task-${crypto.randomUUID().slice(0, 8)}`, title: "New task", instructions: "", kind: "implementation", owner: team.members.find((member) => member.role === "worker" && member.status !== "retired")?.id ?? "", dependsOn: [], requirements: team.requirements[0] ? [team.requirements[0].id] : [], acceptance: [""], paths: [""] }] })}>Add task</button></div>
      {draft.tasks.map((task) => <details class="plan-task-editor" key={task.id} open><summary>{task.title || "Untitled task"} · <code>{task.id}</code></summary><div class="plan-task-body">
        <label>Title<input class="field" aria-label={`Title for ${task.id}`} maxLength={180} value={task.title} onInput={(event) => updateTask(task.id, { title: event.currentTarget.value })} /></label>
        <div class="settings-grid"><label>Kind<select class="field" aria-label={`Kind for ${task.id}`} value={task.kind} onChange={(event) => { const kind = event.currentTarget.value as EditableTeamTask["kind"]; const owner = team.members.find((member) => member.id === task.owner); updateTask(task.id, { kind, ...(kind === "implementation" && owner?.role !== "worker" ? { owner: team.members.find((member) => member.role === "worker" && member.status !== "retired")?.id ?? "" } : {}) }); }}><option value="implementation">Implementation</option><option value="investigation">Investigation</option></select></label>
          <label>Owner<select class="field" aria-label={`Owner for ${task.id}`} value={task.owner} onChange={(event) => updateTask(task.id, { owner: event.currentTarget.value })}>{team.members.filter((member) => member.status !== "retired" && member.role !== "reviewer" && (task.kind === "investigation" || member.role === "worker")).map((member) => <option key={member.id} value={member.id}>{member.name} · {member.provider}</option>)}</select></label></div>
        <label>Instructions<textarea class="field" aria-label={`Instructions for ${task.id}`} rows={3} maxLength={16000} value={task.instructions} onInput={(event) => updateTask(task.id, { instructions: event.currentTarget.value })} /></label>
        <label>Owned paths · one per line<textarea class="field mono" aria-label={`Paths for ${task.id}`} rows={2} value={task.paths.join("\n")} onInput={(event) => updateTask(task.id, { paths: event.currentTarget.value.split("\n") })} /></label>
        <label>Acceptance criteria · one per line<textarea class="field" aria-label={`Acceptance for ${task.id}`} rows={3} value={task.acceptance.join("\n")} onInput={(event) => updateTask(task.id, { acceptance: event.currentTarget.value.split("\n") })} /></label>
        <fieldset><legend>Requirements covered</legend>{team.requirements.map((requirement) => <label class="check" key={requirement.id}><input type="checkbox" checked={task.requirements.includes(requirement.id)} onChange={(event) => updateTask(task.id, { requirements: event.currentTarget.checked ? [...task.requirements, requirement.id] : task.requirements.filter((id) => id !== requirement.id) })} />{requirement.description} <code>{requirement.id}</code></label>)}</fieldset>
        <fieldset><legend>Dependencies</legend>{draft.tasks.filter((other) => other.id !== task.id).map((other) => <div class="dependency-edit" key={other.id}><label class="check"><input type="checkbox" checked={task.dependsOn.includes(other.id)} onChange={(event) => { const dependencyTypes = { ...task.dependencyTypes }; if (!event.currentTarget.checked) delete dependencyTypes[other.id]; updateTask(task.id, { dependsOn: event.currentTarget.checked ? [...task.dependsOn, other.id] : task.dependsOn.filter((id) => id !== other.id), dependencyTypes }); }} />{other.title}</label>{task.dependsOn.includes(other.id) ? <select class="field" aria-label={`Dependency ${other.id} for ${task.id}`} value={task.dependencyTypes?.[other.id] ?? "completion"} onChange={(event) => updateTask(task.id, { dependencyTypes: { ...task.dependencyTypes, [other.id]: event.currentTarget.value as "completion" | "artifact" | "knowledge" } })}><option value="completion">Completion</option><option value="artifact">Integrated artifact</option><option value="knowledge">Evidence-backed knowledge</option></select> : null}</div>)}</fieldset>
        <button class="btn small danger" disabled={draft.tasks.length <= 1} onClick={() => setDraft({ ...draft, tasks: draft.tasks.filter((other) => other.id !== task.id).map((other) => { const dependencyTypes = { ...other.dependencyTypes }; delete dependencyTypes[task.id]; return { ...other, dependsOn: other.dependsOn.filter((id) => id !== task.id), dependencyTypes }; }) })}>Remove task</button>
      </div></details>)}
      <div class="at-row"><h4>Shared contracts</h4><button class="btn small" disabled={draft.contracts.length >= 24} onClick={() => setDraft({ ...draft, contracts: [...draft.contracts, ""] })}>Add contract</button></div>
      {draft.contracts.map((contract, index) => <div class="plan-contract-editor" key={index}><textarea class="field" aria-label={`Shared contract ${index + 1}`} rows={3} maxLength={8000} value={contract} onInput={(event) => setDraft({ ...draft, contracts: draft.contracts.map((value, at) => at === index ? event.currentTarget.value : value) })} /><button class="btn small" onClick={() => setDraft({ ...draft, contracts: draft.contracts.filter((_, at) => at !== index) })}>Remove contract {index + 1}</button></div>)}
      {problem ? <p class="msg warn" role="status">{problem}</p> : <p class="help" role="status">Plan is valid. Saving changes keeps approval pending.</p>}{error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="ps">Based on revision {draft.revision}</span><button class="btn" onClick={exportDraft}>Export draft</button><button class="btn" disabled={busy} onClick={onClose}>Cancel</button><button class="btn primary" disabled={!!problem || busy} onClick={save}>{busy ? "Saving…" : "Save plan changes"}</button></div>
  </div></dialog>;
}

/** The one thing a waiting team needs from you, shown under the run header like a plan approval, not at the end of the message list. */
export function TeamQuestionCard({ run }: { run: RunSummary }) {
  const team = run.team;
  const message = team?.messages.find((item) => item.id === team.awaitingRequestId);
  if (!team || !message) return null;
  const sender = team.members.find((member) => member.id === message.sender);
  const task = team.tasks.find((item) => item.id === message.taskId);
  // Laid out like a plan approval (an attention card with a warn strip), since it's the same kind of ask.
  return <section class="awaiting-card team-question" aria-label="The team needs your answer">
    <div class="aw-head"><span class="status-pill awaiting">Waiting for you</span><b>The team needs your answer</b><span class="help">{sender?.name ?? message.sender}{task ? ` · ${task.title}` : ""}</span></div>
    <div class="aw-body"><Markdown text={message.body} /></div>
    <div class="aw-actions"><QuestionReply run={run} message={message} /></div>
  </section>;
}

export function QuestionReply({ run, message }: { run: RunSummary; message: TeamMessage }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const answer = async () => {
    if (!text.trim() || busy || sent) return;
    setBusy(true);
    setError("");
    try { await post<Note>(`/api/runs/${run.id}/notes`, { requestId: message.id, text }); setSent(true); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  if (sent) return <p class="help" role="status">Answer sent.</p>;
  if (run.status !== "running") return <p class="help">Press Resume in the header to continue the run, then answer here.</p>;
  const field = `team-answer-${message.id}`;
  return <div class="at-reply"><label class="lbl" for={field}>Your answer</label><textarea class="field" id={field} placeholder="Your answer…" rows={2} value={text} onInput={(event) => setText(event.currentTarget.value)} /><button class="btn primary small" disabled={!text.trim() || busy} onClick={answer}>{busy ? "Sending…" : "Send answer"}</button>{error ? <p class="msg err" role="alert">{error}</p> : null}</div>;
}
