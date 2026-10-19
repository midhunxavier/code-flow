# Measured performance: 19 October 2026

The architecture changes improved latest-transcript opening by **3.3×** with
1,000 events and **26.0×** with 5,000 events on this machine.
The experimental Rust reader did not improve this workload, so production retains
TypeScript. These numbers describe synthetic history/transcript operations, not
provider inference or total coding-task duration.

## Comparison

Medians of seven fresh-context Chrome trials after one unmeasured warmup per variant:

| Workload | Before | Optimized TypeScript | Optimized + Rust experiment |
| --- | ---: | ---: | ---: |
| 20 runs, 1,000 events: latest transcript visible | 979.77 ms | 293.61 ms | 302.11 ms |
| 200 runs, 5,000 events: latest transcript visible | 9,541.80 ms | 367.53 ms | 383.86 ms |
| 200 runs, 100,000 events: latest transcript visible | Timed out (30 s heading wait) | 408.02 ms | 432.77 ms |
| 1,000 events: transcript API | 203.89 ms | 5.70 ms | 9.20 ms |
| 5,000 events: transcript API | 8,879.75 ms | 7.17 ms | 10.60 ms |
| 100,000 events: transcript API | Not measured after UI failure | 8.63 ms | 12.87 ms |
| 20 runs: history search API | 1.75 ms | 1.46 ms | 1.22 ms |
| 200 runs: history search API (5,000-event fixture) | 4.78 ms | 2.44 ms | 2.33 ms |

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
| 5,000 events: decoded bytes through latest output | 3.53 MiB | 1.82 MiB | 1.82 MiB |
| 1,000 events: JS heap after GC | 4.33 MiB | 4.59 MiB | 4.59 MiB |
| 5,000 events: JS heap after GC | 5.72 MiB | 4.74 MiB | 4.74 MiB |
| 100,000 events: JS heap after GC | Unavailable | 4.75 MiB | 4.75 MiB |

Small-history heap increased **6.0%**; at 5,000 events it decreased
**17.1%**. The cache and paging state have a fixed cost. All successful
variants rendered 200 transcript rows in this fixture; the improvement is not
explained by comparing different visible row counts. Received bytes include decoded
assets and stream traffic, not compressed wire bytes. Heap is the Chrome JavaScript
heap after forced GC, not RSS or total system memory. Startup was sampled only once
per server and is retained in the raw data, not used for a speedup claim.

Browser latest-output ranges (min–max):

| Events | Before | TypeScript | Rust |
| --- | ---: | ---: | ---: |
| 1,000 | 532.57–1,009.12 ms | 278.67–353.26 ms | 271.22–363.27 ms |
| 5,000 | 8,076.10–12,642.95 ms | 241.54–1,030.41 ms | 335.25–986.40 ms |
| 100,000 | Timeout | 317.61–519.21 ms | 389.53–489.95 ms |

This is a developer laptop, not an isolated benchmark host. Other applications and
OS activity contribute noise; initial system load averages were
8.54, 9.39, 10.65. Variant order rotates each round and filesystem caches are not
flushed. Small sub-millisecond differences in history API timings should not be
interpreted as reliable Rust benefits. Raw samples are provided rather than a
statistical-significance claim.

## Rust decision

The dependency-free release-mode Rust helper reads the same file backwards and
returns original records and byte offsets over a pipe. The same TypeScript code
then validates and constructs the page. Tests verify parity for Unicode, malformed
records, large previews, step filters, reconnects and pagination. Benchmark timing
includes actual process creation, IPC and termination.

Against optimized TypeScript, Rust transcript API medians were **61% slower**
for 1,000 events, **48% slower** for 5,000, and **49% slower** for 100,000.
The optimized bounded scan is already only a few milliseconds; this process boundary
adds more cost than it removes. This does not establish that Rust itself is slower,
or predict the performance of a persistent native worker, an in-process extension,
or a full rewrite. The experiment remains reproducible but is not enabled in the
production app and adds no Rust installation requirement for users.

## Reproduction and scope

- Baseline: `71ca4017c29c804ce7343ce88990b94d731557da` (main before this performance branch).
- Measured optimized implementation: `489c8edf29360e7077421cc226882edcb0b078b2`.
- Host: Apple M4, 10 cores, 16 GiB, macOS arm64; Node v22.14.0; Chrome 155.0.8059.80; rustc 1.90.0 (1159e78c4 2025-09-14).
- Same synthetic fixtures, provider stubs and dependency installation for all variants.
- No real user history, provider requests or external service latency.
- A subsequent feed fix preserves live events while paging requests fail or race a
  Latest response. It is covered by regression tests; it does not change the
  completed-run path measured above. The numbers remain pinned to the measured commit.

```sh
npm run benchmark:compare -- --baseline 71ca4017c29c804ce7343ce88990b94d731557da --trials 7
npm run test:rust
```

The harness requires Chrome and Cargo for the experimental third variant. See
[raw samples and environment metadata](benchmarks/2026-10-19-performance.json),
[resource limits and architecture](performance.md), and the
[Rust experiment](../experiments/rust-transcript/README.md).
