import { TEAM_JOIN_SETTINGS } from "./settings-location.js";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, open, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import type { SharedRole } from "../shared-accounts.js";
import { CollabError, MAX, SHA256_HEX } from "./model.js";
import type { Attempt, AttemptProgress, Board, Checkpoint, CheckpointInput, CollabActor, InboxItem, Instruction, RunnerPublic, Task, Who } from "./model.js";
import { RUNNER_LOCAL, ownerActor } from "./store.js";
import type { BundleInfo, ClaimInput, CollabStore, FinishInput, HandoffInput } from "./store.js";

/**
 * What the linked runner needs from a hub, whichever side of the network it is on: the hub owner's own
 * process calls the store directly (LocalHub), a teammate's computer speaks HTTP with its runner credential
 * (RemoteHub). The runner never learns which one it has, so one execution path serves both modes.
 */
export interface HubMe { me: Who & { roles: Record<string, SharedRole> }; runners: RunnerPublic[]; linked?: boolean }
/** The body of `POST /api/team/attempts/:aid/progress`: a whole progress snapshot plus its order number and the run it comes from. */
export interface ProgressReportBody extends AttemptProgress { seq: number; runId?: string }
export type HandoffAction = "accept" | "decline" | "cancel";
export interface HubClient {
  /** `"local"` for the hub owner's process, otherwise the runner id the credential was issued to; attempts are claimed under it. */
  readonly runnerId: string;
  readonly runnerName: string;
  /** The hub's address when it is remote; local attempt records keep it so a later link to another hub is visible. */
  readonly url?: string;
  me(): Promise<HubMe>;
  board(projectId?: string): Promise<Board>;
  task(id: string): Promise<Task>;
  inbox(after?: number): Promise<{ items: InboxItem[]; unread: number }>;
  claimAttempt(taskId: string, input: ClaimInput): Promise<Task>;
  progress(attemptId: string, report: ProgressReportBody): Promise<{ attempt: Attempt }>;
  /** Also returns the approved instructions nobody delivered yet, so the runner can hand them to the agent. */
  heartbeat(attemptId: string): Promise<{ attempt: Attempt; instructions: Instruction[] }>;
  finish(attemptId: string, input: FinishInput): Promise<{ attempt: Attempt }>;
  addCheckpoint(attemptId: string, input: CheckpointInput): Promise<Checkpoint>;
  uploadBundle(checkpointId: string, file: string, info: BundleInfo): Promise<Checkpoint>;
  /** Writes the bundle to `toFile` (which must not exist) and returns the checkpoint manifest it belongs to. */
  downloadBundle(checkpointId: string, toFile: string): Promise<Checkpoint>;
  markInstructionDelivered(taskId: string, instructionId: string, attemptId: string): Promise<Task>;
  offerHandoff(taskId: string, input: HandoffInput, revision: number): Promise<Task>;
  respondHandoff(taskId: string, handoffId: string, action: HandoffAction, revision: number): Promise<Task>;
}

/** The transport a RemoteHub speaks through: TeamLink implements it, adding the bearer so the token never leaves the link. */
export interface HubRequestInit { method?: string; headers?: Record<string, string>; json?: unknown; body?: BodyInit | null; timeoutMs?: number; signal?: AbortSignal; duplex?: "half" }
export interface HubTransport {
  readonly url: string;
  readonly runnerId: string;
  readonly runnerName: string;
  /** A JSON round trip: non-2xx answers become CollabError(hub message, status). */
  json<T>(path: string, init?: HubRequestInit): Promise<T>;
  /** A raw round trip for bundle bytes and event streams; the caller reads the status itself. */
  request(path: string, init?: HubRequestInit): Promise<Response>;
}

const enc = encodeURIComponent;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Bundle transfers get ten minutes instead of the usual 30 s: 64 MiB over a slow Tailscale link is legitimate, a stalled JSON call is not. */
const BUNDLE_TIMEOUT_MS = 10 * 60_000;

