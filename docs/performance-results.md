# Measured performance: 19 October 2026

The architecture changes improved latest-transcript opening by **1.9×** with
1,000 events and **27.5×** with 5,000 events on this machine.
The experimental Rust reader showed no consistent end-to-end benefit and increased
transcript API latency, so production retains TypeScript. These numbers describe
synthetic history/transcript operations, not provider inference or total coding-task
duration.

## Comparison

Medians of seven fresh-context Chrome trials after one unmeasured warmup per variant:

| Workload | Before | Optimized TypeScript | Optimized + Rust experiment |
| --- | ---: | ---: | ---: |
| 20 runs, 1,000 events: latest transcript visible | 507.07 ms | 265.93 ms | 261.32 ms |
| 200 runs, 5,000 events: latest transcript visible | 7,486.30 ms | 271.84 ms | 332.22 ms |
| 200 runs, 100,000 events: latest transcript visible | Timed out (30 s heading wait) | 259.74 ms | 267.20 ms |
| 1,000 events: transcript API | 168.64 ms | 4.91 ms | 8.88 ms |
| 5,000 events: transcript API | 6,445.59 ms | 4.43 ms | 8.01 ms |
| 100,000 events: transcript API | Not measured after UI failure | 5.14 ms | 8.80 ms |
| 20 runs: history search API | 1.60 ms | 1.31 ms | 1.29 ms |
| 200 runs: history search API (5,000-event fixture) | 3.24 ms | 1.46 ms | 1.65 ms |

API medians contain 35 requests per successful variant/workload (five per browser
trial). The old transcript endpoint replays the entire history over SSE; the new
endpoint returns a recent page of at most 500 events. These are deliberately the
paths used to reach the same user-visible latest output, **not equal-size response
benchmarks**. Earlier events remain accessible through pagination. Reduced work,
indexed repository membership and smaller responses explain the gain; it is not a
language-only comparison.

The baseline stress attempt failed before the run heading became visible, with no
browser JavaScript exception. It was stopped before timing the other variants to
avoid background CPU interference. A timeout is not a precise timing or speedup
ratio. No baseline stress API or heap result is inferred.

## Resource tradeoffs and variance

| Browser metric | Before | Optimized TypeScript | Rust experiment |
| --- | ---: | ---: | ---: |
| 1,000 events: decoded bytes through latest output | 1.99 MiB | 1.63 MiB | 1.63 MiB |
| 5,000 events: decoded bytes through latest output | 3.53 MiB | 1.99 MiB | 1.82 MiB |
| 1,000 events: JS heap after GC | 4.33 MiB | 4.59 MiB | 4.59 MiB |
| 5,000 events: JS heap after GC | 5.73 MiB | 4.72 MiB | 4.75 MiB |
| 100,000 events: JS heap after GC | Unavailable | 4.71 MiB | 4.75 MiB |

Small-history heap increased **6.0%**; at 5,000 events it decreased
**17.7%**. The cache and paging state have a fixed cost. All successful
variants rendered 200 transcript rows in this fixture; the improvement is not
explained by comparing different visible row counts. Received bytes include decoded
assets and stream traffic, not compressed wire bytes. Heap is the Chrome JavaScript
heap after forced GC, not RSS or total system memory. Startup was sampled only once
per server and is retained in the raw data, not used for a speedup claim.

Browser latest-output ranges (min–max):

| Events | Before | TypeScript | Rust |
| --- | ---: | ---: | ---: |
| 1,000 | 444.91–545.48 ms | 236.50–279.94 ms | 241.34–334.27 ms |
| 5,000 | 7,468.25–8,484.10 ms | 243.33–339.21 ms | 260.89–359.22 ms |
| 100,000 | Timeout | 229.12–262.89 ms | 244.02–338.19 ms |

This is a developer laptop, not an isolated benchmark host. Other applications and
OS activity contribute noise; initial system load averages were
7.80, 11.29, 11.21. Variant order rotates each round and filesystem caches are not
flushed. Small sub-millisecond differences in history API timings should not be
interpreted as reliable Rust benefits. Raw samples are provided rather than a
statistical-significance claim.

## Rust decision

The dependency-free release-mode Rust helper reads the same file backwards and
returns original records and byte offsets over a pipe. The same TypeScript code
then validates and constructs the page. Tests verify parity for Unicode, malformed
records, large previews, step filters, reconnects and pagination. Benchmark timing
includes actual process creation, IPC and termination.

Against optimized TypeScript, Rust transcript API medians were **81% slower**
for 1,000 events, **81% slower** for 5,000, and **71% slower** for 100,000.
Rust's small-workload browser median differs by only a few milliseconds from
TypeScript and lies within the observed ranges; it is not evidence of a reliable
user-visible gain.
The optimized bounded scan is already only a few milliseconds; this process boundary
adds more cost than it removes. This does not establish that Rust itself is slower,
or predict the performance of a persistent native worker, an in-process extension,
or a full rewrite. The experiment remains reproducible but is not enabled in the
production app and adds no Rust installation requirement for users.

## Reproduction and scope

- Baseline: `44a006830a0ef2326b22a01f468981b6e48fd940` (current main, including SQLite memory storage).
- Measured optimized implementation: `33c376ec2f0ebcfdfbf0a5e378d3e0e796a71ae0`.
- Host: Apple M4, 10 cores, 16 GiB, macOS arm64; Node v22.14.0; Chrome 155.0.8059.80; rustc 1.90.0 (1159e78c4 2025-09-14).
- Same synthetic fixtures, provider stubs and dependency installation for all variants.
- No real user history, provider requests or external service latency.
- The measured code includes the live-page race fix and the integration with the
  SQLite memory update from main. Earlier pilot results are superseded by this run.

```sh
npm run benchmark:compare -- --baseline 44a006830a0ef2326b22a01f468981b6e48fd940 --trials 7
npm run test:rust
```

The harness requires Chrome and Cargo for the experimental third variant. See
[raw samples and environment metadata](benchmarks/2026-10-19-performance.json),
[resource limits and architecture](performance.md), and the
[Rust experiment](../experiments/rust-transcript/README.md).
