import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc, post } from "./lib.js";
import { agents, agentSettings, repo } from "./state.js";
import { teamLink } from "./collab-state.js";
import { taskDraftProblem, type TaskDraft } from "../src/task-draft.js";

/** A draft stays local until the user applies it and saves the surrounding task form. */
export function TaskDraftAssistant({ projectId, repository, baseRef, onBusy, onApply }: {
  projectId: string; repository: string; baseRef: string;
  onBusy: (busy: boolean) => void; onApply: (draft: TaskDraft) => void;
}) {
  const installed = agents.value.filter((agent) => agent.available);
  const [agent, setAgent] = useState(installed[0]?.id ?? "");
  const [idea, setIdea] = useState("");
  const [path, setPath] = useState(teamLink.value?.mappings[projectId]?.[repository] ?? "");
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState<TaskDraft>();
  const mounted = useRef(true), busyCallback = useRef(onBusy); busyCallback.current = onBusy;
  useEffect(() => { if (!agent && installed[0]) setAgent(installed[0].id); }, [agent, agents.value]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!busy || !runId) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const run = await api<{ status: string; summary?: string; error?: string; stopReason?: string }>(`/api/runs/${enc(runId)}`);
        if (!active) return;
        if (run.status === "running") { setError(""); timer = setTimeout(poll, 1500); return; }
        if (run.status !== "done") throw new Error(run.error || run.stopReason || `Draft ${run.status}. Open the drafting run for details, or try again.`);
        let value: unknown;
        try { value = JSON.parse(run.summary ?? ""); } catch { throw new Error("The agent did not return a usable draft. Try again or create the task manually."); }
        const problem = taskDraftProblem(value); if (problem) throw new Error(problem);
        setDraft(value as TaskDraft); setError(""); setBusy(false); busyCallback.current(false);
      } catch (problem) {
        if (!active) return;
        setError((problem as Error).message);
        // A failed poll must not imply the agent stopped. Keep the stop control and retry reads.
        const status = (problem as { status?: number }).status;
        if (status === 0 || (status !== undefined && status >= 500)) { timer = setTimeout(poll, 3000); return; }
        setBusy(false); busyCallback.current(false);
      }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [runId, busy]);
  const generate = async () => {
    if (busy || !idea.trim()) return;
    setBusy(true); onBusy(true); setError(""); setDraft(undefined); setRunId("");
    try {
      const result = await post<{ runId: string }>("/api/team-link/draft", { projectId, repository, idea, agent, repo: path.trim(), baseRef, agentSettings: agentSettings.value });
      if (mounted.current) setRunId(result.runId);
    } catch (problem) { if (mounted.current) { setError((problem as Error).message); setBusy(false); onBusy(false); } }
  };
  const stop = async () => {
    setStopping(true);
    try { await post(`/api/runs/${enc(runId)}/cancel`, {}); }
    catch (problem) { setError((problem as Error).message); }
    finally { setStopping(false); }
  };
  return <section class="team-section team-draft-assistant" aria-label="Draft with agent">
    <h3>Draft with agent</h3>
    <p class="help">Describe your idea. An agent reads the selected repository and proposes a goal, scope, plan and acceptance criteria. Review the draft before creating a shared task. Limit: 5 minutes and 2 agent calls.</p>
    <label>Idea<textarea class="field" rows={3} maxLength={16384} value={idea} disabled={busy} onInput={(event) => setIdea(event.currentTarget.value)} /></label>
    <label>Drafting agent<select class="field" value={agent} disabled={busy} onChange={(event) => setAgent(event.currentTarget.value)}><option value="" disabled>Choose an installed agent</option>{installed.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</select></label>
    <label>Repository folder<input class="field mono" value={path} disabled={busy} placeholder="/absolute/path/to/your/clone" onInput={(event) => setPath(event.currentTarget.value)} /></label>
    <button type="button" class="btn small" disabled={busy || !repo.value} onClick={() => setPath(repo.value)}>Use current repository</button>
    {!installed.length ? <p class="help">Install and sign in to an agent on this computer to draft tasks. You can still create a task manually.</p> : null}
    <div class="team-actions">
      <button type="button" class="btn" disabled={busy || !idea.trim() || !path.trim() || !repository || !installed.some((entry) => entry.id === agent)} onClick={() => void generate()}>{busy ? "Drafting…" : draft ? "Generate again" : "Generate draft"}</button>
      {busy && runId ? <button type="button" class="btn" disabled={stopping} onClick={() => void stop()}>{stopping ? "Stopping…" : "Stop drafting"}</button> : null}
      {runId ? <a href={`#/run/${enc(runId)}`} target="_blank" rel="noopener">Open drafting run</a> : null}
    </div>
    {busy ? <p class="help" role="status">The agent is reading repository context and preparing your draft.</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {draft ? <div class="team-draft-preview"><h4>{draft.title}</h4><p class="team-comment-text">{draft.goal}</p><h4>Acceptance criteria</h4><p class="team-comment-text">{draft.acceptance}</p><button type="button" class="btn primary" onClick={() => onApply(draft)}>Use draft in form</button><p class="help">This replaces the title, goal and acceptance fields. You can edit them before saving.</p></div> : null}
  </section>;
}
