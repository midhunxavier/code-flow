import { confirmAction } from "./confirm-state.js";
import { useEffect, useState, useRef } from "preact/hooks";
import { api, enc, post, showToast } from "./lib.js";
import { refreshProviders } from "./state.js";
import type { AcpConnection, AcpConnectionDocument, AcpProbe } from "../src/adapters/acp-types.js";
import { acpPresets, acpPresetConnection } from "../src/adapters/acp-presets.js";

export function AcpConnectionsPanel() {
  const form = useRef<HTMLFormElement>(null);
  const [document, setDocument] = useState<AcpConnectionDocument>();
  const [draft, setDraft] = useState<AcpConnection>(), [argumentsText, setArgumentsText] = useState("");
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<{ id: string; name: string; probe: AcpProbe }>();
  const reload = async () => { try { setDocument(await api("/api/acp-connections")); setError(""); } catch (error) { setError((error as Error).message); } };
  useEffect(() => { void reload(); }, []);
  const edit = (connection: AcpConnection, existing: boolean) => { setDraft(structuredClone(connection)); setArgumentsText(connection.args.join("\n")); setEditing(existing); setResult(undefined); setError(""); };
  const patch = (value: Partial<AcpConnection>) => { setDraft((old) => old ? { ...old, ...value } : old); setResult(undefined); };
  const value = () => ({ ...draft!, args: argumentsText.split("\n").filter(line => line.trim() !== "") });
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } };
  const refresh = async (next: AcpConnectionDocument) => { setDocument(next); await refreshProviders(); };
  const save = async (connection: AcpConnection) => { await refresh(await post("/api/acp-connections", { revision: document!.revision, connection })); };
  const check = async (connection: AcpConnection) => { setResult(undefined); setResult({ id: connection.id, name: connection.name, probe: await post("/api/acp-connections/check", { connection }) }); };
  const preset = acpPresets.find((item) => draft?.id === `acp:${item.key}`);
  return <section class="settings-card" aria-label="ACP connections">
    <h3>Connect another coding agent</h3>
    <p class="help">Connect OpenCode, Kilo, Cline or another CLI that supports Agent Client Protocol (ACP). Install and sign in through the CLI on this machine first.</p>
    <p class="help">Connections can be saved and checked for protocol and models. ACP providers are unavailable for runs because Code Flow cannot enforce their managed permission policy. Choose Claude Code, Codex or Antigravity for coding tasks; changing to Full access does not enable ACP runs.</p>
    <div class="settings-actions">{acpPresets.map((item) => <button key={item.key} class="btn" disabled={busy || !document} onClick={() => { const existing = document?.connections.find((connection) => connection.id === `acp:${item.key}`); edit(existing ?? acpPresetConnection(item), !!existing); }}>Connect {item.name}</button>)}<button class="btn" disabled={busy || !document} onClick={() => edit({ id: "acp:", name: "", command: "", args: [], enabled: true }, false)}>Add compatible CLI</button><button class="btn" disabled={busy} onClick={() => void reload()}>Reload connections</button></div>
    {document?.connections.map((connection) => <article class="wb-item" key={connection.id}>
      <div class="wb-item-head"><strong>{connection.name}</strong><span class="badge">{connection.enabled ? "Enabled" : "Disabled"}</span></div>
      <p class="help"><code>{[connection.command, ...connection.args].join(" ")}</code></p>
      <div class="settings-actions">
        <button class="btn small" disabled={busy} onClick={() => edit(connection, true)} aria-label={`Edit ${connection.name}`}>Edit</button>
        <button class="btn small" disabled={busy} onClick={() => void action(() => check(connection))}>Check {connection.name}</button>
        <button class="btn small" disabled={busy} onClick={() => void action(() => save({ ...connection, enabled: !connection.enabled }))}>{connection.enabled ? "Disable" : "Enable"} {connection.name}</button>
        <button class="btn small" disabled={busy} onClick={() => void (async () => { if (!await confirmAction(`Remove “${connection.name}”? Its command and arguments will be deleted. Older runs that reference it need the same connection restored before they can continue.`, { title: "Remove ACP connection?", confirmLabel: "Remove connection", danger: true })) return; await action(async () => { const next = await api<AcpConnectionDocument>(`/api/acp-connections/${enc(connection.id)}?revision=${document.revision}`, { method: "DELETE" }); if (draft?.id === connection.id) setDraft(undefined); if (result?.id === connection.id) setResult(undefined); await refresh(next); showToast(`Removed ${connection.name}`); }); })()}>Remove {connection.name}</button>
      </div>
    </article>)}
    {draft ? <form ref={form} class="acp-connection-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
      const connection = value();
      if (!editing && document?.connections.some((item) => item.id === connection.id)) throw new Error("That connection ID already exists. Edit the saved connection or choose another ID.");
      await save(connection); setDraft(undefined);
    }); }}>
      <h4>{editing ? "Edit connection" : "New connection"}</h4>
      {preset ? <div class="help">
        <p>Install: <code>{preset.install}</code>. Sign in: <code>{preset.login}</code>. <a href={preset.docs} target="_blank" rel="noopener noreferrer">{preset.name} CLI documentation</a></p>
        {"help" in preset ? <p>{preset.help}</p> : null}
      </div> : null}
      <div class="settings-grid">
        <label>Connection ID<input class="field" disabled={busy} aria-label="ACP connection ID" required pattern={"[a-z][a-z0-9\\-]{0,40}"} title="Start with a lowercase letter; use lowercase letters, digits or hyphens. The acp: prefix is added for you." aria-describedby="acp-id-hint" maxLength={41} readOnly={editing} value={draft.id.slice(4)} onInput={(event) => patch({ id: `acp:${event.currentTarget.value}` })} /></label>
        <label>Name<input class="field" disabled={busy} aria-label="ACP connection name" required maxLength={100} value={draft.name} onInput={(event) => patch({ name: event.currentTarget.value })} /></label>
      </div>
      <p class="help" id="acp-id-hint">Connection ID: lowercase letters, digits and hyphens, starting with a letter. Enter the name without the acp: prefix.</p>
      <label class="lbl">Executable<input class="field" disabled={busy} aria-label="ACP executable" required maxLength={4000} placeholder="opencode or /absolute/path/to/agent" value={draft.command} onInput={(event) => patch({ command: event.currentTarget.value })} /></label>
      <label class="lbl">Arguments · one per line (blank lines ignored)<textarea class="field" disabled={busy} aria-label="ACP arguments" rows={3} value={argumentsText} placeholder="acp" onInput={(event) => { setArgumentsText(event.currentTarget.value); setResult(undefined); }} /></label>
      <p class="help">Enter the executable separately from its arguments. Paths with spaces do not need quotes. Use the CLI’s own login; do not put credentials in these fields.</p>
      <div class="settings-actions"><button type="button" class="btn" disabled={busy} onClick={() => { if (form.current?.reportValidity()) void action(() => check(value())); }}>{busy ? "Working…" : "Check connection"}</button><button type="submit" class="btn primary" disabled={busy || !document}>Save connection</button><button type="button" class="btn" disabled={busy} onClick={() => { setDraft(undefined); setResult(undefined); }}>Cancel</button></div>
    </form> : null}
    {result ? <div class="msg" role="status"><strong>{result.name}: connected</strong><p>{result.probe.agent}{result.probe.version ? ` ${result.probe.version}` : ""} · ACP v1 · {result.probe.catalog.models.length} models · Session resume {result.probe.sessionResume ? "available" : "unavailable"}</p><p class="help">Created a session without sending a prompt. Model access and inference have not been tested.</p></div> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}
