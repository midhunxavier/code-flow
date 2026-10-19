import { signal } from "@preact/signals";
import type { SharedRole } from "../src/shared-accounts.js";
import type { Attempt, AttemptState, Board, Checkpoint, InboxItem, InboxKind, RunnerPublic, Task, TaskStatus, Who } from "../src/collab/model.js";
import { api, ago as agoText, enc, latestOnly } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { subscribe } from "./stream.js";

/**
 * The team board's browser state: what the hub answered, what this computer's link says, and how the
 * pages learn that something changed. Owner and shared principals use the same /api/team/* routes, so
 * one module serves the app's Team pages and the shared dashboard's Team tab; the /api/team-link/*
 * calls (this computer as a runner) are owner-only and never made in shared mode. The rules mirrored
 * here (current attempt, liveness, status transitions) copy src/collab/model.ts, which the bundle
 * cannot import because it loads node:crypto; the server enforces them, the mirror only explains them.
 */

/** The two pages, as the owner app's Route union and the shared dashboard's own hash route both carry them. */
export type TeamRoute = { view: "team"; project?: string } | { view: "team-task"; id: string };
/** GET /api/team-link: this computer's link to a hub (`linked: false` means this instance is its own team server). */
export interface TeamLinkInfo { linked: boolean; url?: string; user?: { userId: string; username: string; displayName: string }; hubName?: string; machineName?: string; mappings: Record<string, Record<string, string>>; defaults?: { pattern?: string; roles?: Record<string, string[]>; trust?: string }; runner?: RunnerPublic; lastSync?: number; error?: string }
/** GET /api/team-link/attempts: the runner's own record of an attempt it executes here, which links a task to its run page. */
export interface LocalAttempt { attemptId: string; taskId: string; state: string; runId?: string; repo?: string; base?: string; lastSeq?: number; lastAckedSeq?: number; updatedAt?: number }
export interface InboxPage { items: InboxItem[]; unread: number }
export type Member = Board["projects"][number]["members"][number];

export const board = signal<Board | null>(null);
export const boardLoaded = signal(false);
export const boardError = signal("");
export const teamLink = signal<TeamLinkInfo | null>(null);
export const teamLinkError = signal("");
export const inboxUnread = signal(0);
export const localAttempts = signal<LocalAttempt[]>([]);
/** The task page's task, for the top bar's crumbs. */
export const openTask = signal<Task | null>(null);
/** Set by the inbox bell: the board scrolls to its inbox panel once and clears it. */
export const inboxOpen = signal(false);
/** Moves whenever the hub says something changed; the pages reload on it (and poll every 15 s regardless). */
export const teamTick = signal(0);

