# One chat for Agent and Team work

Select **New chat** and describe what you want. Choose a project repository for code work, or start a tool-free discussion with Claude before attaching one. Use **Agent** for one provider's normal conversation, or **Team** to discuss complex work with a lead and review a task-specific approach. No saved agent team, workflow preset or special prompt syntax is required.

## Start simply

1. Choose **New chat** from the sidebar or a project. Create a project and add its repository if needed.
2. Choose **Agent** or **Team** beside the composer. Open **Message settings** (the model button) to choose the provider, model and supported effort. In Team mode these settings select the lead; each proposed approach shows the worker settings separately.
3. Send a question, an idea or a concrete task. Enter sends; Shift + Enter adds a line. Attach supporting files with **+ → Attach files**. The project’s sidebar **+** opens a new chat in that project.
4. In Team mode, discuss the idea first or review the proposed approach. Workers start only after **Start planning**, **Start review** or **Start implementation**, according to the proposed scope.
5. Keep working in the same chat. A chat can hold a plan, its implementation, a later review and further tasks, each with its own approved execution.

For example:

> Plan a login form using the existing components. Have Claude draft it and Codex review it until both approve the same version. Plan only. Use high effort for both.

Then:

> Implement the agreed plan. Have Claude build and Codex review. Run the focused tests and finish only when the check passes and Codex approves the same code.

You can name exact models and supported efforts or let the lead propose them. Unsupported explicit choices require correction; Code Flow does not silently substitute them. Only the providers used by the task need to be available and signed in.

## Try Haiku and Luna from plan agreement to verified code

This small demo uses Node's built-in test runner, with no framework or dependencies. Install and sign in to both provider CLIs before starting. Use the explicit models only when they are available in your installed CLI catalogs; an unavailable choice should be corrected rather than silently substituted.

1. Create a disposable Git repository in a terminal:

   ```sh
   TEAM_CHAT_DEMO="$(mktemp -d "$HOME/codeflow-team-demo.XXXXXX")"
   cd "$TEAM_CHAT_DEMO"
   git init -q
   printf '%s\n' '# Team chat demo' > README.md
   git add README.md
   git -c user.name="Team Demo" -c user.email="demo@code-flow.invalid" commit -qm "Initialize demo"
   pwd
   ```

2. In Code Flow, create a project named **Team chat demo**, add the repository path printed above, and choose **New chat → Team**. Open **Message settings** and choose Claude Haiku at **high** effort for the lead. This does not set the worker efforts: inspect those in the approach too.

3. Send this plan-only request:

   > Plan a tiny JavaScript slug utility. Use Claude claude-haiku-5-5 and Codex gpt-6-luna, both at high effort. Haiku drafts the plan, Luna reviews it, and Haiku addresses corrections. Require explicit approval of the same final plan from both agents, with at most two review passes. The planned implementation is slugify.mjs plus slugify.test.mjs: lowercase ASCII letters, trim separators, replace runs of non-ASCII-alphanumeric characters with one hyphen, return an empty string for empty or separator-only input, and throw TypeError for non-string input. Include tests for all those cases. Plan only; do not implement yet.

4. Review the approach card before choosing **Start planning**. Confirm both participant model IDs and **high** effort, plan-only scope, explicit agreement reviews, and the limits. Use **Adjust approach** for model/effort or limit corrections. For this small demo, 12 calls and 30 minutes is a reasonable starting allowance. Start it and wait for **Plan agreed**, then read the final plan. If agreement is not reached within the limits, inspect the remaining findings before authorizing more work.

5. Stay in the same chat, choose **New work** if the composer is targeting an earlier task, and send:

   > Implement the agreed slug utility plan. Claude claude-haiku-5-5 is the builder and Codex gpt-6-luna is the independent reviewer; both use high effort. Haiku creates slugify.mjs and slugify.test.mjs and fixes review findings. Run node --test slugify.test.mjs. Allow up to two build-review passes. Finish only when this check passes and Luna approves the same final code snapshot. Preserve the agreed behavior. Do not merge, push or deploy.

