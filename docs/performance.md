# Performance and resource boundaries

The backend remains Node/TypeScript and the UI remains Preact. Execution journals,
provider receipts and repository leases retain their existing authority. The changes
below reduce repeated work and bound presentation buffers without changing agent
permissions, verification requirements or retrying ambiguous remote executions.

## History and transcripts

`RunIndex` maintains ordered run summaries, complete normalized search text and
repository/worktree membership. Ordinary updates replace the indexed record without
sorting every run again. Unfiltered history uses a binary cursor lookup; filtered
search still scans the in-memory search strings. Only the selected page is cloned.
Authorization filtering precedes totals and pagination.

Cold projections now include their full searchable text. Legacy cold indexes hydrate
once during asynchronous startup to obtain that text. Listing and searching no longer
read every cold detail file or synchronously validate every archived source. Opening
a detail or using it for an operation still validates the source and rebuilds stale
projections. HTTP detail hydration uses asynchronous I/O; synchronous compatibility
remains for existing internal mutation callers. Indexes grow with run count, and
live/resumable runs still retain their execution metadata.

New UI subscriptions use `run-page:<id>`. The initial frame contains the latest run
and step snapshots, a recent transcript page, and persistence status. A reconnect
reuses a sequence cursor if the missed events fit the page; otherwise it explicitly
resets to a recent page. The old `run:<id>` topic and per-run events endpoint remain
available for older clients. Those legacy endpoints and full exports still load full
history; they are not the bounded UI path.

`GET /api/runs/:id/transcript?step=:step&before=:cursor` reads backwards directly from
a file offset. The opaque cursor binds the offset to the run and file identity.
Appending does not invalidate older pages; replacing/compacting a log does, returning
409 so the viewer can reload Latest. There is no initial full scan or separate index
file to recover. Partial pages can be empty when a bounded scan crosses only metadata
or events from other steps; their continuation cursor still advances.

Default limits:

| Resource | Bound |
| --- | --- |
| Transcript response | 500 events and 1 MiB of event JSON |
| Scan per page | 16 MiB, plus the record crossing the boundary |
| Individual log record | 64 MiB |
| Displayed event string | 32 Ki UTF-16 units, with a visible omission notice |
| Browser transcript cache per run | 8 MiB estimated serialized memory / 10,000 events |
| Idle browser run feeds | Six feeds, within a 32 MiB estimate |
| Initial transcript rows | 200; older pages replace the step window |
| Global run replay ring | 500 snapshots / 32 MiB serialized data |

Complete event text remains in the authoritative log and full export. Historical
step windows do not append live text into an older page; Latest returns to current
events. A tool result whose call is outside the page is still displayed explicitly.
The estimates bound retained payloads, not total JavaScript heap or DOM allocation.

## Streaming and storage

SSE stops writing when Node reports backpressure, resumes in order on `drain`, and
disconnects a client whose queued plus writable bytes exceed the budget. The default
is 8 MiB per connection (`CODEFLOW_SSE_BUFFER_BYTES`). The existing
`CODEFLOW_SSE_STALL_MS` timeout also applies. An individual oversized frame is refused
by the same bound. Slow consumers never block agent execution.

Disk writes are ordered by run ID, including that run's event log and execution
journal. Up to four unrelated runs can write concurrently. Ordinary contiguous
appends batch up to 128 records / 256 KiB. Synced writes, rewrites and deletion form
ordering boundaries. The append backlog has a 64 MiB byte budget: overflow is a
reported write failure, and strict journal callers fail closed.

Optional startup checkpoints use a separate single-writer queue with a 32 MiB
payload admission budget. Their captured source identity prevents a stale checkpoint
from describing newer events. Durability barriers can be scoped to a run; reading
transcripts waits for that run's appends without fsyncing every other run. Shutdown
still flushes writes. The run view reports saving and persistence failures separately
from workflow completion.

## UI and analysis

The UI build produces hashed ESM chunks and a hashed stylesheet. Settings, Terminal,
Browser and Changes load on demand. Assets have immutable caching, compression,
ETags and a bounded server cache. HTML remains revalidated. Old chunks remain on the
local build directory for already-open tabs; SSH release packages include only the
current manifest's files. Packaging checks that HTML and manifest belong together.

Code intelligence reuses at most two isolated TypeScript workers, each with the
existing 192 MiB heap limit. Every request still checks and reads the current allowed
saved sources. Only changed source text and removals are sent to the language service.
This preserves freshness and filesystem checks without rebuilding the service each
time. Workers expire after 60 seconds idle and are terminated on cancellation,
timeout, policy changes and server shutdown. Only one inspection runs at a time.

Shared polling waits for completion before scheduling another request, pauses in
hidden tabs and refreshes when visible. Background inventories explicitly opt in to
sharing concurrent identical GETs; selection-sensitive reads always issue fresh requests.
Mutations invalidate the request-sharing map. Writes are never automatically retried.

## Measurement and verification

`/api/health` includes bounded HTTP timing samples, event-loop delay/utilization,
process memory, disk queue depth/bytes, slow-client disconnects, storage-cache counts
and language-worker reuse counts. Settings diagnostics include this snapshot and
browser shell-ready/long-task measurements. Metrics contain no request bodies or
query strings. These are local diagnostic counters, not exported telemetry.

Run:

```sh
npm run build
npm run benchmark:performance
npx tsx --test test/performance-boundaries.test.ts test/transcript-pages.test.ts
npx tsx --test test/e2e/history-launch.e2e.ts
```

The benchmark uses a temporary synthetic home, 10,000 indexed runs and 100,000
transcript events. It reports timings, scanned/response bytes and built asset sizes;
it does not access the user's actual run history or invoke providers. Treat timings
as machine-dependent observations. The deterministic tests enforce ordering, buffer
bounds, cursor correctness and failure behavior instead of fragile timing thresholds.

Further optimization should follow real profiles. SQLite-backed search, Rust modules,
additional worker offloading and adaptive process limits remain architectural options,
not requirements for these bounded paths.

## Before/after and native comparison

`npm run benchmark:compare -- --baseline <commit> --trials 7` builds the baseline
from a Git archive, the current TypeScript app, and a temporary copy with the
experimental Rust transcript reader. It uses identical synthetic fixtures and real
HTTP servers plus Chrome. One browser warmup precedes repeated fresh browser
contexts, and variant order rotates. The OS filesystem cache remains warm. Default
fixtures have 1,000, 5,000 and 100,000 events. `--scenarios small,medium` selects a
subset. Raw samples, machine/tool versions, commit IDs and failures are saved to
`output/performance/comparison.json`; `--output` overrides that destination.

The UI measurement ends when the latest event is visible after opening Show work.
The old app transfers/replays all events; the new app transfers a bounded latest
page with Earlier navigation. API timing likewise compares full replay to the
latest page, not equal-size responses. Browser received bytes are decoded resource
bytes, not compressed wire bytes. Heap is JavaScript heap after forced GC, not
whole-process memory. Timeouts are failures, never silently replaced with a timing.
Agent execution and provider inference are excluded. See the Rust experiment's
[README](../experiments/rust-transcript/README.md) for its scope and parity test.
