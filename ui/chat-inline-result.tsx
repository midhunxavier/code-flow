import { useEffect, useState } from "preact/hooks";
import type { ChatEvent } from "../src/conversational/chat-model.js";
import type { TaskSnapshot } from "../src/conversational/service.js";
import { api, enc } from "./lib.js";
import { Icon } from "./icons.js";
import { TaskResult } from "./task-conversation.js";
import { chatResultExecution } from "./chat-result-data.js";

export function ChatInlineResult({ event, task, onEvidence }: { event: ChatEvent; task?: TaskSnapshot; onEvidence: () => void }) {
  const recorded = chatResultExecution(event, task?.execution);
  const [historical, setHistorical] = useState<TaskSnapshot>(), [error, setError] = useState("");
  const execution = recorded ?? (historical?.execution && historical.execution.id === event.runId ? historical.execution : undefined);
  useEffect(() => {
    if (recorded || !event.taskId || !event.runId) return;
    const controller = new AbortController(); setHistorical(undefined); setError("");
    void api<TaskSnapshot>(`/api/task-conversations/${enc(event.taskId)}/execution?runId=${enc(event.runId)}`, { signal: controller.signal }).then(setHistorical).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [event.taskId, event.runId, !!recorded]);
  return <article class="task-turn chat-deliverable chat-inline-result">
    <div class="task-message-meta"><span class="task-avatar"><Icon name="check"/></span><b>Code Flow</b><time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
    <div class="task-turn-body"><h2>{event.body}</h2>
      {execution && event.taskId ? execution.artifacts.length ? <TaskResult taskId={event.taskId} execution={execution} preferredId={event.artifact?.id} label="Final result"/> : <p class="help">No final artifact was recorded. Inspect the execution for preserved work.</p> : error ? <p role="alert">Could not load the saved result: {error}</p> : <p role="status">Loading the saved result…</p>}
      <div class="task-result-actions"><button class="btn ghost small" type="button" onClick={onEvidence}>Evidence and changes</button><a class="btn ghost small" href={`#/run/${enc(event.runId!)}`}>Inspect execution</a></div>
    </div>
  </article>;
}