6. Review this second approach: it should authorize implementation, name both workers at **high**, contain the exact check command, and retain the earlier task context. Choose **Start implementation**. The first approval covered planning; this approval covers implementation.

7. Expect **Changes verified** when the check and review gate pass. Open **Task details** and verify actual completed assignments and native CLI session receipts for Haiku and Luna. Open **Inspect execution and changes** to read the diff, test output and review evidence. The chat should retain both **Plan agreed** and **Changes verified** results. Code stays in the preserved worktree until you explicitly apply it to your checkout.

## Agent mode

For a new chat, choose the computer and project above the message box. A project with one repository selects it automatically; projects with several repositories show a repository choice. The selected project and repository survive reloads. Choose **No project · discussion** to start without code context. **Add files or context → Project and source** can turn off repository files for a discussion within a single-repository project. After typing, **Improve** previews an editable, structured rewrite using your saved rewrite settings. **Use this prompt** replaces the draft; **Undo rewrite** restores it. Rewriting does not send the message or approve work. It currently requires a repository; Quick uses only the draft text, while Repo uses a committed snapshot.

Agent uses the existing provider adapter, tools and permission choices. Send authorizes that turn within its displayed allowance; there is no Team approach approval for an ordinary Agent turn. The default allowance is 12 managed calls and 30 execution minutes. **Task details → Agent allowance for new work** changes future turns.

Follow-up messages continue the provider session when possible. Changing providers starts a new provider session with recent conversation context and a snapshot of the preceding Agent workspace. Switching to Team similarly retains completed Agent work when preparing the next task. An active Team writer must settle before an Agent writer starts. Changes remain in isolated worktrees.

## Team mode

The lead reads the conversation, repository and recorded task evidence to answer, clarify, record guidance or propose an approach. A discussion does not create a worker execution. **Ask about this task** explicitly targets an existing task; **New work** returns to a new request. That target is preserved with the draft.

The approach card shows scope, participants and their provider/model/effort, completion criteria, source, commands and limits. Open **Approach, source and commands** for the full sequence. **Adjust approach** edits participant settings, commands, limits and supported review-pass counts without another lead call. Describe scope or sequence changes in the conversation.

The scope-specific start button accepts and starts the exact revision once. Changed source or proposal revisions block stale starts. **Refresh source** captures the latest source while retaining the approach for review. A plan-only or review-only request does not authorize implementation.

An accepted task keeps its scope, settings and allowance. Changing the chat's mode or model affects future messages. A material task change produces another approach requiring fresh acceptance. If the requested process includes a user design checkpoint, only its explicit approval option permits implementation.

## Source and files

Tracked working-copy changes, including staged additions/deletions, are included by default without changing your index. In a new chat, **+ → Project and source** can select committed code instead or explicitly include non-ignored new files. Fresh Git repositories are supported without creating a commit on the main branch.

Completed tasks in the same chat can pass their preserved implementation to later tasks. References from another chat/project cannot authorize that handoff. Interrupted or uncertain writes require inspection before continuation.

Attach up to ten files, 1 MB each and 4 MB total. Files stay available across modes. **Chat files** removes a file from future context; accepted tasks keep their pinned copies. Draft file bytes use browser storage; submitted files are stored privately with content hashes. Credential filenames and invalid paths are rejected. Storage failures are visible, and an unrestored draft attachment blocks Send until restored or removed.

## Guidance, queues and recovery

Messages sent while a turn is active queue in order with their selected settings and files. Inspect or cancel queued messages in **Task details**. A failed or cancelled Agent turn preserves queued text but requires an explicit next request rather than automatically replaying uncertain writes.

Guidance can be recorded before a subsequent assignment receives it. **Guidance delivery** distinguishes recorded from delivered; delivery alone does not prove incorporation. Pause, resume and cancellation preserve work. Provider authentication errors link to connection settings; preserved runs remain inspectable.

