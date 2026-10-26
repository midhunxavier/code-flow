import { DISPATCH_LABELS, PRIORITY_OPTIONS } from "../src/run-outcome.js";
import { useEffect, useRef, useState } from "preact/hooks";
import type { outcomeMetrics, TaskIntent, workflowRecommendations } from "../src/experience.js";
import { progressSummary } from "../src/experience.js";
import { api, duration, enc, post, usePoll } from "./lib.js";
import { navigate, openBrowserPage, cancelPreviewBrowserPage, draftTo, patterns, runs, setPattern } from "./state.js";
import type { DevServer, RunSummary, Step } from "./types.js";
import { ScenarioEvidence } from "./journeys.js";
import type { Journey } from "../src/journeys.js";
import { checksLabel, checksSummary, agentReviewLabel, executionLabel, integrityFor } from "./run-experience.js";
import { IntegrityNote } from "./run-evidence.js";
import { continuePreviewSetup, requestPreviewSetup, startResultPreview, previewSetupFailed, NO_PREVIEW_COMMAND, previewStoppedMessage, stopResultPreview } from "./result-preview.js";
import { ResultNextStep } from "./result-next-step.js";

export { intentDraft } from "./composer-draft-fields.js";
type Experience = { metrics: ReturnType<typeof outcomeMetrics>; recommendations: ReturnType<typeof workflowRecommendations> };
export function OutcomeMetrics({ repository, project }: { repository?: string; project?: string }) {
  const [data, setData] = useState<Experience>(), [error, setError] = useState("");
  usePoll(current => api<Experience>(`/api/experience?${new URLSearchParams({ ...(repository ? { repo: repository } : {}), ...(project ? { project } : {}) })}`).then(value => current() && (setData(value), setError("")), error => current() && setError(error.message)), 15000, [repository, project]);
  if (error) return <p class="help" role="status">Outcome metrics unavailable: {error}</p>;
  if (!data) return null;
  const m = data.metrics;
  return <section class="outcome-metrics" aria-label="Useful outcomes"><h3>Useful outcomes</h3><dl class="experience-metrics"><div><dt>Accepted by you</dt><dd>{m.rated ? `${m.accepted} / ${m.rated} rated` : "Not rated yet"}</dd></div><div><dt>Time to verified result</dt><dd>{m.medianVerifiedMs === undefined ? "No verified results" : `${duration(m.medianVerifiedMs)} median`}</dd></div><div><dt>Recorded correction time</dt><dd>{m.reworkSamples ? `${m.medianReworkMinutes} min median` : "Not recorded"}</dd></div><div><dt>Shipped</dt><dd>{m.shipped} runs</dd></div></dl><p class="help">All recorded history in this scope. Time includes waits; corrections use {m.reworkSamples} recorded samples. {m.completed - m.rated} finished runs are unrated. Shipped means a recorded merge.</p></section>;
}
export function WorkflowRecommendation({ repository, intent }: { repository: string; intent?: TaskIntent }) {
  const [data, setData] = useState<Experience>(), [error, setError] = useState("");
  useEffect(() => { let alive = true; setData(undefined); setError(""); if (repository) api<Experience>(`/api/experience?repo=${enc(repository)}${intent ? `&intent=${intent}` : ""}`).then(value => alive && setData(value), error => alive && setError(error.message)); return () => { alive = false; }; }, [repository, intent]);
  const eligible = data?.recommendations.filter(item => item.completed >= 3 && patterns.value.some(pattern => pattern.id === item.pattern)) ?? [];
  if (!repository) return null;
  return <details class="workflow-recommendation"><summary>Workflow advice from this repository</summary>{error ? <p role="alert">{error}</p> : null}{!eligible.length ? <p class="help">Keep using the suggested workflow. Recommendations need at least three finished runs per workflow{intent ? ` with the ${intent} task type` : ""}; older unlabelled runs do not count toward a task type.</p> : <><p class="help">Ranked by the conservative lower bound of recorded check success. These tasks differ in difficulty; this is evidence to consider, not a prediction. Your workflow changes only when you choose Apply.</p>{eligible.map(item => <article key={item.pattern}><b>{patterns.value.find(pattern => pattern.id === item.pattern)?.name}</b><p>{item.verified}/{item.completed} runs passed checks · 95% interval {Math.round(item.confidence.low * 100)}–{Math.round(item.confidence.high * 100)}% · {item.rated ? `${item.accepted}/${item.rated} rated results accepted` : "No acceptance feedback"}{item.reworkSamples ? ` · ${item.medianReworkMinutes} min median corrections (${item.reworkSamples} samples)` : ""}</p><button class="btn small" onClick={() => setPattern(item.pattern)}>Apply {patterns.value.find(pattern => pattern.id === item.pattern)?.name}</button><details><summary>Supporting runs</summary>{item.runIds.map(id => <a class="evidence-run-link" key={id} href={`#/run/${enc(id)}`}>{id}</a>)}</details></article>)}</>}</details>;
}
export function LiveProgress({ run, steps }: { run: RunSummary; steps: Step[] }) {
  const status = progressSummary(run, steps);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const change = async (path: string, body: object) => { setBusy(true); setError(""); try { await post(`/api/runs/${run.id}/${path}`, body); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <section class={`live-progress ${run.status === "running" && !run.pauseRequested ? "is-running" : ""}`} aria-label="Current progress">
    <div class="live-progress-copy"><h3><span class="live-progress-dot" aria-hidden="true" />{status.title}</h3><p>{status.detail.slice(0, 700)}{status.detail.length > 700 ? "…" : ""}</p></div>
    {run.status === "running" ? <div class="live-progress-controls">
      <button class="btn small" disabled={busy} onClick={() => void change("pause", { paused: !run.pauseRequested })}>{run.pauseRequested ? DISPATCH_LABELS.resume : DISPATCH_LABELS.pause}</button>
      <label>Priority<select class="field" aria-label="Run priority" disabled={busy} value={run.priority ?? 0} onChange={e => void change("priority", { priority: Number(e.currentTarget.value) })}>{PRIORITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </div> : null}
    {error ? <p class="live-progress-error" role="alert">{error}</p> : null}
  </section>;
}
export function ResultStudio({ run }: { run: RunSummary }) {
  // The primary result (a race's winner) comes first and is shown by default.
  const choices = run.artifacts.flatMap(artifact => run.worktrees.filter(tree => tree.branch === artifact.branch)).filter((tree, index, trees) => trees.findIndex(other => other.name === tree.name) === index);
  const [previewSettings, setPreviewSettings] = useState(false);
  const [selected, setSelected] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [command, setCommand] = useState(run.app?.command ?? "");
  const [server, setServer] = useState<DevServer | null>(null), [journey, setJourney] = useState<Journey>(), [head, setHead] = useState(""), [workingChanges, setWorkingChanges] = useState(false), [fileCount, setFileCount] = useState<number | null>(null);
  const tree = choices.find(tree => tree.name === selected) ?? choices[0];
  useEffect(() => { let alive = true; setHead(""); setServer(null); setFileCount(null); if (tree) { api<{ head: string; files: unknown[]; workingChanges?: boolean }>(`/api/runs/${run.id}/review-coverage?branch=${enc(tree.branch)}`).then(value => { if (alive) { setHead(value.head); setWorkingChanges(!!value.workingChanges); setFileCount(value.files.length); } }, error => alive && setError(error.message)); api<DevServer | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`).then(value => alive && setServer(value), error => alive && setError(error.message)); } return () => { alive = false; }; }, [run.id, tree?.branch, run.endedAt]);
  useEffect(() => { let alive = true; if (run.journeyId) api<{ journey: Journey }>(`/api/journeys/${run.journeyId}`).then(value => alive && setJourney(value.journey), error => alive && setError(error.message)); return () => { alive = false; }; }, [run.journeyId]);
  useEffect(() => {
    let alive = true;
    if (tree) {
      api<{ command: string } | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve/config`).then(value => { if (alive) setCommand(value?.command ?? ""); }, () => {});
      continuePreviewSetup(run, tree).then(app => { if (app && alive) { setServer(app); openBrowserPage(app.url, run.id, app.startedAt); } }, error => { if (alive) setError(error.message); });
    }
    return () => { alive = false; };
  }, [run.id, tree?.name, run.endedAt]);
  usePoll(current => {
    if (!tree) return;
    return api<DevServer | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`).then(value => {
      if (!current()) return; setServer(value);
      if (value?.status === "exited") setError(previewStoppedMessage(value));
    }, error => current() && setError(error.message));
  }, 2000, [run.id, tree?.name, busy], !!tree && !busy && !run.archived && (fileCount !== 0 || workingChanges));
  if (!tree || run.archived) return null;
  // A PR can still need an update or merge when this run made no local changes.
  // Keep its delivery controls without promising a review or preview of empty work.
  if (fileCount === 0 && !workingChanges) return run.testRun || run.source?.kind === "pr" || run.prs[tree.branch]
    ? <section class="result-studio result-compact" aria-label={run.testRun ? "Test run" : "Pull request status"}><ResultNextStep key={`${run.id}/${tree.branch}`} run={run} branch={tree.branch}>{null}</ResultNextStep></section>
    : null;
  const tryResult = async () => {
    setBusy(true); setError("");
    try {
      const configured = command.trim() || (await api<{ command: string } | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve/config`))?.command;
      if (!configured && server?.status !== "running") {
        if (previewSetupFailed(run, tree)) { setPreviewSettings(true); throw new Error(NO_PREVIEW_COMMAND); }
        await requestPreviewSetup(run, tree); return;
      }
      const app = await startResultPreview(run, tree, configured);
      if (app) { setServer(app); openBrowserPage(app.url, run.id, app.startedAt); }
    } catch (error) { setError((error as Error).message); setServer(await api<DevServer | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`).catch(() => null)); }
    finally { setBusy(false); }
  };
  const rate = async (decision: "accepted" | "needs-work") => {
    setBusy(true); setError("");
    try {
      await post(`/api/runs/${run.id}/outcome`, { decision, branch: tree.branch, expectedHead: head });
      if (decision === "needs-work" && run.status === "done") {
        if (run.projectTeam && run.project) navigate({ view: "project", id: run.project, section: "automation", kind: "missions" });
        else if (!run.projectTeam) navigate({ view: "review", id: run.id, branch: tree.branch });
      }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const checks = checksSummary(run, false, tree.branch), review = agentReviewLabel(run, tree.branch), integrity = integrityFor(run, tree.branch);
  // Never "Ready to review" under a "Needs attention" status, or for a pass that changed the tests.
  const attention = checks === "Failed" || review === "Changes requested" || review === "Outdated" || integrity.length > 0 || executionLabel(run) === "Needs attention";
  return <section class={`result-studio result-compact${attention ? " needs-attention" : ""}`} aria-label="Try and assess the result">
    <ResultNextStep key={`${run.id}/${tree.branch}`} run={run} branch={tree.branch}><div class="result-primary"><div><h3>{run.status !== "done" ? "Partial work saved" : fileCount === null ? "Inspect saved work" : integrity.length ? "Check the test changes before merging" : attention ? "Changes need attention" : "Ready to review"}</h3>
      <p class="help">Checks: {checks} · Review: {review}</p></div>
      <div class="experience-actions"><button class={`btn${run.status === "done" && fileCount !== null ? " primary" : ""}`} onClick={() => navigate({ view: "review", id: run.id, branch: tree.branch })}>Review changes</button>
        <button class="btn" disabled={busy || !!run.projectTeam && !command.trim()} onClick={tryResult}>{busy ? "Preparing preview…" : server?.status === "running" ? "Open preview" : previewSetupFailed(run, tree) ? "Set up preview…" : "Preview"}</button>
        {server?.status === "running" ? <button class="btn small" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { cancelPreviewBrowserPage(server.url, server.startedAt, run.id); await stopResultPreview(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`, server); setServer(null); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }}>Stop preview</button> : null}</div>
    </div></ResultNextStep>
    {integrity.length ? <IntegrityNote issues={integrity} /> : null}
    <p class="result-chat-hint">{run.testRun ? "Review the test evidence or keep discussing it in chat." : "Ask for changes or a preview in chat."} <button class="link" onClick={() => draftTo(`main:${run.id}`, "")}>Continue chatting</button></p>
    {choices.length > 1 ? <label>Result branch<select class="field" disabled={busy} value={tree.name} onChange={e => setSelected(e.currentTarget.value)}>{choices.map(choice => <option key={choice.name} value={choice.name}>{choice.name}</option>)}</select></label> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {server ? <details class="preview-log"><summary>Preview logs</summary><p class="help">{server.status === "running" ? "Running" : `Stopped${server.exitCode == null ? "" : ` · exit ${server.exitCode}`}`} · {server.command}</p><pre class="team-prose" aria-label="Preview app output">{server.logs.join("\n") || "No output yet."}</pre></details> : null}
    <details class="result-more" open={previewSettings}><summary>More options</summary>
      {run.testRun || run.source?.kind === "pr" || run.prs[tree.branch] ? <button class="btn small" onClick={() => navigate({ view: "review", id: run.id, branch: tree.branch })}>{run.testRun ? "Review test changes" : "Review local changes"}</button> : null}
      {!run.testRun ? <button class="link result-test-label" disabled={busy} onClick={async () => { setBusy(true); try { await post(`/api/runs/${run.id}/test-run`, { testRun: { reason: "This run was marked as a test. Keep its results as evidence and archive it when finished." } }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Mark as test run</button> : <button class="link result-test-label" disabled={busy} onClick={async () => { setBusy(true); try { await post(`/api/runs/${run.id}/test-run`, { testRun: null }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Remove test label</button>}
      <details open={previewSettings}><summary>Preview settings</summary><p class="help">Preview detects the app's launch command. When setup is needed, the agent prepares it in chat. The command must listen on the allocated $PORT; a preview that never becomes ready is stopped.</p><label>App command<input class="field" placeholder="Detected automatically" value={command} onInput={e => setCommand(e.currentTarget.value)} /></label><button class="btn small" disabled={busy} onClick={tryResult}>Start preview</button>{previewSetupFailed(run, tree) ? <button class="btn small" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await requestPreviewSetup(run, tree); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }}>Ask the agent again</button> : null}</details>
      <details><summary>Record your assessment</summary><p class="help">Optional feedback on this commit. {workingChanges ? "Ask the agent to commit the working changes first. " : ""}Accepting does not publish or merge. Needs more work opens the review to write feedback for the agent.</p><div class="experience-actions"><button class="btn small" disabled={busy || !head || workingChanges} onClick={() => void rate("accepted")}>Accept result</button><button class="btn small" disabled={busy || !head || workingChanges} onClick={() => void rate("needs-work")}>Needs more work</button></div>
      {run.outcome ? <p class="help">{run.outcome.decision === "accepted" ? "Accepted" : "Needs more work"} at {run.outcome.head.slice(0, 12)}{head && (run.outcome.head !== head || run.outcome.branch !== tree.branch) ? " · previous result; assess this commit separately" : ""}.</p> : null}</details>
      {journey ? <ScenarioEvidence key={`${run.id}/${tree.branch}`} journey={journey} runId={run.id} branch={tree.branch} appUrl={server?.status === "running" ? server.url : undefined} /> : null}
      <VisualComparison key={`${run.id}/${tree.branch}`} appUrl={server?.status === "running" ? server.url : undefined} />
      {!run.projectTeam ? <Alternatives run={run} branch={tree.branch} head={head} /> : null}
    </details>
  </section>;
}
const ALTERNATIVE = "\n\nExplore this alternative from the supplied result:\n";
function Alternatives({ run, branch, head }: { run: RunSummary; branch: string; head: string }) {
  const [a, setA] = useState("Keep the layout compact and focused."), [b, setB] = useState("Make the layout spacious with clear visual hierarchy.");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [launched, setLaunched] = useState(false), [another, setAnother] = useState(false);
  // Opening the form for another pair starts you in its first instruction; Cancel takes you back.
  const first = useRef<HTMLTextAreaElement>(null), again = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (another) first.current?.focus(); }, [another]);
  const siblings = [...runs.value.values()].filter(item => run.group ? item.group?.id === run.group.id : item.parentRunId === run.id && item.group).sort((a, b) => b.createdAt - a.createdAt);
  const group = run.group?.id ?? siblings[0]?.group?.id;
  const pair = siblings.filter(item => item.group?.id === group).slice(0, 2).sort((a, b) => (a.group?.label ?? "").localeCompare(b.group?.label ?? ""));
  // A comparison started from this run stays acknowledged after a reload: another pair is a deliberate choice.
  const requested = launched || pair.length > 0;
  const instruction = (label: string) => { const task = pair.find(item => item.group?.label === label)?.task; return task?.startsWith(run.task + ALTERNATIVE) ? task.slice(run.task.length + ALTERNATIVE.length) : undefined; };
  const tryAnother = () => { setA(instruction("Alternative A") ?? a); setB(instruction("Alternative B") ?? b); setLaunched(false); setError(""); setAnother(true); };
  const launch = async () => { if (!head || busy) return; setBusy(true); setError(""); setLaunched(true); try { await post("/api/compare", { run: { repo: run.repo, project: run.project, parentRunId: run.id, baseRef: head, pattern: run.pattern, task: run.task, intent: run.intent, journeyId: run.journeyId, roles: run.roles, options: run.options, loop: run.loop, trust: run.trust, approvals: run.approvals, agentSettings: run.agentSettings, roleSettings: run.roleSettings }, variants: [{ label: "Alternative A", task: `${run.task}${ALTERNATIVE}${a}` }, { label: "Alternative B", task: `${run.task}${ALTERNATIVE}${b}` }] }); } catch (error) { setError(`${(error as Error).message}. Inspect recent runs before starting another comparison; a partial launch may have succeeded.`); } finally { setBusy(false); setAnother(false); } };
  const form = !run.group && (busy || !requested || another);
  return <details class="alternatives"><summary>Try two alternatives</summary><p class="help">Two independent runs start from <code>{head.slice(0, 12) || branch}</code>, each with this run's workflow and budget ({run.loop.maxInvocations ?? run.loop.maxSteps} calls / {run.loop.maxMinutes} minutes). Choose the result you want to continue.</p>{form ? <><div class="experience-columns"><label>Alternative A<textarea ref={first} class="field" value={a} maxLength={4000} onInput={e => setA(e.currentTarget.value)} /></label><label>Alternative B<textarea class="field" value={b} maxLength={4000} onInput={e => setB(e.currentTarget.value)} /></label></div><button class="btn" disabled={!head || busy || launched || !a.trim() || !b.trim()} onClick={launch}>{busy ? "Starting alternatives…" : launched ? "Comparison requested" : "Build both alternatives"}</button>{another ? <button class="btn ghost" onClick={() => { setAnother(false); requestAnimationFrame(() => again.current?.focus()); }}>Cancel</button> : null}</> : !run.group ? <><p class="help" role="status">Comparison requested{pair[0] ? ` ${new Date(pair[0].createdAt).toLocaleString()}` : ""}. Each alternative keeps its own run and preview.</p><button ref={again} class="btn small" onClick={tryAnother}>Try another pair…</button></> : null}{error ? <p role="alert">{error}</p> : null}<div class="experience-columns">{pair.map(item => <AlternativePreview key={item.id} run={item} />)}</div></details>;
}
function AlternativePreview({ run }: { run: RunSummary }) {
  const [preview, setPreview] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [command, setCommand] = useState(run.app?.command ?? "");
  const tree = run.worktrees.find(tree => tree.branch === run.artifacts[0]?.branch);
  // After a reload, find the preview that is still running (its command with it), or the detected
  // command. Best effort: starting the preview by hand reports what is wrong.
  useEffect(() => {
    let alive = true;
    if (tree && run.status !== "running") (async () => {
      const server = await api<DevServer | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`);
      if (server?.status === "running") {
        if (alive) setCommand(server.command);
        const value = await post<{ origin: string }>("/api/preview", { url: server.url });
        if (alive) setPreview(value.origin);
      } else {
        const config = await api<{ command: string } | null>(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve/config`);
        if (alive && config?.command) setCommand(current => current || config.command);
      }
    })().catch(() => {});
    return () => { alive = false; };
  }, [run.id, tree?.name, run.status]);
  const start = async () => { if (!tree) return; setBusy(true); setError(""); try { const server = await startResultPreview(run, tree, command); if (!server) return; const value = await post<{ origin: string }>("/api/preview", { url: server.url }); setPreview(value.origin); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } };
  return <article class="alternative-preview"><h4>{run.group?.label}</h4><p>{run.status} · Checks: {checksLabel(run)}</p>{run.status !== "running" && tree ? <><label>Preview command<input class="field" value={command} onInput={e => setCommand(e.currentTarget.value)} /></label><button class="btn small" disabled={busy || !command.trim()} onClick={start}>{busy ? "Starting…" : "Preview alternative"}</button></> : null}{preview ? <iframe src={preview} title={`${run.group?.label} working preview`} sandbox="allow-scripts allow-same-origin allow-forms" /> : null}<a class="btn small" href={`#/run/${run.id}`}>{run.status === "running" ? "Follow progress" : "Choose and continue"}</a>{error ? <p role="alert">{error}</p> : null}</article>;
}

function VisualComparison({ appUrl }: { appUrl?: string }) {
  const [beforeUrl, setBeforeUrl] = useState(""), [before, setBefore] = useState(""), [after, setAfter] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const capture = async () => { if (!appUrl || busy) return; setBusy(true); setError(""); try { const result = await post<{ image: string }>("/api/snapshot", { url: appUrl, width: 1280, height: 900 }); setAfter(`data:image/png;base64,${result.image}`); if (beforeUrl.trim()) { const baseline = await post<{ image: string }>("/api/snapshot", { url: beforeUrl.trim(), width: 1280, height: 900 }); setBefore(`data:image/png;base64,${baseline.image}`); } else setBefore(""); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } };
  return <details class="visual-comparison"><summary>Show me what changed</summary><p class="help">Capture the running result, optionally beside an original app URL. Both use a fresh browser at the same viewport. These snapshots are a visual comparison, not an automated test; download them to keep a copy.</p><label>Original app URL (optional)<input class="field" type="url" disabled={busy} value={beforeUrl} onInput={e => { setBeforeUrl(e.currentTarget.value); setBefore(""); }} placeholder="http://localhost:3000" /></label><button class="btn small" disabled={busy || !appUrl} onClick={capture}>{busy ? "Capturing views…" : "Capture comparison"}</button>{!appUrl ? <p class="help">Start the result preview first.</p> : null}{error ? <p role="alert">{error}</p> : null}<div class="experience-columns">{before ? <div class="walkthrough"><h4>Original</h4><img src={before} alt="Original app at 1280 by 900 pixels" /><a download="original.png" href={before}>Download original</a></div> : null}{after ? <div class="walkthrough"><h4>Result</h4><img src={after} alt="Result app at 1280 by 900 pixels" /><a download="result.png" href={after}>Download result</a></div> : null}</div></details>;
}
