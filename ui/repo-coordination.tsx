import { completeSentence } from "./lib.js";
import { confirmAction } from "./confirm-state.js";
import { COORDINATION_LIMITS, coordinationRetryProblem } from "../src/repo-coordination-policy.js";
import { pollVisible } from "./polling.js";
import { useEffect, useState } from "preact/hooks";
import type { CoordinatedChange, CoordinationNodeStatus } from "../src/repo-coordination.js";
import { api, post } from "./lib.js";

type Project = { id: string; name: string; repos: string[] };
// Status pills in the paper tones: running is mint, needs-a-look is warn, failed is err, verified and shipped are ok.
const JOB_TONE: Partial<Record<CoordinatedChange["status"], string>> = { running: "run", ready: "ok", shipped: "ok", "partial-shipped": "warn", blocked: "warn" };
const NODE_TONE: Partial<Record<CoordinationNodeStatus, string>> = { claimed: "run", running: "run", shipping: "run", verified: "ok", shipped: "ok", failed: "err", unknown: "warn", blocked: "warn", "shipping-unknown": "warn" };
const badge = (tone?: string) => `badge${tone ? ` ${tone}` : ""}`;
const sentence = (value: string) => { const text = value.replace(/-/g, " "); return text.charAt(0).toUpperCase() + text.slice(1); };
export type DraftNode = { id: string; repo: string; task: string; provider: string; check: string; dependsOn: string[] };
const empty = (id: string, repo = ""): DraftNode => ({ id, repo, task: "", provider: "claude", check: "", dependsOn: [] });

