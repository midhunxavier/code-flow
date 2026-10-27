import { useEffect, useState } from "preact/hooks";
import { api, showToast, showError } from "./lib.js";
import { pollVisible } from "./polling.js";
import type { PhoneDevice } from "../src/phone-sessions.js";

/** The paired phones, in the Phone card: a quiet disclosure, each device a row with its own Revoke. */
export function PhoneDevices() {
  const [devices, setDevices] = useState<PhoneDevice[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api<PhoneDevice[]>("/api/remote/devices").then(value => { setDevices(value); setError(""); }, error => setError(error.message));
  useEffect(() => pollVisible(load, 10_000), []);
  return (
    <details class="phone-devices">
      <summary>Paired devices{devices ? ` · ${devices.length}` : ""}</summary>
      <p class="help">Each phone has its own expiring session. Revoking one phone leaves your other devices signed in.</p>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      {devices?.length ? (
        <div class="pd-list">
          {devices.map((device) => (
            <div class="pd-row" key={device.id}>
              <span class="pd-name">{device.label} <small>· {device.id.slice(0, 6)}</small></span>
              <span class="pd-when">Paired {new Date(device.createdAt).toLocaleString()} · expires {new Date(device.expiresAt).toLocaleDateString()}</span>
              <button class="btn small" aria-label={`Revoke ${device.label} ${device.id.slice(0, 6)}`} onClick={async () => { try { await api(`/api/remote/devices/${device.id}`, { method: "DELETE" }); await load(); } catch (error) { showError((error as Error).message, 5000); } }}>Revoke device</button>
            </div>
          ))}
        </div>
      ) : <p class="help">{devices ? "No paired devices." : "Loading paired devices…"}</p>}
      <button class="btn small pd-refresh" onClick={load}>Refresh devices</button>
    </details>
  );
}
