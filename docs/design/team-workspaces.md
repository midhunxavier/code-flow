# Team workspaces: design

Status: slice 1 is implemented (sections 3.1 and 3.2). Sections 3.3 and 3.4 are proposals and are not built.

This document covers where a team's agents work inside one conversation, how their work is combined, and what is left on disk afterwards.

## 1. What a conversation creates

A conversation has one workspace of its own (the `solo` worktree). Each time a team works for it, the team runs as a separate execution with its own checkouts:

| Checkout | How many | Purpose |
|---|---|---|
| `integration` | 1 per team execution | The shared result. Planning, review and repairs happen here. |
| `auto-<task>` | 1 per planned task | Where the task's owner works. |
| `.base-check`, `.proof-check` | as needed | Detached scratch checkouts for base comparison and fail-to-pass proof. |

Checkouts are per task, not per agent. Three agents with five tasks create six checkouts, not three. Two teams in one conversation create two full sets. Teams in one conversation never run at the same time: a team runs inside a conversation turn, and the turn does not end until the result is applied.

## 2. How work is combined

1. **Task to shared result.** The engine, not an agent, merges each submitted task branch into `integration` with `git merge --no-ff`. If the merge conflicts, the task's owner resolves it.
2. **Shared result to conversation.** The engine applies the difference between the team's starting snapshot and the final `integration` commit to the conversation workspace as a patch. Your branch, staged changes and uncommitted edits are preserved. Overlapping edits go to **Resolve conflicts**.

The coordinator plans and revises the work. It does not merge.

## 3. Changes

### 3.1 Check a task before it joins the shared result (implemented)

Before: every task was merged first and checked afterwards. A task that broke the check stayed merged. Teammates still working then failed their own checks against a broken shared result and were marked failed for a defect that was not theirs.

Now, while any other task is unfinished:

1. The current shared result is merged into the task's own checkout. The owner resolves any conflict there.
2. The configured check runs in the task's checkout.
3. Only a passing task is merged into `integration`. A failing task is marked failed, keeps its work in its own checkout for a retry, and the shared result is unchanged.

The last unfinished task is merged and checked on `integration` itself, as before, so the final check can reuse that result. When every task passes, the number of check runs is the same as before. When a task stays failed, the final check runs once more.

This is recorded as the run option `checkBeforeIntegration`, set on new team runs. A saved run without the option replays the order it recorded.

### 3.2 Remove a team's checkouts once its result is applied (implemented)

Before: every checkout of every team execution stayed on disk until the whole conversation task was archived with cleanup.

Now, when a team execution has finished and its result is in the conversation workspace (applied cleanly, or after you resolve conflicts):

- The folders of its checkouts are removed, including those of earlier executions that a correction superseded.
- Every branch is kept, so the result can still be inspected and compared.
- A checkout with uncommitted work is not removed. Team activity says how many stayed.

An execution that stopped or failed keeps its checkouts, because **Resume team** continues in them.

### 3.3 One checkout per agent instead of per task (proposed)

Each worker would keep one checkout for all its tasks. This runs the setup command once per agent rather than once per task, and lets an agent keep its provider session between its tasks.

Open problems to solve first:

- **Leftover work.** A failed or interrupted task leaves unmerged edits in the agent's checkout. The agent's next task must start clean, and the leftover work must be parked under the task's name so a retry, possibly by another agent, can pick it up.
- **Ownership checks.** "Changed files outside declared ownership" relies on the checkout containing one task's changes only.
- **Session growth.** Resuming one provider session across many tasks grows its context. Today a member that changes checkout starts a fresh session from its checkpoint.
- **Task views.** Team details shows a task's changes by its branch. With shared checkouts it must show a commit range.

### 3.4 Read-only tasks without a checkout of their own (proposed)

Investigation tasks would read `integration` instead of getting their own checkout. This is not safe yet: a read-only step restores the checkout to the state it found, which would undo a merge that landed while it was reading. It needs a read path that does not restore, or a lightweight detached checkout that skips setup.

## 4. Example

A conversation "Add login", with the setup command `npm ci`.

| Turn | What runs | Checkouts while running | Left on disk afterwards |
|---|---|---|---|
| 1 | Solo agent scaffolds the page | 1 | 1 |
| 2 | Team A, 3 agents, 4 tasks | 1 + 1 + 4 = 6 | 1 |
| 3 | Team B, 3 agents, 3 tasks | 1 + 1 + 3 = 5 | 1 |

Before 3.2, turn 3 ended with 10 checkouts on disk. With 3.3, turn 2 would run with 1 + 1 + 3 = 5.

In turn 2, suppose the API task and the form task run in parallel and the API task breaks the test suite:

- Before 3.1: the API task is merged, the check fails, and the form task's check then fails too because it runs against the broken shared result.
- With 3.1: the API task is checked in its own checkout, fails, and is not merged. The form task passes and is merged. The coordinator retries only the API task.
