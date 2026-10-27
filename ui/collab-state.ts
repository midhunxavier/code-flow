import { signal } from "@preact/signals";
import type { SharedRole } from "../src/shared-accounts.js";
import type { Attempt, AttemptState, Board, Checkpoint, InboxItem, InboxKind, RunnerPublic, Task, TaskStatus, Who } from "../src/collab/model.js";
import { apiPath, api, ago as agoText, enc, latestOnly, selectedTeamConnection, collaborationConfigured, ownerOnLocalListener, teamConnectionRequired } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { openSharedEvents, SHARED_EVENTS_RETRY_MS, type SharedStreamState } from "./shared-events.js";
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
export type TeamRoute = { view: "team"; project?: string } | { view: "team-people"; project?: string } | { view: "team-task"; id: string };
/** GET /api/team-link: this computer's link to a hub (`linked: false` means this instance is its own team server). */
export interface TeamLinkInfo { linked: boolean; connection?: "connected" | "reconnecting" | "offline"; url?: string; user?: { userId: string; username: string; displayName: string }; hubName?: string; machineName?: string; mappings: Record<string, Record<string, string>>; defaults?: { pattern?: string; roles?: Record<string, string[]>; trust?: string }; runner?: RunnerPublic; lastSync?: number; error?: string; revoked?: boolean }
/** GET /api/team-link/attempts: the runner's own record of an attempt it executes here, which links a task to its run page. `runStatus` is the run's status, present only while that run still exists on this computer. */
export interface LocalAttempt { attemptId: string; taskId: string; state: string; runId?: string; runStatus?: string; repo?: string; base?: string; lastSeq?: number; lastAckedSeq?: number; updatedAt?: number }
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
  if (teamConnectionRequired.value) { board.value = null; boardLoaded.value = true; boardError.value = ""; return null; }
  const current = boardRequest();
  try { const next = await api<Board>("/api/team/board"); if (!current()) return board.value; board.value = next; if (next.tasks.length || next.projects.some(project => project.repositories.length > 0 || project.members.some(member => member.userId !== "owner"))) collaborationConfigured.value = true; boardError.value = ""; inboxUnread.value = next.inboxUnread; return next; }
  catch (error) { if (current()) { board.value = null; openTask.value = null; inboxUnread.value = 0; boardError.value = (error as Error).message; } return null; }
  finally { if (current()) boardLoaded.value = true; }
}
export const loadTask = (id: string) => api<Task>(`/api/team/tasks/${enc(id)}`);
export async function loadTeamLink(): Promise<TeamLinkInfo | null> {
  if (!ownerOnLocalListener.value) { teamLink.value = null; teamLinkError.value = ""; return null; }
  if (teamConnectionRequired.value) return null;
  try { teamLink.value = await api<TeamLinkInfo>("/api/team-link"); if (teamLink.value.linked) collaborationConfigured.value = true; teamLinkError.value = ""; }
  catch (error) { teamLink.value = null; teamLinkError.value = (error as Error).message; }
  return teamLink.value;
}
/** Best effort: the link API is owner-only and may be absent on a remote host, and then the "Open run" link simply stays hidden. */
export async function loadLocalAttempts(): Promise<void> {
  if (!ownerOnLocalListener.value) { localAttempts.value = []; return; }
  if (teamConnectionRequired.value) return;
  try { const data = await api<LocalAttempt[] | { attempts?: LocalAttempt[] }>("/api/team-link/attempts"); localAttempts.value = Array.isArray(data) ? data : data.attempts ?? []; } catch { localAttempts.value = []; }
}
export async function loadInbox(): Promise<InboxPage> { if (teamConnectionRequired.value) return { items: [], unread: 0 }; const page = await api<InboxPage>("/api/team/inbox"); inboxUnread.value = page.unread; return page; }
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
  else if (data?.type === "hello") { void loadInbox().catch(() => undefined); void loadBoard(); }
  bumpTeam();
}
let watching: (() => void) | undefined;
/** The owner app: the server's `team` stream topic (the local hub's events, or the hub's relayed through the link). Called once; the subscription lives as long as the page. */
export function watchTeam(): void {
  if (watching || teamConnectionRequired.value) return;
  void loadTeamLink();
  // A tab pinned to its own board must still expose other saved connections.
  if (ownerOnLocalListener.value) void api<{ connections: { linked: boolean }[] }>("/api/team-link/connections").then(inventory => {
    if (inventory.connections.some(connection => connection.linked)) collaborationConfigured.value = true;
  }).catch(() => undefined);
  watching = subscribe(selectedTeamConnection ? `team:${selectedTeamConnection}` : "team", (data: TeamEvent) => applyTeamEvent(data));
}
/** How long a shared Team tab waits before reopening a stream the browser gave up on (an HTTP error: the session ended, or the per-account cap of 4 streams). */
export const TEAM_EVENTS_RETRY_MS = SHARED_EVENTS_RETRY_MS;
/** Shared Board live updates, with the same refusal recovery as Results. */
export function openTeamEvents(onState?: (state: SharedStreamState, reason?: string) => void): () => void {
  return openSharedEvents(apiPath("/api/team/events"), event => { let data: TeamEvent = null; try { data = JSON.parse(event.data) as TeamEvent; } catch {} applyTeamEvent(data && typeof data === "object" ? data : null); }, onState);
}
/**
 * The address teammates enter under Settings → Connections → Share access → Join a team: the network listener's origin, over
 * HTTPS only. GET /api/remote reports the phone link, `…/r/<secret>`, whose path is the read-only view's secret or,
 * with phone control on, the owner pairing link; neither may be handed to a teammate, and the link refuses any URL
 * with a path anyway. Without TLS there is no address to give: runner credentials travel only over HTTPS or loopback.
 */
