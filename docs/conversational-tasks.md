# One chat for Agent and Team work

Select **New chat**, choose a project and Git repository, and describe what you want. Use **Agent** for one provider's normal conversation, or **Team** to discuss complex work with a lead and review a task-specific approach. No saved agent team, workflow preset or special prompt syntax is required.

## Start simply

1. Choose **New chat** from the sidebar or a project. Create a project and add its repository if needed.
2. Choose **Agent** or **Team**, the provider, model and supported effort beside the composer. Mobile layouts put these choices in **Message settings**.
3. Send a question, an idea or a concrete task. Enter sends; Shift + Enter adds a line. Attach supporting files with the file button.
4. In Team mode, discuss the idea first or review the proposed approach. Workers start only after **Start task**.
5. Keep working in the same chat. A chat can hold a plan, its implementation, a later review and further tasks, each with its own approved execution.

For example:

> Plan a login form using the existing components. Have Claude draft it and Codex review it until both approve the same version. Plan only. Use high effort for both.

Then:

> Implement the agreed plan. Have Claude build and Codex review. Run the focused tests and finish only when the check passes and Codex approves the same code.

You can name exact models and supported efforts or let the lead propose them. Unsupported explicit choices require correction; Code Flow does not silently substitute them. Only the providers used by the task need to be available and signed in.

## Agent mode

Agent uses the existing provider adapter, tools and permission choices. Send authorizes that turn within its displayed allowance; there is no Team approach approval for an ordinary Agent turn. The default allowance is 12 managed calls and 30 execution minutes. **Task details → Agent allowance for new work** changes future turns.

Follow-up messages continue the provider session when possible. Changing providers starts a new provider session with recent conversation context and a snapshot of the preceding Agent workspace. Switching to Team similarly retains completed Agent work when preparing the next task. An active Team writer must settle before an Agent writer starts. Changes remain in isolated worktrees.

## Team mode

The lead reads the conversation, repository and recorded task evidence to answer, clarify, record guidance or propose an approach. A discussion does not create a worker execution. **Ask about this task** explicitly targets an existing task; **New work** returns to a new request. That target is preserved with the draft.

The approach card shows scope, participants and their provider/model/effort, completion criteria, source, commands and limits. Open **Approach, source and commands** for the full sequence. **Adjust approach** edits participant settings, commands, limits and supported review-pass counts without another lead call. Describe scope or sequence changes in the conversation.

**Start task** accepts and starts the exact revision once. Changed source or proposal revisions block stale starts. **Refresh source** captures the latest source while retaining the approach for review. A plan-only or review-only request does not authorize implementation.

An accepted task keeps its scope, settings and allowance. Changing the chat's mode or model affects future messages. A material task change produces another approach requiring fresh acceptance. If the requested process includes a user design checkpoint, only its explicit approval option permits implementation.

## Source and files

Tracked working-copy changes, including staged additions/deletions, are included by default without changing your index. In a new chat, **Task details → Project and source** can select committed code instead or explicitly include non-ignored new files. Fresh Git repositories are supported without creating a commit on the main branch.

Completed tasks in the same chat can pass their preserved implementation to later tasks. References from another chat/project cannot authorize that handoff. Interrupted or uncertain writes require inspection before continuation.

Attach up to ten files, 1 MB each and 4 MB total. Files stay available across modes. **Chat files** removes a file from future context; accepted tasks keep their pinned copies. Draft file bytes use browser storage; submitted files are stored privately with content hashes. Credential filenames and invalid paths are rejected. Storage failures are visible, and an unrestored draft attachment blocks Send until restored or removed.

## Guidance, queues and recovery

Messages sent while a turn is active queue in order with their selected settings and files. Inspect or cancel queued messages in **Task details**. A failed or cancelled Agent turn preserves queued text but requires an explicit next request rather than automatically replaying uncertain writes.

Guidance can be recorded before a subsequent assignment receives it. **Guidance delivery** distinguishes recorded from delivered; delivery alone does not prove incorporation. Pause, resume and cancellation preserve work. Provider authentication errors link to connection settings; preserved runs remain inspectable.

Team lead preparation has a shared allowance of 12 calls and 30 execution minutes per chat. Each reply uses at most three calls and five minutes, including schema repairs. When exhausted, review a larger total allowance in Task details. Worker execution has its own explicitly reviewed allowance; default proposals use 12 calls, 30 minutes and two concurrent workers. Review passes and retries share the allowance. Provider usage records are not billing totals.

Reloading restores messages, approaches, executions and results. Closing the window does not cancel submitted work. Background processing advances already-submitted turns; it never starts an unaccepted task. Project or filesystem permission changes still block dispatch.

## Results and participation

Results appear in order beside their tasks: **Plan ready**, **Plan agreed**, **Changes verified**, **Review completed**, or **Stopped with partial work**. The main result is the final deliverable; evidence opens separately. Agreement applies to a specific artifact, and checks apply to a recorded code snapshot.

**Task details** contains actual participant assignment statuses and CLI session receipts, worktrees and earlier executions. A worker saying that another agent reviewed something is not participation evidence. Code Flow starts managed participants itself, and workers perform their own assignments without nesting another team.

**Inspect execution and changes** opens the existing run workspace. Applying changes, opening a PR, merging, pushing and deploying remain explicit actions.

## Existing workflows and CLI integration

**Existing workflows** opens the workflow composer and its saved drafts. Templates, saved agent configurations, automations, project missions, human collaboration, remote and container workflows retain their existing routes and behavior. They are outside the new-chat setup path.

The initial Team chat supports local Claude/Codex managed participants. Agent mode retains the existing provider choices. Read-only assignments use provider-enforced capabilities; a worktree is not filesystem read isolation. Accepted setup/check commands execute as the user.

Claude Code and Codex CLI sessions can use the same execution foundation through the [project MCP integration](cli-conversational-teams.md). The browser chat is an owner-authenticated interface; it does not expose CLI bootstrap credentials or require a separate terminal approval command.
