import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { isAbsolute, join, relative, sep } from "node:path";
import { DevServers, freePort } from "./serve.js";

export interface LaunchService { id: string; name?: string; command: string; cwd: string; dependsOn: string[]; health: false | { path: string; timeoutMs: number }; env: Record<string, string> }
export interface LaunchProfile { id: string; name: string; services: LaunchService[] }
export interface LaunchServiceState { id: string; name: string; command: string; cwd: string; port: number; url: string; status: "pending" | "starting" | "healthy" | "running" | "exited" | "stopped"; healthChecked: boolean; logs: string[]; exitCode?: number | null }
export interface LaunchSession { key: string; profile: string; root: string; status: "starting" | "ready" | "failed" | "stopped"; startedAt: number; readyAt?: number; services: LaunchServiceState[]; error?: string }
export class LaunchProfileError extends Error { constructor(message: string, readonly status = 400, readonly confirm?: "allowUntrusted") { super(message); } }
const identifier = /^[a-z][a-z0-9-]{0,39}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max && !value.includes("\0");
const envPrefix = (id: string) => id.replace(/-/g, "_").toUpperCase();

function directoryAllowed(path: unknown): path is string {
  return path === "." || (typeof path === "string" && path.length <= 500 && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !/[\\\x00-\x1f]/.test(path) && !path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"));
}
export function validateLaunchProfiles(value: unknown): LaunchProfile[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 12 || Object.keys(value).some((key) => !["version", "profiles"].includes(key))) throw new LaunchProfileError("Expected version 1 launch configuration with at most 12 profiles.");
  const profiles = value.profiles.map((raw): LaunchProfile => {
    if (!object(raw) || typeof raw.id !== "string" || !identifier.test(raw.id) || !text(raw.name, 120) || !Array.isArray(raw.services) || raw.services.length < 1 || raw.services.length > 6 || Object.keys(raw).some((key) => !["id", "name", "services"].includes(key))) throw new LaunchProfileError("Each named launch profile needs a valid ID and 1–6 services.");
    const services = raw.services.map((entry): LaunchService => {
      if (!object(entry) || typeof entry.id !== "string" || !identifier.test(entry.id) || !text(entry.command, 4000) || (entry.name !== undefined && !text(entry.name, 120)) || !directoryAllowed(entry.cwd ?? ".") || Object.keys(entry).some((key) => !["id", "name", "command", "cwd", "dependsOn", "health", "env"].includes(key))) throw new LaunchProfileError("Services need a valid ID, bounded command and a safe relative working directory.");
      const dependsOn = entry.dependsOn ?? [];
      if (!Array.isArray(dependsOn) || dependsOn.length > 5 || dependsOn.some((id) => typeof id !== "string" || !identifier.test(id)) || new Set(dependsOn).size !== dependsOn.length) throw new LaunchProfileError(`${entry.id} has invalid dependencies.`);
      let health: LaunchService["health"] = { path: "/", timeoutMs: 15000 };
      if (entry.health === false) health = false;
      else if (entry.health !== undefined) {
        if (!object(entry.health) || !text(entry.health.path, 500) || !entry.health.path.startsWith("/") || entry.health.path.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(entry.health.path) || Object.keys(entry.health).some((key) => !["path", "timeoutMs"].includes(key))) throw new LaunchProfileError(`${entry.id} needs a local HTTP health path.`);
        const timeoutMs = entry.health.timeoutMs ?? 15000;
        if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new LaunchProfileError("Health timeout must be between 100 and 120,000 ms.");
        health = { path: entry.health.path, timeoutMs };
      }
      if (entry.env !== undefined && !object(entry.env)) throw new LaunchProfileError("Service environment must be an object.");
      const env: Record<string, string> = {};
      for (const [key, val] of Object.entries(entry.env ?? {})) {
        if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(key) || key.startsWith("CODEFLOW_") || ["PORT", "HOST", "SERVICE_NAME"].includes(key) || typeof val !== "string" || val.length > 4000 || val.includes("\0")) throw new LaunchProfileError(`Invalid or reserved service environment variable: ${key}`);
        env[key] = val;
      }
      if (Object.keys(env).length > 40) throw new LaunchProfileError("Service environment is limited to 40 entries.");
      return { id: entry.id, ...(entry.name ? { name: entry.name as string } : {}), command: entry.command, cwd: (entry.cwd ?? ".") as string, dependsOn: [...dependsOn], health, env };
    });
    if (new Set(services.map((service) => service.id)).size !== services.length) throw new LaunchProfileError("Service IDs must be unique within a profile.");
    const ordered = new Set<string>();
    while (ordered.size < services.length) {
      const ready = services.find((service) => !ordered.has(service.id) && service.dependsOn.every((id) => ordered.has(id)));
      if (!ready) throw new LaunchProfileError("Service dependencies must name existing services and form an acyclic graph.");
      ordered.add(ready.id);
    }
    const reserved = new Set(services.flatMap((service) => [`${envPrefix(service.id)}_URL`, `${envPrefix(service.id)}_PORT`]));
    if (services.some((service) => Object.keys(service.env).some((key) => reserved.has(key)))) throw new LaunchProfileError("Generated peer URL and port variables cannot be overridden.");
    const generated = new Set([...reserved, "PORT", "HOST", "SERVICE_NAME"]);
    for (const service of services) for (const value of Object.values(service.env)) for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) if (!generated.has(match[1]!)) throw new LaunchProfileError(`Unknown generated environment variable: ${match[1]}`);
    return { id: raw.id, name: raw.name, services };
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new LaunchProfileError("Launch profile IDs must be unique.");
  return profiles;
}

