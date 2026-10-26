import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { closed, digest, text, validateTeamConfiguration, validateTeamSnapshot, type AgentTeamConfiguration, type AgentTeamSnapshot } from "./project-team-model.js";
import { ProjectTeamConflict } from "./project-team-store.js";

export interface AgentTeamDefinition extends AgentTeamSnapshot {
  version: 1; createdAt: number; updatedAt: number;
  versions: AgentTeamSnapshot[];
  operations: { id: string; hash: string }[];
}
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_VERSIONS = 100;
function validate(value: unknown): AgentTeamDefinition {
  const r = closed(value, ["version", "id", "revision", "name", "configuration", "createdAt", "updatedAt", "versions", "operations"], "reusable agent team");
  const snapshot = validateTeamSnapshot({ id: r.id, revision: r.revision, name: r.name, configuration: r.configuration });
  if (r.version !== 1 || !Number.isSafeInteger(r.createdAt) || r.createdAt < 0 || !Number.isSafeInteger(r.updatedAt) || r.updatedAt < 0 || !Array.isArray(r.versions) || r.versions.length !== r.revision || r.versions.length > MAX_VERSIONS || !Array.isArray(r.operations) || r.operations.length !== r.revision) throw new Error("Invalid reusable team history");
  r.versions.forEach((entry: unknown, i: number) => { const v = validateTeamSnapshot(entry); if (v.id !== r.id || v.revision !== i + 1) throw new Error("Invalid reusable team version sequence"); });
  if (digest(snapshot) !== digest(r.versions.at(-1))) throw new Error("Reusable team differs from its current version");
  for (const op of r.operations) if (!op || typeof op.id !== "string" || !op.id || op.id.length > 150 || !/^[a-f0-9]{64}$/.test(op.hash)) throw new Error("Invalid reusable team operation");
  if (new Set(r.operations.map((op: { id: string }) => op.id)).size !== r.operations.length) throw new Error("Duplicate reusable team operation");
  return r as AgentTeamDefinition;
}

/** Definitions contain preferences only. Project authority, sessions and memory stay in assignments/runs. */
export class AgentTeamDefinitions {
  private definitions = new Map<string, AgentTeamDefinition>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  readonly faults = new Map<string, string>();
  constructor(private readonly directory: string, private readonly changed: () => void = () => {}) {}
  async load() {
    this.loaded = false; this.definitions.clear(); this.faults.clear();
    const files = await readdir(this.directory).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
    for (const name of files.filter((f) => /^at-[a-f0-9]{24}\.json$/.test(f))) {
      try {
        const file = await open(join(this.directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let value: unknown;
        try {
          const info = await file.stat(); if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Reusable team exceeds its file bound");
          const buffer = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_BYTES) throw new Error("Reusable team grew beyond its bound");
          value = JSON.parse(buffer.subarray(0, bytesRead).toString());
        } finally { await file.close(); }
        const definition = validate(value);
        if (name !== `${definition.id}.json`) throw new Error("Reusable team filename differs from identity");
        this.definitions.set(definition.id, definition);
      } catch (error) { this.faults.set(name.slice(0, -5), (error as Error).message); }
    }
    this.loaded = true;
  }
  list(): AgentTeamSnapshot[] { return [...this.definitions.values()].map(({ id, revision, name, configuration }) => structuredClone({ id, revision, name, configuration })); }
  snapshot(id: string, revision: number): AgentTeamSnapshot {
    const definition = this.get(id), snapshot = definition.versions.find((v) => v.revision === revision);
    if (!snapshot) throw new Error("Choose an existing reusable team version");
    return structuredClone(snapshot);
  }
  get(id: string): AgentTeamDefinition {
    if (this.faults.has(id)) throw new Error(`Reusable team storage is unavailable: ${this.faults.get(id)}`);
    const value = this.definitions.get(id);
    if (!value) throw Object.assign(new Error("Reusable agent team not found"), { status: 404 });
    return structuredClone(value);
  }
  save(input: { id?: string; revision?: number; operationId: string; name: string; configuration: AgentTeamConfiguration }) {
    const work = this.queue.then(async () => {
      if (!this.loaded) throw new Error("Load reusable teams before writing");
      const operationId = text(input.operationId, 150, "operation ID"), name = text(input.name, 80, "team name"), configuration = validateTeamConfiguration(input.configuration);
      const hash = digest({ name, configuration }), id = input.id ?? `at-${digest(operationId).slice(0, 24)}`;
      if (this.faults.has(id)) throw new Error("Repair the damaged reusable team before writing");
      const before = input.id ? this.get(id) : this.definitions.get(id);
      const prior = before?.operations.find((op) => op.id === operationId);
      if (prior) { if (prior.hash !== hash) throw new ProjectTeamConflict("Operation ID was reused with different content"); return structuredClone(before!); }
      if (before && !input.id) throw new ProjectTeamConflict("Reusable team creation ID collision");
      if (before && input.revision !== before.revision) throw new ProjectTeamConflict("Reusable team changed. Reload before saving.");
      if (before && before.versions.length >= MAX_VERSIONS) throw new ProjectTeamConflict(`This reusable team reached its ${MAX_VERSIONS}-version limit. Create a new reusable team to keep editing.`);
      if (!before && this.definitions.size >= 100) throw new Error("The reusable team library is full");
      const revision = (before?.revision ?? 0) + 1, now = Date.now();
      const snapshot: AgentTeamSnapshot = { id, revision, name, configuration };
      const next: AgentTeamDefinition = { ...snapshot, version: 1, createdAt: before?.createdAt ?? now, updatedAt: now, versions: [...before?.versions ?? [], snapshot], operations: [...before?.operations ?? [], { id: operationId, hash }] };
      validate(next);
      const data = JSON.stringify(next); if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Reusable team history is full");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = join(this.directory, `.${id}-${randomBytes(6).toString("hex")}.tmp`);
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        await rename(temp, join(this.directory, `${id}.json`));
        if (process.platform !== "win32") { const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
        this.definitions.set(id, structuredClone(next)); this.changed();
        return structuredClone(next);
      } finally { await rm(temp, { force: true }).catch(() => undefined); }
    });
    this.queue = work.catch(() => undefined); return work;
  }
  async flush() { await this.queue; }
}
