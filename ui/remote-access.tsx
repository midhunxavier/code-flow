import { useEffect, useRef, useState } from "preact/hooks";
import type { TailscaleStatus } from "../src/tailscale.js";
import { QrCode } from "./bits.js";
import { api, copy, post } from "./lib.js";
import { PhoneDevices } from "./phone-devices.js";

interface RemoteInfo {
  enabled: boolean;
  lan: boolean;
  transport: "lan" | "tailscale";
  control: boolean;
  secure: boolean;
  insecureDevelopment: boolean;
  pairingUntil: number;
  local: string;
  lanUrls: string[];
  lanError?: string;
  tailscale: TailscaleStatus;
  tailscaleUrl?: string;
}

export function RemoteAccess() {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const saving = useRef(false);
  const reading = useRef(false);
  const refresh = async (force = false) => {
    if (saving.current || reading.current) return;
    reading.current = true;
    setChecking(true);
    const id = ++generation.current;
    try {
      const value = await api<RemoteInfo>(`/api/remote${force ? "?refresh=1" : ""}`);
      if (id === generation.current) { setInfo(value); setError(""); setNow(Date.now()); }
    } catch (err) {
      if (id === generation.current) setError((err as Error).message);
    } finally { reading.current = false; setChecking(false); }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 10_000);
    return () => { clearInterval(timer); ++generation.current; };
  }, []);
  const set = async (patch: object) => {
    if (saving.current) return;
    saving.current = true;
    const id = ++generation.current;
    setBusy(true);
    try {
      const value = await post<RemoteInfo>("/api/remote", patch);
      if (id === generation.current) { setInfo(value); setError(""); setNow(Date.now()); }
    } catch (err) {
      if (id === generation.current) setError((err as Error).message);
    } finally { saving.current = false; setBusy(false); }
  };
  const tailscale = info?.transport === "tailscale";
  const full = !!info?.control && info.lan;
  const expired = full && now >= (info?.pairingUntil ?? 0);
  const links = !info || expired || error ? [] : tailscale ? (info.tailscaleUrl ? [info.tailscaleUrl] : []) : info.lanUrls;
  const short = (url: string) => url.replace(/\/r\/(\w{6})\w+/, "/r/$1…");
  return <section class="section" aria-label="Remote access">
    <div class="section-title">Remote access</div>
    <p class="help">Open Codeflow from your phone, tablet or another computer. This computer must stay awake and Codeflow must remain running.</p>
    {error ? <p class="msg err" role="alert">{error} <button class="btn small" disabled={busy} onClick={() => void refresh(true)}>Retry</button></p> : null}
    {!info ? <p class="help">{error ? "Remote access settings could not be loaded." : "Loading remote access…"}</p> : <>
      <label class="checkpoint">
        <input type="checkbox" aria-label="Enable remote access" disabled={busy} checked={info.enabled} onChange={(e) => void set({ enabled: e.currentTarget.checked })} />
        <span><b>Enable remote access</b> — a private link to your runs and results. Starts with a read-only view.</span>
      </label>
      {info.enabled ? <>
        <label class="remote-connection">Connection
          <select class="field" aria-label="Remote connection" disabled={busy} value={info.lan ? info.transport : "local"} onChange={(e) => {
            const value = e.currentTarget.value;
            void set({ lan: value !== "local", transport: value === "tailscale" ? "tailscale" : "lan", ...(value !== "local" && !info.secure && !info.insecureDevelopment ? { control: false } : {}) });
          }}>
            <option value="local">This computer only</option>
            <option value="tailscale">Tailscale · access anywhere</option>
            <option value="lan">Wi-Fi · local network</option>
          </select>
        </label>
        {tailscale ? <div class="remote-status" role="status">
          <b>{info.tailscale.state === "connected" ? "Tailscale connected" : "Tailscale setup needed"}</b>
          <p class="help">{info.tailscale.message}{info.tailscale.ip ? ` ${info.tailscale.dnsName ? `${info.tailscale.dnsName} · ` : ""}${info.tailscale.ip}` : ""}</p>
          <button class="btn small" disabled={busy || checking} onClick={() => void refresh(true)}>{checking ? "Checking Tailscale…" : "Refresh Tailscale"}</button>{" "}
          {info.tailscale.state === "not-installed" ? <a class="btn small" href="https://tailscale.com/download" target="_blank" rel="noreferrer">Install Tailscale</a> : null}
          <p class="help">Connect your other device to the same Tailscale network. Its access rules must allow this computer's remote port. Codeflow listens only on the Tailscale address in this mode.</p>
        </div> : info.lan ? <p class="help">Your other device must be on the same trusted Wi-Fi network. HTTPS is required for full control.</p> : null}
        {info.lan ? <>
          <label class={`checkpoint${info.control ? " danger" : ""}`}>
            <input type="checkbox" aria-label="Full control from remote devices" disabled={busy || (!info.secure && !info.insecureDevelopment)} checked={info.control} onChange={(e) => void set({ control: e.currentTarget.checked })} />
            <span><b>Full control from remote devices</b> — start runs, answer questions, review changes, merge and open pull requests. Anyone with the pairing link has your control of this computer.</span>
          </label>
          <p class="help">{info.secure ? "Encrypted HTTPS. " : info.insecureDevelopment ? "Development override: unencrypted HTTP. " : "To enable full control, configure CODEFLOW_TLS_CERT and CODEFLOW_TLS_KEY, then restart Codeflow. "}{full ? "Pairing links expire after ten minutes. Paired devices stay signed in for up to 30 days." : ""}</p>
          <PhoneDevices key={`${info.transport}-${info.pairingUntil}`} />
        </> : null}
        {info.lanError ? <p class="msg err" role="alert">{info.lanError}</p> : null}
        {expired ? <p class="msg" role="status">Pairing link expired. Choose New link to pair another device.</p> : null}
        {links[0] ? <div class="phone-qr">
          <QrCode text={links[0]} />
          <div class="phone-qr-text"><b>Scan with your phone</b><span class="help">{full ? "Pairs this device with full control" : "Opens the read-only view"} at {short(links[0])}. {tailscale ? "Turn on Tailscale on the phone before opening the link." : "Connect your phone to the same Wi-Fi first."}</span></div>
        </div> : info.lan && !expired && !error ? <p class="help">No remote link until {tailscale ? "Tailscale is connected and Codeflow can listen on its address" : "Codeflow can listen on your network"}.</p> : null}
        <div class="hook">
          {(info.lan ? links : [info.local]).map((url) => <div key={url}>
            <code>{short(url)}</code>{" "}<button class="btn small" onClick={() => copy(url, "Link copied")}>Copy link</button>{" "}
            {!info.lan ? <a class="btn small" href={url} target="_blank" rel="noreferrer">Open</a> : null}
          </div>)}
          {info.lan ? <p class="help">Open this link on your other device. Connections from this computer are blocked on the remote port.</p> : null}
          <button class="btn small" disabled={busy} onClick={() => confirm("Make a new link? Old links stop working and all paired devices are signed out.") && void set({ rotate: true })}>New link</button>
        </div>
      </> : null}
    </>}
  </section>;
}