/** The hub owner's process: direct store calls under the owner principal (or, for tests and future in-process members, any actor with the runner id its credential names). */
export class LocalHub implements HubClient {
  readonly runnerId: string; readonly runnerName: string;
  private readonly actorOf: () => CollabActor;
  constructor(private readonly store: CollabStore, actor?: CollabActor | (() => CollabActor), options: { runnerId?: string; runnerName?: string } = {}) {
    this.actorOf = typeof actor === "function" ? actor : actor ? () => actor : () => ownerActor(store.ownerName);
    this.runnerId = options.runnerId ?? RUNNER_LOCAL; this.runnerName = options.runnerName ?? (hostname() || "this computer").slice(0, MAX.runnerName);
  }
  private get actor(): CollabActor { return this.actorOf(); }
  async me(): Promise<HubMe> { const board = await this.store.board(this.actor); const { runners, ...me } = board.me; return { me, runners, linked: false }; }
  board(projectId?: string): Promise<Board> { return this.store.board(this.actor, projectId); }
  task(id: string): Promise<Task> { return this.store.task(this.actor, id); }
  inbox(after?: number): Promise<{ items: InboxItem[]; unread: number }> { return this.store.inbox(this.actor, after); }
  claimAttempt(taskId: string, input: ClaimInput): Promise<Task> { return this.store.claimAttempt(this.actor, taskId, input); }
  progress(attemptId: string, report: ProgressReportBody): Promise<{ attempt: Attempt }> { return this.store.attemptProgress(this.actor, attemptId, report); }
  heartbeat(attemptId: string): Promise<{ attempt: Attempt; instructions: Instruction[] }> { return this.store.heartbeat(this.actor, attemptId); }
  finish(attemptId: string, input: FinishInput): Promise<{ attempt: Attempt }> { return this.store.finishAttempt(this.actor, attemptId, input); }
  addCheckpoint(attemptId: string, input: CheckpointInput): Promise<Checkpoint> { return this.store.addCheckpoint(this.actor, attemptId, input); }
  uploadBundle(checkpointId: string, file: string, info: BundleInfo): Promise<Checkpoint> { return this.store.storeBundle(this.actor, checkpointId, createReadStream(file), info); }
  async downloadBundle(checkpointId: string, toFile: string): Promise<Checkpoint> {
    const { path, checkpoint } = await this.store.bundlePath(this.actor, checkpointId);
    try { await copyFile(path, toFile, constants.COPYFILE_EXCL); } catch (error) { throw new CollabError(`The checkpoint bundle could not be copied to ${toFile}: ${error instanceof Error ? error.message : String(error)}`, 500); }
    return checkpoint;
  }
  markInstructionDelivered(taskId: string, instructionId: string, attemptId: string): Promise<Task> { return this.store.markInstructionDelivered(this.actor, taskId, instructionId, attemptId); }
  offerHandoff(taskId: string, input: HandoffInput, revision: number): Promise<Task> { return this.store.offerHandoff(this.actor, taskId, input, revision); }
  respondHandoff(taskId: string, handoffId: string, action: HandoffAction, revision: number): Promise<Task> { return this.store.respondHandoff(this.actor, taskId, handoffId, action, revision); }
}

