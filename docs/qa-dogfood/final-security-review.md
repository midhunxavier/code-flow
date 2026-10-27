# Final adversarial security and correctness review

Reviewed commit: `6eb901c9b7dd5ae061197df7016f5d51e39b74d8` against `f14f404`.
Review checkout: `/private/tmp/codeflow-final-security-review` (detached, clean).

## Result

No new confirmed actionable finding in the boundaries reviewed below. This is a bounded review of selected authority, persistence, cleanup and dispatch paths, not a claim that the entire integration is free of defects. Cluster 51 was not present in this pinned integration and is excluded from this result.

The review was read-only. Every application, import and test command used an explicit outer scratch `CODEFLOW_HOME`; fixtures used scratch state, scratch repositories and fake providers. No live application home, live server on 4317/4318, real SSH destination, remote push or provider mutation was used. No new browser run was performed during this final review.

## Independently executed verification

1. **66/66 passed**, zero failures, about 21.6 seconds:
   - `test/qa-code-hosts-review.test.ts`
   - `test/shared-accounts.test.ts`
   - `test/qa-auth-session-accounts.test.ts`
   - `test/qa-auth-session-accounts-cleanup.test.ts`
   - `test/qa-phone-pairing-pages.test.ts`
   - `test/qa-phone-listener-tls.test.ts`
   - `test/filesystem-policy.test.ts`
   - `test/engine-filesystem-policy.test.ts`
   - `test/ssh-gateway.test.ts`
   - `test/qa-automation-webhooks.test.ts`
   - `test/retention-policy.test.ts`

   Evidence: `/private/tmp/codeflow-qa-continue/final-security-tests.log`.

2. **37/37 passed**, zero failures, about 10.8 seconds:
   - `test/maintenance.test.ts`
   - `test/persistence.test.ts`
   - `test/qa-provider-health.test.ts`
   - `test/qa-diagnostics-maintenance.test.ts`
   - `test/remote-tls.test.ts`

   Evidence: `/private/tmp/codeflow-qa-continue/final-security-persistence-tests.log`.

Both batches ran from the pinned review checkout with:

```sh
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-security-home node --import tsx --test --test-concurrency=2 <files above>
```

These reruns establish the listed regression boundaries on the integrated revision. They do not independently exercise real providers or every possible operating-system race.

## Source boundaries reviewed

### Authentication, sessions and filesystem authority

Inspected the changed server dispatch boundaries and their surrounding logic: local Host/Origin validation; LAN exact-origin validation; port-scoped owner cookies and legacy-cookie migration; explicit owner bearer precedence; shared-cookie presence preventing silent owner fallback; runner credential/member revalidation; shared-account error behavior and request authorization; login, invitation acceptance and logout; token removal preserving safe deep-link state; local team handoff; local-only computer proxy; phone pairing GET/POST boundary and existing-session reuse; filesystem-policy activation checks and owner API gating.

Read the shared-account changes for failed-storage behavior, sign-in rate-limit reservations, invitation grants, bounded sessions and disabled-account removal. Read phone-session storage/capacity changes. Read the filesystem-access route classifications and the filesystem-policy changes for directory traversal, sensitive directories, ancestor resolution and unchanged policy revisions.

Tests exercise revoked/invalid sessions, credential and account cleanup, phone authority, policy restrictions, restricted native execution and related failure handling. Phone pairing security was also reviewed earlier during cluster 41; only the present listed tests were rerun here.

### SSH, remote access and proxies

Inspected the SSH gateway and manager changes: transport identity and health-generation checks, recovery serialization, stream closure, removal of forwarded credential/cookie/referrer headers, redirect refusal, response sandbox headers, local transport ownership and absence of mutation replay. Read environment-certificate inspection and TLS hostname/key/date validation changes.

A suspected bypass was investigated and **refuted**: `SshProjects.list()` can perform health probes, but `/api/ssh-hosts` rejects requests when filesystem restrictions are active before invoking the list operation. It is not a reachable policy bypass through that route.

The final test batches cover delayed SSH recovery without replaying mutation requests, phone listener capabilities, certificate validation, certificate issuance bounds and temporary-key cleanup. No real SSH or certificate issuance service was used.

Also inspected the changed browser-control authority checks and stable-target/document identity checks, including isolated annotation execution and uncertain-action handling. This was a focused read, not a complete browser subsystem audit.

### Imported code and publishing

Read imported-commit provenance helpers, bounded trusted-ref capture, marker retention, legacy cleanup, staging fetch and atomic import behavior. Inspected the publication operation ledger, pre-dispatch effect boundary, current project membership checks, owned result checks, exact source/target verification and push leases. Read the full unpublished-range integrity helper used by PR watch follow-ups. Checked engine admission sites for imported raw SHAs and isolated code-review continuation; the entire engine diff was not exhaustively reviewed.

The independent code-host regression file covers imported raw target, base and intermediate identities; existing local history remaining native; cleanup after repeated failures; friendly missing-base errors; legacy migration; launch preflight versus registered-run outcomes; and successful isolated continuation.

The legacy import migration cannot reconstruct a lost historical pre-import trust snapshot for a target already aliased by an ordinary local ref. That documented compatibility limitation is not a new finding from this final pass. New imports use the captured trust boundary.

### Automation triggers

Read the explicit ordinary-versus-sweep GitHub event matrix, public webhook authentication ordering, bounded payload handling, bearer/HMAC authorization, input normalization, untrusted details handling, source admission claims, duplicate receipts, queue handling and sweep claim cleanup. The focused tests exercise event/action filtering, retry/dedupe behavior and ordinary-versus-sweep selection. No real webhook provider was called.

### Persistence, cleanup and process ownership

Read process-registry exit changes: an import-only process does not overwrite another registry or recreate a deleted state directory, while a process that owns tracked children still kills and clears them. Inspected shutdown failure normalization, append completion/write-health callbacks and shared state-lock extraction.

Inspected maintenance output preflight and exclusive output creation, offline locking, restore authority exclusion/disabled execution state, retention managed-root validation, missing-directory handling, source fingerprints, symlink rejection and non-forced Git worktree deletion. Read account cleanup changes that revoke execution/terminal grants before deleting account records. Reviewed connection migration failure handling and the changed integration/ACP validation surfaces. The large collaboration store diff and every filesystem operation were not exhaustively audited.

Tests cover encrypted backup round trips with authority material excluded, restoration disabling background effects, maintenance locking/output failures, persistence across restart and shutdown, registry ownership on exit, credential redaction, retention protections and TLS temporary-file cleanup.

## Earlier independent findings already handled before this pin

These are not outstanding findings against this revision:

- During cluster 53 review, a VS Code disconnect could occur while the real client awaited compatibility checks, after the extension's earlier guard but before POST dispatch. The isolated VM/HTTP probe recorded one start after disconnect. The root agent added the dispatch-boundary guard and a regression, and corrected wording for uncertain POST outcomes before integration. Probe evidence is under `/private/tmp/codeflow-qa-continue/clients53-review/`.
- Cluster 51's separate ML review found a missing-best-job patience comparison issue and verified scratch upload-resumption edge cases. Its owner repaired the patience check, but cluster 51 is outside the pinned integration reviewed here. Evidence is under `/private/tmp/codeflow-qa-continue/ml51-review/`.

## Limits

No whole-application security certification is implied. This review did not perform real provider, real cloud, real SSH, native OS permission, multi-machine or destructive live-data testing. It did not exhaustively enumerate every server route or every large engine/collaboration diff hunk. The final application/browser/asset-budget validation remains owned by the parent integration task. Changes integrated after `6eb901c` require their own checks.
