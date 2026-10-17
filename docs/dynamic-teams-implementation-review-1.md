# Review 1: the dynamic teams implementation

Reviewed: commits `2cf0736` (Add dynamic agent teams with durable collaboration and scoped memory) and `dfd752d`, on top of `8cb3641`, together with the evidence document `dynamic-teams-evaluation.md`. About 8,600 lines across 80 files: the Auto team pattern and plan model, the event scheduler, the mailbox, the memory store, the live tool bridge and its adapters, the evaluation runner and rollout store, the UI, and the documentation.

Method: four independent read-throughs (runtime and scheduler; memory store and trust boundary; live bridge, adapters and credentials; evaluation, rollout and documentation claims) plus a UI pass. Suspected defects were reproduced with scripts or tests before they were counted. The evidence JSON was checked number by number against the document. Everything marked **fixed** below was changed in this review and is covered by a test; everything marked **open** is not.

Baseline before this review: typecheck clean, 416 of 416 unit tests passing, 17 browser tests passing. After: 420 of 420 unit tests, both browser suites, typecheck and the UI build pass.

## Verdict

The implementation is more careful than most: identity, authority and provenance are derived by the server and never from model output; control state is journaled before it is acted on; schemas are closed; the test suite exercises crashes, replays and spoofing rather than object shapes. The trust boundary around project memory holds. Nothing reviewed lets an agent accept its own knowledge, borrow another member's session, or reach the application token.

Its failures are of calibration, not of design: several safeguards are sized wrong. A repository without a test command could never finish a run; deleting one memory erased every record of every run that had merely seen it; one shared cap let a looping member fill the memory store for every project; every live tool call rebuilt the whole mailbox from scratch; the provider inventory re-probed the CLIs on every scheduler event. All of these are fixed here. The evidence document is honest in tone but its numbers come from an uncommitted tree, its real trials overlapped in time, and its "rollout gate" gates a label rather than the feature. Those are now disclosed in the documents themselves.

Keep Auto team experimental and opt-in, as the evidence document already decides. Re-run the real trials from the committed runner before any beta claim.

## Fixed in this review

### Runtime and scheduling

- **A repository without a runnable check could never finish.** The final verification treated "no configured check" as an unresolved gap, so the team ended blocked, the run stopped with "unresolved work", and every Resume spent a review invocation and blocked again. Now a complete, independently reviewed result in such a repository finishes as `completed` with `verification.check: "unknown"`, no pass/fail verdict, and nothing accepted into team or project memory. The UI shows "Reviewed · no check ran" rather than "Verified". `src/patterns/auto-team.ts`, `ui/team-state.ts`, `ui/team.tsx`, test "Auto team without a runnable check finishes reviewed but unverified".
- **Provider inventory probed the CLIs on every scheduler event.** `teamInventory()` ran `codex debug models` and `agy models` (a network fetch, 45 s timeout) at every wave and journaled the catalogs each time. Later observations now reuse the planning catalogs and refresh only availability and quota. `src/engine.ts`, `src/patterns/auto-team.ts`.
- **A no-op coordinator revision was asked again until the coordination budget ran out.** A revision that adds, reassigns, retries, answers or contracts nothing now ends the wave loop with the unresolved work listed. Test "Auto team stops asking the coordinator once a revision changes nothing".
- **User answers and teammate messages shared one JSON block** labelled "agent data unless origin=user". They are now separate prompt sections, the user's answers marked authoritative for the task and teammates' messages marked as evidence. The member's own session handle and private checkpoint no longer appear in the assignment JSON. `src/patterns/auto-team.ts`.

### Memory store

- **Deleting one memory cascaded through context references.** `derivedFrom` records what was in a member's context, not text copied from it, so deleting a widely selected convention erased every checkpoint, contract and finding of every run that saw it, including user-accepted entries derived from them, and any run still citing it failed on its next write ("Memory source was deleted"). Deletion now redacts only the target; references to a tombstone inherit its origins instead of throwing. Reproduced before the fix with a scratch script. `src/memory.ts`, test "deletion erases the entry's body; entries that saw it keep theirs".
- **One global cap of 5,000 entries across all scopes and repositories**, with private and team records never retired and no API to delete them. A few hundred runs, or one looping member, would make every Auto run fail at plan time with "Memory limit reached". The project cap now counts project entries only; private and team records are capped at 512 per run; archiving a run with cleanup retires its private and team records. The store's own load-time validation used the same global count and would have refused to open the file. `src/memory.ts`, `src/engine.ts` (`archive`).
- **Run-wide provenance unions overflowed the 128-reference limit** and the overflow was fatal after verification had succeeded. Writes now cite the journaled selection of the task that produced them (stable across replays, which also removes a crash-idempotency hole in the pattern path), and the limit is 1,024. `src/patterns/auto-team.ts`, `src/team-memory.ts`, `src/engine.ts`.
- **A user's edit silently accepted a proposal**, including a tags-only edit of an untrusted one, contradicting "the user must approve the exact revision". An edit now keeps a proposal a proposal unless the request says `accept: true`; an accepted entry the user edits is recorded as accepted by the user. `src/memory.ts`, `src/server.ts`, test "a user's edit keeps a proposal a proposal unless they accept it".
- Storage failures were returned as HTTP 400; they are 500 now. The unused `memoryPrompt()` helper, which rendered bodies unescaped into Markdown headings, is removed.

