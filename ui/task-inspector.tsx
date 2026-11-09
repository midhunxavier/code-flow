import type { TaskSnapshot } from "../src/conversational/service.js";
import { Sequence, TaskActivity } from "./task-conversation.js";
import { Icon } from "./icons.js";

/** State and evidence come from the server projection, never inferred from a successful HTTP call. */
export function TaskInspector({ task, onOutput, onAdjust, onAction, onReply, onRefresh, busy }: { task: TaskSnapshot; busy: boolean; onAction: (action: string) => void; onReply: () => void; onOutput: () => void; onAdjust: () => void; onRefresh?: () => void }) {
  const { view, proposal, execution: run } = task;
  const running = run?.status === "running", minutes = (run?.usage.ms ?? 0) / 60000;
  const limits = run?.limits ?? proposal?.definition.limits;
  return <section class="task-inspector">
    <header class="task-inspector-status"><span class={`dot ${running && !run.paused ? "running" : run?.status ?? ""}`} aria-hidden="true"/><h2 role="status">{view.label}</h2><span class="task-inspector-scope">{proposal?.definition.scope === "write" ? "Code changes" : proposal?.definition.scope === "review" ? "Review" : "Plan only"}</span></header>
    {view.notice ? <p class="help">{view.notice}</p> : null}
    {limits ? <div class="task-budget" aria-label="Execution allowance">
      <div title={`${Math.max(0, limits.maxInvocations - (run?.usage.calls ?? 0))} calls remaining`}><span>Calls</span><strong>{run?.usage.calls ?? 0}<small> / {limits.maxInvocations}</small></strong><progress aria-label="Agent calls used" value={run?.usage.calls ?? 0} max={limits.maxInvocations}/></div>
      <div title={`${Math.max(0, limits.maxMinutes - minutes).toFixed(1)} minutes remaining`}><span>Time</span><strong>{minutes.toFixed(1)}<small> / {limits.maxMinutes} min</small></strong><progress aria-label="Execution minutes used" value={minutes} max={limits.maxMinutes}/></div>
    </div> : null}
    <div class="task-inspector-controls">{running ? <><button type="button" class="btn small" disabled={busy || run.pausePending} onClick={() => onAction(run.paused ? "resume" : "pause")}><Icon name={run.paused ? "play" : "pause"}/>{run.paused ? "Resume" : run.pausePending ? "Pausing…" : "Pause"}</button><button type="button" class="icon-btn" aria-label="Stop task" title="Stop task and preserve completed work" disabled={busy} onClick={() => onAction("cancel")}><Icon name="stop"/></button></> : null}<button type="button" class="btn ghost small" onClick={onReply}><Icon name="chat"/>Ask in chat</button></div>
    {run?.error ? <p class="msg err">{run.error}</p> : null}
    {view.recovery === "reconnect" ? <a class="btn small" href="#/settings/agents">Reconnect provider</a> : view.recovery === "inspect" ? <a class="btn small" href={`#/run/${encodeURIComponent(run!.id)}`}>Inspect preserved work</a> : view.recovery === "allowance" || view.recovery === "revise" ? <p class="help">Revise the approach in chat to continue with a new allowance.</p> : null}
    <div class="task-agent-heading"><h3>Agents</h3><span>{view.participants.length}</span></div>
    <div class="task-agent-list">{view.participants.map(p => {
      const active = p.assignments.some(a => a.status === "running"), failed = p.assignments.some(a => ["failed", "interrupted"].includes(a.status));
      const completed = p.assignments.some(a => a.status === "done");
      const label = !run ? "Proposed" : active ? "Working" : failed ? "Needs attention" : completed ? running ? "Ready" : "Done" : "Waiting";
      const current = [...(run?.activity ?? [])].reverse().find(a => a.participant === p.id && a.status === "working");
      return <article class={`task-agent ${active ? "active" : ""}`} key={p.id}>
        <div class="task-agent-top"><span class={`dot ${active ? "running" : failed ? "failed" : ""}`} aria-hidden="true"/><strong>{p.id}</strong><span class="task-agent-state">{label}</span></div>
        <p class="task-agent-model" title={`${p.provider} · ${p.model || "Provider default"} · ${p.effort || "Default effort"}`}>{p.model || p.provider}{p.effort ? <span>{p.effort} effort</span> : null}</p>
        {current ? <p class="task-agent-assignment" title={current.title}>{current.title}</p> : null}
      </article>;
    })}</div>
    {run ? <details class="task-inspector-section"><summary>Activity history</summary><TaskActivity execution={run}/></details> : null}
    {proposal ? <><details class="task-inspector-section"><summary>Approach and checks</summary><Sequence steps={proposal.definition.steps}/><h4>Done when</h4><ul>{proposal.definition.completion.map(item => <li key={item}>{item}</li>)}</ul><p>Source: <code>{proposal.source.commit.slice(0, 12)}</code> · {proposal.source.source}</p><p>Check: <code>{proposal.definition.check || "No command check for this scope"}</code></p><p>Setup: <code>{proposal.definition.setup || "None"}</code></p><p class="help">Standard managed tools · {proposal.definition.limits.maxAttempts} attempts per step. Publishing is a separate action.</p></details><div class="task-actions"><button class="btn small" onClick={onOutput}>{run ? `${view.resultLabel} in chat` : "Show approach in chat"}</button>{!running || run.paused ? <button class="btn ghost small" onClick={onAdjust}>Adjust approach</button> : null}{!proposal.runId && onRefresh ? <button class="btn ghost small" disabled={busy} onClick={onRefresh}>Refresh source</button> : null}</div></> : null}
    <details class="task-inspector-section"><summary>Advanced · execution history and receipts</summary><p>{task.task.request}</p>{task.task.executions.map((id,i) => <p key={id}><a href={`#/run/${encodeURIComponent(id)}`}>Execution {i+1} · {id}</a></p>)}{run?.worktrees.map(w => <p key={w.path}><code>{w.path}</code></p>)}{run?.participation.map(p => <div key={p.id}>{p.assignments.map(a => <p key={a.id}>{p.id} / {a.id} · {a.status}<br/><code>{a.sessionId || "No native session receipt"}</code></p>)}</div>)}<a href={`#/task/${encodeURIComponent(task.task.id)}`}>Approach revision history</a></details>
  </section>;
}
