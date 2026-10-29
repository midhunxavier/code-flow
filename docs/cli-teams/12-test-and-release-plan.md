# Test and release plan

Status: proposed. [Index](README.md)

Use the repository's existing Node test runner, fake provider executables, temporary repositories, and isolated Code Flow state directories. Real provider calls are reserved for explicit, bounded compatibility/release probes. None are required to validate this documentation pack.

## Test layers

| Layer | Coverage |
| --- | --- |
| Schema/unit | Canonical hashes, typed references, bounds, unsupported fields, role constraints |
| Pure reducer | Allowed state transitions, expected revisions, gate logic, idempotency |
| Graph fixtures | Fan-out, joins, loop termination, independence, invalid cycles, expansion limits |
| Adapter contract | Model/effort propagation, sessions, output validation, errors, cancellation |
| Persistence faults | Every boundary before/after dispatch, artifact write, journal commit, and response |
| Workspace integration | Dirty index/worktree preservation, concurrent edits, snapshots, owned worktrees |
| MCP integration | Scope, request validation, cursors, bounded waits, retries, claim fencing |
| Installer/package | Merge/uninstall ownership, portability, binaries/skills present in package |
| Native host live | Actual invocation, acceptance, host participation, progress, full result in both CLIs |

## Required scenarios

| Test ID | Scenario | Expected outcome | Requirements |
| --- | --- | --- | --- |
| T01 | Start same operation twice, including lost first response | One run, same durable receipt | R03, R10 |
| T02 | Reuse operation ID with changed payload | Conflict, no second side effect | R10 |
| T03 | Accept proposal v1, then edit to v2 | Old acceptance cannot start v2 | R02, R03 |
| T04 | Plan v2 approved by A; plan changes to v3; B approves v3 | Agreement remains false until required reviewers approve v3 | R07 |
| T05 | Two Codex models and one Claude planner | Distinct participant IDs, settings, sessions, and outputs | R05 |
| T06 | Missing/invalid review output | Limited repair or blocked step, never approval | R07, R15 |
| T07 | Reviewer unavailable | Missing vote reported; no false agreement | R09, R15 |
| T08 | One current-session review, one managed planner | Correct claim, exact artifact target, result returned to host | R01, R08 |
| T09 | Host settings unknown but strict model pin required | Managed assignment or proposal error; no guessed match | R08, R09 |
| T10 | Host disconnects while writable step active | Workspace stays owned/uncertain; no replacement writer | R08, R10, R11 |
| T11 | Old claim submits after reassignment | Rejected; current attempt unaffected | R10, R17 |
| T12 | Crash before/after each dispatch/result boundary | Durable outcomes reused; uncertain effects reconciled | R10 |
| T13 | Disk full during authoritative append | No dependent dispatch or success acknowledgement | R10 |
| T14 | Two runner processes start together | One owner; other connects or reports conflict | R10, R18 |
| T15 | Staged, unstaged, deleted, and selected untracked files | Exact review snapshot; original files/index unchanged | R11 |
| T16 | Source changes during capture | Snapshot rejected/refreshed, not mixed | R11 |
| T17 | Required check unavailable | Unverified/waiting result, not successful build | R12, R15 |
| T18 | Checks pass on old snapshot, then code changes | Old evidence cannot pass final gate | R12 |
| T19 | Loop hits iteration/call/time limit | Work preserved, precise stopping reason | R06, R14 |
| T20 | Retry/output-repair calls consume allowance | No unaccounted managed launches | R14 |
| T21 | Cancel with process termination uncertainty | Honest uncertain state; files preserved | R10, R13 |
| T22 | Unsupported effort or missing CLI flag | No silent substitution or boundary relaxation | R09 |
| T23 | Worker calls public start/save/control or spoofs identity | Denied; no nested workflow | R17 |
| T24 | Project-root traversal or wrong run scope | Denied before artifact/filesystem access | R16, R17 |
| T25 | Installer rerun/uninstall against existing modified config | Unrelated and user-modified entries preserved | R16, R18 |
| T26 | Large result/event history | Paged bounded response, no lost deliverable content | R01, R15 |
| T27 | Plan-only task in repo with missing build dependencies | Planning works without unrelated setup | R01, R06 |
| T28 | Nonconverging reviewers | Clear remaining disagreement; no forced consensus | R07, R15 |
| T29 | Reuse saved team with local override | Original version unchanged; run snapshot records override | R04 |
| T30 | Review-only request | No implementation writes or automatic fixes | R11, R17 |
| T31 | Existing procedural runs and HTTP clients | Existing behavior remains compatible | R18 |
| T32 | No-change result | Explanation and evidence shown in original chat | R01, R15 |

