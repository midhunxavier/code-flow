# Review 0: Dynamic teams implementation plan

> Engineering record. Status, measurements and decisions below describe the recorded implementation or review. For current usage, start with the [documentation library](README.md).

Reviewed: `docs/dynamic-teams-implementation-plan.md`, uncommitted, dated 17 October 2026, written against `ee246c7` (the current `main`).

Lens: the product promise the plan exists to serve.

> Give code-flow a task; it assembles an appropriate team from your available agents, coordinates their work, and delivers a verified result with reusable project knowledge.

Method: every claim the plan makes about the current code was checked against the working tree, and the four external references were fetched. Findings cite files and functions so they can be re-checked.

## Verdict

The plan is a careful systems design. Its invariants are the right ones: no silent success, unknown is not a pass, persist before dispatch, at-least-once delivery with idempotent application, agents propose and the runtime verifies. The record model is coherent and the acceptance tests are specific. None of the factual claims about the codebase are wrong.

The problem is the order. The promise becomes visible to a user in Phase 5 of 8, after a storage migration (P1), a memory subsystem (P2), a new scheduler (P3) and a messaging layer (P4) have each shipped. The plan's own stated reason for a new recovery model is already met by the existing journal, so the biggest early investment rests on a justification that does not hold. The first user-visible milestone the plan names, "the restart-safe question-and-answer scenario at the end of Phase 4", is a reliability demo, not the promise.

Recommendation: do not approve the phase order as written. Approve the invariants, the schemas, and the adapter capability inventory. Add a thin vertical slice of the promise on the existing engine before Phase 1, and let what it measures decide the storage, scheduler and messaging investments. Details are in "Proposed re-sequencing" below.

## What the plan gets right

- **code-flow owns the team.** This is confirmed by the vendor docs the plan cites: Claude's agent teams do not spawn under `-p`, which is how code-flow runs Claude, and they are experimental with no session resumption for in-process teammates. There is nothing to delegate to.
- **Member identity separate from provider identity.** `AgentId` is `"claude" | "codex" | "agy"` (`src/adapters/types.ts:9`). `resolveAuto` deduplicates within a role, and `addNote` targets an `AgentId`, so a note to "codex" goes to whichever Codex turn starts next (`src/engine.ts:617`). Two Codex workers really are indistinguishable today for notes, usage and Insights.
- **Verification in the runtime, bound to evidence.** This extends what `check()`, `integrity.ts` and `fixUntilGreen` already do, and keeps the product's distinguishing rule: a result is done when the tests pass, not when an agent says so.
- **Turn-boundary messaging first, live steering as an enhancement.** Only Codex app-server can take input mid-turn (`turn/steer`); Claude takes its prompt on stdin and agy has no input path. Making correctness independent of live transport is correct.
- **Candour about unknowns.** The adapter matrix marks untested capabilities unknown, nested vendor subagents are called out as unaccountable, and the plan refuses to estimate dates before the spikes. That is the right posture.
- **Explicit outcomes with gaps.** "A gap must never become success merely because all runnable tasks ended" is the single most important product rule in the document.

## Major findings

### 1. The promise arrives last

Phases 1 to 4 build durable state, memory, a scheduler and mailboxes. A user sees "describe the task, watch the team work" only in P5, and only from the normal composer in P7. The "first collaboration release" after P4 still requires a hand-configured team and a hand-supplied workflow, which is a worse version of the supervisor pattern that exists today.

The existing supervisor pattern already does more than half of the promise: a model decomposes the task, writes contracts, assigns workers, workers build in parallel worktrees, the runtime integrates, checks, and gets an independent review, and the user approves the split before anything runs (`src/patterns/supervisor.ts`). The delta to the promise is: the coordinator chooses members and models rather than assigning among a user-picked roster; more than one round; and members that can ask each other questions. The first two are cheap on the existing engine. Only the third needs new machinery, and the plan has not shown how often it is needed.

Recommendation: build the delta first, on the engine that exists, and measure. See "Proposed re-sequencing".

### 2. The new runtime's recovery justification is already met

Section 2, point 2 says a dynamic workflow "must not reconstruct the team by asking the model to plan again", and presents this as the reason pattern replay is unsuitable. But `TeamContext.remember()` journals the result of every `decide()` and `ask()` under `kind:identity#occurrence` and returns the recorded value on resume (`src/engine.ts:714`). A coordinator's plan produced through `decide()` is replayed, not re-asked. As long as the pattern's control flow is a deterministic function of journaled values, which is the existing contract, a dynamic pattern recovers without re-planning. Claude's own dynamic workflows use exactly this model: replay by prompt equality, with the first differing agent and everything after it re-run.

Where the journal genuinely falls short is different and should be stated as such: long-lived members with mailboxes that outlive any one pattern pass, and event-driven wakeups that are not expressible as a linear replay. Those are the real reasons to consider a new runtime. Whether they are worth it depends on how often members need to talk, which nobody has measured.

