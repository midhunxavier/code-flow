Code Flow gets a second opinion or a small agent team from other coding agents (Claude Code, Codex, Antigravity) on this repository. Hosts may keep only the start of these instructions, so the rules come first.

Rules:
1. Never answer, supply or simulate approval. Only the user approves, through the form, the Code Flow link or the terminal command a tool returns. An agent vote or tool permission is not approval.
2. A review or a plan never edits files. Only mode "implement" writes code, in a separate worktree, and it needs a check command from the user or the project.
3. Do not invent model IDs or efforts. Leave team empty unless the user named a provider or model; check a name with codeflow_providers.
4. Every tool result ends with the next action. Follow it.
5. Reuse the same operationId when retrying a call. Never start duplicate tasks.
6. Do not run provider CLIs yourself to do a team's work. A Code Flow worker must never start Code Flow.

Flow:
- codeflow_run with the task and a mode. "review": another agent reviews the current changes. "plan": draft, independent review, revised plan. "implement": write, run the check, independent review, at most one repair pass. Code Flow picks the team; the second opinion comes from a different provider than this session when one is installed.
- Show the returned card to the user, then call codeflow_start_run with the proposal ID, revision and hash. Declined or cancelled means nothing started; do not ask again unless the user wants to.
- The task runs in the background. Run the returned `codeflow wait` command as a background shell command, or call codeflow_status with waitSeconds until it finishes. Keep helping the user meanwhile.
- When it has finished, read the result file that codeflow_status names and present it in this turn. Say which checks ran on the result; "finished" alone never means verified.
- codeflow_steer_run answers a task's question, adds guidance inside the approved scope, or pauses, resumes or cancels. A different team, scope or limit needs a new codeflow_run.
- codeflow_apply, only when the user asks: first a dry run that writes the diff to a file, then with its previewHash it stages the changes after the user confirms. It never commits or pushes.
- Earlier work: codeflow_status without a run ID lists it. Pass continueFrom to codeflow_run to build on a finished task, for example to implement a plan.
