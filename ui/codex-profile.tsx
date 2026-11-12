import { useEffect, useState } from "preact/hooks";
import { api } from "./lib.js";
import { executionPaused } from "./state.js";

type Status = { profile: string; source: "environment" | "settings" | null; problem: string | null; available: string[]; codexHome: string };

/** Settings → Agents: which Codex profile runs use. Saved on this computer's server, read on every turn. */
export function CodexProfileSetting() {
  const [status, setStatus] = useState<Status>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  // Under a filesystem restriction the server refuses provider settings, so nothing is asked for
  // (the notice at the top of the page says why); it loads once the restriction is lifted.
  const paused = executionPaused.value;
  useEffect(() => { if (paused) { setStatus(undefined); return; } let live = true; void api<Status>("/api/codex-profile").then(value => { if (live) setStatus(value); }, err => { if (live) setError((err as Error).message); }); return () => { live = false; }; }, [paused]);
  if (paused) return null;
  if (!status) return error ? <section class="settings-card" aria-label="Codex profile"><h3>Codex profile</h3><p class="msg err" role="alert">Could not load the Codex profile: {error}</p></section> : null;
  const fromEnvironment = status.source === "environment";
  const choose = async (profile: string) => {
    setBusy(true); setError("");
    try { setStatus(await api<Status>("/api/codex-profile", { method: "PUT", body: JSON.stringify({ profile }) })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  // A saved profile whose file has gone stays listed, so it can be seen and cleared.
  const choices = status.profile && !status.available.includes(status.profile) ? [status.profile, ...status.available] : status.available;
  return <section class="settings-card codex-profile-setting" aria-label="Codex profile">
    <h3>Codex profile</h3>
    <label class="lbl">Profile for Codex runs
      <select class="field" aria-label="Codex profile" value={status.profile} disabled={busy || fromEnvironment} onChange={event => void choose(event.currentTarget.value)}>
        <option value="">Codex default (no profile)</option>
        {choices.map(name => <option key={name} value={name}>{name}{status.available.includes(name) ? "" : " · file missing"}</option>)}
      </select>
    </label>
    {fromEnvironment ? <p class="help">Set by <code>CODEFLOW_CODEX_PROFILE</code> for this server; unset it to choose here.</p> : null}
    {status.problem ? <p class="msg warn" role="status">{status.problem}. Codex runs fail until it exists or the profile is cleared.</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {status.profile ? <p class="help">With a profile, Codex turns run one at a time through <code>codex exec</code>: a message you send during a turn waits for the next one, and runs that ask you to approve each tool can’t use Codex.</p> : null}
  </section>;
}
