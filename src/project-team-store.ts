import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { PT_LIMITS, validateTeamDocument, type ProjectTeam } from "./project-team-model.js";
import { repositoryIdentity } from "./repository-identity.js";

export class ProjectTeamConflict extends Error { readonly status = 409; }
/** One serialized writer, immutable published snapshots, and fsync before acknowledgment. */
export class ProjectTeamStore {
  private teams = new Map<string, ProjectTeam>();
  /** Valid history whose repository ownership prevents dispatch; never used for writes. */
  private quarantinedHistory = new Map<string, ProjectTeam>();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  readonly faults = new Map<string, string>();
  private loaded = false;
  private feature?: { version: 1; enabled: boolean; revision: number };
  constructor(readonly directory = join(CODEFLOW_HOME, "project-teams")) {}
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  notify() { for (const listener of this.listeners) { try { listener(); } catch {} } }
  private publish(team: ProjectTeam) { this.teams.set(team.id, structuredClone(team)); this.notify(); }
  async load() {
    const files = await readdir(this.directory).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
    this.teams.clear(); this.quarantinedHistory.clear(); this.faults.clear(); this.feature = undefined;
    try {
      const file = await open(join(this.directory, "settings.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw;
      try {
        const stat = await file.stat(); if (!stat.isFile() || stat.size > 4096) throw new Error("Standing teams settings exceed their regular-file bound");
        const buffer = Buffer.alloc(4097); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096) throw new Error("Standing teams settings grew beyond their limit");
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString());
      } finally { await file.close(); }
      if (!raw || raw.version !== 1 || typeof raw.enabled !== "boolean" || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || Object.keys(raw).some(key => !["version", "enabled", "revision"].includes(key))) throw new Error("Invalid Standing teams setting");
      this.feature = raw;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.faults.set("settings", (error as Error).message); }
    for (const name of files.filter((f) => /^pt-[a-f0-9]{24}\.json$/.test(f))) {
      try {
        const file = await open(join(this.directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let value: unknown;
        try { const stat = await file.stat(); if (!stat.isFile() || stat.size > PT_LIMITS.bytes) throw new Error("Team file exceeds its regular-file bound"); const buffer = Buffer.alloc(PT_LIMITS.bytes + 1); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); if (bytesRead > PT_LIMITS.bytes) throw new Error("Team file grew beyond its limit"); value = JSON.parse(buffer.subarray(0, bytesRead).toString()); } finally { await file.close(); }
        const team = validateTeamDocument(value); if (`${team.id}.json` !== name) throw new Error("Team identity differs from filename"); this.teams.set(team.id, team);
      } catch (error) { this.faults.set(name.slice(0, -5), (error as Error).message); }
    }
    const owners = new Map<string, string[]>();
    for (const team of this.teams.values()) if (team.status !== "archived") {
      try {
        const identity = await repositoryIdentity(team.repo);
        if (team.repositoryId && team.repositoryId !== identity) throw new Error("Repository metadata was replaced; inspect ownership before dispatch");
        if (!team.repositoryId) {
          // Add ownership metadata only. Never rewrite mission snapshots, launch receipts or usage.
          team.repositoryId = identity; team.revision++; team.updatedAt = Date.now();
          await this.save(team);
        }
        owners.set(identity, [...owners.get(identity) ?? [], team.id]);
      } catch (error) { this.faults.set(team.id, (error as Error).message); this.quarantinedHistory.set(team.id, structuredClone(team)); this.teams.delete(team.id); }
    }
    for (const ids of owners.values()) if (ids.length > 1) for (const id of ids) { this.faults.set(id, "Multiple active teams claim this repository; resolve ownership before dispatch"); this.quarantinedHistory.set(id, structuredClone(this.teams.get(id)!)); this.teams.delete(id); }
    this.loaded = true;
  }
  configuration(defaultEnabled: boolean) {
    if (!this.loaded || this.faults.has("settings") || this.faults.has("storage")) return { enabled: false, revision: 0, source: "unavailable" };
    return { enabled: this.feature?.enabled ?? defaultEnabled, revision: this.feature?.revision ?? 0, source: this.feature ? "saved" : "default" };
  }
  setEnabled(enabled: boolean, revision: number) {
    return this.serialized(async () => {
      if (!this.loaded || this.faults.has("settings") || this.faults.has("storage")) throw new Error("Repair Standing teams settings before changing them");
      if (revision !== (this.feature?.revision ?? 0)) throw new ProjectTeamConflict("Standing teams settings changed. Reload before trying again.");
      const next = { version: 1 as const, enabled, revision: revision + 1 };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `.settings-${randomBytes(6).toString("hex")}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.directory, "settings.json"));
        if (process.platform !== "win32") { const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); } }
        this.feature = next;
        for (const listener of this.listeners) { try { listener(); } catch {} }
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
  }
  list() { return [...this.teams.values()].map((t) => structuredClone(t)); }
  get(id: string): ProjectTeam {
    const error = this.faults.get(id); if (error) throw new Error(`Standing team storage is unavailable: ${error}`);
    const team = this.teams.get(id); if (!team) throw Object.assign(new Error("Project team not found"), { status: 404 });
    return structuredClone(team);
  }
  /** Only deletion may inspect validated, quarantined history. Corrupt documents still fail closed. */
  deletionHistory(id: string): ProjectTeam {
    const history = this.quarantinedHistory.get(id);
    return history ? structuredClone(history) : this.get(id);
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn); this.queue = result.catch(() => undefined); return result;
  }
  async flush() { await this.queue; }
  create(team: ProjectTeam) {
    return this.serialized(async () => {
      if (!this.loaded) throw new Error("Load project team storage before writing");
      if (this.faults.size) throw new Error("Repair damaged team records before creating teams; repository ownership cannot be determined");
      const existing = this.teams.get(team.id); if (existing) { if (existing.operations[0]?.hash !== team.operations[0]?.hash) throw new ProjectTeamConflict("Operation ID was reused with different content"); return structuredClone(existing); }
      team = structuredClone(team);
      team.repositoryId = await repositoryIdentity(team.repo);
      if ([...this.teams.values()].some((t) => t.status !== "archived" && (t.repo === team.repo || t.repositoryId === team.repositoryId))) throw new ProjectTeamConflict("This repository already has a standing team (including its linked worktrees)");
      await this.save(team); this.publish(team); return structuredClone(team);
    });
  }
  change(id: string, expected: number | undefined, operation: { id: string; hash: string } | undefined, update: (team: ProjectTeam) => void) {
    return this.serialized(async () => {
      if (!this.loaded) throw new Error("Load project team storage before writing");
      const team = this.get(id);
      const previous = operation && team.operations.find((o) => o.id === operation.id);
      if (previous) { if (previous.hash !== operation!.hash) throw new ProjectTeamConflict("Operation ID was reused with different content"); return team; }
      if (expected !== undefined && expected !== team.revision) throw new ProjectTeamConflict("This team changed. Reload before acting.");
      update(team);
      team.revision++; team.updatedAt = Date.now();
      if (operation) team.operations.push({ ...operation, at: team.updatedAt });
      await this.save(team); this.publish(team); return structuredClone(team);
    });
  }
  private async save(team: ProjectTeam) {
    validateTeamDocument(team);
    const data = JSON.stringify(team); if (Buffer.byteLength(data) > PT_LIMITS.bytes) throw new Error("Standing team history exceeds its storage limit");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${team.id}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(this.directory, `${team.id}.json`));
      if (process.platform !== "win32") { const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}
