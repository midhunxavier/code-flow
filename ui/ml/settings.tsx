import { useEffect, useRef, useState } from "preact/hooks";
import { api, usePoll } from "../lib.js";

interface Activation { enabled: boolean; revision: number }

export function MlSettingsCard() {
  const [settings, setSettings] = useState<Activation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true), saving = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const accept = (next: Activation) => setSettings(previous => !previous || next.revision >= previous.revision ? next : previous);
  async function refresh(current = () => mounted.current) {
    try { const next = await api<Activation>("/api/ml/settings"); if (current() && !saving.current) { accept(next); setError(""); } }
    catch (e) { if (current() && !saving.current) setError((e as Error).message); }
  }
  usePoll(refresh, 15_000, []);
  async function toggle() {
    if (!settings || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const next = await api<Activation>("/api/ml/settings", { method: "POST", body: JSON.stringify({ enabled: !settings.enabled, revision: settings.revision }) });
      if (mounted.current) accept(next);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      // A stale browser must review the saved choice before it can overwrite it.
      try { const next = await api<Activation>("/api/ml/settings"); if (mounted.current) accept(next); } catch { /* Keep the error and offer an explicit retry. */ }
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  return <section class="settings-card" aria-label="Model training" aria-busy={busy}>
    <h3>Model training <span class="badge">Preview</span></h3>
    <div class="settings-row"><div><strong>Train models and fine-tune LLMs</strong><p>Use this computer or your own GPU server over SSH. No cloud training account is required.</p><p role="status">{settings ? settings.enabled ? "Enabled · open a project’s ML tab to get started." : "Disabled · enable when you need it." : error ? "Could not load the model training setting." : "Loading model training setting…"}</p></div>
      <div class="settings-row-control"><button class="btn" disabled={!settings || busy || !!error} onClick={() => void toggle()}>{busy ? "Saving…" : !settings ? "Loading…" : settings.enabled ? "Disable model training" : "Enable model training"}</button></div>
    </div>
    <p class="help">Saved across restarts for all projects on this workspace’s computer. Install training packages separately from a project’s ML tab.</p>
    {settings?.enabled ? <><p class="help">Disabling blocks new ML work. Running jobs and loaded models keep their current limits.</p><details><summary>Running jobs and automation</summary><p class="help">History, cancellation and Stop serving remain available while disabled. Resident models unload when stopped or when their idle or lifetime limits expire. Enabling again allows saved schedules and policies to run within their remaining limits.</p></details></> : null}
    {error ? <p class="msg err" role="alert">{error} <button class="btn small" disabled={busy} onClick={() => void refresh()}>Reload setting</button></p> : null}
  </section>;
}
