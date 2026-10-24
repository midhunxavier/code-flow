import { useEffect, useRef, useState } from "preact/hooks";
import { api, apiPath, enc } from "../lib.js";
import { evaluatedModel, comparisonDifferences, modelContract, promotionConcerns, rankVersions, type RegisteredModel } from "../../src/ml/registry-model.js";
import type { Experiment } from "../../src/ml/model.js";
import type { Cycle } from "../../src/ml/cycle-model.js";
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
interface Props { project: string; enabled: boolean; models: RegisteredModel[]; jobs: Experiment[]; cycles: Cycle[]; refresh: () => Promise<void>; selectJob: (id: string) => void }
export function RegistryPanel({ project, enabled, models, jobs, cycles, refresh, selectJob }: Props) {
  const [jobId, setJobId] = useState(""), [destination, setDestination] = useState("new"), [name, setName] = useState(""), [notes, setNotes] = useState("");
  const [selected, setSelected] = useState(""), [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const registrationId = useRef(crypto.randomUUID()), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const eligible = jobs.filter(e => evaluatedModel(e) && !e.registry);
  const job = eligible.find(e => e.id === jobId) ?? eligible[0];
  const compatible = models.filter(m => m.repo === job?.repo && modelContract(jobs.find(e => e.id === m.versions[0]!.jobId)!) === modelContract(job));
  const target = compatible.find(m => m.id === destination);
  const model = models.find(m => m.id === selected) ?? models[0];
  const changed = () => { registrationId.current = crypto.randomUUID(); setError(""); setMessage(""); };
  async function act(label: string, work: () => Promise<void>) {
    if (busy) return; setBusy(label); setError(""); setMessage("");
    try { await work(); if (mounted.current) { await refresh(); setMessage(({ "Registering model version": "Model version registered.", "Promoting version": "Version promoted.", "Rolling back selection": "Selection rolled back.", "Restoring retained archive": "Retained archive restored." } as Record<string, string>)[label] ?? "Completed."); } }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(""); }
  }
  return <section class="pp-card" aria-label="Model registry"><h3>Model registry</h3>
    <p>Keep named versions of evaluated models, compare their results and choose the version to use. Promotion and rollback change the registry selection. Download the selected version to use it in your application.</p>
    <p>Registration retains a verified export on the Code Flow host, including models trained over SSH. Promotion, rollback and downloads can then work while the training server is offline. Up to 2 GiB of registered exports are retained.</p>
    {error ? <p role="alert">{error}</p> : null}{busy || message ? <p role="status">{busy ? `${busy}…` : message}</p> : null}
    <details open={!models.length}><summary>Register a trained model version</summary>
      {!eligible.length ? <p>Complete a training job or a search's final test to register another version. Validation trials and prepared base models are excluded.</p> : <form onSubmit={e => { e.preventDefault(); if (!job) return; void act("Registering model version", async () => {
        const result = await post<RegisteredModel>("/api/ml/registry", { project, repo: job.repo, jobId: job.id, operationId: registrationId.current, notes, ...(target ? { modelId: target.id, revision: target.revision } : { name: name.trim() || job.name }) });
        if (mounted.current) { setSelected(result.id); setDestination(result.id); setJobId(""); setNotes(""); registrationId.current = crypto.randomUUID(); }
      }); }}>
        <div class="ml-grid">
          <label>Evaluated training result<select value={job?.id} disabled={!enabled || !!busy} onChange={e => { setJobId(e.currentTarget.value); changed(); }}>{eligible.map(e => <option key={e.id} value={e.id}>{e.name} · {e.target.name} · {new Date(e.intent.createdAt).toLocaleString()}</option>)}</select></label>
          <label>Registry destination<select value={target?.id ?? "new"} disabled={!enabled || !!busy} onChange={e => { setDestination(e.currentTarget.value); changed(); }}><option value="new">Create a named model</option>{compatible.map(m => <option key={m.id} value={m.id}>{m.name} · add version {m.versions.length + 1}</option>)}</select></label>
          {!target ? <label>Registry model name<input maxLength={100} value={name} placeholder={job?.name} disabled={!enabled || !!busy} onInput={e => { setName(e.currentTarget.value); changed(); }} /></label> : null}
          <label>Version notes (optional)<input maxLength={1000} value={notes} disabled={!enabled || !!busy} onInput={e => { setNotes(e.currentTarget.value); changed(); }} /></label>
        </div>
        <p>Compatible versions share the repository, task and input/output contract. LoRA versions also share the frozen base model. Each registration records its dataset, compute and training configuration.</p>
        <button class="btn primary" disabled={!enabled || !!busy || !job}>Register version</button>
      </form>}
    </details>
    {models.length ? <><label class="ml-field">Registered model<select value={model?.id} onChange={e => { setSelected(e.currentTarget.value); setError(""); setMessage(""); }}>{models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.versions.length} {m.versions.length === 1 ? "version" : "versions"}</option>)}</select></label>
      {model ? <ModelVersions key={model.id} model={model} jobs={jobs} cycles={cycles} busy={!!busy} enabled={enabled} act={act} selectJob={selectJob} /> : null}
    </> : null}
  </section>;
}
function ModelVersions({ model, jobs, cycles, busy, enabled, act, selectJob }: { model: RegisteredModel; jobs: Experiment[]; cycles: Cycle[]; busy: boolean; enabled: boolean; act: (label: string, work: () => Promise<void>) => Promise<void>; selectJob: (id: string) => void }) {
  const [referenceId, setReferenceId] = useState(""), [candidateId, setCandidateId] = useState(""), [reason, setReason] = useState(""), [reviewedKey, setReviewedKey] = useState("");
  const operation = useRef({ key: "", id: crypto.randomUUID() });
  const version = model.versions.find(v => v.id === candidateId) ?? model.versions.at(-1)!;
  const reference = model.versions.find(v => v.id === referenceId) ?? model.versions.find(v => v.id === model.selectedVersionId) ?? model.versions[0]!;
  const current = model.versions.find(v => v.id === model.selectedVersionId), currentJob = jobs.find(e => e.id === current?.jobId), candidate = jobs.find(e => e.id === version.jobId)!;
  const ranking = rankVersions(model, jobs, reference.id), referenceJob = jobs.find(e => e.id === reference.jobId)!;
  const margin = cycles.find(c => c.id === candidate.intent.search?.cycleId)?.limits.minImprovement ?? 0;
  const concerns = promotionConcerns(candidate, currentJob, margin), reviewKey = `${model.revision}:${version.id}`;
  const canRollback = version.id !== model.selectedVersionId && model.history.some(h => h.to === version.id);
  function select(action: "promote" | "rollback") {
    const body = { versionId: version.id, revision: model.revision, reason: reason.trim(), reviewed: action === "promote" && reviewedKey === reviewKey };
    const key = JSON.stringify({ modelId: model.id, action, ...body });
    if (operation.current.key !== key) operation.current = { key, id: crypto.randomUUID() };
    void act(action === "promote" ? "Promoting version" : "Rolling back selection", async () => { await post(`/api/ml/registry/${enc(model.id)}/${action}`, { ...body, operationId: operation.current.id }); });
  }
  return <div class="ml-detail">
    <h4>{model.name}</h4><p>{current ? `Selected version: v${current.number}` : "No version has been selected"} · Registry revision {model.revision}</p>
    {current ? <a class="btn primary" href={apiPath(`/api/ml/versions/${enc(current.id)}/export`)}>Download selected v{current.number}</a> : null}
    <label class="ml-field">Compare against version<select value={reference.id} onChange={e => setReferenceId(e.currentTarget.value)}>{model.versions.map(v => <option value={v.id} key={v.id}>v{v.number} · {jobs.find(e => e.id === v.jobId)?.name}</option>)}</select></label>
    <p>{ranking.length} of {model.versions.length} versions share this evaluation. {ranking[0] ? `Best score in this comparison: v${ranking[0].version.number}.` : ""} Scores from different datasets, splits or evaluators are shown for context and are not ranked together. Lower completion loss or RMSE is better; higher accuracy is better.</p>
    <div class="ml-table-scroll" role="region" aria-label="Model version comparison" tabIndex={0}><table class="ml-registry-table"><caption>Registered model versions</caption><thead><tr><th>Version</th><th>Final score</th><th>Baseline</th><th>Comparison</th><th>Training computer</th><th>Dataset</th></tr></thead><tbody>{model.versions.slice().reverse().map(v => { const e = jobs.find(e => e.id === v.jobId)!, score = e.status.evaluation!, differences = comparisonDifferences(e, referenceJob); return <tr key={v.id}><td><button class="btn" aria-pressed={v.id === version.id} onClick={() => setCandidateId(v.id)}>v{v.number}{v.id === current?.id ? " · selected" : ""}</button></td><td>{score.candidate.toFixed(4)} {score.metric}</td><td>{score.baseline.toFixed(4)}</td><td>{differences.length ? differences.join("; ") : v.id === ranking[0]?.version.id ? "Best comparable score" : "Comparable"}</td><td>{e.target.name} · {e.target.kind}</td><td><code>{score.datasetHash.slice(0, 12)}</code></td></tr>; })}</tbody></table></div>
    <div class="ml-grid"><label>Version to use<select value={version.id} disabled={busy} onChange={e => setCandidateId(e.currentTarget.value)}>{model.versions.map(v => <option value={v.id} key={v.id}>v{v.number}{v.id === current?.id ? " · selected" : ""}</option>)}</select></label><label>Selection or rollback reason<input maxLength={1000} value={reason} disabled={busy} placeholder="Why this version should be used" onInput={e => setReason(e.currentTarget.value)} /></label></div>
    {version.id !== current?.id && concerns.length ? <div><p>Review before promotion:</p><ul>{concerns.map(c => <li key={c}>{c}</li>)}</ul><label class="ml-check"><input type="checkbox" checked={reviewedKey === reviewKey} disabled={busy} onChange={e => setReviewedKey(e.currentTarget.checked ? reviewKey : "")} />I reviewed these comparison limits or regressions and want to select this version.</label></div> : null}
    <div class="ml-actions"><button class="btn primary" disabled={!enabled || busy || version.id === current?.id || !reason.trim() || concerns.length > 0 && reviewedKey !== reviewKey} onClick={() => select("promote")}>Promote v{version.number}</button><button class="btn" disabled={busy || !canRollback || !reason.trim()} onClick={() => select("rollback")}>Roll back to v{version.number}</button><a class="btn" href={apiPath(`/api/ml/versions/${enc(version.id)}/export`)}>Download v{version.number}</a><button class="btn" disabled={busy} onClick={() => selectJob(version.jobId)}>View training result</button></div>
    <details><summary>Version v{version.number} provenance and recovery</summary><p>Registered {new Date(version.registeredAt).toLocaleString()}{version.notes ? ` · ${version.notes}` : ""}</p><p>Job <code>{version.jobId}</code> · Commit <code>{candidate.intent.source?.commit}</code></p><p>Model hash <code>{candidate.status.evaluation!.modelHash}</code></p><p>Split hash <code>{candidate.status.evaluation!.splitHash}</code> · Worker bundle <code>{candidate.intent.bundle}</code></p>{candidate.intent.model ? <p>Required base model <code>{candidate.intent.model.hash}</code>. The LoRA export contains its adapter and tokenizer; keep these base weights available for inference.</p> : null}<pre class="ml-log">{JSON.stringify(candidate.intent.spec, null, 2)}</pre><p>If the retained archive is missing or damaged, restore the exact export from {candidate.target.name}. This needs the original training computer to be reachable.</p><button class="btn" disabled={busy} onClick={() => void act("Restoring retained archive", async () => { await post(`/api/ml/versions/${enc(version.id)}/restore`, {}); })}>Restore archive from training computer</button></details>
    <details><summary>Promotion and rollback history ({model.history.length})</summary>{model.history.length ? <ol>{model.history.slice().reverse().map(h => <li key={h.id}>{new Date(h.at).toLocaleString()} · {h.action === "rollback" ? "Rolled back" : "Promoted"} {h.from ? `v${model.versions.find(v => v.id === h.from)!.number} → ` : ""}v{model.versions.find(v => v.id === h.to)!.number}: {h.reason}{h.comparison.length ? <p>Reviewed: {h.comparison.join("; ")}</p> : null}</li>)}</ol> : <p>Promotions and rollbacks will be recorded here.</p>}</details>
  </div>;
}
