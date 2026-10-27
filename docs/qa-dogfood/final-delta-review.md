# Final production-delta adversarial review

Reviewed the production changes after `a4faf8b` in `7b5dffb` (model aliases), `2786843` (code-host staging budgets), `4920eb2` (host action errors and team wording), `0498531` (unchanged result delivery), and `d2ce8a0` (approval routing/archive count accessibility), with their surrounding authority and lifecycle paths. Initial combined review checkout: `/private/tmp/codeflow-final-delta-review`; the approval repair is based on integration `1ba2c5f`, including `9212909`. This is a focused delta review, not a claim that every application path was reverified.

## Confirmed finding and repair

**P2 — live provider questions/approvals were absent from authoritative attention counts and filters.** A real fake-Codex question on a seen running fork of a seen root rendered a task under **Needs you 0**. `/api/projects/counts` returned `attentionTasks: 0`/`waiting: 0`, and server attention/waiting filters omitted the pending request. The rail read ApprovalInbox records, while server `needsYou` only understood workflow approvals and team questions. This did not require an unseen result or synthetic saved approval flag.

Evidence before repair: `final-delta-approval-probe.log`, `final-delta-approval-probe/approval-count-probe.json`, `approval-count-probe.png` and its server/browser logs. New baseline family and pagination tests independently returned `0 != 3` and `0 != 105` (`final-approval-baseline.log`).

Fixed in **`15a70ad7835b88fa379bb67f184def687eef3615`**, branch `codex/qa-final-approval-attention`, worktree `/private/tmp/codeflow-qa-final-approval-attention`. The approval registry supplies a payload-free, deadline-aware, side-effect-free pending-run set; the manager derives `approvalPending` only for running, non-archived, non-deleted runs. Counts, project sections, history filters/pages, related-family summaries, initial attention and live summary updates use that same projection. Access predicates still apply before reporting results; family grouping still counts a root/fork/side family once. The flag is not written into durable run state. Registry changes refresh the existing run feed, including resolution, without new persisted run events.

Parent review identified the cost and reentrancy risk of using the existing cloning/expiring `list()` API during every summary. The final implementation uses the new lean projection instead. A deterministic backlog of 32 expired requests proves reads do not mutate decisions or recursively publish notifications; observer depth remains one.

Validation: **33/33** focused approval/attention/history unit tests; **1/1** new Chrome/server replay with actual seen fork answer, side cancellation, root reload/cancellation; **1/1** original SHL-20 navigation/fallback replay; TypeScript `--noEmit` and diff checks pass. Browser errors are `[]`; new replay server log only has the known Node SQLite experimental warning. Evidence: `final-approval-related.log`, `final-approval-browser.log`, `final-approval-browser/`, `final-approval-original.log`, `final-approval-tsc.log`. Repository report: `docs/qa-dogfood/final-approval-attention.md`.

## Other reviewed boundaries

| Area | Independent checks and limits | Outcome |
| --- | --- | --- |
| Model authority (`7b5dffb`) | Followed provider inventory lookup, selected role/variant settings, alias/canonical matching and coordinator pin check. Reran five alias tests, including the saved real plan, wrong/unselected/unreported models, wrong effort, multiple model/effort pairs, and empty default-only variants. | No additional confirmed issue. Alias equivalence remains within the selected provider's reported model identities; coordinator equality and effort restrictions are retained. No new real-provider run was performed in this review. |
| Import/publish effects (`2786843`) | Re-read staging monitor, typed internal failure, caller abort, fast-fetch budget recheck, atomic local import, import-ref cleanup and push ledger ordering. Reran five focused tests: monitored over-budget quarantine removal, caller abort/read-only wording, fast oversized staging with byte/ref preservation, rejection before push effect boundary, and interrupted attempted-push uncertainty advice. | No additional confirmed issue. `beforeEffect` remains immediately before the push command; budget validation precedes it. Tests use real local Git for fetch/import and command stand-ins for push; no actual push was performed. The separate earlier 257 MiB Chrome replay remains evidence for the size cap, rather than a new claim from this rerun. |
| Empty result/TestRun delivery (`0498531`) | Followed ResultStudio's materialized artifact/worktree selection, no-file special case, ResultNextStep's TestRun archive-only behavior and backend branch ownership/result-delivery checks. Reran the new no-op source-PR Chrome regression. | **1/1 passed** (`final-delta-result-delivery.log`). Empty PR results retain delivery status without advertising code review/preview. TestRun restrictions remain in place by source audit; this review did not perform a new separate TestRun browser scenario. An artifactless Agent chat remains outside this ResultStudio branch. |
| Host errors and team counts (`4920eb2`) | Read separation of action errors from refresh errors, task-keyed host controls, cancellation/archive failures, and singular/plural attempt rendering. Checked that routine refresh cannot clear an action failure. | No additional confirmed issue from source review. This lane did not rerun the other agent's full team/ML collaboration suite. |
| Rail routing and archive accessibility (`d2ce8a0`, `9212909`) | Followed root/fork/side family membership, pending request precedence, unrelated-family exclusion, last-viewed fallback and archive-count accessible name. Independently replayed the pending-question path and then the original full SHL-20 case after repair. | Routing replay passes; the authoritative count/filter inconsistency above was the confirmed finding and is fixed separately. Archive count naming retains visible-label content in the accessible name; no fresh full axe sweep was claimed. |

Combined model/budget validation: **10/10** in `final-delta-model-budget.log`.

## Full-suite repair expectation audit

Reviewed the intent behind `261f9f3` rather than treating existing test changes as proof of correctness:

- Filtered-task teardown: a terminal status can be visible before its work promise and durable write release container ownership. The fixture now closes the service before removing its temporary tree; it does not weaken the product's refusal to delete an unconfirmed-running container. Existing explicit removal coverage remains.
- Filesystem-policy route assertion: the failing `.map` was on the GitHub issues result, whose intended response is `{ items, truncated }`. The correction still inspects every returned item; it does not relax the policy gate or treat an error response as a successful list.
- PR-watch delivery: `resultDelivery` requires an owned materialized result branch. The observed external-merge fixture now explicitly creates that checkpoint and asserts its presence before testing delivery. Production branch ownership validation remains unchanged. Fixture refs are populated through local fetch/direct refs, not push.

The separately recorded repair run passed 11 filtered/policy tests plus five watch tests; those earlier results are supporting context, not counted as new independent runs here.

## Execution boundary

All app/test/build/importing commands used explicit scratch `CODEFLOW_HOME`; browser runs used reserved loopback ports, scratch repositories and fake providers. No live4317/4318, live worktree rebuild, home-state inspection, real repository/remote, actual push or PR action was used. Native desktop, physical phone/network, Linux/systemd, Docker/WSL and real provider authority beyond the saved fixture were not newly exercised in this delta review. No additional confirmed unsafe-authority or data-loss regression was found within the reviewed paths.
