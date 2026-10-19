import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CODEFLOW_HOME } from "../config.js";
import { repoRoot } from "../git.js";
import { readJson, send } from "../http.js";
import { logError } from "../log.js";
import type { HubRequestInit, HubTransport } from "./hub-client.js";
import { readBounded, readError } from "./hub-client.js";
export { readBounded } from "./hub-client.js";
import { CollabError, MAX, PATH_ID, REPO_KEY, RUNNER_ID, RUNNER_TOKEN, validatePathId, validateRepoKey, validateText } from "./model.js";

/**
 * This computer's link to a team server: the runner credential the hub issued, who it belongs to, and the
 * folders its repository keys map to. `CODEFLOW_HOME/team-link.json` (0600) holds it; the token never leaves
 * this class except as the `authorization` header of the requests it makes on the hub's behalf.
 */
export type LinkConnection = "connected" | "reconnecting" | "offline";
export interface TeamLinkUser { userId: string; username: string; displayName: string }
export interface TeamLinkDefaults { pattern?: string; roles?: Record<string, string[]>; trust?: string }
export type Mappings = Record<string, Record<string, string>>;
export interface TeamLinkState { linked: boolean; url?: string; runnerId?: string; user?: TeamLinkUser; hubName?: string; machineName?: string; mappings: Mappings; defaults?: TeamLinkDefaults; connection: LinkConnection; lastEventAt?: number; lastSync?: number; error?: string }
export interface ConnectInput { url: unknown; username: unknown; password: unknown; name?: unknown }
/** `sseIdleMs` shortens the event stream's idle timeout (60 s) for tests; the hub pings every 15 s, so anything above that keeps a quiet board connected. */
export interface TeamLinkOptions { file?: string; fetch?: typeof fetch; now?: () => number; machineName?: string; sseIdleMs?: number }
/** One server-sent event as the hub sends it: the parsed `data:` JSON object. */
export type HubEvent = Record<string, unknown>;
/** The file also holds mappings while this instance is its own team server, so link fields are optional and `linked` means all of them are present. */
interface LinkDocument { version: 1; url?: string; runnerId?: string; token?: string; user?: TeamLinkUser; hubName?: string; machineName?: string; mappings: Mappings; defaults?: TeamLinkDefaults }
interface SseFrame { data: string; id?: string }

const READ_LIMIT = 1024 * 1024, JSON_LIMIT = 16 * 1024 * 1024, PROXY_BODY_LIMIT = 64 * 1024, DEFAULT_TIMEOUT_MS = 30_000, SSE_IDLE_MS = 60_000, BACKOFF_MIN_MS = 1000, BACKOFF_MAX_MS = 30_000, MAX_MAPPINGS = 500, MAX_PATH = 4096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]), TRUSTS = ["safe", "standard", "trusted", "full"];
const PASSTHROUGH_HEADERS = ["content-type", "content-length", "x-codeflow-sha256", "content-disposition", "cache-control"];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];
const empty = (): LinkDocument => ({ version: 1, mappings: {} });
class InvalidLink extends Error {}
function invalid(what: string): never { throw new InvalidLink(what); }
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const timer = setTimeout(done, ms); function done() { signal.removeEventListener("abort", done); clearTimeout(timer); resolve(); } signal.addEventListener("abort", done, { once: true }); });
/** Passes a stream through and reports every chunk: the idle timer below watches bytes, not frames, because the hub's keep-alive is an SSE comment that sseFrames() never yields. */
async function* tapped(source: AsyncIterable<Uint8Array>, onChunk: () => void): AsyncGenerator<Uint8Array> { for await (const chunk of source) { onChunk(); yield chunk; } }
/** TLS failures undici reports as "fetch failed": the connection worked, the certificate is what this computer does not accept, and the owner needs to hear that rather than "check that it runs". */
const TLS_CODES: Record<string, string> = { DEPTH_ZERO_SELF_SIGNED_CERT: "a self-signed certificate", SELF_SIGNED_CERT_IN_CHAIN: "a self-signed certificate in its chain", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "a certificate signed by an authority this computer does not know", UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "a certificate signed by an authority this computer does not know", CERT_HAS_EXPIRED: "an expired certificate", ERR_TLS_CERT_ALTNAME_INVALID: "a certificate issued for another name" };

