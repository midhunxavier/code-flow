import { ChangeImpact } from "./change-impact.js";
import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { RunEvidence, VerificationEvidence } from "./run-evidence.js";
import { ReviewCoveragePanel } from "./review-coverage.js";
import { useRunStream } from "./run-feed.js";
import { AgentPicker, ArtifactCard } from "./run.js";
import { api, enc, post, showToast, store } from "./lib.js";
import { route, runs } from "./state.js";
import type { AgentId, DiffFile, Run } from "./types.js";

export interface Comment {
  file: string;
  side: "old" | "new";
  line: number;
  code: string;
  text: string;
}

interface Row {
  type: "hunk" | "ctx" | "add" | "del" | "note";
  text: string;
  old?: number;
  new?: number;
}

/**
 * Line comments not sent yet, per run and branch ("comments:<run>:<branch>"). The Review page and the
 * side panel's Changes tab can be open at once, so both read and change this one copy: a comment sent
 * from one is gone from the other, and one added in either is kept. localStorage holds them across
 * visits, and brings in what another window (a popped-out panel) changed.
 */
const drafts = new Map<string, Comment[]>();
const draftsChanged = signal(0);
const cachedDrafts = (key: string): Comment[] => {
  if (!drafts.has(key)) drafts.set(key, store.json<Comment[]>(key, []));
  return drafts.get(key)!;
};
/** The comments not sent yet on a run's branch; a component that reads them re-renders when they change. */
export function commentDrafts(key: string): Comment[] {
  void draftsChanged.value;
  return cachedDrafts(key);
}
/** Change them from what they are now (not from what a view last showed). */
export function changeCommentDrafts(key: string, change: (comments: Comment[]) => Comment[]) {
  const next = change(cachedDrafts(key));
  drafts.set(key, next);
  store.set(key, JSON.stringify(next));
  draftsChanged.value++;
}
window.addEventListener("storage", (e) => {
  if (e.key !== null && !e.key.startsWith("comments:")) return;
  // Read again on next use; no key means the whole storage was cleared.
  if (e.key === null) drafts.clear();
  else drafts.delete(e.key);
  draftsChanged.value++;
});

