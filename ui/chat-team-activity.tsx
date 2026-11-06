import { useState } from "preact/hooks";
import type { TaskSnapshot } from "../src/conversational/service.js";
import { Icon } from "./icons.js";
import { TaskActivity, TaskResult } from "./task-conversation.js";

type Execution = NonNullable<TaskSnapshot["execution"]>;
type Output = Execution["artifacts"][number];

const outputLabels: Record<string, string> = { plan: "Plan", review: "Review", code_snapshot: "Code snapshot", verification: "Check output", decision: "Decision" };

export function ChatTeamActivity({ taskId, execution, status, onInspect }: { taskId: string; execution: Execution; status: string; onInspect: () => void }) {
  const running = execution.status === "running";
  const active = running ? execution.participation.flatMap(worker => worker.assignments.filter(assignment => assignment.status === "running").map(assignment => ({ ...assignment, participant: worker.id }))) : [];
  const outputs = execution.artifacts.filter(artifact => artifact.kind !== "result" && artifact.kind !== "collection");
  return <section class="chat-team-run" aria-label="Team activity">
    <div class="chat-team-run-header"><Icon name="layers"/><h2>Team activity</h2><span role="status">{status}</span><button type="button" class="btn ghost small" onClick={onInspect}>Details</button></div>
    {active.length ? <ul class="chat-team-workers" aria-label="Active assignments">{active.map(step => <li key={step.id}><span class="dot running" aria-hidden="true"/><div><strong>{step.participant}</strong><span>{step.title || "Working on the approved task"}</span></div></li>)}</ul>
      : running && !outputs.length ? <p class="help">Completed outputs will appear here.</p> : null}
    {outputs.length ? <ol class="chat-team-outputs" aria-label="Completed outputs">{outputs.map((artifact, index) => <li key={artifact.id}><TeamOutput taskId={taskId} execution={execution} artifact={artifact} number={index + 1}/></li>)}</ol> : null}
    {execution.activity.length ? <details class="chat-team-step-history"><summary>Step history</summary><TaskActivity execution={execution}/></details> : null}
  </section>;
}

function TeamOutput({ taskId, execution, artifact, number }: { taskId: string; execution: Execution; artifact: Output; number: number }) {
  const [open, setOpen] = useState(false);
  const label = `${outputLabels[artifact.kind] ?? artifact.kind}${artifact.participant ? ` from ${artifact.participant}` : ""}`;
  const verdict = artifact.kind === "review" ? artifact.data?.verdict === "approve" ? "Approved" : artifact.data?.verdict === "changes_requested" ? "Changes requested" : undefined : undefined;
  return <div class="chat-team-output">
    <button type="button" class="chat-team-output-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron"/><span class="chat-team-output-index" aria-hidden="true">{number}</span><strong>{label}</strong>{verdict ? <span class="chat-team-output-verdict">{verdict}</span> : null}</button>
    {open ? <TaskResult taskId={taskId} execution={execution} preferredId={artifact.id} label={label} artifactOnly/> : null}
    {!open && artifact.excerpt ? <p class="chat-team-output-preview">{artifact.excerpt}{artifact.excerptTruncated ? "…" : ""}</p> : null}
  </div>;
}
