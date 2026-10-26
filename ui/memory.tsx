import { completeSentence } from "./lib.js";
import { useEffect, useState } from "preact/hooks";
import { Markdown } from "./bits.js";
import { api, ApiError, post, showToast } from "./lib.js";
import type { MemoryEntry } from "../src/memory.js";
import { memoryDraft, mergeMemoryDraft, resolveMemoryMerge, type MemoryDraft, type MemoryDraftField } from "./memory-merge.js";
import { MemoryAnalysisPanel, MemoryDeleteImpact } from "./memory-analysis.js";
import { MemoryGraph } from "./memory-graph.js";

/** Knowledge remains inspectable and editable at the scope where later runs read it. */
export function ProjectMemory({ projectId, repo, refreshKey = "" }: { projectId: string; repo: string; refreshKey?: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/memory`;
  const load = async () => {
    setLoading(true);
    setError("");
    try { setEntries(await api<MemoryEntry[]>(`${endpoint}?repo=${encodeURIComponent(repo)}`)); }
    catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError("");
    api<MemoryEntry[]>(`${endpoint}?repo=${encodeURIComponent(repo)}`).then(
      (result) => { if (current) setEntries(result); },
      (err: Error) => { if (current) setError(err.message); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, projectId, repo, refreshKey]);
  const visible = (entries ?? []).filter((entry) => entry.status !== "deleted");
  const proposals = visible.filter((entry) => entry.status === "proposed").length;
  return <details class="project-memory" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Project memory{entries ? ` · ${visible.length} ${visible.length === 1 ? "entry" : "entries"}${proposals ? ` · ${proposals} to review` : ""}` : ""}</summary>
    <p class="help">Accepted knowledge can be used in future runs in this repository. Proposals need review before they become project guidance.</p>
    <p class="help">Deleting erases this entry's text and removes it from future retrieval. Entries written with it in context retain their own text and the source reference; review and delete those separately. Source run transcripts remain under normal run retention.</p>
    <div class="at-row"><button class="btn small" disabled={loading} onClick={load}>{loading ? "Loading…" : "Refresh"}</button><button class="btn small" onClick={() => setCreating(!creating)}>{creating ? "Cancel new entry" : "Add project knowledge"}</button></div>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {creating ? <MemoryEditor endpoint={endpoint} repo={repo} onSaved={async () => { setCreating(false); await load(); }} onCancel={() => setCreating(false)} /> : null}
    {entries && !visible.length ? <p class="help">No project knowledge saved for this repository yet.</p> : null}
    {entries ? <MemoryAnalysisPanel endpoint={endpoint} repo={repo} entries={entries} refreshKey={refreshKey} onPublished={load} /> : null}
    {entries ? <MemoryGraph endpoint={endpoint} repo={repo} entries={entries} /> : null}
    <div class="memory-list">{visible.map((entry) => <MemoryCard key={entry.id} entry={entry} endpoint={endpoint} onChanged={load} />)}</div>
  </details>;
}

function MemoryCard({ entry, endpoint, onChanged }: { entry: MemoryEntry; endpoint: string; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [impactReady, setImpactReady] = useState(false);
  const change = async (op: "approve" | "delete") => {
    setBusy(true);
    setError("");
    try { await post(`${endpoint}/commands`, { op, id: entry.id, expectedRevision: entry.revision }); await onChanged(); if (op === "delete") showToast("Memory removed. Entries written with it in context keep their text and its provenance; run transcripts are retained.", 5000); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const sensitiveOrigin = entry.origins.some((origin) => origin.lockedDown || origin.trust !== "trusted");
  return <article class="memory-card" id={`memory-${entry.id}`} tabIndex={-1}>
    <div class="at-row"><b>{entry.title}</b><span class={`badge ${entry.status === "accepted" ? "ok" : "warn"}`}>{entry.status === "accepted" ? "Accepted" : "Proposal"}</span></div>
    <div class="help">Revision {entry.revision} · {entry.applicability.kind === "branch" ? `Branch ${entry.applicability.branch}${entry.applicability.commit ? ` at ${entry.applicability.commit.slice(0, 12)}` : ""}` : "This repository"}{entry.acceptedBy ? ` · accepted by ${entry.acceptedBy === "user" ? "you" : entry.acceptedBy}` : ""}</div>
    {editing ? <MemoryEditor entry={entry} endpoint={endpoint} repo={entry.repo} onSaved={async () => { setEditing(false); await onChanged(); }} onCancel={() => setEditing(false)} /> : <Markdown text={entry.body} />}
    {entry.paths.length ? <p class="help">Applies to: {entry.paths.join(", ")}</p> : null}
    {entry.tags.length ? <p class="help">Tags: {entry.tags.join(", ")}</p> : null}
    <details><summary>Origin and evidence</summary>
      {sensitiveOrigin ? <p class="at-notice">Includes material from an untrusted or unknown source. Review the content before accepting it as future guidance.</p> : null}
      <ul>{entry.origins.map((origin, i) => <li key={i}>{origin.kind === "user" ? "User-authored" : origin.kind === "run" ? "From a run" : "Imported"} · {origin.trust}{origin.lockedDown ? " · locked down" : ""}{origin.private ? " · private origin" : ""}{origin.runId ? <> · <a href={`#/run/${encodeURIComponent(origin.runId)}`}>View source run</a></> : null}{origin.memberId ? ` · ${origin.memberId}` : ""}</li>)}</ul>
      {entry.sourceRefs.length ? <p class="help">Sources: {entry.sourceRefs.join(", ")}</p> : null}
      {entry.derivedFrom.length ? <p class="help">Derived from: {entry.derivedFrom.map((ref) => `${ref.id} (revision ${ref.revision})`).join(", ")}</p> : null}
      {entry.verification ? <p class="help">{entry.verification.passed ? "Verification passed" : "Verification incomplete"} at <code>{entry.verification.commit.slice(0, 12)}</code>{entry.verification.merged ? " · merged" : " · branch evidence"}. {entry.verification.evidenceRefs.join(", ")}</p> : null}
    </details>
    {entry.status === "accepted" ? <MemoryFeedback projectId={entry.projectId!} endpoint={endpoint} id={entry.id} revision={entry.revision} onChanged={onChanged} /> : null}
    {entry.feedback?.filter((item) => item.revision === entry.revision).length ? <p class="help">Feedback on this revision: {entry.feedback.filter((item) => item.revision === entry.revision).map((item) => item.rating).join(", ")}. Stale or incorrect guidance is excluded until edited.</p> : null}
    <div class="memory-actions">
      {entry.status === "proposed" ? <button class="btn small primary" disabled={busy || editing} onClick={() => change("approve")}>{busy ? "Saving…" : "Accept for future runs"}</button> : null}
      {!editing ? <button class="btn small" disabled={busy} onClick={() => setEditing(true)}>Edit</button> : null}
      {confirmingDelete
        ? <div class="memory-confirm" role="group" aria-label="Confirm deletion"><span class="help">Delete this knowledge? Its text is erased; entries written with it in context keep theirs.</span><MemoryDeleteImpact endpoint={endpoint} repo={entry.repo} entryId={entry.id} onReady={() => setImpactReady(true)} /><button class="btn small danger" disabled={busy || !impactReady} onClick={() => { setConfirmingDelete(false); void change("delete"); }}>Delete</button><button class="btn small" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep</button></div>
        : <button class="btn small danger" disabled={busy || editing} onClick={() => { setImpactReady(false); setConfirmingDelete(true); }}>Delete…</button>}
    </div>
    {error ? <p class="msg err" role="alert">{error} Refresh to see the latest revision.</p> : null}
  </article>;
}

export function MemoryFeedback({ projectId, endpoint, id, revision, runId, onChanged }: { projectId: string; endpoint?: string; id: string; revision: number; runId?: string; onChanged?: () => Promise<void> }) {
  const [rating, setRating] = useState("useful");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const send = async () => {
    setBusy(true); setError(""); setResult("");
    try {
      await post(`${endpoint ?? `/api/projects/${encodeURIComponent(projectId)}/memory`}/commands`, { op: "feedback", id, expectedRevision: revision, runId, rating, note: note.trim() || undefined });
      setResult("Feedback saved for this revision."); await onChanged?.();
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  };
  return <details class="memory-feedback"><summary>Rate this knowledge</summary><label>Usefulness<select class="field" aria-label={`Memory usefulness ${id}`} value={rating} onChange={(event) => setRating(event.currentTarget.value)}><option value="useful">Useful</option><option value="irrelevant">Not relevant</option><option value="stale">Out of date</option><option value="incorrect">Incorrect</option></select></label><label>Reason (optional)<textarea class="field" aria-label={`Memory feedback ${id}`} rows={2} maxLength={1000} value={note} onInput={(event) => setNote(event.currentTarget.value)} /></label><button class="btn small" disabled={busy} onClick={send}>{busy ? "Saving…" : "Save memory feedback"}</button>{result ? <p class="help" role="status">{result}</p> : null}{error ? <p class="msg err" role="alert">{error}</p> : null}</details>;
}

function MemoryEditor({ entry, endpoint, repo, onSaved, onCancel }: { entry?: MemoryEntry; endpoint: string; repo: string; onSaved: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [paths, setPaths] = useState(entry?.paths.join("\n") ?? "");
  const [scope, setScope] = useState<"repository" | "branch">(entry?.applicability.kind ?? "repository");
  const [branch, setBranch] = useState(entry?.applicability.kind === "branch" ? entry.applicability.branch : "");
  const [commit, setCommit] = useState(entry?.applicability.kind === "branch" ? entry.applicability.commit ?? "" : "");
  // Keep the revision on which this draft is based even if a refreshed entry arrives.
  const [base, setBase] = useState(entry);
  const [revision, setRevision] = useState(entry?.revision);
  const [asNew, setAsNew] = useState(false);
  const [conflict, setConflict] = useState<{ latest: MemoryEntry | null } | null>(null);
  const [choices, setChoices] = useState<Partial<Record<MemoryDraftField, "draft" | "latest">>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draft: MemoryDraft = {
    title, body, paths: paths.split("\n").map((path) => path.trim()).filter(Boolean),
    applicability: scope === "repository" ? { kind: "repository" } : { kind: "branch", branch: branch.trim(), ...(commit.trim() ? { commit: commit.trim() } : {}) },
  };
  const merge = base && conflict?.latest ? mergeMemoryDraft(memoryDraft(base), draft, memoryDraft(conflict.latest)) : null;
  const fieldLabels: Record<MemoryDraftField, string> = { title: "title", body: "knowledge", paths: "relevant paths", applicability: "where this applies" };
  const refreshConflict = async () => {
    const latest = await api<MemoryEntry[]>(`${endpoint}?repo=${encodeURIComponent(repo)}`);
    setConflict({ latest: latest.find((candidate) => candidate.id === entry?.id) ?? null });
    setChoices({});
  };
  const applyMerge = () => {
    if (!base || !conflict?.latest) return;
    const next = resolveMemoryMerge(memoryDraft(base), draft, memoryDraft(conflict.latest), choices);
    setTitle(next.title); setBody(next.body); setPaths(next.paths.join("\n"));
    setScope(next.applicability.kind);
    setBranch(next.applicability.kind === "branch" ? next.applicability.branch : "");
    setCommit(next.applicability.kind === "branch" ? next.applicability.commit ?? "" : "");
    setBase(conflict.latest); setRevision(conflict.latest.revision); setConflict(null); setError("");
    showToast("Changes merged into your draft. Review it, then save.");
  };
  const save = async () => {
    if (!title.trim() || !body.trim() || (scope === "branch" && !branch.trim()) || busy || conflict) return;
    setBusy(true);
    setError("");
    try { await post(`${endpoint}/commands`, { op: entry && !asNew ? "update" : "create", id: asNew ? undefined : entry?.id, expectedRevision: revision, repo, ...draft }); await onSaved(); }
    catch (err) {
      setError((err as Error).message);
      if (entry && !asNew && err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        try { await refreshConflict(); }
        catch (problem) { setError(`${(err as Error).message}. Couldn't load the latest revision: ${(problem as Error).message}`); }
      }
    }
    finally { setBusy(false); }
  };
  return <form class="memory-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label>Title<input class="field" aria-label="Memory title" maxLength={200} value={title} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
    <label>Knowledge<textarea class="field" aria-label="Memory knowledge" rows={4} maxLength={16000} value={body} onInput={(event) => setBody(event.currentTarget.value)} /></label>
    <label>Relevant paths, one per line<textarea class="field" aria-label="Memory paths" rows={2} placeholder="Leave empty for the whole repository" value={paths} onInput={(event) => setPaths(event.currentTarget.value)} /></label>
    <label>Where this applies<select class="field" aria-label="Where memory applies" value={scope} onChange={(event) => setScope(event.currentTarget.value as "repository" | "branch")}><option value="repository">Use across this repository</option><option value="branch">Only a specific branch</option></select></label>
    {scope === "branch" ? <><label>Branch<input class="field" aria-label="Memory branch" value={branch} onInput={(event) => setBranch(event.currentTarget.value)} /></label><label>Commit, if required<input class="field" aria-label="Memory commit" value={commit} onInput={(event) => setCommit(event.currentTarget.value)} placeholder="Optional commit that must be present" /></label></> : <p class="help">Saving makes this guidance eligible for future runs on any branch in this repository.</p>}
    {conflict ? <section class="at-notice" aria-label="Resolve memory revision conflict">
      <b>{conflict.latest ? `This entry is now at revision ${conflict.latest.revision}. Your draft is preserved.` : "This entry was removed in another session. Your draft is preserved."}</b>
      {conflict.latest ? <>
        <details><summary>Latest saved knowledge</summary><b>{conflict.latest.title}</b><Markdown text={conflict.latest.body} /><p class="help">Paths: {conflict.latest.paths.join(", ") || "whole repository"} · {conflict.latest.applicability.kind === "repository" ? "This repository" : `Branch ${conflict.latest.applicability.branch}${conflict.latest.applicability.commit ? ` at ${conflict.latest.applicability.commit}` : ""}`}</p></details>
        {merge?.conflicts.length ? <><p class="help">Both versions changed these fields. Choose each one to keep. Independent edits will be combined.</p>{merge.conflicts.map((field) => <label key={field}>Conflict: {fieldLabels[field]}<select class="field" aria-label={`Resolve memory ${fieldLabels[field]}`} value={choices[field] ?? ""} onChange={(event) => { const value = event.currentTarget.value as "draft" | "latest"; setChoices((previous) => ({ ...previous, [field]: value })); }}><option value="">Choose a version…</option><option value="draft">Keep my draft</option><option value="latest">Use latest saved version</option></select></label>)}</> : <p class="help">Your edits and the latest edits affect different fields and can be combined.</p>}
        <button type="button" class="btn small primary" disabled={busy || !!merge?.conflicts.some((field) => !choices[field])} onClick={applyMerge}>Apply reviewed merge</button>
      </> : <><p class="help">You can keep editing this draft and save it as a separate entry.</p><button type="button" class="btn small" onClick={() => { setAsNew(true); setRevision(undefined); setBase(undefined); setConflict(null); setError(""); }}>Keep draft as new knowledge</button></>}
      <button type="button" class="btn small" disabled={busy} onClick={async () => { setBusy(true); try { await refreshConflict(); } catch (problem) { setError((problem as Error).message); } finally { setBusy(false); } }}>Refresh latest revision</button>
    </section> : null}
    {asNew ? <p class="help">This draft will be saved as a new entry.</p> : null}
    <div class="memory-actions"><button type="submit" class="btn small primary" disabled={busy || !!conflict || !title.trim() || !body.trim() || (scope === "branch" && !branch.trim())}>{busy ? "Saving…" : "Save knowledge"}</button><button type="button" class="btn small" disabled={busy} onClick={onCancel}>Cancel</button></div>
    {error && !conflict ? <p class="msg err" role="alert">{completeSentence(error)} Your draft is still here.</p> : null}
  </form>;
}
