import type { TeamContext } from "./engine.js";

interface Job<T> { id: string; work: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
interface Pending<T> { promise: Promise<T>; settled: boolean }

/**
 * Bounded event pool. Idle runners are promises, never vendor processes. A completion
 * batch is durable before its artifacts affect readiness. Replay awaits recorded IDs,
 * rather than accepting whichever cached promise happens to resolve first.
 */
export async function withEventPool<T, R>(ctx: TeamContext, concurrency: number, driver: (pool: EventPool<T>) => Promise<R>): Promise<R> {
  const pool = new EventPool<T>(ctx);
  let result!: R;
  await ctx.parallel(Array.from({ length: Math.max(1, concurrency) + 1 }, (_, i) => i), async (index) => {
    if (index === 0) {
      try { result = await driver(pool); } finally { pool.close(); }
    } else {
      for (;;) {
        const job = await pool.take(ctx.signal);
        if (!job) break;
        try { job.resolve(await job.work()); }
        catch (error) { job.reject(error); throw error; }
      }
    }
  });
  return result;
}

export class EventPool<T> {
  private queue: Job<T>[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;
  private pending = new Map<string, Pending<T>>();
  constructor(private ctx: Pick<TeamContext, "remember" | "signal">) {}
  get size(): number { return this.pending.size; }
  get ids(): string[] { return [...this.pending.keys()]; }
  submit(id: string, work: () => Promise<T>): void {
    if (this.closed || this.pending.has(id)) throw new Error(`Duplicate or closed scheduler dispatch: ${id}`);
    let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const pending = { promise, settled: false }; this.pending.set(id, pending);
    void promise.then(() => { pending.settled = true; }, () => { pending.settled = true; });
    this.queue.push({ id, work, resolve, reject }); this.wake();
  }
  async next(identity: string, wakeAt?: number): Promise<T[]> {
    if (!this.pending.size) return [];
    const signal = this.ctx.signal;
    if (signal.aborted) throw new Error("Event scheduler stopped");
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Event scheduler stopped"));
      signal.addEventListener("abort", abort, { once: true });
    });
    // A queued attempt may never start after sibling cancellation. Both live
    // completion waits and recorded replay batches must be interruptible.
    try {
      const ids = await this.ctx.remember("team-completion", identity, async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = wakeAt === undefined ? [] : [new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, wakeAt - Date.now()));
        })];
        try {
          await Promise.race([...this.pending.values()].map((p) => p.promise).concat(wake as Promise<T>[], stopped));
          // One microtask coalesces simultaneous exits without an arbitrary wall-clock barrier.
          await Promise.resolve();
          return [...this.pending].filter(([, p]) => p.settled).map(([id]) => id).sort();
        } finally { clearTimeout(timer); }
      });
      if (!ids.length && wakeAt === undefined || ids.some((id) => !this.pending.has(id))) throw new Error("Scheduler completion history does not match dispatched attempts");
      const outcomes = await Promise.race([Promise.all(ids.map((id) => this.pending.get(id)!.promise)), stopped]);
      ids.forEach((id) => this.pending.delete(id));
      return outcomes;
    } finally { signal.removeEventListener("abort", abort); }
  }
  async take(signal: AbortSignal): Promise<Job<T> | undefined> {
    if (signal.aborted) throw new Error("Event scheduler stopped");
    while (!this.queue.length && !this.closed) {
      if (signal.aborted) throw new Error("Event scheduler stopped");
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.waiters = this.waiters.filter((w) => w !== wake); reject(new Error("Event scheduler stopped")); };
        this.waiters.push(wake); signal.addEventListener("abort", abort, { once: true });
      });
    }
    return this.queue.shift();
  }
  close(): void { this.closed = true; this.wake(); }
  private wake(): void { const waiting = this.waiters; this.waiters = []; waiting.forEach((fn) => fn()); }
}
