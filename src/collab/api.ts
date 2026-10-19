import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { HttpError, readJson, readLoginJson, send } from "../http.js";
import { SharedAccountError } from "../shared-accounts.js";
import type { SharedAccounts, SharedUser } from "../shared-accounts.js";
import { ATTEMPT_ID, CHECKPOINT_ID, CollabError, MAX, PATH_ID, RUNNER_TOKEN, SHA256_HEX, actorRole, roleAtLeast, validateText } from "./model.js";
import type { Checkpoint, CollabActor } from "./model.js";
import type { ChangeEvent, ChangeKind, ClaimInput, CollabStore, FinishInput, HandoffInput, ReviewInput } from "./store.js";

/**
 * The hub's HTTP layer for the team board: a closed route table, one dispatcher that turns store calls into
 * JSON answers, the per-actor change stream and the runner enrolment handshake. It holds no state and no
 * authorization rule of its own (the store enforces roles, ownership and revisions, so in-process callers get
 * the same answers); it decides which kinds of principal may reach which route, bounds every body, and keeps
 * store internals (file paths, token hashes) off the wire. server.ts resolves the principal and mounts this.
 */

export type TeamPrincipal = "owner" | "browser" | "runner";
export type TeamOp = "connect" | "me" | "board" | "events" | "task" | "task-create" | "task-update" | "task-delete" | "comment" | "decision" | "review-request" | "review" | "instruction-propose" | "instruction-decide" | "attempt-claim" | "handoff-offer" | "handoff-respond" | "attempt-progress" | "attempt-heartbeat" | "attempt-finish" | "attempt-recover" | "checkpoint-add" | "checkpoint" | "checkpoint-delete" | "bundle-upload" | "bundle-download" | "inbox" | "inbox-read" | "runners" | "runner-revoke" | "repositories" | "profile";
export interface TeamRoute { op: TeamOp; principals: TeamPrincipal[]; bodyLimit?: number }
/** What server.ts hands over per request: the resolved principal, the CSRF rule it chose for that principal kind (called for every non-GET), and for long-lived streams a way to re-resolve the principal (throw to end the stream). */
export interface TeamApiHost { store: CollabStore; actor: CollabActor; principal: TeamPrincipal; reauthorize?: () => CollabActor; mutation: (req: IncomingMessage) => void }
export interface RunnerConnectHost { accounts: Pick<SharedAccounts, "verifyCredentials">; store: CollabStore; transport: { address: string; secure: boolean; loopback: boolean }; ownerName?: string }
/** Frames of GET /api/team/events. `seq` values are cursors (`<epoch>:<seq>` goes back as `?after=`); a resync means the ring could not replay (or the actor's roles changed), so the client reloads what it shows. */
export type TeamStreamFrame = { type: "hello"; epoch: string; seq: number; unread: number } | { type: "change"; seq: number; kind: ChangeKind; taskId?: string; projectId?: string } | { type: "inbox"; seq: number; unread: number } | { type: "resync" };

