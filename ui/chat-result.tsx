import { useEffect, useRef, useState } from "preact/hooks";
import type { TaskSnapshot } from "../src/conversational/service.js";
import type { DiffFile } from "./types.js";
import { api, post, enc } from "./lib.js";
import { Icon } from "./icons.js";
import { Sequence, TaskResult } from "./task-conversation.js";

type Tab = "result" | "approach" | "reviews" | "checks" | "changes" | "preview";
/** Read-only output viewer. Its independent scroll never moves the conversation. */
export function ChatResultPane({ task: current, runId, onClose }: { task: TaskSnapshot; runId?: string; onClose: () => void }) {
  const [historical, setHistorical] = useState<TaskSnapshot>(), [loadError, setLoadError] = useState("");
  const task = historical ?? current;
  useEffect(() => { if (!runId || current.execution?.id === runId) return; const controller = new AbortController(); void api<TaskSnapshot>(`/api/task-conversations/${enc(current.task.id)}/execution?runId=${enc(runId)}`, { signal: controller.signal }).then(setHistorical).catch(e => { if (!controller.signal.aborted) setLoadError(e.message); }); return () => controller.abort(); }, [current.task.id, runId]);
  const [tab, setTab] = useState<Tab>(task.execution?.artifacts.length ? "result" : "approach");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { const trigger = document.activeElement as HTMLElement | null; heading.current?.focus(); return () => { if (trigger?.isConnected) trigger.focus(); }; }, []);
  const run = task.execution, proposal = task.proposal;
  const kinds = tab === "reviews" ? ["review"] : tab === "checks" ? ["verification"] : ["result", "plan"];
  const artifacts = run?.artifacts.filter(a => kinds.includes(a.kind)) ?? [];
  return <aside class="chat-result-pane" aria-label="Task output"><header><div><p class="task-kicker">{task.view.label}</p><h2 ref={heading} tabIndex={-1}>{task.task.request.split("\n")[0]!.slice(0, 90)}</h2></div><button class="icon-btn" aria-label="Close task output" onClick={onClose}><Icon name="close"/></button></header>
    <div class="chat-output-tabs" role="group" aria-label="Output sections">{([ ["result", "Result"], ["approach", "Approach"], ["reviews", "Reviews"], ["checks", "Checks"], ["changes", "Changes"], ["preview", "Preview"] ] as const).map(([id, label]) => <button class="btn ghost small" type="button" aria-pressed={tab === id} onClick={() => setTab(id)} key={id}>{label}</button>)}</div>
    {loadError ? <p role="alert">{loadError}</p> : null}
    <div class="chat-output-body" hidden={!!runId && current.execution?.id !== runId && !historical} key={`${task.task.id}:${tab}`}>
      {tab === "approach" && proposal ? <><h3>Proposed work</h3><Sequence steps={proposal.definition.steps}/><h3>Done when</h3><ul>{proposal.definition.completion.map(c => <li key={c}>{c}</li>)}</ul><h3>{proposal.runId ? "Accepted source" : "Proposed source"}</h3><p><code>{proposal.source.commit}</code> · {proposal.source.source === "working_changes" ? "working copy" : "committed code"}</p><p class="help">Revision {proposal.revision} · {proposal.runId ? "Accepted for this execution" : "Awaiting your authorization"}</p><h3>Team</h3>{task.view.participants.map(p => <div class="chat-output-participant" key={p.id}><b>{p.id}</b><p>{p.provider} · {p.model || "Provider default"} · {p.effort || "Default effort"}</p><small>{p.participation}</small>{p.assignments.map(a => <p class="help" key={a.id}>{a.id} · {a.status}{a.sessionId ? <><br/>Native session: <code>{a.sessionId}</code></> : null}</p>)}</div>)}</> : null}
      {tab === "preview" ? run ? <OutputPreview runId={run.id}/> : <p class="help">A working preview can appear after implementation starts.</p> : tab === "changes" ? run ? <OutputChanges execution={run}/> : <p class="help">Changes appear after implementation starts.</p> : tab !== "approach" ? artifacts.length && run ? <><p class="help">{task.view.notice}</p><TaskResult key={tab} taskId={task.task.id} execution={{ ...run, artifacts }} preferredId={artifacts.at(-1)!.id}/></> : <p class="help">{tab === "checks" ? "No check evidence has been recorded." : tab === "reviews" ? "No reviewer verdict has been recorded." : "Results appear here as the team delivers work."}</p> : null}
      {run ? <a class="btn ghost small" href={`#/run/${enc(run.id)}`}>Inspect execution and preserved workspace</a> : null}
    </div></aside>;
}
function OutputChanges({ execution }: { execution: NonNullable<TaskSnapshot["execution"]> }) {
  const [files, setFiles] = useState<DiffFile[]>(), [error, setError] = useState("");
  const branch = execution.worktrees[0]?.branch;
  useEffect(() => { if (!branch) return; const controller = new AbortController(); setFiles(undefined); setError(""); void api<DiffFile[]>(`/api/runs/${enc(execution.id)}/diff?branch=${enc(branch)}`, { signal: controller.signal }).then(setFiles).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [execution.id, branch, execution.artifacts.length, execution.status]);
  return <>{error ? <p role="alert">{error}</p> : !branch ? <p class="help">No implementation workspace was created.</p> : !files ? <p role="status">Loading changes…</p> : !files.length ? <p class="help">No code changes recorded.</p> : <><p class="help">Current preserved workspace · {files.length} files. Verification applies to the recorded snapshot; later edits need new checks.</p>{files.map(f => <details class="chat-output-diff" key={f.path}><summary>{f.path}<span>+{f.additions} −{f.deletions}</span></summary>{f.truncated ? <p class="help">Preview truncated. Inspect the workspace for the complete file.</p> : null}{f.binary ? <p class="help">Binary file</p> : <pre>{f.patch.split("\n").map((line, i) => <span key={i} class={line.startsWith("@@") ? "dh" : line.startsWith("+") ? "da" : line.startsWith("-") ? "dd" : undefined}>{line}{"\n"}</span>)}</pre>}</details>)}</>}</>;
}

function OutputPreview({ runId }: { runId: string }) {
  const [servers, setServers] = useState<{ key: string; url: string; status: string }[]>(), [origin, setOrigin] = useState(""), [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void api<{ key: string; url: string; status: string }[]>("/api/serve", { signal: controller.signal }).then(all => setServers(all.filter(s => s.key.startsWith(`${runId}/`) && s.status === "running"))).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [runId]);
  return <>{error ? <p role="alert">{error}</p> : !servers ? <p role="status">Checking for a running preview…</p> : servers.length ? <><p class="help">Live application preview. This may change after the verified snapshot.</p>{servers.map(s => <button type="button" class="btn small" key={s.key} onClick={() => { void post<{ origin: string }>("/api/preview", { url: s.url }).then(value => setOrigin(value.origin)).catch(e => setError(e.message)); }}>Open running preview</button>)}{origin ? <iframe class="chat-output-preview" src={origin} title="Application preview" sandbox="allow-scripts allow-same-origin allow-forms"/> : null}</> : <p class="help">No running preview for this task. Ask the team to set up a preview, or open the execution to run the app.</p>}</>;
}
