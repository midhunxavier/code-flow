# Runs: talking to them, restarts, insights

## The run view

A run reads like a conversation, top to bottom:

- **The header** stays at the top as you scroll (on wider screens): status, the task's first line, the pattern, and **Resume**, **Edit & run again**, **Archive…** or **Stop run**.
- **Your task**, as the message that started it, with any context you gave.
- **The agents' work**, as one list of steps ("4 steps · 6m 2s"). It's open while the run is going and folds away once there's a result. Open any step to see its transcript inline: the agent's messages (rendered as Markdown), its tool calls as one-line rows that expand to the full input and output, and its thinking, collapsed. <kbd>[</kbd> and <kbd>]</kbd> move between steps.
- **The result**, with its branches and what you can do with them (see [Review and ship](github.md#review-and-ship)).
- **The reply box** at the bottom (below).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/transcript-dark.png">
  <img src="images/transcript-light.png" alt="A step opened in a run: Codex's tool calls, its checklist and its summary (demo data)">
</picture>

## Talking to a run

Runs are conversations, not fire-and-forget jobs:

- **Approve the plan:** tick *Let me approve the plan* (the subtasks for Supervisor, the tests for Test-first). The run pauses at that checkpoint, and its time budget with it.
  - **Approve:** the agents start building.
  - **Ask for changes:** your note goes to the author, who revises in its own session and asks again.
  - **Reject:** the run ends without building anything.
  - A pending checkpoint survives restarts. Waiting runs show under *Needs you*, with a notification.
- **Message the team** while it runs, from the reply box. **To** picks the agent, or *Next agent* gives the note to the first one that can take it. A line next to it says where the note will go.
  - **Into a running Codex turn:** Codex runs through `codex app-server`, so a note for Codex (or for anyone) reaches its running turn right away, as a new message on the live thread (`turn/steer`). Codex takes it into account from its next step, without waiting for the turn to end.
  - **At the start of the next turn:** Claude, agy, and Codex on the `exec` fallback can't take input mid-turn. Their notes are added to the start of that agent's next turn.
  - The run view shows each note as queued or delivered, and which step it reached ("✓ delivered to codex mid-turn (Implement plan)"). A mid-turn note also shows in that step's transcript. If the turn ended just as the note arrived, the note goes back in the queue for the next turn. If the step is retried, the retry gets the note in its prompt.
- **Reply** after it finishes, from the same box:
  - to an agent in its worktree (**To:** e.g. *Codex · build*): it continues its own session, then code-flow commits and re-runs the check;
  - or to *Whole team · new run*: a new run that starts from this run's result branch, with your feedback added to the task.

<kbd>↵</kbd> sends and <kbd>⇧</kbd><kbd>↵</kbd> adds a line.

### A single agent

A **Single agent** run is one conversation with one agent, as in that agent's own app:

- The run reads as a chat: your messages, and each turn the agent takes. A turn streams live while the agent works. Once it's done, it folds into the agent's answer, with **Show work** for its tool calls and thinking.
- There's no **To**: every message goes to that agent. A message you send while it works goes into its running turn if the turn takes input (Codex). Otherwise it's sent as your next message as soon as the turn ends, so nothing waits for a reply you'd have to send again.
- A turn that fails ends that turn, not the conversation: reply to try again or to change course. Whatever it changed is kept on its branch.
- code-flow commits after every turn and runs your check if you set one. The branch, and merging it or opening a pull request, are at the bottom of the thread.

Prompts are passed on **stdin**, not as command-line arguments (`claude -p` reading stdin, Codex's JSON-RPC or `codex exec -`, and agy's stream-json input), so long tasks and diffs aren't limited by the operating system's argument size.

## Runs survive restarts

Every run is saved to disk as it happens (`~/.codeflow/runs/<run>.jsonl`), and the server rebuilds the run list from those files when it starts.

- **Interrupted runs:** if code-flow stops while a run is going (Ctrl-C, a restart, a crash), the run comes back as **Interrupted**.
  - **Resume** re-runs the pattern from the top. Each step that already finished (agent turns, checks, commits, worktrees) is replayed instantly from a journal (`<run>.journal.jsonl`), and real work continues at the first unfinished step. Nothing finished is redone.
  - Runs that hit a time or step limit, failed, or were stopped by you can be resumed the same way, with a fresh budget.
  - A recorded check is replayed only if the code it checked is still the code at that point. A recorded commit is replayed only if it's still in the branch's history. Anything else runs again.
  - Follow-ups on a finished run don't replay the pattern at all; only the follow-ups run. A follow-up that fails doesn't undo the finished run.
  - Resume is claimed at once, so a double click or a PR watch can't start the same run twice. If the last attempt is still wrapping up (listing its work), the new one waits for it. Archiving, merging and pushing wait until a resume has started, too.
  - Notes delivered to a turn that never finished, or failed, go back in the queue for the next turn (the retry, or the resumed run).
- **Sessions that are gone:** an agent continues its own conversation only from a turn that worked. If that conversation no longer exists (the CLI says so), the turn runs once more in a new conversation, given the task from the start. A conversation that couldn't be resumed is never recorded as the step's.
- **At startup:** a step still marked as running in a run that isn't (code-flow stopped or crashed while it ran) is closed as interrupted. Folders in a worktree root that no run owns are listed in `~/.codeflow/server.log`; code-flow never deletes them. A run log without a run in it is logged there too, rather than skipped silently.
- **Clean shutdown:** Ctrl-C or SIGTERM stops running agents and marks their runs interrupted. A second Ctrl-C exits at once.
- **One server per data folder:** a second server on the same `CODEFLOW_HOME` waits for the first to stop (as in a restart), then refuses to start. A crash mid-write can leave a line half-written; it's closed off before the next write, so it never corrupts the next line. Failed writes, such as a full disk, are counted and reported at `/api/health`.
- **Needs you:** the sidebar groups runs into *Needs you* (finished runs you haven't opened, and interrupted runs), *Running*, *Recent* and *Archived*. The browser tab shows the count, and the bell in the top bar turns on desktop notifications for when a run finishes or needs you.

## Insights, comparisons and finding runs

- **Insights** (in the top bar, or <kbd>i</kbd>) shows, per agent and per pattern, for one repo or all, over 7 days, 30 days or all time:
  - runs, and how often the result passed its check;
  - race wins, loops each agent got green, and review findings other reviewers agreed with;
  - failed steps, tokens (input, output, cached) and time per step;
  - Claude's API-equivalent cost. Your plan isn't billed per token; it's a measure of size.
- **Compare setups…** (next to *Start run*) starts the same task with several patterns at once, each with the team you last picked for it, optionally 2–3 times each. Insights shows them side by side: result, time, steps, tokens, cost, and whether tests were touched. The best value in each column is highlighted.
- **Tokens and cost** also show on each step, in the run's details under the header (with a per-agent breakdown on hover) and in the sidebar.
- **Disk:** every worktree is a full checkout, often with its own `node_modules`. Insights measures them and **Clean up** removes the worktrees, not the branches, of runs that finished more than *N* days ago and need nothing from you.
- **Finding runs:** the sidebar has search (<kbd>/</kbd>), filters (needs you, running, passed, failing, tests changed; pattern; agent; this repo), and <kbd>j</kbd>/<kbd>k</kbd> to move between runs. In a run, <kbd>[</kbd>/<kbd>]</kbd> move between steps. <kbd>?</kbd> lists every shortcut. Run status changes are announced to screen readers.
