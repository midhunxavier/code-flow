import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc, post } from "./lib.js";
import type { ChangeRisk, ReviewCoverage } from "../src/verification.js";

interface Coverage { head: string; files: string[]; reviewed: string[]; coverage: ReviewCoverage; risk: ChangeRisk; stale: boolean; rework: { id: string; minutes: number; note: string; at: number }[] }
export function ReviewCoveragePanel({ runId, branch, refreshKey, onOpen }: { runId: string; branch: string; refreshKey?: string; onOpen: (path: string) => void }) {
  const [data, setData] = useState<Coverage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const view = `${runId}\0${branch}`;
  const currentView = useRef(view); currentView.current = view;
  const endpoint = `/api/runs/${enc(runId)}/review-coverage`;
  useEffect(() => {
    let current = true; setData(null); setError("");
    api<Coverage>(`${endpoint}?branch=${enc(branch)}`).then((value) => { if (current) setData(value); }, (err) => { if (current) setError(err.message); });
    return () => { current = false; };
  }, [runId, branch, refreshKey]);
  useEffect(() => { setBusy(false); setMinutes(""); setNote(""); }, [runId, branch]);
  const mutate = async (path: string, body: unknown) => {
    const expectedView = view;
    setBusy(true); setError("");
    try { const result = await post<Coverage>(path, body); if (currentView.current !== expectedView) return false; setData(result); return true; }
    catch (err) { if (currentView.current === expectedView) setError((err as Error).message); return false; }
    finally { if (currentView.current === expectedView) setBusy(false); }
  };
  return <details class="review-coverage"><summary>Human review coverage{data ? ` · ${data.coverage.reviewed}/${data.coverage.changed} files · ${data.risk.level} change risk` : ""}</summary>
    <p class="help">Mark files after reviewing them. Coverage records your review of this commit; it resets when the branch moves. Passing checks do not imply human review.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {data ? <><p class="help">Commit {data.head.slice(0, 12)}{data.stale ? " · previous review refers to older code" : ""}</p>{data.risk.reasons.map((reason) => <p class="help">{reason}</p>)}
      {data.files.map((path) => <div class="at-row" key={path}><label class="check"><input type="checkbox" aria-label={`Mark ${path} reviewed`} disabled={busy} checked={data.reviewed.includes(path)} onChange={(event) => mutate(endpoint, { branch, expectedHead: data.head, path, reviewed: event.currentTarget.checked })} /> Reviewed</label><button class="btn ghost small" onClick={() => onOpen(path)}>{path}</button></div>)}
      <details><summary>Record human rework</summary><p class="help">Track time you spent correcting or completing this result. These are your records, not estimates from agent activity.</p><label>Minutes<input class="field" type="number" min="1" max="1440" value={minutes} disabled={busy} onInput={(event) => setMinutes(event.currentTarget.value)} /></label><label>What changed<textarea class="field" rows={2} maxLength={2000} value={note} disabled={busy} onInput={(event) => setNote(event.currentTarget.value)} /></label><button class="btn small" disabled={busy || !(Number(minutes) >= 1 && Number(minutes) <= 1440)} onClick={async () => { if (await mutate(`/api/runs/${enc(runId)}/human-rework`, { branch, expectedHead: data.head, minutes: Number(minutes), note })) { setMinutes(""); setNote(""); } }}>Record rework</button><p class="help">{data.rework.reduce((sum, entry) => sum + entry.minutes, 0)} minutes recorded across {data.rework.length} entries.</p>{data.rework.map((entry) => <p class="help" key={entry.id}>{entry.minutes} min · {new Date(entry.at).toLocaleDateString()} · {entry.note}</p>)}</details>
    </> : <p class="help">Loading coverage…</p>}
  </details>;
}
