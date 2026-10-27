# Final approval attention consistency repair

Final delta review found a P2 gap after the SHL-20 navigation repair: a seen root chat with a seen running fork waiting on a real provider question appeared under **Needs you 0**, and `/api/runs?limit=1&status=attention` and project waiting sections omitted the request. The rail read the live approval inbox, while server counts and filters only recognized workflow approvals and team questions.

The manager now projects `approvalPending` from the live registry into run summaries, counts, history pages, project reports, related-family summaries and attention snapshots. The flag is not persisted in the run index or logs. Registry changes publish summary updates, including resolution, through the existing run feed so the normal counts refresh follows them. Only running, non-archived, non-deleted runs can have this live flag; existing access predicates and family grouping remain in effect. The registry projection checks deadlines without cloning request payloads, expiring records or emitting recursively.

Validation on `codex/qa-final-approval-attention`, based on integration `1ba2c5f`:

- New four-unit regression file: actual registry questions and commands; authorized root/fork/side family deduplication; related summaries and one-item cursors; 105 authorized pending tasks crossing the 100-item page boundary with denied requests excluded; resolved/stopped/archived/stale restored controls; expired-many reads and observer depth. Included in **33/33** targeted attention/history/approval tests.
- New Chrome/server replay: all chats explicitly marked seen; fork question answered through the UI; side request cancelled; root question retained after browser reload, then cancelled. The badge, overall/project task and run counts, `status=attention`, and `section=waiting` agree throughout. **1/1 passed**, browser error receipt empty; server log contains only the known Node SQLite experimental warning.
- Original SHL-20 root/fork/side routing and unrelated-request fallback replay rerun separately: **1/1 passed**.
- TypeScript `--noEmit` and `git diff --check` passed.

Before the repair, the new family/pagination tests failed with `0 != 3` and `0 != 105`; the independent original Chrome probe recorded `attentionTasks: 0` with a real pending question and both chats seen. This extends the original navigation coverage to server totals and filters; it does not claim that the first SHL-20 replay tested those totals.

Evidence in `/private/tmp/codeflow-qa-continue/`: `final-delta-approval-probe.log` and `final-delta-approval-probe/` (original failing live receipt), `final-approval-baseline.log`, `final-approval-related.log`, `final-approval-browser.log`, `final-approval-browser/` (screenshots, API receipts, browser/server logs), `final-approval-original.log`, and `final-approval-tsc.log`. All execution used explicit scratch `CODEFLOW_HOME`, scratch repositories, fake providers, and reserved loopback ports. No live repository, home, port, or external effect was used.
