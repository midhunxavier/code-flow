import type { RunEvent } from "./engine.js";

/**
 * What a window needs to show a run, from its event history: every agent event and log line, but
 * only the latest snapshot of the run and of each step. A run's log has a snapshot for every change
 * (each with the task, the issue's text, CI logs, the repository's conventions…), and a window
 * that connects only ever shows the last one, so sending the rest cost most of the bytes.
 * The events keep their order, so a window applies them as it would live ones.
 */
export function replayEvents(events: RunEvent[]): RunEvent[] {
  let lastRun = -1;
  const lastStep = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.type === "run") lastRun = i;
    else if (e.type === "step") lastStep.set(e.step.id, i);
  });
  return events.filter((e, i) => (e.type === "run" ? i === lastRun : e.type === "step" ? lastStep.get(e.step.id) === i : true));
}
