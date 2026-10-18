import { useEffect, useState } from "preact/hooks";
import { api, post } from "./lib.js";
import type { ExternalSource, ExternalSourceItem, ExternalSourceKind, ExternalSourcePage } from "../src/integrations.js";

interface IntegrationSummary { id: string; name: string; provider: string; project: string; kinds: ExternalSourceKind[]; configured: boolean }

export function IntegrationsView({ onImport }: { onImport: (source: ExternalSource) => void }) {
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [kind, setKind] = useState<ExternalSourceKind>("issue");
  const [items, setItems] = useState<ExternalSourceItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void api<IntegrationSummary[]>("/api/integrations").then((values) => { if (alive) { setIntegrations(values); setSelected(values[0]?.id ?? ""); } }, (err) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, []);
  const integration = integrations.find((value) => value.id === selected);
  useEffect(() => { setItems([]); setCursor(undefined); setTruncated(false); setError(""); if (integration && !integration.kinds.includes(kind)) setKind(integration.kinds[0]!); }, [selected, kind]);
  const load = async (more = false) => {
    if (!integration) return;
    const requested = selected, requestedKind = kind;
    setBusy("list"); setError("");
    try {
      const query = new URLSearchParams({ kind }); if (more && cursor) query.set("cursor", cursor);
      const result = await api<ExternalSourcePage>(`/api/integrations/${encodeURIComponent(selected)}/items?${query}`);
      // Controls are disabled while loading, keeping the response attached to this selection.
      if (requested === selected && requestedKind === kind) { setItems((old) => [...new Map((more ? [...old, ...result.items] : result.items).map((value) => [`${value.kind}:${value.key}`, value])).values()]); setCursor(result.nextCursor); setTruncated(result.truncated); }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(""); }
  };
  const importItem = async (value: ExternalSourceItem) => {
    setBusy(value.key); setError("");
    try { onImport(await post<ExternalSource>(`/api/integrations/${encodeURIComponent(selected)}/import`, { kind, key: value.key })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(""); }
  };
  return <section class="wb-card sources-panel" aria-label="External sources">
    <h2>External sources</h2>
    <p>Read issues and review requests from configured services, then attach a selected item to a task.</p>
    <p class="help">Imported text stays untrusted context. Review requests import descriptions and branch metadata; their code is not fetched automatically.</p>
    {!integrations.length ? <p class="help">Configure sources with CODEFLOW_INTEGRATIONS_FILE or CODEFLOW_INTEGRATIONS_JSON on the server. Credentials come from server environment variables.</p> : <>
      <div class="wb-fields">
      <label>Integration<select class="field" aria-label="Source integration" value={selected} disabled={!!busy} onChange={(event) => setSelected(event.currentTarget.value)}>{integrations.map((value) => <option value={value.id} key={value.id}>{value.name} · {value.provider} · {value.project}</option>)}</select></label>
      <label>Source type<select class="field" aria-label="External source type" value={kind} disabled={!!busy} onChange={(event) => setKind(event.currentTarget.value as ExternalSourceKind)}>{integration?.kinds.map((value) => <option key={value} value={value}>{value === "pr" ? "Review requests" : "Issues"}</option>)}</select></label>
      </div>
      {!integration?.configured ? <p class="msg warn">The server does not have credentials for this integration.</p> : null}
      <button class="btn" disabled={!integration?.configured || !!busy} onClick={() => load()}>{busy === "list" ? "Loading…" : "Load sources"}</button>
      <div class="wb-list" aria-live="polite">{items.map((value) => <article class="wb-item source-item" key={`${value.kind}:${value.key}`}>
        <div class="wb-item-head"><b>{value.key} · {value.title}</b>{value.state ? <span class="badge">{value.state.charAt(0).toUpperCase() + value.state.slice(1).toLowerCase()}</span> : null}</div>
        {value.body ? <p class="help">{value.body.slice(0, 400)}</p> : null}
        <div class="wb-actions">{value.url ? <a class="btn small" href={value.url} target="_blank" rel="noreferrer">Open source</a> : null}
        <button class="btn small primary" disabled={!!busy} onClick={() => importItem(value)}>{busy === value.key ? "Importing…" : "Use as task context"}</button></div>
      </article>)}</div>
      {cursor && items.length < 1_000 ? <button class="btn" disabled={!!busy} onClick={() => load(true)}>Load next page</button> : null}
      {truncated || cursor && items.length >= 1_000 ? <p class="help">The listing reached its limit. Narrow the configured project or open the service to inspect additional items.</p> : null}
    </>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}
