// The Archive dialog (a run's More run actions, a conversation's sidebar menu): loaded when it opens.
import { useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { post, showToast, showError } from "./lib.js";
import type { RunSummary } from "./types.js";

/** What POST /api/runs/:id/archive did. */
export interface ArchiveResult { archived: boolean; removed?: string[]; deletedBranches?: string[]; failed?: string[]; retained?: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The toast after an archive that removed everything it was asked to. */
export function archivedMessage(result: ArchiveResult, cleanup: boolean): string {
  if (!cleanup) return "Archived · worktrees and branches kept";
  if (result.retained) return `Archived · ${result.retained.toLowerCase()}`;
  const removed = result.removed?.length ?? 0, deleted = result.deletedBranches?.length ?? 0;
  if (!removed && !deleted) return "Archived";
  return `Archived · removed ${plural(removed, "worktree")}${deleted ? ` and ${plural(deleted, "branch", "branches")}` : "; branches kept"}`;
}

/**
 * Archive a run and, optionally, remove its worktrees and branches. With `members` (an Agent
 * conversation's tabs, side chats and team runs), the whole task is archived and the workspace
 * they share is cleaned up. What couldn't be removed is shown, with why, before it closes.
 */
export function ArchiveDialog({ run, members, onClose }: { run: RunSummary; members?: RunSummary[]; onClose: () => void }) {
  const [cleanup, setCleanup] = useState(true);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[] | null>(null);
  const ref = useDialog(true, onClose);
  const task = !!members;
  // A linked chat lists the workspace it shares: count each worktree once, from its owner.
  const trees = [...new Map((members ?? [run]).filter((member) => !task || !member.chatLink).flatMap((member) => member.worktrees ?? []).map((tree) => [tree.path, tree])).values()];
  // Branches only go with their worktrees; the box reads as not applicable otherwise.
  const willDeleteBranches = cleanup && deleteBranches;
  const merged = (members ?? [run]).some((member) => member.merges?.length);
  const archive = async () => {
    setBusy(true);
    try {
      const result = await post<ArchiveResult>(`/api/runs/${run.id}/archive`, { cleanup, deleteBranches: willDeleteBranches, ...(task ? { task: true } : {}) });
      if (result.failed?.length) { setFailed(result.failed); return; }
      showToast(archivedMessage(result, cleanup), 4000);
      onClose();
    } catch (error) {
      showError((error as Error).message, 5000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog class="picker small-dialog" ref={ref} aria-labelledby="archive-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="archive-title">{task ? "Archive this conversation" : "Archive this run"}</h3>
        </div>
        <div class="dialog-body">
          {failed ? <>
            <p class="msg err" role="alert">Archived, but {failed.length === 1 ? "this couldn't be removed" : `these ${failed.length} couldn't be removed`}:{"\n"}{failed.join("\n")}</p>
            <p class="help">It's left as it was. The run's Activity log has the details.</p>
          </> : <>
            {task ? <p class="help">Archives the conversation with its agent tabs and side chats.</p> : null}
            <label class="check">
              <input type="checkbox" checked={cleanup} disabled={busy} onChange={(e) => { setCleanup(e.currentTarget.checked); if (!e.currentTarget.checked) setDeleteBranches(false); }} /> Remove its {plural(trees.length, "worktree")} (uncommitted changes in {trees.length === 1 ? "it" : "them"} are lost)
            </label>
            <label class="check">
              <input type="checkbox" checked={willDeleteBranches} disabled={busy || !cleanup} onChange={(e) => setDeleteBranches(e.currentTarget.checked)} /> Also delete its branches
              {!cleanup ? " (only with its worktrees)" : merged ? "" : ` (nothing from this ${task ? "conversation" : "run"} has been merged yet)`}
            </label>
            <div class="help">Kept branches can be resumed or merged later; Resume re-attaches them.</div>
          </>}
        </div>
        <div class="picker-foot">
          <span class="ps" />
          {failed ? <button class="btn primary" onClick={onClose}>Close</button> : <>
            <button class="btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button class="btn primary" disabled={busy} onClick={() => void archive()}>
              {busy ? "Archiving…" : "Archive"}
            </button>
          </>}
        </div>
      </div>
    </dialog>
  );
}
