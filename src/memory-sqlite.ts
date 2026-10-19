import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { MemoryEntry, MemoryQuery } from "./memory.js";

export interface MemoryDocument { schemaVersion: 1; entries: MemoryEntry[] }
export type EntityKind = "memory" | "file" | "run" | "commit";
export interface KnowledgeEntity { id: string; kind: EntityKind; key: string; label: string }
export interface KnowledgeRelationship {
  from: string; to: string; relation: "applies_to" | "learned_from" | "derived_from" | "verified_at";
  evidence: { id: string; revision: number }; targetRevision?: number;
}
export interface KnowledgeGraph { entities: KnowledgeEntity[]; relationships: KnowledgeRelationship[]; truncated: boolean }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const idFor = (entry: MemoryEntry, kind: EntityKind, key: string) => digest(JSON.stringify([entry.repo, entry.projectId ?? null, kind, key]));

/** Connections are short-lived; DELETE journaling leaves one portable file after commit.
 * All mutations use BEGIN IMMEDIATE, including legacy import and derived graph/index updates.
 * No model-generated relationship types or arbitrary SQL reach this layer. */
export class MemoryDatabase {
  readonly legacy: string;
  readonly backup: string;
  constructor(readonly file: string, private validate: (raw: string) => MemoryDocument) {
    this.legacy = file.replace(/\.sqlite$/, "") + ".json";
    this.backup = `${this.legacy}.pre-sqlite`;
  }

