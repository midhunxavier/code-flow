import { pollVisible } from "./polling.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, post, showToast } from "./lib.js";
import { projects } from "./state.js";
import type { NotificationDelivery, NotificationEvent, NotificationSettings } from "../src/notifications.js";

interface Destination { id: string; name: string; protocol: "webhook" | "slack"; available: boolean; configured: boolean; host?: string; settings: NotificationSettings; dropped: number; lastError?: string }
const EVENTS: { id: NotificationEvent; label: string }[] = [{ id: "done", label: "Run finished" }, { id: "failure", label: "Run or verification failed" }, { id: "needs-attention", label: "A decision or answer is needed" }];

export function NotificationsView({ destinationIds, projectId }: { destinationIds?: string[]; projectId?: string } = {}) {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState(""), [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState("");
  const request = useRef(0);
  const reload = async () => {
    const current = ++request.current;
    try {
      const [targets, history] = await Promise.all([api<Destination[]>("/api/notifications"), api<NotificationDelivery[]>("/api/notifications/deliveries")]);
      if (current !== request.current) return;
      setDestinations(targets.filter(target => !destinationIds || destinationIds.includes(target.id))); setDeliveries(history.filter(item => (!destinationIds || destinationIds.includes(item.target)) && (!projectId || item.project === projectId || item.manual)));
      setLoaded(true); setLoadError(""); setUnavailable(false);
    } catch (error) {
      if (current === request.current) { setLoadError((error as Error).message); setUnavailable(error instanceof ApiError && error.status === 503); }
      throw error;
    }
  };
  useEffect(() => {
    setLoaded(false); setLoadError(""); setUnavailable(false);
    const stop = pollVisible(() => reload().catch(() => {}), 10_000);
    return () => { ++request.current; stop(); };
  }, [JSON.stringify(destinationIds), projectId]);
  const retry = async (delivery: NotificationDelivery) => {
    setBusy(delivery.id);
    try { await post(`/api/notifications/deliveries/${delivery.id}/retry`); await reload(); setError(""); showToast("Notification retry queued"); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(""); }
  };
  return <section class="wb-card notifications-panel" aria-label="Outbound notifications">
    <h2>Notifications</h2>
    <p>Choose a destination, the events to send and the projects it covers. Notifications include task titles, run IDs, workflow and result status.</p>
    {loadError ? <p class="msg err" role="alert">{loadError} <button class="btn small" onClick={() => void reload().catch(() => {})}>Retry loading notifications</button></p> : null}
    {!loaded && !loadError ? <p role="status">Loading notification settings and history…</p> : null}
    {loaded && !unavailable ? <>
    {!destinations.length && !loadError ? <p class="help">Connect Slack or a webhook in Integrations. New destinations start off; choose projects and events before enabling delivery.</p> : <div class="wb-list">{destinations.map((target) => <DestinationSettings key={target.id} destination={target} refresh={reload} projectId={projectId} />)}</div>}
    <h3>Delivery history</h3>
    <p class="help">Keeps 200 deliveries. Temporary failures retry up to three times. A delivery interrupted by restart needs an explicit retry; the recipient may already have received it.</p>
    {/* data-label names each cell's column where phones stack a delivery's cells (styles.css, workspace) */}
    {deliveries.length ? <div class="table-wrap delivery-history"><table class="ins-table"><thead><tr><th>Created</th><th>Destination</th><th>Event</th><th>Run</th><th>Status</th><th>Attempts</th><th>Action</th></tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}>
      <td data-label="Created">{new Date(delivery.createdAt).toLocaleString()}</td><td data-label="Destination">{destinations.find((target) => target.id === delivery.target)?.name ?? delivery.target}</td><td data-label="Event">{delivery.manual ? "Manual test" : EVENTS.find((event) => event.id === delivery.event)?.label ?? delivery.event}</td>
      <td data-label="Run">{delivery.teamId ? <a href={`#/project/${delivery.project}/automation/missions`}>Project mission</a> : delivery.runId === "test" ? "Test" : <a href={`#/run/${delivery.runId}`}>{delivery.runId}</a>}</td>
      <td data-label="Status"><span class={`badge${delivery.state === "delivered" ? " ok" : delivery.state === "failed" ? " err" : delivery.state === "sending" ? " run" : ""}`}>{delivery.state.charAt(0).toUpperCase() + delivery.state.slice(1)}</span>{delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ""}{delivery.reason ? <div class="help">{delivery.reason}</div> : null}{delivery.state === "pending" && delivery.nextAttemptAt ? <div class="help">Next: {new Date(delivery.nextAttemptAt).toLocaleTimeString()}</div> : null}</td>
      <td data-label="Attempts">{delivery.totalAttempts ?? delivery.attempts}{delivery.retryCount ? <div class="help">{delivery.retryCount} manual {delivery.retryCount === 1 ? "retry" : "retries"}</div> : null}</td>
      <td data-label="Action">{delivery.state === "failed" ? <button class="btn small" disabled={!!busy} onClick={() => retry(delivery)}>{busy === delivery.id ? "Queuing…" : "Retry delivery"}</button> : "–"}</td>
    </tr>)}</tbody></table></div> : !loadError ? <p class="help">No notifications have been queued.</p> : null}
    </> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}

