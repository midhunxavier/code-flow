import { useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { api, ApiError, showToast } from "./lib.js";
import { forgetRun } from "./state.js";
import type { RunSummary } from "./types.js";

async function deleteRun(id: string) {
  const path = `/api/runs/${encodeURIComponent(id)}`;
  try { await api(path, { method: "DELETE" }); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    // A missing DELETE route is different from an already deleted run.
    try { await api(path); }
    catch (readError) {
      if (readError instanceof ApiError && readError.status === 404) { forgetRun(id); return; }
      throw readError;
    }
    throw new Error("This server hasn't loaded the delete update yet. Restart Code Flow, then refresh this page and try again.");
  }
  forgetRun(id);
}

export function DeleteRunDialog({ run, onClose }: { run: RunSummary; onClose: () => void }) {
  return <DeleteRunsDialog runs={[run]} onClose={onClose} />;
}

export function DeleteRunsDialog({ runs, onClose, onDeleted }: { runs: RunSummary[]; onClose: () => void; onDeleted?: (id: string) => void }) {
  const [pending, setPending] = useState(runs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(true, () => { if (!busy) onClose(); });
  const single = runs.length === 1;
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="delete-run-title">
    <div class="picker-inner">
      <div class="picker-head"><h3 id="delete-run-title">{single ? "Delete this run?" : `Delete ${pending.length} ${pending.length === 1 ? "run" : "runs"}?`}</h3></div>
      <div class="dialog-body">
        {single ? <p class="delete-run-name">{pending[0]?.task.split("\n")[0]}</p> : <ul class="delete-run-list">{pending.map(run => <li key={run.id}>{run.task.split("\n")[0] || "Untitled run"}</li>)}</ul>}
        <p>This permanently deletes {single ? "the conversation and run history" : "these conversations and their run history"}. It cannot be undone.</p>
        <p class="help">Git branches, worktrees and repository files are kept. Archive instead if you want to keep {single ? "the conversation" : "the conversations"}.</p>
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