export { RUNNER_TOKEN };
/** A bearer that looks like a runner credential is authenticated against the team store and nothing else; owner tokens and session cookies never match this shape. */
export const looksLikeRunnerToken = (bearer: unknown): bearer is string => typeof bearer === "string" && RUNNER_TOKEN.test(bearer);
export const isTeamApiPath = (parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "team";
/** Whether a runner credential may reach the route at all; server.ts answers 403 "This credential only reaches the team API" for everything else. */
export function runnerAllowed(route: TeamRoute | undefined): boolean { return route !== undefined && route.principals.includes("runner"); }

const KIB = 1024;
/** Sized from model.ts's bounds rather than one flat figure, counting four UTF-8 bytes per character where model.ts bounds characters (readJson counts bytes): a progress snapshot carries up to 100 paths of 300 characters, 10 blockers of 500 and a 4 KiB summary (under 192 KiB), a checkpoint manifest up to 100 decisions of 2000 characters, 16 KiB of requirements, 8 KiB of remaining work and the paths (under 1.25 MiB), so a CJK team's legitimate reports are never 413. */
export const TEAM_BODY_LIMIT = { small: 16 * KIB, task: 64 * KIB, progress: 192 * KIB, manifest: 1280 * KIB, connect: 8 * KIB } as const;
const ALL: readonly TeamPrincipal[] = ["owner", "browser", "runner"], EXECUTING: readonly TeamPrincipal[] = ["owner", "runner"], OWNER_ONLY: readonly TeamPrincipal[] = ["owner"], NOBODY: readonly TeamPrincipal[] = [];
const ID = Symbol("id"); type Segment = string | typeof ID;
interface RouteSpec { method: string; path: readonly Segment[]; op: TeamOp; principals: readonly TeamPrincipal[]; bodyLimit?: number }
const r = (method: string, path: readonly Segment[], op: TeamOp, principals: readonly TeamPrincipal[] = ALL, bodyLimit?: number): RouteSpec => bodyLimit === undefined ? { method, path, op, principals } : { method, path, op, principals, bodyLimit };
/** Every team route, with exact segment counts. Browsers never execute (claim, progress, heartbeat, finish, checkpoints, bundle upload are the executing machine's: the owner process in-process, or the runner credential the attempt was claimed with); the owner's profile is the owner's alone; enrolment is anonymous and handled by handleRunnerConnect. */
const ROUTES: readonly RouteSpec[] = [
  r("POST", ["runners", "connect"], "connect", NOBODY, TEAM_BODY_LIMIT.connect),
  r("GET", ["me"], "me"), r("GET", ["board"], "board"), r("GET", ["events"], "events"),
  r("GET", ["tasks", ID], "task"), r("POST", ["tasks"], "task-create", ALL, TEAM_BODY_LIMIT.task), r("PUT", ["tasks", ID], "task-update", ALL, TEAM_BODY_LIMIT.task), r("DELETE", ["tasks", ID], "task-delete", ALL, TEAM_BODY_LIMIT.small),
  r("POST", ["tasks", ID, "comments"], "comment", ALL, TEAM_BODY_LIMIT.small), r("POST", ["tasks", ID, "decisions"], "decision", ALL, TEAM_BODY_LIMIT.small), r("POST", ["tasks", ID, "review-request"], "review-request", ALL, TEAM_BODY_LIMIT.small), r("POST", ["tasks", ID, "reviews"], "review", ALL, TEAM_BODY_LIMIT.small),
  r("POST", ["tasks", ID, "instructions"], "instruction-propose", ALL, TEAM_BODY_LIMIT.small), r("POST", ["tasks", ID, "instructions", ID], "instruction-decide", ALL, TEAM_BODY_LIMIT.small),
  r("POST", ["tasks", ID, "attempts"], "attempt-claim", EXECUTING, TEAM_BODY_LIMIT.small), r("POST", ["tasks", ID, "handoff"], "handoff-offer", ALL, TEAM_BODY_LIMIT.small), r("POST", ["tasks", ID, "handoff", ID], "handoff-respond", ALL, TEAM_BODY_LIMIT.small),
  r("POST", ["attempts", ID, "progress"], "attempt-progress", EXECUTING, TEAM_BODY_LIMIT.progress), r("POST", ["attempts", ID, "heartbeat"], "attempt-heartbeat", EXECUTING), r("POST", ["attempts", ID, "finish"], "attempt-finish", EXECUTING, TEAM_BODY_LIMIT.small), r("POST", ["attempts", ID, "checkpoints"], "checkpoint-add", EXECUTING, TEAM_BODY_LIMIT.manifest),
  r("POST", ["attempts", ID, "recover"], "attempt-recover", ALL, TEAM_BODY_LIMIT.small),
  r("GET", ["checkpoints", ID], "checkpoint"), r("DELETE", ["checkpoints", ID], "checkpoint-delete"), r("PUT", ["checkpoints", ID, "bundle"], "bundle-upload", EXECUTING, MAX.bundle), r("GET", ["checkpoints", ID, "bundle"], "bundle-download"),
  r("GET", ["inbox"], "inbox"), r("POST", ["inbox", "read"], "inbox-read", ALL, TEAM_BODY_LIMIT.small),
  r("GET", ["runners"], "runners"), r("DELETE", ["runners", ID], "runner-revoke"),
  r("PUT", ["projects", ID, "repositories"], "repositories", ALL, TEAM_BODY_LIMIT.task), r("PUT", ["profile"], "profile", OWNER_ONLY, TEAM_BODY_LIMIT.small),
];
const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];
const idOk = (part: string | undefined): part is string => part !== undefined && PATH_ID.test(part) && !UNSAFE_KEYS.includes(part);
/** The closed table over the canonical path (`["api","team",…]`): anything not listed, including a path id outside `[a-zA-Z0-9_-]{1,100}`, is undefined and the server answers 404 "Unknown team operation" without touching the store. */
export function teamRoutePolicy(method: string, parts: readonly string[]): TeamRoute | undefined {
  if (!isTeamApiPath(parts) || parts.length > 6) return undefined;
  const rest = parts.slice(2);
  for (const spec of ROUTES) {
    if (spec.method !== method || spec.path.length !== rest.length || !spec.path.every((segment, index) => segment === ID ? idOk(rest[index]) : segment === rest[index])) continue;
    const route: TeamRoute = { op: spec.op, principals: [...spec.principals] }; if (spec.bodyLimit !== undefined) route.bodyLimit = spec.bodyLimit; return route;
  }
  return undefined;
}
/** The refusal names what the route is for, since the principal kind alone says nothing a teammate can act on. */
function denied(route: TeamRoute): HttpError {
  if (!route.principals.length) return new HttpError(403, "Connect a computer without a session or runner credential: POST /api/team/runners/connect with { username, password, name }");
  if (!route.principals.includes("runner")) return new HttpError(403, "Only the hub owner may do this, from the team server itself");
  return new HttpError(403, "Only the computer executing an attempt may start it or report on it; run team tasks from your own code-flow (Settings → Team → Connect this computer)");
}
const checkpointIdOf = (value: unknown): string => { if (typeof value !== "string" || !CHECKPOINT_ID.test(value)) throw new CollabError("Send the checkpoint id as 32 lowercase hexadecimal characters"); return value; };
const attemptIdOf = (value: unknown): string => { if (typeof value !== "string" || !ATTEMPT_ID.test(value)) throw new CollabError("Send the attempt id as 32 lowercase hexadecimal characters"); return value; };