### 3. SQLite is a platform decision presented as a spike

The repository has five runtime dependencies and no native module. `package.json` says `node >= 20`, and CI runs Node 20 on Linux. `node:sqlite` does not exist on Node 20. That leaves three options, each a real cost: a native dependency with prebuilt binaries and a node-gyp fallback; a WASM build whose durability semantics differ; or dropping Node 20. Phase 0 defers the choice, but every later phase is designed around SQLite semantics (transactions, outbox, leases, migrations), so the "spike" is not free to fail.

What the plan actually needs is narrower than a database: atomic commit of a small batch of related records, crash-safe recovery, and idempotent operation application. The server is already the single writer (the one-server lock in `src/store.ts`). One fsynced append of a JSON line holding the whole batch is atomic under that constraint, torn lines are already detected and skipped (`test/store-reliability.test.ts`), and in-memory projections rebuilt at load are how runs work now. The journal is already synced and awaited before the pattern moves on (`src/store.ts:167`); only the event log append is best-effort. The plan's phrase "the current best-effort logging behavior is not sufficient" is true of the event log and not of the journal, and should say so.

Recommendation: state the required storage properties, not the technology. Default to extending the existing append-only store with batch records and a snapshot, and keep SQLite as the fallback if a measured need appears (query volume, project memory search at scale). If SQLite is chosen anyway, make the Node 20 decision explicitly in P0 rather than letting the driver choice make it.

### 4. The reference designs use simpler persistence than the plan

The plan cites Claude agent teams and Claude dynamic workflows as references. Both were checked. Agent teams use one JSON file per mailbox and file locking for task claims; dynamic workflows persist per-agent results and replay by prompt equality; neither uses a transactional store, an outbox or leases. They also document limitations the plan should expect to inherit: task status can lag, teammates stop early, the lead can declare done before tasks finish. Those are prompt and policy problems, not storage problems, and the plan's verification-in-runtime stance is the right answer to them. The reference designs therefore support a lighter P1 than the plan proposes.

### 5. "Appropriate team" has no definition

The promise's load-bearing word is "appropriate". The plan says routing must stop deduplicating providers and must expose fallback reasons, but it never states the composition policy the coordinator is constrained by. The existing product encodes composition wisdom that should carry over as rules, not be rediscovered by a model:

- A reviewer or judge should be a different provider from the author ("a good default is to have a different vendor review", `docs/patterns.md`). The supervisor pattern warns when it cannot do this.
- Routing skips providers at 90 percent of a usage window or recently limited (`src/routing.ts`), and prefers the provider whose code passes most often in this repo (`src/stats.ts`).
- A small task uses one worker. The plan says this but gives the coordinator no rule for it.

Recommendation: write the composition policy as validation rules in P0 (minimum and maximum members by task size signal, independence constraints for review, quota and ranking inputs, user-pinned choices), and have the coordinator propose within them. The acceptance tests in P5 then test the policy, not a model's taste.

### 6. The plan-approval checkpoint is missing from the promise's flow

`ctx.approve("plan")` exists and the supervisor pattern uses it to show the split and contracts before any worker starts (`src/engine.ts:595`, `src/patterns/supervisor.ts`). For a product that assembles a team and spends the user's subscription quota, approving the team and plan is the most important control, and it already exists. The plan mentions "existing review/permission choices" in P7 and an "awaiting input" outcome, but never names the checkpoint: show the proposed members, models, tasks, acceptance criteria and estimated turns, and let the user approve, revise, or reject before dispatch. Section 3.1's "requirements with stable IDs" should be the editable list the user approves here, rather than a model-extracted artifact treated as ground truth.

### 7. Project memory has no trust boundary

Runs started from issues, PRs or alerts by people outside the repo are locked down: Safe mode, no `.env`, checks in Docker (`src/engine.ts:2168`). The plan adds `publish_finding` and promotion to project memory, which every later run reads. An untrusted issue that persuades a worker to publish a "convention" would then reach every future run in that project. Section 6.3 says memory is "not an instruction source allowed to override the current user or permissions", but offers no mechanism.

Recommendation: memory entries carry the originating run's trust level; locked-down runs cannot promote automatically and their proposals wait for the user; retrieval marks entries by provenance; the lockdown rules extend to messages between members in a locked-down run. Add this to P2's acceptance tests. The existing `UntrustedSourceError` and `lockdown` fields are the hooks.

### 8. Coordinator cost is unmeasured until Phase 8

The product's premise is subscriptions, and the vendor docs the plan cites say teams "use significantly more tokens". Each coordinator wake is a CLI session resume with full context. The plan measures "coordinator overhead" in P8, after the architecture is fixed. It should be the first number produced, because it decides how event-driven the coordinator can afford to be (per event, per wave, or per phase) and therefore how much of P3 and P4 is needed. A related gap: a long-lived coordinator session grows until the CLI compacts it; the plan's portable checkpoint is the answer but is never connected to the coordinator.

