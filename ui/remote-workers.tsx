import { useEffect, useRef, useState } from "preact/hooks";
import { api, post } from "./lib.js";
import type { WorkerCapabilities } from "../src/remote-workers/protocol.js";
import type { Step } from "./types.js";

export interface WorkerChoice { workerId: string; repoMapping: string }
interface RegisteredWorker { id: string; name: string; repoMappings: string[]; containerProfile?: string; protocol: 1 }
interface Probe { capabilities: WorkerCapabilities; hasBase?: boolean; hasRepositoryBase?: boolean }

export function RemoteWorkerSelect({ value, onChange, disabled }: { value?: WorkerChoice; onChange: (value: WorkerChoice | undefined) => void; disabled?: boolean }) {
  const [workers, setWorkers] = useState<RegisteredWorker[]>([]), [error, setError] = useState("");
  useEffect(() => { let alive = true; void api<RegisteredWorker[]>("/api/remote-workers").then((items) => { if (alive) setWorkers(items); }, (err) => { if (alive) setError(err.message); }); return () => { alive = false; }; }, []);
  const worker = workers.find((item) => item.id === value?.workerId);
  return <div aria-label="Agent execution location">
    <label>Agent execution<select aria-label="Agent execution" value={value?.workerId ?? ""} disabled={disabled} onChange={(event) => { const selected = workers.find((item) => item.id === event.currentTarget.value); onChange(selected ? { workerId: selected.id, repoMapping: selected.repoMappings[0]! } : undefined); }}>
      <option value="">This computer</option>{workers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}{value && !worker ? <option value={value.workerId}>Unavailable worker: {value.workerId}</option> : null}
    </select></label>
    {worker ? <><label>Worker repository mapping<select aria-label="Worker repository mapping" value={value?.repoMapping} disabled={disabled} onChange={(event) => onChange({ workerId: worker.id, repoMapping: event.currentTarget.value })}>{worker.repoMappings.map((mapping) => <option key={mapping} value={mapping}>{mapping}</option>)}</select></label><p class="help">Agents use the worker’s installed CLI and login in a disposable checkout. Exact commits and staged references are transferred over SSH. Native approval prompts and live team tools are unavailable; replies use structured outcomes on the next turn.{worker.containerProfile ? ` Worker container profile: ${worker.containerProfile}.` : ""}</p></> : value ? <p class="msg err">This worker is no longer registered. Choose an available worker before starting.</p> : null}
    {error ? <p class="msg err">Worker configuration could not be loaded: {error}</p> : null}
  </div>;
}

export function RemoteWorkersView() {
  const [workers, setWorkers] = useState<RegisteredWorker[]>([]), [error, setError] = useState("");
  useEffect(() => { let alive = true; void api<RegisteredWorker[]>("/api/remote-workers").then((items) => { if (alive) setWorkers(items); }, (err) => { if (alive) setError(err.message); }); return () => { alive = false; }; }, []);
  return <section class="composer" aria-label="Remote workers"><h1>Remote workers</h1>
    <p>Use an explicitly provisioned SSH host to run agent turns. Each turn receives an exact Git commit, its prompt and bounded staged references. Worker credentials stay on that worker.</p>
    {!workers.length ? <p class="help">Register worker aliases, commands and repository mappings with CODEFLOW_REMOTE_WORKERS_FILE on the server. Prepare the host’s known-host key and official CLI login separately. See docs/remote-workers.md.</p> : workers.map((worker) => <WorkerProbe key={worker.id} worker={worker} />)}
    <p class="help">A lost connection can leave an ambiguous outcome. Inspect the step’s durable receipt before explicitly retrying. Code-flow never automatically repeats an accepted remote turn. SSH receipt metadata is retained; private recovery capabilities are excluded from backups.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}
