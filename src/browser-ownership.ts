export interface BrowserControlState { owner?: string; user: boolean; waiting: number }
interface Actor { key: string; name: string; fresh: boolean }
interface Waiter { actor: Actor; resolve: () => void; reject: (error: Error) => void; cleanup: () => void }

/** A cancellable FIFO lease over a task's browser. An in-flight action always
 * settles before a takeover is acknowledged. Idle leases cannot strand peers. */
export class BrowserOwnership {
  private owner?: Actor;
  private user = false;
  private manual = false;
  private userActions = 0;
  private busy = 0;
  private waiters: Waiter[] = [];
  private idle?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(state: BrowserControlState) => void>();
  private settled = new Set<() => void>();
  constructor(private idleMs = 30_000, private waitMs = 90_000) {}
  state(): BrowserControlState { return { owner: this.user ? "You" : this.owner?.name, user: this.user, waiting: this.waiters.length }; }
  watch(fn: (state: BrowserControlState) => void) { this.listeners.add(fn); fn(this.state()); return () => { this.listeners.delete(fn); }; }
  private publish() { for (const fn of this.listeners) fn(this.state()); }
  private scheduleIdle() {
    clearTimeout(this.idle);
    if (this.owner && !this.busy) { this.idle = setTimeout(() => { this.owner = undefined; this.drain(); }, this.idleMs); this.idle.unref(); }
  }
  private drain() {
    if (!this.user && !this.owner && !this.busy) {
      const next = this.waiters.shift();
      if (next) { next.cleanup(); this.owner = next.actor; next.resolve(); this.scheduleIdle(); }
    }
    this.publish();
  }
  private async acquire(key: string, name: string, signal: AbortSignal) {
    if (signal.aborted) throw new Error("This browser turn has ended");
    if (!this.user && this.owner?.key === key) return;
    await new Promise<void>((resolve, reject) => {
      const stop = (reason: string) => { this.waiters = this.waiters.filter(item => item !== waiter); waiter.cleanup(); reject(new Error(reason)); this.publish(); };
      const abort = () => stop("This browser turn has ended");
      let remaining = this.waitMs, last = Date.now();
      // A deliberate human takeover is a pause, not a competing worker timeout.
      const timer = setInterval(() => { const now = Date.now(); if (!this.manual) remaining -= now - last; last = now; if (remaining <= 0) stop("Still waiting for browser control. Another agent is using it; inspect the current page when you retry."); }, Math.min(1000, this.waitMs));
      const waiter: Waiter = { actor: { key, name, fresh: false }, resolve, reject, cleanup: () => { clearInterval(timer); signal.removeEventListener("abort", abort); } };
      signal.addEventListener("abort", abort, { once: true }); this.waiters.push(waiter); this.drain();
    });
  }
  async agent<T>(key: string, name: string, signal: AbortSignal, inspection: boolean, action: () => Promise<T>, requiresFresh = true): Promise<T> {
    await this.acquire(key, name, signal);
    if (signal.aborted || this.user || this.owner?.key !== key) throw new Error("Browser control changed. Inspect the current page before continuing.");
    if (requiresFresh && !inspection && !this.owner.fresh) throw new Error("Browser control acquired. Call browser_snapshot or browser_screenshot before acting on the current page.");
    clearTimeout(this.idle); this.busy++;
    try { const result = await action(); if (inspection && this.owner?.key === key) this.owner.fresh = true; return result; }
    finally { this.busy--; if (!this.busy) { for (const done of this.settled) done(); this.settled.clear(); } this.scheduleIdle(); this.drain(); }
  }
  release(key: string) {
    for (const waiter of this.waiters.filter(item => item.actor.key === key)) { waiter.cleanup(); waiter.reject(new Error("Browser request released")); }
    this.waiters = this.waiters.filter(item => item.actor.key !== key);
    if (this.owner?.key === key) { this.owner = undefined; clearTimeout(this.idle); }
    this.drain();
  }
  private async holdForUser() {
    this.user = true; this.owner = undefined; clearTimeout(this.idle); this.publish();
    if (this.busy) await new Promise<void>(resolve => this.settled.add(resolve));
    return this.state();
  }
  async takeover() { this.manual = true; return this.holdForUser(); }
  async userAction<T>(action: () => Promise<T>) {
    this.userActions++;
    await this.holdForUser();
    try { return await action(); } finally { this.userActions--; this.user = this.manual || this.userActions > 0; this.drain(); }
  }
  resume() { this.manual = false; this.user = this.userActions > 0; this.drain(); return this.state(); }
  close() { clearTimeout(this.idle); for (const waiter of this.waiters) { waiter.cleanup(); waiter.reject(new Error("Browser session ended")); } this.waiters = []; this.listeners.clear(); }
}
