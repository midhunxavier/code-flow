import type { Project } from "./types.js";

/** Project ids are meaningful only within the computer that owns them. */
export interface ProjectReference { computer: string; project: string }
export const projectReferenceKey = (ref: ProjectReference) => JSON.stringify([ref.computer, ref.project]);

export function projectDestination(projects: Project[], id: string, repository: string) {
  const project = projects.find(item => item.id === id);
  const matches = projects.filter(item => item.repos.includes(repository));
  const problem = id && !project ? "This project's draft is retained, but the project is unavailable. Choose a destination."
    : project && repository && !project.repos.includes(repository) ? "This repository is no longer in the project. Add it explicitly or choose another repository."
    : !project && repository ? "Choose a project for this repository before starting."
    : "";
  return { project, matches, problem, unavailable: !!id && !project };
}

/** Infer legacy ownership only when it is unambiguous; never choose the first matching project. */
export function legacyDraftProject(projects: Project[], preferred: string, repository: string): string {
  if (projects.some(project => project.id === preferred && project.repos.includes(repository))) return preferred;
  const matches = projects.filter(project => project.repos.includes(repository));
  return matches.length === 1 ? matches[0]!.id : "";
}

export class ProjectDraftReadError extends Error {
  constructor(readonly key: string, cause: unknown) { super(`Saved draft could not be read: ${(cause as Error)?.message ?? cause}. Its stored data has been retained.`); }
}

/** IndexedDB accommodates attachments that exceed localStorage's quota. Writes are ordered. */
export class ProjectDraftStore<T> {
  private database?: Promise<IDBDatabase | undefined>;
  private connection?: IDBDatabase;
  private writes: Promise<unknown> = Promise.resolve();
  private memory = new Map<string, T>();
  private failures = new Set<string>();
  private unreadable = new Map<string, ProjectDraftReadError>();
  private removed = new Set<string>();
  get unsavedKeys(): string[] { return [...this.failures]; }
  constructor(private readonly prefix: string, private readonly fallback: Storage | undefined = globalThis.localStorage, private readonly validate?: (value: T) => void) {}

  private open(): Promise<IDBDatabase | undefined> {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open("codeflow-project-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onsuccess = () => { if (blocked) { request.result.close(); return; } this.connection = request.result; resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new Error("Close older Code Flow tabs to restore drafts.")); };
    }).catch(() => undefined); // Storage policies can expose IndexedDB while denying open().
  }

  async read(key: string): Promise<T | undefined> {
    if (this.removed.has(key)) return undefined;
    if (this.unreadable.has(key)) throw this.unreadable.get(key)!;
    try {
      const value = await this.readValue(key);
      if (value !== undefined) this.validate?.(value);
      return value;
    } catch (cause) {
      const error = new ProjectDraftReadError(key, cause);
      this.unreadable.set(key, error); throw error;
    }
  }

  private async readValue(key: string): Promise<T | undefined> {
    await this.writes.catch(() => undefined);
    const id = this.prefix + key;
    if (this.memory.has(id)) return structuredClone(this.memory.get(id)!);
    const db = typeof indexedDB === "undefined" ? undefined : await this.open();
    if (!db) {
      const value = this.fallback?.getItem(id);
      return value ? JSON.parse(value) as T : undefined;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", "readonly");
      const request = tx.objectStore("drafts").get(id);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  write(key: string, value: T): Promise<void> {
    if (this.removed.has(key)) return Promise.resolve();
    if (this.unreadable.has(key)) return Promise.reject(this.unreadable.get(key)!);
    const id = this.prefix + key;
    const snapshot = structuredClone(value);
    this.memory.set(id, snapshot);
    const persist = async () => {
      // Once opened, begin the transaction in the input event itself. Chaining
      // behind earlier completion callbacks can lose the final edit on reload.
      const db = typeof indexedDB === "undefined" ? undefined : this.connection ?? await this.open();
      if (!db) {
        if (!this.fallback) throw new Error("Draft storage is unavailable.");
        this.fallback.setItem(id, JSON.stringify(snapshot));
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.objectStore("drafts").put(snapshot, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Draft save was interrupted."));
        tx.commit?.();
      });
    };
    // IndexedDB serializes transactions over this store in creation order.
    const work = persist().then(() => { this.failures.delete(key); }, error => { this.failures.add(key); throw error; });
    this.writes = Promise.all([this.writes.catch(() => undefined), work]).then(() => undefined);
    // Callers handle each write's error; the barrier is also read by read().
    void this.writes.catch(() => undefined);
    return work;
  }

  /** Remove both persistence layers after earlier writes; stale local saves cannot recreate it. */
  remove(key: string): Promise<void> {
    this.removed.add(key);
    const id = this.prefix + key;
    this.memory.delete(id); this.unreadable.delete(key); this.failures.delete(key);
    const work = this.writes.catch(() => undefined).then(async () => {
      const db = typeof indexedDB === "undefined" ? undefined : this.connection ?? await this.open();
      if (db) await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.objectStore("drafts").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Draft removal was interrupted."));
        tx.commit?.();
      });
      this.fallback?.removeItem(id);
      this.failures.delete(key);
    });
    this.writes = work;
    void work.catch(() => undefined);
    return work;
  }
}
