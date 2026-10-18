import { useEffect, useState } from "preact/hooks";
import { api, post, showToast } from "./lib.js";
import { projects } from "./state.js";
import type { NotificationDelivery, NotificationEvent, NotificationSettings } from "../src/notifications.js";

interface Destination { id: string; name: string; protocol: "webhook" | "slack"; available: boolean; configured: boolean; host?: string; settings: NotificationSettings; dropped: number; lastError?: string }
const EVENTS: { id: NotificationEvent; label: string }[] = [{ id: "done", label: "Run finished" }, { id: "failure", label: "Run or verification failed" }, { id: "needs-attention", label: "A decision or answer is needed" }];

export function NotificationsView() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const reload = async () => {
    const [targets, history] = await Promise.all([api<Destination[]>("/api/notifications"), api<NotificationDelivery[]>("/api/notifications/deliveries")]);
    setDestinations(targets); setDeliveries(history);
  };
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([api<Destination[]>("/api/notifications"), api<NotificationDelivery[]>("/api/notifications/deliveries")]).then(([targets, history]) => { if (alive) { setDestinations(targets); setDeliveries(history); setError(""); } }, (err) => { if (alive) setError(err.message); });
    void load(); const timer = setInterval(() => void load(), 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const retry = async (delivery: NotificationDelivery) => {
    setBusy(delivery.id);
    try { await post(`/api/notifications/deliveries/${delivery.id}/retry`); await reload(); showToast("Notification retry queued"); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(""); }
  };
  return <section class="composer" aria-label="Outbound notifications">
    <h1>Notifications</h1>
    <p>Choose a destination, the events to send and the projects it covers. Notifications include task titles, run IDs, workflow and result status.</p>
    {!destinations.length ? <p class="help">Configure HTTPS webhook or Slack destinations with CODEFLOW_NOTIFICATIONS_FILE or CODEFLOW_NOTIFICATIONS_JSON on the server. New destinations start disabled.</p> : destinations.map((target) => <DestinationSettings key={target.id} destination={target} refresh={reload} />)}
    <h2>Delivery history</h2>
    <p class="help">Keeps 200 deliveries. Temporary failures retry up to three times. A delivery interrupted by restart needs an explicit retry; the recipient may already have received it.</p>
    {deliveries.length ? <div class="table-wrap"><table class="ins-table"><thead><tr><th>Created</th><th>Destination</th><th>Event</th><th>Run</th><th>Status</th><th>Attempts</th><th>Action</th></tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}>
      <td>{new Date(delivery.createdAt).toLocaleString()}</td><td>{destinations.find((target) => target.id === delivery.target)?.name ?? delivery.target}</td><td>{delivery.manual ? "Manual test" : delivery.event}</td>
      <td>{delivery.runId === "test" ? "Test" : <a href={`#/run/${delivery.runId}`}>{delivery.runId}</a>}</td>
      <td>{delivery.state}{delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ""}{delivery.reason ? <div class="help">{delivery.reason}</div> : null}{delivery.nextAttemptAt ? <div class="help">Next: {new Date(delivery.nextAttemptAt).toLocaleTimeString()}</div> : null}</td>
      <td>{delivery.totalAttempts ?? delivery.attempts}{delivery.retryCount ? <div class="help">{delivery.retryCount} manual retries</div> : null}</td>
      <td>{delivery.state === "failed" ? <button class="btn small" disabled={!!busy} onClick={() => retry(delivery)}>{busy === delivery.id ? "Queuing…" : "Retry delivery"}</button> : "–"}</td>
    </tr>)}</tbody></table></div> : <p class="help">No notifications have been queued.</p>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}

function DestinationSettings({ destination: target, refresh }: { destination: Destination; refresh: () => Promise<void> }) {
  const [settings, setSettings] = useState(target.settings);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setSettings(target.settings); }, [JSON.stringify(target.settings)]);
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
  return <article class="section" aria-label={`Notification settings for ${target.name}`}>
    <h2>{target.name}</h2><p class="help">{target.protocol}{target.host ? ` · ${target.host}` : ""}</p>
    {!target.available ? <p class="msg err">Saved notification state is unavailable. Check the server log before enabling delivery.</p> : !target.configured ? <p class="msg warn">A valid HTTPS destination and its credentials are required on the server.</p> : null}
    <label class="check"><input type="checkbox" checked={settings.enabled} disabled={!target.available || !target.configured || !!busy} onChange={(event) => setSettings({ ...settings, enabled: event.currentTarget.checked })} />Enable notifications to this destination</label>
    <fieldset disabled={!!busy || !target.available}><legend>Events</legend>{EVENTS.map((event) => <label class="check" key={event.id}><input type="checkbox" checked={settings.events.includes(event.id)} onChange={(input) => setSettings({ ...settings, events: input.currentTarget.checked ? [...settings.events, event.id] : settings.events.filter((id) => id !== event.id) })} />{event.label}</label>)}</fieldset>
    <fieldset disabled={!!busy || !target.available}><legend>Projects</legend><label class="check"><input type="checkbox" checked={settings.projects === "all"} onChange={(event) => setSettings({ ...settings, projects: event.currentTarget.checked ? "all" : [] })} />All projects</label>{settings.projects !== "all" ? choices.map((project) => <label class="check" key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={(event) => setSettings({ ...settings, projects: event.currentTarget.checked ? [...selected, project.id] : selected.filter((id) => id !== project.id) })} />{project.name}</label>) : null}</fieldset>
    <button class="btn primary" disabled={!!busy || !target.available || settings.enabled && (!target.configured || !settings.events.length || settings.projects !== "all" && !settings.projects.length)} onClick={save}>{busy === "save" ? "Saving…" : "Save notification settings"}</button>
    <button class="btn" disabled={!!busy || !target.configured || !target.available} onClick={sendTest}>{busy === "test" ? "Queuing…" : "Send test notification"}</button>
    {target.dropped ? <p class="msg warn">{target.dropped} events exceeded the queue limit.</p> : null}{target.lastError ? <p class="msg warn">{target.lastError}</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </article>;
}
