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
| `POST /runs/:id/provider-chat` | `agent`, optional `settings: {model, effort}`, `message` | Start a single-agent child with another provider, a portable conversation transcript, saved context files and a new worktree from the source result commit. Requires an idle source and clean worktree; retains project, computer and permission restrictions. Provider sessions and side-chat transcripts are excluded. |
| `POST /runs/:id/fork` | exact `commit`, optional `task` | Begin a child run from an owned checkpoint, retaining source trust restrictions. |
| `POST /runs/:id/revise-goal` | `message`, optional `budget` | Create a new Auto-team run with a user-authored goal revision and prior work references; returns 201 with its `id`. |
| `POST /runs/:id/rerun-tasks` | `expectedHead`, `taskIds`, optional selected-task `instructions`, explicit `budget` | Execute accepted selected tasks and every dependency descendant in a child at the pinned integration commit. Retained work is labeled baseline input; final checks/review are independent. Returns 201 `{id}`. |
| `POST /runs/:id/team-plan` | `revision`, `tasks`, `contracts`, `rationale` | Edit a pending Auto-team plan before dispatch. Keeps member identities and requirements fixed; validates owners, dependencies, paths and acceptance mappings. Returns `team`; stale revisions return 409. |
| `GET /runs/:id/review-coverage` | `branch` query | Return current commit, changed files, reviewed files, percentage, heuristic risk, stale-review indicator and human rework history. Only run-owned branches are allowed. |
| `POST /runs/:id/review-coverage` | `branch`, `expectedHead`, `path`, `reviewed` | Record or remove review of a changed file at that exact commit. Branch movement invalidates prior coverage; stale requests are rejected. |
| `POST /runs/:id/human-rework` | `branch`, `expectedHead`, `minutes`, optional `note` | Append a user-entered correction-time record (1–1,440 minutes, note ≤2,000 characters, at most 100 records/run). Returns 201 with updated coverage. |
| `POST /runs/:id/validate-merge` | `branch`, `into`, optional `allowUntrusted` | Verify the combined result with the current target in a disposable checkout. Returns pinned `source`, `target`, merge `tree`, `report` or `conflicts`. Requires a configured check/profile. |
| `POST /runs/:id/merge` | `branch`, `into`, optional `archiveAfter`, `requireValidation` | Merge an owned result into the selected local branch. `requireValidation: true` requires passing verification for unchanged source/target and the exact merged tree. |
| `POST /runs/:id/archive` | `archived`, optional `cleanup`, `deleteBranches` | Archive or unarchive a finished run. Use `cleanup: false` to hide it while keeping worktrees and branches. |
| `DELETE /runs/:id` | — | Permanently remove a finished run's conversation/history and private run memory. Active runs are rejected. Git branches, worktrees and repository files remain. Run-list streams publish a summary with `deleted: true`; clients remove that ID. |
| `GET /runs/:id/export` | optional `transcript=1` query | Export sanitized run metadata, checks, and requested transcript. |
| `GET /approvals` | optional `run` query | Inspect bounded per-action permission requests. |
| `POST /approvals/:id` | `decision=approve\|decline` | Answer one still-active request once; expired or cancelled requests return 409. |
| `GET /notes/history` | `key` query | Read bounded saved note revisions. |
| `GET /notes/search` | `q` query | Search current saved notes. |
| `POST /notes/restore` | `key`, `revision`, `expectedRevision` | Restore a prior note as a new revision. |
| `POST /remote/tls` | `{mode: "tailscale"}` or `{mode: "import", hostname, cert, key}` with PEM strings | Local owner only. Validate and save HTTPS configuration, rotate pairing, disable full control and reload the network listener without restarting runs. Tailscale mode uses the connected computer's DNS name. Environment-managed TLS cannot be replaced here. Returns remote status and public certificate metadata, never PEM material. |
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

## Team collaboration

