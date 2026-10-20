# Measured performance: 19 October 2026

> Engineering record. Status, measurements and decisions below describe the recorded implementation or review. For current usage, start with the [documentation library](README.md).

The architecture changes improved latest-transcript opening by **1.9×** with
1,000 events and **27.6×** with 5,000 events on this machine.
The experimental Rust reader showed no consistent end-to-end benefit and increased
transcript API latency, so production retains TypeScript. These numbers describe
synthetic history/transcript operations, not provider inference or total coding-task
duration.

## Comparison

Medians of seven fresh-context Chrome trials after one unmeasured warmup per variant.
The endpoint is Playwright’s DOM visibility check for the latest event after opening
Show work; timings include automation polling and are not precise paint timings.

| Workload | Before | Optimized TypeScript | Optimized + Rust experiment |
| --- | ---: | ---: | ---: |
| 20 runs, 1,000 events: latest transcript visible | 444.45 ms | 232.94 ms | 234.59 ms |
| 200 runs, 5,000 events: latest transcript visible | 7,124.48 ms | 257.77 ms | 320.41 ms |
| 200 runs, 100,000 events: latest transcript visible | Timed out (30 s heading wait) | 270.34 ms | 340.54 ms |
| 1,000 events: transcript API | 129.52 ms | 5.53 ms | 9.56 ms |
| 5,000 events: transcript API | 6,314.58 ms | 6.58 ms | 10.46 ms |
| 100,000 events: transcript API | Not measured after UI failure | 7.62 ms | 11.85 ms |
| 20 runs: history search API | 2.50 ms | 1.99 ms | 1.97 ms |
| 200 runs: history search API (5,000-event fixture) | 5.50 ms | 3.99 ms | 3.33 ms |

API medians contain seven requests per successful variant/workload (one per browser
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
| 1,000 events: decoded bytes through latest output | 2.02 MiB | 1.66 MiB | 1.66 MiB |
| 5,000 events: decoded bytes through latest output | 3.56 MiB | 2.02 MiB | 1.85 MiB |
| 1,000 events: JS heap after GC | 4.35 MiB | 4.60 MiB | 4.61 MiB |
| 5,000 events: JS heap after GC | 5.74 MiB | 4.73 MiB | 4.75 MiB |
| 100,000 events: JS heap after GC | Unavailable | 4.76 MiB | 4.76 MiB |

Small-history heap increased **5.7%**; at 5,000 events it decreased
**17.6%**. The cache and paging state have a fixed cost. All successful
variants rendered 200 transcript rows in this fixture; the improvement is not
explained by comparing different visible row counts. Received bytes include decoded
assets and stream traffic, not compressed wire bytes. Heap is the Chrome JavaScript
heap after forced GC, not RSS or total system memory. Startup was sampled only once
per server and is retained in the raw data, not used for a speedup claim.

Browser latest-output ranges (min–max):

| Events | Before | TypeScript | Rust |
| --- | ---: | ---: | ---: |
| 1,000 | 413.63–457.03 ms | 213.88–247.74 ms | 225.48–247.21 ms |
| 5,000 | 6,456.07–8,098.10 ms | 227.98–263.78 ms | 242.07–342.26 ms |
| 100,000 | Timeout | 260.06–351.29 ms | 262.73–344.04 ms |

This is a developer laptop, not an isolated benchmark host. Other applications and
OS activity contribute noise; initial system load averages were
5.62, 5.59, 6.68. Variant order rotates each round and filesystem caches are not
flushed. Small sub-millisecond differences in history API timings should not be
interpreted as reliable Rust benefits. Raw samples are provided rather than a
statistical-significance claim.

## Rust decision

The dependency-free release-mode Rust helper reads the same file backwards and
returns original records and byte offsets over a pipe. The same TypeScript code
then validates and constructs the page. Tests verify parity for Unicode, malformed
records, large previews, step filters, reconnects and pagination. Benchmark timing
includes actual process creation, IPC and termination.

Against optimized TypeScript, Rust transcript API medians were **73% slower**
for 1,000 events, **59% slower** for 5,000, and **56% slower** for 100,000.
Browser samples vary; a small median advantage in an individual workload does not
establish a consistent user-visible improvement across workloads.
The optimized bounded scan is already only a few milliseconds; this process boundary
adds more cost than it removes. This does not establish that Rust itself is slower,
or predict the performance of a persistent native worker, an in-process extension,
or a full rewrite. The experiment remains reproducible but is not enabled in the
production app and adds no Rust installation requirement for users.

## Reproduction and scope

- Baseline: `c300a90ea9c71f940ac9b504ad8b3513b270f257` (main at measurement time, including SQLite memory, result previews and browser scenarios).
- Measured optimized implementation: `0081bb76c33c86c2db16ca04b862ab490cf1920e`.
- Host: Apple M4, 10 cores, 16 GiB, macOS arm64; Node v22.14.0; Chrome 155.0.8059.80; rustc 1.90.0 (1159e78c4 2025-09-14).
- Same synthetic fixtures, provider stubs and dependency installation for all variants.
- No real user history, provider requests or external service latency.
- The measured code includes the live-page race fix and the integration with the
  SQLite memory and result-preview updates from main, plus the archived-compaction
  and shutdown fix found by CI. Earlier pilot results are superseded by this run.

```sh
npm run benchmark:compare -- --baseline c300a90ea9c71f940ac9b504ad8b3513b270f257 --trials 7 --api-repeats 1
npm run test:rust
```

The harness requires Chrome and Cargo for the experimental third variant. See
[raw samples and environment metadata](benchmarks/2026-10-19-performance.json),
[resource limits and architecture](performance.md), and the
[Rust experiment](../experiments/rust-transcript/README.md).

[Documentation library](README.md) · [Development guide](architecture.md)
