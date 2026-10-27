import { subscribe } from "./stream.js";
import { pollVisible } from "./polling.js";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, post, showToast } from "./lib.js";
import { route, runs } from "./state.js";
import type { ApprovalRecord } from "../src/approvals.js";

/** Every pending request the server reports: the inbox shows them, and a run waiting on one says so. */
export const pendingApprovals = signal<ApprovalRecord[]>([]);
/** How long a card that takes another's place ignores clicks, so a click aimed at the old one can't land on it. */
export const ARM_MS = 900;
/**
 * Why a card took the place of the one you were reading, when that wasn't your doing. Its buttons stay
 * off until you say you've read the new request: a wait alone would let a later click land unread.
 */
const REPLACED_NOTICE = "The request you were viewing was answered elsewhere, expired or was cancelled. This is a different one.";

/**
 * The order requests are offered in: those of the run you're looking at, then the soonest deadline
 * first, so a newer request never hides one that is about to expire.
 */
export function inboxOrder(records: ApprovalRecord[], viewingRun?: string): ApprovalRecord[] {
  return [...records].sort((a, b) => Number(b.runId === viewingRun) - Number(a.runId === viewingRun) || a.expiresAt - b.expiresAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** The answer to a question with this option picked (or, for a multiple choice, toggled). */
export function pickOption(answer: string, option: string, multiple: boolean): string {
  if (!multiple) return option;
  const picked = answer.split(",").map(value => value.trim()).filter(Boolean);
  return (picked.includes(option) ? picked.filter(value => value !== option) : [...picked, option]).join(", ");
}
export function optionPicked(answer: string, option: string, multiple: boolean): boolean {
  return multiple ? answer.split(",").map(value => value.trim()).includes(option) : answer.trim() === option;
}

/**
 * Permission requests are explicit, one-action decisions; an ignored request expires denied. The
 * card stays on the request you are reading until you move on or it ends: a new request never
 * takes its place, and a decision always applies to the request that was on screen.
 */
export function ApprovalInbox() {
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  /** The request on screen, whether you chose it (Previous/Next), and why it replaced the one before. */
  const shown = useRef<{ id?: string; chosen: boolean; notice: string }>({ chosen: false, notice: "" });
  /** The last request this window answered (set before the answer is sent: the server's update can arrive first). */
  const decided = useRef<string>();
  const [, rerender] = useState(0);
  useEffect(() => {
    let current = true;
    let stopFallback: (() => void) | undefined;
    const stop = subscribe("approvals", (data: { type: string; records?: ApprovalRecord[]; status?: number }) => {
      if (!current) return;
      if (data.type === "snapshot" && data.records) pendingApprovals.value = data.records;
      // Older connected hosts do not have the topic. Current hosts need no approval timer.
      if (data.type === "error" && data.status === 404 && !stopFallback) {
        stopFallback = pollVisible(async () => {
          const records = await api<ApprovalRecord[]>("/api/approvals");
          if (current) pendingApprovals.value = records.filter(record => record.status === "pending");
        }, 2000);
      }
    });
    return () => { current = false; stop(); stopFallback?.(); pendingApprovals.value = []; };
  }, []);
  const viewing = route.value.view === "run" ? route.value.id : undefined;
  // Opening a run brings its own request forward, unless the card already shows one of that run's.
  useEffect(() => {
    const first = inboxOrder(pendingApprovals.value, viewing)[0];
    const current = pendingApprovals.value.find(record => record.id === shown.current.id);
    if (viewing && first?.runId === viewing && current && current.runId !== viewing) {
      shown.current = { id: first.id, chosen: false, notice: "" };
      rerender(n => n + 1);
    }
  }, [viewing]);
  const pending = inboxOrder(pendingApprovals.value, viewing);
  let request = pending.find(record => record.id === shown.current.id);
  if (!request && pending[0]) {
    // The shown request ended (or none was shown): the next one takes its place, disarmed for a moment,
    // or, when it replaces one you were reading that you didn't answer here, until you say you've read it.
    const vanished = !!shown.current.id && shown.current.id !== decided.current;
    request = pending[0];
    shown.current = { id: request.id, chosen: false, notice: vanished ? REPLACED_NOTICE : "" };
  }
  // Nothing waits: whatever arrives later is new, not a replacement.
  if (!request) { shown.current = { chosen: false, notice: "" }; return null; }
  const index = pending.indexOf(request);
  const move = (step: number) => {
    const next = pending[(index + step + pending.length) % pending.length]!;
    shown.current = { id: next.id, chosen: true, notice: "" };
    rerender(n => n + 1);
  };
  // You read the request that took the other's place, and say so: now its buttons work.
  const review = () => {
    shown.current = { ...shown.current, chosen: true, notice: "" };
    rerender(n => n + 1);
  };
  return <ApprovalCard key={request.id} request={request} position={index + 1} count={pending.length} chosen={shown.current.chosen} notice={shown.current.notice} onMove={move} onReview={review}
    answers={answers[request.id] ?? {}} onAnswer={(question, value) => setAnswers(values => ({ ...values, [request!.id]: { ...values[request!.id], [question]: value } }))}
    onDeciding={(id) => { decided.current = id; }} onFailed={(id, message) => {
      if (decided.current === id) decided.current = undefined;
      if (shown.current.id !== id) {
        showToast(`Your approval decision was not applied: ${message}`, 6000);
        shown.current = { ...shown.current, chosen: false, notice: REPLACED_NOTICE };
        rerender(n => n + 1);
      }
    }} onDecided={(id) => { pendingApprovals.value = pendingApprovals.value.filter(record => record.id !== id); }} />;
}

interface CardProps {
  request: ApprovalRecord;
  position: number;
  count: number;
  /** Shown at your own request: its buttons work at once. */
  chosen: boolean;
  /** Set when this card replaced one you were reading: its buttons wait for onReview, however long. */
  notice: string;
  onMove: (step: number) => void;
  onReview: () => void;
  answers: Record<string, string>;
  onAnswer: (question: string, value: string) => void;
  onDeciding: (id: string) => void;
  onFailed: (id: string, message: string) => void;
  onDecided: (id: string) => void;
}

/** One request. Keyed by its id, so its buttons, error and arming never carry over to another request. */
function ApprovalCard({ request, position, count, chosen, notice, onMove, onReview, answers, onAnswer, onDeciding, onFailed, onDecided }: CardProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Shown long enough that a click can't have been aimed at what was here before. */
  const [settled, setSettled] = useState(chosen);
  /** Folded down to its header, so the page under it can be used; the request still waits. */
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (settled || hidden) return;
    const timer = setTimeout(() => setSettled(true), ARM_MS);
    return () => clearTimeout(timer);
  }, [settled, hidden]);
  // A card that replaced one you were reading waits for you to say you've read it.
  const armed = settled && !notice;
  // Unfolding puts the buttons back where the header was: they wait a moment again.
  const fold = () => { setHidden(value => !value); setSettled(false); };
  const decide = async (decision: "approve" | "decline") => {
    if (!armed || busy) return;
    setBusy(true); setError(""); onDeciding(request.id);
    try { await post(`/api/approvals/${request.id}`, { decision, answers }); onDecided(request.id); }
    catch (error) { const message = (error as Error).message; setError(message); onFailed(request.id, message); }
    finally { setBusy(false); }
  };
  const run = runs.value.get(request.runId);
  const title = run?.task.split("\n")[0]!.slice(0, 160) || `Run ${request.runId}`;
  const question = request.kind === "question";
  // A raised card over the corner of the page: a warn strip names the request, the command or files
  // follow as code, and the decision is one ink button.
  // Hidden, it is a small pill in the corner, clear of the page's own composer and its Send.
  return <aside class={`approval-inbox${hidden ? " folded" : ""}`} role="alert" aria-label={question ? "Agent question" : "Tool approval required"}>
    <div class="ai-head">
      <Icon name="alert" />
      {hidden ? <span class="ai-folded">{count} waiting</span> : <>
        <h3>{question ? "Your agent has a question" : "Permission required"}</h3>
        {count > 1 ? <span class="ai-nav">
          <button type="button" class="icon-btn" aria-label="Previous request" onClick={() => onMove(-1)}><Icon name="chevron" class="ai-prev" /></button>
          <span class="ai-count" aria-live="polite">{position} of {count} pending</span>
          <button type="button" class="icon-btn" aria-label="Next request" onClick={() => onMove(1)}><Icon name="chevron" class="ai-next" /></button>
        </span> : null}
      </>}
      <button type="button" class="icon-btn ai-fold" aria-label={hidden ? "Show request" : "Hide request"} aria-expanded={!hidden} aria-controls={`ai-body-${request.id} ai-actions-${request.id}`} title={hidden ? "Show request" : "Hide request so you can use the page under it"} onClick={fold}><Icon name="chevron" class={hidden ? "ai-unfold" : undefined} /></button>
    </div>
    <div class="ai-body" id={`ai-body-${request.id}`} hidden={hidden}>
      {notice ? <div class="msg warn ai-notice" role="status"><p>{notice}</p><button type="button" class="btn small" onClick={onReview}>Decide on this one</button></div> : null}
      {/* One line each, the full text on hover: the card mustn't grow over the page with a long task or folder. */}
      <p class="ai-run" title={run?.task}>From <b>{title}</b></p>
      <p class="ai-what">{request.kind === "command" ? "Run this command once, possibly outside the sandbox" : request.kind === "tool" ? `Use ${request.toolName} once` : question ? "Answer to continue this turn" : "Apply these file changes once"}</p>
      {request.input ? <pre class="ai-command">{request.input}</pre> : null}
      {request.questions?.map((q, at) => {
        const id = `ai-q-${request.id}-${at}`;
        const answer = answers[q.id] ?? "";
        return <fieldset key={`${request.id}:${q.id}`} class="ai-question">
          <legend>{q.header ? <span class="ai-q-header">{q.header}</span> : null}<span>{q.question}</span></legend>
          {q.options?.length ? <div class={`ai-options ${q.optionDescriptions?.some(Boolean) ? "described" : ""}`}>
            {q.options.map((option, n) => {
              const description = q.optionDescriptions?.[n];
              return <div key={option} class="ai-option">
                <button type="button" class="btn small" aria-pressed={optionPicked(answer, option, !!q.multiSelect)} aria-describedby={description ? `${id}-o${n}` : undefined} onClick={() => onAnswer(q.id, pickOption(answer, option, !!q.multiSelect))}>{option}</button>
                {description ? <span id={`${id}-o${n}`} class="help">{description}</span> : null}
              </div>;
            })}
          </div> : null}
          <textarea class="field" aria-label={q.question} placeholder={q.options?.length ? q.multiSelect ? "Pick any, or type your own answer" : "Or type your own answer" : "Type your answer"} value={answer} onInput={event => onAnswer(q.id, event.currentTarget.value)} />
        </fieldset>;
      })}
      {request.command ? <pre class="ai-command">{request.command}</pre> : null}
      {request.paths?.length ? <ul class="ai-paths">{request.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null}
      {request.cwd ? <p class="ai-folder">Folder <code title={request.cwd}><bdi>{request.cwd}</bdi></code></p> : null}
      {request.reason ? <p class="ai-reason">{request.reason}</p> : null}
      <p class="help">Expires at {new Date(request.expiresAt).toLocaleTimeString()}. Grants no session-wide permission.</p>
      {error ? <p class="msg err">{error}</p> : null}
    </div>
    <div class="ai-actions" id={`ai-actions-${request.id}`} hidden={hidden}><button class="btn primary" disabled={!armed || busy || question && !request.questions?.every(q => answers[q.id]?.trim())} onClick={() => decide("approve")}>{question ? "Send answer" : "Approve once"}</button><button class="btn" disabled={!armed || busy} onClick={() => decide("decline")}>Decline</button><span class="spacer" /><button class="btn ghost" onClick={() => { route.value = { view: "run", id: request.runId }; }}>Open chat</button></div>
  </aside>;
}