/** A teammate's computer talking to the hub over HTTPS with its runner credential; paths follow the team API table (spec §6). */
export class RemoteHub implements HubClient {
  constructor(private readonly link: HubTransport) {}
  get runnerId() { return this.link.runnerId; }
  get runnerName() { return this.link.runnerName; }
  get url() { return this.link.url; }
  me(): Promise<HubMe> { return this.link.json<HubMe>("/api/team/me"); }
  board(projectId?: string): Promise<Board> { return this.link.json<Board>(`/api/team/board${projectId ? `?project=${enc(projectId)}` : ""}`); }
  task(id: string): Promise<Task> { return this.link.json<Task>(`/api/team/tasks/${enc(id)}`); }
  inbox(after?: number): Promise<{ items: InboxItem[]; unread: number }> { return this.link.json(`/api/team/inbox${after === undefined ? "" : `?after=${enc(String(after))}`}`); }
  claimAttempt(taskId: string, input: ClaimInput): Promise<Task> { return this.link.json<Task>(`/api/team/tasks/${enc(taskId)}/attempts`, { method: "POST", json: input }); }
  progress(attemptId: string, report: ProgressReportBody): Promise<{ attempt: Attempt }> { return this.link.json(`/api/team/attempts/${enc(attemptId)}/progress`, { method: "POST", json: report }); }
  heartbeat(attemptId: string): Promise<{ attempt: Attempt; instructions: Instruction[] }> { return this.link.json(`/api/team/attempts/${enc(attemptId)}/heartbeat`, { method: "POST", json: {} }); }
  finish(attemptId: string, input: FinishInput): Promise<{ attempt: Attempt }> { return this.link.json(`/api/team/attempts/${enc(attemptId)}/finish`, { method: "POST", json: input }); }
  addCheckpoint(attemptId: string, input: CheckpointInput): Promise<Checkpoint> { return this.link.json<Checkpoint>(`/api/team/attempts/${enc(attemptId)}/checkpoints`, { method: "POST", json: input }); }
  /** The bytes travel as one `application/octet-stream` body with an exact `content-length` and the digest the hub verifies while it streams to disk. */
  async uploadBundle(checkpointId: string, file: string, info: BundleInfo): Promise<Checkpoint> {
    if (!object(info) || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX.bundle || typeof info.sha256 !== "string" || !SHA256_HEX.test(info.sha256)) throw new CollabError("Upload a bundle of 1 byte to 64 MiB with its sha256 digest", 400);
    const stat = await lstat(file).catch(() => undefined); if (!stat?.isFile() || stat.size !== info.size) throw new CollabError(`The bundle file ${file} is missing or its size differs from the manifest; create the checkpoint again`, 400);
    const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
    const result = await this.link.json<{ checkpoint: Checkpoint } | Checkpoint>(`/api/team/checkpoints/${enc(checkpointId)}/bundle`, { method: "PUT", body, duplex: "half", headers: { "content-type": "application/octet-stream", "content-length": String(info.size), "x-codeflow-sha256": info.sha256 }, timeoutMs: BUNDLE_TIMEOUT_MS });
    return "checkpoint" in result && object(result.checkpoint) ? result.checkpoint : result as Checkpoint;
  }
  /** The manifest comes first so the bytes can be checked against what the hub promised; a short or tampered download never reaches the importer. */
  async downloadBundle(checkpointId: string, toFile: string): Promise<Checkpoint> {
    const manifest = await this.link.json<Checkpoint>(`/api/team/checkpoints/${enc(checkpointId)}`);
    if (manifest.bundle !== "available") throw new CollabError("Checkpoint bundle is not available", 404);
    const response = await this.link.request(`/api/team/checkpoints/${enc(checkpointId)}/bundle`, { headers: { accept: "application/octet-stream" }, timeoutMs: BUNDLE_TIMEOUT_MS });
    if (!response.ok) { const error = await readError(response); throw new CollabError(error.message, error.status); }
    const declared = Number(response.headers.get("content-length")), digest = (response.headers.get("x-codeflow-sha256") ?? "").toLowerCase();
    if (declared !== manifest.size || digest !== manifest.sha256) { await response.body?.cancel().catch(() => undefined); throw new CollabError("The team server's bundle headers do not match the checkpoint manifest; retry, or delete the checkpoint if it keeps failing", 502); }
    if (!response.body) throw new CollabError("The team server sent an empty bundle; retry", 502);
    const hash = createHash("sha256"); let received = 0; const handle = await open(toFile, "wx", 0o600);
    try {
      for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>)) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Uint8Array; received += bytes.length;
        if (received > manifest.size) throw new CollabError("The team server sent more bundle bytes than the manifest says; retry", 502);
        hash.update(bytes); await handle.write(bytes);
      }
      await handle.sync();
    } catch (error) { await handle.close(); await rm(toFile, { force: true }).catch(() => undefined); throw error instanceof CollabError ? error : new CollabError(`The bundle download failed: ${error instanceof Error ? error.message : String(error)}; retry`, 502); }
    await handle.close();
    if (received !== manifest.size || hash.digest("hex") !== manifest.sha256) { await rm(toFile, { force: true }).catch(() => undefined); throw new CollabError("The downloaded bundle does not match the checkpoint's size or sha256 digest; retry", 502); }
    return manifest;
  }
  markInstructionDelivered(taskId: string, instructionId: string, attemptId: string): Promise<Task> { return this.link.json<Task>(`/api/team/tasks/${enc(taskId)}/instructions/${enc(instructionId)}`, { method: "POST", json: { action: "delivered", attemptId } }); }
  offerHandoff(taskId: string, input: HandoffInput, revision: number): Promise<Task> { return this.link.json<Task>(`/api/team/tasks/${enc(taskId)}/handoff`, { method: "POST", json: { ...input, revision } }); }
  respondHandoff(taskId: string, handoffId: string, action: HandoffAction, revision: number): Promise<Task> { return this.link.json<Task>(`/api/team/tasks/${enc(taskId)}/handoff/${enc(handoffId)}`, { method: "POST", json: { action, revision } }); }
}