  withDatabase<T>(action: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const fresh = !existsSync(this.file);
      if (fresh && existsSync(this.backup) && !existsSync(this.legacy)) throw new Error("Database is missing but a migration backup exists; restore it explicitly before continuing");
      const legacyRaw = this.readLegacyIfPresent();
      const legacy = legacyRaw === undefined ? undefined : this.validate(legacyRaw);
      if (fresh) {
        try { closeSync(openSync(this.file, "wx", 0o600)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      if (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink()) throw new Error("Memory database must be a regular file");
      if ((lstatSync(this.file).mode & 0o777) !== 0o600) chmodSync(this.file, 0o600);
      db = new DatabaseSync(this.file);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL;");
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (version !== 0 && version !== 1) throw new Error(`Unsupported memory database schema ${version}`);
      if (!version) {
        db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
        try {
          // Another process may have completed initialization while we waited for its lock.
          if (Number(db.prepare("PRAGMA user_version").get()!.user_version) === 0) {
            if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) throw new Error("Unrecognized memory database");
            db.exec(`
              CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
              CREATE TABLE memories (id TEXT PRIMARY KEY, repo TEXT NOT NULL, project_id TEXT,
                scope TEXT NOT NULL, run_id TEXT, member_id TEXT, status TEXT NOT NULL,
                revision INTEGER NOT NULL, document TEXT NOT NULL) STRICT;
              CREATE INDEX memory_scope ON memories(repo, project_id, scope, run_id, member_id);
              CREATE TABLE memory_terms (memory_id TEXT NOT NULL REFERENCES memories(id), term TEXT NOT NULL,
                weight INTEGER NOT NULL, PRIMARY KEY(memory_id, term)) STRICT;
              CREATE INDEX memory_term_lookup ON memory_terms(term);
              CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL) STRICT;
              CREATE TABLE relationships (owner TEXT NOT NULL REFERENCES memories(id), revision INTEGER NOT NULL,
                source TEXT NOT NULL REFERENCES entities(id), target TEXT NOT NULL REFERENCES entities(id),
                relation TEXT NOT NULL, target_revision INTEGER,
                PRIMARY KEY(owner, source, target, relation)) STRICT;
              CREATE INDEX graph_source ON relationships(source);
              CREATE INDEX graph_target ON relationships(target);
              PRAGMA user_version=1;
            `);
            for (const entry of legacy?.entries ?? []) this.writeEntry(db, entry);
            if (legacyRaw !== undefined) {
              const imported = this.read(db);
              if (JSON.stringify(imported.entries) !== JSON.stringify(legacy!.entries)) throw new Error("Legacy memory verification failed");
              db.prepare("INSERT INTO metadata VALUES('legacy_hash', ?)").run(digest(legacyRaw));
            }
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      if (existsSync(this.legacy)) {
        // Finalization has its own lock after import is durable. Concurrent readers or a
        // first writer cannot race the rename and resurrect a retired rollback copy.
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = this.readLegacyIfPresent();
          if (current !== undefined) {
            const hash = db.prepare("SELECT value FROM metadata WHERE key='legacy_hash'").get()?.value;
            if (hash !== digest(current)) throw new Error("Legacy JSON differs from the imported database; resolve it explicitly before continuing");
            if (existsSync(this.backup)) throw new Error("Both legacy JSON and migration backup exist; resolve them explicitly");
            renameSync(this.legacy, this.backup);
            chmodSync(this.backup, 0o600);
            this.syncDirectory();
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      return action(db);
    } catch (error) {
      // Keep application conflict/authorization errors intact; callers rely on their type.
      if ((error as NodeJS.ErrnoException).code?.startsWith("ERR_SQLITE")) {
        throw new Error(`Memory store cannot be read or updated; no operation was acknowledged: ${(error as Error).message}`, { cause: error });
      }
      throw error;
    } finally { db?.close(); }
  }

  read(db: DatabaseSync, query?: MemoryQuery): MemoryDocument {
    const rows = query
      ? db.prepare("SELECT document FROM memories WHERE repo=? AND project_id IS ? AND (? IS NULL OR scope=?) ORDER BY rowid")
        .all(query.repo, query.projectId ?? null, query.scope ?? null, query.scope ?? null)
      : db.prepare("SELECT document FROM memories ORDER BY rowid").all();
    return this.validate(JSON.stringify({ schemaVersion: 1, entries: rows.map((row) => JSON.parse(String(row.document))) }));
  }

  change<T>(db: DatabaseSync, fn: (doc: MemoryDocument) => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const doc = this.read(db);
      const before = new Map(doc.entries.map((entry) => [entry.id, JSON.stringify(entry)]));
      const result = fn(doc);
      const changed = doc.entries.filter((entry) => before.get(entry.id) !== JSON.stringify(entry));
      if (changed.length) {
        this.validate(JSON.stringify(doc));
        // Retire the migration copy before the first mutation so deletion/revision cannot
        // leave old bodies in an application-owned rollback copy. User backups are separate.
        this.cleanLegacyCopies();
        db.exec("DELETE FROM metadata WHERE key='legacy_hash'");
        for (const entry of changed) this.writeEntry(db, entry);
        db.exec("DELETE FROM entities WHERE id NOT IN (SELECT source FROM relationships UNION SELECT target FROM relationships)");
      }
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** An indexed Unicode token search also works on Node builds without FTS5. */
  search(db: DatabaseSync, query: MemoryQuery, eligible: string[]): Map<string, number> {
    const terms = [...new Set(tokenize(query.query ?? ""))].slice(0, 32);
    if (!terms.length || !eligible.length) return new Map();
    return new Map(db.prepare(`SELECT memory_id, SUM(weight) AS relevance FROM memory_terms
      WHERE term IN (SELECT value FROM json_each(?)) AND memory_id IN (SELECT value FROM json_each(?))
      GROUP BY memory_id ORDER BY relevance DESC, memory_id LIMIT 512`)
      .all(JSON.stringify(terms), JSON.stringify(eligible)).map((row) => [String(row.memory_id), Number(row.relevance)]));
  }

  graph(db: DatabaseSync, entries: MemoryEntry[], limit = 1000): KnowledgeGraph {
    const allowed = new Map(entries.map((entry) => [entry.id, entry]));
    const memoryNodes = new Map(entries.map((entry) => [idFor(entry, "memory", entry.id), entry]));
    const entities = new Map<string, KnowledgeEntity>();
    const relationships: KnowledgeRelationship[] = [];
    let truncated = false;
    const edges = db.prepare(`SELECT r.*, s.kind AS source_kind, s.key AS source_key, t.kind AS target_kind, t.key AS target_key
      FROM relationships r JOIN entities s ON s.id=r.source JOIN entities t ON t.id=r.target WHERE r.owner=? ORDER BY r.relation, t.key`);
    for (const entry of entries) {
      for (const row of edges.all(entry.id)) {
        // Historical/private/deleted source bodies and labels never enter the graph.
        const target = memoryNodes.get(String(row.target));
        if (row.target_kind === "memory" && (!target || target.revision !== row.target_revision)) continue;
        if (!allowed.has(String(row.owner)) || row.revision !== entry.revision) continue;
        if (relationships.length >= limit) { truncated = true; break; }
        for (const prefix of ["source", "target"] as const) {
          const id = String(row[prefix]), kind = row[`${prefix}_kind`] as EntityKind, key = String(row[`${prefix}_key`]);
          entities.set(id, { id, kind, key, label: kind === "memory" ? memoryNodes.get(id)!.title : key });
        }
        relationships.push({ from: String(row.source), to: String(row.target), relation: row.relation as KnowledgeRelationship["relation"],
          evidence: { id: entry.id, revision: entry.revision }, ...(row.target_revision == null ? {} : { targetRevision: Number(row.target_revision) }) });
      }
      if (truncated) break;
    }
    return { entities: [...entities.values()], relationships, truncated };
  }

  private writeEntry(db: DatabaseSync, entry: MemoryEntry) {
    db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      repo=excluded.repo, project_id=excluded.project_id, scope=excluded.scope, run_id=excluded.run_id,
      member_id=excluded.member_id, status=excluded.status, revision=excluded.revision, document=excluded.document`)
      .run(entry.id, entry.repo, entry.projectId ?? null, entry.scope, entry.runId ?? null, entry.memberId ?? null, entry.status, entry.revision, JSON.stringify(entry));
    db.prepare("DELETE FROM memory_terms WHERE memory_id=?").run(entry.id);
    db.prepare("DELETE FROM relationships WHERE owner=?").run(entry.id);
    if (entry.status === "deleted") return;
    const weights = new Map<string, number>();
    for (const [value, weight] of [[entry.title, 3], [entry.tags.join(" "), 2], [entry.body, 1]] as const) {
      for (const term of new Set(tokenize(value))) weights.set(term, (weights.get(term) ?? 0) + weight);
    }
    const termInsert = db.prepare("INSERT INTO memory_terms VALUES(?,?,?)");
    for (const [term, weight] of weights) termInsert.run(entry.id, term, weight);
    const entity = (kind: EntityKind, key: string) => {
      const id = idFor(entry, kind, key);
      db.prepare("INSERT OR IGNORE INTO entities VALUES(?,?,?)").run(id, kind, key);
      return id;
    };
    const source = entity("memory", entry.id);
    const edge = (kind: EntityKind, key: string, relation: KnowledgeRelationship["relation"], revision?: number) => {
      db.prepare("INSERT OR REPLACE INTO relationships VALUES(?,?,?,?,?,?)").run(entry.id, entry.revision, source, entity(kind, key), relation, revision ?? null);
    };
    for (const path of entry.paths) edge("file", path, "applies_to");
    if (entry.runId) edge("run", entry.runId, "learned_from");
    for (const ref of entry.sourceRefs) {
      if (ref.startsWith("run:") && ref.length > 4) edge("run", ref.slice(4), "learned_from");
      if (/^commit:[a-f0-9]{40,64}$/i.test(ref)) edge("commit", ref.slice(7), "learned_from");
    }
    if (entry.applicability.kind === "branch" && entry.applicability.commit) edge("commit", entry.applicability.commit, "applies_to");
    if (entry.verification?.commit) edge("commit", entry.verification.commit, "verified_at");
    const sources = new Map<string, number>();
    for (const ref of entry.derivedFrom) sources.set(ref.id, Math.max(sources.get(ref.id) ?? 0, ref.revision));
    for (const [id, revision] of sources) edge("memory", id, "derived_from", revision);
  }

  private readLegacyIfPresent(): string | undefined {
    try {
      const info = lstatSync(this.legacy);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error("Legacy memory must be a regular file under 32 MiB");
      return readFileSync(this.legacy, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private cleanLegacyCopies() {
    rmSync(this.backup, { force: true });
    for (const name of readdirSync(dirname(this.file))) {
      for (const path of [this.file, this.legacy]) {
        const prefix = `${basename(path)}.`;
        if (name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length))) rmSync(`${dirname(this.file)}/${name}`);
      }
    }
    this.syncDirectory();
  }

  private syncDirectory() {
    if (process.platform === "win32") return;
    const fd = openSync(dirname(this.file), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

function tokenize(value: string): string[] { return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []; }
