import { useEffect, useState } from "preact/hooks";
import { Icon } from "./icons.js";
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
  // A raised card over the corner of the page: a warn strip names the request, the command or files
  // follow as code, and the decision is one ink button.
  return <aside class="approval-inbox" role="alert" aria-label="Tool approval required">
    <div class="ai-head">
      <Icon name="alert" />
      <h3>Permission required</h3>
      {pending.length > 1 ? <span class="ai-count">{pending.length} pending</span> : null}
    </div>
    <div class="ai-body">
      <p class="ai-what">{request.kind === "command" ? "Run this command once" : "Apply these file changes once"}</p>
      {request.command ? <pre class="ai-command">{request.command}</pre> : null}
      {request.paths?.length ? <ul class="ai-paths">{request.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null}
      {request.cwd ? <p class="ai-folder">Folder <code>{request.cwd}</code></p> : null}
      {request.reason ? <p class="ai-reason">{request.reason}</p> : null}
      <p class="help">Expires at {new Date(request.expiresAt).toLocaleTimeString()}. This decision grants no session-wide permissions.</p>
      {error ? <p class="msg err">{error}</p> : null}
    </div>
    <div class="ai-actions"><button class="btn primary" disabled={busy} onClick={() => decide("approve")}>Approve once</button><button class="btn" disabled={busy} onClick={() => decide("decline")}>Decline</button><span class="spacer" /><button class="btn ghost" onClick={() => { route.value = { view: "run", id: request.runId }; }}>Inspect run</button></div>
  </aside>;
}
