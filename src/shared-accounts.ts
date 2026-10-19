import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { CODEFLOW_HOME } from "./config.js";

export type SharedRole = "viewer" | "reviewer" | "contributor" | "maintainer";
/** Weakest first: each role may do everything the roles before it may do, so authorization compares rank with roleAtLeast instead of enumerating roles. */
export const SHARED_ROLES: readonly SharedRole[] = ["viewer", "reviewer", "contributor", "maintainer"];
/** A missing or unrecognised role never satisfies a requirement; the owner is not a SharedRole and is granted maintainer rank by callers. */
export function roleAtLeast(role: SharedRole | undefined, needed: SharedRole): boolean { const rank = role === undefined ? -1 : SHARED_ROLES.indexOf(role), floor = SHARED_ROLES.indexOf(needed); return rank >= 0 && floor >= 0 && rank >= floor; }
/** Browser sign-in and runner enrolment prove the same password; only sign-in receives a session. */
export interface SharedCredentials { username: unknown; password: unknown; address: string; secure: boolean; loopback: boolean }
export interface SharedUser { id: string; username: string; displayName: string; enabled: boolean; revision: number; roles: Record<string, SharedRole>; createdAt: number; updatedAt: number }
export interface SharedPrincipal { kind: "shared"; userId: string; username: string; displayName: string; revision: number; roles: Record<string, SharedRole> }
export interface SharedAccountState { revision: number; users: SharedUser[] }
interface Password { algorithm: "scrypt"; N: 131072; r: 8; p: 1; salt: string; hash: string }
interface StoredUser extends SharedUser { password: Password }
interface Session { hash: string; userId: string; revision: number; createdAt: number; lastSeenAt: number; expiresAt: number }
interface State { version: 1; revision: number; users: StoredUser[]; sessions: Session[] }
export class SharedAccountError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const MAX_USERS = 128, MAX_SESSIONS = 1024, SESSION_MS = 12 * 60 * 60_000, IDLE_MS = 30 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every((key) => allowed.includes(key));
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hex = (v: unknown, length: number) => typeof v === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(v);
const userId = (v: unknown): v is string => typeof v === "string" && /^u-[a-f0-9-]{36}$/.test(v);
/** `owner` is the team board's name for the person running the server (`@owner` mentions, the member list), so no account may take it; `reserved: false` lets a file written before this rule still load. */
function username(value: unknown, reserved = true): string { if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(value)) throw new SharedAccountError("Use 3–64 letters, digits, dots, underscores or dashes for the username"); const name = value.toLowerCase(); if (reserved && name === "owner") throw new SharedAccountError("The username owner is reserved for the server owner"); return name; }
function displayName(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new SharedAccountError("Enter a display name of up to 120 characters"); return value.trim(); }
function passwordText(value: unknown, creating = true): string { if (typeof value !== "string" || Buffer.byteLength(value) > 1024 || (creating && [...value].length < 15)) throw new SharedAccountError("Passwords need at least 15 characters and at most 1024 UTF-8 bytes"); return value; }
export function validateSharedRoles(value: unknown): Record<string, SharedRole> {
  if (!object(value) || Object.keys(value).length > 200) throw new SharedAccountError("Project roles must be a map with at most 200 assigned projects");
  const roles: Record<string, SharedRole> = {};
  for (const [id, role] of Object.entries(value)) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !SHARED_ROLES.includes(role as SharedRole)) throw new SharedAccountError("Only project viewer, reviewer, contributor and maintainer roles may be assigned"); roles[id] = role as SharedRole; }
  return roles;
}
let activeDerivations = 0;
async function derive(value: string, salt: string): Promise<Buffer> {
  if (activeDerivations >= 2) throw new SharedAccountError("Sign-in is busy; try again shortly", 429);
  activeDerivations++;
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(value, Buffer.from(salt, "hex"), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result))); }
  finally { activeDerivations--; }
}
async function makePassword(value: unknown): Promise<Password> { const text = passwordText(value); const salt = randomBytes(16).toString("hex"); return { algorithm: "scrypt", N: 131072, r: 8, p: 1, salt, hash: (await derive(text, salt)).toString("hex") }; }
const dummySalt = randomBytes(16).toString("hex"), dummyHash = randomBytes(32);
function publicUser(user: StoredUser): SharedUser { return { id: user.id, username: user.username, displayName: user.displayName, enabled: user.enabled, revision: user.revision, roles: { ...user.roles }, createdAt: user.createdAt, updatedAt: user.updatedAt }; }
function principal(user: StoredUser): SharedPrincipal { return { kind: "shared", userId: user.id, username: user.username, displayName: user.displayName, revision: user.revision, roles: { ...user.roles } }; }
function validateState(raw: unknown): State {
  if (!object(raw) || !keys(raw, ["version", "revision", "users", "sessions"]) || raw.version !== 1 || !integer(raw.revision) || !Array.isArray(raw.users) || raw.users.length > MAX_USERS || !Array.isArray(raw.sessions) || raw.sessions.length > MAX_SESSIONS) throw new Error("Invalid shared account storage");
  for (const u of raw.users) {
    if (!object(u) || !keys(u, ["id", "username", "displayName", "enabled", "revision", "roles", "createdAt", "updatedAt", "password"]) || !userId(u.id) || username(u.username, false) !== u.username || displayName(u.displayName) !== u.displayName || typeof u.enabled !== "boolean" || !integer(u.revision) || u.revision < 1 || !integer(u.createdAt) || !integer(u.updatedAt) || u.updatedAt < u.createdAt || !object(u.password) || !keys(u.password, ["algorithm", "N", "r", "p", "salt", "hash"]) || u.password.algorithm !== "scrypt" || u.password.N !== 131072 || u.password.r !== 8 || u.password.p !== 1 || !hex(u.password.salt, 32) || !hex(u.password.hash, 64)) throw new Error("Invalid shared account record");
    validateSharedRoles(u.roles);
  }
  if (new Set(raw.users.map((u) => u.id)).size !== raw.users.length || new Set(raw.users.map((u) => u.username)).size !== raw.users.length) throw new Error("Duplicate shared account identity");
  for (const s of raw.sessions) if (!object(s) || !keys(s, ["hash", "userId", "revision", "createdAt", "lastSeenAt", "expiresAt"]) || !hex(s.hash, 64) || !userId(s.userId) || !integer(s.revision) || !integer(s.createdAt) || !integer(s.lastSeenAt) || !integer(s.expiresAt) || s.lastSeenAt < s.createdAt || s.expiresAt !== s.createdAt + SESSION_MS || s.lastSeenAt > s.expiresAt || !raw.users.some((u) => u.id === s.userId)) throw new Error("Invalid shared account session");
  if (new Set(raw.sessions.map((s) => s.hash)).size !== raw.sessions.length) throw new Error("Duplicate shared session");
  return raw as unknown as State;
}
interface Bucket { count: number; expires: number }
/** Global denial limits are deliberately bounded; arbitrary attacker addresses cannot grow this map indefinitely. */
class LoginLimiter {
  private buckets = new Map<string, Bucket>();
  check(address: string, name: string, now: number) {
    for (const [key, value] of this.buckets) if (value.expires <= now) this.buckets.delete(key);
    const keys: Array<[string, number]> = [["global", 100], [`ip:${address.slice(0, 128)}`, 20], [`user:${digest(name)}`, 8]];
    if (keys.some(([key, max]) => (this.buckets.get(key)?.count ?? 0) >= max)) throw new SharedAccountError("Too many sign-in attempts; try again later", 429);
    for (const [key] of keys) { const bucket = this.buckets.get(key) ?? { count: 0, expires: now + 15 * 60_000 }; bucket.count++; this.buckets.delete(key); this.buckets.set(key, bucket); }
    while (this.buckets.size > 2048) this.buckets.delete(this.buckets.keys().next().value!);
  }
}
/** Local accounts delegate result review and team-board work only. These identities never authorize execution on this host; contributors run team tasks on their own computers. */
export class SharedAccounts {
  private state: State = { version: 1, revision: 0, users: [], sessions: [] };
  private loaded = false; private loading?: Promise<void>; private readable = true; private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>(); private limiter = new LoginLimiter();
  constructor(private readonly file = join(CODEFLOW_HOME, "shared-accounts.json")) {}
  get available() { return this.loaded && this.readable; }
  get hasUsers() { return this.available && this.state.users.length > 0; }
  load(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Shared account storage is not a bounded regular file"); this.state = validateState(JSON.parse(await handle.readFile("utf8"))); }
        finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.readable = false; throw new SharedAccountError("Shared accounts cannot be read; owner recovery remains available and the account file was left untouched", 503); } }
      finally { this.loaded = true; }
    })();
  }
  snapshot(): SharedAccountState { this.require(); return { revision: this.state.revision, users: this.state.users.map(publicUser) }; }
  onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  create(input: { revision: unknown; username: unknown; displayName: unknown; password: unknown; roles: unknown }): Promise<SharedAccountState> {
    return this.change(async (state) => { this.cas(state, input.revision); if (state.users.length >= MAX_USERS) throw new SharedAccountError("At most 128 shared accounts may be created"); const name = username(input.username), label = displayName(input.displayName), roles = validateSharedRoles(input.roles); if (state.users.some((user) => user.username === name)) throw new SharedAccountError("That username is already in use", 409); const password = await makePassword(input.password); const now = Date.now(); state.users.push({ id: `u-${randomUUID()}`, username: name, displayName: label, enabled: true, revision: 1, roles, password, createdAt: now, updatedAt: now }); });
  }
  update(id: string, input: { revision: unknown; displayName?: unknown; enabled?: unknown; roles?: unknown; password?: unknown }): Promise<SharedAccountState> {
    return this.change(async (state) => { this.cas(state, input.revision); const user = this.find(state, id); if (input.displayName !== undefined) user.displayName = displayName(input.displayName); if (input.enabled !== undefined) { if (typeof input.enabled !== "boolean") throw new SharedAccountError("Enabled must be true or false"); user.enabled = input.enabled; } if (input.roles !== undefined) user.roles = validateSharedRoles(input.roles); if (input.password !== undefined) user.password = await makePassword(input.password); user.revision++; user.updatedAt = Date.now(); state.sessions = state.sessions.filter((session) => session.userId !== id); });
  }
  revokeSessions(id: string, input: { revision: unknown }): Promise<SharedAccountState> { return this.change((state) => { this.cas(state, input.revision); const user = this.find(state, id); user.revision++; user.updatedAt = Date.now(); state.sessions = state.sessions.filter((session) => session.userId !== id); }); }
  /** Runner enrolment (POST /api/team/runners/connect) proves a password exactly like sign-in, with the same transport rule, limiter and constant-time compare, but must not mint a cookie session. */
  async verifyCredentials(input: SharedCredentials): Promise<SharedUser> { return publicUser(await this.verify(input)); }
  async login(input: SharedCredentials) {
    const user = await this.verify(input);
    const token = randomBytes(32).toString("base64url"), now = Date.now(); const revision = user.revision;
    await this.mutate((state) => {
      const current = this.find(state, user.id); if (!current.enabled || current.revision !== revision) throw new SharedAccountError("Account changed during sign-in; try again", 401);
      state.sessions = state.sessions.filter((session) => session.expiresAt > now && session.lastSeenAt + IDLE_MS > now && session.userId !== user.id);
      // Keep the seven latest existing sessions for this account, not an unbounded login history.
      const own = this.state.sessions.filter((session) => session.userId === user.id && session.expiresAt > now && session.lastSeenAt + IDLE_MS > now).sort((a, b) => b.createdAt - a.createdAt).slice(0, 7);
      state.sessions.push(...own, { hash: digest(token), userId: user.id, revision, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_MS });
      state.sessions.sort((a, b) => b.createdAt - a.createdAt); state.sessions = state.sessions.slice(0, MAX_SESSIONS);
    }, false);
    return { token, user: publicUser(user), expiresAt: now + SESSION_MS };
  }
  authenticate(token: string, options: number | { now?: number; touch?: boolean } = Date.now()): SharedPrincipal | undefined {
    const now = typeof options === "number" ? options : options.now ?? Date.now();
    if (!this.available || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return undefined;
    const hash = digest(token); const session = this.state.sessions.find((session) => session.hash === hash);
    if (!session || session.expiresAt <= now || session.lastSeenAt + IDLE_MS <= now) return undefined;
    const user = this.state.users.find((user) => user.id === session.userId);
    if (!user?.enabled || user.revision !== session.revision) return undefined;
    if (typeof options === "number" || options.touch !== false) session.lastSeenAt = Math.max(session.lastSeenAt, now); return principal(user);
  }
  async logout(token: string): Promise<void> { await this.load(); await this.mutate((state) => { state.sessions = state.sessions.filter((session) => session.hash !== digest(token)); }, true); }
  /** The single password check: an unknown account still derives against a dummy salt, so timing never reveals which usernames exist. */
  private async verify(input: SharedCredentials): Promise<StoredUser> {
    await this.load(); this.require();
    if (!input.secure && !input.loopback) throw new SharedAccountError("Shared sign-in requires HTTPS outside this computer", 403);
    const name = typeof input.username === "string" ? input.username.toLowerCase() : "";
    this.limiter.check(input.address, name.slice(0, 128), Date.now());
    const supplied = passwordText(input.password, false), user = this.state.users.find((entry) => entry.username === name);
    const expected = user ? Buffer.from(user.password.hash, "hex") : dummyHash;
    const result = await derive(supplied, user?.password.salt ?? dummySalt);
    if (!timingSafeEqual(result, expected) || !user?.enabled) throw new SharedAccountError("Invalid username or password", 401);
    return user;
  }
  private require() { if (!this.available) throw new SharedAccountError("Shared account storage is unavailable; use the owner recovery link", 503); }
  private find(state: State, id: string) { const user = state.users.find((user) => user.id === id); if (!user) throw new SharedAccountError("Shared account not found", 404); return user; }
  private cas(state: State, revision: unknown) { if (!integer(revision) || revision !== state.revision) throw new SharedAccountError("Accounts changed; reload before saving", 409); }
  private async change(update: (state: State) => void | Promise<void>) { await this.load(); await this.mutate(async (state) => { await update(state); state.revision++; }, true); return this.snapshot(); }
  private mutate(update: (state: State) => void | Promise<void>, notify: boolean): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      this.require(); const next = structuredClone(this.state); await update(next); await this.write(next); this.state = next;
      if (notify) for (const listener of this.listeners) { try { listener(); } catch { /* A failed stream callback cannot undo durable revocation. */ } }
    }); this.writes = write; return write;
  }
  private async write(state: State) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try { const info = await lstat(this.file); if (!info.isFile() || info.isSymbolicLink()) throw new SharedAccountError("Refusing to replace non-regular account storage", 503); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); } await rename(temp, this.file); await chmod(this.file, 0o600); if (process.platform !== "win32") { const dir = await open(dirname(this.file), "r"); try { await dir.sync(); } finally { await dir.close(); } } }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
}
