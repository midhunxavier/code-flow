/**
 * A fixed number of slots, handed out in order. code-flow uses it to cap how many agent CLIs
 * and check commands run at once across every run, so ten runs started together (or a
 * comparison) don't start forty processes on your laptop.
 */
export class Slots {
  private used = 0;
  private readonly waiting: { grant: () => void; signal?: AbortSignal; onAbort: () => void; priority: () => number; group: string }[] = [];
  private readonly activeGroups = new Map<string, number>();
  private lastGroup = "";

  constructor(readonly size: number) {}

  get busy() {
    return this.used;
  }
  get queued() {
    return this.waiting.length;
  }

  /** Resolves with a release function once a slot is free; rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal, opts: { priority?: number | (() => number); group?: string } = {}): Promise<() => void> {
    const group = opts.group ?? "";
    const priority = () => { const value = typeof opts.priority === "function" ? opts.priority() : opts.priority ?? 0; return Number.isFinite(value) ? value : 0; };
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.used < this.size) {
      this.used++;
      this.activeGroups.set(group, (this.activeGroups.get(group) ?? 0) + 1);
      this.lastGroup = group;
      return Promise.resolve(this.releaser(group));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        priority,
        group,
        grant: () => {
          signal?.removeEventListener("abort", entry.onAbort);
          this.used++;
          this.activeGroups.set(group, (this.activeGroups.get(group) ?? 0) + 1);
          this.lastGroup = group;
          resolve(this.releaser(group));
        },
        onAbort: () => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new Error("aborted"));
        },
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private releaser(group: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      const remaining = (this.activeGroups.get(group) ?? 1) - 1;
      if (remaining) this.activeGroups.set(group, remaining); else this.activeGroups.delete(group);
      // Priorities are read at dispatch, so changing a queued run's priority takes effect.
      // Equal-priority work favors projects with fewer active processes, then alternates groups.
      let best = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        const candidate = this.waiting[i]!;
        const current = this.waiting[best];
        const load = this.activeGroups.get(candidate.group) ?? 0;
        const currentLoad = current ? this.activeGroups.get(current.group) ?? 0 : 0;
        if (!current || candidate.priority() > current.priority() || candidate.priority() === current.priority() && (load < currentLoad || load === currentLoad && current.group === this.lastGroup && candidate.group !== this.lastGroup)) best = i;
      }
      if (best >= 0) this.waiting.splice(best, 1)[0]!.grant();
    };
  }
}
