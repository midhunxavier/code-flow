export interface PersistenceStatus { state: "saving" | "saved" | "error"; seq: number; error?: string }

/** Presentation of durability is separate from workflow state and execution authority. */
export class PersistenceTracker {
  private states = new Map<string, PersistenceStatus>();
  private listeners = new Map<string, Set<(status: PersistenceStatus) => void>>();
  get(id: string): PersistenceStatus { return this.states.get(id) ?? { state: "saved", seq: 0 }; }
  subscribe(id: string, listener: (status: PersistenceStatus) => void) {
    let listeners = this.listeners.get(id); if (!listeners) this.listeners.set(id, listeners = new Set()); listeners.add(listener);
    return () => { listeners!.delete(listener); if (!listeners!.size) this.listeners.delete(id); };
  }
  private set(id: string, status: PersistenceStatus) {
    if ((this.states.get(id)?.seq ?? 0) > status.seq) return;
    this.states.set(id, status); for (const listener of this.listeners.get(id) ?? []) listener(status);
  }
  failure(id: string, seq: number, error: string) { this.set(id, { state: "error", seq, error }); }
  /** `message`: what a failure tells the user, instead of the raw error (which can name private paths). */
  track(id: string, seq: number, durable: Promise<void>, message?: string) {
    this.set(id, { state: "saving", seq });
    void durable.then(() => this.set(id, { state: "saved", seq }), (error: Error) => this.failure(id, seq, message ?? error.message));
  }
  delete(id: string) { this.states.delete(id); this.listeners.delete(id); }
}