/** Keep typed work and dependencies while moving the draft to another project's repositories. */
export function retargetDrafts(nodes: DraftNode[], repos: string[]): DraftNode[] {
  const used = new Set(nodes.filter(node => repos.includes(node.repo)).map(node => node.repo));
  return nodes.map(node => {
    if (repos.includes(node.repo)) return node;
    const repo = repos.find(repo => !used.has(repo)) ?? "";
    if (repo) used.add(repo);
    return { ...node, repo };
  });
}
export function CoordinatedChangesPanel({ endpoint = "/api/coordinated-changes", projectId }: { endpoint?: string; projectId?: string }) {
  const [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState(projectId ?? "");
  const [name, setName] = useState(""), [nodes, setNodes] = useState<DraftNode[]>([empty("repo1"), empty("repo2")]);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [jobs, setJobs] = useState<CoordinatedChange[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({}), [receipts, setReceipts] = useState<Record<string, string>>({}), [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({}), [targetErrors, setTargetErrors] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const shippingRepos = [...new Set(jobs.filter(job => !job.cancelRequested && job.status !== "shipped" && job.nodes.every(node => ["verified", "shipped"].includes(node.status))).flatMap(job => job.nodes.filter(node => node.status !== "shipped").map(node => node.run.repo)))].sort().join("\0");
  useEffect(() => {
    let active = true;
    for (const repo of shippingRepos.split("\0").filter(Boolean)) void api<{ current: string | null; branches: { name: string; kind: string }[] }>(`/api/branches?repo=${encodeURIComponent(repo)}`).then(info => {
      if (!active) return;
      const local = info.branches.filter(branch => branch.kind === "local").map(branch => branch.name);
      const initial = info.current && local.includes(info.current) ? info.current : ["main", "master"].find(branch => local.includes(branch)) ?? local[0] ?? "";
      setDefaults(previous => ({ ...previous, [repo]: initial }));
      setTargetErrors(previous => ({ ...previous, [repo]: initial ? "" : "Choose an existing local branch for this repository." }));
    }).catch(error => { if (active) setTargetErrors(previous => ({ ...previous, [repo]: `Could not load local branches: ${(error as Error).message}. Enter a target explicitly.` })); });
    return () => { active = false; };
  }, [shippingRepos]);
  const targetFor = (job: CoordinatedChange, node: CoordinatedChange["nodes"][number]) => targets[`${job.id}:${node.id}`] ?? defaults[node.run.repo] ?? "";
  const selected = projects.find((item) => item.id === project);
  const refresh = async () => { setJobs(await api<CoordinatedChange[]>(endpoint)); };
  useEffect(() => { let active = true; void api<Project[]>("/api/projects").then((projects) => { if (active) { setProjects(projects); const first = projects.find(item => item.id === projectId) ?? projects.find((item) => item.repos.length >= 2) ?? projects[0]; if (first) { setProject(first.id); setNodes(previous => retargetDrafts(previous, first.repos)); } } }).catch((problem) => { if (active) setError((problem as Error).message); }); const stop = pollVisible(() => api<CoordinatedChange[]>(endpoint).then((jobs) => { if (active) setJobs(jobs); }).catch((problem) => { if (active) setError((problem as Error).message); }), 5000); return () => { active = false; stop(); }; }, [endpoint, projectId]);
  const edit = (nodeId: string, patch: Partial<DraftNode>) => { setOperationId(crypto.randomUUID()); setNodes((previous) => previous.map((node) => node.id === nodeId ? { ...node, ...patch } : node)); };
  const create = async () => {
    if (busy) return; setBusy("create"); setError("");
    try {
      if (!selected || nodes.some((node) => !selected.repos.includes(node.repo) || !node.task.trim())) throw new Error("Choose project repositories and write a task for each one.");
      await post(endpoint, { project, name: name.trim(), operationId, nodes: nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn, run: { repo: node.repo, project, pattern: "solo", task: node.task, roles: { agent: [node.provider] }, options: {}, loop: { ...(node.check.trim() ? { check: node.check.trim() } : {}), maxSteps: 20, maxInvocations: 20, maxMinutes: 15, copy: [] } } })) });
      setOperationId(crypto.randomUUID()); setName(""); setNodes((previous) => previous.map((node) => ({ ...node, task: "" }))); await refresh();
    } catch (problem) { setError(`${completeSentence((problem as Error).message)} Your draft is preserved.`); }
    finally { setBusy(""); }
  };
  const act = async (job: CoordinatedChange, action: string, body: Record<string, unknown> = {}) => {
    if (busy) return; setBusy(job.id + action); setJobErrors(previous => ({ ...previous, [job.id]: "" }));
    try { await post(`${endpoint}/${encodeURIComponent(job.id)}/${action}`, { expectedRevision: job.revision, ...body }); await refresh(); }
    catch (problem) { setJobErrors(previous => ({ ...previous, [job.id]: (problem as Error).message })); await refresh().catch(() => undefined); }
    finally { setBusy(""); }
  };
  const cancel = async (job: CoordinatedChange) => {
    const verified = job.nodes.filter(node => node.status === "verified").map(node => node.id);
    const active = job.nodes.filter(node => ["claimed", "running", "unknown"].includes(node.status)).map(node => node.id);
    const message = [`Stop pending dispatch for ${job.name}.`, active.length ? `Stop running or claimed tasks: ${active.join(", ")}.` : "", verified.length ? `Withdraw ${verified.length} verified result${verified.length === 1 ? "" : "s"} (${verified.join(", ")}) from shipping. Retrying reruns their agents and uses one of ${COORDINATION_LIMITS.attempts} attempts.` : "", "Run branches and commits are kept. Already merged repositories stay merged."].filter(Boolean).join("\n\n");
    if (await confirmAction(message, { title: "Cancel coordinated change?", confirmLabel: "Cancel coordinated change", danger: true })) await act(job, "cancel");
  };
  return <section class="wb-card coordination-panel" aria-label="Coordinated repository changes">
    <h2>Coordinated repository changes</h2>
    <p class="help">Plan dependent changes across 2–10 repositories in one project. Each starts from its pinned commit in safe mode. Downstream work receives exact verified commit facts after its dependencies finish. Repositories keep separate workspaces and credentials.</p>
    <p class="help">Tasks use at most 20 agent calls and 15 minutes by default. There are no unattended native tool approval waits, inherited uploads or copied ignored files. Shipping requires a reviewed matrix and a separate explicit merge for each repository; merges can partially succeed and never push automatically.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <details><summary>Create a coordinated change</summary>
      <div class="wb-fields"><label>Project<select class="field" aria-label="Coordinated project" value={project} onChange={(event) => { const value = event.currentTarget.value, chosen = projects.find((item) => item.id === value); setOperationId(crypto.randomUUID()); setProject(value); setNodes(previous => retargetDrafts(previous, chosen?.repos ?? [])); }}><option value="">Choose project</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label>Change name<input class="field" aria-label="Coordinated change name" maxLength={120} value={name} onInput={(event) => { setOperationId(crypto.randomUUID()); setName(event.currentTarget.value); }} /></label></div>
      {!selected || selected.repos.length < 2 ? <p class="help">Add at least two repositories to a project before coordinating changes.</p> : null}
      {nodes.map((node, index) => <fieldset key={node.id} class="coordination-task" aria-label={`Coordinated task ${node.id}`}><legend>Task {node.id}</legend>
        <label>Repository<select class="field" aria-label={`Repository for ${node.id}`} value={node.repo} onChange={(event) => edit(node.id, { repo: event.currentTarget.value })}><option value="">Choose repository</option>{selected?.repos.map((repo) => <option key={repo} value={repo}>{repo}</option>)}</select></label>
        <label>Task<textarea class="field" rows={3} aria-label={`Task for ${node.id}`} maxLength={24000} value={node.task} onInput={(event) => edit(node.id, { task: event.currentTarget.value })} /></label>
        <label>Provider<select class="field" aria-label={`Provider for ${node.id}`} value={node.provider} onChange={(event) => edit(node.id, { provider: event.currentTarget.value })}><option value="claude">Claude</option><option value="codex">Codex</option><option value="agy">Antigravity</option><option value="auto">Auto</option></select></label>
        <label>Verification command · blank uses repository configuration<input class="field" aria-label={`Verification for ${node.id}`} value={node.check} onInput={(event) => edit(node.id, { check: event.currentTarget.value })} /></label>
        <div class="coordination-deps">Start after these verified tasks:{nodes.filter((other) => other.id !== node.id).map((other) => <label key={other.id} class="help"><input type="checkbox" aria-label={`${node.id} depends on ${other.id}`} checked={node.dependsOn.includes(other.id)} onChange={(event) => edit(node.id, { dependsOn: event.currentTarget.checked ? [...node.dependsOn, other.id] : node.dependsOn.filter((name) => name !== other.id) })} /> {other.id}</label>)}</div>
        {nodes.length > 2 ? <button class="btn small" disabled={!!busy} onClick={() => setNodes((previous) => previous.filter((item) => item.id !== node.id).map((item) => ({ ...item, dependsOn: item.dependsOn.filter((name) => name !== node.id) })))}>Remove task {index + 1}</button> : null}
      </fieldset>)}
      <div class="wb-actions"><button class="btn small" disabled={!!busy || nodes.length >= 10 || nodes.length >= (selected?.repos.length ?? 0)} onClick={() => { const next = Array.from({ length: 10 }, (_, index) => `repo${index + 1}`).find((id) => !nodes.some((node) => node.id === id))!; setNodes((previous) => [...previous, empty(next, selected?.repos.find((repo) => !previous.some((node) => node.repo === repo)))]); }}>Add repository task</button><button class="btn small primary" disabled={!!busy || !selected || selected.repos.length < 2 || !name.trim()} onClick={create}>Start coordinated change</button></div>
    </details>
    <div class="wb-actions"><button class="btn small" disabled={!!busy} onClick={() => void refresh().catch((problem) => setError((problem as Error).message))}>Refresh coordinated changes</button></div>
    {jobs.length === 0 ? <p class="help">No coordinated changes yet.</p> : null}
    {jobs.length ? <div class="wb-list">{jobs.map((job) => <article key={job.id} class="wb-item coordination-job" aria-label={`Coordinated change ${job.name}`}>
      <div class="wb-item-head"><b>{job.name}</b><span class={badge(JOB_TONE[job.status])}>{sentence(job.status)} · revision {job.revision}</span>{!job.cancelRequested && job.status !== "shipped" ? <button class="btn small" disabled={!!busy} onClick={() => void cancel(job)}>Cancel coordinated change</button> : null}</div>
      {jobErrors[job.id] ? <p class="msg err" role="alert">{jobErrors[job.id]}</p> : null}
      {job.nodes.some(node => node.status === "cancelled") ? <p class="help">Retry cancelled tasks explicitly. Retrying one task restarts it and its downstream tasks; independent cancelled tasks need their own retry.</p> : null}
      <p class="help">Project {projects.find((item) => item.id === job.project)?.name ?? job.project} · {job.id}</p>
      {job.nodes.map((node) => { const key = `${job.id}:${node.id}`, action = `nodes/${encodeURIComponent(node.id)}`, retryProblem = coordinationRetryProblem(job, node.id); return <section key={node.id} class="coordination-node" aria-label={`Repository task ${node.id}`}>
        <div class="wb-item-head"><h3>{node.id}</h3><span class={badge(NODE_TONE[node.status])}>{sentence(node.status)}</span></div><p class="help">{node.run.repo} · starts at <code>{node.baseCommit}</code>{node.dependsOn.length ? ` · depends on ${node.dependsOn.join(", ")}` : " · independent"}{node.runId ? ` · attempt ${node.attempts}` : ""}</p>
        <p>{node.run.task}</p>{node.reason ? <p class="help">{node.reason}</p> : null}
        {node.result ? <p class="help">{["verified", "shipped"].includes(node.status) ? "Verified branch" : "Last verified branch"} {node.result.branch} at <code>{node.result.commit}</code> · receipt {node.result.verificationId}</p> : null}
        {node.shippedCommit ? <p class="help">Merged commit: <code>{node.shippedCommit}</code></p> : null}
        {node.runId ? <div class="wb-actions"><a class="btn small" href={`#/run/${encodeURIComponent(node.runId)}`}>Open run {node.runId}</a></div> : null}
        {node.status === "unknown" ? <div><p class="help">Claim {node.claimId} · inspect existing runs before linking or retrying.</p><label>Matching run ID<input class="field" aria-label={`Matching run for ${node.id}`} value={receipts[key] ?? ""} onInput={(event) => setReceipts((previous) => ({ ...previous, [key]: event.currentTarget.value }))} /></label><button class="btn small" disabled={!!busy || !receipts[key]} onClick={() => act(job, action + "/attach", { runId: receipts[key] })}>Link matching run {node.id}</button><label class="help"><input type="checkbox" aria-label={`Acknowledge unknown retry ${node.id}`} checked={acknowledged[key] ?? false} onChange={(event) => setAcknowledged((previous) => ({ ...previous, [key]: event.currentTarget.checked }))} /> I inspected existing runs and accept that retrying could duplicate work.</label></div> : null}
        {["failed", "blocked", "cancelled"].includes(node.status) && job.nodes.some((item) => item.status === "unknown") ? <label class="help"><input type="checkbox" aria-label={`Acknowledge unknown dependent retry ${node.id}`} checked={acknowledged[key] ?? false} onChange={(event) => setAcknowledged((previous) => ({ ...previous, [key]: event.currentTarget.checked }))} /> I inspected unknown dependent launches and accept that invalidating them could duplicate work.</label> : null}
        {["failed", "unknown", "blocked", "cancelled"].includes(node.status) ? <button class="btn small" disabled={!!busy || !!retryProblem || node.status === "unknown" && !acknowledged[key]} aria-describedby={retryProblem ? `${key}-retry-reason` : undefined} title={retryProblem} onClick={() => act(job, action + "/retry", { acknowledgeUnknown: acknowledged[key] === true })}>Retry task {node.id}</button> : null}
        {["failed", "unknown", "blocked", "cancelled"].includes(node.status) && retryProblem ? <p class="help" id={`${key}-retry-reason`}>{retryProblem}</p> : null}
        {node.status === "shipping-unknown" ? <div><p class="help">Shipping claim {node.shippingClaimId} has an unknown outcome. Inspect the exact local target commit; automatic retry is disabled.</p><label>Proven merge commit<input class="field" aria-label={`Shipping recovery commit for ${node.id}`} value={receipts[key] ?? ""} onInput={(event) => setReceipts((previous) => ({ ...previous, [key]: event.currentTarget.value }))} /></label><button class="btn small" disabled={!!busy || !receipts[key]} onClick={() => act(job, action + "/recover-shipping", { commit: receipts[key] })}>Recover exact shipping receipt {node.id}</button></div> : null}
      </section>; })}
      {!job.cancelRequested && job.nodes.every((node) => ["verified", "shipped"].includes(node.status)) && job.status !== "shipped" ? <section class="coordination-node" aria-label="Coordinated shipping review"><h3>Review local merge targets</h3>
        {job.nodes.filter((node) => node.status !== "shipped").map((node) => <label key={node.id}>Target branch for {node.id}<input class="field" aria-label={`Shipping target for ${node.id}`} placeholder="Choose a local branch" value={targetFor(job, node)} onInput={(event) => setTargets((previous) => ({ ...previous, [`${job.id}:${node.id}`]: event.currentTarget.value }))} />{targetErrors[node.run.repo] ? <span class="help">{targetErrors[node.run.repo]}</span> : null}</label>)}
        <button class="btn small" disabled={!!busy || job.nodes.some(node => node.status !== "shipped" && !targetFor(job, node).trim())} onClick={() => act(job, "shipping-preview", { targets: Object.fromEntries(job.nodes.filter((node) => node.status !== "shipped").map((node) => [node.id, targetFor(job, node)])) })}>Validate and preview shipping matrix</button>
      </section> : null}
      {job.shipping ? <section class="coordination-node" aria-label="Pinned shipping matrix">{job.shipping.expiresAt <= now ? <p class="msg warn" id={`${job.id}-preview-expired`}>Preview expired. Validate and preview the shipping matrix again before merging.</p> : null}<p class="help">Preview {job.shipping.id} · expires {new Date(job.shipping.expiresAt).toLocaleString()}. Each action is independent; previously merged repositories remain merged if another fails.</p><ul>{job.shipping.entries.map((entry) => { const node = job.nodes.find((node) => node.id === entry.nodeId)!; return <li key={entry.nodeId}><b>{entry.nodeId} → {entry.validation.into}</b><p class="help">Source <code>{entry.validation.source}</code> · target <code>{entry.validation.target}</code> · validated tree <code>{entry.validation.tree}</code></p><button class="btn small primary" disabled={!!busy || job.cancelRequested || job.shipping!.expiresAt <= now || node.status !== "verified"} aria-describedby={job.shipping!.expiresAt <= now ? `${job.id}-preview-expired` : undefined} onClick={() => act(job, `nodes/${encodeURIComponent(node.id)}/ship`, { previewId: job.shipping!.id })}>Merge {node.id} into {entry.validation.into}</button></li>; })}</ul></section> : null}
      <details><summary>Coordination history · {job.history.length}</summary><ul>{job.history.slice().reverse().map((entry) => <li key={entry.id}>{new Date(entry.at).toLocaleString()}{entry.nodeId ? ` · ${entry.nodeId}` : ""} · {entry.detail}{entry.runId ? ` · run ${entry.runId}` : ""}{entry.commit ? <> · <code>{entry.commit}</code></> : null}</li>)}</ul></details>
    </article>)}</div> : null}
  </section>;
}