/** Inspection never repeats a turn or imports an artifact. Resume is a separate owner action. */
export function RemoteStepReceipt({ runId, step }: { runId: string; step: Step }) {
  const [receipt, setReceipt] = useState<{ remote: NonNullable<Step["remote"]>; ok?: boolean; error?: string }>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirm, setConfirm] = useState(false);
  const generation = useRef(0), identity = `${runId}/${step.id}/${step.remote?.requestId ?? ""}`;
  useEffect(() => { generation.current++; setReceipt(undefined); setError(""); setBusy(false); setConfirm(false); return () => { generation.current++; }; }, [identity, step.remote?.state, step.remote?.ambiguous, step.remote?.resultHead]);
  if (!step.remote) return null;
  const remote = receipt?.remote ?? step.remote, terminal = ["completed", "failed", "cancelled"].includes(remote.state);
  const inspect = async (cancel = false) => {
    const current = generation.current; setBusy(true); setError(""); setConfirm(false);
    try { const value = await post<NonNullable<typeof receipt>>(`/api/runs/${encodeURIComponent(runId)}/remote-steps/${encodeURIComponent(step.id)}/${cancel ? "cancel" : "receipt"}`, {}); if (current === generation.current) setReceipt(value); }
    catch (err) { if (current === generation.current) setError((err as Error).message); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <section class="section remote-step-receipt" aria-label="Remote execution receipt">
    <p><strong>SSH worker {remote.workerId}</strong> · <span role="status">Receipt: {remote.state}</span>{remote.recovered ? " · inspected" : ""}</p>
    <p class="help">Request <code>{remote.requestId}</code>{remote.resultHead ? <> · result <code>{remote.resultHead.slice(0, 12)}</code></> : null}</p>
    {remote.ambiguous || remote.state === "unknown" ? <p class="msg err">The execution outcome is unknown. Inspect or request cancellation before using Resume. Inspection never launches another agent turn.</p> : null}
    <button class="btn small" disabled={busy} onClick={() => inspect()}>{busy ? "Contacting worker…" : "Inspect remote receipt"}</button>{!terminal ? <button class="btn small" disabled={busy} onClick={() => setConfirm(true)}>Cancel remote execution</button> : null}
    {confirm ? <div role="group" aria-label="Confirm remote cancellation"><p>Request cancellation of this exact worker request? A lost connection can prevent confirmation; an unknown receipt remains unresolved.</p><button class="btn small" disabled={busy} onClick={() => inspect(true)}>Request cancellation</button><button class="btn small" disabled={busy} onClick={() => setConfirm(false)}>Keep execution</button></div> : null}
    {receipt?.error ? <p class="help">{receipt.error}</p> : null}{error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}

function WorkerProbe({ worker }: { worker: RegisteredWorker }) {
  const [mapping, setMapping] = useState(worker.repoMappings[0] ?? ""), [probe, setProbe] = useState<Probe>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inspect = async () => { setBusy(true); setError(""); setProbe(undefined); try { setProbe(await post<Probe>(`/api/remote-workers/${encodeURIComponent(worker.id)}/probe`, { repoMapping: mapping })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return <article class="section" aria-label={`Worker ${worker.name}`}><h2>{worker.name}</h2><p class="help">Protocol {worker.protocol}{worker.containerProfile ? ` · Worker container: ${worker.containerProfile}` : " · Worker-local official CLIs"}</p>
    <label>Repository mapping<select aria-label={`Repository mapping for ${worker.name}`} value={mapping} disabled={busy} onChange={(event) => { setMapping(event.currentTarget.value); setProbe(undefined); }}>{worker.repoMappings.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
    <button class="btn" onClick={inspect} disabled={busy}>{busy ? "Connecting…" : "Check worker connection"}</button>
    {probe ? <div role="status"><p>{probe.capabilities.repoMappings.includes(mapping) ? "Repository mapping available" : "Repository mapping unavailable"}</p><ul>{probe.capabilities.providers.map((provider) => <li key={provider.id}>{provider.id}: {provider.available ? "CLI installed" : "CLI unavailable"}</li>)}</ul><p class="help">Login is checked when the selected CLI runs. Maximum source/result bundle: {Math.floor(probe.capabilities.maximumBundleBytes / 1024 / 1024)} MiB; staged context: {Math.floor(probe.capabilities.maximumContextBytes / 1024 / 1024)} MiB.</p></div> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </article>;
}
