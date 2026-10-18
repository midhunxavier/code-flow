# Local API and command-line client

Use `npm run client -- --help` for the HTTP client. It requires the explicit
`CODEFLOW_TOKEN` printed/configured by the server and accepts `CODEFLOW_URL` for
another configured origin. It never reads agent login files. JSON files and
shell arguments are treated as data, not executed. Output files are created
privately and never overwritten.

`/api/v1/*` exposes the same authenticated operations as `/api/*`.
`GET /api/v1/capabilities` lists the new stable operation families. Existing
unversioned clients remain compatible. Authentication, Host, Origin and phone
session checks apply identically to both prefixes.

Paths below are relative to `/api` (or `/api/v1`). Requests with bodies use JSON.
Successful mutations use the status shown where relevant; validation errors use
`400`, missing resources `404`, and explicit concurrency conflicts `409`.
Errors contain an `error` string. No client-side mutation retry is automatic.

| Operation | Request | Behavior |
| --- | --- | --- |
| `POST /improve-prompt` | `repo`, `text`, optional `mode=quick\|repo`, `agent`, `context`, `source`, `execution=local` | Owner-only local prompt rewrite in a disposable private Git directory; returns `{prompt, summary, agent}` after cleanup. |
| `POST /readiness` | `repo`, optional `baseRef`, `setup`, `check`, `execute` | Inspection by default; `execute: true` runs commands in a temporary worktree at a pinned commit. |
| `GET /verification/profile` | `repo`, `preset` query | Detect lightweight, standard or thorough checks. |
| `POST /verification` | `repo`, `profile` or `preset`, optional `baseRef`, `baseline`, `setup`, `repeats` | Execute bounded required gates on isolated checkouts and return structured evidence plus Markdown. |
| `GET /workspace/file` | `repo`, `path` query | Load a bounded regular text file and its hash. |
| `POST /workspace/file` | `repo`, `path`, `text`, `expectedHash` | Save only the loaded version; conflicts return 409. Active run worktrees and symlinks are refused. |
| `POST /workspace/merge-file` | `repo`, `path`, `base`, `draft` | Compute a three-way merge against the current file without writing. Returns `current`, merged `text`, `conflicts`, and `clean`; conflict markers need manual resolution before saving. |
| `GET /workspace/search` | `repo`, `q`, `mode=text\|symbols` query | Bounded text or declaration search with source line numbers. |
| `GET /workspace/dependencies` | `repo` query | Bounded static architecture graph across JavaScript/TypeScript, Python, Go, Rust and Java; packages, cycles and unresolved/computed edges are explicit. |
| `POST /workspace/context` | `repo`, `paths` | Preview explicit file context, approximate token size and sensitive-file omissions. |
| `GET /workspace/checkpoints` | `repo`, optional `ref` query | List exact commit checkpoints. |
| `POST /workspace/apply-checkpoint` | `repo`, `runId`, `source`, `paths`, `expectedHead` | Apply selected files to an idle, clean run worktree without committing. |
| `POST /workspace/checkpoint-hunks` | `repo`, `runId`, `source`, `path` | Preview server-generated hunks for one existing regular text file in an idle run worktree. Returns pinned `head`, `source`, `path`, and bounded `hunks` with IDs. |
| `POST /workspace/apply-hunks` | `repo`, `runId`, `source`, `path`, `expectedHead`, `hunks` | Apply 1–200 distinct preview IDs to a clean, unchanged run checkout. Arbitrary client patches are never accepted; files stay unstaged. |
| `POST /runs/:id/pause` | `paused` | Hold new dispatch at operation boundaries; active work finishes. |
| `POST /runs/:id/priority` | `priority` from -10 to 10 | Update dispatch priority, including waiting work. Equal priorities favor less-busy projects. |
| `POST /runs/:id/fork` | exact `commit`, optional `task` | Begin a child run from an owned checkpoint, retaining source trust restrictions. |
| `POST /runs/:id/revise-goal` | `message`, optional `budget` | Create a new Auto-team run with a user-authored goal revision and prior work references; returns 201 with its `id`. |
| `POST /runs/:id/rerun-tasks` | `expectedHead`, `taskIds`, optional selected-task `instructions`, explicit `budget` | Execute accepted selected tasks and every dependency descendant in a child at the pinned integration commit. Retained work is labeled baseline input; final checks/review are independent. Returns 201 `{id}`. |
| `POST /runs/:id/team-plan` | `revision`, `tasks`, `contracts`, `rationale` | Edit a pending Auto-team plan before dispatch. Keeps member identities and requirements fixed; validates owners, dependencies, paths and acceptance mappings. Returns `team`; stale revisions return 409. |
| `GET /runs/:id/review-coverage` | `branch` query | Return current commit, changed files, reviewed files, percentage, heuristic risk, stale-review indicator and human rework history. Only run-owned branches are allowed. |
| `POST /runs/:id/review-coverage` | `branch`, `expectedHead`, `path`, `reviewed` | Record or remove review of a changed file at that exact commit. Branch movement invalidates prior coverage; stale requests are rejected. |
| `POST /runs/:id/human-rework` | `branch`, `expectedHead`, `minutes`, optional `note` | Append a user-entered correction-time record (1–1,440 minutes, note ≤2,000 characters, at most 100 records/run). Returns 201 with updated coverage. |
| `POST /runs/:id/validate-merge` | `branch`, `into`, optional `allowUntrusted` | Verify the combined result with the current target in a disposable checkout. Returns pinned `source`, `target`, merge `tree`, `report` or `conflicts`. Requires a configured check/profile. |
| `POST /runs/:id/merge` | `branch`, `into`, optional `archiveAfter`, `requireValidation` | Merge an owned result into the selected local branch. `requireValidation: true` requires passing verification for unchanged source/target and the exact merged tree. |
| `GET /runs/:id/export` | optional `transcript=1` query | Export sanitized run metadata, checks, and requested transcript. |
| `GET /approvals` | optional `run` query | Inspect bounded per-action permission requests. |
| `POST /approvals/:id` | `decision=approve\|decline` | Answer one still-active request once; expired or cancelled requests return 409. |
| `GET /notes/history` | `key` query | Read bounded saved note revisions. |
| `GET /notes/search` | `q` query | Search current saved notes. |
| `POST /notes/restore` | `key`, `revision`, `expectedRevision` | Restore a prior note as a new revision. |
| `GET /remote/devices` | none | List paired device metadata, never session credentials. |
| `DELETE /remote/devices/:id` | none | Revoke one device immediately. |
| `GET /diagnostics` | optional `repo` query | Export versions, queue/write health and sanitized recent logs. |

