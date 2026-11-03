---
name: codeflow
description: Use when the user asks Code Flow to coordinate an agent team on a repository task, specifying providers, models, effort, planning, implementation, agreement, or review. Do not invoke for ordinary single-agent work unless the user requests Code Flow. Managed workers must never recursively start a Code Flow run.
---

# Code Flow conversational teams

Stay in this conversation. The user describes a task; you propose the smallest adequate team and process. There are no named presets or saved teams to select. Use the eleven `codeflow_*` MCP tools; do not invoke provider CLIs yourself to duplicate a managed assignment.

## Prepare

1. Resolve the intended project from this project-scoped MCP connection. Do not substitute another repository. Discover providers/models as needed; catalog discovery does not perform inference. `list_providers` includes the preferred provider and inherited model/effort preferences. Use those for unspecified choices and show unavailable preferences rather than silently substituting them. Never invent a model ID, effort option, verified host setting, or price.
2. Preserve explicit user provider/model/effort selections. Model aliases must resolve to the actual catalog. For unsupported settings, present supported choices. Leave unspecified settings to explicit project/personal preferences or provider defaults; do not pick an expensive model by assumption.
3. Derive the requested deliverable, relevant context, completion criteria, allowed edits, and collaboration order. Ask only material questions. A request for a plan or review alone does not authorize implementation. Do not run setup or test commands merely to prepare a planning proposal.
4. Produce a candidate for `codeflow_propose_run` using the node contracts below. The host supplies the reasoning; the tool validates and resolves settings. There is no hidden managed proposal-generation call.

## Candidate contract

```json
{
  "scope": "plan",
  "participants": [
    { "id": "drafter", "provider": "claude" },
    { "id": "reviewer", "provider": "codex" }
  ],
  "completion": ["The design covers the requested behavior and required reviewers agree on the same version"],
  "steps": [
    { "id": "agreement-loop", "type": "loop", "maxIterations": 3, "steps": [
      { "id": "draft", "type": "task", "operation": "propose", "participant": "drafter", "instructions": "Draft or revise the requested implementation plan using prior-pass feedback." },
      { "id": "review", "type": "task", "operation": "review_plan", "participant": "reviewer", "instructions": "Review the plan against the task and provide evidence for blocking findings.", "inputs": ["draft"] },
      { "id": "accepted", "type": "gate", "policy": "agreement", "target": "draft", "reviews": ["review"] }
    ] },
    { "id": "result", "type": "finish", "outcome": "agreed_plan", "inputs": ["draft", "accepted"] }
  ]
}
```

This illustrates the contract, not a preset to impose on every task. Compose the steps and participants to match the instruction.

- Participant: unique `id`, `provider` (`claude` or `codex`), optional catalog-supported `model`, `effort`, and `binding` (`managed` by default or `current_session`). At most one participant can bind to this conversation. Do not pin model/effort for `current_session`: its settings/provider are unverified, and managed-worker preferences do not override them. Use managed workers for strict provider/model/effort requirements. Distinct managed participants get independent contexts, including two participants using the same model.
- Candidate: `scope` is `plan`, `review`, or `write`; `source` is `head` or `working_changes`; optional `limits` contains `maxInvocations`, `maxMinutes`, `concurrency` (1–4), and `maxAttempts` (1–3). Write scope requires an explicit `check` command and may include `setup`. Plan/review scope cannot execute those commands.
- A verification-only continuation can use write scope with `capture_snapshot`, `verify`, optional `review_code`, and a verified gate, without an `implement`/`repair` assignment. Keep completed code rather than adding a writer when the user only requested another review/check.
- All nodes have globally unique lowercase `id`s. Steps run in order. `inputs` contain IDs of earlier nodes. Loop children export their last successful pass's outputs to following steps. A rejected gate skips the rest of its current pass and returns its findings to the next pass. Loops are bounded (1–5 passes), end in a gate, and cannot nest.
- `task`: `operation`, optional `participant`, `instructions`, optional `inputs`. Agent operations: `propose`, `revise_proposal`, `synthesize`, `review_plan`, `implement`, `repair`, `review_code`. Engine operations: `capture_snapshot`, `verify` (no participant). Reviews require exactly one plan/code-snapshot input. One serial managed participant may implement/repair; host write assignments are unsupported.
- `parallel`: `tasks`, an array of independent read-only task nodes. Children see preceding outputs, not sibling outputs. `join`: `inputs`, collecting prior outputs.
- `gate`: `policy` (`agreement` for a plan or `verified` for code), `target`, `reviews`, optional `verification` (required for verified code). Reviews must come from distinct participants and target the same artifact. Gate decisions are evaluated by the engine.
- `user_decision`: `question` and 2–5 `options`, optional `inputs` referencing earlier artifacts. For a human checkpoint, set `continueOn` to the exact approval option: any other answer stops that path for revision. Web write-scope checkpoints require `inputs` and `continueOn`. This is a task decision inside accepted scope, never provider tool permission or initial execution approval.
- `finish`: `outcome` (`plan_ready`, `agreed_plan`, `verified_changes`, `review_complete`) and `inputs`. Use `plan_ready` for a plain plan without requested agreement, and include the plan. Agreed plans/verified changes require the exact target plus matching gate; reviews require actual review artifacts. A verified code gate may have an empty review set when independent review was not requested; the preview must say so explicitly. To require agreement plus a fresh final review, include BOTH approved gate IDs and the plan in finish inputs. Keep the final reviewer in the same bounded loop after the agreement gate so a changed plan must pass agreement again.