function DestinationSettings({ destination: target, refresh, projectId }: { destination: Destination; refresh: () => Promise<void>; projectId?: string }) {
  const initialSettings = () => projectId && Array.isArray(target.settings.projects) && !target.settings.projects.length ? { ...target.settings, projects: [projectId] } : target.settings;
  const [settings, setSettings] = useState(initialSettings);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setSettings(initialSettings()); }, [JSON.stringify(target.settings)]);
  const selected = settings.projects === "all" ? [] : settings.projects;
  const choices = [{ id: "unassigned", name: "Without a project" }, ...projects.value.map((project) => ({ id: project.id, name: project.name })), ...selected.filter((id) => id !== "unassigned" && !projects.value.some((project) => project.id === id)).map((id) => ({ id, name: `Unavailable project: ${id}` }))];
  const save = async () => {
    setBusy("save"); setError("");
    try { await post(`/api/notifications/${target.id}`, settings); await refresh(); showToast("Notification settings saved"); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(""); }
  };
  const sendTest = async () => {
    setBusy("test"); setError("");
    try { await post(`/api/notifications/${target.id}/test`); await refresh(); showToast("Test notification queued"); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(""); }
  };
  return <article class="wb-item notification-destination" aria-label={`Notification settings for ${target.name}`}>
    <div class="wb-item-head"><h3>{target.name}</h3><span class={`badge${target.settings.enabled ? " ok" : ""}`}>{target.settings.enabled ? "Enabled" : "Off"}</span></div><p class="help">{target.protocol}{target.host ? ` · ${target.host}` : ""}</p>
    {!target.available ? <p class="msg err">Saved notification state is unavailable. Check the server log before enabling delivery.</p> : !target.configured ? <p class="msg warn">A valid HTTPS destination and its credentials are required on the server.</p> : null}
    <label class="check"><input type="checkbox" checked={settings.enabled} disabled={!target.available || !target.configured || !!busy} onChange={(event) => setSettings({ ...settings, enabled: event.currentTarget.checked })} />Enable notifications to this destination</label>
    <fieldset disabled={!!busy || !target.available}><legend>Events</legend>{EVENTS.map((event) => <label class="check" key={event.id}><input type="checkbox" checked={settings.events.includes(event.id)} onChange={(input) => setSettings({ ...settings, events: input.currentTarget.checked ? [...settings.events, event.id] : settings.events.filter((id) => id !== event.id) })} />{event.label}</label>)}</fieldset>
    <fieldset disabled={!!busy || !target.available}><legend>Projects</legend><label class="check"><input type="checkbox" checked={settings.projects === "all"} onChange={(event) => setSettings({ ...settings, projects: event.currentTarget.checked ? "all" : [] })} />All projects</label>{settings.projects !== "all" ? choices.map((project) => <label class="check" key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={(event) => setSettings({ ...settings, projects: event.currentTarget.checked ? [...selected, project.id] : selected.filter((id) => id !== project.id) })} />{project.name}</label>) : null}</fieldset>
    <div class="wb-actions"><button class="btn primary" disabled={!!busy || !target.available || settings.enabled && (!target.configured || !settings.events.length || settings.projects !== "all" && !settings.projects.length)} onClick={save}>{busy === "save" ? "Saving…" : "Save notification settings"}</button>
    <button class="btn" disabled={!!busy || !target.configured || !target.available} onClick={sendTest}>{busy === "test" ? "Queuing…" : "Send test notification"}</button></div>
    {target.dropped ? <p class="msg warn">{target.dropped} events exceeded the queue limit.</p> : null}{target.lastError ? <p class="msg warn">{target.lastError}</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </article>;
}
