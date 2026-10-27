# Runs and workspace

Open a run from the sidebar or Inbox. Describe what you want in chat, read the agent's answer, then choose **Review changes** or **Preview**. Continue in the same chat to ask questions or request another revision. Agent and Team mode use this same flow.

For a linked GitHub pull request, the result card shows the next step using its current GitHub status: **Update branch**, wait for checks or required review, then **Merge pull request**. Updating brings in the base branch and lets GitHub run checks; it does not merge the PR. Merge asks for confirmation and rechecks the displayed commit. After an update, the card distinguishes current GitHub checks from the run's earlier local review. Conflicts, unpublished edits, failed checks, missing evidence and required approvals keep merge unavailable.

Test runs show **Test complete — archive this run**, with the reason they were only a test. **Archive test run** keeps the conversation, branches and working files. Publishing is disabled for a test run. Use **More options → Mark as test run** for an existing run, or supply `testRun: { reason: "Regression replay; already fixed upstream" }` when creating one through the API. This purpose is explicit; asking an agent to write tests does not mark ordinary development as a test run.

## The run view

A run reads like a conversation, top to bottom:

- **The header** shows execution status, the task and workflow, and whether the run is archived or merged (and into what). **More run actions** contains Edit & run again, Archive and Delete; a running task keeps Stop run visible.
- **Your task**, as the message that started it, with any context you gave.
- **The agents' work**, as one list of steps ("4 steps · 6m 2s"). It's open while the run is going and folds away once there's a result. Open any step to see its transcript inline: the agent's messages (rendered as Markdown), its tool calls as one-line rows that expand to the full input and output, and its thinking, collapsed. <kbd>[</kbd> and <kbd>]</kbd> move between steps or agent turns.
- **The answer and result** keep the conversation first. **Review changes** opens the files and diff, with a feedback box always available below them. Sending comments starts an agent revision; managed workflows rerun configured checks. Review tools and publishing are separate disclosures. A finished execution can still have failed, blocked or unverified checks, and passing checks do not override a review that requests changes.
- **Preview** opens the app beside the conversation. Code Flow detects a saved launch command or a common `dev`/`start` script. If setup is needed, the button asks your agent or enabled team to configure it, then starts a managed server and opens it when ready. Existing settings are preserved. If the repository has no web UI, the agent explains the available way to test it instead. **More options → Preview settings** retains manual configuration.
- **Details and publishing** keeps branch metadata, evidence and publishing controls out of the conversation. Terminal, editor and folder shortcuts remain under **Open in your tools**. Agent conversations also expose publishing through **Review changes** (see [Review and ship](github.md#review-and-ship)).
- **Questions and recovery actions** stay visible when the run needs your answer. Team internals are under **Team activity**.
- **The reply box** at the bottom (below).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/transcript-dark.png">
  <img src="images/transcript-light.png" alt="A step opened in a run: the agent’s recorded tool calls and output (demo data)">
</picture>

## Recovering work

The next-action card explains what happened and what is retained. **Retry unfinished work**, **Resume work**, and **Extend budget & resume** reuse recorded results with a fresh allowance of the displayed calls and minutes. **Reconnect provider** opens provider health and login instructions; resume after reconnecting.

A provider usage limit shows the provider and its reported reset time. **Check provider usage** opens health; **Resume after reset** is unavailable until a known future reset. When the provider gives no reset time, check its usage before retrying. Increasing the run budget does not change a provider quota. These controls are also available in Agent chats.

**Stopped by you** means execution was cancelled. **Plan rejected** ends the run at that checkpoint: use **Edit & run again** for a fresh plan; Resume cannot replay the rejected decision. **Pause dispatch** lets active work finish, then reports **Dispatch paused** until you resume dispatch. Run and repository History controls use the same High, Normal and Low priorities.

Runs with no changes have no result-review card. Failed runs with saved changes say **Partial work saved**. Actual failed checks stay visible under **What went wrong**, including when execution finished; expected TDD failures and inconclusive proof checks are shown separately. Read-only councils show their findings and publication controls directly.

**Request a fix** prepares an editable follow-up without sending it. Repeated clicks focus the same request without duplicating it or removing your own notes. **Fix check command** opens a continuation dialog: choose the saved result branch and correct setup/check commands. Starting it creates a child run with the same team and permissions and a single configured check. Original history and evidence remain available.

Independent agent review applies to the reviewed commit. When a follow-up changes that result, **Review: Outdated** keeps the earlier findings as history. Inspect the updated changes and checks before accepting or publishing them; a passing follow-up check does not renew independent approval.

## Talking to a run

[Auto teams](auto-team.md) add individual member targeting and structured questions. Questions addressed to you pause the workflow and appear in **Needs you**; answering saves the reply before work resumes. The team panel exposes tasks, dependencies, messages, coverage, checkpoints, context references and coordination usage. Its project-memory panel supports revision-aware edits, acceptance and deletion. A stopped Auto team with unresolved gaps resumes its existing workflow with a fresh bounded allocation.

Runs are conversations, not fire-and-forget jobs:

- **Approve the plan:** tick *Let me approve the plan* (the subtasks for Supervisor, the tests for Test-first). The run pauses at that checkpoint, and its time budget with it.
  - **Approve:** the agents start building.
  - **Ask for changes:** your note goes to the author, who revises in its own session and asks again.
  - **Reject:** the run ends without building anything.
  - A pending checkpoint survives restarts. Waiting runs show under *Needs you*, with a notification.
- **Message the team** while it runs, from the reply box. **To** picks the agent, or *Next agent* gives the note to the first one that can take it. A line next to it says where the note will go.
  - **Into a running Codex turn:** Codex runs through `codex app-server`, so a note for Codex (or for anyone) reaches its running turn right away, as a new message on the live thread (`turn/steer`). Codex takes it into account from its next step, without waiting for the turn to end.
  - **At the start of the next turn:** Claude, agy, and Codex on the `exec` fallback can't take input mid-turn. Their notes are added to the start of that agent's next turn.
  - The run view shows each note as queued or delivered, and which step it reached ("✓ delivered to Codex mid-turn (Implement plan)"). A mid-turn note also shows in that step's transcript. If the turn ended just as the note arrived, the note goes back in the queue for the next turn. If the step is retried, the retry gets the note in its prompt.
  - **When no turn comes:** a note sent during the last turn, which couldn't take it, has no turn left to go to. When the run finishes, its text stays visible above the reply box as **Not delivered**, with **Put in reply box** to restore it alongside any draft you already wrote. The Activity log retains the same record. It never reaches a later reply's turn as if you had just sent it. (A [single agent](#a-single-agent) takes it as your next message instead; a run that stops keeps it for its resume.)
- **Reply** after it finishes, from the same box:
  - to an agent in its worktree (**To:** e.g. *Codex · build*): it continues its own session, then code-flow commits and re-runs the check;
  - or to *Whole team · new run*: a new run that starts from this run's result branch, with your feedback added to the task.

Your messages display exactly as typed, including code identifiers such as `__init__.py`. Agent answers support Markdown; local file links show their labels and expose the target on hover without opening local URLs.

Reply drafts, including attached browser screenshots, are saved for the run and the connected computer in this browser. They survive new tabs and browser restarts; legacy tab-only text is migrated when opened. Another tab's edits warn before replacing your local text, and a successful send clears the saved draft. If storage is unavailable, a warning explains that the draft remains only in the open tab. Draft-dependent actions wait for saved content to load.

For a local provider known to be signed out, the reply box links to **Settings → Agents & models** and offers **Recheck sign-in**. The warning does not lock out a fresh retry after signing in. A failed reply is marked beside the reply box; it does not erase a previously completed conversation. Send another reply to continue. Provider errors appear once in the finished turn, with recovery actions below; **Show work** retains the full transcript.

<kbd>↵</kbd> sends and <kbd>⇧</kbd><kbd>↵</kbd> adds a line.

### A single agent

A **Single agent** run is one conversation with one agent, as in that agent's own app:

- The run reads as a chat: your messages, and each turn the agent takes. A turn streams live while the agent works. Once it's done, it folds into the agent's answer, with **Show work** for its tool calls and thinking.
- There's no **To**: every message goes to that agent. A message you send while it works goes into its running turn if the turn takes input (Codex). Otherwise it's sent as your next message as soon as the turn ends, so nothing waits for a reply you'd have to send again.
- A turn that fails ends that turn, not the conversation: reply to try again or to change course. Whatever it changed is kept on its branch.
- Agent conversations keep working files without automatically committing. **Review changes** includes new and uncommitted files, and feedback returns to the agent in the same workspace. Ask the agent to commit when ready; publishing and recorded approval apply to committed code. Agent replies do not automatically run the configured check or verification gates. The check remains available for merge validation; ask the agent to run tests, or enable AI team for checked work. Managed workflows, including explicit checkpointed Agent runs, checkpoint and run configured checks after changes.

Prompts are passed on **stdin**, not as command-line arguments (`claude -p` reading stdin, Codex's JSON-RPC or `codex exec -`, and agy's stream-json input), so long tasks and diffs aren't limited by the operating system's argument size.

## Projects

Runs are grouped into projects. A project has a name and the repositories its runs work in.

- **No setup:** the first time you start a run in a repository that no project holds, code-flow makes a project named after it. The first time you start a code-flow that has projects, every repository that already has runs gets one, so your runs are grouped from the start.
- **The sidebar** lists every project with its runs under it, the projects with the newest runs first. Click a project's name to open its page, or the arrow next to it to fold it. Hover it for **+** (a new run in that project) and **⋯** (rename it, change its repositories, or delete it). Projects with nothing to list fold into one *more projects* line, each with how many archived runs it has. **+** next to *Projects* makes a new one.
- **A project's page** shows what needs you, what's running, recent results with their check and pull request state, the project's automations and inbox, and the week's numbers (runs, checks passed, cost). Its task box opens the composer in the project. The side panel shows the project meanwhile.
- **The project button** (in the composer, in Insights and Automations, or <kbd>p</kbd>) picks the project you're in: new runs start in it, and Insights and the [Automations page](automations.md#projects) show it. With *All projects*, a new run goes in its repository's project.
  - Automations says when other projects have results or automations too, with a link to show all.
  - The read-only [phone view](automations.md#phone-view) lists every project's runs, each under its project's name.
- **Switching projects** moves the composer to the project's repository you used last, and to the pattern and team you last started a run with there from the composer (chats in the side panel don't change it). Each project remembers its own.
- **Several repositories:** a project can hold several, and a repository can be in several projects. Each run still works in one repository. **New project** and **Edit** in the switcher name a project and add or remove its repositories.
- **A run's repository always belongs to its project.** Starting a run in a project, or moving one there, adds the repository if it's missing. The composer says so before you start.
- **Moving a run:** click the project chip at the top of the run. Provider tabs, side chats and delegated team executions move with their conversation; side chats cannot move separately. Branches and worktrees stay where they are.
- **A side-panel chat** starts in the project you're in, like a run from the composer.
- **Runs started from other runs stay in that run's project:** replies to the whole team, chats started from a run's result, comparisons, sweeps and automations. An automation whose project was deleted starts its runs in its repository's project.
- **Deleting a project** keeps its runs; they show under *No project*. Taking a repository out of a project keeps the runs already in it.
- Project edits detect stale name or repository changes from another tab. Reload the current project in the editor, review it, then reapply your changes. An unreadable browser draft is retained without being overwritten; other project drafts remain available.
- Projects are saved in `~/.codeflow/projects.json`. Each run records its project in its own log.

## The side panel

The panel on the right (the button at the top right, or <kbd>\</kbd>) follows what you open, like the side pane in Claude's or Codex's app. On a run (or its review), every tab is that run's: its project, its repository and its worktrees. On a [project's page](#projects), the composer and elsewhere, it's that project and repository. The line at the top of the panel says which. The pin keeps the panel on one run or project while you open others; **Follow** lets go. **Expand** fills the app window; **Restore** or <kbd>Esc</kbd> returns to the split view. Each run and project remembers its own tab, chats, terminals, folders and browser pages, so going back to a run brings its panel back. Drag the panel's left edge to resize it; a narrow panel names only the open tab.

Chat, Terminal and Browser keep what's open in a strip, like browser tabs: **+** opens another, a pill shows when one is working or has news, and **×** closes it.

The Browser follows the selected run, so a run without a website shows **No website open**. Pages in other runs stay open in their own browsers. To keep a website visible while you switch runs, choose **Keep open** in its panel header. This pins the whole panel; **Follow** resumes switching with your selected run.

- **Chat.** On a run, a side chat works in the run's own worktree, as a conversation of its own with the agent you pick: messages to the run's agents never reach it, and a reply to the run never continues it. **Ask** only reads, and leaves the result and its check as they were. code-flow doesn't undo what changes in the worktree while an Ask runs, since you may be working there too; a warning names the changes instead (agy can write even in an Ask: see [caveats](security.md#caveats)). **Change** edits the worktree: code-flow commits the change on the run's branch, runs the check, proves it again and updates the result, as it does for a reply; the steps it takes (the check, the proof) are the side chat's, not in the run's timeline. A message sent while the team is still working waits for it to finish, then gets a time and step budget of its own. If the run fails or is stopped before the message's turn starts, it ends with a note saying so: resume the run, then send it again. A turn the run stopped in the middle of waits instead, and resuming the run finishes it. The run's thread stays the team's: a side chat's turns aren't in it, and a change one made gets one line there, with a link back. **☰** lists every chat, closed ones too, and **Separate chat** starts a [Single agent](#a-single-agent) run on a branch of its own, from the run's result. In a project, a chat is such a run (it has no worktree to share): it shows in the sidebar, keeps its session and its branch, and **Open** shows it as a run.
- **Changes** (on a run) lists what it changed: the whole result branch, or just its **last step** (the latest commit, a side chat's change, say), with a diff per file, kept up to date while the run works. Click a line to comment; comments go to the agent that wrote the code, and their drafts are shared with the full-width [review](github.md#review-and-ship) (**Full review**).
- **Files** lists the folder's files (ignored files hidden; **M** changed, **U** new), with search. A file opens in the shared editor used by Repository tools → Code, with version-checked saves, three-way conflict resolution and recoverable drafts. Active run worktrees remain protected against manual saves. Open **What could this change affect?** for static import evidence. On a run, the folder picker offers the run's worktrees and starts on its result's, so you can read what the agent wrote before merging; a project with several repositories offers each. From the composer, **+** and dragging add a file to the task's context. With the keyboard, <kbd>Enter</kbd> opens a file or folder, <kbd>→</kbd>/<kbd>←</kbd> open and close a folder, and <kbd>↓</kbd>/<kbd>↑</kbd> move through the list.
- **Terminal** is a real terminal in a run's worktree (its result's, to start with) or the repository: your login shell in a pseudo-terminal, so prompts, colours, pagers and full-screen programs (`vim`, `htop`, `less`, `git log`) work, mouse clicks and scrolling too, and it fits the panel as you resize it. The first one opens when you show the tab; close the last one and the tab stays empty until you open another (**Open a terminal** or **+**). While a project has a custom [filesystem restriction](filesystem-policy.md), terminals are paused: none opens, and the tab says which project and links to its policy. **+** opens another in any of them, and **Split** shows two, one above the other (drag the line between them). An app the run started with **Run app** can be shown as a read-only log, which stays after the app exits, marked *exited*. A shell stays open between commands, so `cd`, exported variables and virtualenvs stick. Its pill names what's running in the foreground; <kbd>Ctrl</kbd>+<kbd>C</kbd> stops the command, and **Stop** ends the shell with everything it started and opens a new one in the same folder. Copy and paste with <kbd>⌘C</kbd>/<kbd>⌘V</kbd> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>/<kbd>V</kbd> elsewhere). A terminal you come back to, or reload, shows what it showed before (the last 256 KB). Up to 12 shells stay open; a new one takes the place of the oldest idle one, never one that's running something, in the foreground or in the background (`npm run dev &`, a stopped `vim`). If all 12 are, opening another says so: stop or close one first. Closing one ends everything it started, `nohup`'d and disowned jobs too, and stopping code-flow closes every shell the same way. The pseudo-terminal needs `python3` (3.6 or later, standard library only; `CODEFLOW_PYTHON` picks another). Without it a shell is fed through a pipe: commands run one at a time and each reports its exit code, there are no pagers, prompts or full-screen programs, colours are off, and <kbd>↑</kbd>/<kbd>↓</kbd> recall commands.
- **Browser** shows a live Chrome shared by you and the run's agents. **Preview** opens the app here, or enter an address and click **Go**. Local apps load directly in this dedicated browser profile, separate from your personal Chrome. **Fit panel**, **Tablet** and **Phone** choose the viewport. **Take control** pauses agent input; release control when finished. Tabs, navigation, file uploads and downloads all refer to this same browser.
  - **Pick** selects an element; **Box** marks an area. Each produces a numbered pin with a screenshot and a comment. **Adjust** tries style changes on a picked element. Pins survive navigation, but Adjust becomes unavailable for elements from an earlier document.
  - **Console** shows errors, warnings and failed requests. The latest 300 entries per tab survive panel changes, app reloads and pop-outs while the browser session is running. Navigation or **Clear** resets them. A `+` and an omission message show when older entries were dropped. Attachments include at most the last 20 retained errors, with omitted context disclosed.
  - **Add to chat** puts selections in the message box as removable context cards; add your message and send it. **Send to** chooses another chat or a new run. Evidence includes the selector, page content, screenshot, style changes and optional console errors. Attached screenshots are saved in `.codeflow-context/`, never committed. Older snapshot comments remain readable.
  - **Record a bug** records a repeatable browser journey. Screenshots on pins are drawn from the page's elements; some cross-origin images and fonts may be absent, and password fields are masked.
  - Visual comparisons use **Show me what changed** on the result, with separate fresh-profile captures. The Browser panel itself has no Snapshot mode.
- **Notes** is a scratchpad per repository (the run's, or the project's) plus a general one, saved as you type in `~/.codeflow/notes.json`, so it's the same on your phone. **→ Task** adds the selection (or the whole note) to the task in the composer; **→ Chat** sends it to a new chat.

## Runs survive restarts

Every run is saved to disk as it happens (`~/.codeflow/runs/<run>.jsonl`), and the server rebuilds the run list from those files when it starts.

- **Interrupted runs:** if code-flow stops while a run is going (Ctrl-C, a restart, a crash), the run comes back as **Interrupted**.
  - **Resume** re-runs the pattern from the top. Each step that already finished (agent turns, checks, commits, worktrees) is replayed instantly from a journal (`<run>.journal.jsonl`), and real work continues at the first unfinished step. Nothing finished is redone.
  - Runs that hit a time or step limit, failed, or were stopped by you can be resumed the same way, with a fresh budget.
  - A recorded check is replayed only if the code it checked is still the code at that point. A recorded commit is replayed only if it's still in the branch's history. Anything else runs again.
  - While it replays, code-flow reads what changed at the commit the replay has reached, not at the newest one already in the worktree. So the pattern decides as it did the first time: Test-first doesn't take the builder's later rounds for the tester's changes and undo them.
  - A race contestant or worker whose CLI wasn't signed in, or stalled, isn't recorded as failed: the resume gives it its turn. One that ran out of plan usage stopped the run, so its turn comes after the reset.
  - Follow-ups on a finished run don't replay the pattern at all; only the follow-ups run, each with a full time and step budget, and the run's check result stands until one of them runs the check again. A follow-up that fails doesn't undo the finished run.
  - Resume is claimed at once, so a double click or a PR watch can't start the same run twice. If the last attempt is still wrapping up (listing its work), the new one waits for it. Stop pressed meanwhile keeps it from starting: the run stays as it was. Archiving, merging, pushing and opening a pull request are refused while the run works (a follow-up or a side chat on it too, from any tab or your phone) and until a resume has started.
  - Notes delivered to a turn that never finished, or failed, go back in the queue for the next turn (the retry, or the resumed run).
- **Sessions that are gone:** an agent continues its own conversation only from a turn that worked. If that conversation no longer exists (the CLI says so), the turn runs once more in a new conversation, given the task from the start. A conversation that couldn't be resumed is never recorded as the step's.
- **At startup:** a step still marked as running in a run that isn't (code-flow stopped or crashed while it ran) is closed as interrupted. Folders in a worktree root that no run owns are listed in `~/.codeflow/server.log`; code-flow never deletes them. A run log without a run in it is logged there too, rather than skipped silently.
- **Clean shutdown:** Ctrl-C or SIGTERM stops running agents and marks their runs interrupted. A second Ctrl-C exits at once.
- **One server per data folder:** a second server on the same `CODEFLOW_HOME` waits for the first to stop (as in a restart), then refuses to start. A crash mid-write can leave a line half-written; it's closed off before the next write, so it never corrupts the next line. Failed writes, such as a full disk, are counted and reported at `/api/health`.
- **Needs you:** finished runs you haven't opened, and interrupted runs, are listed at the top of the sidebar, whatever their project, instead of under it. The browser tab shows the count, and the bell at the bottom of the sidebar turns on desktop notifications for when a run finishes or needs you.

## Insights, comparisons and finding runs

- **Insights** (in the sidebar, or <kbd>i</kbd>) shows, per agent and per pattern, for the project you're in, one repo, or everything, over 7 days, 30 days or all time:
  - runs, how often the result passed its check, and how often it was proven (a test fails without the change; a weak proof, where the tests only fail to load without it, doesn't count);
  - race wins, loops each agent got green, and review findings other reviewers agreed with;
  - failed steps, tokens (input, output, cached) and time per step;
  - Claude's API-equivalent cost. Your plan isn't billed per token; it's a measure of size.
- **Insights → Experiments → Compare setups…** starts the same task with several patterns at once, each with the team you last picked for it, optionally 2–3 times each. Insights shows them side by side: result, time, steps, tokens, cost, whether tests were touched, and whether the result was proven. The best value in each column is highlighted.
- **Tokens and cost** also show on each step, in the run's details under the header (with a per-agent breakdown on hover) and when you hover a run in the sidebar.
- **Disk:** every worktree is a full checkout, often with its own `node_modules`. Insights measures them and **Clean up** removes the worktrees, not the branches, of runs that finished more than *N* days ago (0: every finished run) and need nothing from you, and archives those runs. It never loses work the branches don't hold: a run whose worktree has uncommitted or untracked changes, holds commits no branch has (made on a detached HEAD) or is locked (`git worktree lock`), a run that's working, and a chat that shares its workspace with other chats are left as they are, and listed with the reason.
  - **Archive…** with its worktrees removed, and **Clean up**, also clear the rest of the run's folder in `.worktrees/`: scratch checkouts an interrupted attempt left (where proofs and reviewers' tests ran), and, when the branches go too, the context staged for its agents (kept otherwise: a resume or a reply copies it into the worktree it checks out again). The folder goes once it's empty. The pull request's head code-flow fetched for a run started from one (`codeflow-pr/<n>`) is deleted with the last run still using it, unless it's checked out somewhere; it can be fetched again.
  - An Agent conversation's tabs and side chats share one worktree, so archiving one of them leaves it alone. **Archive and clean up…** in the conversation's sidebar menu archives all of it and removes that worktree (uncommitted changes in it are lost), optionally with its branch. **Delete…** removes only the history; clean up first if you don't want the worktree.
  - If removing something fails (a worktree that isn't the checkout code-flow expects, a git error), the dialog says what and why; the run is still archived. A run whose branches were deleted says its changes are gone, and offers no review or merge for them.
- **A run deleted elsewhere:** the viewing tab shows a persistent notice and keeps its unsent reply text and images available to copy or save. The stale route is replaced so Back does not reopen deleted actions. Opening an old link also shows recovery instead of a cached conversation; the reply is never sent to a different run.
- **Finding runs:** the sidebar lists every [project](#projects)'s runs, one line each: a status dot, the task and its age (hover for the rest). It has search (<kbd>/</kbd>) and, behind the button next to it, grouping by project or by status, filters (needs you, running, passed, failing, tests changed; pattern; agent; this repo) and **show archived runs** (also the archive button at the bottom of the sidebar). While you search or filter, matching archived runs show too. <kbd>j</kbd>/<kbd>k</kbd> move between runs. In a run, <kbd>[</kbd>/<kbd>]</kbd> move between steps or agent turns. <kbd>\</kbd> shows or hides the side panel. <kbd>?</kbd> lists every shortcut. Run status changes are announced to screen readers.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
