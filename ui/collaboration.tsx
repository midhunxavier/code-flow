import { useEffect, useRef, useState } from "preact/hooks";
import type { CollaborationThread } from "../src/collaboration-reviews.js";
import { api, enc, post } from "./lib.js";

/** Human review stays separate from agent notes and executable follow-ups. */
export function CollaborationPanel({ runId, branch, refreshKey }: { runId: string; branch: string; refreshKey?: string }) {
  const scope = `${runId}\0${branch}`, current = useRef(scope); current.current = scope;
  const generation = useRef(0), mutation = useRef(false);
  const [opened, setOpened] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [thread, setThread] = useState<CollaborationThread>(), [head, setHead] = useState(""), [draft, setDraft] = useState({ scope, text: "" });
  const text = draft.scope === scope ? draft.text : "";
  const refresh = async () => {
    const request = ++generation.current; setLoading(true); setError("");
    try {
      const [comments, coverage] = await Promise.all([api<CollaborationThread>(`/api/runs/${enc(runId)}/collaboration`), api<{ head: string }>(`/api/runs/${enc(runId)}/review-coverage?branch=${enc(branch)}`)]);
      if (current.current !== scope || request !== generation.current) return;
      setThread(comments); setHead(coverage.head);
    } catch (problem) { if (current.current === scope && request === generation.current) setError((problem as Error).message); }
    finally { if (current.current === scope && request === generation.current) setLoading(false); }
  };
  useEffect(() => { setThread(undefined); setHead(""); if (opened) void refresh(); return () => { generation.current++; }; }, [runId, branch, refreshKey, opened]);
  return <details class="collaboration-comments" onToggle={(event) => setOpened(event.currentTarget.open)}><summary>Comments<span class="review-summary-meta">{error ? "Needs attention" : thread?.comments.length ? thread.comments.length : ""}</span></summary>
    <p class="help">Leave feedback on this result. To request changes from agents, use the main chat.</p>
    <button class="btn small" type="button" disabled={busy || loading} onClick={() => void refresh()}>Refresh comments</button>
    {loading ? <p class="help" role="status">Loading comments…</p> : null}
    {error ? <p class="msg err" role="alert">{error} Your comment draft is kept.</p> : null}
    {thread?.comments.map((comment) => <article key={comment.id}><strong>{comment.actor.name}</strong><p class="help">{comment.branch} · {comment.head.slice(0, 12)} · {new Date(comment.at).toLocaleString()}{comment.branch !== branch || head && comment.head !== head ? " · another branch or earlier commit" : ""}</p><pre>{comment.text}</pre></article>)}
    {thread && !thread.comments.length ? <p class="help">No comments yet.</p> : null}
    <form onSubmit={async (event) => {
      event.preventDefault(); if (mutation.current || !head || !text.trim()) return;
      mutation.current = true; generation.current++; setLoading(false); setBusy(true); setError("");
      try { const result = await post<CollaborationThread>(`/api/runs/${enc(runId)}/collaboration`, { branch, expectedHead: head, text }); if (current.current === scope) { setThread(result); setDraft({ scope, text: "" }); } }
      catch (problem) { if (current.current === scope) setError((problem as Error).message); }
      finally { mutation.current = false; setBusy(false); }
    }}><label>Your comment<textarea class="field" rows={3} maxLength={4000} value={text} onInput={(event) => setDraft({ scope, text: event.currentTarget.value })} /></label><p class="help">{head ? `Result commit ${head.slice(0, 12)}` : "Load the current result commit before commenting."}</p><button class="btn small" disabled={busy || loading || !head || !text.trim()}>{busy ? "Saving…" : "Add comment"}</button></form>
  </details>;
}
