import { useState } from "preact/hooks";
import { SecureRemoteSetup, type RemoteInfo } from "./remote-access.js";

/** Only the missing network step, in place: the invitation's project and role stay selected. */
export function ProjectShareAccess({ info, busy, save, refresh }: { info: RemoteInfo; busy: boolean; save: (body: object, path?: string) => Promise<boolean>; refresh: () => void }) {
  const [transport, setTransport] = useState<"tailscale" | "lan">(info.enabled && info.lan ? info.transport : "tailscale");
  return <section class="share-access" aria-label="Secure project access"><h4>Make this server reachable</h4>
    <p class="help">Teammates need an encrypted address they can open. Keep this computer running.</p>
    <label>Connection method<select aria-label="Connection method" class="field" disabled={busy} value={transport} onChange={event => setTransport(event.currentTarget.value as "tailscale" | "lan")}><option value="tailscale">Tailscale · recommended</option><option value="lan">Other HTTPS network</option></select></label>
    {transport === "tailscale" ? <p class="help">{info.tailscale.message} Sign in to the same permitted Tailscale network on both computers.</p> : <p class="help">Use a server hostname and certificate trusted by your teammates. Your network must allow the server’s port.</p>}
    {transport === "tailscale" && info.tailscale.state === "not-installed" ? <a class="btn" href="https://tailscale.com/download" target="_blank" rel="noreferrer">Install Tailscale</a> : null}
    <div class="settings-actions"><button type="button" class="btn" disabled={busy} onClick={refresh}>Check connection</button>{!info.enabled || !info.lan || info.transport !== transport ? <button type="button" class="btn primary" disabled={busy || transport === "tailscale" && info.tailscale.state !== "connected"} onClick={() => void save({ enabled: true, lan: true, transport })}>Enable team access</button> : null}</div>
    {info.enabled && info.lan && info.transport === transport ? <SecureRemoteSetup info={info} busy={busy} save={body => save(body, "/api/remote/tls")} /> : null}
    {info.lanError ? <p class="msg err" role="alert">{info.lanError}</p> : null}
  </section>;
}
