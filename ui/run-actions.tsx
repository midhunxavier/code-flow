import { runTitle } from "../src/run-title.js";
import { useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { lazyView } from "./lazy-view.js";
import { api, ApiError, showToast } from "./lib.js";
import { beginRunDeletion, forgetRun } from "./state.js";
import type { RunSummary } from "./types.js";

/** Archive a run, or a whole Agent conversation, removing its worktrees if asked (see ui/archive-dialog.tsx). */
export const ArchiveDialog = lazyView(() => import("./archive-dialog.js").then((module) => module.ArchiveDialog));

async function deleteRun(id: string) {
  const finished = beginRunDeletion(id);
  try { await deleteRunRecord(id); } finally { finished(); }
}
async function deleteRunRecord(id: string) {
  const path = `/api/runs/${encodeURIComponent(id)}`;
  try { await api(path, { method: "DELETE" }); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    // A missing DELETE route is different from an already deleted run.
    try { await api(path); }
    catch (readError) {
      if (readError instanceof ApiError && readError.status === 404) { forgetRun(id, true); return; }
      throw readError;
    }
    throw new Error("This server hasn't loaded the delete update yet. Restart Code Flow, then refresh this page and try again.");
  }
  forgetRun(id, true);
}

export function DeleteRunDialog({ run, onClose }: { run: RunSummary; onClose: () => void }) {
  return <DeleteRunsDialog runs={[run]} onClose={onClose} />;
}

export function DeleteRunsDialog({ runs, onClose, onDeleted }: { runs: RunSummary[]; onClose: () => void; onDeleted?: (id: string) => void }) {
  const [pending, setPending] = useState(runs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose, () => !busy);
  const single = runs.length === 1;
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="delete-run-title">
    <div class="picker-inner">
      <div class="picker-head"><h3 id="delete-run-title">{single ? "Delete this run?" : `Delete ${pending.length} ${pending.length === 1 ? "run" : "runs"}?`}</h3></div>
      <div class="dialog-body">
        {single ? <p class="delete-run-name">{pending[0] ? runTitle(pending[0]) : ""}</p> : <ul class="delete-run-list">{pending.map(run => <li key={run.id}>{runTitle(run)}</li>)}</ul>}
        <p>This permanently deletes {single ? "the conversation and run history" : "these conversations and their run history"}. It cannot be undone.</p>
        {runs.some(run => run.projectTeam) ? <p class="help">The mission's saved records and budget accounting are kept.</p> : null}
        <p class="help">Git branches, worktrees and repository files are kept. Archive instead if you want to keep {single ? "the conversation" : "the conversations"}; <b>Archive and clean up…</b> in its sidebar menu also removes its worktrees.</p>
        {error ? <div class="err" role="alert">{error}</div> : null}
      </div>
      <div class="picker-foot"><span class="ps" /><button class="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button class="btn danger" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          const failed: RunSummary[] = [];
          const errors: string[] = [];
          for (const run of pending) {
            try { await deleteRun(run.id); onDeleted?.(run.id); }
            catch (e) { failed.push(run); errors.push(`${single ? "" : `${run.task.split("\n")[0]}: `}${(e as Error).message}`); }
          }
          const count = pending.length - failed.length;
          if (count) showToast(count === 1 ? "Run deleted" : `${count} runs deleted`);
          if (!failed.length) { onClose(); return; }
          setPending(failed); setError(errors.join("\n")); setBusy(false);
        }}>{busy ? "Deleting…" : single ? "Delete run" : `Delete ${pending.length} ${pending.length === 1 ? "run" : "runs"}`}</button>
      </div>
    </div>
  </dialog>;
}
