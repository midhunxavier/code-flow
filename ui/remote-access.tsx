import { useEffect, useRef, useState } from "preact/hooks";
import type { TailscaleStatus } from "../src/tailscale.js";
import { QrCode } from "./bits.js";
import { api, copy, post } from "./lib.js";
import { PhoneDevices } from "./phone-devices.js";

export interface RemoteInfo {
  enabled: boolean;
  lan: boolean;
  transport: "lan" | "tailscale";
  control: boolean;
  secure: boolean;
  insecureDevelopment: boolean;
  tls?: { editable: boolean; source?: "environment" | "tailscale" | "import"; hostname?: string; expiresAt?: number; error?: string; renewal?: { automatic: boolean; running: boolean; nextAttempt: number; lastSuccess?: number; error?: string } };
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
  const set = async (patch: object, path = "/api/remote") => {
    if (saving.current) return false;
    saving.current = true;
    const id = ++generation.current;
    setBusy(true);
    try {
      const value = await post<RemoteInfo>(path, patch);
      if (id === generation.current) { setInfo(value); setError(""); setNow(Date.now()); }
      return true;
    } catch (err) {
      if (id === generation.current) setError((err as Error).message);
      return false;
    } finally { saving.current = false; setBusy(false); }
  };
  const tailscale = info?.transport === "tailscale";
  const full = !!info?.control && info.lan;
  const expired = full && now >= (info?.pairingUntil ?? 0);
  const links = !info || expired || error ? [] : tailscale ? (info.tailscaleUrl ? [info.tailscaleUrl] : []) : info.lanUrls;
  const short = (url: string) => url.replace(/\/r\/(\w{6})\w+/, "/r/$1…");
  return <section class="section auto-card phone-card" aria-label="Remote access">
    <h2 class="section-title">Remote access</h2>
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
          <SecureRemoteSetup info={info} busy={busy} save={(body) => set(body, "/api/remote/tls")} />
          <label class={`checkpoint${info.control ? " danger" : ""}`}>
            <input type="checkbox" aria-label="Full control from remote devices" disabled={busy || (!info.secure && !info.insecureDevelopment)} checked={info.control} onChange={(e) => void set({ control: e.currentTarget.checked })} />
            <span><b>Full control from remote devices</b> — start runs, answer questions, review changes, merge and open pull requests. Anyone with the pairing link has your control of this computer.</span>
          </label>
          <p class="help">{info.secure ? "Encrypted HTTPS. " : info.insecureDevelopment ? "Development override: unencrypted HTTP. " : "Set up secure remote access above to enable full control. "}{full ? "Pairing links expire after ten minutes. Paired devices stay signed in for up to 30 days." : ""}</p>
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


export function SecureRemoteSetup({ info, busy, save }: { info: RemoteInfo; busy: boolean; save: (body: object) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState("tailscale");
  const [hostname, setHostname] = useState(info.tls?.hostname ?? info.tailscale.dnsName ?? "");
  const [error, setError] = useState("");
  const certFile = useRef<HTMLInputElement>(null), keyFile = useRef<HTMLInputElement>(null);
  const canTailscale = info.transport === "tailscale";
  const automatic = canTailscale && method === "tailscale";
  const renewal = info.tls?.renewal;
  const expires = info.tls?.expiresAt;
  const expiring = !!expires && expires - Date.now() < 30 * 86400_000;
  const submit = async () => {
    setError("");
    try {
      if (automatic) { if (await save({ mode: "tailscale" })) setOpen(false); return; }
      const cert = certFile.current?.files?.[0], key = keyFile.current?.files?.[0];
      if (!cert || !key) throw new Error("Choose both the certificate and private key files");
      if (cert.size > 128 * 1024 || key.size > 32 * 1024) throw new Error("Certificate must be under 128 KB and private key under 32 KB");
      if (await save({ mode: "import", hostname, cert: await cert.text(), key: await key.text() })) {
        if (keyFile.current) keyFile.current.value = "";
        setOpen(false);
      }
    } catch (error) { setError((error as Error).message); }
  };
  return <div class="remote-status secure-remote-setup">
    <b>{info.secure ? "Secure remote access is set up" : "Set up secure remote access"}</b>
    {info.tls?.source === "environment" ? <p class="help">HTTPS is managed by this server's environment configuration.</p> : <>
      {info.tls?.hostname ? <p class="help">{info.tls.hostname}{expires ? ` · Certificate expires ${new Date(expires).toLocaleDateString()}` : ""}</p> : null}
      {info.tls?.error ? <p class="msg err">{info.tls.error}</p> : expiring && !renewal ? <p class="help">Renew the certificate before it expires to keep remote access available.</p> : null}
      {renewal ? <div class="help"><b>Automatic renewal is on</b><p>{renewal.running ? "Renewing certificate…" : `Next renewal attempt: ${new Date(Math.max(Date.now(), renewal.nextAttempt)).toLocaleString()}`}{renewal.lastSuccess ? ` · Last renewed ${new Date(renewal.lastSuccess).toLocaleString()}` : ""}</p><p>Codeflow renews within 30 days of expiry while it is running and Tailscale access is enabled. Paired devices stay signed in.</p>{renewal.error ? <p role="status">{renewal.error}</p> : null}</div> : null}
      <p class="help">Configure HTTPS here. Codeflow saves the certificate privately and applies it immediately without restarting your chats. Manually replacing a certificate turns full control off until you enable it below.</p>
      {info.tls?.editable ? <button class="btn small" disabled={busy} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close setup" : info.secure ? "Renew or replace certificate" : "Set up secure remote access"}</button> : <p class="help">Open these settings on the computer running Codeflow to configure HTTPS.</p>}
      {open ? <form class="secure-remote-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={busy}>
          {canTailscale ? <label>Certificate setup<select class="field" value={method} onChange={(event) => setMethod(event.currentTarget.value)}><option value="tailscale">Use Tailscale · recommended</option><option value="import">Import certificate files</option></select></label> : null}
          {automatic ? <>
            <p class="help">Create or renew a certificate for <b>{info.tailscale.dnsName ?? "this computer's Tailscale name"}</b>. Enable HTTPS certificates in your <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">Tailscale DNS settings</a> first.</p>
            <p class="help">The computer's DNS name will appear in public certificate transparency logs. This does not make Codeflow public. <a href="https://tailscale.com/docs/how-to/set-up-https-certificates" target="_blank" rel="noreferrer">About Tailscale certificates</a></p>
            <p class="help">Automatic renewal is included. Codeflow renews within 30 days of expiry while it is running and Tailscale access is enabled, and retries automatically if renewal fails.</p>
          </> : <>
            <label>Remote hostname or IP<input class="field" value={hostname} placeholder="codeflow.example.com" onInput={(event) => setHostname(event.currentTarget.value)} required /></label>
            <label>Certificate file (PEM)<input class="field" type="file" accept=".pem,.crt,.cer" ref={certFile} required /></label>
            <label>Private key file (PEM)<input class="field" type="file" accept=".pem,.key" ref={keyFile} required /></label>
            <p class="help">Use a certificate trusted by your other device for this exact hostname or IP. The hostname must resolve to this computer. The key must be unencrypted; it is saved privately on this computer and never returned to the browser.</p>
          </>}
          <p class="help">Replacing a certificate signs paired devices out. Pair them again after enabling full control.</p>
          {error ? <p class="msg err" role="alert">{error}</p> : null}
          <button type="submit" class="btn primary" disabled={busy || automatic && (info.tailscale.state !== "connected" || !info.tailscale.dnsName)}>{busy ? "Setting up HTTPS…" : automatic ? "Get Tailscale certificate" : "Save and apply HTTPS"}</button>
        </fieldset>
      </form> : null}
    </>}
  </div>;
}
