/** Ordered within a run, with bounded disk concurrency across unrelated runs. */
export class WorkQueue {
  private tails = new Map<string, Promise<unknown>>();
  private ready: (() => void)[] = [];
  private active = 0;
  private pending = 0;
  private bytes = 0;
  constructor(private readonly concurrency = 4) {}
  get stats() { return { active: this.active, pending: this.pending, bytes: this.bytes, keys: this.tails.size }; }
  run<T>(key: string, operation: () => Promise<T>, bytes = 0): Promise<T> {
    this.pending++; this.bytes += bytes;
    const work = (this.tails.get(key) ?? Promise.resolve()).then(async () => {
      await new Promise<void>((resolve) => {
        const grant = () => { this.active++; resolve(); };
        if (this.active < this.concurrency) grant(); else this.ready.push(grant);
      });
      try { return await operation(); }
      finally { this.active--; this.pending--; this.bytes -= bytes; this.ready.shift()?.(); }
    });
    const settled = work.then(() => undefined, () => undefined);
    this.tails.set(key, settled);
    void settled.then(() => { if (this.tails.get(key) === settled) this.tails.delete(key); });
    return work;
  }
  async flush(key?: string) {
    await Promise.all(key === undefined ? [...this.tails.values()] : [this.tails.get(key)]);
  }
}
