# Dynamic teams: implementation evidence and rollout decision

Recorded 17 October 2026 for the P0–P8 implementation on top of `main` at `8cb364143716a3feda3edd12e7fa0a310c92ecf5`. The implementation is described in the [plan](dynamic-teams-implementation-plan.md) and [Auto team guide](auto-team.md). The [machine-readable evidence](evaluations/dynamic-teams-2026-10-17.json) preserves the trial reports, limitations, assessment and explicit rollout decision.

**Decision: keep Auto experimental and opt-in.** All implementation packages are delivered. The evidence supports exercising the feature with bounded budgets; it does not support replacing Supervisor by default. Earlier unsuccessful trials are retained. A successful final trial does not erase them.

**Provenance of this evidence.** The JSON artifact was produced from an uncommitted working tree (`implementation.state`) by an earlier version of the runner than the committed one: its reports carry `pairId: "pair-1"` and, for pair A, `caseId: sum-numbers-v1`, where the committed runner writes a batch-scoped pair ID and the v2 case, and pair C predates the worker-turn attribution fix. The source runs and journals are not committed. The real numbers are therefore historical measurements of the development tree and cannot be regenerated from this repository; a fresh `--fake` run reproduces the 5/2 and 4/1 call counts, and only a new `--real --confirm` batch can produce reproducible real numbers. Per-trial model identity was not recorded (the runner passes provider defaults), and the matched Supervisor runs were pinned to two subtasks, so their 25% coordination share is by construction rather than observed.

## Verification

- Full automated suite: 397 tests passed at the time of the trials (416 after the post-delivery review below, 420 after [review 1](dynamic-teams-implementation-review-1.md)), including recovery, storage faults, mailbox ordering, immediate replies, identity isolation, memory trust, live capabilities, legacy compatibility and rollout controls.
- Browser suite: 17 tests passed, including Auto approval, blockers, inspection and an in-flight goal revision that stops the old team and requires the configured approval for its child.
- After final trust/diagnostic adjustments: 11 focused composition and rollout-engine tests passed.
- After correcting worker-turn attribution: 8 evaluation tests passed. Worker answer and repair turns count even without task IDs; coordinator/reviewer turns do not.
- Typecheck, UI build and `git diff --check` passed. Validation ran on Node `v22.14.0`; the existing Node 20/22 CI matrix is retained, but this report does not claim a separate local Node 20 run.

The asynchronous scheduling regression runs a fast dependency, its successor and an unrelated slow worker. It asserts that the successor starts before the slow worker ends. A separate saved-wave compatibility case asserts the old barrier, and restart tests preserve recorded completion ordering. These fixtures demonstrate scheduling behavior, not a real-provider speedup.

## Real task comparisons

Each pair used the same generated repository, base commit, task and verification command: implement `sumNumbers(values)` with finite-number filtering, non-array rejection, empty-input handling, input preservation and `node:test` coverage. Runs used isolated storage and repositories, official signed-in CLIs and a maximum of 12 invocations. The generated task forbids fetching packages, accessing external services or publishing. Plan approval was explicitly disabled by this unattended evaluation harness; interactive approval is covered by the browser and engine tests.

The CLIs were Claude Code `2.1.302` and Codex `0.162.1`. Pair A used Claude as coordinator; pairs B/C used Codex. These are development trials of one small task, with code fixes between them, not independent samples of the final implementation or a representative benchmark. They were not sequential: the report timestamps show pair B starting before pair A finished, and between 12:44:56 and 12:46:06 UTC three real runs (A supervisor, B supervisor, C auto) ran at the same time on one machine, so the elapsed times in the table were measured under shared CPU, network and rate-limit contention.

| Pair | Pattern | Result | Calls / coordination | Worker turns | Elapsed | Selected memory | Journal bytes / load |
|---|---|---|---:|---:|---:|---:|---:|
| A | auto-team | stopped; unverified | 3 / 2 (67%) | 1 | 300.48 s | 0 | 38,298 / 2.95 ms |
| A | supervisor | done; verified | 4 / 1 (25%) | 2 | 216.60 s | 0 | 23,817 / 3.53 ms |
| B | auto-team | failed; unverified | 1 / 1 (100%) | 0 | 5.55 s | 0 | 2,538 / 0.34 ms |
| B | supervisor | done; verified | 4 / 1 (25%) | 2 | 233.43 s | 0 | 20,345 / 3.37 ms |
| C | auto-team | done; verified | 5 / 3 (60%) | 1 | 294.59 s | 1 | 54,147 / 0.87 ms |
| C | supervisor | done; verified | 4 / 1 (25%) | 2 | 259.62 s | 0 | 20,789 / 1.46 ms |