/** The hub is reached by its origin: HTTPS anywhere, plain HTTP only on this computer's loopback (tests and a hub on the same machine). */
export function validateHubUrl(value: unknown): string {
  const hint = "Enter the team server's address as https://host[:port] (http:// only for 127.0.0.1 or localhost)";
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new CollabError(hint);
  let url: URL; try { url = new URL(value.trim()); } catch { throw new CollabError(hint); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new CollabError(hint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) throw new CollabError(hint);
  return url.origin;
}
function validateUser(v: unknown): TeamLinkUser {
  if (!object(v) || typeof v.userId !== "string" || !PATH_ID.test(v.userId) || UNSAFE_KEYS.includes(v.userId) || typeof v.username !== "string" || !v.username || v.username.length > 64 || typeof v.displayName !== "string" || !v.displayName || v.displayName.length > MAX.displayName) invalid("link user has an unexpected format");
  return { userId: v.userId, username: v.username, displayName: v.displayName };
}
function validateMappings(v: unknown): Mappings {
  if (!object(v)) invalid("mappings is not an object"); const mappings: Mappings = {}; let count = 0;
  for (const [projectId, repos] of Object.entries(v)) {
    if (!PATH_ID.test(projectId) || UNSAFE_KEYS.includes(projectId) || !object(repos)) invalid(`mapping for project ${projectId.slice(0, 40)} has an unexpected format`); const entry: Record<string, string> = {};
    for (const [key, path] of Object.entries(repos)) { if (!REPO_KEY.test(key) || typeof path !== "string" || !isAbsolute(path) || path.length > MAX_PATH) invalid(`mapping ${key.slice(0, 40)} has an unexpected format`); if (++count > MAX_MAPPINGS) invalid(`more than ${MAX_MAPPINGS} mappings`); entry[key] = path; }
    mappings[projectId] = entry;
  }
  return mappings;
}
function validateDefaults(v: unknown): TeamLinkDefaults | undefined {
  if (v === undefined) return undefined; if (!object(v) || Object.keys(v).some((key) => !["pattern", "roles", "trust"].includes(key))) invalid("defaults has an unexpected format"); const defaults: TeamLinkDefaults = {};
  if (v.pattern !== undefined) { if (typeof v.pattern !== "string" || !/^[a-z0-9-]{1,40}$/.test(v.pattern)) invalid("default pattern"); defaults.pattern = v.pattern; }
  if (v.trust !== undefined) { if (typeof v.trust !== "string" || !TRUSTS.includes(v.trust)) invalid("default trust"); defaults.trust = v.trust; }
  if (v.roles !== undefined) { if (!object(v.roles)) invalid("default roles"); const roles: Record<string, string[]> = {}; for (const [role, list] of Object.entries(v.roles)) { if (!/^[\w-]{1,40}$/.test(role) || !Array.isArray(list) || list.length > 6 || list.some((id) => typeof id !== "string" || id.length > 80)) invalid("default roles"); roles[role] = list as string[]; } defaults.roles = roles; }
  return defaults;
}
function validateDocument(raw: unknown): LinkDocument {
  if (!object(raw)) invalid("not an object"); const extra = Object.keys(raw).find((key) => !["version", "url", "runnerId", "token", "user", "hubName", "machineName", "mappings", "defaults"].includes(key)); if (extra !== undefined) invalid(`unknown field ${JSON.stringify(extra.slice(0, 40))}`);
  if (raw.version !== 1) invalid("version is not 1"); const document: LinkDocument = { version: 1, mappings: validateMappings(raw.mappings ?? {}) }, defaults = validateDefaults(raw.defaults); if (defaults) document.defaults = defaults;
  const link = [raw.url, raw.runnerId, raw.token, raw.user, raw.machineName].filter((value) => value !== undefined).length;
  if (link === 0) return document; if (link !== 5) invalid("the link is incomplete (url, runnerId, token, user and machineName belong together)");
  try { document.url = validateHubUrl(raw.url); } catch { return invalid("url is not a team server address"); }
  if (typeof raw.runnerId !== "string" || !RUNNER_ID.test(raw.runnerId)) invalid("runnerId has an unexpected format"); if (typeof raw.token !== "string" || !RUNNER_TOKEN.test(raw.token)) invalid("token has an unexpected format");
  document.runnerId = raw.runnerId; document.token = raw.token; document.user = validateUser(raw.user);
  if (typeof raw.machineName !== "string" || !raw.machineName.trim() || raw.machineName.length > MAX.runnerName) invalid("machineName has an unexpected format"); document.machineName = raw.machineName;
  if (raw.hubName !== undefined) { if (typeof raw.hubName !== "string" || raw.hubName.length > MAX.displayName) invalid("hubName has an unexpected format"); if (raw.hubName) document.hubName = raw.hubName; }
  return document;
}
async function readDocument(file: string): Promise<unknown> {
  let body: string;
  try { const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const info = await handle.stat(); if (!info.isFile()) throw new Error(`${file} is not a regular file`); if (info.size > READ_LIMIT) throw new InvalidLink("larger than 1 MiB"); body = await handle.readFile("utf8"); } finally { await handle.close(); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return JSON.parse(body); } catch (error) { throw new InvalidLink(`not valid JSON (${(error as Error).message})`); }
}
/** Splits an event stream into frames: `data:` lines joined by newlines, the optional `id:`; comments and unknown fields are skipped. */
export async function* sseFrames(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseFrame> {
  let buffer = "";
  const frame = (block: string): SseFrame | undefined => { const data: string[] = []; let id: string | undefined; for (const line of block.split("\n")) { if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, "")); else if (line.startsWith("id:")) id = line.slice(3).trim(); } if (!data.length) return undefined; const result: SseFrame = { data: data.join("\n") }; if (id !== undefined) result.id = id; return result; };
  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"); if (buffer.length > READ_LIMIT) throw new Error("The event stream sent a frame larger than 1 MiB");
    let at: number; while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) { const block = buffer.slice(0, at).replace(/\r\n/g, "\n"); buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, ""); const parsed = frame(block); if (parsed) yield parsed; }
  }
}