export function teamServerAddress(remote: { secure?: boolean; tailscaleUrl?: string; lanUrls?: string[] } | null | undefined): string | undefined {
  const address = remote?.tailscaleUrl ?? remote?.lanUrls?.[0];
  if (!remote?.secure || typeof address !== "string") return undefined;
  try { const url = new URL(address); return url.protocol === "https:" ? url.origin : undefined; } catch { return undefined; }
}

export const TASK_STATUSES: readonly TaskStatus[] = ["planned", "working", "blocked", "review", "done"];
export const STATUS_LABEL: Record<TaskStatus, string> = { planned: "Planned", working: "Working", blocked: "Blocked", review: "In review", done: "Done" };
/** `.status-pill.<class>` tones already defined for runs, reused so the board reads like the rest of the app. */
export const STATUS_PILL: Record<TaskStatus, string> = { planned: "planned", working: "running", blocked: "blocked", review: "review", done: "done" };
/** A claimed or running attempt whose runner has been silent for 90 s reads "Connection lost" instead (attemptSilent); `unknown` is what the hub or the runner itself recorded, with a reason. */
export const ATTEMPT_LABEL: Record<AttemptState, string> = { claimed: "Starting", running: "Running", paused: "Paused", finished: "Finished", failed: "Failed", stopped: "Stopped at a limit", unknown: "Status unknown", superseded: "Superseded" };
export const ATTEMPT_PILL: Record<AttemptState, string> = { claimed: "running", running: "running", paused: "stopped", finished: "done", failed: "failed", stopped: "stopped", unknown: "failing", superseded: "" };
export const INBOX_LABEL: Record<InboxKind, string> = { assigned: "Assigned to you", mention: "Mentioned you", "review-requested": "Review requested", "review-recorded": "Review recorded", "handoff-offered": "Hand-over offered", "handoff-accepted": "Hand-over accepted", "handoff-declined": "Hand-over declined", "handoff-cancelled": "Hand-over cancelled", "instruction-proposed": "Instruction proposed", "instruction-approved": "Instruction approved", "instruction-declined": "Instruction declined", blocked: "Blocked", "attempt-finished": "Attempt finished", "attempt-failed": "Attempt failed", comment: "New comment" };
export const HEARTBEAT_LIVE_MS = 90_000;
/** The `code` of the one 409 a page answers by reloading and keeping the draft (src/collab/model.ts STALE_REVISION); every other 409 is a refusal to show. */
export const STALE_REVISION = "stale-revision";

export const whoLabel = (who: Who | undefined, meId?: string): string => !who ? "Unassigned" : who.userId === meId ? `${who.displayName} (you)` : who.displayName;
/** Two letters for an avatar: first and last name's initials, or the first two letters of a single name. */
export function initials(name: string): string { const parts = name.trim().split(/\s+/).filter(Boolean); const text = parts.length > 1 ? `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}` : (parts[0] ?? "").slice(0, 2); return text.toUpperCase() || "?"; }
export const ago = (at: number): string => agoText(at);
export const when = (at: number): string => new Date(at).toLocaleString();
export const shortCommit = (commit: string): string => commit.slice(0, 10);
export const memberName = (b: Board | null, userId: string): string => { for (const project of b?.projects ?? []) { const member = project.members.find((entry) => entry.userId === userId); if (member) return member.displayName; } return userId; };
/** The viewer's role in a project: the board says it per project; the owner is a maintainer everywhere. */
export const roleIn = (b: Board | null, projectId: string): SharedRole | undefined => b?.projects.find((project) => project.id === projectId)?.role ?? (b?.me.userId === "owner" ? "maintainer" : b?.me.roles[projectId]);

