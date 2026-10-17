import { useEffect, useRef, useState } from "preact/hooks";
import { commentsMessage, FileDiff, lastWriter, type Comment } from "./review.js";
import { AgentPicker } from "./run.js";
import { api, enc, post, showToast, store } from "./lib.js";
import { route } from "./state.js";
import type { AgentId, DiffFile, Run, RunSummary } from "./types.js";

const STATUS = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

/**
 * The side panel's Changes tab: what a run changed, next to its thread. The whole result branch or
 * just its last step; line comments go back to the agent, and share their drafts with the Review page.
 */
export function ChangesTab({ run }: { run: RunSummary }) {
  const branches = [...new Set([...run.artifacts.map((a) => a.branch), ...run.worktrees.map((w) => w.branch)])];
  const [picked, setPicked] = useState<string | null>(null);
  const branch = picked && branches.includes(picked) ? picked : branches[0] ?? "";
  const [last, setLast] = useState(false);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const draftKey = `comments:${run.id}:${branch}`;
  const [comments, setCommentsState] = useState<Comment[]>(() => store.json(draftKey, []));
  const [full, setFull] = useState<Run | null>(null);
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [sending, setSending] = useState(false);
  const setComments = (next: Comment[]) => {
    setCommentsState(next);
    store.set(draftKey, JSON.stringify(next));
  };
  useEffect(() => setCommentsState(store.json(draftKey, [])), [draftKey]);

  // New commits (a follow-up, a fix) change the diff: reload when the run moves on.
  const moved = `${run.status}|${run.followUps.map((f) => f.status).join()}|${run.artifacts.map((a) => a.stat).join()}`;
  // Another branch or view: its files, not the last ones, once they've loaded.
  const view = `${branch}|${last}`;
  const loaded = useRef(view);
  useEffect(() => {
    if (!branch) return;
    let alive = true;
    setError("");
    if (loaded.current !== view) {
      loaded.current = view;
      setFiles(null);
    }
    api<DiffFile[]>(`/api/runs/${enc(run.id)}/diff?branch=${enc(branch)}${last ? "&last=1" : ""}`).then(
      (d) => alive && setFiles(d),
      (e) => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
  }, [run.id, branch, last, moved]);
  // The steps say who last wrote here: comments go to them unless you pick someone else.
  useEffect(() => {
    api<Run>(`/api/runs/${enc(run.id)}`).then(setFull, () => setFull(null));
  }, [run.id, run.followUps.length]);

  const worktree = run.worktrees.find((w) => w.branch === branch);
  const target: AgentId = agent ?? lastWriter(full, worktree?.name) ?? "claude";
  const file = files?.find((f) => f.path === open);
  const totals = files?.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const canSend = run.status === "done" && !!worktree && comments.length > 0 && !sending;

  const send = async () => {
    if (!worktree) return;
    setSending(true);
    try {
      await post(`/api/runs/${enc(run.id)}/followups`, { kind: "comments", worktree: worktree.name, agent: target, message: commentsMessage(comments) });
      setComments([]);
      showToast("Sent — the agent is working on your comments");
    } catch (err) {
      showToast((err as Error).message, 5000);
    } finally {
      setSending(false);
    }
  };

  if (!branches.length) return <div class="side-empty help">This run has no branch yet: its changes show here once an agent has worked.</div>;
  return (
    <>
      <div class="side-toolbar">
        {branches.length > 1 ? (
          <select class="field" aria-label="Branch" value={branch} onChange={(e) => (setPicked(e.currentTarget.value), setOpen(null))}>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b.split("/").pop()} · {b}
              </option>
            ))}
          </select>
        ) : (
          <code class="changes-branch" title={branch}>
            {branch}
          </code>
        )}
        <div class="segmented small" role="group" aria-label="Which changes">
          <button type="button" class={!last ? "on" : ""} aria-pressed={!last} title="Everything on the branch since the run started" onClick={() => setLast(false)}>
            Whole run
          </button>
          <button type="button" class={last ? "on" : ""} aria-pressed={last} title="The branch's latest commit: what the most recent step or follow-up changed" onClick={() => setLast(true)}>
            Last step
          </button>
        </div>
        <button type="button" class="btn ghost small" title="Review the branch file by file, full width" onClick={() => (route.value = { view: "review", id: run.id, branch })}>
          Full review
        </button>
      </div>
      <div class="changes">
        {error ? <div class="side-empty msg err">{error}</div> : null}
        {!files && !error ? <div class="side-empty help">Loading…</div> : null}
        {file ? (
          <>
            <div class="file-head">
              <button type="button" class="btn ghost small" aria-label="Back to the changed files" title="Back to the changed files" onClick={() => setOpen(null)}>
                ←
              </button>
              <span class="fp" title={file.path}>
                {file.path}
              </span>
              <span class="help">
                <span class="add">+{file.additions}</span> <span class="del">−{file.deletions}</span>
              </span>
            </div>
            <div class="changes-diff">
              <FileDiff
                key={`${branch}:${file.path}:${last}`}
                file={file}
                comments={comments.filter((c) => c.file === file.path)}
                onAdd={(c) => setComments([...comments, c])}
                onRemove={(c) => setComments(comments.filter((x) => x !== c))}
              />
            </div>
          </>
        ) : files ? (
          <>
            <div class="changes-sum help">
              {files.length ? (
                <>
                  {files.length} file{files.length === 1 ? "" : "s"} · <span class="add">+{totals!.add}</span> <span class="del">−{totals!.del}</span>
                  {last ? " in the last step" : ""}
                </>
              ) : last ? (
                "No commits on this branch yet."
              ) : (
                "No changes on this branch yet."
              )}
            </div>
            {files.map((f) => {
              const n = comments.filter((c) => c.file === f.path).length;
              return (
                <button key={f.path} type="button" class="rf" onClick={() => setOpen(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span class={`fs ${f.status}`}>{STATUS[f.status]}</span>
                  <span class="fp">{f.path}</span>
                  {n ? <span class="count">{n}</span> : null}
                  <span class="fn">
                    <span class="add">+{f.additions}</span> <span class="del">−{f.deletions}</span>
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
      </div>
      {comments.length ? (
        <div class="changes-send">
          <span class="help">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
          </span>
          {run.status === "done" ? (
            <>
              <label class="to">
                <span class="to-lbl">To</span>
                <AgentPicker value={target} onChange={setAgent} />
              </label>
              <button type="button" class="btn primary small" disabled={!canSend} onClick={send}>
                {sending ? "Sending…" : "Send"}
              </button>
            </>
          ) : (
            <span class="help">They can be sent once the run has finished.</span>
          )}
        </div>
      ) : null}
    </>
  );
}