/** Reads a response body up to `limit` bytes. The hub's JSON answers are small, so a larger one is an error (502) and the rest is cancelled; `truncate` instead keeps the first `limit` bytes and cancels the rest, for error bodies that are read for their message only. */
export async function readBounded(response: Response, limit: number, options: { truncate?: boolean } = {}): Promise<string> {
  if (!response.body) return "";
  const declared = Number(response.headers.get("content-length") ?? 0); if (declared > limit && !options.truncate) { await response.body.cancel().catch(() => undefined); throw new CollabError(`The team server's answer exceeds ${Math.round(limit / 1024)} KiB`, 502); }
  const chunks: Buffer[] = []; let size = 0;
  // Leaving the loop early destroys the Readable and with it the response stream, so the hub sees the socket close instead of this process buffering the rest.
  for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>)) { const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > limit) { if (!options.truncate) throw new CollabError(`The team server's answer exceeds ${Math.round(limit / 1024)} KiB`, 502); chunks.push(bytes.subarray(0, bytes.length - (size - limit))); break; } chunks.push(bytes); }
  return Buffer.concat(chunks).toString("utf8");
}
/** The hub's `{ error }` envelope as a CollabError, read from at most `limit` bytes of the body (anything larger is not a hub message). A 401 on a credentialed call means the runner credential is gone (revoked, or the hub's store was reset), so the owner's action is appended; `connecting` keeps the hub's own words for a wrong password. */
export async function readError(response: Response, connecting = false, limit = 64 * 1024): Promise<CollabError> {
  let message = "", code: string | undefined; try { const text = await readBounded(response, limit, { truncate: true }); const parsed: unknown = JSON.parse(text); if (object(parsed)) { if (typeof parsed.error === "string") message = parsed.error.slice(0, 2000); if (typeof parsed.code === "string") code = parsed.code.slice(0, 100); } } catch { /* not JSON: use the status */ }
  if (response.status === 401 && !connecting) {
    // Older hubs supplied their own (sometimes obsolete) reconnect suffix. Normalize it once.
    const reason = message.replace(/;\s*(?:connect this computer again|reconnect) in Settings[^;]*/gi, "").trim();
    return new CollabError(`${reason || "The team server no longer accepts this computer's credential"}; connect this computer again in ${TEAM_JOIN_SETTINGS}`, 401, code ?? "runner-credential-invalid");
  }
  return new CollabError(message || `The team server answered HTTP ${response.status}`, response.status >= 400 && response.status <= 599 ? response.status : 502, code);
}