### 9. Memory before execution is the wrong order

P2 builds relevance selection, context budgets, manifests and promotion before P3 produces any workflow data to select from. Relevance cannot be tested without tasks, contracts and findings flowing. Split P2: the parts P3 and P4 need (private checkpoints, accepted team contracts, context manifest) come first; project memory, promotion, retention and deletion come after P5, when there are real findings to promote and the lockdown rule from finding 7 can be tested against real runs.

### 10. The record model is heavier than turn-boundary messaging needs

Twelve records and three stored state machines. At turn boundaries, "delivery" is "included in the prompt of attempt X", which the context manifest already records; a separate Delivery record only earns its keep with live steering in P6. Member status (idle, running, waiting) is derivable from the member's active attempt and open requests, so storing it invites drift. Message, Request and Delivery can start as one record with a type. Keep the plan's names but defer the splits until a phase needs them.

## Minor findings

- **Budget semantics change silently.** P3 says "resume alone does not grant an unlimited new budget". Today resume explicitly grants "a fresh budget" (`src/engine.ts:2285`, `docs/runs.md:82`), and that is a documented product decision. Changing it for team runs is defensible; say that legacy and team runs differ, and why.
- **Verification binding is over-specified.** Binding evidence to commit, contract revision, workflow revision, check definition and environment fingerprint is five dimensions where two (commit SHA and check command, plus setup fingerprint when `.codeflow/config.json` sets one) cover the cases that occur. Start there; add dimensions when a test shows they are needed.
- **`findPattern` is a small problem.** Four call sites (`src/server.ts:406`, `:956`, `src/engine.ts:1830`, `:2291`), not a broad audit. And an unknown pattern id already makes resume fail safely with "Unknown pattern". Recording team runs under an id older code-flow does not know gives P8's "older executables must not execute team-v1 runs" for free; say so instead of designing a schema-version rejection.
- **SSE cursors.** `Last-Event-ID` is honoured only within one server start (`src/server.ts:626`). The plan's persistent cursor requirement is real; note that it benefits legacy runs too and could ship independently.
- **`CODEFLOW_TOKEN` is already withheld from agents** (`src/env.ts:8`). P6 presents this as a new rule; cite the existing one and extend it to the scoped credential.
- **Claude's write mode uses an `--allowedTools` allow-list** (`src/adapters/claude.ts:81`). P6's MCP bridge tools must be added to it per trust level; the capability inventory in P0 should include this.
- **Three new source directories** (`src/team/`, `src/workflows/`, `src/memory/`) in a codebase that is flat apart from `adapters/` and `patterns/`. Not wrong, but the architecture doc's layout table will need the same treatment, and roughly forty new files for a 22k-line codebase is a scale the plan should state plainly.
- **Mermaid diagram.** `Runtime --> UI` hides that the UI today is driven by the run snapshot plus SSE; the plan's "projections" should be additions to that snapshot where possible rather than five new GET routes with their own pagination.
- **Section 5.1 operations through "validated turn results first".** This is the right first transport and is under-sold: it is also the only transport that works identically for all three CLIs, which makes it the one to design the protocol around, with live tools conforming to it rather than the reverse.
- **"Dynamic-worker prompt" in P4** refers to `preamble()` in `src/patterns/prompts.ts:10` ("nobody can answer questions"). The Codex adapter has the same assumption when declining input requests (`src/adapters/codex-app-server.ts:242`). Both change together.

## Claims checked against the code

| Plan claim | Status | Evidence |
|---|---|---|
| `AgentId` means a provider | Confirmed | `src/adapters/types.ts:9` |
| Role resolution deduplicates providers | Confirmed | `resolveAuto` in `src/routing.ts`: `[...new Set(chosen)]` |
| Notes can target a provider | Confirmed | `RunManager.addNote(id, text, agent?: AgentId)`, `takeNotes` |
| Replay uses operation identities plus occurrence counts | Confirmed | `remember()` keys `kind:identity#n`, `src/engine.ts:714` |
| Prompt framing says nobody can answer | Confirmed | `src/patterns/prompts.ts:10` |
| JSONL history, replay journal, server lock in `store.ts` | Confirmed | `src/store.ts:13`, `:167`, `:329` |
| Journal writes are best-effort | Partly wrong | Journal entries are fsynced and awaited; the event log is best-effort (`writeHealth`) |
| CI matrix Node 20/22 Linux, 22 macOS | Confirmed | `.github/workflows/ci.yml` |
| No SQLite today | Confirmed | `package.json`: five runtime deps, none native |
| Codex live steering exists; others do not | Confirmed | `turn/steer` in `src/adapters/codex-app-server.ts`; Claude prompt on stdin |
| APIs assume `findPattern` succeeds | Confirmed, small | Four call sites |
| Projects hold several repos | Confirmed | `Project.repos: string[]` in `src/projects.ts` |
| Recurring findings threshold | Confirmed | `RECURRING = 2` in `src/learnings.ts` |
| Four external references | All resolve | Claude workflows, Claude agent teams, Codex subagents, LangGraph memory |

