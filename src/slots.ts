/**
 * A fixed number of slots, handed out in order. code-flow uses it to cap how many agent CLIs
 * and check commands run at once across every run, so ten runs started together (or a
 * comparison) don't start forty processes on your laptop.
 */
export class Slots {
  private used = 0;
  private readonly waiting: { grant: () => void; signal?: AbortSignal; onAbort: () => void }[] = [];

  constructor(readonly size: number) {}

  get busy() {
    return this.used;
  }
  get queued() {
    return this.waiting.length;
  }

  /** Resolves with a release function once a slot is free; rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.used < this.size) {
      this.used++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        grant: () => {
          signal?.removeEventListener("abort", entry.onAbort);
          this.used++;
          resolve(this.releaser());
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

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      this.waiting.shift()?.grant();
    };
  }
}