Pair A exhausted its five-minute limit after a plan validation retry and implementation. Its initial IDs did not satisfy the lowercase identifier policy. The repaired implementation did not reach independent review before the deadline, so the runtime correctly reported an unverified stopped result. Prompts and strict schemas now communicate the identifier rules directly.

Pair B exposed a real Codex schema incompatibility before worker dispatch: strict object schemas must include every property in `required`, including `subplans`. Wire schemas now satisfy that restriction recursively, with an explicit regression test. A repository-path canonicalization defect also prevented the synthetic memory seed from being selected; it was fixed and tested before pair C.

Pair C exercised the corrected strict schemas and selected one seeded project memory. Its first plan unnecessarily assigned a task to the independent reviewer. The runtime rejected it, and a planning retry assigned the verification task to the coordinator; the runtime still performed its own independent final review. The final prompt and rejection diagnostic now tell planners to omit that redundant final-review task. Pair C therefore includes this observed extra coordination and predates the final wording improvement; no reduced overhead is claimed for that change.

The verified Auto result covered all five structured requirements, passed checks and independent review, and passed the fail-to-pass proof. Reported elapsed time includes planning and verification. Coordinator fractions count actual CLI launches, including planning repair, rather than only logical steps. Provider-reported tokens/costs can be partial; API-equivalent costs are not subscription charges and are not a complete cross-provider price comparison.

None of these real Auto runs needed peer information. They therefore supply no useful estimate of real peer-question frequency or asynchronous latency gains. The final successful Auto run used one worker; its 60% coordinator fraction is not a multi-worker overhead measurement. The 20-Auto-run, 100-worker-turn and 20-matched-pair default-rollout targets have not been met.

## Live bridge evidence

Both adapters were exercised against the scoped local MCP bridge using a real CLI invocation. The server returned a unique test response only after an authenticated `read_inbox` call; the model's final response matched it.

| Provider | Transport | Elapsed | Accepted callbacks | Result |
|---|---|---:|---:|---|
| Claude Code 2.1.302, Haiku | stream-json with MCP configuration | 8.630 s | 1 | Correct member and response |
| Codex 0.162.1 | app-server, read-only | 13.623 s | 1 | Correct member and response |

Claude first supplied an unsupported `input` field; schema validation rejected it and the model corrected the call. Codex initially showed that per-tool approval configuration was required even with a noninteractive approval policy. Its adapter now explicitly permits only the bounded collaboration/memory tool names; source-write and other tool permissions are unchanged. These successful smoke checks prove transport and identity plumbing, not complete real-provider coverage of every collaboration operation. Fake adapter and engine tests cover authentication, scope, revocation, durable writes, steering fallback and replay. The Claude summary was reconstructed from its retained successful tool output after the later Codex smoke overwrote the temporary combined report; that capture provenance is included in the JSON artifact.

Unsupported or unproven capabilities remain visible in the capability inventory. Structured outcomes remain the fallback. Vendor-native nested-agent usage cannot be counted when the CLI does not expose it; the implementation does not invent that usage.

## Deterministic workflow and memory evidence

The labeled fake comparison completed and verified both patterns. Auto used five calls, two coordinator calls, one blocking peer question and two worker turns. The question was answered after 796 ms; the observed post-answer delay was 226 ms. That delay is the event scheduler's own dispatch latency after an answer arrives (every trial ran event-driven, so there was no wave barrier to avoid); it is not a measured speedup. Supervisor used four calls and one coordinator call.

Auto selected one synthetic accepted project memory about dependency-free `node:test`; Supervisor selected none through the new memory layer. This tests retrieval and attribution, not whether a learned memory helps a human. The real pair C selected the same kind of seed. Human usefulness/staleness feedback was zero in these trials. The application supports revision-specific useful/irrelevant/stale/incorrect feedback, exclusion of stale or incorrect revisions, and bounded relevance adjustments.

