import { DISPATCH_LABELS, PRIORITY_OPTIONS, dispatchLabel } from "../src/run-outcome.js";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { api, ApiError, enc, post, showToast } from "./lib.js";
import { confirmAction } from "./confirm-state.js";
import { presentFolders, workbenchFolders } from "./workbench-folders.js";
import { LaunchProfilesPanel } from "./launch-profiles.js";
const FilteredTasksPanel = lazyView(() => import("./filtered-tasks.js").then((module) => module.FilteredTasksPanel));
import { CoordinatedChangesPanel } from "./repo-coordination.js";
import { repo, runs, route, projects, projectsLoaded } from "./state.js";
import type { VerificationProfile, VerificationReport } from "../src/verification.js";
import type { RevertPreview } from "../src/checkpoint-review.js";
import type { CheckpointHunks } from "../src/workspace-changes.js";
import { lazyView } from "./lazy-view.js";
const CodeBrowser = lazyView(() => import("./code-browser.js").then((module) => module.CodeBrowser));
import type { RepositoryTool } from "./navigation.js";

type Tab = "verification" | "code" | "context" | "history" | "services" | "coordination" | "filtered-tasks";
const TOOL_GROUPS: readonly { label: string; tools: readonly (readonly [Tab, string])[] }[] = [
  { label: "Code and verification", tools: [["verification", "Verification"], ["code", "Code"], ["context", "Context"], ["history", "History"]] },
  { label: "Repository operations", tools: [["services", "Services"], ["coordination", "Coordinated changes"], ["filtered-tasks", "Filtered tasks"]] },
];
/** How long something has been running: "45 s", "3 min 05 s". */
const elapsed = (ms: number) => { const seconds = Math.floor(ms / 1000); return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`; };
/** A raw status value as a sentence-case pill label ("needs-changes" → "Needs changes"). */
const sentence = (value: string) => { const text = value.replace(/-/g, " "); return text.charAt(0).toUpperCase() + text.slice(1); };
interface Checkpoint { sha: string; at: number; subject: string; owned?: boolean }

export function downloadArtifact(name: string, contents: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkbenchView({ projectId, initialFolder, initialTool, onNavigate }: { projectId?: string; initialFolder?: string; initialTool?: RepositoryTool; onNavigate?: (folder: string, tool: RepositoryTool) => void }) {
  const project = projects.value.find(item => item.id === projectId);
  const repositories = projectId ? project?.repos ?? [] : repo.value ? [repo.value] : [];
  const [tab, updateTab] = useState<Tab>(initialTool ?? "verification");
  const [folder, updateFolder] = useState(initialFolder ?? repositories[0] ?? "");
  const setTab = (value: Tab) => { updateTab(value); onNavigate?.(folder, value); };
  const setFolder = (value: string) => { updateFolder(value); onNavigate?.(value, tab); };
  useEffect(() => { updateTab(initialTool ?? "verification"); }, [initialTool]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<VerificationProfile | null>(null);
  const [preset, setPreset] = useState("standard");
  const [base, setBase] = useState("HEAD");
  const [baseline, setBaseline] = useState("");
  const [setup, setSetup] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [report, setReport] = useState<(VerificationReport & { markdown: string; commit: string }) | null>(null);
  const [verifying, setVerifying] = useState<{ controller: AbortController; startedAt: number } | null>(null);
  const [, setTick] = useState(0);
  const [paths, setPaths] = useState("");
  const [context, setContext] = useState<any>(null);
  const [history, setHistory] = useState<{ head: string; checkpoints: Checkpoint[] } | null>(null);
  const [checkpoint, setCheckpoint] = useState("");
  const [comparison, setComparison] = useState<{ from:string;to:string;stat:string;patch:string;files:{status:string;path:string}[];truncated:boolean } | null>(null);
  const [revertPreview, setRevertPreview] = useState<RevertPreview | null>(null);
  const [applyPaths, setApplyPaths] = useState("");
  const [hunkPath, setHunkPath] = useState("");
  const [hunks, setHunks] = useState<CheckpointHunks | null>(null);
  const [chosenHunks, setChosenHunks] = useState<string[]>([]);
  const [taskProjectId, setTaskProjectId] = useState("");
  const availableRuns = [...runs.value.values()].filter((run) => repositories.includes(run.repo) && (!projectId || run.project === projectId || !run.project));
  // Archiving can remove a run's worktrees while the run keeps their records: offer an archived run's folder only once it's found on disk.
  const archivedKey = [...new Set(availableRuns.filter((run) => run.archived).flatMap((run) => run.worktrees.map((tree) => tree.path)))].sort().join("\0");
  const [retained, setRetained] = useState<{ key: string; paths: Set<string> }>({ key: "", paths: new Set() });
  useEffect(() => {
    if (!archivedKey) return;
    let current = true;
    void presentFolders(archivedKey.split("\0"), (path) => api<{ entries: { name: string }[]; truncated: boolean }>(`/api/fs?hidden=1&path=${enc(path)}`).then((listing) => ({ names: listing.entries.map((entry) => entry.name), truncated: listing.truncated }), () => null))
      .then((paths) => { if (current) setRetained({ key: archivedKey, paths }); });
    return () => { current = false; };
  }, [archivedKey]);
  const checked = !archivedKey || retained.key === archivedKey;
  const folders = workbenchFolders(availableRuns, checked ? retained.paths : new Set());
  const selectedRun = folders.find((entry) => entry.path === folder)?.run;
  const selectedTree = selectedRun?.worktrees.find((tree) => tree.path === folder);
  const removedTree = !selectedTree && availableRuns.some((run) => run.archived && run.worktrees.some((tree) => tree.path === folder));
  const selectedCheckpoint = history?.checkpoints.find((item) => item.sha === checkpoint);
  // With nothing chosen, the only project is the choice; with several, the user picks one, as each has its own file policy.
  const taskProject = project ?? projects.value.find((project) => project.id === taskProjectId) ?? projects.value.find((project) => project.repos.includes(selectedRun?.repo ?? folder)) ?? (projects.value.length === 1 ? projects.value[0] : undefined);
  const runAction = async (path: string, body: unknown) => perform(async () => { await post(path, body); showToast("Updated"); });
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  // A verification can take as long as its gates' timeouts: show it's still going, and for how long.
  useEffect(() => { if (!verifying) return; const timer = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(timer); }, [verifying]);
  const verify = () => perform(async () => {
    const controller = new AbortController();
    setReport(null); setVerifying({ controller, startedAt: Date.now() });
    try { setReport(await api("/api/verification", { method: "POST", body: JSON.stringify({ repo: folder, profile, baseRef: base, baseline, setup, repeats }), signal: controller.signal })); }
    catch (error) { if (!controller.signal.aborted) throw error; showToast("Verification cancelled"); }
    finally { setVerifying(null); }
  });
  useLayoutEffect(() => { if (!initialFolder && !folder && repositories[0]) updateFolder(repositories[0]); }, [repositories.join("\0"), folder]);
  useEffect(() => { setReport(null); setProfile(null); setHistory(null); setContext(null); setComparison(null); setRevertPreview(null); setHunks(null); setError(""); }, [folder]);
  // Here the folder comes only from this page's own list: once it's gone from the list, go back to the repository.
  useEffect(() => { if (!projectId && checked && folder && !repositories.includes(folder) && !selectedTree) updateFolder(repositories[0] ?? ""); }, [checked, folder, !!selectedTree]);
  if (projectId && !project) return <p role="status">{projectsLoaded.value ? "This project no longer exists." : "Loading project…"}</p>;
  if (projectId && folder && removedTree) return <p class="msg warn" role="status">{checked ? "This run's worktree was removed when the run was archived. Resume the run to recreate it, or choose a repository above." : "Checking this run worktree…"}</p>;
  if (projectId && folder && !repositories.includes(folder) && !selectedTree) return <p class="msg warn" role="status">This repository or run worktree is unavailable in this project. Choose a repository above.</p>;
  return <div class="workbench">
    <header class="page-head"><div class="page-head-text"><h3>Inspect, verify, and recover</h3>
      <p>Check the repository, inspect code and context, and manage results with evidence.</p></div></header>
    <div class="wb-target"><label class="lbl" for="wb-folder">Repository or run worktree</label>
    <select id="wb-folder" class="field" value={folder} disabled={busy} onChange={(event) => setFolder(event.currentTarget.value)}>
      {repositories.length ? repositories.map(repository => <option key={repository} value={repository}>{repository}</option>) : <option value="">Choose a repository in New run</option>}
      {folders.map(({ path, name, run }) => <option key={path} value={path}>{(run.task.split("\n")[0] || "(no task)").slice(0, 50)} · {name}{run.archived ? " · archived" : ""}</option>)}
    </select></div>
    <div class="wb-mobile-tool"><label class="lbl" for="wb-tool">Repository tool</label><select id="wb-tool" class="field" value={tab} disabled={busy} onChange={(event) => setTab(event.currentTarget.value as Tab)}>{TOOL_GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.tools.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</optgroup>)}</select></div>
    <div class="wb-layout">
    {/* OntoLab's sidebar nav: the tools in their groups, the open one selected */}
    <nav class="wb-tabs" aria-label="Repository tools">{TOOL_GROUPS.map((group, n) => <div class="wb-group" role="group" aria-labelledby={`wb-group-${n}`} key={group.label}><div class="wb-group-label" id={`wb-group-${n}`}>{group.label}</div>{group.tools.map(([id, label]) => <button key={id} type="button" class="wb-tab" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>)}</div>)}</nav>
    <div class="wb-main">
    {!folder && tab !== "coordination" && tab !== "filtered-tasks" ? <p class="help wb-note">Choose a repository in New run first.</p> : null}
    {error ? <div class="msg err" role="alert">{error}</div> : null}
    {busy && !verifying ? <p class="help wb-note" role="status">Working…</p> : null}
    {tab === "verification" ? <section class="wb-card">
      <h2>Verification profile</h2>
      <div class="wb-row"><label>Profile <select class="field" value={preset} onChange={(event) => setPreset(event.currentTarget.value)}><option value="lightweight">Lightweight</option><option value="standard">Standard</option><option value="thorough">Thorough</option></select></label><button class="btn" disabled={!folder || busy} onClick={() => perform(async () => { const detected = await api<VerificationProfile>(`/api/verification/profile?repo=${enc(folder)}&preset=${preset}`); setProfile(detected); setSetup(detected.setup ?? ""); })}>Detect checks</button></div>
      {profile ? <>
        <p class="help">{profile.source ? `Detected from ${profile.source}. ` : ""}Required gates must pass. A skipped gate or flaky result cannot verify a change.</p>
        {profile.checks.map((check, index) => <div class="wb-check" key={check.id}><span>{check.title ?? check.id}</span><input class="field" type="text" aria-label={`Command for ${check.id}`} value={check.command} onInput={(event) => setProfile({ ...profile, checks: profile.checks.map((item, n) => n === index ? { ...item, command: event.currentTarget.value } : item) })} /><label class="wb-timeout">Timeout (min)<input class="field" type="number" min={1 / 60_000} max={30} step="any" aria-label={`Timeout for ${check.id} in minutes`} value={check.timeoutMs / 60_000} onChange={(event) => { const minutes = event.currentTarget.valueAsNumber; if (Number.isFinite(minutes) && minutes > 0) setProfile({ ...profile, checks: profile.checks.map((item, n) => n === index ? { ...item, timeoutMs: Math.max(1, Math.round(Math.min(30, minutes) * 60_000)) } : item) }); else event.currentTarget.value = String(check.timeoutMs / 60_000); }} /></label><label><input type="checkbox" checked={check.required} onChange={(event) => setProfile({ ...profile, checks: profile.checks.map((item, n) => n === index ? { ...item, required: event.currentTarget.checked } : item) })} /> Required</label></div>)}
        <button class="btn small" disabled={profile.checks.length >= 12} onClick={() => setProfile({ ...profile, checks: [...profile.checks, { id: `custom-${profile.checks.length + 1}`, kind: "custom", command: "", required: true, timeoutMs: 600_000 }] })}>Add custom gate</button>
        <details><summary>Requirement evidence mapping</summary><p class="help">Describe each criterion and select the checks that exercise it. A criterion with no checks, or a failing mapped check, remains uncovered. Review whether the checks actually test the stated behavior.</p>{(profile.requirements ?? []).map((requirement, index) => <div key={requirement.id}><label>{requirement.id}<input class="field" aria-label={`Description for ${requirement.id}`} value={requirement.description} onInput={(event) => setProfile({ ...profile, requirements: profile.requirements!.map((item, n) => n === index ? { ...item, description: event.currentTarget.value } : item) })} /></label><div class="wb-row">{profile.checks.map((check) => <label class="check" key={check.id}><input type="checkbox" checked={requirement.checks.includes(check.id)} onChange={(event) => setProfile({ ...profile, requirements: profile.requirements!.map((item, n) => n === index ? { ...item, checks: event.currentTarget.checked ? [...item.checks, check.id] : item.checks.filter((id) => id !== check.id) } : item) })} /> {check.title ?? check.id}</label>)}</div></div>)}<button class="btn small" disabled={(profile.requirements?.length ?? 0) >= 48} onClick={() => setProfile({ ...profile, requirements: [...(profile.requirements ?? []), { id: `criterion-${(profile.requirements?.length ?? 0) + 1}`, description: "", checks: [] }] })}>Add criterion</button></details>
        <div class="wb-row"><label>Commit or branch<input class="field" value={base} onInput={(event) => setBase(event.currentTarget.value)} /></label><label>Compare baseline<input class="field" placeholder="Optional base commit" value={baseline} onInput={(event) => setBaseline(event.currentTarget.value)} /></label><label>Attempts per gate<select class="field" value={repeats} onChange={(event) => setRepeats(Number(event.currentTarget.value))}>{[1, 2, 3].map((n) => <option value={n}>{n}</option>)}</select></label></div>
        <label>Setup command<input class="field" placeholder="Optional, e.g. npm ci" value={setup} onInput={(event) => setSetup(event.currentTarget.value)} /></label>
        <p class="help">Executes repository code in a temporary worktree at the selected commit. Uncommitted changes are excluded. Baseline comparison runs the same profile on both commits. Each gate stops at its timeout (at most 30 minutes); a whole verification stops after an hour.</p>
        <div class="wb-row"><button class="btn primary" disabled={busy || !profile.checks.length || profile.checks.some((check) => !check.command.trim())} onClick={verify}>Run verification</button><button class="btn" onClick={() => downloadArtifact("verification-profile.json", JSON.stringify(profile, null, 2))}>Export profile</button></div>
        {verifying ? <div class="wb-progress" role="status"><span>Running verification · {elapsed(Date.now() - verifying.startedAt)} so far</span><button class="btn" onClick={() => verifying.controller.abort()}>Cancel verification</button></div> : null}
      </> : <p class="help">Detect commands from this repository, then review the profile before executing it.</p>}
      {report ? <><h3>Result: {report.state}</h3><p class="help">Commit {report.commit.slice(0, 12)}</p><div class="wb-scroll"><table><thead><tr><th>Gate</th><th>Required</th><th>Result</th><th>Evidence</th></tr></thead><tbody>{report.checks.map((gate) => <tr key={gate.check.id}><td>{gate.check.title ?? gate.check.id}</td><td>{gate.check.required ? "Yes" : "No"}</td><td><span class={`badge ${gate.diagnosis === "passed" ? "ok" : gate.diagnosis === "failed" || gate.diagnosis === "regression" ? "err" : "warn"}`}>{gate.diagnosis !== "passed" && gate.attempts.length && gate.attempts.every((attempt) => attempt.timedOut) ? "Timed out" : sentence(gate.diagnosis)}</span>{gate.reason ? <p class="help">{gate.reason}</p> : null}</td><td><details><summary>{gate.attempts.length} {gate.attempts.length === 1 ? "attempt" : "attempts"}</summary>{gate.attempts.map((attempt, index) => <pre key={index}>{attempt.output || `Exit ${attempt.exitCode}`}</pre>)}</details></td></tr>)}</tbody></table></div>{report.skipped.map((gate) => <p class="msg err">{gate.check.id}: {gate.reason}</p>)}{report.requirements?.length ? <section aria-label="Requirement verification results"><h4>Requirement evidence</h4><ul>{report.requirements.map((requirement) => <li key={requirement.id}>{requirement.covered ? "Covered" : "Uncovered"}: {requirement.description}{requirement.missing.length ? ` · missing ${requirement.missing.join(", ")}` : !requirement.covered ? " · no checks mapped" : ""}</li>)}</ul></section> : null}<button class="btn" onClick={() => downloadArtifact("verification.md", report.markdown, "text/markdown")}>Export report</button></> : null}
    </section> : null}
    {tab === "code" ? <CodeBrowser key={folder} folder={folder} /> : null}
    {tab === "context" ? <section class="wb-card"><h2>Context inspector</h2><p class="help">Preview explicit file context before selecting it for a task. Credential-file contents are excluded, and recognizable secrets are redacted.</p><textarea class="field" aria-label="Context file paths" rows={5} placeholder="One repository-relative file per line" value={paths} onInput={(event) => setPaths(event.currentTarget.value)} /><button class="btn" disabled={!folder || busy || !paths.trim()} onClick={() => perform(async () => setContext(await post("/api/workspace/context", { repo: folder, paths: paths.split("\n").map((path) => path.trim()).filter(Boolean) })))}>Inspect context</button>{context ? <><p>{context.bytes.toLocaleString()} bytes · approximately {context.approximateTokens.toLocaleString()} tokens</p><p class="help">{context.note}</p>{context.files.map((file: any) => <details key={file.path}><summary>{file.path} {file.sensitive ? "· sensitive" : `· ${file.bytes} bytes`}</summary><pre>{file.omitted ?? file.preview}</pre></details>)}</> : null}</section> : null}
    {tab === "history" ? <section class="wb-card"><h2>Checkpoints and run controls</h2>{selectedRun ? <><p>{selectedRun.task.split("\n")[0]} · {dispatchLabel(selectedRun) ?? selectedRun.status}</p><div class="wb-row"><button class="btn" onClick={() => { route.value = { view: "run", id: selectedRun.id }; }}>Open run</button>{selectedRun.status === "running" ? <button class="btn" disabled={busy} onClick={() => runAction(`/api/runs/${selectedRun.id}/pause`, { paused: !selectedRun.pauseRequested })}>{selectedRun.pauseRequested ? DISPATCH_LABELS.resume : DISPATCH_LABELS.pause}</button> : null}<label>Priority<select class="field" aria-label="Run priority" value={selectedRun.priority ?? 0} onChange={(event) => runAction(`/api/runs/${selectedRun.id}/priority`, { priority: Number(event.currentTarget.value) })}>{PRIORITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button class="btn" disabled={busy} onClick={() => perform(async () => downloadArtifact(`run-${selectedRun.id}.json`, JSON.stringify(await api(`/api/runs/${selectedRun.id}/export?transcript=1`), null, 2)))}>Export run evidence</button></div></> : <p class="help">Select a run worktree above to pause, prioritize, fork, or apply its checkpoint files.</p>}
      <button class="btn" disabled={!folder || busy} onClick={() => perform(async () => { const data = await api<{ head: string; checkpoints: Checkpoint[] }>(`/api/workspace/checkpoints?repo=${enc(folder)}${selectedRun?.baseRef ? `&base=${enc(selectedRun.baseRef)}` : ""}`); setHistory(data); setCheckpoint(data.checkpoints[0]?.sha ?? ""); })}>Load checkpoints</button>
      {history ? <><div class="wb-row"><select class="field" aria-label="Checkpoint" value={checkpoint} onChange={(event) => { setCheckpoint(event.currentTarget.value); setComparison(null); setRevertPreview(null); }}>{history.checkpoints.map((item) => <option value={item.sha}>{item.sha.slice(0, 8)} · {item.subject}{item.owned === false ? " · before this run" : item.owned && item.sha === selectedRun?.baseRef ? " · where this run started" : ""}</option>)}</select>{selectedRun ? <button class="btn" aria-describedby={selectedCheckpoint?.owned === false ? "wb-fork-help" : undefined} disabled={busy || !checkpoint || selectedCheckpoint?.owned === false} onClick={() => perform(async () => { const fork = await post<{ id: string }>(`/api/runs/${selectedRun.id}/fork`, { commit: checkpoint }); route.value = { view: "run", id: fork.id }; })}>Fork from checkpoint</button> : null}</div>{selectedRun && selectedCheckpoint?.owned === false ? <p class="help" id="wb-fork-help">This commit is from before the run started, so it holds none of the run's work. Fork from where the run started or a later commit, or start a new run from it.</p> : null}{selectedRun ? <><textarea class="field" aria-label="Checkpoint paths" placeholder="Files to restore from this checkpoint, one per line" value={applyPaths} onInput={(event) => setApplyPaths(event.currentTarget.value)} /><p class="help">Applying selected files changes this worktree without committing them. A file the checkpoint doesn't have is deleted; you're asked first. The worktree must be clean and idle; existing changes are preserved by refusing the operation.</p><button class="btn" disabled={busy || selectedRun.status === "running" || !applyPaths.trim()} onClick={() => perform(async () => {
        const body = { repo: folder, runId: selectedRun.id, source: checkpoint, expectedHead: history.head, paths: applyPaths.split("\n").map((path) => path.trim()).filter(Boolean) };
        let result: { deleted?: string[] };
        try { result = await post("/api/workspace/apply-checkpoint", body); }
        catch (error) {
          if (!(error instanceof ApiError) || error.confirm !== "deleteFiles") throw error;
          if (!await confirmAction(error.message, { title: "Delete files from the worktree?", confirmLabel: "Apply and delete", danger: true })) return;
          result = await post("/api/workspace/apply-checkpoint", { ...body, confirmDeletes: true });
        }
        const deleted = result.deleted ?? [];
        showToast(deleted.length ? `Checkpoint files applied; deleted ${deleted.length === 1 ? deleted[0] : `${deleted.length} files`}. Review before committing` : "Selected checkpoint files applied; review before committing", deleted.length ? 6000 : 2000);
      })}>Apply selected files</button></> : null}</> : null}
    </section> : null}
    {tab === "history" && history ? <section class="wb-card" aria-label="Full checkpoint comparison"><h2>Compare and revert commits</h2><p class="help">Compare every changed file between the selected checkpoint and the observed current HEAD. Reverting computes the inverse of one non-merge commit on a disposable checkout, then stages that reviewed change in a clean, idle owned worktree. Commit it yourself to record the revert.</p><div class="wb-row"><button class="btn" disabled={busy || !checkpoint} onClick={() => perform(async () => setComparison(await post("/api/workspace/compare-checkpoint", { repo:folder,from:checkpoint,to:history.head })))}>Compare selected checkpoint to HEAD</button>{selectedRun ? <button class="btn" disabled={busy || selectedRun.status === "running" || !checkpoint} onClick={() => perform(async () => { setRevertPreview(null); setRevertPreview(await post("/api/workspace/preview-revert", { repo:folder,runId:selectedRun.id,commit:checkpoint,expectedHead:history.head })); })}>Preview inverse commit</button> : null}</div>{comparison ? <><p class="help">{comparison.from.slice(0,12)} → {comparison.to.slice(0,12)} · {comparison.files.length} changed paths{comparison.truncated ? " · preview truncated" : ""}</p>{comparison.stat.trim() ? <pre>{comparison.stat}</pre> : null}<details><summary>Full commit patch</summary><pre>{comparison.patch || "No changes between these commits."}</pre></details></> : null}{revertPreview && selectedRun ? <div class="at-notice" aria-label="Reviewed commit revert"><h4>Revert: {revertPreview.subject}</h4><p class="help">Commit {revertPreview.commit.slice(0,12)} · current HEAD {revertPreview.head.slice(0,12)}. Review the entire inverse patch before applying it. Conflicting reversions leave this worktree unchanged.</p>{revertPreview.stat.trim() ? <pre>{revertPreview.stat}</pre> : null}<details open><summary>Inverse patch to stage</summary><pre>{revertPreview.patch}</pre></details><button class="btn primary" disabled={busy || selectedRun.status === "running"} onClick={() => perform(async () => { await post("/api/workspace/apply-revert", { repo:folder,runId:selectedRun.id,commit:revertPreview.commit,expectedHead:revertPreview.head,fingerprint:revertPreview.fingerprint }); setRevertPreview(null); showToast("Inverse change staged. Review and commit it to record the revert.",6000); })}>Stage reviewed inverse change</button></div> : null}</section> : null}
    {tab === "history" && history && selectedRun ? <section class="wb-card"><h2>Apply selected hunks</h2><p class="help">Compare one existing text file against the selected checkpoint. Selected hunks remain unstaged for review; the run worktree must be clean and idle.</p><div class="wb-row"><input class="field" aria-label="File for checkpoint hunks" value={hunkPath} placeholder="Repository-relative file" onInput={(event) => setHunkPath(event.currentTarget.value)} /><button class="btn" disabled={busy || selectedRun.status === "running" || !hunkPath.trim()} onClick={() => perform(async () => { setHunks(await post("/api/workspace/checkpoint-hunks", { repo: folder, runId: selectedRun.id, source: checkpoint, path: hunkPath.trim() })); setChosenHunks([]); })}>Compare hunks</button></div>{hunks ? <><p>{hunks.hunks.length} hunks · {hunks.source.slice(0, 12)}</p>{hunks.hunks.map((hunk) => <details key={hunk.id}><summary><label><input type="checkbox" checked={chosenHunks.includes(hunk.id)} onChange={(event) => setChosenHunks(event.currentTarget.checked ? [...chosenHunks, hunk.id] : chosenHunks.filter((id) => id !== hunk.id))} /> {hunk.header}</label></summary><pre>{hunk.patch}</pre></details>)}<button class="btn" disabled={busy || !chosenHunks.length || selectedRun.status === "running"} onClick={() => perform(async () => { await post("/api/workspace/apply-hunks", { repo: folder, runId: selectedRun.id, source: hunks.source, path: hunks.path, expectedHead: hunks.head, hunks: chosenHunks }); setHunks(null); showToast("Selected hunks applied; review the unstaged changes"); })}>Apply chosen hunks</button></> : null}</section> : null}
    {tab === "filtered-tasks" ? <><div class="wb-scope"><label class="lbl" for="filtered-tasks-project">Filtered tasks project</label><select class="field" id="filtered-tasks-project" disabled={!!projectId || !projects.value.length} value={taskProject?.id ?? ""} onChange={(event) => setTaskProjectId(event.currentTarget.value)}>{taskProject ? null : <option value="" disabled>{projects.value.length ? "Choose a project" : projectsLoaded.value ? "No projects yet" : "Loading projects…"}</option>}{projects.value.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></div>{taskProject ? <><p class="help wb-note">Manage project filesystem rules in <a href="#/settings/projects">Settings → Projects &amp; access</a>.</p><FilteredTasksPanel key={taskProject.id} projectId={taskProject.id} repos={taskProject.repos} /></> : projects.value.length ? <p class="help wb-note">Choose a project above to run a filtered task in it.</p> : projectsLoaded.value ? <p class="help wb-note">Create a project in <a href="#/settings/projects">Settings</a> first.</p> : <p class="help wb-note" role="status">Loading projects…</p>}</> : null}
    {tab === "coordination" ? <CoordinatedChangesPanel projectId={projectId} /> : null}
    {tab === "services" ? selectedRun && selectedTree ? <LaunchProfilesPanel key={`${selectedRun.id}/${selectedTree.name}`} runId={selectedRun.id} worktree={selectedTree.name} /> : <p class="help wb-note">Select a run worktree to preview and launch its configured services.</p> : null}
    </div></div>
  </div>;
}