const BUSY: readonly AttemptState[] = ["claimed", "running", "unknown"], NOT_SUPERSEDED: readonly AttemptState[] = ["claimed", "running", "paused", "finished", "failed", "stopped", "unknown"], RESUMABLE: readonly AttemptState[] = ["paused", "stopped", "unknown"];
const latestIn = (attempts: readonly Attempt[], states: readonly AttemptState[]): Attempt | undefined => { for (let index = attempts.length - 1; index >= 0; index--) { const attempt = attempts[index]!; if (states.includes(attempt.state)) return attempt; } return undefined; };
export const busyAttempt = (task: Pick<Task, "attempts">): Attempt | undefined => latestIn(task.attempts, ["claimed", "running"]) ?? latestIn(task.attempts, BUSY);
/** The busy attempt, else the latest one not superseded when it is paused or unknown: an older paused attempt behind a newer finished one is history, not where the task stands. */
export const currentAttempt = (task: Pick<Task, "attempts">): Attempt | undefined => { const busy = busyAttempt(task); if (busy) return busy; const latest = latestIn(task.attempts, NOT_SUPERSEDED); return latest && (latest.state === "paused" || latest.state === "unknown") ? latest : undefined; };
/** The attempt the task page's Execution card shows: the current one, else the latest of any state, so a finished, failed or budget-stopped attempt keeps its summary, its run link and (when it ran here) its Resume button instead of reading "No attempt yet". */
export const shownAttempt = (task: Pick<Task, "attempts">): Attempt | undefined => currentAttempt(task) ?? task.attempts[task.attempts.length - 1];
/** The states POST /api/team-link/tasks/:id/resume continues under the same attempt id (src/collab/link-api.ts): paused by a stop, stopped at a budget or limit, or unknown after a restart. Never on a Done task: the server refuses a report that would revive an attempt there, so the button is not offered. */
export const attemptResumable = (attempt: Pick<Attempt, "state">, task?: Pick<Task, "status">): boolean => RESUMABLE.includes(attempt.state) && task?.status !== "done";
export const latestCheckpoint = (task: Pick<Task, "checkpoints">): Checkpoint | undefined => { let latest: Checkpoint | undefined; for (const checkpoint of task.checkpoints) if (!latest || checkpoint.at >= latest.at) latest = checkpoint; return latest; };
/** A runner is executing and said so within the last 90 s. */
export const attemptLive = (attempt: Pick<Attempt, "state" | "lastHeartbeatAt">, now = Date.now()): boolean => (attempt.state === "claimed" || attempt.state === "running") && now - attempt.lastHeartbeatAt < HEARTBEAT_LIVE_MS;
/** Executing on paper but silent for 90 s: "Connection lost". The runner may be offline, asleep or gone, and nobody can tell from here. */
export const attemptSilent = (attempt: Pick<Attempt, "state" | "lastHeartbeatAt">, now = Date.now()): boolean => (attempt.state === "claimed" || attempt.state === "running") && !attemptLive(attempt, now);
/** Silent or `unknown`: execution stays reserved, and the task owner or a project maintainer may recover the attempt once they confirmed its agent stopped (POST /api/team/attempts/:id/recover, which the hub checks again). */
export const attemptStale = (attempt: Pick<Attempt, "state" | "lastHeartbeatAt">, now = Date.now()): boolean => attempt.state === "unknown" || attemptSilent(attempt, now);
/** Why a busy attempt blocks `before`, worded by what can be done about it: a live runner is stopped on its computer; one that lost contact (given `now`) is recovered here. */
export const busyProblem = (busy: Pick<Attempt, "state" | "lastHeartbeatAt" | "runnerName">, before: string, now?: number): string => now !== undefined && attemptStale(busy, now) ? `Recover the attempt on ${busy.runnerName}, whose runner lost contact, before ${before}` : `Stop the attempt running on ${busy.runnerName} before ${before}`;
export const BLOCKER_REQUIRED = "Describe what blocks the task before marking it blocked";
/** Why a status change would be refused, in the server's words, so the select can say it before the round trip. `blocker` is the text a save would carry; omitted means the task's own. With `now`, an attempt whose runner lost contact is named for recovery rather than for a stop nobody here can make. */
export function transitionProblem(task: Pick<Task, "status" | "blocker" | "attempts" | "handoff">, to: TaskStatus, role: SharedRole | undefined, blocker: string | undefined = task.blocker, now?: number): string | undefined {
  if (!roleAtLeast(role, "contributor")) return "A project contributor role is required to change the status";
  if (to === "blocked" && !blocker?.trim()) return BLOCKER_REQUIRED;
  if (to === task.status) return undefined;
  if (to === "done") { const busy = busyAttempt(task); if (busy) return busyProblem(busy, "marking the task done", now); if (task.handoff?.state === "offered") return "Accept, decline or cancel the offered hand-over before marking the task done"; }
  return undefined;
}
/** Who may become the owner through the select, by the server's owner rules: maintainers choose anyone, a contributor only takes an unowned task or hands back their own. `now` words a busy attempt as transitionProblem does. */
export function ownerProblem(task: Pick<Task, "owner" | "attempts">, role: SharedRole | undefined, meId: string | undefined, now?: number): string | undefined {
  if (!roleAtLeast(role, "contributor")) return "A project contributor role is required to take a task";
  const busy = busyAttempt(task); if (busy) return busyProblem(busy, "changing the owner", now);
  if (roleAtLeast(role, "maintainer") || !task.owner || task.owner.userId === meId) return undefined;
  return "Only a project maintainer may reassign a task that already has an owner";
}
