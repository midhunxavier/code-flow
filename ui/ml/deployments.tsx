import { useEffect, useRef, useState } from "preact/hooks";
import { api, apiPath, enc, usePoll, signInAgain } from "../lib.js";
import { promotionConcerns, type RegisteredModel } from "../../src/ml/registry-model.js";
import { isLlm, type Experiment, type Probe, type Target } from "../../src/ml/model.js";
import { readInferenceStream } from "./inference-stream.js";
import type { Deployment, ResidentStatus } from "../../src/ml/deployment-model.js";
import type { Cycle } from "../../src/ml/cycle-model.js";
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
interface Props { project: string; enabled: boolean; deployments: Deployment[]; models: RegisteredModel[]; jobs: Experiment[]; targets: Target[]; cycles: Cycle[]; refresh: () => Promise<void> }
export function DeploymentPanel({ project, enabled, deployments, models, jobs, targets, cycles, refresh }: Props) {
  const [modelId, setModelId] = useState(""), [versionId, setVersionId] = useState(""), [targetId, setTargetId] = useState("local"), [name, setName] = useState(""), [reason, setReason] = useState("");
  const [device, setDevice] = useState("cpu"), [gpu, setGpu] = useState(""), [cpus, setCpus] = useState(1), [seconds, setSeconds] = useState(60), [maxRows, setRows] = useState(32), [inputTokens, setInputTokens] = useState(512), [outputTokens, setOutputTokens] = useState(64);
  const [persistent, setPersistent] = useState(true), [memoryMiB, setMemory] = useState(4096), [idleSeconds, setIdle] = useState(900), [lifetimeSeconds, setLifetime] = useState(28800);
  const [probe, setProbe] = useState<Probe>(), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState(""), [selected, setSelected] = useState("");
  const mounted = useRef(true), operation = useRef({ key: "", id: crypto.randomUUID() });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const model = models.find(m => m.id === modelId) ?? models[0], version = model?.versions.find(v => v.id === versionId) ?? model?.versions.find(v => v.id === model.selectedVersionId) ?? model?.versions.at(-1), job = jobs.find(e => e.id === version?.jobId);
  const llm = isLlm(job?.intent.spec), margin = cycles.find(c => c.id === job?.intent.search?.cycleId)?.limits.minImprovement ?? 0;
  const concerns = job ? promotionConcerns(job, undefined, margin) : [];
  useEffect(() => { if (job?.intent.model) { const output = Math.min(64, Math.floor(job.intent.model.contextLength / 4)); setOutputTokens(output); setInputTokens(Math.min(512, job.intent.model.contextLength - output)); } }, [model?.id]);
  const d = deployments.find(d => d.id === selected) ?? deployments[0];
  async function act(label: string, work: () => Promise<void>, success: string) {
    if (busy) return; setBusy(label); setError(""); setMessage("");
    try { await work(); if (mounted.current) { await refresh(); setMessage(success); } } catch (e) { if (mounted.current) setError((e as Error).message); } finally { if (mounted.current) setBusy(""); }
  }
  function chooseModel(value: string) { setModelId(value); setVersionId(""); setReviewed(false); const m = models.find(m => m.id === value), e = jobs.find(e => e.id === m?.versions[0]?.jobId); if (e?.intent.model) { const output = Math.min(64, Math.floor(e.intent.model.contextLength / 4)); setOutputTokens(output); setInputTokens(Math.min(512, e.intent.model.contextLength - output)); } }
  return <section class="pp-card" aria-label="Model deployments"><h3>Deploy and use a model</h3>
    <p>Use a registered model through an authenticated endpoint on your local computer or SSH server. Keep it loaded for repeated requests, or load it separately each time. Code Flow must stay running to receive requests.</p>
    <p>Persistent serving reserves one worker until you stop the deployment. Requests have explicit resource limits. Version changes load and check the candidate before switching the endpoint, with their own history.</p>
    {error ? <p role="alert">{error}</p> : null}{busy || message ? <p role="status">{busy ? `${busy}…` : message}</p> : null}
    {!models.length ? <p>Register a trained model version above to create its deployment.</p> : <details open={!deployments.length}><summary>Create a deployment</summary><form onSubmit={e => { e.preventDefault(); if (!model || !version || !job) return;
      const body = { project, repo: model.repo, name: name.trim() || model.name, modelId: model.id, versionId: version.id, target: targetId, config: { ...(persistent ? { mode: "persistent", memoryMiB, idleSeconds, lifetimeSeconds } : {}), device: llm ? device : "cpu", ...(llm && device === "cuda" ? { gpu } : {}), cpus, timeoutSeconds: seconds, maxRows, maxInputTokens: inputTokens, maxNewTokens: outputTokens }, reason: reason.trim(), reviewed };
      const key = JSON.stringify(body); if (key !== operation.current.key) operation.current = { key, id: crypto.randomUUID() };
      void act("Preparing deployment", async () => { const result = await post<Deployment>("/api/ml/deployments", { ...body, operationId: operation.current.id }); if (mounted.current) setSelected(result.id); }, "Deployment enabled. Use its endpoint or try an inference request below.");
    }}>
      <div class="ml-grid">
        <label>Model to deploy<select value={model?.id} disabled={!enabled || !!busy} onChange={e => chooseModel(e.currentTarget.value)}>{models.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
        <label>Version to deploy<select value={version?.id} disabled={!enabled || !!busy} onChange={e => { setVersionId(e.currentTarget.value); setReviewed(false); }}>{model?.versions.map(v => <option value={v.id} key={v.id}>v{v.number}{v.id === model.selectedVersionId ? " · registry selection" : ""}</option>)}</select></label>
        <label>Deployment name<input maxLength={100} value={name} placeholder={model?.name} disabled={!enabled || !!busy} onInput={e => setName(e.currentTarget.value)} /></label>
        <label>Inference computer<select value={targetId} disabled={!enabled || !!busy} onChange={e => { setTargetId(e.currentTarget.value); setProbe(undefined); setGpu(""); }}>{targets.map(t => <option value={t.id} key={t.id}>{t.name} · {t.kind}</option>)}</select></label>
      </div>
      <button type="button" class="btn" disabled={!enabled || !!busy} onClick={() => void act("Checking inference computer", async () => { const p = await post<Probe>(`/api/ml/targets/${enc(targetId)}/probe`, { serving: true }); if (mounted.current) setProbe(p); }, "Computer check complete.")}>Check inference computer</button>
      {probe ? <p>{probe.serving === 1 ? "Serving worker is available" : "Update this training worker to enable deployment"} · {probe.cpus} CPU threads. Prepare the matching recipe environment in the training controls above.</p> : null}
      {llm ? <p>The exact frozen base model must be prepared on this computer. Its context is {job?.intent.model?.contextLength} tokens. The adapter export is transferred automatically; base weights stay on the selected computer.</p> : null}
      <label class="ml-field">Serving mode<select value={persistent ? "persistent" : "on-demand"} disabled={!enabled || !!busy} onChange={e => setPersistent(e.currentTarget.value === "persistent")}><option value="persistent">Persistent · keep the model loaded</option><option value="on-demand">On demand · load for each request</option></select></label>
      {persistent ? <p>Memory is monitored and accelerator allocations are capped. Idle and lifetime limits unload the model; the next request warms it again. Stop this deployment before training on the same computer.</p> : null}
      <div class="ml-grid">
        {persistent ? <><label>Serving memory limit (MiB)<input type="number" min="256" max="262144" value={memoryMiB} disabled={!enabled || !!busy} onInput={e => setMemory(Number(e.currentTarget.value))} /></label><label>Unload after idle seconds<input type="number" min="10" max="3600" value={idleSeconds} disabled={!enabled || !!busy} onInput={e => setIdle(Number(e.currentTarget.value))} /></label><label>Maximum serving lifetime (seconds)<input type="number" min="30" max="86400" value={lifetimeSeconds} disabled={!enabled || !!busy} onInput={e => setLifetime(Number(e.currentTarget.value))} /></label></> : null}
        {llm ? <label>Inference device<select value={device} disabled={!enabled || !!busy} onChange={e => setDevice(e.currentTarget.value)}><option value="cpu">CPU</option><option value="mps">Apple GPU (MPS)</option><option value="cuda">NVIDIA GPU (CUDA)</option></select></label> : null}
        {llm && device === "cuda" ? <label>Inference NVIDIA GPU<select value={gpu} disabled={!enabled || !!busy} onChange={e => setGpu(e.currentTarget.value)}><option value="">Check the computer and choose a GPU</option>{probe?.gpus.map(g => <option key={g.uuid} value={g.uuid}>{g.name} · {g.uuid}</option>)}</select></label> : null}
        <label>Inference CPU threads<input type="number" min="1" max="32" value={cpus} disabled={!enabled || !!busy} onInput={e => setCpus(Number(e.currentTarget.value))} /></label>
        <label>Request timeout (seconds)<input type="number" min="5" max="90" value={seconds} disabled={!enabled || !!busy} onInput={e => setSeconds(Number(e.currentTarget.value))} /></label>
        {llm ? <><label>Maximum input tokens<input type="number" min="1" max="4096" value={inputTokens} disabled={!enabled || !!busy} onInput={e => setInputTokens(Number(e.currentTarget.value))} /></label><label>Maximum generated tokens<input type="number" min="1" max="512" value={outputTokens} disabled={!enabled || !!busy} onInput={e => setOutputTokens(Number(e.currentTarget.value))} /></label></> : <label>Maximum rows per request<input type="number" min="1" max="100" value={maxRows} disabled={!enabled || !!busy} onInput={e => setRows(Number(e.currentTarget.value))} /></label>}
        <label>Deployment reason<input maxLength={1000} value={reason} disabled={!enabled || !!busy} onInput={e => setReason(e.currentTarget.value)} /></label>
      </div>
      {concerns.length ? <><ul>{concerns.map(c => <li key={c}>{c}</li>)}</ul><label class="ml-check"><input type="checkbox" checked={reviewed} disabled={!enabled || !!busy} onChange={e => setReviewed(e.currentTarget.checked)} />I reviewed this result and want to deploy it.</label></> : null}
      <button class="btn primary" disabled={!enabled || !!busy || !reason.trim() || concerns.length > 0 && !reviewed}>Create deployment</button>
    </form></details>}
    {deployments.length ? <><label class="ml-field">Deployment<select value={d?.id} onChange={e => setSelected(e.currentTarget.value)}>{deployments.map(d => <option value={d.id} key={d.id}>{d.name} · {d.enabled ? "enabled" : "stopped"}</option>)}</select></label>{d ? <DeploymentUse key={d.id} d={d} model={models.find(m => m.id === d.modelId)!} jobs={jobs} cycles={cycles} enabled={enabled} busy={!!busy} act={act} /> : null}</> : null}
  </section>;
}
function DeploymentUse({ d, model, jobs, cycles, enabled, busy, act }: { d: Deployment; model: RegisteredModel; jobs: Experiment[]; cycles: Cycle[]; enabled: boolean; busy: boolean; act: (label: string, work: () => Promise<void>, success: string) => Promise<void> }) {
  const current = d.releases.find(r => r.id === d.current)!, number = (id: string) => model.versions.find(v => v.id === id)?.number;
  const [candidateId, setCandidateId] = useState(current.versionId), [reason, setReason] = useState(""), [reviewedKey, setReviewedKey] = useState(""), [input, setInput] = useState(JSON.stringify(current.base ? { prompt: "Write a short answer.", maxNewTokens: Math.min(32, d.config.maxNewTokens) } : { rows: [Object.fromEntries(current.features.map(f => [f, 0]))] }, null, 2));
  const [runtime, setRuntime] = useState<ResidentStatus>(), [streaming, setStreaming] = useState(true), [text, setText] = useState("");
  const abort = useRef<AbortController>();
  const persistent = d.config.mode === "persistent";
  usePoll(async current => { const status = await api<ResidentStatus>(`/api/ml/deployments/${enc(d.id)}/runtime`); if (current()) setRuntime(status); }, 5000, [d.id, d.revision], persistent);
  const [running, setRunning] = useState(false), [result, setResult] = useState<unknown>(), [error, setError] = useState("");
  useEffect(() => { setResult(undefined); setError(""); setText(""); }, [d.revision]);
  const mounted = useRef(true), operation = useRef({ key: "", id: crypto.randomUUID() }); useEffect(() => { mounted.current = true; return () => { mounted.current = false; abort.current?.abort(); }; }, []);
  const candidate = model.versions.find(v => v.id === candidateId) ?? model.versions[0]!, candidateJob = jobs.find(e => e.id === candidate.jobId)!, currentJob = jobs.find(e => e.id === model.versions.find(v => v.id === current.versionId)!.jobId)!;
  const concerns = promotionConcerns(candidateJob, currentJob, cycles.find(c => c.id === candidateJob.intent.search?.cycleId)?.limits.minImprovement ?? 0), reviewKey = `${d.revision}:${candidate.id}`;
  function change(action: "switch" | "rollback" | "stop" | "resume") {
    const body = { revision: d.revision, ...(action === "switch" || action === "rollback" ? { versionId: candidate.id } : {}), reason: reason.trim(), reviewed: action === "switch" && reviewedKey === reviewKey }, key = JSON.stringify({ action, ...body });
    if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() };
    void act(action === "stop" ? "Stopping new requests" : "Checking deployment version", async () => { await post(`/api/ml/deployments/${enc(d.id)}/${action}`, { ...body, operationId: operation.current.id }); }, action === "stop" ? (persistent ? "Deployment stopped. Resident cleanup is being confirmed." : "Deployment stopped. Dispatched requests finish within their original timeout.") : "Deployment version is ready for inference.");
  }
  async function predict(e: Event) {
    e.preventDefault(); if (running) return; setRunning(true); setError(""); setResult(undefined); setText("");
    const controller = new AbortController(); abort.current = controller;
    try {
      const body = JSON.parse(input);
      let response: unknown;
      if (persistent && current.base && streaming) {
        const result = await fetch(apiPath(`/api/ml/deployments/${enc(d.id)}/stream`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
        if (result.status === 401) signInAgain();
        response = await readInferenceStream(result, delta => { if (mounted.current) setText(previous => previous + delta); });
      } else response = await api(`/api/ml/deployments/${enc(d.id)}/predict`, { method: "POST", body: JSON.stringify(body), signal: controller.signal });
      if (mounted.current) setResult(response);
    } catch (e) { if (mounted.current) setError(controller.signal.aborted ? "Request cancelled. Stopping active generation may take a moment; check resident status before retrying." : (e as Error).message); }
    finally { if (mounted.current) setRunning(false); abort.current = undefined; }
  }
  return <div class="ml-detail"><h4>{d.name}</h4><p>{d.enabled ? persistent ? "Enabled · persistent" : "Enabled · on demand" : "Stopped"} · v{number(current.versionId)} · {d.target.name} · {d.config.device} · {d.config.timeoutSeconds}-second request timeout</p>
    {persistent ? <><p role="status">Resident model: {d.cleanupPending ? "cleanup pending" : runtime?.state ?? "checking"}{runtime?.memoryBytes !== undefined ? ` · ${Math.ceil(runtime.memoryBytes / 1024 ** 2)} MiB measured` : ""}{runtime?.reason ? ` · ${runtime.reason}` : ""}</p><p>{d.config.memoryMiB} MiB memory limit · unload after {d.config.idleSeconds} idle seconds · maximum lifetime {d.config.lifetimeSeconds} seconds</p><button class="btn" disabled={!enabled || !d.enabled || busy || running} onClick={() => void act("Warming selected model", async () => { const status = await post<ResidentStatus>(`/api/ml/deployments/${enc(d.id)}/warm`, {}); if (mounted.current) setRuntime(status); }, "Selected model is loaded.")}>Warm selected model</button></> : null}
    <p>POST <code>{apiPath(`/api/ml/deployments/${enc(d.id)}/predict`)}</code></p><p>Use the existing Code Flow owner authentication from your application backend. The SSH worker opens no public inference port. Rows, prompts and generated results are not retained by the serving runtime.</p>
    {persistent && current.base ? <p>Stream: POST <code>{apiPath(`/api/ml/deployments/${enc(d.id)}/stream`)}</code></p> : null}
    <form onSubmit={predict}>{persistent && current.base ? <label class="ml-check"><input type="checkbox" checked={streaming} disabled={running} onChange={e => setStreaming(e.currentTarget.checked)} />Stream the response as it is generated</label> : null}<label class="ml-field">Inference request JSON<textarea class="ml-inference-input" rows={7} maxLength={64000} value={input} disabled={running} onInput={e => { setInput(e.currentTarget.value); setResult(undefined); setError(""); }} /></label><p>{current.base ? `Up to ${d.config.maxInputTokens} input tokens and ${d.config.maxNewTokens} generated tokens. Supply a prompt or chat messages.` : `Supply up to ${d.config.maxRows} rows with these feature columns: ${current.features.join(", ")}. Replace the example values with your inputs.`}</p><button class="btn primary" disabled={!enabled || !d.enabled || busy || running}>{running ? "Running inference…" : current.base ? "Generate response" : "Run prediction"}</button>{running && persistent ? <button type="button" class="btn" onClick={() => abort.current?.abort()}>Cancel request</button> : null}</form>
    {error ? <p role="alert">{error}</p> : null}{running ? <p role="status">Loading the pinned model and running the request on {d.target.name}…</p> : null}{text ? <pre class="ml-log" tabIndex={0} aria-label="Streaming response" aria-live="polite">{text}</pre> : null}{result ? <pre class="ml-log" tabIndex={0} aria-label="Inference result">{JSON.stringify(result, null, 2)}</pre> : null}
    <details><summary>Switch version, roll back or stop</summary><div class="ml-grid"><label>Deployment version<select value={candidate.id} disabled={busy} onChange={e => setCandidateId(e.currentTarget.value)}>{model.versions.map(v => <option key={v.id} value={v.id}>v{v.number}{v.id === current.versionId ? " · deployed" : ""}</option>)}</select></label><label>Deployment change reason<input maxLength={1000} value={reason} disabled={busy} onInput={e => setReason(e.currentTarget.value)} /></label></div>
      {candidate.id !== current.versionId && concerns.length ? <><ul>{concerns.map(c => <li key={c}>{c}</li>)}</ul><label class="ml-check"><input type="checkbox" checked={reviewedKey === reviewKey} disabled={busy} onChange={e => setReviewedKey(e.currentTarget.checked ? reviewKey : "")} />I reviewed the comparison limits or regressions for this deployment.</label></> : null}
      <div class="ml-actions"><button class="btn" disabled={!enabled || busy || running || candidate.id === current.versionId || !reason.trim() || concerns.length > 0 && reviewedKey !== reviewKey} onClick={() => change("switch")}>Deploy v{candidate.number}</button><button class="btn" disabled={!enabled || busy || running || candidate.id === current.versionId || !d.releases.some(r => r.versionId === candidate.id) || !reason.trim()} onClick={() => change("rollback")}>Roll deployment back to v{candidate.number}</button><button class="btn" disabled={busy || !reason.trim() || !d.enabled && (!enabled || running)} onClick={() => change(d.enabled ? "stop" : "resume")}>{d.enabled ? "Stop deployment" : "Resume deployment"}</button></div><p>{persistent ? "Stop cancels active generation and releases the resident model. Finish the current request before switching. A switch briefly unloads the old model and attempts to restore it if the candidate fails." : "Changes do not redirect requests already dispatched. A stopped deployment accepts no new requests; existing ones finish within their original limits."}</p>
    </details>
    <details><summary>Deployment history ({d.history.length})</summary><ol>{d.history.slice().reverse().map(h => <li key={h.operationId}>{new Date(h.at).toLocaleString()} · {h.action} · v{number(d.releases.find(r => r.id === h.to)!.versionId)}: {h.reason}{h.comparison.length ? <p>Reviewed: {h.comparison.join("; ")}</p> : null}</li>)}</ol></details>
  </div>;
}
