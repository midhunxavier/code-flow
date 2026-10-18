import { batch, signal, type Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { Built } from "./run.js";
import { reconcileStreamSnapshot, type StreamSnapshot } from "./run-stream.js";
import { subscribe } from "./stream.js";
import type { AgentEvent, RunEvent, RunSummary, Step } from "./types.js";

export interface RunData {
  steps: Map<string, Step>;
  events: Map<string, AgentEvent[]>;
  /** Transcript items per step, built incrementally as events arrive (see itemsFor). */
  built: Map<string, Built>;
  logs: { ts: number; level: string; text: string }[];
  seen: Set<number>;
  /** The event the shown run snapshot, and each step's, came with: an older one never replaces it. */
  runSeq: number;
  stepSeq: Map<string, number>;
  /** Whose numbering the events follow (the run's own); another one numbers its events afresh. */
  epoch: string;
}

export const emptyData = (): RunData => ({ steps: new Map(), events: new Map(), built: new Map(), logs: [], seen: new Set(), runSeq: 0, stepSeq: new Map(), epoch: "" });

/**
 * One run's events, shared by everything that shows the run (the run view, and the side panel's
 * chat on the same run): one subscription on the window's stream, one copy of its transcripts.
 * Kept a while after nothing shows it, so going back resumes where it left off instead of
 * starting over.
 */
interface RunFeed {
  id: string;
  /** Mutated in place as events arrive; replaced when the history starts over. */
  data: { current: RunData };
  run: Signal<RunSummary | null>;
  /** Why the run can't be shown (it doesn't exist, or the server said no). */
  problem: Signal<string>;
  /** Changes once per frame while events arrive, so views re-render. */
  version: Signal<number>;
  users: number;
  stop?: () => void;
  stepListeners: Set<(step: Step) => void>;
  /** The newest snapshot, shown at the next frame. */
  pending?: RunSummary;
  scheduled: boolean;
  /** The newest event received: where a resubscription picks up. */
  lastSeq: number;
  idleSince: number;
}

const feeds = new Map<string, RunFeed>();
/** Runs kept once nothing shows them, the most recently shown first. */
const KEEP_IDLE = 6;

function feedFor(id: string): RunFeed {
  let feed = feeds.get(id);
  if (!feed) {
    feed = { id, data: { current: emptyData() }, run: signal(null), problem: signal(""), version: signal(0), users: 0, stepListeners: new Set(), scheduled: false, lastSeq: 0, idleSince: Date.now() };
    feeds.set(id, feed);
  }
  return feed;
}

function use(feed: RunFeed) {
  if (feed.users++) return;
  feed.stop = subscribe(
    `run:${feed.id}`,
    (ev) => receive(feed, ev),
    () => (feed.data.current.epoch && feed.lastSeq ? `${feed.data.current.epoch}:${feed.lastSeq}` : undefined),
  );
}

function release(feed: RunFeed) {
  if (--feed.users) return;
  feed.stop?.();
  feed.stop = undefined;
  feed.idleSince = Date.now();
  const idle = [...feeds.values()].filter((f) => !f.users).sort((a, b) => b.idleSince - a.idleSince);
  for (const f of idle.slice(KEEP_IDLE)) feeds.delete(f.id);
}

type Message = RunEvent | { type: "hello"; epoch: string; resumed?: boolean; snapshot?: StreamSnapshot } | { type: "error"; status: number; message: string };

function receive(feed: RunFeed, ev: Message) {
  if (ev.type === "error") {
    feed.problem.value = ev.status === 404 ? ev.message : `Couldn't load this run: ${ev.message}`;
    return;
  }
  if (ev.type === "hello") {
    // Not resumed means the history follows from the start: start over rather than mix two of them.
    if (ev.epoch !== feed.data.current.epoch || !ev.resumed) {
      feed.data.current = { ...emptyData(), epoch: ev.epoch };
      feed.lastSeq = 0;
    }
    feed.problem.value = "";
    // The run as it is now: it outranks older snapshots in the history that follows. Where this
    // left off stays where the events got to, so a drop mid-history picks up from there.
    if (ev.snapshot) {
      feed.data.current = reconcileStreamSnapshot(feed.data.current, ev.snapshot);
      feed.pending = ev.snapshot.run;
      for (const step of ev.snapshot.steps) for (const listener of feed.stepListeners) listener(step);
      schedule(feed);
    }
    return;
  }
  const d = feed.data.current;
  if (d.seen.has(ev.seq)) return;
  d.seen.add(ev.seq);
  feed.lastSeq = Math.max(feed.lastSeq, ev.seq);
  if (ev.type === "run") {
    if (ev.seq < d.runSeq) return;
    d.runSeq = ev.seq;
    // The run list is the global feed's (watchAllRuns): this stream numbers its events differently.
    feed.pending = ev.run;
  } else if (ev.type === "step") {
    if (ev.seq < (d.stepSeq.get(ev.step.id) ?? 0)) return;
    d.stepSeq.set(ev.step.id, ev.seq);
    d.steps.set(ev.step.id, ev.step);
    for (const listener of feed.stepListeners) listener(ev.step);
  } else if (ev.type === "agent") {
    if (!d.events.has(ev.stepId)) d.events.set(ev.stepId, []);
    d.events.get(ev.stepId)!.push(ev.event);
  } else if (ev.type === "log") {
    d.logs.push(ev);
  }
  schedule(feed);
}

/**
 * Bursts of events (a history replaying) render once per frame, the run's snapshot with them.
 * Browsers pause animation frames in background tabs and hidden panes, so a timer renders there
 * too (throttled, but it renders).
 */
function schedule(feed: RunFeed) {
  if (feed.scheduled) return;
  feed.scheduled = true;
  const flush = () => {
    if (!feed.scheduled) return;
    feed.scheduled = false;
    batch(() => {
      if (feed.pending) feed.run.value = feed.pending;
      feed.pending = undefined;
      feed.version.value++;
    });
  };
  requestAnimationFrame(flush);
  setTimeout(flush, 250);
}

/**
 * A run's snapshot, every step and agent event, kept in `data` (mutated in place; `version`
 * changes as events arrive so components re-render). The run view and the side panel's chat both
 * read a run this way, and share it. `onStep` sees each step update as it lands. While `active` is
 * false (a pane that's hidden or closed) the run isn't watched; it catches up when it's shown again.
 */
export function useRunStream(id: string, onStep?: (step: Step) => void, active = true) {
  // Looked up on every render: a run dropped from the cache while nothing showed it is a new one.
  const feed = feedFor(id);
  const stepHandler = useRef(onStep);
  stepHandler.current = onStep;
  useEffect(() => {
    const listener = (step: Step) => stepHandler.current?.(step);
    feed.stepListeners.add(listener);
    return () => void feed.stepListeners.delete(listener);
  }, [feed]);
  useEffect(() => {
    if (!active) return;
    use(feed);
    return () => release(feed);
  }, [feed, active]);
  return { run: feed.run.value, problem: feed.problem.value, data: feed.data, version: feed.version.value };
}