Prompt improvement accepts up to 20,000 input/output characters and a 1,000-character
summary. Context is limited to 50 names of 300 characters; optional source metadata
contains `kind=issue|pr|alert`, integer `number` and a title of at most 200 characters.
Quick mode supplies only the text and metadata; repository mode exports a pinned
committed-HEAD snapshot with a fresh Git namespace. Source Git configuration, hooks,
remotes, history, ignored/untracked content and executable provider configuration
are not copied. Both use safe provider permissions and an in-process repository
mutation lease; cleanup removes only the private directory after failure or
cancellation, never resetting the source checkout or its index. See
[snapshot bounds](getting-started.md#your-first-run). Snapshot preparation has a
60-second deadline. Inherited Git routing/configuration overrides are refused so
the provider cannot accidentally target another checkout through its environment.
Improve also requires absolute, nonempty PATH entries and currently supports
macOS/Linux; Windows is refused until executable discovery is pinned and tested.
Explicit SSH/container profiles return
400, shared accounts return 403, repository/policy conflicts return 409, the three-turn
global concurrency limit returns 429, and provider/snapshot failures return 502.
Closing the request cancels the turn; clients must not automatically retry it.

Verification profiles contain `name`, up to 12 `checks`, optional `setup`, and
up to 48 `requirements`. Each check has a unique `id`, `kind`, `command`, optional
`title`, `required` (default true), and `timeoutMs` (default five minutes, maximum
30 minutes). Kinds are `build`, `typecheck`, `lint`, `unit`, `integration`,
`browser`, `mutation`, `visual`, `accessibility`, and `custom`. A requirement is
`{id, description, checks: [checkId, ...]}`; an empty mapping remains uncovered.
A failed mapped gate or uncovered criterion prevents `verified` status. Repeats
are limited to 1–3; a mixed passing/failing result remains flaky. Baseline
failures are evidence, not permission to ignore a required gate.

Standalone verification pins the requested commit, excludes uncommitted changes,
and runs setup and gates on temporary worktrees. A setup or gate that changes
tracked files, the staged tree, or HEAD is rejected with 409 before subsequent
gates execute. Ignored and untracked generated output is permitted. Setup failure
returns 422. Run-attached profile verification similarly produces a blocked
report on candidate drift. Requirement coverage records the checks selected by
the user; it does not prove those checks semantically exercise the criterion.
Human file coverage is a separate, user-authored commit-bound record.
See [selective task reruns](task-reruns.md) for budget, replay, retained-evidence
and unchanged-result semantics. Client-authored `teamRerun` seeds are never
accepted by run creation.

## Paginated history and event feeds

`GET /runs` keeps the legacy full-list response when no `limit` query is supplied.
With `limit=1..100`, it returns `{runs, total, nextCursor?, nextBefore?}`. Pass the
opaque `nextCursor` as `cursor` on the next request; cursors preserve ties for
runs created in the same millisecond. Optional `q` filters all indexed run
metadata and `project` selects a project. The legacy `before` timestamp is
supported but can omit timestamp ties; prefer `cursor`. Keep filters consistent
between pages. Invalid cursors and page sizes return 400.

`GET /events?limit=1..100` is the bounded SSE run feed. Its initial `hello`
contains the recent page, every running run and at most 100 older attention
items, `total`, `nextCursor`, `attentionTotal`, `attentionTruncated`, and an
optional `attentionNextCursor`. Older attention remains accessible through
history; the rail displays the truncation. Without `limit`, the legacy full
initial list remains available. Policy changes invalidate the feed generation.
Reconnect using `Last-Event-ID`; a valid retained cursor resumes snapshots, while
a stale cursor triggers a fresh `hello`. `GET /runs/:id/events` streams that run's
retained events with a run-bound replay cursor. These are live feeds, not durable
client acknowledgment queues.

## Read-only external sources

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /integrations` | none | List explicitly server-configured provider metadata and availability without credential names or values. |
| `GET /integrations/:id/items` | `kind=issue\|pr`, optional `cursor` query | Return `{items, nextCursor?, truncated}` from a bounded provider listing. Supported kinds depend on the provider. |
| `POST /integrations/:id/import` | `kind`, `key` | Read one item and return 201 with a server-issued source snapshot ID and untrusted marker. |

Run creation accepts `externalSourceId` from the import response, or
`externalSourceRef: {integration, kind, key}` for a server-side import. It rejects
client-authored `externalSource` snapshots, invalid/expired IDs, and simultaneous
ID/ref inputs. Snapshots expire after 30 minutes and the server retains at most
200. Imported context forces Safe permissions, removes secret-file copying, and
requires network-disabled checks in a container or explicit host authorization.
Forks and continuations inherit the trust boundary. Source text is task context;
PR imports do not fetch or check out remote code. See [external source setup and
provider limits](external-sources.md).

## Outbound notifications

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /notifications` | none | List configured destination name/protocol/hostname, availability, opt-in settings, drop count and last failure. No URL paths, tokens, credential references or payloads. |
| `POST /notifications/:id` | `enabled`, `events`, `projects` | Save explicit target opt-in. Events are `done`, `failure`, `needs-attention`; scope is `"all"` or project IDs (`"unassigned"` covers no project). Enabling requires an event and nonempty scope. |
| `GET /notifications/deliveries` | none | List at most 200 delivery metadata records, newest first, without saved message payloads. |
| `POST /notifications/:id/test` | empty body | Explicitly queue a test, including for a disabled destination. Returns 202; delivery proceeds in the background. |
| `POST /notifications/deliveries/:id/retry` | empty body | Explicitly requeue a failed delivery, preserving lifetime attempts and manual-retry count. Returns 202. |

Destinations are configured only through server environment JSON/file with
environment-variable references for HTTPS URLs and credentials. New destinations
are disabled. Delivery uses no redirects, a ten-second timeout and at most three
automatic attempts per batch. Changing the URL requires renewed opt-in. Unknown
outcomes after restart require manual retry; recipients should deduplicate the
persistent `Idempotency-Key`. Notification storage/configuration failure returns
503 and leaves delivery off. See [configuration, disclosure, and delivery
limitations](notifications.md).

## Project memory analysis and revision commands

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /projects/:id/memory` | optional `repo` query | List authorized project entries. A supplied repository must belong to the project. |
| `POST /projects/:id/memory/commands` | `op=create\|approve\|update\|delete\|feedback` plus operation fields | Run user-authorized revision commands. All existing-entry mutations require exact `id` and `expectedRevision`; conflicts return 409. Client authority/origins are not forwarded. |
| `GET /projects/:id/memory/analysis` | `repo` query (optional for a single-repo project) | Return bounded provenance, freshness, duplicates/semantic claims, deletion impact and curated onboarding with exact source revisions and truncation indicators. |
| `POST /projects/:id/memory/analysis/publish` | `repo`, `expectedSources` from `analysis.onboarding.sourceRefs` | Recompute and publish eligible user-authored onboarding guidance with pinned provenance. Changed sources return 409; no eligible sources returns 400. |

Create accepts `repo`, `title`, `body`, optional `paths`, `tags`, and
`applicability`. Update accepts editable fields and optional `accept: true`; an
ordinary edit never accepts a proposal automatically. Feedback accepts `rating`,
optional `note` and `runId`; a run reference must have selected that exact entry
revision. Analysis is heuristic and bounded: lexical similarity does not infer
contradictions on its own. Deterministic semantic claims compare supported
policies and structured boolean/text/numeric intervals only across overlapping
applicability; unsupported prose is counted. Git freshness checks do not
establish semantic correctness. See [supported claims](memory-claims.md).
Publication excludes imported/private/untrusted material and prior onboarding
summaries. Memory APIs remain owner-only; shared project roles use the separate
closed review surface described below.

## Multi-service launch profiles

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /runs/:id/launch-profiles` | `worktree` query | Read `.codeflow/launch.json` from the owned worktree and return `{profiles, found, error?, session}` with sanitized configuration and session logs. |
| `POST /runs/:id/launch-profiles` | `worktree`, `profile`, optional `allowUntrusted` | Start a configured dependency-ordered group; returns 201 with session and assigned local URLs/ports. Locked-down host execution requires explicit authorization. |
| `DELETE /runs/:id/launch-profiles` | `worktree` query | Stop the owned launch session and return `{stopped}`. |

Profiles configure at most six services and bounded commands, relative working
directories, dependencies, environment values and optional local HTTP health
checks. The server assigns ports and peer URL variables. This starts local
processes; it is not remote deployment or hosting. See [launch profile
configuration and lifecycle](launch-profiles.md).

## Automation inspection and replay

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /automations` | none | List configured local schedules and webhook triggers. |
| `POST /automations` | `name`, `run`, `schedule` and/or `webhook`, optional `enabled`, `isolate`, `image` | Validate saved run settings and create a trigger (201). |
| `POST /automations/:id` | changed fields; optional `rotateToken` | Update validated settings or rotate the webhook credential. |
| `POST /automations/schedule-preview` | `schedule`, optional `after`, `count` | Return `{times}` (at most ten UTC millisecond timestamps) without scheduling work. |
| `POST /automations/:id/preview` | optional webhook event input | Dry-run saved settings, selected sweep items, permissions and limits without starting runs or consuming the event. |
| `GET /automations/:id/events` | none | Inspect bounded persistent event records including queued, started, failed and dropped deliveries. |
| `POST /automations/:id/events/:eventId/retry` | empty body | Replay an eligible saved event through the same validation, deduplication and queue limits. |
| `POST /automations/:id/run` | empty body | Explicitly fire now; returns 201 with run IDs, or 409 if skipped. |
| `DELETE /automations/:id` | none | Remove the trigger. |

Daily schedules use `{at: "HH:MM", timezone?: "IANA/Zone", days?: [0..6]}`;
Sunday is zero and an explicit empty weekday list is invalid. Omitted timezone
uses server local time. Interval schedules use `{every: minutes}`. During a
repeated local clock time, a daily schedule fires once on its first occurrence;
a missing local time shifts forward by the clock gap. Webhook event history
keeps at most 100 records and the pending queue at most ten. Replay preserves the
saved event content, while rechecking current configuration and limits. It never
merges results automatically.

Run creation accepts `loop.verification`, `loop.maxTokens`, `loop.maxCostUsd`,
`loop.agentContainer`, and explicit `approvals.tools`. Token/cost limits count
only provider-reported usage and are checked between operations. API-equivalent
cost is not a subscription charge. Automated and locked-down runs never wait for
native tool permissions. See [agent containers](agent-containers.md),
[external sources](external-sources.md), and [maintenance](maintenance.md).

The client has no automatic retry for mutations. A dropped response is not proof
that an operation did not execute; inspect the run before repeating a creation.

## Shared identities and project review

`GET /auth/self`, `POST /auth/login {username,password}` and `POST /auth/logout`
bootstrap the local viewer/reviewer dashboard. Login sets a distinct session
cookie; tokens and password/session hashes are never returned. Shared sessions
require actual TLS or a direct loopback connection without forwarding headers.
Owner account administration uses `GET/POST /accounts`, `PUT /accounts/:id`, and
`POST /accounts/:id/revoke-sessions`, with the current account-state `revision`.

Shared routing is a closed allowlist. Project/run lists, result detail, safe
events, diffs, coverage and exports are scoped before counts and cursors.
Reviewers may record file coverage and `POST /runs/:id/collaboration
{branch,expectedHead,text}`; both recheck current project membership and owned
result HEAD. `GET` returns the separate human discussion. These comments never
resume an agent. All execution, administrative and private-context operations
remain owner-only. See [roles, projections and session limits](shared-projects.md).

## Explicit workers, coordination and extensions

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /remote-workers` | none | List explicitly configured SSH targets without private capabilities. |
| `POST /remote-workers/:id/probe` | `repoMapping` | Probe the provisioned worker and its own provider inventory. |
| `POST /runs/:id/remote-steps/:step/receipt` | empty body | Inspect an accepted execution receipt; never replay the turn. |
| `POST /runs/:id/remote-steps/:step/cancel` | empty body | Explicitly request cancellation and inspect its receipt. |
| `GET /coordinated-changes` | none | List durable multi-repository jobs and their current claims. |
| `POST /coordinated-changes` | `project`, `name`, `nodes`, optional `operationId` | Create 2–10 explicitly configured repository tasks with a verified dependency DAG. |
| `POST /coordinated-changes/:id/cancel` | `expectedRevision` | Cancel further dispatch; preserve accepted execution receipts. |
| `POST /coordinated-changes/:id/shipping-preview` | `expectedRevision`, `targets` | Validate the current source/target/tree matrix without merging. |
| `POST /coordinated-changes/:id/nodes/:node/retry` | `expectedRevision`, optional `acknowledgeUnknown` | Explicitly retry after inspecting an uncertain claim. |
| `POST /coordinated-changes/:id/nodes/:node/attach` | `expectedRevision`, `runId` | Attach only an exact matching durable launch receipt. |
| `POST /coordinated-changes/:id/nodes/:node/ship` | `expectedRevision`, `previewId` | Merge one unchanged verified local candidate; no automatic remote push. |
| `POST /coordinated-changes/:id/nodes/:node/recover-shipping` | `expectedRevision`, `commit` | Confirm the exact reviewed parents/tree after an uncertain local merge. |
| `GET /extensions` | none | Inspect host API version and explicitly configured trusted provider/workflow bundles. |

Runs select SSH using `loop.remoteWorker: {workerId,repoMapping}`. Worker
credentials stay on the provisioned worker; accepted turns are never retried
automatically after a disconnected transport. See [worker setup and receipt
recovery](remote-workers.md). Coordination ships each repository separately;
there is no atomic transaction across repositories. See [coordinated
changes](coordinated-changes.md). Extension installation is server configuration,
not an HTTP operation; immutable version/hash pins are rechecked before
execution. See [trusted extension contracts](extensions.md).

## Code-host review and publication

Owner-only `GET /code-hosts` lists configured GitLab/Bitbucket code adapters and
safe operation receipts. `POST /code-hosts/preview {integration,key,repo,project?}`
creates a short-lived server snapshot. `POST /code-hosts/:id/fetch` imports exact
source/target Git objects without executing them; `/:id/run` accepts the prepared
agent container and required verification configuration. `/:id/review` performs
an explicit supported comment, reply, thread resolution or GitLab approval.

Push and merge each have distinct `/:id/push-preview` or `/:id/merge-preview`
operations taking `runId` and an owned `branch`; their actions require the
returned `planId`. `POST /code-hosts/create-preview` takes `integration`, `runId`,
`branch`, `targetBranch`, `title`, and `body`; `/:id/create` explicitly creates
the expected-absent source branch and native PR. An unknown receipt can only be
acknowledged explicitly at `/code-hosts/history/:id/acknowledge` with
`{acknowledge:true}`. No startup replay occurs.

Git updates use exact expected-ref leases. Merge is a pinned Git merge and may
leave provider PR closure pending; native merge queues and atomic provider-policy
snapshots are not claimed. Unsupported/unknown protected-branch policies fail
closed. See [provider-specific operations and limits](code-hosts.md).

GitHub threads use `GET /runs/:id/pr-threads?branch=<owned-branch>` and `POST` with
`{action:"load",snapshotId,threadId}` or
`{action:"resolve",snapshotId,threadId,expectedHead,expectedRevision,resolved}`.
Resolution rechecks fresh remote state and reports postflight uncertainty.
See [thread pagination, permissions and mutation races](github-review-threads.md).

## Filesystem policies

Owner-only `GET /projects/:id/filesystem-policy` returns the committed policy.
`PUT` accepts `{revision,read:{allow,deny},write:{allow,deny}}` with literal
repository-relative paths. Policies intersect across matching projects and
pinned run snapshots. App file/tree/search/write/diff access rechecks current
rules; raw history and other unfilterable evidence are withheld. Custom
restrictions pause ordinary application-managed execution globally, including
background preparation. See [activation, execution boundaries and HTTP error
semantics](filesystem-policy.md).

Restricted execution uses a separate owner-only manual task surface:

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /filtered-tasks` | optional `project` query | Return bounded lifecycle/receipt metadata; historical source/output content is not listed. |
| `POST /filtered-tasks` | `project`, `repo`, `task`, `agent`, `image`, optional `network`, `maxMinutes` | Prepare a filtered committed snapshot and return 202 after a durable claim; only built-in providers and an explicit local immutable image are supported. |
| `GET /filtered-tasks/:id` | none | Read task/output under unchanged current canonical policy and project membership. |
| `POST /filtered-tasks/:id/preview-import` | empty body | Validate source/result/policy and preview bounded allowed file changes. |
| `POST /filtered-tasks/:id/import` | `revision`, `expectedHead`, `resultHash` | Create a new review branch with an atomic exact-source ref transaction; leave checkout and index unchanged. |
| `POST /filtered-tasks/:id/cancel` | `revision` | Cancel preparation/execution and confirm the owned daemon container is absent. |
| `POST /filtered-tasks/:id/receipt` | `revision` | Explicitly inspect an interrupted branch-import receipt; never replay a provider turn. |
| `DELETE /filtered-tasks/:id` | JSON `revision` | Remove a stopped terminal task's private export/record; preserve any imported review branch. |

The task container receives only permitted committed regular files and a new Git
object database. It mounts no original repository metadata, host login directory,
authentication volume or application memory. The image layer and copied files
denied writes are read-only. Network starts off; enabling inference access is an
explicit owner choice. Input/output limits are 500 files, 512 KiB per file and
16 MiB total; live monitoring is a polling safeguard, not a filesystem quota.
Restarted effectful phases become unknown and require explicit inspection or
cancellation. See [runtime provisioning, recovery and limitations](filesystem-policy.md).
