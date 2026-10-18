import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CODEFLOW_HOME } from "./config.js";

/**
 * The side panel's Notes: a scratchpad per repository (and one for no repository in
 * particular), kept in `~/.codeflow/notes.json` so the same notes show on your phone and after
 * a reload. Plain text; the UI saves as you type.
 */

export interface Note {
  text: string;
  updatedAt: number;
  revision: number;
  restoredFrom?: number;
}

interface NotesDocument {
  version: 2;
  /** Empty notes remain as tombstones, so stale clients cannot recreate deleted content. */
  notes: Record<string, Note>;
  history: Record<string, Note[]>;
}

const FILE = join(CODEFLOW_HOME, "notes.json");
export const MAX_NOTE_CHARS = 200_000;
/** Includes the current revision. Restoring an old revision creates a new revision. */
export const MAX_NOTE_REVISIONS = 50;
const queues = new Map<string, Promise<unknown>>();

export class NotesConflictError extends Error {
  constructor(readonly current: Note) {
    super(`Note revision conflict: the current note is at revision ${current.revision}`);
    this.name = "NotesConflictError";
  }
}

/**
 * A server owns the file. The per-file queue also coordinates multiple instances in that
 * server. Transactions read fresh snapshots, and only publish after an atomic durable save.
 * A failed read or write does not poison the next transaction or update in-memory state.
 */
export class Notes {
  private readonly file: string;
  constructor(file = FILE) { this.file = resolve(file); }

  async get(key: string): Promise<Note> {
    await queues.get(this.file);
    const document = await readDocument(this.file);
    return copy(document.notes[normalize(key)] ?? empty());
  }

  /** Omitting expectedRevision keeps older clients compatible; new clients should send it. */
  set(key: string, text: string, expectedRevision?: number): Promise<Note> {
    if (typeof text !== "string") return Promise.reject(new Error("Send the note's text"));
    if (text.length > MAX_NOTE_CHARS) return Promise.reject(new Error(`A note can hold ${MAX_NOTE_CHARS.toLocaleString()} characters at most`));
    if (!validRevision(expectedRevision)) return Promise.reject(new Error("Expected note revision must be a non-negative integer"));
    return this.change((document) => this.update(document, normalize(key), text, expectedRevision));
  }

  /** Retained revisions, newest first. An untouched scratchpad has no history. */
  async history(key: string): Promise<Note[]> {
    await queues.get(this.file);
    const document = await readDocument(this.file);
    const normalized = normalize(key);
    return (document.history[normalized] ?? (document.notes[normalized] ? [document.notes[normalized]!] : [])).map(copy);
  }

  restore(key: string, revision: number, expectedRevision: number): Promise<Note> {
    if (!Number.isSafeInteger(revision) || revision < 1) return Promise.reject(new Error("Choose a saved note revision to restore"));
    if (expectedRevision === undefined || !validRevision(expectedRevision)) return Promise.reject(new Error("Restoring a note needs its current revision"));
    return this.change((document) => {
      const normalized = normalize(key);
      const current = document.notes[normalized] ?? empty();
      if (current.revision !== expectedRevision) throw new NotesConflictError(copy(current));
      const historical = document.history[normalized]?.find((note) => note.revision === revision)
        ?? (current.revision === revision ? current : undefined);
      if (!historical) throw new Error("That note revision is no longer available");
      return this.update(document, normalized, historical.text, expectedRevision, revision);
    });
  }