/** Dispatches one `/api/team/*` request for an already resolved principal. CollabErrors (the store's refusals, including 503 while storage is unavailable) are answered here with their status, because server.ts's `attempt()` maps only its own error classes; HttpErrors pass through to the server's listener and anything else surfaces as a logged 500. */
export async function handleTeamApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], host: TeamApiHost): Promise<void> {
  const method = req.method ?? "GET", route = teamRoutePolicy(method, parts);
  if (!route) throw new HttpError(404, "Unknown team operation");
  if (!route.principals.includes(host.principal)) throw denied(route);
  if (method !== "GET") host.mutation(req);
  try { await dispatch(req, res, url, parts, host, route); }
  catch (error) { if (error instanceof CollabError && !res.headersSent) return send(res, error.status, { error: error.message }); throw error; }
}
async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], host: TeamApiHost, route: TeamRoute): Promise<void> {
  const { store, actor } = host, id = parts[3] ?? "", sub = parts[5] ?? "", body = (): Promise<Record<string, unknown>> => readJson(req, route.bodyLimit ?? TEAM_BODY_LIMIT.small, { timeoutMs: 10_000 });
  switch (route.op) {
    case "connect": throw denied(route);
    case "me": { const { runners, ...me } = (await store.board(actor)).me; return send(res, 200, { me, runners, linked: false }); }
    case "board": { const project = url.searchParams.get("project"); if (project) { if (!idOk(project)) throw new CollabError("Project not found", 404); return send(res, 200, await store.board(actor, project)); } return send(res, 200, await store.board(actor)); }
    case "events": return openTeamEvents(res, url, host);
    case "task": return send(res, 200, await store.task(actor, id));
    case "task-create": return send(res, 201, await store.createTask(actor, await body()));
    case "task-update": { const patch = await body(); return send(res, 200, await store.updateTask(actor, id, patch, patch.revision)); }
    case "task-delete": return send(res, 200, await store.deleteTask(actor, id, (await body()).revision));
    case "comment": return send(res, 200, await store.comment(actor, id, (await body()).text));
    case "decision": return send(res, 200, await store.decide(actor, id, (await body()).text));
    case "review-request": { const input = await body(); return send(res, 200, await store.requestReview(actor, id, input.reviewer, input.revision)); }
    case "review": { const input = await body(), review: ReviewInput = { checkpointId: checkpointIdOf(input.checkpointId), verdict: input.verdict as ReviewInput["verdict"] }; if (input.text !== undefined && input.text !== null) review.text = input.text as string; return send(res, 200, await store.review(actor, id, review, input.revision)); }
    case "instruction-propose": return send(res, 200, await store.proposeInstruction(actor, id, (await body()).text));
    case "instruction-decide": {
      const input = await body(); if (input.action === "delivered") return send(res, 200, await store.markInstructionDelivered(actor, id, sub, attemptIdOf(input.attemptId)));
      if (input.action !== "approve" && input.action !== "decline") throw new CollabError('Choose an action: "approve", "decline" or "delivered"'); return send(res, 200, await store.decideInstruction(actor, id, sub, input.action));
    }
    case "attempt-claim": return send(res, 201, await store.claimAttempt(actor, id, (await body()) as unknown as ClaimInput));
    case "handoff-offer": { const input = await body(), handoff: HandoffInput = { to: input.to as string, checkpointId: input.checkpointId as string }; if (input.note !== undefined && input.note !== null) handoff.note = input.note as string; return send(res, 200, await store.offerHandoff(actor, id, handoff, input.revision)); }
    case "handoff-respond": { const input = await body(); return send(res, 200, await store.respondHandoff(actor, id, sub, input.action as "accept" | "decline" | "cancel", input.revision)); }
    case "attempt-progress": return send(res, 200, await store.attemptProgress(actor, id, await body()));
    case "attempt-heartbeat": return send(res, 200, await store.heartbeat(actor, id));
    case "attempt-finish": return send(res, 200, await store.finishAttempt(actor, id, (await body()) as unknown as FinishInput));
    case "attempt-recover": return send(res, 200, await store.recoverAttempt(actor, id, await body()));
    case "checkpoint-add": return send(res, 201, await store.addCheckpoint(actor, id, await body()));
    case "checkpoint": return send(res, 200, await checkpointById(store, actor, id));
    case "checkpoint-delete": await store.deleteCheckpoint(actor, id); return send(res, 200, { deleted: true });
    case "bundle-upload": return uploadBundle(req, res, store, actor, id);
    case "bundle-download": return downloadBundle(res, store, actor, id);
    case "inbox": return send(res, 200, await store.inbox(actor, url.searchParams.get("after") ?? undefined));
    case "inbox-read": { const input = await body(); return send(res, 200, await store.markRead(actor, input.all === true ? "all" : input.ids)); }
    case "runners": return send(res, 200, await store.runners(actor));
    case "runner-revoke": await store.revokeRunner(actor, id); return send(res, 200, { revoked: true });
    case "repositories": { const input = await body(); return send(res, 200, await store.setRepositories(actor, id, input.repositories, input.revision)); }
    case "profile": return send(res, 200, await store.setOwnerName(actor, (await body()).displayName));
  }
}
/** The store keeps checkpoints inside their tasks and has no lookup by checkpoint id, so the manifest is found through the actor's own board: the tasks whose latest checkpoint it is first, then every visible task. Visibility is the board's, so an id from another project is "not found" here as well. */
async function checkpointById(store: CollabStore, actor: CollabActor, id: string): Promise<Checkpoint> {
  if (CHECKPOINT_ID.test(id)) {
    const board = await store.board(actor), order = board.tasks.filter((task) => task.checkpoint?.id === id).map((task) => task.id); for (const task of board.tasks) if (!order.includes(task.id)) order.push(task.id);
    for (const taskId of order) { const found = (await store.task(actor, taskId)).checkpoints.find((checkpoint) => checkpoint.id === id); if (found) return found; }
  }
  throw new CollabError("Checkpoint not found", 404);
}
/** Streams the request body into the store, which hashes and counts as it goes. Refusals are answered here rather than thrown, and a declared body of acceptable size is then drained rather than cut off: destroying a socket that still holds unread upload bytes makes the kernel answer with RST, and the runner then sees EPIPE instead of the 409 "already uploaded" its finish retry depends on (it never completes, and the attempt stays running on the board). Only a body the hub could never take, undeclared or over 64 MiB, is cut once the answer is out. */
async function uploadBundle(req: IncomingMessage, res: ServerResponse, store: CollabStore, actor: CollabActor, id: string): Promise<void> {
  const declared = req.headers["content-length"], size = declared !== undefined && /^\d{1,12}$/.test(declared) ? Number(declared) : undefined;
  const refuse = (status: number, message: string) => { send(res, status, { error: message }); if (req.complete || req.destroyed) return; if (size !== undefined && size <= MAX.bundle) req.resume(); else res.once("finish", () => req.destroy()); };
  if (!/^application\/octet-stream(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) return refuse(415, "Upload the checkpoint bundle as application/octet-stream");
  if (size === undefined) return refuse(411, "Send content-length with the checkpoint bundle");
  if (size > MAX.bundle) return refuse(413, `Checkpoint bundles are limited to ${MAX.bundle / 1024 / 1024} MiB`);
  const sha256 = String(req.headers["x-codeflow-sha256"] ?? "").toLowerCase(); if (!SHA256_HEX.test(sha256)) return refuse(400, "Send the bundle's SHA-256 digest as 64 hexadecimal characters in the x-codeflow-sha256 header");
  try { const checkpoint = await store.storeBundle(actor, id, req, { size, sha256 }); send(res, 200, { checkpoint }); }
  catch (error) { if (!(error instanceof CollabError)) throw error; refuse(error.status, error.message); }
}
/** The file is opened (O_NOFOLLOW, size re-checked) before any header goes out, so a bundle that vanished since the manifest was read is a clean 404 and never a truncated 200. */
async function downloadBundle(res: ServerResponse, store: CollabStore, actor: CollabActor, id: string): Promise<void> {
  const { path, checkpoint } = await store.bundlePath(actor, id), missing = () => new CollabError("The checkpoint bundle is missing from the hub's storage; create a new checkpoint", 404);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw missing(); });
  const info = await handle.stat().catch(() => undefined); if (!info?.isFile() || info.size !== checkpoint.size) { await handle.close().catch(() => undefined); throw missing(); }
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(checkpoint.size), "x-codeflow-sha256": checkpoint.sha256, "cache-control": "no-store", "content-disposition": `attachment; filename="${checkpoint.id}.bundle"` });
  // pipeline closes the handle with its stream; a client that goes away mid-file ends here quietly, since nothing more can be said on a response whose headers are out.
  try { await pipeline(handle.createReadStream(), res); } catch { res.destroy(); }
}