export class TeamLink implements HubTransport {
  readonly file: string;
  private document: LinkDocument = empty(); private loading?: Promise<void>;
  private connection: LinkConnection = "offline"; private connectionError?: string; private lastEventAt?: number; private stopEvents?: () => void;
  private readonly fetchImpl: typeof fetch; private readonly now: () => number; private readonly defaultMachineName: string; private readonly sseIdleMs: number;
  constructor(options: TeamLinkOptions = {}) { this.file = options.file ?? join(CODEFLOW_HOME, "team-link.json"); this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init)); this.now = options.now ?? Date.now; this.defaultMachineName = (options.machineName ?? hostname() ?? "").trim().slice(0, MAX.runnerName) || "this computer"; this.sseIdleMs = options.sseIdleMs && options.sseIdleMs > 0 ? options.sseIdleMs : SSE_IDLE_MS; }
  load(): Promise<void> {
    return this.loading ??= (async () => {
      let raw: unknown;
      try { raw = await readDocument(this.file); } catch (error) { if (error instanceof InvalidLink) { await this.setAside(error.message); return; } logError(`Couldn't read ${this.file}; this computer is treated as not linked until the file can be read`, error); return; }
      if (raw === undefined) return;
      try { this.document = validateDocument(raw); } catch (error) { await this.setAside(error instanceof Error ? error.message : String(error)); }
    })();
  }
  private async setAside(why: string) { const aside = `${this.file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`; try { await rename(this.file, aside); logError(`${this.file} is unusable (${why}): moved it to ${aside}; connect this computer again in Settings → Team`); } catch (error) { logError(`${this.file} is unusable (${why}) and couldn't be moved aside; connect this computer again after fixing it`, error); } this.document = empty(); }
  private async save(): Promise<void> {
    validateDocument(this.document); const body = JSON.stringify(this.document, null, 2);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try { const info = await lstat(this.file); if (!info.isFile()) throw new CollabError(`Refusing to replace ${this.file}: it is not a regular file`, 503); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); } await rename(temp, this.file); await chmod(this.file, 0o600); if (process.platform !== "win32") { const dir = await open(dirname(this.file), "r"); try { await dir.sync(); } finally { await dir.close(); } } }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  get linked(): boolean { return !!(this.document.url && this.document.token && this.document.runnerId && this.document.user && this.document.machineName); }
  /** Everything but the token. */
  get config(): Omit<TeamLinkState, "connection" | "lastEventAt" | "lastSync" | "error"> {
    const d = this.document, config: ReturnType<TeamLink["state"]> = { linked: this.linked, mappings: structuredClone(d.mappings), connection: this.connection };
    if (this.linked) { config.url = d.url; config.runnerId = d.runnerId; config.user = { ...d.user! }; config.machineName = d.machineName; if (d.hubName) config.hubName = d.hubName; } else if (!d.machineName) config.machineName = this.defaultMachineName;
    if (d.defaults) config.defaults = structuredClone(d.defaults);
    const { connection: _connection, ...rest } = config; return rest;
  }
  state(): TeamLinkState { const state: TeamLinkState = { ...this.config, connection: this.linked ? this.connection : "offline" }; if (this.lastEventAt !== undefined) { state.lastEventAt = this.lastEventAt; state.lastSync = this.lastEventAt; } if (this.connectionError && this.linked) state.error = this.connectionError; return state; }
  private requireLink(): Required<Pick<LinkDocument, "url" | "token" | "runnerId" | "user" | "machineName">> { const d = this.document; if (!this.linked) throw new CollabError("This computer is not connected to a team server; connect it in Settings → Team", 409); return { url: d.url!, token: d.token!, runnerId: d.runnerId!, user: d.user!, machineName: d.machineName! }; }
  get url(): string { return this.requireLink().url; }
  get runnerId(): string { return this.requireLink().runnerId; }
  get runnerName(): string { return this.requireLink().machineName; }

  /** Trades the account password for a runner credential once; the password is never stored. */
  async connect(input: ConnectInput): Promise<TeamLinkState> {
    await this.load(); if (this.linked) throw new CollabError(`This computer is already connected to ${this.document.url}; disconnect it first`, 409);
    const url = validateHubUrl(input.url), username = validateText(input.username, 64, "username", { required: true, singleLine: true }), name = validateText(input.name === undefined || input.name === "" ? this.defaultMachineName : input.name, MAX.runnerName, "machine name", { required: true, singleLine: true });
    if (typeof input.password !== "string" || !input.password || input.password.length > 1024) throw new CollabError("Enter the password of your shared account");
    let response: Response; try { response = await this.rawFetch(`${url}/api/team/runners/connect`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ username, password: input.password, name }) }, DEFAULT_TIMEOUT_MS); } catch (error) { throw unreachable(error, url); }
    if (!response.ok) { const error = await readError(response, true); throw new CollabError(error.message, [400, 401, 403, 409, 429, 503].includes(response.status) ? response.status : 502); }
    const body: unknown = await readBounded(response, 64 * 1024).then((text) => JSON.parse(text)).catch(() => undefined);
    if (!object(body) || !object(body.runner) || typeof body.runner.id !== "string" || !RUNNER_ID.test(body.runner.id) || typeof body.token !== "string" || !RUNNER_TOKEN.test(body.token)) throw new CollabError("The team server answered the connect request with an unexpected body; make sure it runs a code-flow with team collaboration", 502);
    let user: TeamLinkUser; try { user = validateUser(body.user); } catch { throw new CollabError("The team server answered the connect request without a usable account; make sure it runs a code-flow with team collaboration", 502); }
    const hubName = object(body.hub) && typeof body.hub.name === "string" && body.hub.name ? body.hub.name.slice(0, MAX.displayName) : undefined;
    const document: LinkDocument = { ...this.document, url, runnerId: body.runner.id, token: body.token, user, machineName: name }; if (hubName) document.hubName = hubName; else delete document.hubName;
    const previous = this.document; this.document = document; try { await this.save(); } catch (error) { this.document = previous; throw error; }
    this.connection = "offline"; this.connectionError = undefined; this.lastEventAt = undefined; return this.state();
  }
  /** Revokes the credential on the hub when it can be reached, and forgets it here either way; mappings stay for the next link or for this instance's own board. */
  async disconnect(): Promise<void> {
    await this.load(); this.stopEvents?.(); const d = this.document;
    if (this.linked) { try { const response = await this.rawFetch(`${d.url}/api/team/runners/${encodeURIComponent(d.runnerId!)}`, { method: "DELETE", headers: { accept: "application/json", authorization: `Bearer ${d.token}` } }, 5000); await response.body?.cancel().catch(() => undefined); } catch (error) { logError("The team server could not be told to revoke this computer's credential; revoke it there in Settings → Team", error); } }
    this.document = { version: 1, mappings: d.mappings }; if (d.defaults) this.document.defaults = d.defaults; this.connection = "offline"; this.connectionError = undefined; this.lastEventAt = undefined;
    await this.save();
  }
  /** Maps a project's repository key to a clone on this computer; an empty path removes the mapping. */
  async setMapping(projectId: unknown, repoKey: unknown, path: unknown): Promise<Mappings> {
    await this.load(); const project = validatePathId(projectId, "project id"), key = validateRepoKey(repoKey);
    if (path === "" || path === null || path === undefined) { const repos = this.document.mappings[project]; if (repos) { delete repos[key]; if (!Object.keys(repos).length) delete this.document.mappings[project]; await this.save(); } return structuredClone(this.document.mappings); }
    if (typeof path !== "string" || !isAbsolute(path) || path.length > MAX_PATH) throw new CollabError("Enter the absolute path of your clone of this repository");
    let root: string; try { root = await realpath(await repoRoot(path)); } catch { throw new CollabError(`${path} is not inside a Git repository; choose a clone of ${key}`); }
    const count = Object.values(this.document.mappings).reduce((sum, repos) => sum + Object.keys(repos).length, 0); if (count >= MAX_MAPPINGS && !this.document.mappings[project]?.[key]) throw new CollabError(`At most ${MAX_MAPPINGS} repositories can be mapped on one computer`);
    const repos = this.document.mappings[project] ?? (this.document.mappings[project] = {}); repos[key] = root; await this.save(); return structuredClone(this.document.mappings);
  }
  resolveRepo(projectId: string, repoKey: string): string | undefined { return Object.hasOwn(this.document.mappings, projectId) ? this.document.mappings[projectId]![repoKey] : undefined; }

  /** Every call goes to the validated hub origin and nowhere else: a redirect is an error (the password and the bearer-authenticated bodies would otherwise be re-sent to whatever address a 307 names, and that address's answers taken for the hub's), like every other credentialed outbound call in code-flow. */
  private async rawFetch(url: string, init: RequestInit & { duplex?: "half" }, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController(), timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new CollabError(`The team server did not answer within ${Math.round(timeoutMs / 1000)} s`, 504)), timeoutMs) : undefined; timer?.unref?.();
    try { return await this.fetchImpl(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal } as RequestInit); } finally { if (timer) clearTimeout(timer); }
  }
  /** Every hub call carries the bearer; JSON bodies are tagged so the hub's `readJson` accepts them. */
  async request(path: string, init: HubRequestInit = {}): Promise<Response> {
    const link = this.requireLink(); const headers: Record<string, string> = { accept: "application/json", ...init.headers, authorization: `Bearer ${link.token}` }; let body = init.body;
    if (init.json !== undefined) { body = JSON.stringify(init.json); headers["content-type"] = "application/json"; }
    try { return await this.rawFetch(`${link.url}${path}`, { method: init.method ?? "GET", headers, body: body ?? null, ...(init.duplex ? { duplex: init.duplex } : {}) }, init.timeoutMs ?? DEFAULT_TIMEOUT_MS, init.signal); } catch (error) { throw unreachable(error, link.url); }
  }
  async json<T>(path: string, init: HubRequestInit = {}): Promise<T> {
    const response = await this.request(path, init); if (!response.ok) throw await readError(response);
    if (response.status === 204) return undefined as T;
    // The request timeout ended with the headers; the body gets the same budget so a stalled answer cannot hold a runner operation open for good.
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS, timer = timeoutMs > 0 ? setTimeout(() => void response.body?.cancel(new CollabError(`The team server did not finish its answer within ${Math.round(timeoutMs / 1000)} s`, 504)).catch(() => undefined), timeoutMs) : undefined; timer?.unref?.();
    let text: string; try { text = await readBounded(response, JSON_LIMIT); } catch (error) { throw unreachable(error, this.document.url ?? ""); } finally { if (timer) clearTimeout(timer); }
    if (!text.trim()) return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new CollabError("The team server answered with something other than JSON", 502); }
  }

  /** Follows the hub's `/api/team/events` stream, reconnecting with 1→30 s backoff; the cursor `<epoch>:<seq>` resumes where the last frame left off. */
  events(onEvent: (event: HubEvent) => void, onState?: (connection: LinkConnection, error?: string) => void): () => void {
    this.stopEvents?.(); const controller = new AbortController(); let stopped = false, delay = BACKOFF_MIN_MS, cursor: string | undefined, epoch: string | undefined;
    const setState = (connection: LinkConnection, error?: string) => { if (stopped && connection !== "offline") return; this.connection = connection; this.connectionError = error; try { onState?.(connection, error); } catch { /* a listener's failure must not stop the stream */ } };
    const loop = async () => {
      while (!stopped && this.linked) {
        try {
          const response = await this.request(`/api/team/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, { headers: { accept: "text/event-stream" }, signal: controller.signal });
          if (response.status === 401 || response.status === 403) { const error = await readError(response); setState("offline", error.message); delay = BACKOFF_MAX_MS; }
          else if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); setState("reconnecting", `The team server answered HTTP ${response.status} for its event stream`); }
          else {
            delay = BACKOFF_MIN_MS; setState("connected"); const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
            // Any bytes count as life, the hub's comment pings included; `lastEventAt` still moves only with data frames.
            const arm = () => { const timer = setTimeout(() => source.destroy(new Error(`no event or ping for ${Math.round(this.sseIdleMs / 1000)} s`)), this.sseIdleMs); timer.unref?.(); return timer; };
            let idle = arm(); const abort = () => source.destroy(); controller.signal.addEventListener("abort", abort, { once: true });
            try {
              for await (const frame of sseFrames(tapped(source, () => { clearTimeout(idle); idle = arm(); }))) {
                this.lastEventAt = this.now();
                let event: unknown; try { event = JSON.parse(frame.data); } catch { continue; } if (!object(event)) continue;
                if (event.type === "hello" && typeof event.epoch === "string") epoch = event.epoch; if (event.type === "resync") { cursor = undefined; epoch = undefined; }
                if (typeof event.seq === "number" && Number.isSafeInteger(event.seq) && epoch) cursor = `${epoch}:${event.seq}`; else if (frame.id && /^[a-f0-9]{1,32}:\d{1,15}$/.test(frame.id)) cursor = frame.id;
                try { onEvent(event); } catch (error) { logError("A team event listener failed", error); }
              }
              if (!stopped) setState("reconnecting", "The team server closed its event stream");
            } finally { clearTimeout(idle); controller.signal.removeEventListener("abort", abort); }
          }
        } catch (error) { if (!stopped) setState("reconnecting", error instanceof CollabError ? error.message : `The team server's event stream ended unexpectedly (${error instanceof Error ? error.message : String(error)}); reconnecting`); }
        if (stopped) break; await sleep(delay, controller.signal); delay = Math.min(BACKOFF_MAX_MS, delay * 2);
      }
      if (!stopped) { stopped = true; setState("offline", this.linked ? this.connectionError : undefined); }
    };
    const stop = () => { if (stopped) return; stopped = true; controller.abort(); if (this.stopEvents === stop) this.stopEvents = undefined; setState("offline"); };
    this.stopEvents = stop; void loop(); return stop;
  }
  close(): void { this.stopEvents?.(); }

  /** Forwards an owner UI request to the hub under the runner credential: same method, path and query; a JSON body is re-read and re-sent, cookies never travel, and the hub's answer comes back with its status. */
  async proxy(req: IncomingMessage, res: ServerResponse, parts: readonly string[], url: URL): Promise<void> {
    const link = this.requireLink(), method = (req.method ?? "GET").toUpperCase(), path = `/${parts.map((part) => encodeURIComponent(part)).join("/")}${url.search}`;
    const headers: Record<string, string> = { accept: typeof req.headers.accept === "string" && req.headers.accept ? req.headers.accept.slice(0, 200) : "application/json" }; let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const type = req.headers["content-type"] ?? "", length = Number(req.headers["content-length"] ?? 0);
      if (type.startsWith("application/json")) { body = JSON.stringify(await readJson(req, PROXY_BODY_LIMIT, { timeoutMs: 10_000 })); headers["content-type"] = "application/json"; }
      else if (length > 0 || req.headers["transfer-encoding"]) return send(res, 415, { error: "Team requests are forwarded as JSON only; upload checkpoint bundles from the computer that runs the task" });
    }
    let upstream: Response;
    try { upstream = await this.rawFetch(`${link.url}${path}`, { method, headers: { ...headers, authorization: `Bearer ${link.token}` }, body: body ?? null }, DEFAULT_TIMEOUT_MS); }
    catch (error) { const reason = unreachable(error, link.url); return send(res, 502, { error: `The team server is unreachable at ${link.url}; check the connection and try again (${reason.message})` }); }
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.body || type.startsWith("application/json") || upstream.status === 204 || upstream.status >= 400 && !type.startsWith("text/event-stream")) {
      let text: string; try { text = upstream.body ? await readBounded(upstream, JSON_LIMIT) : ""; } catch (error) { return send(res, 502, { error: `The team server's answer could not be read: ${error instanceof Error ? error.message : String(error)}` }); }
      if (type.startsWith("application/json") || upstream.status === 204 || !text) { res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(text || "{}"); return; }
      return send(res, upstream.status >= 400 ? upstream.status : 502, { error: `The team server answered with ${type.split(";")[0] || "an unexpected content type"}` });
    }
    const passthrough: Record<string, string> = { "cache-control": "no-store" }; for (const name of PASSTHROUGH_HEADERS) { const value = upstream.headers.get(name); if (value) passthrough[name] = value; }
    res.writeHead(upstream.status, passthrough);
    const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>); res.once("close", () => source.destroy());
    try { await pipeline(source, res); } catch (error) { if (!res.destroyed) res.destroy(); logError("A proxied team response ended early", error); }
  }
}

/** A failed connection in the owner's words, with the status the link API answers (504 for our own timeout, 502 for everything else): a redirect and an untrusted certificate each get their own sentence, since neither is fixed by checking that the server runs. */
export function unreachable(error: unknown, url: string): CollabError {
  if (error instanceof CollabError) return error;
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error instanceof Error ? error : undefined, code = cause ? (cause as NodeJS.ErrnoException).code : undefined, detail = cause ? `${code ?? cause.name}: ${cause.message}` : String(error);
  if (error instanceof Error && error.name === "AbortError") return new CollabError(`The team server at ${url} did not answer in time`, 504);
  if (cause?.message === "unexpected redirect") return new CollabError(`The team server at ${url} redirected the request; code-flow talks only to the address you entered, so enter the address the server itself answers at`, 502);
  if (code !== undefined && Object.hasOwn(TLS_CODES, code)) return new CollabError(`This computer does not trust the team server's certificate at ${url} (${TLS_CODES[code]}, ${code}): give the server a Tailscale HTTPS certificate for its tailnet name, or trust its certificate here with NODE_EXTRA_CA_CERTS`, 502);
  return new CollabError(`The team server at ${url} is unreachable (${detail.slice(0, 300)}); check that it runs and that this computer can reach it`, 502);
}