Team lead preparation has a shared allowance of 12 calls and 30 execution minutes per chat. Each reply uses at most three calls and five minutes, including schema repairs. When exhausted, review a larger total allowance in Task details. Worker execution has its own explicitly reviewed allowance; default proposals use 12 calls, 30 minutes and two concurrent workers. Review passes and retries share the allowance. Provider usage records are not billing totals.

Reloading restores messages, approaches, executions and results. Closing the window does not cancel submitted work. Background processing advances already-submitted turns; it never starts an unaccepted task. Project or filesystem permission changes still block dispatch.

## Results and participation

Results appear in order beside their tasks: **Plan ready**, **Plan agreed**, **Changes verified**, **Review completed**, or **Stopped with partial work**. The main result is the final deliverable; evidence opens separately. Agreement applies to a specific artifact, and checks apply to a recorded code snapshot.

Started tasks appear as compact progress rows in chat. Open a progress row or **Task details** for pause/resume, results and recovery controls; a running task also keeps a direct Stop control. Questions and approach approvals remain explicit.

**Task details** contains actual participant assignment statuses and CLI session receipts, worktrees and earlier executions. Inspecting a lead turn shows its readable response, proposed participants and workflow, with protocol JSON collapsed under **Technical response (JSON)**. A proposed participant has not run yet. A worker saying that another agent reviewed something is not participation evidence. Code Flow starts managed participants itself, and workers perform their own assignments without nesting another team.

**Inspect execution and changes** opens the existing run workspace. Applying changes, opening a PR, merging, pushing and deploying remain explicit actions.

## Existing workflows and CLI integration

**Project settings → Advanced → Saved workflows** opens the workflow composer and its saved drafts. The main chat header contains only Task details after the chat starts. Templates, saved agent configurations, automations, project missions, human collaboration, remote and container workflows retain their existing routes and behavior. They are outside the new-chat setup path.

The initial Team chat supports local Claude/Codex managed participants. Agent mode retains the existing provider choices. Read-only assignments use provider-enforced capabilities; a worktree is not filesystem read isolation. Accepted setup/check commands execute as the user.

Claude Code and Codex CLI sessions can use the same execution foundation through the [project MCP integration](cli-conversational-teams.md). The browser chat is an owner-authenticated interface; it does not expose CLI bootstrap credentials or require a separate terminal approval command.

## Workspace, context and recovery

**Message settings** opens a small anchored picker for the next message. In Team mode it selects the lead; workers are selected in the approach. Provider model catalogs supply supported effort choices, and the recorded assignments show the actual settings and native session receipts.

Use **View approach**, **View plan**, **View review** or **View changes** to open a separate output pane. It contains the proposed sequence, accepted source, results, reviews, checks and current workspace changes. Opening or closing it preserves the conversation's reading position. On narrow windows the output temporarily fills the workspace. Review completion means findings were delivered; it does not mean the findings were fixed. Verification applies to its recorded snapshot.

**Project ⋯ → Project settings → Edit project defaults** manages shared instructions, background files, check/setup commands, Agent permission defaults and execution allowances. **+ → Project context** is a shortcut to the same versioned configuration. Each submitted message pins a revision before dispatch, including queued messages; accepted approaches retain that context. Editing shared context affects future messages. Message attachments remain chat context and are never silently promoted to project context. Conflicting filenames must be resolved explicitly. Combined project and chat files support ten files / 4 MB (1 MB per file).

With **Discussion only · no repository**, Claude can answer without inspecting code or starting workers. The installed CLI must advertise the required controls; builtin tools, MCP, browser integration, hooks and native delegation are disabled on every invocation. This is a CLI tool restriction, not operating-system isolation. Text attachments are included directly in the prompt, bounded to 64 KB of UTF-8 text. Other providers require an attached repository until their adapters can verify the same contract. Choose **+ → Project and source**, select a project repository and **Attach repository** to continue the same conversation with code work. The private empty discussion workspace is never used as project source.

