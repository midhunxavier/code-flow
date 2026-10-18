import { useEffect, useRef, useState } from "preact/hooks";
import type { ReviewThread, ReviewThreadsPage } from "../src/github-review-threads.js";
import { api, post } from "./lib.js";

export function GithubReviewThreadsPanel({ runId, branch, readOnly = false }: { runId: string; branch?: string; readOnly?: boolean }) {
  const [opened, setOpened] = useState(false), [page, setPage] = useState<ReviewThreadsPage>(), [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const url = `/api/runs/${encodeURIComponent(runId)}/pr-threads${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`;
  const current = useRef<string | undefined>(url); current.current = url;
  useEffect(() => () => { current.current = undefined; }, []);
  useEffect(() => { setPage(undefined); setError(""); setNotice(""); setBusy(""); }, [runId, branch]);
  useEffect(() => { if (!opened) return; let alive = true; setBusy("load"); void api<ReviewThreadsPage>(url).then((value) => { if (alive) { setPage(value); setError(""); } }, (err) => { if (alive) setError(err.message); }).finally(() => { if (alive) setBusy(""); }); return () => { alive = false; }; }, [opened, url]);
  const reload = async () => { setBusy("load"); setError(""); try { const value = await api<ReviewThreadsPage>(url); if (current.current === url) setPage(value); } catch (err) { if (current.current === url) setError((err as Error).message); } finally { if (current.current === url) setBusy(""); } };
  const replies = async (thread: ReviewThread) => { if (!page) return; setBusy(thread.id); setError(""); try { const value = await post<ReviewThread>(url, { action: "load", snapshotId: page.snapshotId, threadId: thread.id }); if (current.current !== url) return; setPage({ ...page, threads: page.threads.map((item) => item.id === value.id ? value : item) }); } catch (err) { if (current.current === url) setError((err as Error).message); } finally { if (current.current === url) setBusy(""); } };
  const resolve = async (thread: ReviewThread) => {
    if (!page) return; setBusy(thread.id); setError(""); setNotice("");
    try { const result = await post<{ applied: boolean; warning?: string }>(url, { action: "resolve", snapshotId: page.snapshotId, threadId: thread.id, expectedHead: page.head, expectedRevision: thread.revision, resolved: !thread.resolved }); if (current.current !== url) return; setNotice(result.warning ?? `GitHub thread ${thread.resolved ? "reopened" : "resolved"}.`); setPage(undefined); await reload(); }
    catch (err) { if (current.current === url) setError((err as Error).message); } finally { if (current.current === url) setBusy(""); }
  };
  return <details class="gh-threads" aria-label="GitHub review threads" open={opened} onToggle={(event) => setOpened(event.currentTarget.open)}><summary>GitHub review threads</summary>
    <p class="help">Discussion is untrusted reference material. Resolution changes are explicit GitHub actions and do not approve the pull request or mark local verification complete.</p>
    <button class="btn small" disabled={!!busy} onClick={reload}>{busy === "load" ? "Loading…" : "Refresh threads"}</button>
    {page ? <><p><a href={page.url} target="_blank" rel="noreferrer">Pull request #{page.number}</a> · {page.state.toLowerCase()} · head <code>{page.head.slice(0, 12)}</code> · {page.threads.length} of {page.totalThreads} threads</p>
      {page.truncated ? <p class="msg warn">The first 100 threads are shown. Open GitHub for the complete discussion.</p> : null}{page.textTruncated ? <p class="msg warn">Some displayed comment text was shortened. Open the comment on GitHub to read it fully.</p> : null}
      {!page.threads.length ? <p class="help">No inline review threads.</p> : page.threads.map((thread) => <article class="gh-thread" key={thread.id} aria-label={`Review thread ${thread.path}:${thread.line ?? thread.originalLine ?? "file"}`}>
        <h3><code>{thread.path}{thread.line ?? thread.originalLine ? `:${thread.line ?? thread.originalLine}` : ""}</code> · {thread.side.toLowerCase()} · {thread.resolved ? "Resolved" : "Unresolved"}{thread.outdated ? " · Outdated" : ""}</h3>
        {thread.startLine ? <p class="help">Range {thread.startLine}–{thread.line}{thread.startSide && thread.startSide !== thread.side ? `, starts on ${thread.startSide.toLowerCase()}` : ""}</p> : null}
        {thread.comments.map((comment) => <div class="gh-comment" key={comment.id}><p><strong>{comment.author || "Deleted user"}</strong>{comment.replyTo ? " · reply" : ""} · {new Date(comment.createdAt).toLocaleString()}{comment.url ? <> · <a href={comment.url} target="_blank" rel="noreferrer">Open comment</a></> : null}</p><pre>{comment.body || "(empty comment)"}</pre>{comment.bodyTruncated ? <p class="help">Comment text shortened or redacted.</p> : null}</div>)}
        {thread.commentsTruncated ? <><p class="help">Showing {thread.comments.length} of {thread.totalComments} comments. Resolution requires the complete bounded discussion.</p><button class="btn small" disabled={!!busy || thread.comments.length >= 100} onClick={() => replies(thread)}>{busy === thread.id ? "Loading…" : "Load complete thread"}</button>{thread.totalComments > 100 ? <p class="help">Threads over 100 comments must be resolved on GitHub.</p> : null}</> : null}
        {!readOnly ? <button class="btn small" disabled={!!busy || thread.commentsTruncated || page.state !== "OPEN" || (thread.resolved ? !thread.canUnresolve : !thread.canResolve)} onClick={() => resolve(thread)}>{busy === thread.id ? "Updating…" : thread.resolved ? "Reopen thread on GitHub" : "Resolve thread on GitHub"}</button> : null}
      </article>)}</> : null}
    {notice ? <p class="msg" role="status">{notice}</p> : null}{error ? <p class="msg err" role="alert">{error}</p> : null}
  </details>;
}