/** Review a result branch file by file; line comments go back to an agent as a follow-up. */
export function Review({ id, branch }: { id: string; branch: string }) {
  const { run: liveRun, data } = useRunStream(id);
  const summary = liveRun ?? runs.value.get(id);
  const [refresh, setRefresh] = useState(0);
  const draftKey = `comments:${id}:${branch}`;
  const [run, setRun] = useState<Run | null>(null);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState("");
  const [runError, setRunError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // Shared with the side panel's Changes tab, which can be open next to this page.
  const comments = commentDrafts(draftKey);
  const [general, setGeneral] = useState(() => store.get(`${draftKey}:general`) ?? "");
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let current = true;
    setError("");
    api<DiffFile[]>(`/api/runs/${id}/diff?branch=${enc(branch)}`).then(
      (d) => {
        if (!current) return;
        setFiles(d);
        setSelected(previous => d.some(file => file.path === previous) ? previous : d[0]?.path ?? null);
      },
      (e) => { if (current) setError((e as Error).message); },
    );
    // Without the run, comments still work, but "Send to" can't default to the agent that wrote the code.
    api<Run>(`/api/runs/${id}`).then(value => { if (current) { setRun(value); setRunError(""); } }, (e) => { if (current) setRunError(`Couldn't load this run: ${(e as Error).message}. Check who the comments go to before sending.`); });
    return () => { current = false; };
  }, [id, branch, refresh, summary?.status, summary?.lastCheck?.at]);

  const worktree = ((summary ?? run)?.worktrees ?? []).find((w) => w.branch === branch);
  // Default to the agent that last wrote code in this worktree.
  const defaultAgent = useMemo(() => lastWriter(run, worktree?.name), [run, worktree?.name]);
  const target: AgentId = agent ?? defaultAgent ?? "claude";
  const file = files?.find((f) => f.path === selected);
  const totals = files?.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const canSend = summary?.status === "done" && !!worktree && (comments.length > 0 || general.trim().length > 0);

  const send = async () => {
    if (!worktree) return;
    setSending(true);
    const message = commentsMessage(comments, general);
    try {
      await post(`/api/runs/${id}/followups`, { kind: "comments", worktree: worktree.name, agent: target, message });
      changeCommentDrafts(draftKey, () => []);
      store.set(`${draftKey}:general`, "");
      showToast("Sent — the agent is working on your comments");
      route.value = { view: "run", id };
    } catch (err) {
      showToast((err as Error).message, 5000);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="review">
      <div class="review-head">
        <button class="btn ghost small review-back" onClick={() => (route.value = { view: "run", id })}>
          <Icon name="chevron" class="back" /> Back to run
        </button>
        <div class="review-title">
          <h1>Review</h1>
          <code title={branch}>{branch}</code>
          {totals ? (
            <span class="review-totals">
              {files!.length} file{files!.length === 1 ? "" : "s"} · <span class="add">+{totals.add}</span> <span class="del">−{totals.del}</span>
            </span>
          ) : null}
        </div>
        {/* one group, so the agent and the button wrap together */}
        <div class="review-send">
          {summary?.status === "done" ? (
            <>
              <span class="review-to">Send to</span>
              <AgentPicker value={target} onChange={setAgent} />
              <button class="btn primary" disabled={!canSend || sending} onClick={send}>
                {sending ? "Sending…" : `Send ${comments.length || ""} comment${comments.length === 1 ? "" : "s"}`.replace("  ", " ")}
              </button>
            </>
          ) : (
            <span class="review-to">Comments can be sent once the run has finished.</span>
          )}
        </div>
      </div>
      {summary ? <div class="review-overview">
        <RunEvidence run={summary} branch={branch} />
        <div class="review-evidence-tools"><VerificationEvidence run={summary} /><button class="btn small" onClick={() => setRefresh(value => value + 1)}>Refresh changes</button></div>
        {summary.artifacts.find(a => a.branch === branch) ? <details class="review-delivery"><summary>Publish changes</summary><p class="help">Review the diff and evidence before publishing. Merge validation and confirmation still apply.</p><ArtifactCard key={branch} run={summary} artifact={summary.artifacts.find(a => a.branch === branch)!} steps={[...data.current.steps.values()]} reviewing /></details> : null}
      </div> : null}
      {error ? <div class="msg err review-msg">{error}</div> : null}
      {runError ? <div class="msg warn review-msg">{runError}</div> : null}
      <div class="review-body">
        <div class="review-files">
          {worktree && files?.length ? <ChangeImpact folder={worktree.path} paths={files.map(file => file.path)} refreshKey={`${refresh}:${summary?.status}:${summary?.lastCheck?.at}`} /> : null}
          <ReviewCoveragePanel runId={id} branch={branch} refreshKey={`${refresh}:${summary?.status}:${summary?.lastCheck?.at}`} onOpen={setSelected} />
          {files?.map((f) => {
            const n = comments.filter((c) => c.file === f.path).length;
            const cut = f.path.lastIndexOf("/") + 1;
            return (
              <button key={f.path} type="button" class={`rf ${f.path === selected ? "selected" : ""}`} onClick={() => setSelected(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                <span class={`fs ${f.status}`}>{{ added: "A", modified: "M", deleted: "D", renamed: "R" }[f.status]}</span>
                {/* the folder shortens first, so the file's name stays readable */}
                <span class="fp">
                  {cut ? <span class="fdir">{f.path.slice(0, cut)}</span> : null}
                  <span class="fname">{f.path.slice(cut)}</span>
                </span>
                {n ? (
                  <span class="count" title={`${n} comment${n === 1 ? "" : "s"}`}>
                    {n}
                  </span>
                ) : null}
                <span class="fn">
                  <span class="add">+{f.additions}</span> <span class="del">−{f.deletions}</span>
                </span>
              </button>
            );
          })}
          {files && !files.length ? <div class="tree-empty">No changes on this branch.</div> : null}
          <div class="general">
            <label class="lbl" for="general">
              Overall comment
            </label>
            <textarea
              id="general"
              class="field"
              rows={4}
              placeholder="Anything that isn't about one line…"
              value={general}
              onInput={(e) => {
                setGeneral(e.currentTarget.value);
                store.set(`${draftKey}:general`, e.currentTarget.value);
              }}
            />
          </div>
        </div>
        <div class="review-diff" role="region" aria-label={file ? `Diff of ${file.path}` : "Diff"}>
          {file ? (
            <FileDiff
              key={file.path}
              file={file}
              comments={comments.filter((c) => c.file === file.path)}
              onAdd={(c) => changeCommentDrafts(draftKey, (now) => [...now, c])}
              onRemove={(c) => changeCommentDrafts(draftKey, (now) => now.filter((x) => x !== c))}
            />
          ) : files ? null : (
            <div class="tree-empty">Loading diff…</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The agent that last wrote code in a worktree: who line comments go to unless you pick someone else. */
export const lastWriter = (run: Run | null, worktree?: string): AgentId | undefined =>
  [...(run?.steps ?? [])].reverse().find((s) => (s.kind ?? "agent") === "agent" && s.worktree === worktree && s.mode === "write")?.agent;

/** Line comments (and an overall one) as the follow-up message the agent gets. */
export function commentsMessage(comments: Comment[], general = ""): string {
  const lines = comments.map((c, i) => `${i + 1}. ${c.file}:${c.line}${c.side === "old" ? " (a removed line)" : ""} — \`${c.code.trim().slice(0, 140)}\`\n   ${c.text.trim()}`);
  return [lines.join("\n"), general.trim() ? `General: ${general.trim()}` : ""].filter(Boolean).join("\n\n");
}

export function FileDiff({ file, comments, onAdd, onRemove }: { file: DiffFile; comments: Comment[]; onAdd: (c: Comment) => void; onRemove: (c: Comment) => void }) {
  const rows = useMemo(() => parsePatch(file.patch), [file.patch]);
  const [editing, setEditing] = useState<{ side: "old" | "new"; line: number; code: string } | null>(null);
  const [text, setText] = useState("");
  // The diff is one tab stop (a roving tabindex): Tab lands on the last line you were on, the arrow
  // keys move between lines, Enter or Space comments on one. A tab stop per line would trap Tab in a long diff.
  const [active, setActive] = useState(-1);
  const body = useRef<HTMLTableSectionElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  // a new comment box takes focus, opened by click or by key
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);
  if (file.binary) return <div class="tree-empty">Binary file — no text diff.</div>;
  const at = (side: "old" | "new", line?: number) => comments.filter((c) => c.side === side && c.line === line);
  const isLine = (row: Row) => row.type === "add" || row.type === "del" || row.type === "ctx";
  // (a live diff can change under the remembered line: fall back to the first line)
  const stop = rows[active] && isLine(rows[active]!) ? active : rows.findIndex(isLine);
  // closing the editor removes the focused textarea: put focus back on its line, not on the page
  const close = (i: number) => {
    body.current?.querySelector<HTMLElement>(`tr[data-i="${i}"]`)?.focus();
    setEditing(null);
  };
  const move = (e: KeyboardEvent) => {
    const lines = [...(body.current?.querySelectorAll<HTMLElement>("tr.dl[tabindex]") ?? [])];
    const from = lines.indexOf(e.currentTarget as HTMLElement);
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 20, PageUp: -20, Home: -lines.length, End: lines.length };
    if (from < 0 || !(e.key in steps) || e.altKey || e.ctrlKey || e.metaKey) return false;
    e.preventDefault();
    lines[Math.max(0, Math.min(lines.length - 1, from + steps[e.key]!))]!.focus();
    return true;
  };
  return (
    <div>
      <div class="diff-file-head">
        {file.oldPath ? `${file.oldPath} → ` : ""}
        {file.path}
        {file.truncated ? <span class="help"> · diff truncated</span> : null}
      </div>
      <table class="diff">
        <tbody ref={body}>
          {rows.map((row, i) => {
            const side: "old" | "new" = row.type === "del" ? "old" : "new";
            const line = side === "old" ? row.old : row.new;
            const commentable = isLine(row);
            const here = commentable ? at(side, line) : [];
            const isEditing = editing && commentable && editing.side === side && editing.line === line;
            const comment = () => {
              if (!commentable || line === undefined) return;
              setEditing({ side, line, code: row.text });
              setText("");
            };
            return [
              <tr
                key={`r${i}`}
                class={`dl ${row.type}`}
                data-i={i}
                tabIndex={commentable ? (i === stop ? 0 : -1) : undefined}
                onClick={comment}
                onFocus={() => setActive(i)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || move(e)) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    comment();
                  }
                }}
                title={commentable ? "Click or press Enter to comment on this line" : undefined}
              >
                <td class="ln">{row.old ?? ""}</td>
                <td class="ln">{row.new ?? ""}</td>
                <td class="code">
                  <span class="sign">{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
                  {row.text}
                </td>
              </tr>,
              ...here.map((c, j) => (
                <tr key={`c${i}-${j}`} class="comment-row">
                  <td colSpan={3}>
                    <div class="comment">
                      <span>{c.text}</span>
                      <button class="btn ghost small" onClick={() => onRemove(c)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              )),
              isEditing ? (
                <tr key={`e${i}`} class="comment-row">
                  <td colSpan={3}>
                    <div class="comment editing">
                      <textarea
                        ref={editor}
                        class="field"
                        rows={3}
                        aria-label={`Comment on line ${line}`}
                        placeholder="What should change here?"
                        value={text}
                        onInput={(e) => setText(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
                            onAdd({ file: file.path, side, line: line!, code: row.text, text });
                            close(i);
                          }
                          if (e.key === "Escape") close(i);
                        }}
                      />
                      <div class="row">
                        <button class="btn small" onClick={() => close(i)}>
                          Cancel
                        </button>
                        <button
                          class="btn small primary"
                          disabled={!text.trim()}
                          onClick={() => {
                            onAdd({ file: file.path, side, line: line!, code: row.text, text });
                            close(i);
                          }}
                        >
                          Add comment <span class="kbd">⌘↵</span>
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Unified diff → rows with old/new line numbers. */
function parsePatch(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ type: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue; // file header lines (index, ---, +++)
    if (line.startsWith("+")) rows.push({ type: "add", text: line.slice(1), new: newNo++ });
    else if (line.startsWith("-")) rows.push({ type: "del", text: line.slice(1), old: oldNo++ });
    else if (line.startsWith(" ")) rows.push({ type: "ctx", text: line.slice(1), old: oldNo++, new: newNo++ });
    else if (line.startsWith("\\")) rows.push({ type: "note", text: line });
  }
  return rows;
}
