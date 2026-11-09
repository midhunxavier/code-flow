import { signal } from "@preact/signals";
import type { TaskSnapshot } from "../src/conversational/service.js";
import { Sequence } from "./task-conversation.js";

/** Which section each task card in the thread shows. Shared so the side panel can open a section without leaving the task. */
export type TaskSection = "progress" | "approach" | "reviews" | "result" | "checks" | "changes";
export const taskCardSection = signal<Record<string, TaskSection>>({});

export function showTaskSection(taskId: string, section: TaskSection) {
  taskCardSection.value = { ...taskCardSection.value, [taskId]: section };
  // Wait for the section to render, then put the card's header at the top of the thread.
  requestAnimationFrame(() => setTimeout(() => {
    const card = document.querySelector<HTMLElement>(`[data-task-card="${CSS.escape(taskId)}"]`), box = card?.closest<HTMLElement>(".task-chat-scroll");
    if (card && box) box.scrollTo({ top: box.scrollTop + card.getBoundingClientRect().top - box.getBoundingClientRect().top - 8 });
  }));
}

const providerName = (id: string) => id === "codex" ? "Codex" : id === "claude" ? "Claude" : id;
const scopeLabel = (scope: string) => scope === "write" ? "Code changes" : scope === "review" ? "Review only, no file changes" : "Plan only, no file changes";

/** The approach as people read it before and after starting: team, steps, done-when and limits. */
export function ApproachSummary({ task }: { task: TaskSnapshot }) {
  const proposal = task.proposal!, d = proposal.definition;
  return <div class="task-plan-view">
    <section><h3>Team</h3><ul class="task-plan-team">{d.participants.map(p => <li key={p.id}><b>{p.id}</b><span>{providerName(p.provider)}{p.model ? ` · ${p.model}` : ""}{p.effort ? ` · ${p.effort}` : ""}</span></li>)}</ul></section>
    <section><h3>Steps</h3><Sequence steps={d.steps}/></section>
    {d.completion.length ? <section><h3>Done when</h3><ul>{d.completion.map(item => <li key={item}>{item}</li>)}</ul></section> : null}
    <p class="task-plan-meta">{scopeLabel(d.scope)} · up to {d.limits.maxInvocations} agent calls · {d.limits.maxMinutes} min · source <code>{proposal.source.commit.slice(0, 10)}</code> ({proposal.source.source === "working_changes" ? "working copy" : "committed code"}){d.check ? <> · check <code>{d.check}</code></> : null}</p>
    <p class="task-plan-meta">Revision {proposal.revision} · {proposal.runId ? "Accepted for this execution" : "Awaiting your authorization"}</p>
  </div>;
}