## Proposed test files

- `test/cli-teams-schema.test.ts`
- `test/cli-teams-graph.test.ts`
- `test/cli-teams-gates.test.ts`
- `test/cli-teams-service.test.ts`
- `test/cli-teams-recovery.test.ts`
- `test/cli-teams-host.test.ts`
- `test/cli-teams-mcp.test.ts`
- `test/cli-teams-workspace.test.ts`
- `test/cli-teams-install.test.ts`
- `test/cli-teams-budget.test.ts`
- `test/release/cli-teams.test.mjs`

These are future implementation files. Tests should assert observable behavior and failure invariants rather than duplicate implementation branches.

Existing patterns to reuse: [team-live-engine.test.ts](../../test/team-live-engine.test.ts), [auto-team.test.ts](../../test/auto-team.test.ts), [engine-review.test.ts](../../test/engine-review.test.ts), [run-history.test.ts](../../test/run-history.test.ts), [merge-tree-pin.test.ts](../../test/merge-tree-pin.test.ts).

## Verification commands after implementation

```sh
npm run typecheck
node --import tsx --test test/cli-teams-*.test.ts
npm test
npm run test:package
```

The new test glob will not exist until implementation. Run focused tests while developing; run the broader existing suite and package checks at integration/release boundaries. Do not repeatedly run unrelated expensive live or desktop suites for local schema/documentation edits.

## Live acceptance walkthroughs

For both Claude Code and Codex as host:

1. Initialize a small disposable project containing both provider integrations.
2. Produce a proposal with exact models/efforts and verify the displayed settings against actual worker launches.
3. Accept through the supported host channel or clearly disclosed terminal fallback.
4. Run two independent proposals and reach agreement on a final plan.
5. Exercise a host planning/review assignment and capture its returned artifact.
6. Implement a small deterministic change with the other provider and require a meaningful failing-before/passing-after check where appropriate.
7. Introduce a reviewer finding and observe one bounded repair iteration.
8. Disconnect/reconnect, pause/resume, and retrieve the complete final deliverable.
9. Review current dirty changes separately and verify that source file/index fingerprints are unchanged afterward.

Record CLI versions, OS/runtime, provider transports, requested/resolved settings, native confirmation behavior, actual managed invocation count, check evidence, and limitations. Do not record authentication tokens or private unrelated project data.

## Operational acceptance targets

Measure start acknowledgement separately from provider latency: start should return after durable admission, not after inference. `get_run` must respect its requested wait bound. Discovery and status must remain responsive while workers are active. Waiting on a user consumes no provider slot.

Exercise the supported maximum participants, expanded steps, and event pages with fake providers. Assert scheduler concurrency never exceeds configured limits and that multiple projects make progress. Report measured replay time and memory on a documented fixture/hardware baseline; set regression thresholds from those measurements rather than inventing universal performance promises.

## Release checklist

- [ ] R01–R18 have passing evidence linked to tests or live probes.
- [ ] All T01–T32 scenarios pass or an explicit scope change removes an unsupported feature.
- [ ] Both native host paths deliver actual plans/results.
- [ ] No required host capability is inferred solely from docs or a fake fixture.
- [ ] Migration/version behavior is tested with existing saved runs and templates.
- [ ] Package includes runtime, skills, built-in workflows, and schemas.
- [ ] Project configuration contains no credentials or machine-specific paths.
- [ ] Help clearly labels current-session limitations and acceptance fallback.
- [ ] User can diagnose missing providers, invalid settings, blocked checks, and uncertain work.
- [ ] Release notes distinguish supported, experimental, and deferred behavior.

## Requirement traceability

R01–R04: project UX/MCP and P6–P7. R05–R07: domain/graph and P1/P3. R08–R09: participants and P0/P4. R10: durability and P2/P8. R11–R12: workspaces/verification and P5. R13–R15: runtime controls/budgets and P3/P6/P8. R16–R18: installation/authority/backward compatibility and P2/P7/P8.
