# Domain model and data contracts

Status: proposed. [Index](README.md)

## Identity and versioning

IDs are opaque, stable, and never derived from a display name alone. Provider ID, participant ID, role ID, provider session ID, host connection ID, and user actor ID are distinct concepts. The server derives actor identity from its connection binding; tool arguments cannot choose another actor.

Every definition has `schemaVersion`, `id`, and positive `version`. Every mutable run/proposal projection has `revision`. Saved versions and artifacts are immutable. Use deterministic canonical JSON for hashing: recursively sorted object keys, ordered arrays preserved, UTF-8 encoding, no undefined values or non-finite numbers. Record the canonicalization version alongside hashes.

## Configuration entities

| Entity | Required content |
| --- | --- |
| AgentProfile | Provider; model selection; effort selection; capability requirements |
| RoleContract | Input/output artifact types; instructions; access mode; participant cardinality; independence rules |
| TeamDefinition | Participant entries referencing profiles; role-to-participant bindings; workflow reference |
| WorkflowDefinition | Graph nodes/edges; inputs; outputs; bounded loops; gate policies |
| Proposal | Task/context references; concrete definitions; resolved assignments; repository/snapshot; checks; limits; unresolved questions |
| AcceptanceRecord | Proposal revision/hash; policy revision; actor and acceptance channel; timestamp; invalidation state |

An `AgentProfile` is reusable settings, not a running agent. A `Participant` is a role-capable execution identity for one run. Same-provider participants must not share private sessions by accident.

```ts
type Selection =
  | { kind: "explicit"; value: string }
  | { kind: "provider_default" }
  | { kind: "current_session" };

type DefinitionRef = { id: string; version: number };

type ParticipantDefinition = {
  id: string;
  profileRef: DefinitionRef;
  bindingPreference: "managed" | "prefer_current_session";
};

type Binding =
  | { kind: "managed"; profileRef: DefinitionRef }
  | { kind: "host"; connectionId: string };

type ArtifactRef = {
  id: string;
  revision: number;
  sha256: string;
  kind: "requirements" | "proposal" | "plan" | "review" |
        "code_snapshot" | "verification" | "decision" | "instruction" | "result";
};

type Assignment = {
  runId: string;
  stepId: string;
  attemptId: string;
  participantId: string;
  roleId: string;
  inputRefs: Record<string, ArtifactRef | ArtifactRef[] | null>; // null only for declared initial loop state
  workspaceId?: string;
  instructions: string;
  outputKind: ArtifactRef["kind"];
  policyRevision: number;
  deadlineAt: string;
};
```

Operation contracts supply the fixed input/output types and bounded instructions. A workflow role declaration supplies cardinality, access, and independence constraints for those operations; it need not duplicate all registered operation instructions. Participant definitions in saved teams contain binding preferences, never live connection IDs.

A published artifact type can differ from the untrusted submission schema: an implementation report names an owned workspace and describes changes, then the engine captures the actual `code_snapshot`. A model-authored hash is not filesystem evidence.

These snippets describe contracts; runtime validation must reject unknown fields, oversized values, and invalid enum combinations. JSON Schema files and TypeScript types are implementation deliverables, not present in this documentation folder.

## Resolved settings

Store requested and resolved values separately. A catalog record includes provider ID, CLI version, model ID, supported effort values, discovery time, and source. A model being listed is not proof that a paid call will succeed.

Explicit settings must be validated before acceptance and again before dispatch. Provider-default selections are resolved to concrete observed settings when possible. If the provider does not expose a resolved default, record `provider_default_unverified` and display it. If it changes observably during a run, stop for a configuration revision. A host's self-reported model/effort is labeled as such; unknown does not become a guessed value.

A strict model/effort role cannot bind to an unverified host session. Use a compatible managed participant instead. Alias resolution must not silently change an accepted explicit model pin. `current_session` selections require a host binding; a managed fallback must resolve a concrete compatible selection and appear in the accepted proposal rather than inheriting an unknowable host value.

## Runtime entities

| Entity | Required content |
| --- | --- |
| Run | Accepted config hash; repository identity; revision; state; budgets; graph snapshot |
| StepInstance | Node ID; loop iteration path; participant; input refs; state; current attempt |
| Attempt | Start intent; dispatch identity; claim token digest; process/session references; outcome |
| Participant | Binding; role membership; settings provenance; lifecycle; capabilities |
| Artifact | Typed content; hash; immutable revision; provenance; storage locator |
| Finding | Stable ID; target ref; severity; blocking flag; evidence; resolution history |
| GateDecision | Policy; exact target; eligible reviewers; included verdict refs; derived result |
| Verification | Code ref; check/profile version; environment fingerprint; outcome; logs |
| ControlReceipt | Operation ID; actor; expected revision; durable decision; result |

Step identity is deterministic over run ID, workflow version, node path, loop iteration path, and participant ID. Attempt identity changes on retry. IDs and actor bindings are not accepted from provider-authored text.

## Artifact payload requirements

- Requirements: original request, acceptance criteria with stable IDs, non-goals, declared assumptions.
- Proposal/plan: title, approach, scoped changes, requirement mapping, risks, verification approach, unresolved decisions.
- Review: exact target ref, verdict, findings, requirement coverage, evidence refs.
- Code snapshot: repository identity, base ref, immutable tree/manifest hash, changed paths, origin and workspace.
- Verification: check ID/version, target code ref, environment, result (`passed`, `failed`, `unavailable`, `cancelled`), execution evidence.
- Instruction: scope, sender provenance, affected requirement/assignment references, and text; never execution authority by itself.
- Result: requested deliverable, outcome, actual plan or changes, checks, outstanding findings, next action, artifact refs.

Human-readable Markdown may accompany structured fields. The executor consumes structured fields, not text scraped for words such as “approved” or “done.” Artifact IDs cannot be arbitrary filesystem paths.

## Finding lifecycle

Use `open -> addressed -> resolved`, with an alternative `disputed` state. A builder can mark a finding addressed and attach evidence; it cannot declare the reviewer's finding resolved. Resolution requires reviewer confirmation or a recorded policy-authorized user decision. A dispute has evidence and remains visible. Optional suggestions do not block unless explicitly included in accepted completion criteria.

Plan/content changes invalidate all votes on the prior target. Code changes invalidate check/review evidence for the prior code snapshot. A gate cannot assemble approvals from different targets.

## Run and step state machines

Run states:

`proposed -> awaiting_acceptance -> ready -> running`

From running: `waiting_user`, `waiting_host`, `waiting_provider`, `paused`, `recovering`, `completed`, `failed`, `cancelled`, or `stopped_limit`.

Waiting states resume only when their specific dependency is satisfied. `failed` means an execution failure, not simply a reviewer requesting revision. `completed` means accepted completion rules passed. A partial/unverified build is an artifact on a waiting/stopped run, not a completed verified build. A review-only run can complete after delivering findings even when the code has issues: its result outcome is `review_complete`, never `verified_changes`.

Step states:

`pending -> ready -> claimed/dispatching -> running -> succeeded`

Alternative states: `blocked`, `failed`, `cancelled`, `uncertain`, `superseded`, `skipped` (only an explicit graph branch). A submitted result is validated and committed before `succeeded` is derived. A stale attempt can never overwrite the current attempt.

## Data lifecycle

Project definitions are portable and version-controlled. Runtime records, sessions, credentials, and local overrides live in private application state. Retain artifact provenance across resume and handoff. Removing a project integration does not delete its runs or workspaces. Cleanup must be explicit, must refuse active/uncertain ownership, and must preserve user-owned files.
