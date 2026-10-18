import { useEffect, useState } from "preact/hooks";
import type { CoordinatedChange } from "../src/repo-coordination.js";
import { api, post } from "./lib.js";

type Project = { id: string; name: string; repos: string[] };
type DraftNode = { id: string; repo: string; task: string; provider: string; check: string; dependsOn: string[] };
const empty = (id: string, repo = ""): DraftNode => ({ id, repo, task: "", provider: "claude", check: "", dependsOn: [] });

export function CoordinatedChangesPanel({ endpoint = "/api/coordinated-changes" }: { endpoint?: string }) {
  const [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState("");
  const [name, setName] = useState(""), [nodes, setNodes] = useState<DraftNode[]>([empty("repo1"), empty("repo2")]);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [jobs, setJobs] = useState<CoordinatedChange[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({}), [receipts, setReceipts] = useState<Record<string, string>>({}), [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const selected = projects.find((item) => item.id === project);
  const refresh = async () => { setJobs(await api<CoordinatedChange[]>(endpoint)); };
  useEffect(() => { let active = true; void Promise.all([api<Project[]>("/api/projects"), api<CoordinatedChange[]>(endpoint)]).then(([projects, jobs]) => { if (active) { setProjects(projects); setJobs(jobs); const first = projects.find((item) => item.repos.length >= 2) ?? projects[0]; if (first) { setProject(first.id); setNodes([empty("repo1", first.repos[0]), empty("repo2", first.repos[1])]); } } }).catch((problem) => { if (active) setError((problem as Error).message); }); const timer = setInterval(() => { void api<CoordinatedChange[]>(endpoint).then((jobs) => { if (active) setJobs(jobs); }).catch((problem) => { if (active) setError((problem as Error).message); }); }, 5000); return () => { active = false; clearInterval(timer); }; }, [endpoint]);
  const edit = (nodeId: string, patch: Partial<DraftNode>) => { setOperationId(crypto.randomUUID()); setNodes((previous) => previous.map((node) => node.id === nodeId ? { ...node, ...patch } : node)); };
  const create = async () => {
    if (busy) return; setBusy("create"); setError("");
    try {
      if (!selected || nodes.some((node) => !selected.repos.includes(node.repo) || !node.task.trim())) throw new Error("Choose project repositories and write a task for each one.");
      await post(endpoint, { project, name: name.trim(), operationId, nodes: nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn, run: { repo: node.repo, project, pattern: "solo", task: node.task, roles: { agent: [node.provider] }, options: {}, loop: { ...(node.check.trim() ? { check: node.check.trim() } : {}), maxSteps: 20, maxInvocations: 20, maxMinutes: 15, copy: [] } } })) });
      setOperationId(crypto.randomUUID()); setName(""); setNodes((previous) => previous.map((node) => ({ ...node, task: "" }))); await refresh();
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(""); }
  };
  const act = async (job: CoordinatedChange, action: string, body: Record<string, unknown> = {}) => {
    if (busy) return; setBusy(job.id + action); setError("");
    try { await post(`${endpoint}/${encodeURIComponent(job.id)}/${action}`, { expectedRevision: job.revision, ...body }); await refresh(); }
    catch (problem) { setError((problem as Error).message); await refresh().catch(() => undefined); }
    finally { setBusy(""); }
  };
  return <section class="section coordination-panel" aria-label="Coordinated repository changes" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
    <div class="section-title">Coordinated repository changes</div>
    <p class="help">Plan dependent changes across 2–10 repositories in one project. Each starts from its pinned commit in safe mode. Downstream work receives exact verified commit facts after its dependencies finish. Repositories keep separate workspaces and credentials.</p>
    <p class="help">Tasks use at most 20 agent calls and 15 minutes by default. There are no unattended native tool approval waits, inherited uploads or copied ignored files. Shipping requires a reviewed matrix and a separate explicit merge for each repository; merges can partially succeed and never push automatically.</p>
    {error ? <p class="msg err" role="alert">{error} Your draft is preserved.</p> : null}
    <details><summary>Create a coordinated change</summary>
      <label>Project<select class="field" aria-label="Coordinated project" value={project} onChange={(event) => { const value = event.currentTarget.value, chosen = projects.find((item) => item.id === value); setOperationId(crypto.randomUUID()); setProject(value); setNodes([empty("repo1", chosen?.repos[0]), empty("repo2", chosen?.repos[1])]); }}><option value="">Choose project</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label>Change name<input class="field" aria-label="Coordinated change name" maxLength={120} value={name} onInput={(event) => { setOperationId(crypto.randomUUID()); setName(event.currentTarget.value); }} /></label>
      {!selected || selected.repos.length < 2 ? <p class="help">Add at least two repositories to a project before coordinating changes.</p> : null}
      {nodes.map((node, index) => <fieldset key={node.id} style={{ minWidth: 0 }} aria-label={`Coordinated task ${node.id}`}><legend>Task {node.id}</legend>
        <label>Repository<select class="field" aria-label={`Repository for ${node.id}`} value={node.repo} onChange={(event) => edit(node.id, { repo: event.currentTarget.value })}><option value="">Choose repository</option>{selected?.repos.map((repo) => <option key={repo} value={repo}>{repo}</option>)}</select></label>
        <label>Task<textarea class="field" rows={3} aria-label={`Task for ${node.id}`} maxLength={24000} value={node.task} onInput={(event) => edit(node.id, { task: event.currentTarget.value })} /></label>
        <label>Provider<select class="field" aria-label={`Provider for ${node.id}`} value={node.provider} onChange={(event) => edit(node.id, { provider: event.currentTarget.value })}><option value="claude">Claude</option><option value="codex">Codex</option><option value="agy">Antigravity</option><option value="auto">Auto</option></select></label>
        <label>Verification command · blank uses repository configuration<input class="field" aria-label={`Verification for ${node.id}`} value={node.check} onInput={(event) => edit(node.id, { check: event.currentTarget.value })} /></label>
        <div>Start after these verified tasks:{nodes.filter((other) => other.id !== node.id).map((other) => <label key={other.id} class="help"><input type="checkbox" aria-label={`${node.id} depends on ${other.id}`} checked={node.dependsOn.includes(other.id)} onChange={(event) => edit(node.id, { dependsOn: event.currentTarget.checked ? [...node.dependsOn, other.id] : node.dependsOn.filter((name) => name !== other.id) })} /> {other.id}</label>)}</div>
        {nodes.length > 2 ? <button class="btn small" disabled={!!busy} onClick={() => setNodes((previous) => previous.filter((item) => item.id !== node.id).map((item) => ({ ...item, dependsOn: item.dependsOn.filter((name) => name !== node.id) })))}>Remove task {index + 1}</button> : null}
      </fieldset>)}
      <div class="at-row" style={{ flexWrap: "wrap" }}><button class="btn small" disabled={!!busy || nodes.length >= 10 || nodes.length >= (selected?.repos.length ?? 0)} onClick={() => { const next = Array.from({ length: 10 }, (_, index) => `repo${index + 1}`).find((id) => !nodes.some((node) => node.id === id))!; setNodes((previous) => [...previous, empty(next, selected?.repos.find((repo) => !previous.some((node) => node.repo === repo)))]); }}>Add repository task</button><button class="btn small primary" disabled={!!busy || !selected || selected.repos.length < 2 || !name.trim()} onClick={create}>Start coordinated change</button></div>
    </details>
    <button class="btn small" disabled={!!busy} onClick={() => void refresh().catch((problem) => setError((problem as Error).message))}>Refresh coordinated changes</button>
    {jobs.length === 0 ? <p class="help">No coordinated changes yet.</p> : null}
    {jobs.map((job) => <article key={job.id} class="memory-card" aria-label={`Coordinated change ${job.name}`}>
      <div class="at-row" style={{ flexWrap: "wrap" }}><b>{job.name}</b><span>{job.status} · revision {job.revision}</span>{!job.cancelRequested && job.status !== "shipped" ? <button class="btn small" disabled={!!busy} onClick={() => act(job, "cancel")}>Cancel coordinated change</button> : null}</div>
      <p class="help">Project {projects.find((item) => item.id === job.project)?.name ?? job.project} · {job.id}</p>
      {job.nodes.map((node) => { const key = `${job.id}:${node.id}`, action = `nodes/${encodeURIComponent(node.id)}`; return <section key={node.id} aria-label={`Repository task ${node.id}`}>
        <h3>{node.id} · {node.status}</h3><p class="help">{node.run.repo} · starts at <code>{node.baseCommit}</code>{node.dependsOn.length ? ` · depends on ${node.dependsOn.join(", ")}` : " · independent"}</p>
        <p>{node.run.task}</p>{node.reason ? <p class="help">{node.reason}</p> : null}
        {node.runId ? <p><a href={`#/run/${encodeURIComponent(node.runId)}`}>Open run {node.runId}</a> · attempt {node.attempts}</p> : null}
        {node.result ? <p class="help">Verified branch {node.result.branch} at <code>{node.result.commit}</code> · receipt {node.result.verificationId}</p> : null}
        {node.shippedCommit ? <p class="help">Merged commit: <code>{node.shippedCommit}</code></p> : null}
        {node.status === "unknown" ? <div><p class="help">Claim {node.claimId} · inspect existing runs before linking or retrying.</p><label>Matching run ID<input class="field" aria-label={`Matching run for ${node.id}`} value={receipts[key] ?? ""} onInput={(event) => setReceipts((previous) => ({ ...previous, [key]: event.currentTarget.value }))} /></label><button class="btn small" disabled={!!busy || !receipts[key]} onClick={() => act(job, action + "/attach", { runId: receipts[key] })}>Link matching run {node.id}</button><label class="help"><input type="checkbox" aria-label={`Acknowledge unknown retry ${node.id}`} checked={acknowledged[key] ?? false} onChange={(event) => setAcknowledged((previous) => ({ ...previous, [key]: event.currentTarget.checked }))} /> I inspected existing runs and accept that retrying could duplicate work.</label></div> : null}
        {["failed", "blocked", "cancelled"].includes(node.status) && job.nodes.some((item) => item.status === "unknown") ? <label class="help"><input type="checkbox" aria-label={`Acknowledge unknown dependent retry ${node.id}`} checked={acknowledged[key] ?? false} onChange={(event) => setAcknowledged((previous) => ({ ...previous, [key]: event.currentTarget.checked }))} /> I inspected unknown dependent launches and accept that invalidating them could duplicate work.</label> : null}
        {["failed", "unknown", "blocked", "cancelled"].includes(node.status) ? <button class="btn small" disabled={!!busy || node.attempts >= 3 || node.status === "unknown" && !acknowledged[key]} onClick={() => act(job, action + "/retry", { acknowledgeUnknown: acknowledged[key] === true })}>Retry task {node.id}</button> : null}
        {node.status === "shipping-unknown" ? <div><p class="help">Shipping claim {node.shippingClaimId} has an unknown outcome. Inspect the exact local target commit; automatic retry is disabled.</p><label>Proven merge commit<input class="field" aria-label={`Shipping recovery commit for ${node.id}`} value={receipts[key] ?? ""} onInput={(event) => setReceipts((previous) => ({ ...previous, [key]: event.currentTarget.value }))} /></label><button class="btn small" disabled={!!busy || !receipts[key]} onClick={() => act(job, action + "/recover-shipping", { commit: receipts[key] })}>Recover exact shipping receipt {node.id}</button></div> : null}
      </section>; })}
      {!job.cancelRequested && job.nodes.every((node) => ["verified", "shipped"].includes(node.status)) && job.status !== "shipped" ? <section aria-label="Coordinated shipping review"><h3>Review local merge targets</h3>
        {job.nodes.filter((node) => node.status !== "shipped").map((node) => <label key={node.id}>Target branch for {node.id}<input class="field" aria-label={`Shipping target for ${node.id}`} value={targets[`${job.id}:${node.id}`] ?? "main"} onInput={(event) => setTargets((previous) => ({ ...previous, [`${job.id}:${node.id}`]: event.currentTarget.value }))} /></label>)}
        <button class="btn small" disabled={!!busy} onClick={() => act(job, "shipping-preview", { targets: Object.fromEntries(job.nodes.filter((node) => node.status !== "shipped").map((node) => [node.id, targets[`${job.id}:${node.id}`] ?? "main"])) })}>Validate and preview shipping matrix</button>
      </section> : null}
      {job.shipping ? <section aria-label="Pinned shipping matrix"><p class="help">Preview {job.shipping.id} · expires {new Date(job.shipping.expiresAt).toLocaleString()}. Each action is independent; previously merged repositories remain merged if another fails.</p><ul>{job.shipping.entries.map((entry) => { const node = job.nodes.find((node) => node.id === entry.nodeId)!; return <li key={entry.nodeId}><b>{entry.nodeId} → {entry.validation.into}</b><p class="help">Source <code>{entry.validation.source}</code> · target <code>{entry.validation.target}</code> · validated tree <code>{entry.validation.tree}</code></p><button class="btn small primary" disabled={!!busy || job.cancelRequested || job.shipping!.expiresAt <= Date.now() || node.status !== "verified"} onClick={() => act(job, `nodes/${encodeURIComponent(node.id)}/ship`, { previewId: job.shipping!.id })}>Merge {node.id} into {entry.validation.into}</button></li>; })}</ul></section> : null}
      <details><summary>Coordination history · {job.history.length}</summary><ul>{job.history.slice().reverse().map((entry) => <li key={entry.id}>{new Date(entry.at).toLocaleString()}{entry.nodeId ? ` · ${entry.nodeId}` : ""} · {entry.detail}{entry.runId ? ` · run ${entry.runId}` : ""}{entry.commit ? <code> · {entry.commit}</code> : null}</li>)}</ul></details>
    </article>)}
  </section>;
}