/** Walk every ancestor without following repository symlinks. */
export async function launchDirectory(root: string, path: string): Promise<string> {
  if (!directoryAllowed(path)) throw new LaunchProfileError("Choose a safe relative service working directory.");
  if (!(await lstat(root)).isDirectory()) throw new LaunchProfileError("Launch root must be a regular worktree directory.");
  const canonical = await realpath(root);
  let current = canonical;
  for (const part of path === "." ? [] : path.split("/")) {
    current = join(current, part);
    if (!(await lstat(current)).isDirectory()) throw new LaunchProfileError(`Service directory is missing or uses a symbolic link: ${path}`);
  }
  const resolved = await realpath(current); const rel = relative(canonical, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new LaunchProfileError("Service working directory escapes the worktree.");
  return resolved;
}
export async function readLaunchProfiles(root: string): Promise<{ profiles: LaunchProfile[]; found: boolean; error?: string }> {
  try {
    const directory = await launchDirectory(root, ".codeflow");
    const handle = await open(join(directory, "launch.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 128 * 1024) throw new LaunchProfileError("Launch configuration must be a regular file under 128 KiB.");
      return { profiles: validateLaunchProfiles(JSON.parse(await handle.readFile("utf8"))), found: true };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: [], found: false };
    return { profiles: [], found: true, error: (error as Error).message };
  }
}

function healthProbe(port: number, path: string, signal: AbortSignal, budgetMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted); resolve(ok); };
    const request = httpGet({ hostname: "127.0.0.1", port, path, timeout: 1000, agent: false }, (response) => { const ok = (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300; response.destroy(); done(ok); });
    const aborted = () => { request.destroy(); done(false); };
    // An absolute deadline also bounds a peer that dribbles headers and resets socket timeouts.
    const timer = setTimeout(aborted, Math.max(1, Math.min(1000, budgetMs)));
    signal.addEventListener("abort", aborted, { once: true });
    request.on("timeout", () => { request.destroy(); done(false); });
    request.on("error", () => done(false));
  });
}
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true }); });
interface ActiveLaunch { session: LaunchSession; controller: AbortController; serviceKeys: string[]; inFlight: boolean; monitor?: ReturnType<typeof setInterval> }

