import { subscribe } from "./stream.js";
import { pollVisible } from "./polling.js";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, post } from "./lib.js";
import { route } from "./state.js";
import type { ApprovalRecord } from "../src/approvals.js";

/** Permission requests are explicit, one-action decisions; an ignored request expires denied. */
export function ApprovalInbox() {
  const [pending, setPending] = useState<ApprovalRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    let current = true;
    let stopFallback: (() => void) | undefined;
    const stop = subscribe("approvals", (data: { type: string; records?: ApprovalRecord[]; status?: number }) => {
      if (!current) return;
      if (data.type === "snapshot" && data.records) setPending(data.records);
      // Older connected hosts do not have the topic. Current hosts need no approval timer.
      if (data.type === "error" && data.status === 404 && !stopFallback) {
        stopFallback = pollVisible(async () => {
          const records = await api<ApprovalRecord[]>("/api/approvals");
          if (current) setPending(records.filter(record => record.status === "pending"));
        }, 2000);
      }
    });
    return () => { current = false; stop(); stopFallback?.(); };
  }, []);
  const request = pending[0];
  if (!request) return null;
  const decide = async (decision: "approve" | "decline") => {
    setBusy(true); setError("");
    try { await post(`/api/approvals/${request.id}`, { decision, answers: answers[request.id] }); setPending((records) => records.filter((record) => record.id !== request.id)); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  // A raised card over the corner of the page: a warn strip names the request, the command or files
  // follow as code, and the decision is one ink button.
  return <aside class="approval-inbox" role="alert" aria-label={request.kind === "question" ? "Agent question" : "Tool approval required"}>
    <div class="ai-head">
      <Icon name="alert" />
      <h3>{request.kind === "question" ? "Your agent has a question" : "Permission required"}</h3>
      {pending.length > 1 ? <span class="ai-count">{pending.length} pending</span> : null}
    </div>
    <div class="ai-body">
      <p class="ai-what">{request.kind === "command" ? "Run this command once" : request.kind === "tool" ? `Use ${request.toolName} once` : request.kind === "question" ? "Answer to continue this turn" : "Apply these file changes once"}</p>
      {request.input ? <pre class="ai-command">{request.input}</pre> : null}
      {request.questions?.map(q => <label key={`${request.id}:${q.id}`}>{q.question}{q.options?.length ? <div class="row">{q.options.map(option => <button class="btn small" type="button" onClick={() => setAnswers(values => ({ ...values, [request.id]: { ...values[request.id], [q.id]: option } }))}>{option}</button>)}</div> : null}<textarea class="field" aria-label={q.question} value={answers[request.id]?.[q.id] ?? ""} onInput={event => setAnswers(values => ({ ...values, [request.id]: { ...values[request.id], [q.id]: event.currentTarget.value } }))} /></label>)}
      {request.command ? <pre class="ai-command">{request.command}</pre> : null}
      {request.paths?.length ? <ul class="ai-paths">{request.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null}
      {request.cwd ? <p class="ai-folder">Folder <code>{request.cwd}</code></p> : null}
      {request.reason ? <p class="ai-reason">{request.reason}</p> : null}
      <p class="help">Expires at {new Date(request.expiresAt).toLocaleTimeString()}. This decision grants no session-wide permissions.</p>
      {error ? <p class="msg err">{error}</p> : null}
    </div>
    <div class="ai-actions"><button class="btn primary" disabled={busy || request.kind === "question" && !request.questions?.every(q => answers[request.id]?.[q.id]?.trim())} onClick={() => decide("approve")}>{request.kind === "question" ? "Send answer" : "Approve once"}</button><button class="btn" disabled={busy} onClick={() => decide("decline")}>Decline</button><span class="spacer" /><button class="btn ghost" onClick={() => { route.value = { view: "run", id: request.runId }; }}>Open chat</button></div>
  </aside>;
}