export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T = any>(path: string, body?: unknown) => api<T>(path, { method: "DELETE", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const boardRequest = latestOnly();
/** The whole board: the pages filter by project themselves, so the project chips always know every project the viewer may see. */
export async function loadBoard(): Promise<Board | null> {
  const current = boardRequest();
  try { const next = await api<Board>("/api/team/board"); if (!current()) return board.value; board.value = next; boardError.value = ""; inboxUnread.value = next.inboxUnread; return next; }
  catch (error) { if (current()) boardError.value = (error as Error).message; return board.value; }
  finally { if (current()) boardLoaded.value = true; }
}
export const loadTask = (id: string) => api<Task>(`/api/team/tasks/${enc(id)}`);
export async function loadTeamLink(): Promise<TeamLinkInfo | null> {
  try { teamLink.value = await api<TeamLinkInfo>("/api/team-link"); teamLinkError.value = ""; }
  catch (error) { teamLink.value = null; teamLinkError.value = (error as Error).message; }
  return teamLink.value;
}
/** Best effort: the link API is owner-only and may be absent on a remote host, and then the "Open run" link simply stays hidden. */
export async function loadLocalAttempts(): Promise<void> {
  try { const data = await api<LocalAttempt[] | { attempts?: LocalAttempt[] }>("/api/team-link/attempts"); localAttempts.value = Array.isArray(data) ? data : data.attempts ?? []; } catch { /* see above */ }
}
export async function loadInbox(): Promise<InboxPage> { const page = await api<InboxPage>("/api/team/inbox"); inboxUnread.value = page.unread; return page; }
export async function markRead(ids: string[] | "all"): Promise<number> { const result = await api<{ unread: number }>("/api/team/inbox/read", { method: "POST", body: JSON.stringify(ids === "all" ? { all: true } : { ids }) }); inboxUnread.value = result.unread; return result.unread; }
/** Everything a page shows at once; `link` adds this computer's state (owner app only). */
export async function refreshTeam(options: { link?: boolean } = {}): Promise<void> { await Promise.all([loadBoard(), ...(options.link ? [loadTeamLink(), loadLocalAttempts()] : [])]); }

let bump: ReturnType<typeof setTimeout> | undefined;
/** A burst of change events becomes one reload. */
export function bumpTeam(): void { clearTimeout(bump); bump = setTimeout(() => { teamTick.value++; }, 150); }
type TeamEvent = { type?: string; unread?: number } | null;
/**
 * One frame of the team stream, from either source. `hello` and `inbox` frames of the hub's own stream carry the
 * unread count; the owner app's `team` topic says hello without one (it is the stream's cursor, not the inbox), so
 * that hello fetches the count: the rail's Team badge must be right from the first paint and after every reconnect,
 * not only once a Team page happened to load the board. Every frame but a refusal reloads the pages, inbox frames
 * included: marking items read changes the cards' "Needs you" badges, which only the board payload knows.
 */
export function applyTeamEvent(data: TeamEvent): void {
  if (data?.type === "error") return; // the server declined the topic (nothing to show: the pages still poll)
  if (typeof data?.unread === "number" && data.unread >= 0) inboxUnread.value = data.unread;
  else if (data?.type === "hello") void loadInbox().catch(() => undefined);
  bumpTeam();
}
let watching: (() => void) | undefined;
/** The owner app: the server's `team` stream topic (the local hub's events, or the hub's relayed through the link). Called once; the subscription lives as long as the page. */
export function watchTeam(): void { if (watching) return; watching = subscribe("team", (data: TeamEvent) => applyTeamEvent(data)); }
/** How long a shared Team tab waits before reopening a stream the browser gave up on (an HTTP error: the session ended, or the per-account cap of 4 streams). */
export const TEAM_EVENTS_RETRY_MS = 30_000;
/**
 * The shared dashboard: one EventSource to /api/team/events while its Team tab is shown; the returned function
 * closes it. A dropped connection is the browser's own retry; an HTTP error closes the source for good, so that
 * case is reopened after TEAM_EVENTS_RETRY_MS, since the shared Team pages reload on these frames rather than on
 * a timer (a poll would keep a shared session from ever expiring idle).
 */
export function openTeamEvents(onState?: (state: "connected" | "reconnecting") => void): () => void {
  let source: EventSource | undefined, retry: ReturnType<typeof setTimeout> | undefined, closed = false;
  const open = () => {
    if (closed) return;
    const current = source = new EventSource("/api/team/events");
    current.onopen = () => onState?.("connected");
    current.onerror = () => { onState?.("reconnecting"); if (current.readyState === EventSource.CLOSED && !closed) { clearTimeout(retry); retry = setTimeout(open, TEAM_EVENTS_RETRY_MS); } };
    current.onmessage = (event) => { let data: TeamEvent = null; try { data = JSON.parse(event.data) as TeamEvent; } catch { /* a frame that is not JSON still means something moved */ } applyTeamEvent(data && typeof data === "object" ? data : null); };
  };
  open();
  return () => { closed = true; clearTimeout(retry); source?.close(); };
}
/**
 * The address teammates enter under Settings → Team → Connect this computer: the network listener's origin, over
 * HTTPS only. GET /api/remote reports the phone link, `…/r/<secret>`, whose path is the read-only view's secret or,
 * with phone control on, the owner pairing link; neither may be handed to a teammate, and the link refuses any URL
 * with a path anyway. Without TLS there is no address to give: runner credentials travel only over HTTPS or loopback.
 */
export function teamServerAddress(remote: { secure?: boolean; tailscaleUrl?: string } | null | undefined): string | undefined {
  if (!remote?.secure || typeof remote.tailscaleUrl !== "string") return undefined;
  try { const url = new URL(remote.tailscaleUrl); return url.protocol === "https:" ? url.origin : undefined; } catch { return undefined; }
}

export const TASK_STATUSES: readonly TaskStatus[] = ["planned", "working", "blocked", "review", "done"];
export const STATUS_LABEL: Record<TaskStatus, string> = { planned: "Planned", working: "Working", blocked: "Blocked", review: "In review", done: "Done" };
/** `.status-pill.<class>` tones already defined for runs, reused so the board reads like the rest of the app. */
export const STATUS_PILL: Record<TaskStatus, string> = { planned: "planned", working: "running", blocked: "blocked", review: "review", done: "done" };
export const ATTEMPT_LABEL: Record<AttemptState, string> = { claimed: "Starting", running: "Running", paused: "Paused", finished: "Finished", failed: "Failed", stopped: "Stopped at a limit", unknown: "Connection lost", superseded: "Superseded" };
export const ATTEMPT_PILL: Record<AttemptState, string> = { claimed: "running", running: "running", paused: "stopped", finished: "done", failed: "failed", stopped: "stopped", unknown: "failing", superseded: "" };
export const INBOX_LABEL: Record<InboxKind, string> = { assigned: "Assigned to you", mention: "Mentioned you", "review-requested": "Review requested", "review-recorded": "Review recorded", "handoff-offered": "Hand-over offered", "handoff-accepted": "Hand-over accepted", "handoff-declined": "Hand-over declined", "handoff-cancelled": "Hand-over cancelled", "instruction-proposed": "Instruction proposed", blocked: "Blocked", "attempt-finished": "Attempt finished", "attempt-failed": "Attempt failed", comment: "New comment" };
export const HEARTBEAT_LIVE_MS = 90_000;

export const whoLabel = (who: Who | undefined, meId?: string): string => !who ? "Unassigned" : who.userId === meId ? `${who.displayName} (you)` : who.displayName;
/** Two letters for an avatar: first and last name's initials, or the first two letters of a single name. */
export function initials(name: string): string { const parts = name.trim().split(/\s+/).filter(Boolean); const text = parts.length > 1 ? `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}` : (parts[0] ?? "").slice(0, 2); return text.toUpperCase() || "?"; }
export const ago = (at: number): string => agoText(at);
export const when = (at: number): string => new Date(at).toLocaleString();
export const shortCommit = (commit: string): string => commit.slice(0, 10);
export const memberName = (b: Board | null, userId: string): string => { for (const project of b?.projects ?? []) { const member = project.members.find((entry) => entry.userId === userId); if (member) return member.displayName; } return userId; };
/** The viewer's role in a project: the board says it per project; the owner is a maintainer everywhere. */
export const roleIn = (b: Board | null, projectId: string): SharedRole | undefined => b?.projects.find((project) => project.id === projectId)?.role ?? (b?.me.userId === "owner" ? "maintainer" : b?.me.roles[projectId]);

const BUSY: readonly AttemptState[] = ["claimed", "running", "unknown"], CURRENT: readonly AttemptState[] = ["claimed", "running", "paused", "unknown"], RESUMABLE: readonly AttemptState[] = ["paused", "stopped", "unknown"];
const latestIn = (attempts: readonly Attempt[], states: readonly AttemptState[]): Attempt | undefined => { for (let index = attempts.length - 1; index >= 0; index--) { const attempt = attempts[index]!; if (states.includes(attempt.state)) return attempt; } return undefined; };
export const busyAttempt = (task: Pick<Task, "attempts">): Attempt | undefined => latestIn(task.attempts, ["claimed", "running"]) ?? latestIn(task.attempts, BUSY);
export const currentAttempt = (task: Pick<Task, "attempts">): Attempt | undefined => busyAttempt(task) ?? latestIn(task.attempts, CURRENT);
/** The attempt the task page's Execution card shows: the current one, else the latest of any state, so a finished, failed or budget-stopped attempt keeps its summary, its run link and (when it ran here) its Resume button instead of reading "No attempt yet". */
export const shownAttempt = (task: Pick<Task, "attempts">): Attempt | undefined => currentAttempt(task) ?? task.attempts[task.attempts.length - 1];
/** The states POST /api/team-link/tasks/:id/resume continues under the same attempt id (src/collab/link-api.ts): paused by a stop, stopped at a budget or limit, or unknown after a restart. Never on a Done task: the server refuses a report that would revive an attempt there, so the button is not offered. */
export const attemptResumable = (attempt: Pick<Attempt, "state">, task?: Pick<Task, "status">): boolean => RESUMABLE.includes(attempt.state) && task?.status !== "done";
export const latestCheckpoint = (task: Pick<Task, "checkpoints">): Checkpoint | undefined => { let latest: Checkpoint | undefined; for (const checkpoint of task.checkpoints) if (!latest || checkpoint.at >= latest.at) latest = checkpoint; return latest; };
/** A runner is executing and said so within the last 90 s. */
export const attemptLive = (attempt: Pick<Attempt, "state" | "lastHeartbeatAt">, now = Date.now()): boolean => (attempt.state === "claimed" || attempt.state === "running") && now - attempt.lastHeartbeatAt < HEARTBEAT_LIVE_MS;
/** Executing on paper but silent (or `unknown`): the runner may be offline, asleep or gone, and nobody can tell from here. */
export const attemptStale = (attempt: Pick<Attempt, "state" | "lastHeartbeatAt">, now = Date.now()): boolean => attempt.state === "unknown" || ((attempt.state === "claimed" || attempt.state === "running") && !attemptLive(attempt, now));
export const BLOCKER_REQUIRED = "Describe what blocks the task before marking it blocked";
/** Why a status change would be refused, in the server's words, so the select can say it before the round trip. `blocker` is the text a save would carry; omitted means the task's own. */
export function transitionProblem(task: Pick<Task, "status" | "blocker" | "attempts" | "handoff">, to: TaskStatus, role: SharedRole | undefined, blocker: string | undefined = task.blocker): string | undefined {
  if (!roleAtLeast(role, "contributor")) return "A project contributor role is required to change the status";
  if (to === "blocked" && !blocker?.trim()) return BLOCKER_REQUIRED;
  if (to === task.status) return undefined;
  if (to === "done") { const busy = busyAttempt(task); if (busy) return `Stop the attempt running on ${busy.runnerName} before marking the task done`; if (task.handoff?.state === "offered") return "Accept, decline or cancel the offered hand-over before marking the task done"; }
  return undefined;
}
/** Who may become the owner through the select, by the server's owner rules: maintainers choose anyone, a contributor only takes an unowned task or hands back their own. */
export function ownerProblem(task: Pick<Task, "owner" | "attempts">, role: SharedRole | undefined, meId: string | undefined): string | undefined {
  if (!roleAtLeast(role, "contributor")) return "A project contributor role is required to take a task";
  const busy = busyAttempt(task); if (busy) return `Stop the attempt running on ${busy.runnerName} before changing the owner`;
  if (roleAtLeast(role, "maintainer") || !task.owner || task.owner.userId === meId) return undefined;
  return "Only a project maintainer may reassign a task that already has an owner";
}