A team board served by one code-flow instance (the team server) and the linked
runners on teammates' computers share the routes below. Browser sessions (the
owner and shared accounts) and per-machine runner credentials
(`Authorization: Bearer tr-…`) use the same paths; the table says who may call.
A runner credential reaches only `/team/*` and the enrolment route; every other
API route answers 403 "This credential only reaches the team API", and the pages
treat it as an anonymous visitor. The owner token is matched before a bearer is
read as a runner credential. Runner mutations send
`content-type: application/json` (the bundle upload `application/octet-stream`)
and need no Origin header; browser mutations keep the same-origin JSON
requirement of shared accounts. Board tasks are visible only in projects where
the caller holds a role; people appear as an account id and display name, never
with paths, transcripts, tokens or hashes. `/v1/team/*` and `/v1/team-link/*`
aliases work, and `GET /v1/capabilities` lists the family as
`team-collaboration`.

| Operation | Request | Behavior |
| --- | --- | --- |
| `POST /team/runners/connect` | `username`, `password`, `name` | Anonymous enrolment over HTTPS or loopback: verifies the credentials like sign-in without creating a session, requires a contributor role in some project, and returns 201 with the runner, its credential (shown once), the user and the server's name. |
| `GET /team/me` | none | The caller's identity, project roles and own runners. |
| `GET /team/board` | optional `project` query | The board: the projects where the caller holds a role with their members and repository keys, task cards with the current attempt, latest checkpoint and hand-over, and the unread inbox count (viewer). |
| `GET /team/tasks/:id` | none | The full task (viewer in its project). |
| `POST /team/tasks` | `projectId`, `repository`, `title`, `goal`, `acceptance`, optional `baseRef`, `owner`, `reviewer`, `collaborators`, `dependsOn`, `labels`, `status` | Create a task (contributor); 201. |
| `PUT /team/tasks/:id` | `revision` plus the changed fields | Partial save under the status and ownership rules; `null` clears an optional field. |
| `DELETE /team/tasks/:id` | `revision` | Delete a task (maintainer); `{deleted: true}`. |
| `POST /team/tasks/:id/comments` | `text` | Comment, with `@username` mentions (reviewer). |
| `POST /team/tasks/:id/decisions` | `text` | Record a decision (contributor). |
| `POST /team/tasks/:id/review-request` | `reviewer`, `revision` | Ask a teammate to review (contributor). |
| `POST /team/tasks/:id/reviews` | `checkpointId`, `verdict=approve\|request-changes`, `text`, `revision` | Record a review against a checkpoint (reviewer). |
| `POST /team/tasks/:id/instructions` | `text` | Propose a **Send to agent** instruction (contributor); the task owner's own are approved at once. |
| `POST /team/tasks/:id/instructions/:iid` | `action=approve\|decline\|delivered`, optional `attemptId` | Approve or decline (the task owner or a maintainer); `delivered` is recorded by the attempt's runner. |
| `POST /team/tasks/:id/attempts` | `attemptId`, `runnerId`, `runnerName`, `baseCommit`, optional `fromCheckpointId`, `revision` | Claim an attempt (the task owner through their runner, or the server's owner in-process as runner `local`); idempotent on `attemptId`; 201. Refused (409) while another attempt is claimed, running or unknown, while a hand-over is offered, and on a Done task. |
| `POST /team/attempts/:aid/progress` | `seq`, optional `runId`, the progress fields | Publish a numbered progress snapshot (the attempt's runner); a late number is ignored. A report that would revive a paused, stopped or unknown attempt is refused (409) while another attempt of the task is claimed, running or unknown or a hand-over is offered, on a Done task (409 "Move the task out of Done before resuming the attempt"), and for a machine whose user no longer owns the task (403 "The task now belongs to `<name>`; they continue it from its latest checkpoint, or a project maintainer reassigns it"). |
| `POST /team/attempts/:aid/heartbeat` | empty body | Keep the attempt live; returns the approved, undelivered instructions. |
| `POST /team/attempts/:aid/finish` | `state`, optional `head`, `summary`, `reason` | End the attempt as finished, failed, stopped, paused or unknown. |
| `POST /team/attempts/:aid/recover` | `revision`, `reason`, `confirmedStopped=true` | Recover an unknown attempt after confirming its original execution stopped (task owner or project maintainer). Supersedes it, records the decision and releases the task; stale revisions or a reconnected runner return 409. |
| `POST /team/attempts/:aid/checkpoints` | optional `id`, `commit`, `baseCommit`, `branch`, `size`, `sha256`, `note`, `requirements`, `decisions`, optional `testResults`, `remaining`, `changedFiles` | Register a checkpoint manifest with `bundle: "pending"` (the attempt's runner); 201. `id` (32 lowercase hexadecimal characters) becomes the checkpoint's id and ref `refs/codeflow/team/<id>`; an id already on the board is refused (409), a malformed one 400, and without one the server generates the id. |
| `PUT /team/checkpoints/:cid/bundle` | `application/octet-stream` body, `x-codeflow-sha256` header | Stream the bundle to disk (the checkpoint's runner); size and digest are verified before the checkpoint becomes available. A refusal (415, 400 on a size or digest mismatch, 409 when already uploaded or deleted, 507 when storage is full, 503 when the file could not be stored) is answered at once and the declared body is then drained, so a retry reads the answer; a body without a content-length (411) or declared over 64 MiB (413) is cut off once the answer is written. |
| `GET /team/checkpoints/:cid` | none | The checkpoint manifest (viewer). |
| `GET /team/checkpoints/:cid/bundle` | none | Download the bundle with `content-length` and `x-codeflow-sha256` (contributor). |
| `DELETE /team/checkpoints/:cid` | none | Delete a checkpoint and its bundle (maintainer); `{deleted: true}`. |
| `POST /team/tasks/:id/handoff` | `to`, `checkpointId`, `note`, `revision` | Offer a hand-over from an available checkpoint of the task (the task owner or a maintainer); refused while an attempt runs. |
| `POST /team/tasks/:id/handoff/:hid` | `action=accept\|decline\|cancel`, `revision` | Accept or decline (the recipient); cancel (the sender or a maintainer). |
| `GET /team/inbox` | optional `after` query | The caller's inbox items and unread count. |
| `POST /team/inbox/read` | `ids`, or `all: true` | Mark the caller's items read; returns `{unread}`. |
| `GET /team/runners` | none | The caller's runners; only the hub owner sees all. |
| `DELETE /team/runners/:id` | none | Revoke a runner (its user or the hub owner); `{revoked: true}`. |
| `PUT /team/projects/:id/repositories` | `repositories`, `revision` | Define the project's repository keys (maintainer). |
| `PUT /team/profile` | `displayName` | The owner's display name on the board (owner). |
| `GET /team/events` | optional `after=<epoch:seq>` query | Server-sent events for the caller: `hello` with the epoch and sequence, then `change` events for the board and tasks in the caller's projects and `inbox` unread counts; a cursor the server no longer holds gets `resync`. Closed when the account changes or the runner is revoked, and when 2 MiB of frames wait on the socket. |

Mutations return the updated task and carry the task `revision`; a stale one
fails with 409 "Task changed; reload before saving". A missing role answers 403
naming the role, an unknown or invisible id 404 "Task not found", an unknown
team route 404 "Unknown team operation" (never falling through to owner routes)
and unavailable team storage 503. Task saves and repository keys accept 64 KiB
bodies, progress reports 192 KiB, checkpoint manifests 1.25 MiB, bundles 64 MiB,
enrolment 8 KiB and other routes 16 KiB; a board file at its 16 MiB limit refuses
every change with 413. Progress reports and heartbeats do not change the task
revision.

On a linked computer the owner's `/team/*` requests are forwarded to the team
server with the runner credential, and the owner-only local routes below drive
execution; on the team server itself the same routes work in-process and
`linked` is false.

| Operation | Request | Behavior |
| --- | --- | --- |
| `GET /team-link` | none | The link: `linked`, the server address, user, server name, machine name, mappings and defaults, the connection state, the runner as the server reports it, the last sync and the last error. |
| `POST /team-link/connect` | `url`, `username`, `password`, optional `name` | Enrol this computer: `https://` only (plain `http://` for loopback), never following a redirect and only with a trusted certificate (502 otherwise), refused (409) while already connected or while the local board has tasks; saves the link and starts the change stream and reconciliation; 201. |
| `DELETE /team-link` | none | Revoke the runner on the server (best effort) and forget it here; mappings, defaults and local attempt records stay. |
| `PUT /team-link/mappings` | `projectId`, `repository`, `path` | Map a repository key to an absolute folder that is a Git repository. |
| `POST /team-link/tasks/:id/start` | optional `repo`, `pattern`, `roles`, optional `agentSettings`, `roleSettings`, `trust`, `loop` (`check`, `setup`, `maxMinutes`, `maxSteps`), `fromCheckpointId` | Claim an attempt and start the run here; returns `{attemptId, runId}`; 201. Refused (400) before anything is claimed when the repository cannot carry checkpoints (a submodule, a checkout filter such as Git LFS, or a tree over 20,000 files, 256 MiB or 100 attribute files). |
| `POST /team-link/tasks/:id/stop` | empty body | Cancel the current attempt's run (resumable) and record it as paused. |
| `POST /team-link/tasks/:id/resume` | empty body | Resume this computer's paused, stopped or unknown attempt of the task under the same attempt id; refused (409) when the attempt was superseded or has ended, the task changed hands or is Done, another attempt is busy or a hand-over is offered. |
| `POST /team-link/tasks/:id/handover` | `to`, `note`, optional `includeUncommitted` | Create or reuse the checkpoint (a retry uploads the kept bundle), then offer the hand-over. |
| `POST /team-link/tasks/:id/accept` | `handoffId`, optional `repo` | Download and import the checkpoint, then accept the offer. |
| `POST /team-link/checkpoints/:id/fetch` | `repo` | Import a checkpoint and point `team/<task id>/<first 8 characters of the checkpoint id>` at it; returns `{commit, branch, taskId, created}`. |
| `GET /team-link/attempts` | none | This computer's attempt records: which run belongs to which attempt, and what has been published. |
| `POST /team-link/reconcile` | empty body | Run the recovery pass now: settle claims whose answer was lost and retry unacknowledged finishes; returns `{attached, finished, removed, unknown, retried}`. |

Nothing here replays automatically: a restart, the recovery pass that runs every
minute and `POST /team-link/reconcile` reconcile local attempt records with the
team server and never start a run again. See [team
collaboration](team-collaboration.md) for roles, hand-overs, checkpoints and
limits.

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

## SSH projects

Owner-only connection management is available on the local listener. SSH host
backends and phone/shared sessions cannot manage additional SSH connections.

| Endpoint | Input | Result |
| --- | --- | --- |
| `GET /workspace-projects` | none | Local and connected remote project IDs and names, grouped by computer; never repository paths or credentials. |
| `GET /ssh-hosts` | none | Saved host IDs, names, aliases and connection state, plus concrete aliases discovered from SSH config. |
| `POST /ssh-hosts` | `sshHost`, optional `name` | Save an alias or `user@hostname`; port/key/jump configuration stays in OpenSSH. |
| `POST /ssh-hosts/:id/connect` | none | Install or reuse the remote backend and return a stable, same-origin `/computer/:id/` workspace path. |
| `POST /ssh-hosts/:id/disconnect` | none | Close SSH channels and preview forwards, leaving remote work running. |
| `POST /ssh-hosts/:id/stop` | none | Stop an idle remote backend, then disconnect. Refuses active execution, terminals and development services. |
| `DELETE /ssh-hosts/:id` | none | Disconnect and remove the saved definition; remote data remains. |
| `GET /ssh-context` | none | Local workspace context. At `/computer/:id/api/ssh-context`, returns the saved computer ID, name and connection state. |

The returned workspace uses the same local app origin and owner session. Its
`/computer/:id/api/` endpoints and event streams address the remote backend, so project paths, Git,
files, checks, agent tools and terminals all refer to that server. Mutations are
never replayed automatically. See [SSH projects](ssh-projects.md) for setup,
reconnection, remote previews, supported hosts and authentication boundaries.

Managed Tailscale certificates renew automatically while Tailscale remote access is enabled. `GET /remote` includes `tls.renewal` with `automatic`, `running`, `nextAttempt`, optional `lastSuccess` and a safe `error`. Renewal preserves paired sessions and control settings. Imported/environment certificates are excluded.

For multi-agent roles in Race, Debate, Review council, Supervisor and Loop workflows, a role setting can include additional models from the same provider: `roleSettings.reviewers.claude = { model: "first", variants: [{ model: "second", effort: "low" }] }`. Each entry runs separately with its own settings and session. Pipeline and other single-agent roles still use one model. Auto team pools also accept variants in `roleSettings.pool`: these are allowed model/effort choices for workers and reviewers. The coordinator selects among them within the member limit; it does not launch every selected model. Coordinator settings stay fixed. Additional models use the same validation as primary models (maximum 128 additional models per provider).
