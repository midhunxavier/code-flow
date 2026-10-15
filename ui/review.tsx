import { useEffect, useMemo, useState } from "preact/hooks";
import { AgentPicker } from "./run.js";
import { api, enc, post, showToast, store } from "./lib.js";
import { route, runs } from "./state.js";
import type { AgentId, DiffFile, Run } from "./types.js";

interface Comment {
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

/** Review a result branch file by file; line comments go back to an agent as a follow-up. */
export function Review({ id, branch }: { id: string; branch: string }) {
  const summary = runs.value.get(id);
  const draftKey = `comments:${id}:${branch}`;
  const [run, setRun] = useState<Run | null>(null);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [comments, setCommentsState] = useState<Comment[]>(() => store.json(draftKey, []));
  const [general, setGeneral] = useState(() => store.get(`${draftKey}:general`) ?? "");
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [sending, setSending] = useState(false);

  const setComments = (next: Comment[]) => {
    setCommentsState(next);
    store.set(draftKey, JSON.stringify(next)); // drafts survive navigating away
  };

  useEffect(() => {
    api<DiffFile[]>(`/api/runs/${id}/diff?branch=${enc(branch)}`).then(
      (d) => {
        setFiles(d);
        setSelected(d[0]?.path ?? null);
      },
      (e) => setError((e as Error).message),
    );
    api<Run>(`/api/runs/${id}`).then(setRun, () => {});
  }, [id, branch]);

  const worktree = ((run ?? summary)?.worktrees ?? []).find((w) => w.branch === branch);
  // Default to the agent that last wrote code in this worktree.
  const defaultAgent = useMemo(
    () => [...(run?.steps ?? [])].reverse().find((s) => (s.kind ?? "agent") === "agent" && s.worktree === worktree?.name && s.mode === "write")?.agent,
    [run, worktree?.name],
  );
  const target: AgentId = agent ?? defaultAgent ?? "claude";
  const file = files?.find((f) => f.path === selected);
  const totals = files?.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const canSend = summary?.status === "done" && !!worktree && (comments.length > 0 || general.trim().length > 0);

  const send = async () => {
    if (!worktree) return;
    setSending(true);
    const lines = comments.map(
      (c, i) => `${i + 1}. ${c.file}:${c.line}${c.side === "old" ? " (a removed line)" : ""} — \`${c.code.trim().slice(0, 140)}\`\n   ${c.text.trim()}`,
    );
    const message = [lines.join("\n"), general.trim() ? `General: ${general.trim()}` : ""].filter(Boolean).join("\n\n");
    try {
      await post(`/api/runs/${id}/followups`, { kind: "comments", worktree: worktree.name, agent: target, message });
      setComments([]);
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
        <button class="btn ghost" onClick={() => (route.value = { view: "run", id })}>
          ← Back to run
        </button>
        <div class="review-title">
          <b>Review</b> <code>{branch}</code>
          {totals ? (
            <span class="help">
              {" "}
              {files!.length} file{files!.length === 1 ? "" : "s"} · <span class="add">+{totals.add}</span> <span class="del">−{totals.del}</span>
            </span>
          ) : null}
        </div>
        <span class="spacer" />
        {summary?.status === "done" ? (
          <>
            <span class="help">Send to</span>
            <AgentPicker value={target} onChange={setAgent} />
            <button class="btn primary" disabled={!canSend || sending} onClick={send}>
              {sending ? "Sending…" : `Send ${comments.length || ""} comment${comments.length === 1 ? "" : "s"}`.replace("  ", " ")}
            </button>
          </>
        ) : (
          <span class="help">Comments can be sent once the run has finished.</span>
        )}
      </div>
      {error ? <div class="msg err" style="padding:16px">{error}</div> : null}
      <div class="review-body">
        <div class="review-files">
          {files?.map((f) => {
            const n = comments.filter((c) => c.file === f.path).length;
            return (
              <button key={f.path} type="button" class={`rf ${f.path === selected ? "selected" : ""}`} onClick={() => setSelected(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                <span class={`fs ${f.status}`}>{{ added: "A", modified: "M", deleted: "D", renamed: "R" }[f.status]}</span>
                <span class="fp">{f.path}</span>
                {n ? <span class="count">{n}</span> : null}
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
        <div class="review-diff">
          {file ? (
            <FileDiff
              key={file.path}
              file={file}
              comments={comments.filter((c) => c.file === file.path)}
              onAdd={(c) => setComments([...comments, c])}
              onRemove={(c) => setComments(comments.filter((x) => x !== c))}
            />
          ) : files ? null : (
            <div class="tree-empty">Loading diff…</div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileDiff({ file, comments, onAdd, onRemove }: { file: DiffFile; comments: Comment[]; onAdd: (c: Comment) => void; onRemove: (c: Comment) => void }) {
  const rows = useMemo(() => parsePatch(file.patch), [file.patch]);
  const [editing, setEditing] = useState<{ side: "old" | "new"; line: number; code: string } | null>(null);
  const [text, setText] = useState("");
  if (file.binary) return <div class="tree-empty">Binary file — no text diff.</div>;
  const at = (side: "old" | "new", line?: number) => comments.filter((c) => c.side === side && c.line === line);
  return (
    <div>
      <div class="diff-file-head">
        {file.oldPath ? `${file.oldPath} → ` : ""}
        {file.path}
        {file.truncated ? <span class="help"> · diff truncated</span> : null}
      </div>
      <table class="diff">
        <tbody>
          {rows.map((row, i) => {
            const side: "old" | "new" = row.type === "del" ? "old" : "new";
            const line = side === "old" ? row.old : row.new;
            const commentable = row.type === "add" || row.type === "del" || row.type === "ctx";
            const here = commentable ? at(side, line) : [];
            const isEditing = editing && commentable && editing.side === side && editing.line === line;
            return [
              <tr
                key={`r${i}`}
                class={`dl ${row.type}`}
                onClick={() => {
                  if (!commentable || line === undefined) return;
                  setEditing({ side, line, code: row.text });
                  setText("");
                }}
                title={commentable ? "Click to comment on this line" : undefined}
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
                        class="field"
                        rows={3}
                        autoFocus
                        placeholder="What should change here?"
                        value={text}
                        onInput={(e) => setText(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
                            onAdd({ file: file.path, side, line: line!, code: row.text, text });
                            setEditing(null);
                          }
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                      <div class="row">
                        <button class="btn small" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                        <button
                          class="btn small primary"
                          disabled={!text.trim()}
                          onClick={() => {
                            onAdd({ file: file.path, side, line: line!, code: row.text, text });
                            setEditing(null);
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
