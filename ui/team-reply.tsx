import { useEffect, useState } from "preact/hooks";
import { Markdown } from "./bits.js";
import { api } from "./lib.js";
import { inlineTeamResponses, latestWorkerSteps, type TeamResponse } from "./team-responses.js";
import type { AgentEvent, Run, RunSummary } from "./types.js";
import type { TranscriptPage } from "../src/transcript.js";

/** Historical leads sometimes saved only a status summary. Put their public deliverable
 * in the same reply automatically, without changing the recorded answer or review. */
export function TeamReply({ turn, answer }: { turn: NonNullable<RunSummary["teamTurns"]>[number]; answer: string }) {
  const [responses, setResponses] = useState<(TeamResponse & { repo: string })[]>(), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const stop = new AbortController();
    setResponses(undefined); setError("");
    void (async () => {
      try {
        const run = await api<Run>(`/api/runs/${encodeURIComponent(turn.executionId)}`, { signal: stop.signal });
        const transcripts = new Map<string, AgentEvent[]>();
        await Promise.all(latestWorkerSteps(run.steps).map(async step => {
          const page = await api<TranscriptPage>(`/api/runs/${encodeURIComponent(turn.executionId)}/transcript?step=${encodeURIComponent(step.id)}`, { signal: stop.signal });
          transcripts.set(step.id, page.events.flatMap(event => event.type === "agent" ? [event.event] : []));
        }));
        if (!stop.signal.aborted) {
          setResponses(inlineTeamResponses(run.steps, transcripts, answer).map(response => {
            const step = run.steps.find(step => step.id === response.stepId);
            return { ...response, repo: run.worktrees.find(tree => tree.name === step?.worktree)?.path ?? run.repo };
          }));
        }
      } catch {
        if (!stop.signal.aborted) setError("The saved response couldn’t be loaded.");
      }
    })();
    return () => stop.abort();
  }, [turn.executionId, turn.report, answer, retry]);
  if (responses && !responses.length) return null;
  return <div class="team-reply">
    {responses ? <><p class="help">Saved response · review and check results above still apply.</p>{responses.map(response => <div key={response.id}>{response.title ? <h3>{response.title}</h3> : null}<Markdown text={response.body} repo={response.repo} /></div>)}</> : error ? <p role="alert">{error} <button class="btn small" onClick={() => setRetry(retry + 1)}>Retry loading response</button></p> : <p class="help" role="status">Loading saved response…</p>}
  </div>;
}