  /** Which non-empty notes exist, newest first. */
  async keys(): Promise<{ key: string; updatedAt: number; revision: number }[]> {
    await queues.get(this.file);
    const document = await readDocument(this.file);
    return Object.entries(document.notes)
      .filter(([, note]) => !!note.text)
      .map(([key, note]) => ({ key, updatedAt: note.updatedAt, revision: note.revision }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  }

  /** Search current saved text only; historical/erased revisions are never returned by search. */
  async search(query: string) {
    if (typeof query !== "string" || query.length > 300) throw new Error("Notes search supports up to 300 characters");
    await queues.get(this.file);
    const document = await readDocument(this.file);
    const needle = query.trim().toLowerCase();
    const ordered = Object.entries(document.notes).filter(([, note]) => !!note.text).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    const hits: { key: string; revision: number; updatedAt: number; excerpt: string }[] = [];
    let inspected = 0;
    for (const [key, note] of ordered) {
      if (inspected >= 5000 || hits.length >= 100) break;
      inspected++;
      const position = note.text.toLowerCase().indexOf(needle);
      if (needle && position < 0 && !key.toLowerCase().includes(needle)) continue;
      const start = Math.max(0, position - 60);
      hits.push({ key, revision: note.revision, updatedAt: note.updatedAt, excerpt: note.text.slice(start, start + 300) });
    }
    return { hits, inspected, truncated: inspected < ordered.length };
  }

  private update(document: NotesDocument, key: string, text: string, expectedRevision?: number, restoredFrom?: number): Note {
    const current = document.notes[key] ?? empty();
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new NotesConflictError(copy(current));
    if (text === current.text && restoredFrom === undefined) return copy(current);
    const note: Note = {
      text, updatedAt: Math.max(Date.now(), current.updatedAt + 1), revision: current.revision + 1,
      ...(restoredFrom === undefined ? {} : { restoredFrom }),
    };
    document.notes[key] = note;
    document.history[key] = [note, ...(document.history[key] ?? (current.revision ? [current] : []))].slice(0, MAX_NOTE_REVISIONS);
    return copy(note);
  }

  private change<T>(mutate: (document: NotesDocument) => T): Promise<T> {
    const next = (queues.get(this.file) ?? Promise.resolve()).then(async () => {
      const document = await readDocument(this.file);
      const before = JSON.stringify(document);
      const result = mutate(document);
      if (JSON.stringify(document) !== before) await writeDocument(this.file, document);
      return result;
    });
    const settled = next.catch(() => undefined);
    queues.set(this.file, settled);
    void settled.then(() => { if (queues.get(this.file) === settled) queues.delete(this.file); });
    return next;
  }
}

const empty = (): Note => ({ text: "", updatedAt: 0, revision: 0 });
const copy = (note: Note): Note => ({ ...note });
const validRevision = (revision: unknown) => revision === undefined || (Number.isSafeInteger(revision) && Number(revision) >= 0);

async function readDocument(file: string): Promise<NotesDocument> {
  const document: NotesDocument = { version: 2, notes: Object.create(null), history: Object.create(null) };
  let raw: any;
  try { raw = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return document;
    throw new Error(`Notes store cannot be read: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Notes store cannot be read: invalid document");
  const versioned = raw.version === 2;
  const notes = versioned ? raw.notes : raw;
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) throw new Error("Notes store cannot be read: invalid notes");
  const decode = (value: any, legacy = false): Note => {
    if (!value || typeof value.text !== "string" || value.text.length > MAX_NOTE_CHARS) throw new Error("Notes store cannot be read: invalid note");
    const revision = legacy ? 1 : value.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Notes store cannot be read: invalid revision");
    return {
      text: value.text, updatedAt: Number(value.updatedAt) || 0, revision,
      ...(Number.isSafeInteger(value.restoredFrom) && value.restoredFrom >= 1 ? { restoredFrom: value.restoredFrom } : {}),
    };
  };
  for (const [key, value] of Object.entries(notes)) {
    const normalized = normalize(key);
    const current = decode(value, !versioned);
    document.notes[normalized] = current;
    const saved = versioned && raw.history && Array.isArray(raw.history[key]) ? raw.history[key].map((note: unknown) => decode(note)) as Note[] : [];
    const byRevision = new Map(saved.filter((note) => note.revision < current.revision).map((note) => [note.revision, note]));
    document.history[normalized] = [current, ...[...byRevision.values()].sort((a, b) => b.revision - a.revision)].slice(0, MAX_NOTE_REVISIONS);
  }
  return document;
}

async function writeDocument(file: string, document: NotesDocument): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(document, null, 2));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    if (process.platform !== "win32") {
      const directory = await open(dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Notes are per repository path; anything else is the general scratchpad. */
const normalize = (key: string) => key.startsWith("/") ? key.replace(/\/+$/, "") || "/" : "general";
