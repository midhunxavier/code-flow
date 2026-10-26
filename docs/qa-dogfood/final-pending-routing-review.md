# Independent review: delayed approval routing

Reviewed `f88b0f072bcf01db4de201a5588f58d605172e00` read-only against its parent. The fixture branch remains at `0574e3f`, clean. No tests or application processes were started for this review.

No blocking correctness finding.

- The added signal is `RunSummary.approvalPending === true`, derived by `RunManager.attentionSummary` from the live approval registry. That projection requires a running, non-deleted, non-archived run. Approval registry changes publish fresh summaries. The change does not restore approval authority from historical events or let the browser approve anything.
- Routing remains scoped to the clicked task family. `openTask` filters archived members before looking for a waiter, and side-chat selection uses the clicked root's scope. Stopped/cancelled runs cannot become waiters merely because a summary flag or inbox record is stale: the new clause retains the running-status condition. The previous inbox-record fallback remains for older hosts. The change does not alter the all-archived fallback or the separate existing workflow/team-awaiting predicates.
- The regression delays only snapshot payloads with approval records. Run/history delivery stays live, and each side/fork/root click waits for an observed true per-run summary. The side scenario explicitly verifies no question card before release and an actual question card after release. Cancellation and another family's pending request are followed by the original family's last-viewed fallback and no reopened side panel.
- The test proves the known-summary/delayed-approval-payload race. It does not prove navigation before the run summary has arrived, and the report explicitly preserves that distinction. There is no claim of an archived-run browser matrix; archived safety above is a source review conclusion.

Validation claims checked against saved logs: `pending-routing-fixed.log` reports 1/1, and `pending-routing-daily-fixed.log` reports 16/16 in 85.6 seconds. The report's use of fake providers and real isolated application/browser navigation is consistent with the fixture. No extra execution or broader verification was inferred from those logs.