Separate memory tests verify later-run reuse of an eligible lesson, member-private isolation, exact source revisions, locked-down and inherited-source promotion restrictions, branch applicability, deletion and session-independent reconstruction. Untrusted material remains attributable and cannot become a future project instruction through an automatic summary or follow-up.

The fake Auto journal held 17,594 bytes / 58 records and loaded in 19.11 ms; Supervisor held 5,030 bytes / 13 records and loaded in 6.44 ms. Real journal measurements are in the table and JSON artifact. These are single local **journal-load** timings, not full process-restart benchmarks. Restart behavior is independently tested. The measurements provide no reason to add a database, leases or an outbox; fsynced logical envelopes and deterministic replay remain the storage decision.

## Reproduction and future rollout

### Implementation review after initial delivery

A second review covered the complete implementation and fixed the following issues before commit:

- Ready-work selection now filters unavailable and exhausted tasks before packing non-overlapping work. Live and replay scheduler waits respond to cancellation even without a deadline. Retried event-driven tasks merge the captured input commit, so a later peer commit cannot silently change their inputs.
- Coordinator revisions validate the combined contract set against the existing bounds. A smaller explicit invocation ceiling constrains planning and review reservations; refused retries do not create false launch records. Rejected outcomes update both provider and member failure counts.
- Provider-addressed follow-ups cannot resume a team's private member session. Direct replies retain their own subsequent conversation and can use a one-call budget; new teams still require at least four calls.
- Live memory reads honor task paths, search text and entry limits, keeping returned entries and recorded provenance consistent. Whole-repository `*` assignments can retrieve applicable path-scoped memory. Valid namespaced operation IDs remain within storage limits.
- Malformed JSON-RPC envelopes no longer crash the MCP client.
- Interrupting the evaluation runner stops the whole batch, including a signal during run preparation. Separate batches use unique pair IDs. Beta eligibility requires the verified Auto result to belong to the matched comparison, and multi-worker measurements count workers that actually executed.
- The capability panel clears stale errors when reopened after a successful retry.
- The browser test waits for the active run's waiting status after its question appears; those are separate scheduler snapshots, which exposed a timing race on Linux CI.

Every fix has regression coverage. Final post-review validation is recorded below after the complete test and browser runs. The real measurements above remain the original immutable development-trial evidence; this review did not relabel or overwrite those trials.

- `npm test`: 416 passed, zero failures or skips.
- `npm run test:e2e`: 17 passed, including direct-follow-up and new-team budget checks.
- `npm run typecheck` and `npm run build`: passed.
- Final contract/model regressions: 10 passed after the last contract-bound correction.
- `git diff --cached --check`: passed.

### Commands

```sh
npm test
npm run test:e2e
npm run typecheck
npm run build
npm run evaluate:teams -- --fake --out /tmp/codeflow-team-fixture
npm run evaluate:teams -- --real --confirm --runs 1 --providers codex,claude --max-steps 12 --max-minutes 8 --out /tmp/codeflow-team-real
```

Use a fresh output directory for each invocation. `--real` consumes signed-in CLI quota; ordinary tests use fakes. The runner saves immutable measurement reports and source runs under its isolated directory. Optional `--register-home DIR` copies measurement reports into another installation without copying transcripts or changing rollout. Generated fixtures and private CLI transcripts are not committed with this evidence.

The recorded decision selects all three real development comparisons, including the failures, and stays experimental. It was written into an isolated evaluation store and copied into the evidence artifact; the user's normal app configuration was not changed. The app starts at experimental in the absence of a separate explicit decision. Beta/default changes require a written rationale and qualifying real reports through the rollout API/UI; fake runs cannot qualify them, and since review 1 eligibility is judged over every real report in the store, not only the cited ones. The stage is a recorded label shown in Insights and used as a composer default; the only switch that changes whether Auto teams can start is `CODEFLOW_AUTO_TEAM_ENABLED`. More representative tasks, verified multi-worker runs, meaningful memory feedback and lower observed coordination overhead are needed before promotion.