### Live tool bridge and adapters

- **Every tool call rebuilt the mailbox overlay with one deep clone per pending command.** Measured: 1,000 pending commands cost 1.8 s per call, 4,096 cost 36 s, all synchronous on the main thread and serialized ahead of every other member's calls and the scheduler's own drains. The overlay now clones once and applies commands in place, and each member turn may make at most 256 tool calls. `src/team-mailbox.ts` (`applyMailboxCommandInPlace`), `src/engine.ts`.
- The client answered over-limit requests with `id: null`, leaving the CLI's request waiting until its own tool timeout; it now answers with the request's id. The credential file is deleted as soon as the client has read it. `src/team-tool-client.mjs`.
- The capability TTL was clamped to 2 hours while a step may run 24; a failed listen was cached forever; the bridge was never closed at shutdown; an inactive grant answered 400 instead of 403. `src/team-tools.ts`, `src/server.ts`.

### UI

- The run view's event sequence numbers (the manager's global counter) and the sidebar feed's per-start counter were gated through one map, so a run you had opened stopped updating in the sidebar and never announced that it needed you until a reload. They now have separate gates, and the run view's upsert announces changes. `ui/state.ts`.
- "Waiting for you" was shown for a team question regardless of run status, although the server accepts answers only while the run is running, and a crash left the flag set. The server clears it when it marks a run interrupted; the UI, phone view and inbox show it only for a running run, with the Resume instruction otherwise. `src/engine.ts` (`load`), `ui/team-state.ts` (`teamAwaitingAnswer`), `ui/run.tsx`, `ui/rail.tsx`, `ui/automations.tsx`, `src/remote.ts`.
- The "approve the plan" preference was one shared key, so unticking it once for Plan → Build → Review dispatched Auto teams without their approval checkpoint. It is now remembered per pattern; the old shared choice still applies to manual patterns. `ui/state.ts`, `ui/composer.tsx`.
- The open user question is now a card under the run header, like plan approval, instead of the last item in the message list. `ui/team.tsx` (`TeamQuestionCard`), `ui/run.tsx`.
- The check-command detection could land in the composer field after the user had started typing into it (the browser test recorded `npm testnpm test` as the check); a late detection result now fills only a field nobody has touched. `ui/state.ts` (`loadCheck`).
- Measurements polled the evaluation endpoint every 5 s while collapsed, which rebuilt the report from the whole journal each time; they load only while open. Delete in the memory panel is a two-step inline confirmation. The composer refuses an Auto team with fewer than 4 steps or an empty provider pool before the run exists. An invalid follow-up budget is explained next to the composer instead of only inside the collapsed budget disclosure; "Revise goal" is hidden during plan approval; the answer box has a visible label. The hello event of a run stream now always carries the snapshot.

### Evaluation and runner

- `repairTurns` counted any step whose title matched `/repair|fix/`, including model-authored task titles; it now counts engine-titled steps only. `reportedTokens` omitted cache-read tokens. The "avoidable barrier" label is "dispatch delay after an answer": every trial ran event-driven, so there was no barrier to avoid.
- The rollout decision assessed only the reports a caller cited, so a caller could cherry-pick verified pairs to reach "default". Eligibility is now judged over every real report in the store. `src/team-evaluation.ts`.
- The runner created an empty temporary directory on every invocation even with `--out`; `--real` now requires `--confirm` and prints the maximum invocation count; the trial settings that differ from app defaults (approval off, `maxRepairs: 1`, `maxSubtasks: 2`, provider-default models) are written to `configuration.json`. `scripts/` is now typechecked. `scripts/evaluate-teams.ts`, `tsconfig.json`.

### Documents

- README no longer headlines an experimental feature with one verified real run out of three as the product's primary flow; Auto team is presented as experimental and opt-in.
- `dynamic-teams-evaluation.md` now states where its numbers come from (an uncommitted tree, an older runner, source runs not committed), that the real trials overlapped in time, what the dispatch-delay figure is, and that the rollout stage does not gate availability. Test counts are reconciled (397 at trial time, 416 after the delivery review, 420 now).
- `dynamic-teams-implementation-plan.md`: "validates the scheduling benefit" is corrected to "demonstrates the scheduling order"; three measurement rows marked "Captured" are now "Partly" or "Not captured"; the rollout decision is described as a label.
- `auto-team.md`, `security.md`, `configuration.md`: `--strict-mcp-config` disables the user's and the repository's MCP servers in Claude team turns; members run as one user and the credential file is readable in the window before the client deletes it; deletion and edit semantics as implemented; the per-turn tool budget and per-run memory cap; the stage is informational.

## Open findings, ranked

