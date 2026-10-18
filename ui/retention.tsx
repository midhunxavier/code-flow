import { useEffect, useState } from "preact/hooks";
import type { RetentionKind, RetentionPolicy, RetentionPreview } from "../src/retention-policy.js";
import { api, post } from "./lib.js";

const labels: Record<RetentionKind, string> = { archivedRuns: "Archived run logs and recovery records", attachments: "Staged uploads and message attachments", memory: "Private and team memory from retired runs", worktrees: "Clean linked workspaces, keeping branches" };
const kinds = Object.keys(labels) as RetentionKind[];
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`;
const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;

/** Configure and inspect online; the reviewed deletion manifest is applied offline by CLI. */
export function WorkbenchRetentionPanel({ endpoint = "/api/maintenance/retention" }: { endpoint?: string }) {
  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [days, setDays] = useState<Record<RetentionKind, string>>({ archivedRuns: "", attachments: "", memory: "", worktrees: "" });
  const [keepRuns, setKeepRuns] = useState(""); const [keepMemory, setKeepMemory] = useState("");
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState("");
  const load = async () => {
    const value = await api<RetentionPolicy>(endpoint); setPolicy(value);
    setDays(Object.fromEntries(kinds.map((kind) => [kind, value.days[kind] === null ? "" : String(value.days[kind])])) as Record<RetentionKind, string>);
    setKeepRuns(value.keepRunIds.join("\n")); setKeepMemory(value.keepMemoryIds.join("\n")); setError(""); setPreview(null);
  };
  useEffect(() => { void load().catch((problem) => setError((problem as Error).message)); }, [endpoint]);
  const save = async () => {
    if (!policy || busy) return; setBusy(true); setError(""); setSaved("");
    try {
      const next = Object.fromEntries(kinds.map((kind) => [kind, days[kind].trim() ? Number(days[kind]) : null]));
      if (kinds.some((kind) => next[kind] !== null && (!Number.isInteger(next[kind]) || next[kind]! < 1 || next[kind]! > 36500))) throw new Error("Enter 1–36,500 days, or leave blank to keep that data.");
      const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];
      const value = await post<RetentionPolicy>(endpoint, { expectedRevision: policy.revision, days: next, keepRunIds: ids(keepRuns), keepMemoryIds: ids(keepMemory) });
      setPolicy(value); setPreview(null); setSaved("Retention settings saved. No data was deleted.");
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  };
  const inspect = async () => {
    if (busy) return; setBusy(true); setError("");
    try { setPreview(await post<RetentionPreview>(endpoint + "/preview", {})); }
    catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  };
  const download = () => {
    if (!preview) return;
    const blob = new Blob([JSON.stringify(preview, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `codeflow-retention-${new Date(preview.createdAt).toISOString().replace(/[:.]/g, "-")}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section class="section retention-panel" aria-label="Data retention" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
    <div class="section-title">Data retention</div>
    <p class="help">Choose separate retention ages for application data. Blank fields keep that data. Saving settings never deletes anything; review a fixed preview and apply it with the server stopped.</p>
    <p class="help">Active, resumable, unarchived and pinned work is protected. Project knowledge requires individual review and is never bulk-deleted. Live memory provenance and child/deferred run references preserve their sources.</p>
    {policy ? <>
      {kinds.map((kind) => <label key={kind}>{labels[kind]} · days<input class="field" aria-label={`Retention days ${kind}`} type="number" min={1} max={36500} placeholder="Keep indefinitely" value={days[kind]} onInput={(event) => { setDays((previous) => ({ ...previous, [kind]: event.currentTarget.value })); setSaved(""); }} /></label>)}
      <label>Keep these run IDs · one per line<textarea class="field" rows={2} aria-label="Retention protected run IDs" value={keepRuns} onInput={(event) => setKeepRuns(event.currentTarget.value)} /></label>
      <label>Keep these memory IDs · one per line<textarea class="field" rows={2} aria-label="Retention protected memory IDs" value={keepMemory} onInput={(event) => setKeepMemory(event.currentTarget.value)} /></label>
      <div class="at-row" style={{ flexWrap: "wrap" }}><button class="btn small primary" disabled={busy} onClick={save}>Save retention settings</button><button class="btn small" disabled={busy} onClick={inspect}>{busy ? "Inspecting…" : "Preview saved retention policy"}</button><button class="btn small" disabled={busy} onClick={() => void load().catch((problem) => setError((problem as Error).message))}>Reload saved settings</button></div>
      {saved ? <p class="help" role="status">{saved}</p> : null}
    </> : <p class="help">Loading retention settings…</p>}
    {error ? <p class="msg err" role="alert">{error} Your draft settings are preserved.</p> : null}
    {preview ? <section aria-label="Retention preview">
      <p class="help">Policy revision {preview.policyRevision} · preview {new Date(preview.createdAt).toLocaleString()} · expires {new Date(preview.expiresAt).toLocaleString()}. Known file bytes selected: {bytes(preview.summary.bytes)}. Memory bodies are counted separately.</p>
      <ul>{kinds.map((kind) => <li key={kind}>{labels[kind]}: {preview.summary[kind]} selected{preview.cutoffs[kind] === null ? " · disabled" : ` · last updated before ${new Date(preview.cutoffs[kind]!).toLocaleString()}`}</li>)}</ul>
      {preview.truncated ? <p class="msg err" role="alert">This scan is incomplete or reached a limit and cannot be applied. Review the protected reasons and narrow the policy or repair the unreadable data.</p> : null}
      <details><summary>Exact selected targets · {preview.targets.length}</summary><ul>{preview.targets.map((target) => <li key={target.id}><b>{target.kind}</b> · {target.path ?? target.memory?.id ?? target.runId} · {target.detail}{target.files ? <ul>{target.files.map((file) => <li key={file.path}>{file.path} · {bytes(file.bytes)} · <code>{file.fingerprint}</code></li>)}</ul> : <p class="help">Fingerprint: <code>{target.fingerprint}</code></p>}</li>)}</ul></details>
      <details><summary>Protected data and scan limits · {preview.protected.length}</summary><ul>{preview.protected.map((item, index) => <li key={index}>{item.kind} · {item.id}: {item.reason}</li>)}</ul></details>
      <p class="help">Manifest fingerprint: <code>{preview.fingerprint}</code>. Download after reviewing it, stop the server, then apply the downloaded file. Any policy, ownership or data change invalidates the preview. Workspaces are removed without force and Git branches are kept.</p>
      <button class="btn small" disabled={preview.truncated} onClick={download}>Download reviewed retention plan</button>
      <pre>{`npm run maintenance -- retention-policy --plan /path/to/downloaded-plan.json --apply --home ${quote(preview.home)}`}</pre>
      <p class="help">The apply command takes the same exclusive lock as the server. An I/O failure after deletion starts is reported with the applied and remaining targets.</p>
    </section> : null}
  </section>;
}
