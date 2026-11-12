---
name: codeflow
description: Use when the user asks Code Flow for a second opinion or an agent team on a repository task, for example a review of the current changes by another provider (Claude, Codex, Antigravity), a reviewed plan, or an implementation that is checked and independently reviewed. Do not invoke for ordinary single-agent work unless the user asks for Code Flow. A Code Flow worker must never start another Code Flow run.
---

# Code Flow

Use the connected `codeflow_*` MCP tools. They work on the Git repository this session started in.

1. Call `codeflow_run` with the task and a mode: `review` (another agent reviews the current changes), `plan` (draft, independent review, revised plan) or `implement` (write in a separate worktree, run the check, independent review, one repair pass; ask the user for the check command). Leave `team` empty unless the user named a provider or model.
2. Show the returned card to the user, then call `codeflow_start_run`. Only the user approves, in the form, in Code Flow or in a terminal. Never approve for them.
3. The task runs in the background. Run the returned `codeflow wait` command as a background shell command, or call `codeflow_status` with `waitSeconds`, and keep helping the user meanwhile.
4. When it has finished, read the result file that `codeflow_status` names and present it. Say which checks ran.
5. `codeflow_apply` brings a finished implementation into the checkout after the user confirms. It never commits or pushes.

Every tool result ends with the next action; follow it. If the tools are missing, ask the user to run `codeflow init` and reconnect Code Flow from /mcp. Do not run provider CLIs yourself to do the team's work.
