import { useRef, useState } from "preact/hooks";
import type { TaskSnapshot } from "../src/conversational/service.js";
import { Icon } from "./icons.js";
import { TaskActivity, TaskResult } from "./task-conversation.js";
import { ApproachSummary, taskCardSection, type TaskSection } from "./chat-task-card.js";
import { OutputChanges } from "./chat-result.js";

type Execution = NonNullable<TaskSnapshot["execution"]>;
type Output = Execution["artifacts"][number];

const outputLabels: Record<string, string> = { plan: "Plan", review: "Review", code_snapshot: "Code snapshot", verification: "Check output", decision: "Decision" };

/** One task in the thread. Its sections switch in place, so approach, reviews and results never take you away from the task. */
export function ChatTeamActivity({ task, execution, status, onInspect, onHold }: { task: TaskSnapshot; execution: Execution; status: string; onInspect: () => void; onHold?: () => void }) {
  const taskId = task.task.id;
  const running = execution.status === "running";
  const active = running ? execution.participation.flatMap(worker => worker.assignments.filter(assignment => assignment.status === "running").map(assignment => ({ ...assignment, participant: worker.id }))) : [];
  const outputs = execution.artifacts.filter(artifact => artifact.kind !== "result" && artifact.kind !== "collection");
  const reviews = execution.artifacts.filter(a => a.kind === "review"), checks = execution.artifacts.filter(a => a.kind === "verification");
  const results = execution.artifacts.filter(a => a.kind === "result" || a.kind === "plan");
  const write = task.proposal?.definition.scope === "write";
  const reviewing = JSON.stringify(task.proposal?.definition.steps ?? []).match(/"operation":"review_(?:plan|code)"/);
  const sections: [TaskSection, string, number?][] = [["progress", "Progress"], ...(task.proposal ? [["approach", "Approach"]] as [TaskSection, string][] : []), ...(reviews.length || reviewing ? [["reviews", "Reviews", reviews.length]] as [TaskSection, string, number][] : []), ...(results.length ? [["result", "Result"]] as [TaskSection, string][] : []), ...(write || checks.length ? [["checks", "Checks", checks.length]] as [TaskSection, string, number][] : []), ...(write ? [["changes", "Changes"]] as [TaskSection, string][] : [])];
  const chosen = taskCardSection.value[taskId], section = sections.some(([id]) => id === chosen) ? chosen! : "progress";
  const card = useRef<HTMLElement>(null);
  // Switching sections changes the card's height; keep its header where it was instead of following the thread to the bottom.
  const choose = (id: TaskSection) => {
    const el = card.current, box = el?.closest<HTMLElement>(".task-chat-scroll"), top = el?.getBoundingClientRect().top;
    onHold?.(); taskCardSection.value = { ...taskCardSection.value, [taskId]: id };
    if (el && box && top !== undefined) requestAnimationFrame(() => { box.scrollTop += el.getBoundingClientRect().top - top; });
  };
  const approved = reviews.filter(a => a.data?.verdict === "approve").length, changes = reviews.filter(a => a.data?.verdict === "changes_requested").length;
  return <section ref={card} class="chat-team-run" aria-label="Team activity" data-task-card={taskId}>
    <div class="chat-team-run-header"><Icon name="layers"/><h2>Team activity</h2><span role="status">{status}</span><button type="button" class="btn ghost small" onClick={onInspect}>Details</button></div>
    <div class="task-card-sections" role="group" aria-label="Task sections">{sections.map(([id, label, count]) => <button type="button" key={id} aria-pressed={section === id} onClick={() => choose(id)}>{label}{count ? <> <span class="task-card-count">{count}</span></> : null}</button>)}</div>
    {section === "progress" ? <>
      {active.length ? <ul class="chat-team-workers" aria-label="Active assignments">{active.map(step => <li key={step.id}><span class="dot running" aria-hidden="true"/><div><strong>{step.participant}</strong><span>{step.title || "Working on the approved task"}</span></div></li>)}</ul>
        : running && !outputs.length ? <p class="help">Completed outputs will appear here.</p> : null}
      {outputs.length ? <ol class="chat-team-outputs" aria-label="Completed outputs">{outputs.map((artifact, index) => <li key={artifact.id}><TeamOutput taskId={taskId} execution={execution} artifact={artifact} number={index + 1}/></li>)}</ol> : null}
      {execution.activity.length ? <details class="chat-team-step-history"><summary>Step history</summary><TaskActivity execution={execution}/></details> : null}
    </> : section === "approach" ? <ApproachSummary task={task}/>
    : section === "reviews" ? reviews.length ? <>
      <p class="task-card-summary">{reviews.length} {reviews.length === 1 ? "review" : "reviews"}{approved ? ` · ${approved} approved` : ""}{changes ? ` · ${changes} requested changes` : ""}</p>
      <ol class="chat-team-outputs" aria-label="Reviews">{reviews.map((artifact, index) => <li key={artifact.id}><TeamOutput taskId={taskId} execution={execution} artifact={artifact} number={index + 1}/></li>)}</ol>
    </> : <p class="help">{running ? "Reviews appear here as each reviewer finishes." : "No reviewer verdict was recorded."}</p>
    : section === "checks" ? checks.length ? <ol class="chat-team-outputs" aria-label="Checks">{checks.map((artifact, index) => <li key={artifact.id}><TeamOutput taskId={taskId} execution={execution} artifact={artifact} number={index + 1}/></li>)}</ol> : <p class="help">{running ? "Check output appears here after the check command runs." : "No check evidence was recorded."}</p>
    : section === "changes" ? <OutputChanges execution={execution}/>
    : <TaskResult taskId={taskId} execution={execution} preferredId={results.filter(a => a.kind === "result").at(-1)?.id ?? results.at(-1)?.id} label="Task result"/>}
  </section>;
}

function TeamOutput({ taskId, execution, artifact, number }: { taskId: string; execution: Execution; artifact: Output; number: number }) {
  const [open, setOpen] = useState(false);
  const label = `${outputLabels[artifact.kind] ?? artifact.kind}${artifact.participant ? ` from ${artifact.participant}` : ""}`;
  const verdict = artifact.kind === "review" ? artifact.data?.verdict === "approve" ? "Approved" : artifact.data?.verdict === "changes_requested" ? "Changes requested" : undefined : undefined;
  return <div class="chat-team-output">
    <button type="button" class="chat-team-output-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron"/><span class="chat-team-output-index" aria-hidden="true">{number}</span><strong>{label}</strong>{verdict ? <span class={`chat-team-output-verdict ${artifact.data?.verdict === "approve" ? "is-approved" : "is-changes"}`}>{verdict}</span> : null}</button>
    {open ? <TaskResult taskId={taskId} execution={execution} preferredId={artifact.id} label={label} artifactOnly/> : null}
    {!open && artifact.excerpt ? <p class="chat-team-output-preview">{artifact.excerpt}{artifact.excerptTruncated ? "…" : ""}</p> : null}
  </div>;
}
