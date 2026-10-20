# Selective task reruns

Open an idle Auto-team result, select tasks to rerun and inspect the dependency preview. Allocate a fresh budget; the new child run must verify its final result independently.

## Repeat only the work that changed

Open an idle Auto-team result and expand **Rerun selected tasks**. Select the accepted tasks to execute again, optionally replace instructions for those selected tasks, review the dependency preview, and allocate a fresh call/time budget. Every transitive dependent task is invalidated, including completion, artifact and knowledge dependencies. Unselected tasks with unfinished or stale work must also be selected; their old evidence cannot be silently retained.

The action creates a child run at the exact integration commit shown in the form. It does not edit, resume, or change the original run. Uncommitted worker changes are excluded and remain in the original checkouts. Failed, stopped and interrupted results can be rerun when they have an accepted plan and owned integration checkpoint. A baseline without passing parent verification is explicitly marked unverified. If the integration branch moves after the preview, refresh and review its new commit before starting.

The child executes the pinned accepted plan directly; it does not ask a coordinator to create a replacement plan. Stable task/member IDs, requirements, dependencies, acceptance, ownership paths, contracts, provider pool and model/effort settings remain fixed. Selected tasks and every dependent start pending, without prior attempts, heads, artifacts, handovers, sessions, private checkpoints or verification evidence. Other completed tasks are labeled **retained baseline inputs**, with their source run, source task commit and integration baseline. Their commits must be ancestors of that baseline. Retained public artifact references and handovers are source data, not new instructions or authorization.

All checks, reviews, fail-to-pass claims, human coverage, messages, context manifests and execution metrics start independently in the child. Every original requirement receives a fresh final independent review. A retained task count is not a new execution count; the evaluation records retained tasks and newly executed tasks separately. If the source member was retired or its pinned provider/model is no longer eligible, the rerun fails explicitly instead of silently changing the team or permissions.

An implementation rerun can legitimately produce no new diff when the accepted behavior already exists. This is measured by Git, not accepted from an agent's assertion. Such a result still requires a passing check on the child commit and independent approval of its acceptance. An entirely unchanged result does not fabricate fail-to-pass evidence: it records `proofNotRequired: "unchanged-rerun"` after the fresh check and review. Any new code diff, including a repair, retains the normal proof policy.

Plan approval follows the source's setting. A rerun's held plan cannot be replaced through the plan editor or a coordinator revision request; reject it and create another selection to change its task set or instructions. Runtime questions and bounded repairs continue through normal Auto-team controls. An internal, checksummed seed is journaled before execution, so restart/resume restores the same selected work and pinned baseline projection. The checksum detects changed replay data; it is not an authorization token.

`POST /api/runs/:id/rerun-tasks` accepts:

```json
{
  "expectedHead": "EXACT_CURRENT_INTEGRATION_COMMIT_SHA",
  "taskIds": ["implement-api"],
  "instructions": {"implement-api": "Recheck the error path and its acceptance tests."},
  "budget": {"maxSteps": 12, "maxInvocations": 12, "maxMinutes": 20}
}
```

It returns `201 {"id":"CHILD_RUN_ID"}`. Requests need 1–24 distinct known tasks and an explicit fresh allocation of 4–200 calls and 1–720 minutes. The effective call budget must fund the invalidated tasks, independent review and one recovery allowance. Unknown fields, forged seeds and instructions for unselected tasks are rejected. Stale source state, unavailable pinned roles, or overlapping source operations return 409. Concurrent identical creation requests share one child while pending; after that creation finishes, a repeated request deliberately creates another child. A dropped response should therefore be reconciled by inspecting run history before retrying.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
