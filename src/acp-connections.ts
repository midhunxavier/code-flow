import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import type { AcpBinding, AcpConnection, AcpConnectionDocument } from "./adapters/acp-types.js";

const liveBindings = new Map<string, AcpBinding>();
const fingerprint = (connection: AcpConnection) => createHash("sha256").update(JSON.stringify([connection.id, connection.command, connection.args])).digest("hex");
export function acpBindings(roles: Record<string, readonly string[]>): AcpBinding[] {
  return [...new Set(Object.values(roles).flat().filter((id) => id.startsWith("acp:")))].sort().map((id) => {
    const binding = liveBindings.get(id);
    if (!binding) throw new Error(`ACP connection ${id} is disabled or missing. Restore it in Settings → Agents & models.`);
    return { ...binding };
  });
}
export function assertAcpBindings(run: { roles: Record<string, readonly string[]>; acpConnections?: AcpBinding[] }) {
  if (JSON.stringify(acpBindings(run.roles)) !== JSON.stringify(run.acpConnections ?? [])) throw new Error("This run's ACP command or arguments changed. Restore its original connection or start a new run.");
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
export function validateAcpConnection(value: unknown): AcpConnection {
  if (!object(value) || Object.keys(value).some((key) => !["id", "name", "command", "args", "enabled"].includes(key)) || typeof value.id !== "string" || !/^acp:[a-z][a-z0-9-]{0,40}$/.test(value.id)
    || !text(value.name, 100) || !value.name.trim() || !text(value.command, 4000) || !(isAbsolute(value.command) || /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(value.command))
    || !Array.isArray(value.args) || value.args.length > 32 || value.args.some((arg: unknown) => typeof arg !== "string" || arg.length > 4000 || /[\x00-\x1f\x7f]/.test(arg)) || typeof value.enabled !== "boolean") {
    throw new Error("Use a unique connection ID, a name, an executable name or absolute path, and at most 32 arguments. Shell command strings are not supported.");
  }
  return { id: value.id as AcpConnection["id"], name: value.name.trim(), command: value.command, args: [...value.args], enabled: value.enabled };
}

/** Owner-managed executable configuration, separate from portable project data and extensions. */
export class AcpConnections {
  private document: AcpConnectionDocument = { version: 1, revision: 0, connections: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private ready = false;
  constructor(private readonly publish: (connections: AcpConnection[]) => void, private readonly home = CODEFLOW_HOME) {}
  snapshot() { return structuredClone(this.document); }
  private activate(document: AcpConnectionDocument) {
    this.publish(document.connections.filter((connection) => connection.enabled));
    liveBindings.clear();
    for (const connection of document.connections.filter((connection) => connection.enabled)) liveBindings.set(connection.id, { id: connection.id, fingerprint: fingerprint(connection) });
    this.document = document;
  }
  async load() {
    try {
      const file = await open(join(this.home, "acp-connections.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 256 * 1024) throw new Error("ACP connections must be a regular file under 256 KiB");
        const buffer = Buffer.alloc(256 * 1024 + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 256 * 1024) throw new Error("ACP connections exceed 256 KiB");
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
      if (!object(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !Array.isArray(raw.connections) || raw.connections.length > 16) throw new Error("Invalid ACP connection settings");
      const connections = raw.connections.map(validateAcpConnection);
      if (new Set(connections.map((connection) => connection.id)).size !== connections.length) throw new Error("Duplicate ACP connection IDs");
      this.activate({ version: 1, revision: raw.revision, connections });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.activate(this.document); }
    this.ready = true;
  }
  save(revision: unknown, value: unknown) {
    const connection = validateAcpConnection(value);
    return this.change(revision, (connections) => [...connections.filter((item) => item.id !== connection.id), connection]);
  }
  remove(revision: unknown, id: string) {
    return this.change(revision, (connections) => {
      if (!connections.some((connection) => connection.id === id)) throw new Error("ACP connection no longer exists");
      return connections.filter((connection) => connection.id !== id);
    });
  }
  private change(revision: unknown, update: (connections: AcpConnection[]) => AcpConnection[]) {
    const work = this.queue.then(async () => {
      if (!this.ready) throw new Error("Repair ACP connection storage and restart before changing connections");
      if (revision !== this.document.revision) throw new Error("ACP connections changed in another window. Reload connections before saving.");
      const next: AcpConnectionDocument = { version: 1, revision: this.document.revision + 1, connections: update(this.snapshot().connections) };
      const json = JSON.stringify(next, null, 2);
      if (next.connections.length > 16 || Buffer.byteLength(json) > 256 * 1024) throw new Error("Keep at most 16 ACP connections within 256 KiB");
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const temporary = join(this.home, `.acp-connections-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.home, "acp-connections.json"));
      } finally { await unlink(temporary).catch(() => undefined); }
      this.activate(next);
      return this.snapshot();
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}
