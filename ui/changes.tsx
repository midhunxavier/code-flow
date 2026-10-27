import { pollVisible } from "./polling.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { changeCommentDrafts, commentDrafts, commentsMessage, FileDiff, lastWriter, MergedBadge, MergedNote } from "./review.js";
import { AgentPicker } from "./run.js";
import { api, enc, post, showToast, showError } from "./lib.js";
import { navigate, sideOpen, sideTab } from "./state.js";
import type { AgentId, DiffFile, Run, RunSummary } from "./types.js";
import { chatProvider } from "./run-experience.js";
import { ReviewCoveragePanel } from "./review-coverage.js";
import { CollaborationPanel } from "./collaboration.js";

const STATUS = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

/**
 * The side panel's Changes tab: what a run changed, next to its thread. The whole result branch or
 * just its last step; line comments go back to the agent, and share their drafts with the Review page.
 */
export function ChangesTab({ run }: { run: RunSummary }) {
  // Not a branch that was deleted: its changes are gone.
  const branches = [...new Set([...run.artifacts.map((a) => a.branch), ...run.worktrees.map((w) => w.branch)])].filter((b) => run.worktrees.some((w) => w.branch === b) || !run.deletedWorktrees?.some((w) => w.branch === b));
  const [picked, setPicked] = useState<string | null>(null);
  const branch = picked && branches.includes(picked) ? picked : branches[0] ?? "";
  const [last, setLast] = useState(false);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const draftKey = `comments:${run.id}:${branch}`;
  // Shared with the Review page, which can be open next to this tab.
  const comments = commentDrafts(draftKey);
  const [full, setFull] = useState<Run | null>(null);
  const [fullError, setFullError] = useState("");
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [sending, setSending] = useState(false);

  // New commits (a follow-up, a fix) change the diff: reload when the run moves on.
  const moved = `${run.status}|${run.followUps.map((f) => f.status).join()}|${run.artifacts.map((a) => a.stat).join()}|${run.usage?.agentSteps}|${run.lastCheck?.at}`;
  // While the team works, a step's commit doesn't always come with a new snapshot of the run: look
  // again every few seconds while you can see this tab.
  const shown = sideOpen.value && sideTab.value === "changes";
  const watching = run.status === "running" && shown;
  // Another branch or view: its files, not the last ones, once they've loaded.
  const view = `${branch}|${last}`;
  const loaded = useRef(view);
  useEffect(() => {
    if (!branch || !shown) return;
    let alive = true;
    setError("");
    if (loaded.current !== view) {
      loaded.current = view;
      setFiles(null);
    }
    const stop = pollVisible(() => api<DiffFile[]>(`/api/runs/${enc(run.id)}/diff?branch=${enc(branch)}${last ? "&last=1" : ""}`).then(
      (d) => { if (alive) { setFiles(d); setError(""); } },
      (e) => alive && setError((e as Error).message),
    ), watching ? 10_000 : 0);
    return () => {
      alive = false;
      stop();
    };
  }, [run.id, branch, last, moved, watching, shown]);
  // The steps say who last wrote here: comments go to them unless you pick someone else.
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    const stop = pollVisible(() => api<Run>(`/api/runs/${enc(run.id)}`).then(value => { if (alive) { setFull(value); setFullError(""); } }, (e) => { if (alive) setFullError((e as Error).message); }), 0);
    return () => { alive = false; stop(); };
  }, [run.id, run.followUps.length, shown]);

  const worktree = run.worktrees.find((w) => w.branch === branch);
  // An Agent chat's comments go to its provider, which the summary names; other runs' wait for the
  // steps to say who wrote here (or for you to choose), and never go to someone by default.
  const provider = chatProvider(run);
  const recipient = provider ?? agent ?? lastWriter(full, worktree?.name);
  const file = files?.find((f) => f.path === open);
  const totals = files?.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const canSend = run.status === "done" && !!worktree && !!recipient && comments.length > 0 && !sending;

  const send = async () => {
    if (!worktree || !recipient) return;
    setSending(true);
    try {
      // Each comment names the line its code is on now: in the branch's whole diff, or the last step's
      // when you're looking at that (a comment can be on either).
      const whole = last ? await api<DiffFile[]>(`/api/runs/${enc(run.id)}/diff?branch=${enc(branch)}`).catch(() => undefined) : files ?? undefined;
      const now = last && whole && files ? [...whole, ...files] : whole;
      await post(`/api/runs/${enc(run.id)}/followups`, { kind: "comments", worktree: worktree.name, agent: recipient, message: commentsMessage(comments, "", now) });
      changeCommentDrafts(draftKey, () => []);
      showToast("Sent — the agent is working on your comments");
    } catch (err) {
      showError((err as Error).message, 5000);
    } finally {
      setSending(false);
    }
  };

  if (!branches.length) return <div class="side-empty help">{run.deletedWorktrees?.length ? "This run's branches were deleted, so there are no changes to show." : "This run has no branch yet: its changes show here once an agent has worked."}</div>;
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
          <button type="button" class={last ? "on" : ""} aria-pressed={last} title={run.pattern === "solo" && !run.checkpointOnFinish ? "Changes not yet committed" : "The branch's latest commit: what the most recent step or follow-up changed"} onClick={() => setLast(true)}>
            {run.pattern === "solo" && !run.checkpointOnFinish ? "Uncommitted" : "Last step"}
          </button>
        </div>
        <button type="button" class="btn ghost small" title="Review the branch file by file, full width" onClick={() => navigate({ view: "review", id: run.id, branch })}>
          Full review
        </button>
      </div>
      {!last ? <ReviewCoveragePanel runId={run.id} branch={branch} refreshKey={moved} onOpen={setOpen} /> : null}
      {!last ? <CollaborationPanel runId={run.id} branch={branch} refreshKey={moved} /> : null}
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
                <bdi>{file.path}</bdi>
              </span>
              <span class="help">
                <span class="add">+{file.additions}</span> <span class="del">−{file.deletions}</span>
              </span>
            </div>
            <div class="changes-diff" role="region" aria-label={`Diff of ${file.path}`}>
              <FileDiff
                key={`${branch}:${file.path}:${last}`}
                file={file}
                comments={comments.filter((c) => c.file === file.path)}
                onAdd={(c) => changeCommentDrafts(draftKey, (now) => [...now, c])}
                onRemove={(c) => changeCommentDrafts(draftKey, (now) => now.filter((x) => x !== c))}
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
              const cut = f.path.lastIndexOf("/") + 1;
              return (
                <button key={f.path} type="button" class="rf" onClick={() => setOpen(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span class={`fs ${f.status}`}>{STATUS[f.status]}</span>
                  {/* Cut from the start, so the file's name stays in view; its folders fainter, as on the Review page. */}
                  <span class="fp">
                    <bdi>
                      {cut ? <span class="fdir">{f.path.slice(0, cut)}</span> : null}
                      {f.path.slice(cut)}
                    </bdi>
                  </span>
                  <MergedBadge file={f} />
                  {n ? <span class="count">{n}</span> : null}
                  <span class="fn">
                    <span class="add">+{f.additions}</span> <span class="del">−{f.deletions}</span>
                  </span>
                </button>
              );
            })}
            <MergedNote files={files} />
          </>
        ) : null}
      </div>
      {comments.length ? (
        <div class="changes-send">
          <span class="help" title={fullError || undefined}>
            {comments.length} comment{comments.length === 1 ? "" : "s"}
            {!recipient && fullError && run.status === "done" ? " · Couldn't load who wrote this: choose who gets them" : ""}
          </span>
          {run.status === "done" ? (
            <>
              <label class="to">
                <span class="to-lbl">To</span>
                <AgentPicker value={recipient} fixed={!!provider} placeholder={full || fullError ? "Choose an agent…" : "Loading recipient…"} onChange={setAgent} />
              </label>
              <button type="button" class="btn primary small" disabled={!canSend} title={recipient ? undefined : "Choose who gets these comments"} onClick={send}>
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
