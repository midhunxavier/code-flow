import { useEffect, useState } from "preact/hooks";
import { Icon } from "./icons.js";

export interface DesktopUpdateState {
  currentVersion: string;
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error" | "unsupported";
  message: string;
  version?: string;
  canInstall?: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  checkedAt?: string;
}
interface DesktopBridge {
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  openUpdateInstaller(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<DesktopUpdateState>;
  onUpdateState(callback: (state: DesktopUpdateState) => void): () => void;
}
declare global { interface Window { codeflowDesktop?: DesktopBridge } }

function useDesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState("");
  const bridge = window.codeflowDesktop;
  useEffect(() => {
    if (!bridge) return;
    let live = true, receivedEvent = false;
    const unsubscribe = bridge.onUpdateState(next => { receivedEvent = true; setState(next); setError(""); });
    void bridge.getUpdateState().then(next => { if (live && !receivedEvent) setState(next); }, () => { if (live) setError("Could not connect to the desktop updater. Try again."); });
    return () => { live = false; unsubscribe(); };
  }, [bridge]);
  const act = async (action: () => Promise<DesktopUpdateState>) => {
    setError("");
    try { setState(await action()); }
    catch { setError("Could not connect to the desktop updater. Try again."); }
  };
  return { state, error, bridge, act };
}

export function DesktopUpdatesCard() {
  const { state, error, bridge, act } = useDesktopUpdate();
  if (!bridge) return null;
  const busy = state && ["checking", "downloading", "installing"].includes(state.phase);
  const ready = state?.phase === "downloaded";
  const available = state?.phase === "available";
  return <section class="settings-card" aria-label="App updates" aria-busy={!!busy}>
    <h3>App updates</h3>
    <div class="settings-row"><div><strong>Code Flow{state ? ` ${state.currentVersion}` : ""}</strong><p role="status" aria-live="polite">{state?.message ?? "Connecting to the desktop updater…"}</p></div>
      <div class="settings-row-control"><button class={`btn ${ready || available ? "primary" : ""}`} disabled={!!busy || state?.phase === "unsupported"}
        onClick={() => void act(ready ? () => bridge.installUpdate() : available ? () => bridge.downloadUpdate() : () => bridge.checkForUpdates())}>
        {state?.phase === "checking" ? "Checking…" : state?.phase === "downloading" ? "Downloading…" : state?.phase === "installing" ? "Restarting…" : ready ? "Restart to update" : available ? state.canInstall ? "Download update" : "Download installer" : "Check for updates"}
      </button></div>
    </div>
    {state?.releaseUrl ? <div class="settings-actions"><a href={state.releaseUrl} target="_blank" rel="noreferrer">Release notes ↗</a>{state.phase === "error" && state.downloadUrl ? <button class="btn small" onClick={() => void act(() => bridge.openUpdateInstaller())}>Download installer</button> : null}</div> : null}
    {state?.checkedAt ? <p class="help">Last checked {new Date(state.checkedAt).toLocaleString()}.</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}

export function DesktopUpdateNotice({ collapsed }: { collapsed: boolean }) {
  const { state } = useDesktopUpdate();
  if (!state || !["available", "downloading", "downloaded"].includes(state.phase)) return null;
  const label = state.phase === "downloaded" ? "Restart to update" : state.phase === "downloading" ? "Downloading update…" : "Update available";
  return <a class="desktop-update-notice" href="#/settings/general" title={label} aria-label={label}><Icon name="refresh" />{collapsed ? null : <span>{label}</span>}</a>;
}
