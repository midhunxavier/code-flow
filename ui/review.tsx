import { ChangeImpact } from "./change-impact.js";
import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { IntegrityNote, RunEvidence, VerificationEvidence } from "./run-evidence.js";
import { ReviewCoveragePanel } from "./review-coverage.js";
import { chatProvider, integrityFor, resultAgent } from "./run-experience.js";
import { useRunStream } from "./run-feed.js";
import { AgentPicker, ArtifactCard } from "./run.js";
import { api, enc, post, showToast, showError, store } from "./lib.js";
import { route, runs } from "./state.js";
import { publishReviewIntent } from "./publish-review-intent.js";
import type { AgentId, DiffFile, Run } from "./types.js";

export interface Comment {
  file: string;
  side: "old" | "new";
  line: number;
  code: string;
  text: string;
}

export interface Row {
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
  const [publishOnArrival] = useState(() => publishReviewIntent.value?.runId === id && publishReviewIntent.value.branch === branch);
  const [publishOpen, setPublishOpen] = useState(publishOnArrival);
  useEffect(() => { if (publishOnArrival) publishReviewIntent.value = null; }, []);
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
  const [workingChanges, setWorkingChanges] = useState<boolean | null>(null);
  const feedback = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setGeneral(store.get(`${draftKey}:general`) ?? ""), [draftKey]);

  useEffect(() => {
    let current = true;
    setError("");
    setWorkingChanges(null);
    api<{ workingChanges?: boolean }>(`/api/runs/${id}/review-coverage?branch=${enc(branch)}`).then(value => { if (current) setWorkingChanges(!!value.workingChanges); }, e => { if (current) setRunError(e.message); });
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
  // An Agent chat's comments go to its provider, which the summary names. Otherwise default to the
  // agent that last wrote code in this worktree, once the run's steps say who; until then nobody is
  // shown as chosen.
  const provider = chatProvider(summary ?? run);
  const defaultAgent = useMemo(() => lastWriter(run, worktree?.name), [run, worktree?.name]);
  const recipient = provider ?? agent ?? defaultAgent;
  const file = files?.find((f) => f.path === selected);
  const totals = files?.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const merged = files?.filter((f) => f.mergedFrom) ?? [];
  const canSend = summary?.status === "done" && !summary.projectTeam && !!worktree && !!recipient && (comments.length > 0 || general.trim().length > 0);
  // Drafts on a file the branch no longer changes have no diff to show them in.
  const gone = files ? comments.filter((c) => !files.some((f) => f.path === c.file)) : [];

  const send = async () => {
    if (!worktree || !canSend || sending) return;
    setSending(true);
    const message = commentsMessage(comments, general, files ?? undefined);
    try {
      await post(`/api/runs/${id}/followups`, { kind: "comments", worktree: worktree.name, agent: recipient, message });
      changeCommentDrafts(draftKey, () => []);
      store.set(`${draftKey}:general`, "");
      setGeneral("");
      showToast("Sent — the agent is working on your comments");
      route.value = { view: "run", id };
    } catch (err) {
      showError((err as Error).message, 5000);
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
              {merged.length ? ` · ${merged.length} from ${merged[0]!.mergedFrom}` : ""}
            </span>
          ) : null}
        </div>
        <button class="btn small" onClick={() => feedback.current?.focus()}>Add feedback</button>
      </div>
      {summary ? <div class="review-overview">
        <RunEvidence run={summary} branch={branch} />
        {integrityFor(summary, branch).length ? <IntegrityNote issues={integrityFor(summary, branch)} /> : null}
        <div class="review-option-row"><VerificationEvidence run={summary} />
        <details class="review-tools"><summary>Review tools</summary>
          <ReviewCoveragePanel runId={id} branch={branch} refreshKey={`${refresh}:${summary?.status}:${summary?.lastCheck?.at}`} onOpen={setSelected} />
          {worktree && files?.length ? <ChangeImpact folder={worktree.path} paths={files.map(file => file.path)} refreshKey={`${refresh}:${summary?.status}:${summary?.lastCheck?.at}`} /> : null}
        </details>
        {!summary.testRun && summary.artifacts.find(a => a.branch === branch) ? <details class="review-delivery" open={publishOpen} onToggle={event => setPublishOpen(event.currentTarget.open)}><summary>Publish changes</summary>{workingChanges === false ? <><p class="help">Review the diff and evidence before publishing. Merge… merges into the branch you pick as soon as you click Merge, without asking again{summary.loop.check || summary.loop.verification ? " (tick Require verification there to test the merged result first)" : ""}. Merging a pull request asks you to confirm.</p><ArtifactCard key={branch} run={summary} artifact={summary.artifacts.find(a => a.branch === branch)!} steps={[...data.current.steps.values()]} reviewing initialPanel={publishOnArrival ? "pr" : undefined} /></> : <p class="help">{workingChanges ? "Ask the agent in chat to commit these changes before publishing. Your working files are shown below." : "Checking the workspace…"}</p>}</details> : null}
        <button class="btn small review-refresh" onClick={() => setRefresh(value => value + 1)}>Refresh changes</button></div>
      </div> : null}
      {error ? <div class="msg err review-msg">{error}</div> : null}
      {runError ? <div class="msg warn review-msg">{runError}</div> : null}
      {gone.length ? (
        <div class="msg warn review-msg">
          {gone.length === 1 ? "1 comment is" : `${gone.length} comments are`} on {[...new Set(gone.map((c) => c.file))].join(", ")}, which this branch no longer changes. {gone.length === 1 ? "It's" : "They're"} still sent, with the line {gone.length === 1 ? "it was" : "they were"} on.{" "}
          <button class="btn ghost small" onClick={() => changeCommentDrafts(draftKey, (now) => now.filter((c) => files!.some((f) => f.path === c.file)))}>Discard {gone.length === 1 ? "it" : "them"}</button>
        </div>
      ) : null}
      {summary?.outcome?.decision === "needs-work" && summary.outcome.branch === branch ? <p class="help review-msg">Describe what needs to change in the overall comment or on individual lines, then send your comments to start a revision on this branch.</p> : null}
      <div class="review-body">
        <div class="review-files">
          <div class="review-files-heading">{workingChanges ? "Working changes" : "Changed files"} <span>{files?.length ?? "…"}</span></div>
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
                <MergedBadge file={f} />
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
          <MergedNote files={files ?? []} />

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
      <div class="review-feedback" aria-label="Review feedback">
        <label class="lbl" for="general">Overall comment</label>
        <textarea ref={feedback} id="general" class="field" rows={2} disabled={sending}
          placeholder="Tell the agent what to change…" value={general}
          onInput={e => { setGeneral(e.currentTarget.value); store.set(`${draftKey}:general`, e.currentTarget.value); }} />
        <div class="review-feedback-actions">
          <p class="help">Send feedback to start an agent revision and rerun configured checks. Click a diff line to add a specific comment.</p>
        <div class="review-send">
          {summary?.projectTeam ? (
            <a class="btn" href={`#/project/${summary.project}/automation/missions`}>Use mission revision controls</a>
          ) : summary?.status === "done" ? (
            <>
              <span class="review-to">Send to</span>
              <AgentPicker value={recipient} fixed={!!provider} placeholder={run || runError ? "Choose an agent…" : "Loading recipient…"} onChange={setAgent} />
              <button class="btn primary" disabled={!canSend || sending} title={recipient ? undefined : "Choose who gets these comments"} onClick={send}>
                {sending ? "Sending…" : `Send ${comments.length + (general.trim() ? 1 : 0) || ""} comment${comments.length + (general.trim() ? 1 : 0) === 1 ? "" : "s"}`.replace("  ", " ")}
              </button>
            </>
          ) : (
            <span class="review-to">Comments can be sent once the run has finished.</span>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Said under a file list when some of its files came in from the branch a conflict resolution
 * merged: they aren't the run's work, but merging the result can bring them along. Under it, so
 * the files come first where the list is short (a phone).
 */
export function MergedNote({ files }: { files: DiffFile[] }) {
  const merged = files.filter((f) => f.mergedFrom);
  if (!merged.length) return null;
  const from = merged[0]!.mergedFrom!;
  const one = merged.length === 1;
  return <p class="help merged-note">{one ? "The file" : "Files"} marked “merged in” came from <code>{from}</code> when its conflicts were resolved. {one ? "It isn't this run's change" : "They aren't this run's changes"}, but merging into a branch without {from}'s changes brings {one ? "it" : "them"} along.</p>;
}

/** A file's "merged in" label, when it came in from the branch a conflict resolution merged. */
export function MergedBadge({ file }: { file: DiffFile }) {
  return file.mergedFrom ? <span class="merged-from" title={`From ${file.mergedFrom}, merged in to resolve conflicts: not this run's change`}>merged in</span> : null;
}

/** Default feedback recipient, including the lead for a combined team result. */
export const lastWriter = (run: Run | null, worktree?: string): AgentId | undefined => resultAgent(run, worktree);

/**
 * Line comments (and an overall one) as the follow-up message the agent gets. Given the diff as it
 * is now (`files`, which can list a file once per view of it), each names the line its code is on
 * now, or says its code has changed since.
 */
export function commentsMessage(comments: Comment[], general = "", files?: DiffFile[]): string {
  const parsed = new Map<string, Row[]>();
  const lines = comments.map((c, i) => {
    let where = `${c.file}:${c.line}`;
    if (files) {
      if (!parsed.has(c.file)) parsed.set(c.file, files.filter((f) => f.path === c.file).flatMap((f) => parsePatch(f.patch)));
      const rows = parsed.get(c.file)!;
      const row = rows[placeOf(rows, c)];
      const line = c.side === "old" ? row?.old : row?.new;
      where = line === undefined ? `${c.file} (was line ${c.line}; that code has changed or is no longer in the diff)` : `${c.file}:${line}`;
    }
    return `${i + 1}. ${where}${c.side === "old" ? " (a removed line)" : ""} — \`${c.code.trim().slice(0, 140)}\`\n   ${c.text.trim()}`;
  });
  return [lines.join("\n"), general.trim() ? `General: ${general.trim()}` : ""].filter(Boolean).join("\n\n");
}

/**
 * The row a draft belongs on in the diff as it is now: its own line while that line still has the
 * code it was written on, else the nearest line on its side with that code (the branch moved, and
 * the code with it). -1 when its code isn't in the diff: a draft is never put on whatever line
 * took its number.
 */
function placeOf(rows: Row[], c: Comment): number {
  let best = -1;
  let distance = Infinity;
  rows.forEach((row, i) => {
    const line = c.side === "old" ? (row.type === "del" ? row.old : undefined) : row.type === "add" || row.type === "ctx" ? row.new : undefined;
    if (line === undefined || row.text !== c.code || Math.abs(line - c.line) >= distance) return;
    best = i;
    distance = Math.abs(line - c.line);
  });
  return best;
}

/** A file's drafts by the row they go under, and those whose code isn't in this diff. */
export function placeComments(rows: Row[], comments: Comment[]): { at: Map<number, Comment[]>; elsewhere: Comment[] } {
  const at = new Map<number, Comment[]>();
  const elsewhere: Comment[] = [];
  for (const c of comments) {
    const i = placeOf(rows, c);
    if (i < 0) elsewhere.push(c);
    else at.set(i, [...(at.get(i) ?? []), c]);
  }
  return { at, elsewhere };
}

/** What a diff says in place of lines when it has none to show: a rename, an empty file, a mode change. */
export function diffNote(file: DiffFile, rows: Row[]): string | undefined {
  if (file.binary) return "Binary file — no text diff.";
  if (rows.length) return undefined;
  if (!file.patch.trim() && (file.additions || file.deletions)) return "No text diff available for this file.";
  const mode = /^old mode (\d+)\nnew mode (\d+)$/m.exec(file.patch);
  const modeChange = mode ? `its mode changed from ${mode[1]} to ${mode[2]}` : "";
  if (file.status === "renamed") return `Renamed from ${file.oldPath} with no content changes${mode ? `; ${modeChange}` : ""}.`;
  if (file.status === "added") return "Empty file added.";
  if (file.status === "deleted") return "Empty file deleted.";
  return mode ? `No content changes; ${modeChange}.` : "No content changes.";
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
  const note = diffNote(file, rows);
  // Drafts follow their code when the branch moves; one whose code is gone is listed above the diff.
  const placed = placeComments(rows, comments);
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
      {placed.elsewhere.length ? (
        <div class="comments-elsewhere" role="group" aria-label="Comments on code not in this diff">
          <p class="help">{placed.elsewhere.length === 1 ? "This comment's code isn't" : "These comments' code isn't"} in this diff: it has changed since, or isn't shown here.</p>
          {placed.elsewhere.map((c, j) => (
            <div key={`x${j}`} class="comment">
              <span>
                <span class="comment-was">
                  Line {c.line}
                  {c.side === "old" ? " (removed)" : ""}: <code>{c.code.trim().slice(0, 140)}</code>
                </span>
                {"\n"}
                {c.text}
              </span>
              <button class="btn ghost small" onClick={() => onRemove(c)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {note ? <div class="tree-empty">{note}</div> : null}
      <table class="diff" hidden={!!note}>
        <tbody ref={body}>
          {rows.map((row, i) => {
            const side: "old" | "new" = row.type === "del" ? "old" : "new";
            const line = side === "old" ? row.old : row.new;
            const commentable = isLine(row);
            const here = placed.at.get(i) ?? [];
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
export function parsePatch(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    // A file that changes type is a deletion and then a creation, each with its own header.
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
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