// ---- Change stream: the sharedStream discipline (4 per account, 128 in all, 2 MiB of backlog, a 15 s ping that re-checks the principal) over the store's change ring, filtered to what the actor may see.
const teamStreams = new Map<string, number>(); let totalTeamStreams = 0;
const STREAM_BYTES = 2 * 1024 * 1024, PING_MS = 15_000, STREAMS_PER_USER = 4, STREAMS_TOTAL = 128, CURSOR_MAX = 100;
/** A consumer that cannot keep up is closed once 2 MiB of frames wait on its socket and reconnects with a cursor instead of growing an unbounded queue; the caps keep one account's tabs from starving the hub. `res.write()` reporting false is not taken as backpressure: Node corks a synchronous burst such as the opening replay until the next tick and reports every frame after the first as unsent, which would close every reconnect whose replay exceeds the socket's high-water mark before the hello frame leaves the process. A disposer added after the stream closed runs at once, so nothing registered late (a ping timer) outlives it. */
function teamStream(res: ServerResponse, userId: string) {
  const count = teamStreams.get(userId) ?? 0;
  if (count >= STREAMS_PER_USER || totalTeamStreams >= STREAMS_TOTAL) throw new HttpError(429, "Too many team event streams; close another tab and retry");
  teamStreams.set(userId, count + 1); totalTeamStreams++;
  let closed = false; const disposers: (() => void)[] = [];
  const close = () => { if (closed) return; closed = true; const remaining = (teamStreams.get(userId) ?? 1) - 1; if (remaining) teamStreams.set(userId, remaining); else teamStreams.delete(userId); totalTeamStreams--; for (const dispose of disposers.splice(0)) dispose(); res.destroy(); };
  const write = (frame: string) => { if (closed) return; const bytes = Buffer.byteLength(frame); if (bytes > STREAM_BYTES || res.writableLength + bytes > STREAM_BYTES) return close(); res.write(frame); };
  res.on("close", close); if (res.destroyed) close();
  if (!closed) res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  return { close, add: (dispose: () => void) => { if (closed) dispose(); else disposers.push(dispose); }, emit: (frame: TeamStreamFrame) => write(`data: ${JSON.stringify(frame)}\n\n`), ping: () => write(": connected\n\n") };
}
const rolesKey = (actor: CollabActor) => actor.kind === "owner" ? "owner" : Object.entries(actor.roles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([project, role]) => `${project}=${role}`).join(",");
const seesAllRunners = (actor: CollabActor) => actor.kind === "owner";
/** hello (with the inbox count, which also surfaces unavailable storage as a 503 before any header goes out), then a replay from the cursor or a resync, then live frames. Task and board events are relayed only for projects where the actor holds a role at delivery time, so another project's task ids never travel; inbox events become an unread count rather than their contents. */
async function openTeamEvents(res: ServerResponse, url: URL, host: TeamApiHost): Promise<void> {
  const after = url.searchParams.get("after") ?? undefined; if (after !== undefined && after.length > CURSOR_MAX) throw new HttpError(400, "Invalid team event cursor");
  const { store } = host; let actor = host.actor; const { unread } = await store.inbox(actor);
  const stream = teamStream(res, actor.userId); let roles = rolesKey(actor), last = 0, counting = false;
  const refresh = () => { if (!host.reauthorize) return; const next = host.reauthorize(); if (next.userId !== actor.userId) throw new HttpError(401, "Team session changed"); actor = next; const key = rolesKey(next); if (key !== roles) { roles = key; stream.emit({ type: "resync" }); } };
  const inboxFrame = () => { if (counting) return; counting = true; store.inbox(actor).then(({ unread }) => { counting = false; stream.emit({ type: "inbox", seq: last, unread }); }, () => stream.close()); };
  const deliver = (event: ChangeEvent) => {
    if (event.seq <= last) return; last = event.seq;
    if (event.kind === "inbox") { if (event.userIds?.includes(actor.userId)) inboxFrame(); return; }
    if (event.kind === "runners") { if (!event.userIds || event.userIds.includes(actor.userId) || seesAllRunners(actor)) stream.emit({ type: "change", seq: event.seq, kind: "runners" }); return; }
    // Task events always name their project; a board event without one is global (the owner's display name). Anything else stays private.
    if (event.projectId !== undefined ? actorRole(actor, event.projectId) === undefined : event.kind !== "board") return;
    const frame: Extract<TeamStreamFrame, { type: "change" }> = { type: "change", seq: event.seq, kind: event.kind }; if (event.taskId !== undefined) frame.taskId = event.taskId; if (event.projectId !== undefined) frame.projectId = event.projectId; stream.emit(frame);
  };
  // Both disposers are registered before any frame goes out: a replay that closes the stream (the 2 MiB bound, a client already gone) must take the ping timer with it, or it would re-authorize the principal every 15 s for the life of the process.
  stream.add(store.onChange((event) => { try { refresh(); deliver(event); } catch { stream.close(); } }));
  const timer = setInterval(() => { try { refresh(); stream.ping(); } catch { stream.close(); } }, PING_MS); timer.unref(); stream.add(() => clearInterval(timer));
  const page = store.eventsSince(after);
  stream.emit({ type: "hello", epoch: page.epoch, seq: page.seq, unread }); if (page.resync) stream.emit({ type: "resync" });
  for (const event of page.events) deliver(event); last = Math.max(last, page.seq);
}

