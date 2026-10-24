import { PromotionPanel } from "./promotions.js";
import type { PromotionPolicy } from "../../src/ml/promotion-model.js";
import { MonitorPanel } from "./monitors.js";
import type { ModelMonitor } from "../../src/ml/monitor-model.js";
import { DeploymentPanel } from "./deployments.js";
import type { Deployment } from "../../src/ml/deployment-model.js";
import { RegistryPanel } from "./registry.js";
import type { RegisteredModel } from "../../src/ml/registry-model.js";
import { SchedulePanel, scheduleDefaults, type ScheduleDraft } from "./schedules.js";
import type { TrainingSchedule } from "../../src/ml/schedule-model.js";
import { cycleTerminal, type Cycle } from "../../src/ml/cycle-model.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, apiPath, enc, usePoll, workspaceId } from "../lib.js";
import { ProjectDraftStore } from "../project-context.js";
import type { Project } from "../types.js";
import { RECIPE, LLM_RECIPE, terminal, isLlm, type JobSpec, type Recipe, type LlmSpec, type Experiment, type Probe, type Target, type Task } from "../../src/ml/model.js";
import type { SnapshotRecord } from "../../src/ml/store.js";
interface Overview { promotions: PromotionPolicy[]; monitors: ModelMonitor[]; enabled: boolean; revision: number; targets: Target[]; defaultTarget: string; datasets: SnapshotRecord[]; experiments: Experiment[]; cycles: Cycle[]; schedules: TrainingSchedule[]; registry: RegisteredModel[]; deployments: Deployment[] }
interface Draft extends ScheduleDraft { purpose: "training" | "holdout"; searchIterations: number; searchMinutes: number; elapsedMinutes: number; patience: number; minImprovement: number; objective: string; planner: "builtin" | "claude"; plannerModel: string; recipe: Recipe; modelPath: string; model: string; device: LlmSpec["device"]; gpu: string; maxLength: number; maxSteps: number; rank: number; learningRate: number; accumulation: number; repo: string; target: string; path: string; location: "target" | "controller"; name: string; task: Task; label: string; split: "random" | "group" | "time"; splitColumn: string; minutes: number; cpus: number; snapshot: string; independent: boolean; operationId: string }
const drafts = new ProjectDraftStore<Draft>(`ml-draft-v1:${workspaceId ?? "local"}:`);
const initial = (project: Project, target = "local"): Draft => ({ ...scheduleDefaults(), purpose: "training", searchIterations: 3, searchMinutes: 6, elapsedMinutes: 90, patience: 2, minImprovement: 0, objective: "Improve validation quality within the training budget", planner: "builtin", plannerModel: "sonnet", recipe: RECIPE, modelPath: "", model: "", device: "cpu", gpu: "", maxLength: 512, maxSteps: 100, rank: 8, learningRate: 0.0002, accumulation: 4, repo: project.repos[0] ?? "", target, path: "", location: "target", name: "Prediction model", task: "classification", label: "", split: "random", splitColumn: "", minutes: 2, cpus: 2, snapshot: "", independent: false, operationId: crypto.randomUUID() });
const specSummary = (s?: JobSpec) => !s ? "Not proposed" : isLlm(s) ? `LR ${s.learningRate} · rank ${s.rank} · ${s.maxSteps} steps · accumulation ${s.accumulation}` : `${s.forest?.trees ?? 64} trees · depth ${s.forest?.depth ?? 16}`;
const labels = { submitted: "Starting", preparing: "Preparing", training: "Training", evaluating: "Evaluating", exporting: "Preparing export", succeeded: "Finished", failed: "Failed", cancel_requested: "Cancellation pending", cancelled: "Cancelled", unknown: "Outcome unknown" };
const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