## Proposed re-sequencing

### Slice 0: the promise on the existing engine

Add one opt-in pattern, "Auto team", written against `TeamContext` like every other pattern. No new storage, no mailboxes.

1. **Plan.** The coordinator (user's choice or routed) runs one read-only `decide()` against a `TEAM_PLAN_SCHEMA`: acceptance criteria, members (`id`, role, provider, model, effort), tasks (`id`, instructions, owner, depends-on, owned paths), contracts. The runtime validates it against the composition policy from finding 5: installed providers, quota, member cap, acyclic dependencies, reviewer independence.
2. **Approve.** `ctx.approve("plan")` shows the team and plan. Revise and reject work as they do in the supervisor pattern.
3. **Execute in waves.** Ready tasks run with `ctx.parallel()`; each task is an `ask()` with `identity: task.id` so the journal key is stable; each member keeps a `memberId` to session map so two Codex members stay distinct; each task's worktree starts from the integration branch head, which is the plan's "artifact dependency through integration".
4. **Coordinate per wave.** After integrating and checking a wave, the coordinator gets one bounded `decide()` against a `REVISION_SCHEMA`: done, new tasks, reassignments, answers to questions members raised in their structured outcomes. Cap the rounds. This is event-driven coordination at wave granularity.
5. **Verify.** Independent review by a different provider, bounded repair, final check, `setVerdict` and `setFacts`, result with gaps listed.

Members ask questions by including them in a structured turn outcome; the owner or coordinator answers in the next wave's prompt. Coarse, but it is turn-boundary messaging, and it produces the number nobody has: how often a member needs an answer before it can continue.

Recovery is the existing journal. Interrupted runs resume without re-planning (finding 2).

What Slice 0 proves or refutes, with fake agents in CI and a few real opt-in runs:

- whether a coordinator produces teams a user accepts at the approval step, and how often it is revised;
- coordinator turns and tokens per task as a fraction of worker spend (finding 8);
- how often a wave stalls on a question, which decides whether P4 is needed at all or whether wave-granularity is enough;
- whether two same-provider members cause any confusion beyond notes and Insights, which sizes P1.

Exit criteria: fake-agent run of the section 9 scenario minus restart-under-delivery; a user can start it from the composer behind an opt-in flag; measurements recorded in the plan.

### Then

- **P0 in parallel with Slice 0:** schemas (Slice 0 needs them), adapter capability matrix, composition policy, verification policies by task kind.
- **Storage decision after Slice 0,** from the required properties in finding 3. The likely outcome is batch records on the existing store plus a per-run snapshot. If SQLite wins, make the Node 20 call explicitly.
- **P3 before P2,** and P2 split as in finding 9.
- **P4 only if Slice 0 shows waves are not enough.** If a member rarely needs an answer mid-task, the mailbox layer can be a later enhancement rather than a prerequisite for the MVP.
- **P5 becomes** hardening Slice 0's coordinator (reassignment with handover, member retirement, strategies as reusable sub-plans) rather than building it.
- **P6, P7, P8** as planned, with finding 7's trust rule in P2's tests and finding 6's checkpoint in P7's composer work.

## Questions to answer before approval

1. What is the composition policy? Write the rules the coordinator must satisfy; they are the product.
2. What team-messaging frequency would justify P4's mailboxes over wave-boundary answers? Pick the threshold before measuring.
3. Is dropping Node 20 acceptable if the storage spike points at `node:sqlite`? If not, say now that native and WASM drivers are the only candidates.
4. Who may promote to project memory from a locked-down run? The answer should be "nobody, without the user".
5. What does the user see and approve before any member is dispatched, and does changing the goal mid-run go through the same checkpoint?
6. What is the cost ceiling for coordination as a share of a run's agent turns, and what does the coordinator do when it reaches it?

## Notes on the document itself

- Tight, well-structured, and unusually honest about unknowns. The invariants in 3.3, 3.5, 5.2 and 5.3 should be lifted verbatim into the architecture doc when any of this ships.
- "Likely files" per phase is useful. Add "likely files removed or shrunk": the plan adds a great deal and retires nothing, and the supervisor pattern in particular should be slated to become a strategy under the new mode rather than a parallel implementation.
- The `docs/README.md` link added alongside this plan describes it as proposed. Keep that word until Slice 0 has numbers.

[Documentation library](README.md) · [Development guide](architecture.md)