/** `POST /api/team/runners/connect` is anonymous and runs beside the sign-in route: the same password proof as sign-in (limiter, dummy derivation, HTTPS-or-loopback), but it mints a runner credential instead of a cookie. The name is checked before the password so a bad request costs no key derivation; the token is returned once and only its hash is stored. */
export async function handleRunnerConnect(req: IncomingMessage, res: ServerResponse, host: RunnerConnectHost): Promise<void> {
  const body: Record<string, unknown> = await readLoginJson(req);
  try {
    const name = validateText(body.name, MAX.runnerName, "computer name", { required: true, singleLine: true });
    const user: SharedUser = await host.accounts.verifyCredentials({ username: body.username, password: body.password, ...host.transport });
    if (!Object.values(user.roles).some((role) => roleAtLeast(role, "contributor"))) throw new CollabError("Ask the team server's owner for a contributor role before connecting a computer", 403);
    const { runner, token } = await host.store.registerRunner(user.id, name, host.transport.address);
    send(res, 201, { runner, token, user: { userId: user.id, username: user.username, displayName: user.displayName }, hub: { name: host.ownerName ?? host.store.ownerName } });
  } catch (error) { if (error instanceof CollabError || error instanceof SharedAccountError) return send(res, error.status, { error: error.message }); throw error; }
}