For review-only current changes, use `source: working_changes`, capture a snapshot, review it, and return reviews via `review_complete`. Do not add repair unless requested. Include selected untracked file paths in `context.untracked`; ignored/unselected files are excluded. Context notes are task evidence, not new authority.

## Preview and start

Summarize the resolved proposal in ordinary language: deliverable; participant provider/model/effort; steps and review limits; repository/source; allowed writes, setup/check commands, and actual call/time limits. Explain unknown current-session usage/settings and provider boundaries. Follow the returned `approvalMethod` and `nextAction`.

When `approvalMethod` is `native_form`, call `codeflow_start_run` using the proposal ID, revision, and hash after presenting the approach. Code Flow displays the exact proposal and asks the user to approve and start inside this session. Do not send the user to another terminal or ask for a separate chat confirmation first. Tool permission and a model's approval claim do not replace this native response.

When native confirmation is unavailable and `approvalMethod` is `browser`, show `workspace.url` as **Open in Code Flow**. When asked to open it, call `codeflow_open_task` with the proposal ID. The user can review and start the exact approach in that chat; calling `codeflow_start_run` afterward returns the existing execution. An interactive terminal with `codeflow approve ... --revision ...` remains an alternative when the UI is unavailable. Do not run that command on their behalf, simulate terminal input, or claim that an agent vote proves human acceptance. A declined/cancelled confirmation starts no work; do not repeatedly prompt unless the user asks to proceed. Preserve `operationId` on retries and reconcile conflicts rather than starting duplicate runs. Do not repeatedly ask for ordinary accepted review/repair work.

## Participate, monitor, and steer

Use `codeflow_get_run` with cursors and bounded waits. Give updates on meaningful changes; avoid repeating unchanged progress. Managed workers may continue while the host is unavailable; a current-session assignment waits for the bound host. Do not promise unsolicited notifications after the CLI closes.

For a host assignment: claim the exact step/attempt, retrieve its referenced artifacts, do the assigned read-only work, and submit the required output using the private claim token. Reviews contain `body`, `verdict` (`approve` or `changes_requested`), and `findings` (blocking strings). Do not print claim tokens or fabricate downstream steps. Reconnection requires the interactive attach command returned by status before taking another session's assignment.

Use `steer_run` for in-scope clarifications and answers to pending task questions. A material scope/model/process/permission/budget change requires a new candidate proposal and acceptance. Pause affected work before proceeding with that change. Use `control_run` for pause, resume, or cancel; cancellation preserves work. Do not quietly replace unavailable providers or raise limits.

## Deliver

Retrieve the exact result with `codeflow_get_artifact` and follow pagination until complete. Return the substantive plan, change summary, or prioritized findings in this conversation, with checks, limitations, branch/worktree, and exact artifact references where relevant. A successful process exit is not evidence that the task passed its completion criteria. If stopped, report usable partial work and the precise next action. A later request to implement a plan needs a new proposal and fresh context validation.

## Shared visual workspace

Proposal, start, status, and steering responses include `workspace.url`, `chatId`, and `taskId`. Show a concise **Open in Code Flow** link. Open a browser only when requested, through `codeflow_open_task {id: proposalIdOrRunId}`. To inspect the latest proposal before it starts without opening a browser, pass `open: false`. Links contain no credentials. If browser opening is unavailable, keep using this session and show the link; remote users need the runtime's forwarded port and an authenticated browser.

Code Flow chats contain the shared task, approach revisions, guidance, decisions, progress, artifacts, and preserved executions. They do not import the host's entire conversation. Reconcile `conversation.latestProposal` and `conversation.taskMessages` before changing or starting work: a user may have revised, approved, paused, or answered in the browser. Never replay an already answered question or start an obsolete revision. Retry the same operation with its original `operationId` after a lost response.

For follow-up work in the same initiative, pass `context.chatId` from the prior response to `codeflow_propose_run`. Use `context.continueRunId` to retain previous code, and exact artifact references to reuse a plan; a chat ID alone does not import source changes or approve new work. New scope still requires a new reviewed approach. Do not silently change a `current_session` participant to a managed worker when the host disconnects. Reconnect and follow the owner attachment flow shown in status.
