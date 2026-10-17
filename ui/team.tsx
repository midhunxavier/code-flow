import { useState } from "preact/hooks";
import { AgentTag, Markdown } from "./bits.js";
import { duration, fmtCost, fmtTokens, post } from "./lib.js";
import { memberProgress, requirementProgress, taskBlockers, teamNeedsResume } from "./team-state.js";
import { MemoryFeedback } from "./memory.js";
import { TeamCapabilities, TeamRunMetrics } from "./team-evaluation.js";
import type { Note, RunSummary, TeamMessage, TeamState } from "./types.js";

const STATUS: Record<TeamState["status"], string> = {
  planning: "Building the team", awaiting_approval: "Plan ready for approval", running: "Working", blocked: "Unresolved work", verifying: "Verifying the result", completed: "Finished",
};
const TASK_STATUS = { pending: "Planned", running: "Working", needs_info: "Waiting for information", submitted: "Ready for verification", completed: "Complete", failed: "Needs attention" };
const COVERAGE = { unassigned: "Not assigned", in_progress: "In progress", awaiting_verification: "Awaiting verification", verified: "Verified" };

/** Team-owned context and progress, kept current by the run's normal snapshot stream. */
export function AutoTeam({ run }: { run: RunSummary }) {
  const [inbox, setInbox] = useState("all");
  const team = run.team;
  if (!team) return null;
  const name = (id: string) => id === "user" ? "You" : team.members.find((member) => member.id === id)?.name ?? id;
  const metrics = team.metrics;
  const tokensKnown = metrics.coordinatorInputTokens !== undefined && metrics.coordinatorOutputTokens !== undefined;
  return (
    <section class="auto-team" aria-label="Auto team">
      <div class="at-head">
        <div><h3>Team and workflow</h3><span class="help">Revision {team.revision} · {team.scheduler === "event" ? "Ready work starts when dependencies resolve" : team.wave ? `${team.wave} waves so far · limit ${team.maxWaves} per execution` : "Before the first wave"}</span></div>
        <span class={`badge ${team.gaps.length || team.status === "blocked" ? "warn" : ""}`}>{team.awaitingRequestId ? "Waiting for your answer" : STATUS[team.status]}</span>
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
      {team.reviewFallback ? <div class="at-notice">{team.reviewFallback}</div> : null}
      {team.gaps.length ? <div class="at-notice"><b>Still unresolved</b><ul>{team.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div> : null}
      {teamNeedsResume(run) ? <p class="help">Resume continues this team's unfinished work with a fresh execution budget. Completed work and recorded answers are kept.</p> : null}
      <div class="at-roster" aria-label="Team members">
        {team.members.map((member) => (
          <article class="at-member" key={member.id}>
            <div class="at-row"><b>{member.name}</b><span class="badge">{member.role}</span></div>
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
          return <li key={task.id} class="at-task">
            <div class="at-row"><b>{task.title}</b><span class={`badge ${task.status === "completed" ? "ok" : task.status === "failed" ? "warn" : ""}`}>{TASK_STATUS[task.status ?? "pending"]}</span></div>
            <div class="help">{name(task.owner)} · {task.kind} · {task.attempts ?? 0} attempts</div>
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
          return <li key={requirement.id}><span>{requirement.description}</span><span class={`badge ${progress === "verified" ? "ok" : progress === "unassigned" ? "warn" : ""}`}>{COVERAGE[progress]}</span></li>;
        })}
      </ul>{team.verification ? <p class="help">Checks: {team.verification.check.replaceAll("_", " ")} · Review: {team.verification.reviewed ? team.verification.approved ? "approved" : "changes requested" : "pending"} · Commit <code>{team.verification.head.slice(0, 12)}</code></p> : null}</div> : null}
      {team.messages.length ? <div class="at-section"><div class="at-row"><h4>Team messages</h4><label>Inbox <select class="field" aria-label="Member inbox" value={inbox} onChange={(event) => setInbox(event.currentTarget.value)}><option value="all">All members</option><option value="user">Questions for you</option>{team.members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label></div><div class="at-messages">
        {team.messages.filter((message) => inbox === "all" || message.recipient === inbox).map((message) => <article key={message.id} class={`at-message ${message.status}`}>
          <div class="at-row"><b>{name(message.sender)} → {name(message.recipient)}</b><span class="badge">{message.kind === "question" ? message.status === "open" ? "Open question" : "Answered" : message.kind[0]!.toUpperCase() + message.kind.slice(1)}</span></div>
          <Markdown text={message.body} />
          <div class="help">{message.origin === "user" ? "From you" : "From a team member"}{message.blocking ? message.status === "open" ? " · blocks dependent work" : " · blocker resolved" : ""}</div>
          <div class="help">{message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : ""}{message.delivery ? ` · ${message.delivery.status === "steered" ? "delivered during a turn" : message.delivery.status === "context" ? "included in member context" : "queued for the next turn"}` : ""}{message.originalRecipient ? ` · routed from ${name(message.originalRecipient)}` : ""}{message.deadlineAt && message.status === "open" ? ` · answer due ${new Date(message.deadlineAt).toLocaleTimeString()}` : ""}</div>
          {message.evidence.length ? <details><summary>Evidence</summary><ul>{message.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul></details> : null}
          {message.kind === "question" && message.recipient === "user" && message.status === "open" ? <QuestionReply run={run} message={message} /> : null}
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
    </section>
  );
}

function QuestionReply({ run, message }: { run: RunSummary; message: TeamMessage }) {
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
  if (run.status !== "running") return <p class="help">Resume the run to answer this question.</p>;
  return <div class="at-reply"><textarea class="field" aria-label={`Answer ${message.body}`} placeholder="Your answer…" rows={2} value={text} onInput={(event) => setText(event.currentTarget.value)} /><button class="btn primary small" disabled={!text.trim() || busy} onClick={answer}>{busy ? "Sending…" : "Send answer"}</button>{error ? <p class="msg err" role="alert">{error}</p> : null}</div>;
}