export function MlWorkspace({ project }: { project: Project }) {
  const [overview, setOverview] = useState<Overview>();
  const [draft, setDraft] = useState<Draft>();
  const [probe, setProbe] = useState<Probe>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [message, setMessage] = useState("");
  const [serverForm, setServerForm] = useState(false);
  const [selected, setSelected] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([api<Overview>(`/api/ml?project=${enc(project.id)}`), drafts.read(project.id)]).then(([data, saved]) => {
      if (!mounted.current) return;
      setOverview(data); setDraft(saved ? { ...initial(project), ...saved } : initial(project, data.defaultTarget));
    }).catch(e => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; };
  }, [project.id]);
  usePoll(async current => { const data = await api<Overview>(`/api/ml?project=${enc(project.id)}`); if (current()) setOverview(data); }, 3000, [project.id]);
  function selectJob(value: string) {
    setSelected(value);
    requestAnimationFrame(() => { const detail = document.getElementById("ml-experiment-details"); detail?.focus({ preventScroll: true }); detail?.scrollIntoView({ block: "start", behavior: "smooth" }); });
  }
  async function refresh() { const data = await api<Overview>(`/api/ml?project=${enc(project.id)}`); if (mounted.current) setOverview(data); }
  function edit(patch: Partial<Draft>, inputs = false) {
    if (!draft) return;
    const next = { ...draft, ...patch, operationId: crypto.randomUUID(), ...(inputs ? { snapshot: "", label: "", independent: false } : {}) };
    setDraft(next);
    void drafts.write(project.id, next).then(() => { if (mounted.current) setSaveError(""); }, () => { if (mounted.current) setSaveError("Your draft could not be saved. Keep this page open and retry saving."); });
  }
  async function act(label: string, work: () => Promise<void>) {
    if (busy) return; setBusy(label); setError(""); setMessage("");
    try { await work(); if (mounted.current) await refresh(); }
    catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(""); }
  }
  if (!overview || !draft) return <section class="pp-card"><h2>Model training</h2>{error ? <p role="alert">{error}</p> : <p role="status">Loading training workspace…</p>}</section>;
  const target = overview.targets.find(t => t.id === draft.target);
  const llm = draft.recipe === LLM_RECIPE;
  const snapshot = overview.datasets.find(d => d.purpose !== "holdout" && d.id === draft.snapshot && d.target.id === draft.target && d.repo === draft.repo && (d.dataset.format === "jsonl") === llm);
  const models = overview.experiments.filter(e => e.intent.kind === "model" && e.status.state === "succeeded" && e.status.model && e.target.id === draft.target && e.repo === draft.repo);
  const model = models.find(e => e.id === draft.model);
  const capability = probe?.recipes?.find(r => r.id === draft.recipe) ?? (!llm ? probe : undefined);
  const devices = probe?.recipes?.find(r => r.id === LLM_RECIPE)?.devices ?? [];
  const selectedJob = overview.experiments.find(e => e.id === selected);
  const unavailable = !project.repos.includes(draft.repo) || !target;
  const active = overview.cycles.some(c => !cycleTerminal(c)) || overview.experiments.some(e => !terminal(e.status.state));
  const searchReady = !unavailable && !!snapshot && !!draft.name.trim() && (llm ? !!model && (draft.device !== "cuda" || !!draft.gpu) : !!draft.label && !snapshot.dataset.missing[draft.label] && (draft.split === "random" ? draft.independent : !!draft.splitColumn));
  const searchTraining = () => ({ project: project.id, repo: draft.repo, name: draft.name, dataset: draft.snapshot, operationId: draft.operationId, ...(llm ? { recipe: LLM_RECIPE, model: draft.model } : {}), spec: llm ? { task: "sft", device: draft.device, ...(draft.device === "cuda" ? { gpu: draft.gpu } : {}), maxLength: draft.maxLength, maxSteps: draft.maxSteps, rank: draft.rank, learningRate: draft.learningRate, accumulation: draft.accumulation, seed: 42, trainSeconds: draft.minutes * 60, cpus: draft.cpus } : { task: draft.task, label: draft.label, split: draft.split === "random" ? { kind: "random" } : { kind: draft.split, column: draft.splitColumn }, seed: 42, trainSeconds: draft.minutes * 60, cpus: draft.cpus } });
  const fieldsDisabled = !!busy || !overview.enabled;
  return <div class="ml-workspace">
    <section class="pp-card"><div class="ml-heading"><div><h2>Model training <span class="ml-preview">Preview</span></h2><p>Train a prediction model or fine-tune a language model on your computer or your own server. No cloud training account is required.</p></div><span class="ml-recipe">{llm ? "TRL + PEFT · LoRA" : "AutoGluon · CPU"}</span></div>
      <label class="ml-field">Training recipe<select value={draft.recipe} disabled={fieldsDisabled} onChange={e => edit({ recipe: e.currentTarget.value as Recipe, name: e.currentTarget.value === LLM_RECIPE ? "Language model adapter" : "Prediction model" }, true)}><option value={RECIPE}>Tabular prediction — classification or regression</option><option value={LLM_RECIPE}>Language model fine-tuning — LoRA</option></select></label>
      {!overview.enabled ? <p role="status">New training is disabled. Start Code Flow with <code>CODEFLOW_ML_ENABLED=true</code> to enable this preview. Existing jobs remain inspectable and cancellable.</p> : null}
      {error ? <p class="error" role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
      {saveError ? <p role="alert">{saveError} <button class="btn" onClick={() => void drafts.write(project.id, draft).then(() => setSaveError(""), () => {})}>Retry saving</button></p> : null}
      {unavailable ? <p role="alert">The saved repository or computer is unavailable. Your draft is retained; choose an explicit destination.</p> : null}
    </section>
    <section class="pp-card" aria-label="Training computer"><h3>1. Choose your computer</h3>
      <div class="ml-grid">
        <label>Project repository<select value={draft.repo} disabled={fieldsDisabled} onChange={e => edit({ repo: e.currentTarget.value, model: "" }, true)}><option value="">Choose repository</option>{project.repos.map(repo => <option key={repo} value={repo}>{repo}</option>)}</select></label>
        <label>Training computer<select value={draft.target} disabled={fieldsDisabled} onChange={e => { setProbe(undefined); edit({ target: e.currentTarget.value, model: "", gpu: "" }, true); }}><option value="">Choose computer</option>{overview.targets.map(t => <option key={t.id} value={t.id}>{t.name}{overview.defaultTarget === t.id ? " · project default" : ""}</option>)}</select></label>
      </div>
      <div class="ml-actions">
        <button class="btn" disabled={fieldsDisabled || !target} onClick={() => void act("Checking computer", async () => { const result = await post<Probe>(`/api/ml/targets/${enc(draft.target)}/probe`); if (mounted.current) setProbe(result); })}>Check computer</button>
        <button class="btn" disabled={fieldsDisabled || unavailable} onClick={() => void act("Saving default", async () => { await post("/api/ml/defaults", { project: project.id, repo: draft.repo, target: draft.target, revision: overview.revision }); setMessage("This computer is now the project default."); })}>Use by default for this project</button>
        <button class="btn" disabled={fieldsDisabled} onClick={() => setServerForm(!serverForm)}>Add SSH server</button>
      </div>
      {target ? <p class="muted">{target.kind === "local" ? "This project's computer" : `SSH: ${target.host}`} · Worker files: <code>{target.directory}</code></p> : null}
      {target ? <PythonSettings key={`${target.id}:${target.revision}`} target={target} disabled={fieldsDisabled || active} onSave={python => act("Saving Python settings", async () => { await post(`/api/ml/targets/${enc(target.id)}/settings`, { python, revision: target.revision }); setProbe(undefined); })} /> : null}
      {probe ? <div class="ml-capability" role="status"><strong>{probe.hostname}</strong> · {probe.platform} · {probe.cpus} CPU threads · {Math.round(probe.freeBytes / 1073741824)} GiB free disk
        <p>{probe.gpus.length ? probe.gpus.map(g => `${g.name} · ${Math.round((g.freeMiB ?? g.memoryMiB) / 1024)} GiB available`).join(", ") : "No NVIDIA GPU detected."}{devices.includes("mps") ? " Apple GPU available." : ""}</p>
        {llm && !capability ? <p>Update this worker to enable language-model fine-tuning.</p> : capability?.ready ? <p>Selected recipe's environment is ready.</p> : <><p>{capability?.issue}</p><p>Install locked packages from PyPI into this recipe's private environment. Python 3.12 must already be installed.</p><button class="btn" disabled={fieldsDisabled || unavailable || active} onClick={() => void act("Starting environment setup", async () => { const job = await post<Experiment>(`/api/ml/targets/${enc(draft.target)}/setup`, { project: project.id, repo: draft.repo, operationId: crypto.randomUUID(), ...(llm ? { recipe: LLM_RECIPE } : {}) }); setSelected(job.id); setProbe(undefined); })}>Install training environment</button></>}
        <button class="btn" disabled={fieldsDisabled || unavailable || active} onClick={() => void act("Updating worker", async () => { setProbe(await post<Probe>(`/api/ml/targets/${enc(draft.target)}/upgrade`)); })}>Update training worker</button>
      </div> : null}
      {serverForm ? <ServerForm disabled={fieldsDisabled} onSave={body => act("Registering server", async () => { const result = await post<Target>("/api/ml/targets", body); edit({ target: result.id }, true); setServerForm(false); setProbe(undefined); })} /> : null}
    </section>
    {llm ? <section class="pp-card" aria-label="Base language model"><h3>2. Prepare your base model</h3>
      <p>Use an existing Hugging Face model folder on {target?.name ?? "the training computer"}. Supported: Llama, Qwen2, Qwen3 and GPT-2 with safetensors weights and a tokenizer. Up to 8B parameters and 16 GiB of files. CPU is limited to 150M parameters; larger models need sufficient GPU memory.</p>
      <label class="ml-field">Base model folder<input placeholder="/absolute/path/base-model" value={draft.modelPath} disabled={fieldsDisabled} onInput={e => edit({ modelPath: e.currentTarget.value })} /></label>
      <p class="muted">Preparation copies and hashes the model on that computer. It needs additional disk space equal to the model size. Model downloads and access to gated models are managed by you; Code Flow trains offline.</p>
      <button class="btn" disabled={fieldsDisabled || unavailable || active || !draft.modelPath.trim()} onClick={() => void act("Preparing base model", async () => { const job = await post<Experiment>("/api/ml/models", { project: project.id, repo: draft.repo, target: draft.target, path: draft.modelPath, operationId: crypto.randomUUID() }); setSelected(job.id); edit({ model: job.id }); })}>Prepare base model</button>
      <label class="ml-field">Prepared base model<select value={model ? draft.model : ""} disabled={fieldsDisabled} onChange={e => edit({ model: e.currentTarget.value })}><option value="">{active && draft.model ? "Preparation in progress — see jobs below" : "Choose a prepared model"}</option>{models.map(m => <option key={m.id} value={m.id}>{m.status.model!.architecture} · {m.status.model!.parameters.toLocaleString()} parameters · {m.status.model!.hash.slice(0, 12)}</option>)}</select></label>
    </section> : null}
    <section class="pp-card" aria-label="Training dataset"><h3>{llm ? "3" : "2"}. Prepare your dataset</h3>
      <div class="ml-grid"><label>Dataset purpose<select value={draft.purpose} disabled={fieldsDisabled} onChange={e => edit({ purpose: e.currentTarget.value as Draft["purpose"] }, true)}><option value="training">Training and experiments</option><option value="holdout">Common holdout — evaluation only</option></select></label><label>Dataset path<input placeholder={llm ? "/absolute/path/examples.jsonl" : "/absolute/path/examples.csv"} value={draft.path} disabled={fieldsDisabled} onInput={e => edit({ path: e.currentTarget.value }, true)} /></label>
        {target?.kind === "ssh" ? <label>Dataset is on<select value={draft.location} disabled={fieldsDisabled} onChange={e => edit({ location: e.currentTarget.value as Draft["location"] }, true)}><option value="target">Training server</option><option value="controller">Project computer — copy to training server</option></select></label> : null}
      </div>
      <p class="muted">{llm ? "JSONL, 30–10,000 examples, up to 32 MiB. Use prompt/completion pairs or messages conversations; an optional group keeps related examples together." : "CSV or Parquet, up to 128 MiB and 250,000 rows."} Preparation creates an immutable copy on {target?.name ?? "the selected computer"}. Original data stays unchanged.</p>
      {llm ? <details><summary>Example JSONL formats</summary><pre class="ml-log">{'{"prompt":"Classify this message: Great service!\\nAnswer:","completion":"positive","group":"customer-1"}\n\nOr one conversation per line:\n{"messages":[{"role":"user","content":"What is LoRA?"},{"role":"assistant","content":"A method for training small model adapters."}],"group":"topic-1"}'}</pre><p>Use one format throughout the file. Conversations must alternate user and assistant turns, with an optional first system message. The final assistant answer is trained. Conversations require a compatible chat template in the model folder. Duplicate prompts and explicit groups stay in the same partition.</p></details> : null}
      <button class="btn" disabled={fieldsDisabled || unavailable || !draft.path.trim()} onClick={() => void act("Preparing dataset", async () => { const data = await post<SnapshotRecord>("/api/ml/datasets", { project: project.id, repo: draft.repo, target: draft.target, path: draft.path, location: draft.location, ...(draft.purpose === "holdout" ? { purpose: "holdout" } : {}) }); if (mounted.current) edit({ snapshot: data.id }); })}>Prepare dataset{draft.location === "controller" && target?.kind === "ssh" ? " and transfer" : ""}</button>
      {draft.purpose === "holdout" ? <p>Use 30–10,000 independent labeled examples that neither model used for training, tuning or its original test. Stop persistent serving before preparing this snapshot, then resume it. Reserved holdouts cannot be selected for training. Choose this snapshot in a promotion policy below.</p> : null}
      {overview.datasets.find(d => d.id === draft.snapshot)?.purpose === "holdout" ? <p role="status">Common holdout prepared and reserved for evaluation.</p> : null}
      {snapshot ? <div class="ml-capability"><p><strong>{snapshot.dataset.rows.toLocaleString()} rows</strong> · {snapshot.dataset.columns.length} columns · {snapshot.dataset.duplicateRows} duplicate rows will be removed</p><p>Snapshot: <code>{snapshot.dataset.hash.slice(0, 16)}</code></p></div> : null}
    </section>
    {llm ? <section class="pp-card" aria-label="Fine-tuning configuration"><h3>4. Fine-tune your model</h3>
      <div class="ml-grid"><label>Experiment name<input value={draft.name} disabled={fieldsDisabled} onInput={e => edit({ name: e.currentTarget.value })} /></label>
        <label>Training device<select value={draft.device} disabled={fieldsDisabled} onChange={e => edit({ device: e.currentTarget.value as LlmSpec["device"], gpu: "" })}><option value="cpu">CPU — small models</option><option value="mps">Apple GPU (MPS)</option><option value="cuda">NVIDIA GPU (CUDA)</option></select></label>
        {draft.device === "cuda" ? <label>NVIDIA GPU<select value={draft.gpu} disabled={fieldsDisabled} onChange={e => edit({ gpu: e.currentTarget.value })}><option value="">Check computer, then choose a GPU</option>{probe?.gpus.map(g => <option key={g.uuid} value={g.uuid}>{g.name} · {g.uuid}</option>)}</select></label> : null}
      </div>
      {probe && !devices.includes(draft.device) ? <p role="status">The selected device is unavailable in this recipe's environment. Install the environment or choose an available device.</p> : null}
      <details><summary>Training settings and limits</summary><div class="ml-grid">
        <label>Training minutes<input type="number" min="1" max="60" value={draft.minutes} disabled={fieldsDisabled} onInput={e => edit({ minutes: Number(e.currentTarget.value) })} /></label>
        <label>Maximum steps<input type="number" min="1" max="2000" value={draft.maxSteps} disabled={fieldsDisabled} onInput={e => edit({ maxSteps: Number(e.currentTarget.value) })} /></label>
        <label>Sequence length (tokens)<input type="number" min="32" max="2048" value={draft.maxLength} disabled={fieldsDisabled} onInput={e => edit({ maxLength: Number(e.currentTarget.value) })} /></label>
        <label>LoRA rank<input type="number" min="4" max="64" value={draft.rank} disabled={fieldsDisabled} onInput={e => edit({ rank: Number(e.currentTarget.value) })} /></label>
        <label>Learning rate<input type="number" min="0.000001" max="0.001" step="0.000001" value={draft.learningRate} disabled={fieldsDisabled} onInput={e => edit({ learningRate: Number(e.currentTarget.value) })} /></label>
        <label>Gradient accumulation<input type="number" min="1" max="16" value={draft.accumulation} disabled={fieldsDisabled} onInput={e => edit({ accumulation: Number(e.currentTarget.value) })} /></label>
        <label>CPU threads<input type="number" min="1" max="32" value={draft.cpus} disabled={fieldsDisabled} onInput={e => edit({ cpus: Number(e.currentTarget.value) })} /></label>
      </div></details>
      <p>Only completion tokens contribute to training and evaluation. Compare the adapter with the original model on a held-out test partition. Examples longer than the sequence limit are rejected. Maximum total job time: {draft.minutes + 30} minutes, including preparation and evaluation.</p>
      <button class="btn primary" disabled={fieldsDisabled || unavailable || active || !snapshot || !model || !draft.name.trim() || draft.device === "cuda" && !draft.gpu} onClick={() => void act("Starting fine-tuning", async () => {
        await drafts.write(project.id, draft);
        const job = await post<Experiment>("/api/ml/experiments", { project: project.id, repo: draft.repo, name: draft.name, recipe: LLM_RECIPE, model: draft.model, dataset: draft.snapshot, operationId: draft.operationId, spec: { task: "sft", device: draft.device, ...(draft.device === "cuda" ? { gpu: draft.gpu } : {}), maxLength: draft.maxLength, maxSteps: draft.maxSteps, rank: draft.rank, learningRate: draft.learningRate, accumulation: draft.accumulation, seed: 42, trainSeconds: draft.minutes * 60, cpus: draft.cpus } });
        setSelected(job.id); setMessage("Fine-tuning is recorded. You can close this page and return to its result.");
      })}>Fine-tune model</button>
      {busy ? <p role="status">{busy}…</p> : active ? <p role="status">A job is active or unresolved. Inspect its status below before starting another.</p> : null}
    </section> : (
    <section class="pp-card" aria-label="Training configuration"><h3>3. Choose what to predict</h3>
      <div class="ml-grid"><label>Experiment name<input value={draft.name} disabled={fieldsDisabled} onInput={e => edit({ name: e.currentTarget.value })} /></label><label>Task<select value={draft.task} disabled={fieldsDisabled} onChange={e => edit({ task: e.currentTarget.value as Task })}><option value="classification">Classification — predict a category</option><option value="regression">Regression — predict a number</option></select></label>
        <label>Target column<select value={draft.label} disabled={fieldsDisabled || !snapshot} onChange={e => edit({ label: e.currentTarget.value })}><option value="">Choose a target</option>{snapshot?.dataset.columns.map(c => <option value={c} key={c}>{c}</option>)}</select></label>
        <label>Split strategy<select value={draft.split} disabled={fieldsDisabled} onChange={e => edit({ split: e.currentTarget.value as Draft["split"], independent: false })}><option value="random">Random — independent rows</option><option value="group">Keep groups together</option><option value="time">Earlier rows train, later rows test</option></select></label>
        {draft.split !== "random" ? <label>{draft.split === "group" ? "Group column" : "Time column"}<select value={draft.splitColumn} disabled={fieldsDisabled || !snapshot} onChange={e => edit({ splitColumn: e.currentTarget.value })}><option value="">Choose column</option>{snapshot?.dataset.columns.filter(c => c !== draft.label).map(c => <option value={c} key={c}>{c}</option>)}</select></label> : null}
      </div>
      {draft.split === "random" ? <label class="ml-check"><input type="checkbox" checked={draft.independent} disabled={fieldsDisabled} onChange={e => edit({ independent: e.currentTarget.checked })} />These rows are independent. They do not contain related people, groups or time sequences that must stay together.</label> : <p class="muted">The group/time column controls splitting and is excluded from model features.</p>}
      {snapshot && draft.label && snapshot.dataset.missing[draft.label] ? <p role="alert">The selected target has {snapshot.dataset.missing[draft.label]} missing labels. Prepare complete examples before training.</p> : null}
      <details><summary>Time and CPU limits</summary><div class="ml-grid"><label>Training minutes<input type="number" min="1" max="60" value={draft.minutes} disabled={fieldsDisabled} onInput={e => edit({ minutes: Number(e.currentTarget.value) })} /></label><label>CPU threads<input type="number" min="1" max="32" value={draft.cpus} disabled={fieldsDisabled} onInput={e => edit({ cpus: Number(e.currentTarget.value) })} /></label></div></details>
      <p>Compare against a {draft.task === "classification" ? "majority-class" : "mean-value"} baseline on a separate test partition. Maximum total job time: {draft.minutes + 10} minutes, including preparation and evaluation.</p>
      <button class="btn primary" disabled={fieldsDisabled || unavailable || active || !snapshot || !draft.label || !!snapshot.dataset.missing[draft.label] || draft.split === "random" && !draft.independent || draft.split !== "random" && !draft.splitColumn} onClick={() => void act("Starting training", async () => {
        await drafts.write(project.id, draft);
        const job = await post<Experiment>("/api/ml/experiments", { project: project.id, repo: draft.repo, name: draft.name, dataset: draft.snapshot, operationId: draft.operationId, spec: { task: draft.task, label: draft.label, split: draft.split === "random" ? { kind: "random" } : { kind: draft.split, column: draft.splitColumn }, seed: 42, trainSeconds: draft.minutes * 60, cpus: draft.cpus } });
        if (mounted.current) { setSelected(job.id); setMessage("Training is recorded. You can close this page and return to its result."); }
      })}>Train model</button>
      {busy ? <p role="status">{busy}…</p> : active ? <p role="status">A job is active or unresolved. Inspect its status below before starting another.</p> : null}
    </section>
    )}
    <section class="pp-card" aria-label="Automatic experiments"><h3>Improve within limits</h3>
      <p>Run several configurations on {target?.name ?? "your selected computer"}, compare validation results and test the selected model once. Each trial starts from the same frozen inputs. Models are exported for your review.</p>
      <div class="ml-grid">
        <label>Experiment planner<select value={draft.planner} disabled={fieldsDisabled} onChange={e => edit({ planner: e.currentTarget.value as Draft["planner"] })}><option value="builtin">Built-in search · fully offline</option><option value="claude">Claude CLI · uses your existing login</option></select></label>
        {draft.planner === "claude" ? <label>Planner model<input value={draft.plannerModel} disabled={fieldsDisabled} onInput={e => edit({ plannerModel: e.currentTarget.value })} /></label> : null}
        <label>Maximum iterations<input type="number" min="1" max="8" value={draft.searchIterations} disabled={fieldsDisabled} onInput={e => edit({ searchIterations: Number(e.currentTarget.value) })} /></label>
        <label>Total training budget (minutes)<input type="number" min="1" max="480" value={draft.searchMinutes} disabled={fieldsDisabled} onInput={e => edit({ searchMinutes: Number(e.currentTarget.value) })} /></label>
        <label>Total elapsed limit (minutes)<input type="number" min="1" max="1440" value={draft.elapsedMinutes} disabled={fieldsDisabled} onInput={e => edit({ elapsedMinutes: Number(e.currentTarget.value) })} /></label>
        <label>Stop after trials without improvement<input type="number" min="1" max="8" value={draft.patience} disabled={fieldsDisabled} onInput={e => edit({ patience: Number(e.currentTarget.value) })} /></label>
        <label>Minimum metric improvement<input type="number" min="0" step="0.001" value={draft.minImprovement} disabled={fieldsDisabled} onInput={e => edit({ minImprovement: Number(e.currentTarget.value) })} /></label>
      </div>
      {draft.planner === "claude" ? <><label class="ml-field">Planner objective<input maxLength={2000} value={draft.objective} disabled={fieldsDisabled} onInput={e => edit({ objective: e.currentTarget.value })} /></label><p>Claude receives this objective, hyperparameters and aggregate validation scores. This uses your Claude subscription or API billing. Dataset contents stay on the training computer. A current Claude CLI is required on the Code Flow host.</p></> : <p>Built-in search explores fixed hyperparameters around the best validation result. It requires no LLM account.</p>}
      <p>Each trial reserves up to {draft.minutes} training minute{draft.minutes === 1 ? "" : "s"}. Failed attempts keep their reservations. Preparation, evaluation and planning also count toward the elapsed limit, which continues while Code Flow is closed. Resuming keeps the original limits.</p>
      <button class="btn primary" disabled={fieldsDisabled || active || !searchReady} onClick={() => void act("Starting automatic experiments", async () => { await drafts.write(project.id, draft); await post("/api/ml/cycles", { training: searchTraining(), objective: draft.objective, planner: { kind: draft.planner, ...(draft.planner === "claude" ? { model: draft.plannerModel } : {}) }, limits: { iterations: draft.searchIterations, trainSeconds: draft.searchMinutes * 60, elapsedSeconds: draft.elapsedMinutes * 60, patience: draft.patience, minImprovement: draft.minImprovement } }); setMessage("Automatic experiments are recorded. Keep Code Flow running to dispatch subsequent trials."); })}>Start automatic experiments</button>
      {overview.cycles.map(c => <div class="ml-detail" id={`ml-cycle-${c.id}`} key={c.id}><h4>{c.name} · {c.state}</h4><p>{c.trials.length} / {c.limits.iterations} iterations · {Math.round(c.reservedTrainSeconds / 60 * 10) / 10} / {c.limits.trainSeconds / 60} training minutes reserved · Deadline {new Date(c.expiresAt).toLocaleString()}</p>{c.reason ? <p role="status">{c.reason}</p> : null}
        {c.trials.length ? <div class="ml-table-scroll"><table><caption>Validation comparisons</caption><thead><tr><th>Trial</th><th>Configuration</th><th>Status</th><th>Validation score</th><th>Decision</th></tr></thead><tbody>{c.trials.map(t => { const j = overview.experiments.find(j => j.id === t.jobId); return <tr key={t.number}><td>{t.jobId ? <button class="btn" onClick={() => selectJob(t.jobId!)}>Trial {t.number}</button> : t.number}</td><td>{specSummary(t.spec)}</td><td>{j ? labels[j.status.state] : t.state}</td><td>{j?.status.evaluation ? `${j.status.evaluation.candidate.toFixed(4)} ${j.status.evaluation.metric}` : "Pending"}</td><td>{c.bestJobId === t.jobId && t.jobId ? "Selected · " : ""}{t.reason}</td></tr>; })}</tbody></table></div> : null}
        <div class="ml-actions">{!cycleTerminal(c) ? <button class="btn" disabled={!!busy || c.state === "stopping"} onClick={() => void act("Stopping search", async () => { await post(`/api/ml/cycles/${enc(c.id)}/stop`); })}>Stop search</button> : null}{c.state === "paused" ? <button class="btn" disabled={fieldsDisabled || !!c.finalJobId || Date.now() >= c.expiresAt} onClick={() => void act("Resuming search", async () => { await post(`/api/ml/cycles/${enc(c.id)}/resume`); })}>Resume with remaining budget</button> : null}{c.finalJobId ? <button class="btn" onClick={() => selectJob(c.finalJobId!)}>View final test and export</button> : null}</div>
      </div>)}
    </section>
    <SchedulePanel draft={draft} edit={edit} disabled={fieldsDisabled} busy={!!busy} ready={searchReady}
      source={draft.path} location={draft.location} target={target?.name ?? "Selected computer"} iterations={draft.searchIterations} trainMinutes={draft.searchMinutes} elapsedMinutes={draft.elapsedMinutes}
      schedules={overview.schedules ?? []} cycles={overview.cycles}
      save={() => void act("Saving retraining schedule", async () => {
        await drafts.write(project.id, draft);
        await post("/api/ml/schedules", { search: { training: searchTraining(), objective: draft.objective, planner: { kind: draft.planner, ...(draft.planner === "claude" ? { model: draft.plannerModel } : {}) }, limits: { iterations: draft.searchIterations, trainSeconds: draft.searchMinutes * 60, elapsedSeconds: draft.elapsedMinutes * 60, patience: draft.patience, minImprovement: draft.minImprovement } }, source: { path: draft.path, location: draft.location }, cadence: draft.checkKind === "interval" ? { every: draft.checkMinutes } : { at: draft.checkTime, timezone: draft.checkTimezone, ...(draft.checkKind === "weekdays" ? { days: [1, 2, 3, 4, 5] } : {}) }, stabilitySeconds: draft.stableMinutes * 60, maxCycles: draft.maxScheduledRuns });
        setMessage("Schedule saved. New stable data will start a search with these limits while Code Flow is running.");
      })}
      action={(s, action, stopActive) => void act(action === "pause" ? "Pausing retraining" : action === "resume" ? "Resuming retraining" : "Requesting data check", async () => { await post(`/api/ml/schedules/${enc(s.id)}/${action}`, { revision: s.revision, ...(stopActive ? { stopActive } : {}) }); })}
    />
    <RegistryPanel project={project.id} enabled={overview.enabled} models={overview.registry ?? []} jobs={overview.experiments} cycles={overview.cycles} refresh={refresh} selectJob={selectJob} />
    <DeploymentPanel project={project.id} enabled={overview.enabled} deployments={overview.deployments ?? []} models={overview.registry ?? []} jobs={overview.experiments} targets={overview.targets} cycles={overview.cycles} refresh={refresh} />
    <PromotionPanel datasets={overview.datasets} jobs={overview.experiments} enabled={overview.enabled} policies={overview.promotions ?? []} deployments={overview.deployments ?? []} models={overview.registry ?? []} schedules={overview.schedules ?? []} refresh={refresh} />
    <MonitorPanel enabled={overview.enabled} monitors={overview.monitors ?? []} deployments={overview.deployments ?? []} models={overview.registry ?? []} schedules={overview.schedules ?? []} refresh={refresh} />
    <section class="pp-card" aria-label="Model experiments"><h3>Experiments and models</h3>
      {!overview.experiments.length ? <p>Your training jobs and model exports will appear here.</p> : <div class="ml-experiments">{overview.experiments.map(job => <div class={`ml-experiment ${job.id === selected ? "selected" : ""}`} key={job.id}><button class="ml-select" onClick={() => setSelected(job.id)}><strong>{job.name}</strong><span>{job.target.name} · {new Date(job.intent.createdAt).toLocaleString()}</span></button><span>{labels[job.status.state]}</span>{job.status.evaluation ? <span>{job.status.evaluation.improved ? "Better than baseline" : "Baseline remains competitive"}</span> : null}</div>)}</div>}
      {selectedJob ? <ExperimentDetail key={selectedJob.id} job={selectedJob} busy={!!busy} onAction={(action) => act(action === "cancel" ? "Requesting cancellation" : "Inspecting job", async () => { await post(`/api/ml/experiments/${enc(selectedJob.id)}/${action}`); })} /> : null}
    </section>
  </div>;
}

function PythonSettings({ target, disabled, onSave }: { target: Target; disabled: boolean; onSave: (python: string) => Promise<void> }) {
  const [python, setPython] = useState(target.python);
  return <details><summary>Python settings</summary><p>Choose the Python 3.12 executable used to create this computer's private training environment.</p><form onSubmit={e => { e.preventDefault(); void onSave(python); }} class="ml-actions"><label>Python executable<input value={python} disabled={disabled} onInput={e => setPython(e.currentTarget.value)} required /></label><button class="btn" disabled={disabled || python === target.python}>Save Python settings</button></form></details>;
}
function ServerForm({ disabled, onSave }: { disabled: boolean; onSave: (body: unknown) => Promise<void> }) {
  const [name, setName] = useState(""); const [host, setHost] = useState(""); const [directory, setDirectory] = useState("~/.codeflow/training-worker"); const [python, setPython] = useState("python3"); const [standalone, setStandalone] = useState(false);
  return <form class="ml-server" onSubmit={e => { e.preventDefault(); void onSave({ name, host, directory, python, standalone }); }}><h4>Add your server</h4><p>Use an existing SSH alias with a verified host key. The server needs Node.js 22.13+ and Python 3.12. No agent login is needed there.</p><div class="ml-grid">
    <label>Server name<input required value={name} disabled={disabled} onInput={e => setName(e.currentTarget.value)} /></label><label>SSH host alias<input required value={host} disabled={disabled} onInput={e => setHost(e.currentTarget.value)} /></label><label>Worker directory<input required value={directory} disabled={disabled} onInput={e => setDirectory(e.currentTarget.value)} /></label><label>Python executable<input required value={python} disabled={disabled} onInput={e => setPython(e.currentTarget.value)} /></label>
  </div><label class="ml-check"><input type="checkbox" checked={standalone} disabled={disabled} onChange={e => setStandalone(e.currentTarget.checked)} />This is a standalone server where I can run training directly. It does not require Slurm.</label><button class="btn" type="submit" disabled={disabled || !standalone}>Save training server</button></form>;
}
function ExperimentDetail({ job, busy, onAction }: { job: Experiment; busy: boolean; onAction: (action: "inspect" | "cancel") => Promise<void> }) {
  const [logs, setLogs] = useState(""); const [cursor, setCursor] = useState(0); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const score = job.status.evaluation;
  async function moreLogs() { setLoading(true); try { const result = await api<{ text: string; cursor: number }>(`/api/ml/experiments/${enc(job.id)}/logs?cursor=${cursor}`); setLogs(prior => (prior + result.text).slice(-128000)); setCursor(result.cursor); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }
  return <div class="ml-detail" id="ml-experiment-details" tabIndex={-1} aria-label="Experiment details"><h4>{job.name}</h4><p><strong>{labels[job.status.state]}</strong> · Job <code>{job.id}</code></p>{job.status.error ? <p role="alert">{job.status.error}</p> : null}
    {job.status.model ? <p>Base model ready: {job.status.model.architecture} · {job.status.model.parameters.toLocaleString()} parameters · <code>{job.status.model.hash.slice(0, 16)}</code></p> : null}
    {job.status.progress ? <p role="status">Step {job.status.progress.step} / {job.status.progress.totalSteps}{job.status.progress.loss !== undefined ? ` · Training loss ${job.status.progress.loss.toFixed(4)}` : ""}</p> : null}
    {job.intent.kind === "holdout" ? <p>Common holdout evaluation · fixed incumbent and candidate exports · no training. Cancellation consumes this policy's comparison attempt. Serving resumes after cleanup unless the owner stopped or changed it.</p> : null}
    {job.status.holdout ? <><table><caption>Frozen common holdout · {job.status.holdout.rows} rows{job.status.holdout.tokens ? ` · ${job.status.holdout.tokens} completion tokens` : ""}</caption><thead><tr><th>Metric</th><th>Baseline</th><th>Incumbent</th><th>Candidate</th></tr></thead><tbody><tr><td>{job.status.holdout.metric} · {job.status.holdout.direction} is better</td><td>{job.status.holdout.baseline.toFixed(4)}</td><td>{job.status.holdout.incumbent.toFixed(4)}</td><td>{job.status.holdout.candidate.toFixed(4)}</td></tr></tbody></table><p>Review the linked promotion policy for approval and deployment decisions.</p></> : null}
    {score ? <><table><caption>{score.partition === "validation" ? "Validation evaluation · used for selection" : "Held-out test evaluation"}</caption><thead><tr><th>Metric</th><th>{score.metric === "completion_nll" ? "Base model" : "Baseline"}</th><th>{score.metric === "completion_nll" ? "LoRA adapter" : "Candidate"}</th></tr></thead><tbody><tr><td>{score.metric === "completion_nll" ? "Completion loss (NLL)" : score.metric} · {score.direction} is better</td><td>{score.baseline.toFixed(4)}</td><td>{score.candidate.toFixed(4)}</td></tr></tbody></table><p>{score.trainRows} training / {score.tuningRows} tuning / {score.testRows} test rows. {score.metric === "completion_nll" ? `${score.evaluatedTokens} held-out completion tokens. Lower loss indicates better fit to these reference answers; review generated answers before deployment.` : "This single comparison does not establish production readiness."}</p></> : job.intent.kind === "training" ? <p>Model quality has not yet been evaluated.</p> : null}
    {job.intent.search && !terminal(job.status.state) ? <p>Cancelling this trial consumes its reservation and the search may continue. Use Stop search above to end the whole search.</p> : null}
    <div class="ml-actions"><button class="btn" disabled={busy} onClick={() => void onAction("inspect")}>Inspect job</button>{!terminal(job.status.state) ? <button class="btn" disabled={busy} onClick={() => void onAction("cancel")}>Cancel job</button> : null}{job.status.state === "succeeded" && job.status.artifact ? <a class="btn primary" href={apiPath(`/api/ml/experiments/${enc(job.id)}/export`)}>{job.intent.recipe === LLM_RECIPE ? "Download adapter" : "Download model"}</a> : null}</div>
    <details onToggle={e => { if (e.currentTarget.open && !logs && !loading) void moreLogs(); }}><summary>{job.intent.kind === "holdout" ? "Evaluation log" : "Training log"}</summary>{error ? <p role="alert">{error}</p> : null}<pre class="ml-log">{logs || "No log output loaded."}</pre><button class="btn" disabled={loading} onClick={() => void moreLogs()}>Load more log output</button></details>
  </div>;
}
