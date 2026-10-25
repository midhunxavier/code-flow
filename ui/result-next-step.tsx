import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { MergeMethod } from "../src/github.js";
import type { ResultDelivery } from "../src/result-delivery.js";
import type { RunSummary } from "./types.js";
import { api, enc, post, safeHref, showToast, usePoll } from "./lib.js";
import { confirmAction } from "./confirm-state.js";
import { navigate } from "./state.js";

/** The conversation stays central; publishing has one current, explicit next action. */
export function ResultNextStep({ run, branch, children }: { run: RunSummary; branch: string; children: ComponentChildren }) {
  const [delivery, setDelivery] = useState<ResultDelivery>(), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [method, setMethod] = useState<MergeMethod>();
  const linked = !!run.prs[branch] || run.source?.kind === "pr";
  const endpoint = `/api/runs/${run.id}/delivery?branch=${enc(branch)}`;
  useEffect(() => { setDelivery(undefined); setError(""); setNotice(""); setMethod(undefined); }, [run.id, branch, run.testRun?.reason]);
  const refresh = async (current = () => true) => {
    try { const value = await api<ResultDelivery>(endpoint); if (current()) { setDelivery(value); setError(""); } }
    catch (e) { if (current()) setError((e as Error).message); }
  };
  usePoll(current => linked && !run.testRun && !run.archived ? refresh(current) : Promise.resolve(), 15000, [run.id, branch, run.endedAt, run.testRun?.reason]);
  const test: ResultDelivery | undefined = run.testRun ? { kind: "test", title: "Test complete — archive this run", detail: run.testRun.reason, action: "archive", label: "Archive test run" } : undefined;
  const next = test ?? delivery;
  if (!linked && !test) return <>{children}</>;
  const pr = next?.pr;
  const how = method && pr?.methods.includes(method) ? method : pr?.methods.includes("squash") ? "squash" : pr?.methods[0];
  const act = async () => {
    if (!next || busy || error) return;
    if (next.action === "review") { navigate({ view: "review", id: run.id, branch }); return; }
    if (next.action === "merge" && (!pr || !how || !await confirmAction(
      `${how === "squash" ? "Squash and merge" : how === "rebase" ? "Rebase and merge" : "Merge"} PR #${pr.number} into ${pr.baseRefName} on GitHub?${next.changedSinceRun ? " The branch has changed since this run; its current GitHub checks passed. Review the updated PR before confirming." : ""} Branches and run history will be kept.`,
      { title: "Merge pull request?", confirmLabel: "Merge pull request", danger: true },
    ))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (next.action === "archive") {
        await post(`/api/runs/${run.id}/archive`, { cleanup: false, deleteBranches: false });
        showToast("Archived. Conversation, branches and files are kept.");
      } else {
        const response = await post<{ merged?: boolean }>(`/api/runs/${run.id}/delivery`, { branch, action: next.action, expectedHead: pr!.headRefOid, method: how });
        setNotice(next.action === "update" ? "Update requested. GitHub will run checks on the new commit." : response.merged ? "Merged on GitHub. You can archive this run." : "Merge requested. Waiting for GitHub to confirm completion.");
        await refresh();
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div class="result-next-step">
    <div class="result-primary"><div>
      <span class="result-eyebrow">{test ? "Test run" : "Pull request"}</span>
      <h3>{next?.title ?? (error ? "Couldn’t check the pull request" : "Checking pull request status…")}</h3>
      <p class="result-next-detail">{next?.detail ?? "Getting the current checks and merge status from GitHub."}</p>
    </div>
      <div class="experience-actions">
        {next && next.action !== "github" ? <button class="btn primary" disabled={busy || !!error || next.action === "wait"} onClick={act}>{busy ? next.action === "update" ? "Updating…" : next.action === "merge" ? "Merging…" : "Archiving…" : next.label}</button> : null}
        {pr ? <a class={`btn${next?.action === "github" ? " primary" : ""}`} href={safeHref(pr.url)} target="_blank" rel="noreferrer">{next?.action === "github" ? next.label : "View pull request"}</a> : null}
      </div>
    </div>
    {test ? <p class="help result-status-note">Nothing to publish. Archiving keeps the conversation and working files.</p> : <>
      {next?.changedSinceRun ? <p class="help result-status-note">PR updated since this run. Status below is from GitHub for the current commit; the run’s earlier approval does not cover the update.</p> : null}
      {pr ? <p class="help result-status-note">GitHub checks: {({ pass: "Passed", fail: "Failed", pending: "Running", none: "Not reported" })[pr.ci]} · <code>{pr.headRefOid.slice(0, 7)}</code> <button class="link" disabled={busy} onClick={() => void refresh()}>Refresh status</button></p> : null}
      {next?.action === "merge" && pr && pr.methods.length > 1 ? <details class="result-merge-options"><summary>Merge options</summary><label>Merge method<select class="field" value={how} onChange={e => setMethod(e.currentTarget.value as MergeMethod)}>{pr.methods.map(value => <option key={value} value={value}>{value === "squash" ? "Squash and merge" : value === "rebase" ? "Rebase and merge" : "Create a merge commit"}</option>)}</select></label></details> : null}
    </>}
    {notice ? <p class="help" role="status">{notice}</p> : null}
    {error ? <p class="msg err" role="alert">{error} <button class="link" disabled={busy} onClick={() => void refresh()}>Retry status</button></p> : null}
  </div>;
}
