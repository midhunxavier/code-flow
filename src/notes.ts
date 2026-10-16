import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { logError } from "./log.js";

/**
 * The side panel's Notes: a scratchpad per repository (and one for no repository in
 * particular), kept in `~/.codeflow/notes.json` so the same notes show on your phone and after
 * a reload. Plain text; the UI saves as you type.
 */

export interface Note {
  text: string;
  updatedAt: number;
}

const FILE = join(CODEFLOW_HOME, "notes.json");
export const MAX_NOTE_CHARS = 200_000;

export class Notes {
  private notes: Record<string, Note> | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file = FILE) {}

  private async load(): Promise<Record<string, Note>> {
    if (this.notes) return this.notes;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      this.notes = {};
      if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw as Record<string, any>)) {
          if (value && typeof value.text === "string") this.notes[key] = { text: value.text, updatedAt: Number(value.updatedAt) || 0 };
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") logError(`Couldn't read ${this.file}; starting with empty notes`, err);
      this.notes = {};
    }
    return this.notes;
  }

  async get(key: string): Promise<Note> {
    return (await this.load())[normalize(key)] ?? { text: "", updatedAt: 0 };
  }

  /** Saves through a temporary file; writes are queued so the file never holds a torn note. */
  async set(key: string, text: string): Promise<Note> {
    if (text.length > MAX_NOTE_CHARS) throw new Error(`A note can hold ${MAX_NOTE_CHARS.toLocaleString()} characters at most`);
    const notes = await this.load();
    const note = { text, updatedAt: Date.now() };
    if (text) notes[normalize(key)] = note;
    else delete notes[normalize(key)];
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(notes, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    await this.saving;
    return note;
  }

  /** Which notes exist, newest first. */
  async keys(): Promise<{ key: string; updatedAt: number }[]> {
    return Object.entries(await this.load())
      .map(([key, n]) => ({ key, updatedAt: n.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Notes are per repository path; anything else is the general scratchpad. */
const normalize = (key: string) => (key.startsWith("/") ? key.replace(/\/+$/, "") : "general");
