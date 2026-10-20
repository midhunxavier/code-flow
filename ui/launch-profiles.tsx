import { confirmAction } from "./confirm-state.js";
import { pollVisible } from "./polling.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, enc, post, showToast } from "./lib.js";
import type { LaunchProfile, LaunchSession } from "../src/launch-profiles.js";

interface LaunchInventory { profiles: LaunchProfile[]; found: boolean; error?: string; session: LaunchSession | null }

/** A profile is only read on mount; repository commands run after the explicit Start action. */
export function LaunchProfilesPanel({ runId, worktree }: { runId: string; worktree: string }) {
  const [inventory, setInventory] = useState<LaunchInventory | null>(null);
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "start" | "stop">("");
  const generation = useRef(0); const request = useRef(0); const action = useRef(0);
  const route = `/api/runs/${enc(runId)}/launch-profiles`;
  const query = `?worktree=${enc(worktree)}`;
  const selectId = `launch-profile-${enc(runId)}-${enc(worktree)}`;
  useEffect(() => {
    const scope = ++generation.current; let alive = true;
    setInventory(null); setProfileId(""); setError(""); setBusy(""); action.current++;
    const load = async () => {
      const seq = ++request.current;
      try {
        const result = await api<LaunchInventory>(route + query);
        if (!alive || generation.current !== scope || request.current !== seq) return;
        setInventory(result); setError(""); setProfileId((current) => result.profiles.some((profile) => profile.id === current) ? current : result.profiles[0]?.id ?? "");
      } catch (err) { if (alive && generation.current === scope && request.current === seq) setError((err as Error).message); }
    };
    const stopPolling = pollVisible(load, 2000);
    return () => { alive = false; stopPolling(); generation.current++; action.current++; };
  }, [runId, worktree]);
  const start = async () => {
    const scope = generation.current; const op = ++action.current;
    setBusy("start"); setError("");
    try {
      let session: LaunchSession;
      const body = { worktree, profile: profileId };
      try { session = await post<LaunchSession>(route, body); }
      catch (err) {
        if (!(err instanceof ApiError) || err.confirm !== "allowUntrusted") throw err;
        if (scope !== generation.current || op !== action.current || !await confirmAction(`${err.message}\n\nStart these repository commands on this computer?`, {"title":"Start repository commands?","confirmLabel":"Start commands","danger":true})) return;
        if (scope !== generation.current || op !== action.current) return;
        session = await post<LaunchSession>(route, { ...body, allowUntrusted: true });
      }
      if (scope !== generation.current || op !== action.current) return;
      request.current++; setInventory((current) => current ? { ...current, session } : current);
      showToast(session.status === "ready" ? "Launch profile is ready" : "Launch profile finished startup");
    } catch (err) { if (scope === generation.current && op === action.current) setError((err as Error).message); }
    finally { if (scope === generation.current && op === action.current) setBusy(""); }
  };
  const stop = async () => {
    const scope = generation.current; const op = ++action.current;
    setBusy("stop"); setError("");
    try {
      const result = await api<{ stopped: boolean; session?: LaunchSession }>(route + query, { method: "DELETE" });
      if (scope !== generation.current || op !== action.current) return;
      request.current++; setInventory((current) => current ? { ...current, session: result.session ?? (current.session ? { ...current.session, status: "stopped", services: current.session.services.map((service) => ({ ...service, status: service.status === "exited" ? "exited" : "stopped" })) } : null) } : current);
      showToast(result.stopped ? "Launch profile stopped" : "No active launch profile");
    } catch (err) { if (scope === generation.current && op === action.current) setError((err as Error).message); }
    finally { if (scope === generation.current && op === action.current) setBusy(""); }
  };
  const profile = inventory?.profiles.find((candidate) => candidate.id === profileId);
  const session = inventory?.session;
  const active = session?.status === "ready" || session?.status === "starting" || busy === "start";
  return <section class="wb-card launch-profiles" aria-label="Multi-service launch profiles">
    <h2>Launch profiles</h2>
    <p class="help">Start a coordinated app stack from this worktree’s <code>.codeflow/launch.json</code>. Services get separate ports, peer URLs and bounded HTTP readiness checks. Starting a profile executes repository commands on this computer.</p>
    {!inventory && !error ? <p role="status">Reading launch profiles…</p> : null}
    {inventory?.error ? <p class="msg err" role="alert">{inventory.error}</p> : null}
    {inventory && !inventory.found ? <p class="help">No launch configuration exists in this worktree. Add a version 1 <code>.codeflow/launch.json</code> with named profiles and up to six services each.</p> : null}
    {inventory?.found && !inventory.error && !inventory.profiles.length ? <p class="help">The launch configuration has no profiles.</p> : null}
    {profile ? <>
      <div class="launch-profile-choice"><label class="lbl" for={selectId}>Launch profile</label><select id={selectId} class="field" value={profileId} disabled={!!busy || !!active} onChange={(event) => setProfileId(event.currentTarget.value)}>{inventory!.profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></div>
      <details class="launch-preview"><summary>Review {profile.services.length} service commands</summary><ul>{profile.services.map((service) => <li key={service.id}><strong>{service.name ?? service.id}</strong> <code>{service.cwd}</code><pre>{service.command}</pre><p class="help">{service.dependsOn.length ? `Starts after ${service.dependsOn.join(", ")}. ` : ""}{service.health === false ? "Checks that the process remains running; HTTP readiness is disabled." : `HTTP ${service.health.path} must return 2xx within ${service.health.timeoutMs / 1000}s.`}</p></li>)}</ul></details>
      <div class="launch-actions"><button class="btn primary" disabled={!!busy || !!active || !!inventory?.error} onClick={start}>{busy === "start" ? "Starting services…" : "Start launch profile"}</button><button class="btn" disabled={!active || busy === "stop"} onClick={stop}>{busy === "stop" ? "Stopping…" : "Stop services"}</button></div>
    </> : active ? <button class="btn" disabled={busy === "stop"} onClick={stop}>Stop services</button> : null}
    {session ? <div class="launch-session" aria-live="polite"><p><strong>Stack: {session.status}</strong> · {session.profile}</p>{session.error ? <p class="msg err">{session.error}</p> : null}<div class="launch-services">{session.services.map((service) => <article class="launch-service" key={service.id} aria-label={`${service.name} service`}><div><strong>{service.name}</strong><span class={`badge ${service.status === "healthy" ? "ok" : service.status === "exited" ? "err" : service.status === "starting" || service.status === "running" ? "run" : ""}`}>{service.status.charAt(0).toUpperCase() + service.status.slice(1)}</span></div><p class="help">Port {service.port}{service.exitCode != null ? ` · Exit ${service.exitCode}` : ""} · {service.healthChecked ? "HTTP readiness passed" : "HTTP readiness not confirmed"}</p>{session.status === "ready" && ["healthy", "running"].includes(service.status) ? <a href={service.url} target="_blank" rel="noopener noreferrer">Open {service.name}</a> : <code>{service.url}</code>}<details><summary>Logs ({service.logs.length} recent lines)</summary><pre class="launch-logs">{service.logs.join("\n") || "No output yet."}</pre></details></article>)}</div></div> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}