1. **The real evidence is not reproducible and must be regenerated.** The committed runner, a committed fixture task and recorded model identities are the minimum for a number anyone can check. Until then the evidence document supports exactly one claim: the feature runs end to end on real CLIs. Run `npm run evaluate:teams -- --real --confirm` from the committed tree, sequentially, and replace the JSON.
2. **The rollout stage does not change behaviour.** Either make `beta`/`default` affect availability and the composer (and keep `CODEFLOW_AUTO_TEAM_ENABLED` as the kill switch), or rename the feature "rollout record". A gate that gates nothing invites the wrong conclusion.
3. **Coordination budget is tight by construction.** `min(4, floor(limit / 4))` coordinator calls include initial planning and every approval revision; two "revise" clicks at approval leave one call for the whole run. Consider `min(8, ceil(limit / 4))` or counting approval-driven replanning separately, then measure.
4. **Steering race.** A Codex `turn/steer` that is accepted after the 2 s deadline is journaled as not accepted and re-delivered in the next turn's context. Record "unknown" on timeout and dedupe by message id, or fire-and-forget after persisting the intent and reconcile at the drain. `src/engine.ts` (`steerTeamMessages`).
5. **Capability probes rerun on every turn after a transient miss** and the cache key embeds a test hook. Probe once per server start with a negative cache. `src/adapters/team-tools.ts`.
6. **Bridge handler errors are returned verbatim** (file paths, git errors). Whitelist domain errors as 400; everything else 500 with a generic message, logged server side. `src/team-tools.ts`.
7. **Git fan-out per prompt**: up to 128 `merge-base --is-ancestor` calls per selection, run twice per `projectMemory()`. Memoize `(commit, head)` per run and build the query once. `src/team-memory.ts`.
8. **Memory editor after a 409** keeps the stale revision; the only way out discards the draft. Refetch, rebase the revision, keep the typed fields. `ui/memory.tsx`.
9. **Reconnect handling is tested only through a pure helper** with a scenario the server cannot produce. Add a server test for `Last-Event-ID` beyond `newest` and a client test for the three hello cases. `test/server-reliability.test.ts`, `test/team-ui.test.ts`.
10. **`read_memory` results are frozen per attempt and arguments** (intentional for provenance); new team proposals are invisible to an identical later call in the same attempt. Say so in the tool description.
11. **Answering a question after a restart requires Resume first.** The UI now says so; a better flow would accept the answer while interrupted and deliver it on Resume.
12. **The team view is a dashboard at the top of the thread.** The question card is now under the header; the remaining roster, workflow, coverage, messages and measurements should fold into one disclosure outside plan approval, with measurements and capabilities living in Insights.

## What to avoid next time

- A safeguard whose blast radius is "everything that touched it": the deletion cascade over context references, the global memory cap across scopes and repositories, and the overlay rebuilt from scratch per call all protected one thing by endangering everything around it. Size a safeguard to the record it protects.
- A gap nobody can close. If the team can do nothing about a condition (no test command, no reviewer quota), it must not become a blocking gap that every Resume pays to rediscover.
- Probing external processes inside a loop. Catalog and version probes belong at plan time; a scheduler event should be a function of journaled state.
- One JSON blob for text of different authority. User answers and teammate messages, or a member's private checkpoint and its public record, must not share a section.
- A single preference key across patterns when one pattern makes the preference a safety control.
- Evidence written from an uncommitted tree, trials run concurrently and called sequential, counts ("11 focused tests") that match no file, and estimates labelled as measurements ("avoidable barrier", "repair turns" by regex). The evidence document was candid everywhere except in these specifics, and those are what a reader checks first.
- Calling a recorded label a gate. If a decision does not change what the software does, do not describe it as controlling rollout.
- Headlining an experimental feature in the README before its own evidence supports it.

## Suggestions

- Treat the three memory scopes differently in storage: project knowledge in the curated store; private checkpoints and team records in the run's own journal directory, deleted with the run. Most of the cap, GC and cascade problems disappear with that split.
- Replace the per-event coordinator wake with a per-wave decision unless a measurement shows per-event decisions change outcomes; the fixture data so far shows no peer questions in real runs at all.
- Record model identity per turn in the evaluation report and pin it in the runner; otherwise two trials are not comparable even on the same day.
- Add a `check` detection step to the Auto plan itself: when no check command exists, ask the coordinator to propose one as an investigation task, so verification becomes possible rather than unknown.
- The plan document has become a hybrid of history and status. Move the status table and the storage decision into the evidence document, and keep the plan as the design record it was.

## Verification performed

| Check | Result |
|---|---|
| `npm run typecheck` | passes (now includes `scripts/`) |
| `npm test` | 420 passed, 0 failed (416 before; 4 added) |
| `npm run test:e2e` (`auto-team.e2e.ts`, `ui.e2e.ts`) | passes after the UI changes |
| `npm run build` | passes |
| `git diff --check` | clean |
| Memory cascade, cap and reference-limit reproductions | executed before the fixes; covered by tests after |
| Overlay cost benchmark | executed before the fix (36 s per call at 4,096 pending commands) |
| Real CLI probes (`claude --help`, `codex mcp get`, `codex features list`) | executed against the installed CLIs; claims in `auto-team.md` about them hold |
