import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { CODEFLOW_HOME } from "../config.js";
import { logError } from "../log.js";
import { LocalHub, RemoteHub } from "./hub-client.js";
import { TeamLink, validateHubUrl, type ConnectInput, type HubEvent, type TeamLinkOptions } from "./link.js";
import { CollabError } from "./model.js";
import { CollabRunner, type CollabRunnerOptions } from "./runner.js";
import type { CollabStore } from "./store.js";

export interface TeamConnection { id: string; link: TeamLink; runner: CollabRunner }
interface Options extends Pick<CollabRunnerOptions, "manager" | "findPattern" | "projectFor" | "retryIntervalMs"> {
  store: CollabStore; home?: string; linkOptions?: Omit<TeamLinkOptions, "file">;
  onEvent?: (id: string, event: HubEvent) => void;
}
/** Each runner closes over one immutable hub. Browser selection never changes an executing run's destination. */
export class TeamConnections {
  private readonly entries = new Map<string, TeamConnection>();
  private readonly home: string;
  private readonly busy = new Map<string, number>();
  private readonly removing = new Set<string>();
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: Options) { this.home = options.home ?? CODEFLOW_HOME; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutations.catch(() => undefined).then(fn); this.mutations = next; return next;
  }
  private make(id: string, link: TeamLink): TeamConnection {
    const hub = id === "local" ? new LocalHub(this.options.store) : new RemoteHub(link);
    // Existing attempt journals stay in place; the runner filters them by hub origin.
    const dir = id === "local" || id === "legacy" ? join(this.home, "team-link") : join(this.home, "team-runners", id);
    const runner = new CollabRunner({ ...this.options, dir, hub: () => hub, resolveRepo: (project, key) => link.resolveRepo(project, key) });
    const entry = { id, link, runner }; this.entries.set(id, entry); return entry;
  }
  async load(): Promise<void> {
    const legacyFile = join(this.home, "team-link.json"), directory = join(this.home, "team-connections");
    let local = new TeamLink({ ...this.options.linkOptions, file: legacyFile }); await local.load();
    if (local.linked) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Atomic move, preserving credentials and existing runner identity. A restart completes discovery below.
      const names = await readdir(directory);
      if (names.includes("legacy.json")) throw new CollabError("Both legacy team connection files exist; repair them before starting", 503);
      await rename(legacyFile, join(directory, "legacy.json"));
      local = new TeamLink({ ...this.options.linkOptions, file: legacyFile }); await local.load();
    }
    this.make("local", local);
    let names: string[];
    try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
    for (const name of names.sort()) {
      if (!/^(legacy|c-[a-f0-9]{16})\.json$/.test(name)) continue;
      const link = new TeamLink({ ...this.options.linkOptions, file: join(directory, name) }); await link.load();
      if (link.linked) this.make(name.slice(0, -5), link);
    }
  }
  all(): TeamConnection[] { return [...this.entries.values()]; }
  /** Unscoped clients remain compatible when there is only one remote. Never guess between multiple teams. */
  get(id?: string | null): TeamConnection {
    if (!id) {
      const remotes = this.all().filter((entry) => entry.id !== "local");
      if (remotes.length > 1) throw new CollabError("Choose a team connection before opening its board", 409);
      id = remotes[0]?.id ?? "local";
    }
    const entry = this.entries.get(id); if (!entry) throw new CollabError("This team connection is unavailable; choose a saved team in Settings → Team", 404);
    return entry;
  }
  inventory() { return this.all().map(({ id, link }) => ({ id, ...link.state() })); }
  connect(input: ConnectInput): Promise<TeamConnection> {
    return this.serial(async () => {
      const url = validateHubUrl(input.url);
      if (this.all().some(({ link }) => link.linked && link.url === url)) throw new CollabError("This team server is already saved; select it from your team connections", 409);
      if (this.entries.size >= 21) throw new CollabError("At most 20 team servers can be connected", 409);
      const id = `c-${randomBytes(8).toString("hex")}`;
      const link = new TeamLink({ ...this.options.linkOptions, file: join(this.home, "team-connections", `${id}.json`) });
      await link.connect(input); const entry = this.make(id, link); this.watch(entry);
      this.options.onEvent?.(id, { type: "resync" }); return entry;
    });
  }
  async use<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.get(id);
    if (this.removing.has(id)) throw new CollabError("This team connection is being removed", 409);
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    try { return await action(); } finally { this.busy.set(id, this.busy.get(id)! - 1); }
  }
  disconnect(id: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.get(id); if (id === "local") throw new CollabError("The local board cannot be disconnected", 409);
      if (this.busy.get(id)) throw new CollabError("A team operation is in progress; try disconnecting after it finishes", 409);
      this.removing.add(id);
      try {
        const attempts = await entry.runner.attempts();
        if (attempts.some((attempt) => ["claiming", "claimed", "running", "unknown"].includes(attempt.state) || attempt.pendingFinish)) throw new CollabError("Stop or reconcile this team's active attempts and pending checkpoints before disconnecting", 409);
        await entry.link.disconnect(); await entry.runner.close(); this.entries.delete(id);
        this.options.onEvent?.(id, { type: "resync" });
      } finally { this.removing.delete(id); }
    });
  }
  private watch(entry: TeamConnection) {
    if (!entry.link.linked) return;
    entry.link.events((event) => this.options.onEvent?.(entry.id, event), (connection, error) => {
      this.options.onEvent?.(entry.id, { type: "link", connection, ...(error ? { error } : {}) });
      if (connection === "connected") void entry.runner.reconcile().catch((err) => logError("Team attempts could not be reconciled", err));
    });
  }
  start() { for (const entry of this.all()) { this.watch(entry); void entry.runner.reconcile().catch((error) => logError("Team attempts could not be reconciled at startup", error)); } }
  async close() { for (const entry of this.all()) entry.link.close(); await Promise.all(this.all().map((entry) => entry.runner.close())); }
}
