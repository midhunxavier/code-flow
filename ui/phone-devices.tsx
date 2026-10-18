import { useEffect, useState } from "preact/hooks";
import { api, showToast } from "./lib.js";
import type { PhoneDevice } from "../src/phone-sessions.js";

export function PhoneDevices() {
  const [devices, setDevices] = useState<PhoneDevice[] | null>(null);
  const load = () => api<PhoneDevice[]>("/api/remote/devices").then(setDevices, (error) => showToast(error.message, 5000));
  useEffect(() => { void load(); }, []);
  return <details><summary>Paired devices{devices ? ` · ${devices.length}` : ""}</summary><p class="help">Each phone has its own expiring session. Revoking one phone leaves your other devices signed in.</p><button class="btn small" onClick={load}>Refresh devices</button>{devices?.length ? devices.map((device) => <div class="row" key={device.id}><span>{device.label} · expires {new Date(device.expiresAt).toLocaleDateString()}</span><button class="btn small" onClick={async () => { try { await api(`/api/remote/devices/${device.id}`, { method: "DELETE" }); await load(); } catch (error) { showToast((error as Error).message, 5000); } }}>Revoke device</button></div>) : <p class="help">No paired devices.</p>}</details>;
}