/** Explicitly started stacks share DevServers process-group tracking and run cancellation. */
export class LaunchProfiles {
  private readonly sessions = new Map<string, ActiveLaunch>();
  constructor(private readonly servers: DevServers) {}
  get(key: string): LaunchSession | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    this.refresh(entry);
    return structuredClone(entry.session);
  }
  private refresh(entry: ActiveLaunch) {
    for (const service of entry.session.services) {
      const live = this.servers.get(`${entry.session.key}/${service.id}`);
      if (live) { service.logs = live.logs.slice(-100).map((line) => line.slice(-2000)); service.exitCode = live.exitCode; if (live.status === "exited") service.status = "exited"; }
      else if (entry.session.status === "ready") service.status = "exited";
    }
    if (entry.session.status === "ready" && entry.session.services.some((service) => service.status === "exited")) {
      const failed = entry.session.services.find((service) => service.status === "exited")!;
      entry.session.status = "failed"; entry.session.error = `Service ${failed.name} exited; the stack was stopped.`;
      this.cleanup(entry);
    }
  }
  private cleanup(entry: ActiveLaunch) {
    if (entry.monitor) clearInterval(entry.monitor);
    for (const service of entry.session.services) { const live = this.servers.get(`${entry.session.key}/${service.id}`); if (live) { service.logs = live.logs.slice(-100).map((line) => line.slice(-2000)); service.exitCode = live.exitCode; if (live.status === "exited") service.status = "exited"; } if (service.status !== "exited") service.status = "stopped"; }
    for (const key of [...entry.serviceKeys].reverse()) this.servers.stop(key);
  }
  stop(key: string): boolean {
    const entry = this.sessions.get(key);
    if (!entry) return false;
    this.refresh(entry); entry.controller.abort(); entry.session.status = "stopped";
    for (const service of entry.session.services) if (service.status !== "exited") service.status = "stopped";
    this.cleanup(entry); return true;
  }
  stopAll() { for (const key of this.sessions.keys()) this.stop(key); }
  stopMatching(prefix: string) { for (const key of this.sessions.keys()) if (key.startsWith(prefix)) this.stop(key); }

  async start(key: string, root: string, rawProfile: LaunchProfile, options: { signal?: AbortSignal; lockdown?: string; allowUntrusted?: boolean } = {}): Promise<LaunchSession> {
    if (options.lockdown && !options.allowUntrusted) throw new LaunchProfileError(`${options.lockdown}. Starting this profile executes repository commands on this machine.`, 409, "allowUntrusted");
    const profile = validateLaunchProfiles({ version: 1, profiles: [rawProfile] })[0]!;
    const previous = this.sessions.get(key);
    if (previous && (previous.inFlight || ["starting", "ready"].includes(previous.session.status))) throw new LaunchProfileError("This launch profile is already active or still stopping. Wait for it to stop before starting another.", 409);
    if (this.sessions.size >= 50) for (const [oldKey, entry] of this.sessions) { if (["stopped", "failed"].includes(entry.session.status)) { this.sessions.delete(oldKey); if (this.sessions.size < 50) break; } }
    if (!previous && this.sessions.size >= 50) throw new LaunchProfileError("Too many active launch profiles. Stop a stack before starting another.", 409);
    const entry: ActiveLaunch = { session: { key, root, profile: profile.id, status: "starting", startedAt: Date.now(), services: [] }, controller: new AbortController(), serviceKeys: [], inFlight: true };
    this.sessions.set(key, entry);
    const aborted = () => entry.controller.abort(); options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) entry.controller.abort();
    const active = () => { if (entry.controller.signal.aborted) throw new LaunchProfileError("Launch startup was cancelled.", 409); };
    const childrenActive = () => { active(); this.refresh(entry); for (const serviceKey of entry.serviceKeys) if (this.servers.get(serviceKey)?.status !== "running") throw new LaunchProfileError(`Service ${serviceKey.split("/").at(-1)} exited or was stopped during startup.`, 422); };
    try {
      const ports = new Set<number>(); const generated: Record<string, string> = {};
      for (const service of profile.services) {
        active(); const cwd = await launchDirectory(root, service.cwd);
        let port = await freePort(); for (let retry = 0; ports.has(port) && retry < 20; retry++) port = await freePort();
        if (ports.has(port)) throw new LaunchProfileError("Could not allocate distinct service ports.", 409);
        ports.add(port); const url = `http://127.0.0.1:${port}`;
        generated[`${envPrefix(service.id)}_URL`] = url; generated[`${envPrefix(service.id)}_PORT`] = String(port);
        entry.session.services.push({ id: service.id, name: service.name ?? service.id, command: service.command, cwd, port, url, status: "pending", healthChecked: false, logs: [] });
      }
      const ready = new Set<string>();
      const deadline = Date.now() + 180000;
      while (ready.size < profile.services.length) {
        childrenActive();
        if (Date.now() >= deadline) throw new LaunchProfileError("The launch profile exceeded its startup deadline.", 422);
        const service = profile.services.find((service) => !ready.has(service.id) && service.dependsOn.every((id) => ready.has(id)))!;
        const snapshot = entry.session.services.find((item) => item.id === service.id)!;
        const serviceKey = `${key}/${service.id}`;
        if (await launchDirectory(root, service.cwd) !== snapshot.cwd) throw new LaunchProfileError("A service directory changed during startup.", 409);
        childrenActive();
        const allocated: Record<string, string> = { ...generated, PORT: String(snapshot.port), HOST: "127.0.0.1", SERVICE_NAME: service.id };
        const env = { ...allocated };
        for (const [name, value] of Object.entries(service.env)) env[name] = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, id: string) => { if (allocated[id] === undefined) throw new LaunchProfileError(`Unknown generated environment variable: ${id}`); return allocated[id]!; });
        snapshot.status = "starting"; entry.serviceKeys.push(serviceKey);
        await this.servers.start(serviceKey, snapshot.cwd, service.command, snapshot.port, env, entry.controller.signal);
        if (service.health !== false) {
          const expires = Math.min(deadline, Date.now() + service.health.timeoutMs);
          let healthy = false;
          while (Date.now() < expires) {
            childrenActive();
            if (await healthProbe(snapshot.port, service.health.path, entry.controller.signal, expires - Date.now())) { healthy = true; break; }
            await delay(Math.min(100, Math.max(0, expires - Date.now())), entry.controller.signal);
          }
          if (!healthy) throw new LaunchProfileError(`Service ${snapshot.name} did not pass its HTTP health check before the startup deadline.`, 422);
          snapshot.status = "healthy"; snapshot.healthChecked = true;
        } else {
          await delay(100, entry.controller.signal); childrenActive();
          snapshot.status = "running";
        }
        ready.add(service.id);
      }
      childrenActive(); entry.session.status = "ready"; entry.session.readyAt = Date.now();
      entry.monitor = setInterval(() => this.refresh(entry), 1000); entry.monitor.unref?.();
      return this.get(key)!;
    } catch (error) {
      this.refresh(entry);
      if (entry.session.status !== "stopped") { entry.session.status = "failed"; entry.session.error = (error as Error).message; }
      this.cleanup(entry);
      throw error;
    } finally { entry.inFlight = false; options.signal?.removeEventListener("abort", aborted); }
  }
}
