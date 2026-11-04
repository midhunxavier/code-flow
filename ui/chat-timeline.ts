import type { ChatEvent } from "../src/conversational/chat-model.js";

/** Put each task's controls after its explanation, or after the confirmation that started it. */
export function chatTimeline(events: ChatEvent[]): ChatEvent[] {
  const tasks = new Map<string, ChatEvent>();
  for (const event of events) if (event.kind === "task" && event.taskId) tasks.set(event.taskId, event);
  const anchors = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.taskId && (event.proposal || event.kind === "receipt" && event.body?.startsWith("Started the reviewed approach"))) {
      anchors.set(event.taskId, index);
      if (!tasks.has(event.taskId)) tasks.set(event.taskId, { id: `task-${event.taskId}`, kind: "task", taskId: event.taskId, sequence: event.sequence, at: event.at });
    }
  });
  events.forEach((event, index) => {
    if (event.kind !== "task" || !event.taskId || anchors.has(event.taskId)) return;
    const next = events[index + 1];
    anchors.set(event.taskId, next?.kind === "answer" && (!next.taskId || next.taskId === event.taskId) ? index + 1 : index);
  });
  return events.flatMap((event, index) => [
    ...(event.kind === "task" ? [] : [event]),
    ...[...anchors].filter(([, anchor]) => anchor === index).map(([id]) => tasks.get(id)!),
  ]);
}