Chat row menus support **Rename**, **Pin**, **Archive chat** and **Restore chat**. Archiving organizes history; it does not cancel active work or delete worktrees. **Code Flow menu → Archived chats** opens archived history; **Back to active chats** returns to the normal list. The sidebar **Projects** heading collapses its list and remembers the choice across reloads. Search includes message content and opens the matching history page. Older messages load in pages of 50 (API maximum 100); the browser retains at most 150 visible messages and offers **Back to latest**. The journal currently bounds each chat to 100,000 events; paging does not make server memory unbounded.

A backend controller advances submitted turns and records completed task results even with no browser open. History GETs return state only. The existing shared event stream carries bounded cursor-based invalidations, with reset after restart or a missed replay window; a 15-second poll recovers state if updates are missed. Stable command IDs and durable receipts prevent duplicate submissions from starting another execution. An uncertain write requires inspection of its preserved execution rather than automatic replay.

Authentication failures offer **Reconnect provider**. Exhausted allowances require reviewing a continuation and its limits. Stale source blocks start and offers **Refresh source**. Failed checks and unresolved review findings remain visible in the output; request a revised approach to fix them. Interrupted writes offer **Inspect preserved work**. Browser reconnection reads canonical state and never authorizes a new task by itself.


## Automate a reviewed approach

Open **Scheduling**, describe the goal and when it should happen, and select a project. **Create automation** opens a Team chat. Its lead prepares a standalone bounded approach; no task workers start during this preparation. Review the actual participants, models, effort, checks and finish condition in the approach card.

Choose **Automate this** on a reviewed task. The setup shows the frozen task and team. Select **Once**, **Repeating** (with an explicit IANA time zone), or **On an event**. **More options** contains a one-item-at-a-time issues, dependency-update or security-alert list. Goals such as improving coverage use the same bounded graph; a continuation or a task depending on historical worktrees must be revised into a standalone approach before scheduling.

Each occurrence captures fresh committed HEAD; it does not reuse an old approval of a working-copy snapshot. Enabling authorizes repeated execution of the displayed graph with these source semantics. The engine revalidates project membership, provider settings, current source, permissions and bounds at admission. Changes to workers, commands or execution limits require a new reviewed setup in chat. Existing workflows keep their historical scheduling behavior.

**Test now** performs real bounded work while the saved automation stays paused. The test records its configuration revision, task, actual participant/session receipts, output and allowance use. It never approves the original task in the chat. Retrying the same test operation returns the same execution; an uncertain admission after a restart requires inspection. Testing is available before enabling, but is not mandatory. Webhook setup offers the endpoint, a copyable authenticated request, and **Send test event**; external webhook traffic is accepted only after enabling.

Saved one-time dates can be changed through **Edit → Run at → Save time** without enabling a paused setup.

**Enable automation** authorizes future occurrences. The host must remain running. New chat schedules collapse missed occurrences into one run on return; they never replay every missed occurrence. One-time occurrences are consumed durably before dispatch and never silently repeated after a crash. Pausing leaves current execution running, blocks future starts, and drops queued webhook events. Backlog progress distinguishes items started from completed work and lets you **Pause after this item**.

Results and their independent executions stay in the owning chat and history. Task details follows the selected task, displaying its state, participants, checks, allowances, recovery and revision history. Clean routine automation results stay in history; findings, failed or blocked work, verified changes and decisions appear in the Inbox. Desktop and configured notification targets use the same quiet-success policy for chat automations. No merge, push or deployment is automatic.

The new chat-based automation adapter is owner-local, as are chat and its private files. Historical scheduling, remote workflows and missions remain under Advanced. Switching computers selects the computer that owns its own projects and automations; it does not migrate an existing automation to a different host.

Scheduling focuses on describing new automation. **Manage automations** opens **App settings → Automations**, with project filtering, saved automations and advanced scheduling tools. Existing direct scheduling links remain available. The Changes side panel leads with changed files, followed by collapsed **File review** and **Comments** sections; review metadata and manual rework remain available inside File review.
