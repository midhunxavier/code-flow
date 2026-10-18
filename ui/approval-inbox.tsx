import { useEffect, useState } from "preact/hooks";
import { api, post } from "./lib.js";
import { route } from "./state.js";
import type { ApprovalRecord } from "../src/approvals.js";

/** Permission requests are explicit, one-action decisions; an ignored request expires denied. */
export function ApprovalInbox() {
  const [pending, setPending] = useState<ApprovalRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true, loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try { const records = await api<ApprovalRecord[]>("/api/approvals"); if (current) setPending(records.filter((record) => record.status === "pending")); }
      catch { /* The persistent connection indicator handles an unavailable server. */ }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { current = false; clearInterval(timer); };
  }, []);
  const request = pending[0];
  if (!request) return null;
  const decide = async (decision: "approve" | "decline") => {
    setBusy(true); setError("");
    try { await post(`/api/approvals/${request.id}`, { decision }); setPending((records) => records.filter((record) => record.id !== request.id)); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <aside class="approval-inbox" role="alert" aria-label="Tool approval required" style="position:fixed;right:18px;bottom:18px;max-width:min(480px,calc(100vw - 36px));max-height:70vh;overflow:auto;z-index:1000;padding:20px;background:var(--panel);border:2px solid var(--accent,#7eb34b);border-radius:18px;box-shadow:0 10px 40px #0003">
    <h3>Permission required{pending.length > 1 ? ` · ${pending.length} pending` : ""}</h3>
    <p>{request.kind === "command" ? "Run this command once" : "Apply these file changes once"}</p>
    {request.command ? <pre style="white-space:pre-wrap;overflow-wrap:anywhere">{request.command}</pre> : null}
    {request.paths?.length ? <ul>{request.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null}
    {request.cwd ? <p class="help">Folder: {request.cwd}</p> : null}
    {request.reason ? <p>{request.reason}</p> : null}
    <p class="help">Expires at {new Date(request.expiresAt).toLocaleTimeString()}. This decision grants no session-wide permissions.</p>
    <div class="row"><button class="btn primary" disabled={busy} onClick={() => decide("approve")}>Approve once</button><button class="btn" disabled={busy} onClick={() => decide("decline")}>Decline</button><button class="btn ghost" onClick={() => { route.value = { view: "run", id: request.runId }; }}>Inspect run</button></div>
    {error ? <p class="msg err">{error}</p> : null}
  </aside>;
}
