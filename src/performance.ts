import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Bounded diagnostics: no URLs, query strings, prompts, or individual request records. */
export class PerformanceMetrics {
  private delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly utilization = performance.eventLoopUtilization();
  private readonly startedAt = performance.now();
  private samples: number[] = [];
  private requests = 0;
  private errors = 0;
  private active = 0;
  constructor() { this.delay.enable(); }
  observe(req: IncomingMessage, res: ServerResponse) {
    // Streams are long lived; their lifetime isn't API response latency.
    if (req.headers.accept?.includes("text/event-stream")) return;
    const start = performance.now(); this.active++;
    res.once("close", () => {
      this.active--; this.requests++; if (res.statusCode >= 500) this.errors++;
      this.samples.push(performance.now() - start); if (this.samples.length > 1024) this.samples.shift();
    });
  }
  snapshot() {
    const samples = [...this.samples].sort((a, b) => a - b);
    const utilization = performance.eventLoopUtilization(this.utilization);
    const count = this.delay.count;
    const loop = { p95Ms: count ? this.delay.percentile(95) / 1e6 : null, maxMs: count ? this.delay.max / 1e6 : null, utilization: utilization.utilization, samples: count, window: "since-start" as const, windowSeconds: (performance.now() - this.startedAt) / 1000 };
    return { memory: process.memoryUsage(), uptimeSeconds: process.uptime(), eventLoop: loop,
      http: { requests: this.requests, errors: this.errors, active: this.active, samples: samples.length, p50Ms: samples[Math.floor(samples.length * .5)] ?? 0, p95Ms: samples[Math.floor(samples.length * .95)] ?? 0 } };
  }
  close() { this.delay.disable(); }
}
