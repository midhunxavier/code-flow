# Agent teams in your CLI conversation

The conversational CLI integration builds a team and process from your task. You can choose Claude Code, Codex, individual models, and supported effort values in the same instruction. Existing web workflows and saved web teams are unchanged.

This integration is experimental. Automated tests exercise the project installer, public MCP protocol, worktrees, checks, agreement loops, host participation, and recovery with fixture providers. The current surface has fourteen tools, including exact diff preview and checkout handoff. Native-host compatibility and real-provider evidence are recorded separately in the QA reports; fixture checks do not certify model behavior or every CLI version.

For Claude Desktop and the Codex app, use the [desktop MCP setup](desktop-mcp.md). It reuses this bridge and supplies the workflow instructions without requiring project skill discovery.

Claude Code and Codex CLI also support [automatic shared runtime updates](desktop-mcp.md#automatic-shared-updates). Enable updates from a built release, then rerun `init` once to move their MCP entries to the stable launcher. Active sessions and runs keep their original release until safe handover.

## Install and connect

Use Node.js 22.13+, Git 2.38+, and at least one installed and signed-in Claude Code or Codex CLI. Use the installed Code Flow launcher on PATH. For a source build, run `npm ci`, `npm run package:npm`, then install the resulting `dist/npm` package using your normal local/global package installation method.

Install the launcher for regular use, then set up Code Flow once for your user account:

```sh
npm install -g @midhunxavier/code-flow@preview
codeflow init --dry-run
codeflow init
codeflow doctor
```

`init` detects installed providers. You can choose `--providers claude`, `--providers codex`, or `--providers claude,codex`; both providers are not required for a task using only one. Setup registers one user-level `codeflow` MCP connection per CLI and installs the `codeflow` skill in your user settings:

- Claude Code: `claude mcp add-json -s user codeflow …` (stored in `~/.claude.json`) and `~/.claude/skills/codeflow/`.
- Codex: a marked block in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) and `$CODEX_HOME/skills/codeflow/`.

Nothing is written into your repositories, so they never contain personal paths. The connection works on the Git repository the CLI was started in (a subfolder resolves to its repository root). Started outside a repository, it explains how to continue instead of failing. Setup does not run repository setup commands or agent inference. Unrelated MCP entries are preserved, and setup refuses to overwrite a `codeflow` entry or skill you created or edited.

If a repository has the older in-repository setup (`.mcp.json`, `.codex/config.toml`, `.claude/skills` or `.agents/skills` written by an earlier `codeflow init`), running `codeflow init` inside it removes the entries Code Flow owns and keeps anything you edited. `codeflow uninstall --user` removes the user-level connections and skills; `codeflow uninstall --project` removes only an older in-repository setup.

Start `claude` or `codex` from your project. Reload the CLI or reconnect from `/mcp` if the skill/connection does not appear.

Code Flow connects to the existing local owner. If none is running, it starts one without opening a browser. It does not start a competing execution store or take over an incompatible owner. Close/restart an older owner if it lacks the CLI bridge. Codex configuration explicitly forwards `CODEFLOW_HOME`; use an absolute path for a custom state directory shared across projects.

## Start in Claude Code or Codex

1. In the same project directory, run `claude` or `codex` and trust the project. Approve the Code Flow MCP connection if prompted; restart the CLI if the skill or connection is missing.
2. In Claude Code, invoke `/codeflow`. In Codex, invoke `$codeflow`. Native skill availability depends on your CLI version.
3. Describe the outcome, for example: “Use Claude to implement this bug fix and Codex to review it. Run the focused tests.” Both CLIs must be installed and signed in if you request both.
4. Review the proposed participants, work, checks and limits. Approve the native confirmation, or open the provided Code Flow link and start the task there. Ask for changes before accepting if needed.

## Describe your task

Invoke the installed `codeflow` skill in the host conversation. Examples of native explicit invocation are `/codeflow` in Claude Code and `$codeflow` in Codex; availability follows your host's native skill support. Then describe your task:

> Use Claude and Codex to plan a login form. Claude drafts; both review and agree on the same plan. Then a fresh Claude reviewer examines the final plan. Resolve blocking findings. Plan only.

Or specify your preferred models and effort:

> Use Claude Opus with high effort to draft the plan, Codex with my configured model and high effort to review it, and a fresh Claude Opus reviewer with the highest effort I select from its supported choices for final review.

Code Flow discovers the actual models/efforts before execution. Unsupported or ambiguous selections produce choices; there is no silent downgrade. You do not select a preset or create a named team.

Other requests use the same entry point:

- “Review my current changes with Claude and Codex. Report findings; do not edit.”
- “Fix the empty-email validation bug, run the project's focused tests, and have another agent review the change.”
- “Have two agents propose independently, synthesize their designs, then review the combined plan.”

A plain plan can use one participant without an agreement claim. A small implementation can use one writer and a passing check if independent review was not requested; the preview explicitly says that no independent review is included.

A continuation can retain completed code and only review and verify it, without launching another writer. Its preview identifies that no code editing assignment is included.

Only selected non-ignored untracked files enter a dirty-change snapshot. Tell the host which untracked paths to include. Source snapshots preserve your files and staging index. Managed agents work in a separate run worktree.

## Review and accept

The assistant shows the proposed jobs, provider/model/effort choices, work order, completion criteria, source snapshot, commands, and execution limits. Change the approach conversationally before starting.

When your host declares MCP form elicitation support, Code Flow includes the full proposal in a native confirmation dialog. The host may collapse the text. Open the review link to read the proposal in Code Flow, or set the approval field to True and submit it in the CLI after review. In Claude Code, Space ticks the checkbox, and **Accept** submits it. Declining or cancelling starts no work. The assistant requests the form with `codeflow_start_run` and cannot supply the approval value as a tool argument.

The confirmation waits up to five minutes. The installed Codex configuration allows seven minutes per MCP call so its tool timeout leaves room for confirmation and owner communication. This does not increase the run's managed execution allowance. See [Claude Code's elicitation documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests) and [Codex's native elicitation protocol](https://learn.chatgpt.com/docs/app-server#mcp-server-elicitation-requests).

Every new CLI proposal also has an **Open in Code Flow** link. If your host cannot display the native form, open that chat and use **Start planning**, **Start implementation**, or **Start review**. The CLI and browser share the same acceptance and execution, so returning to the CLI does not start duplicate work.

You can also use the interactive terminal fallback:

```sh
codeflow approve PROPOSAL_ID --revision 1
```

The fallback displays the complete proposal. Type `start` to accept that exact revision, then return to your conversation so the host can start it. There is no unattended `--yes` bypass. Native provider tool permissions are separate from this workflow acceptance.

After upgrading an earlier install, rerun `codeflow init` with the same `CODEFLOW_HOME` to refresh your user-level skills. With shared updates (`codeflow updates enable`), open sessions move to a new release on their own once no work is running. Without them, reconnect Code Flow from `/mcp` or restart the native host. In either case a host conversation may keep the earlier skill instructions until it starts afresh. If the backend restarts, or the computer sleeps past the connection heartbeat, a session reconnects on its next request.

Normal reviews and repairs inside the accepted bounds do not require repeated workflow confirmation. Plan-only work never expands into implementation without a new proposal.

## Progress and changes

After approval, the CLI conversation follows the run in the same turn. It reports changes in who is working, shares findings as steps finish, and retrieves the final result when the run ends. A paused run, a question for you, or a disconnected host assignment can interrupt the follow-up. Progress comes from completed steps and recorded run state, rather than workers' live token streams.

The linked browser chat shows **Team activity** under the approved task. It lists active assignments and completed outputs in order. Expand a plan, review, check, or decision to read it in full. The final result appears separately in the chat when execution ends.

Ask questions or steer work in the same conversation:

> What remains unresolved?
> Use the project's existing form components.
> Pause the run.
> Replace the reviewer with another model and show me the updated approach.

Material changes produce another proposal. Pausing waits at execution boundaries; an active turn may still finish. Cancellation requests termination and preserves artifacts and worktrees. Agreement loops have a fixed pass limit; remaining disagreement is returned to you rather than forced into consensus.

Continuations can start from a preserved run worktree, retaining completed implementation. Exact plan artifacts can also be supplied as context; source changes require revalidation. Continue through the CLI or the linked Code Flow chat. Changed scope, workers, and limits still require a revised approach. Existing web-created workflows retain their normal controls.

You can also inspect/control a run from a terminal:

```sh
codeflow open PROPOSAL_OR_RUN_ID
codeflow status RUN_ID
codeflow result RUN_ID
codeflow pause RUN_ID
codeflow resume RUN_ID
codeflow cancel RUN_ID
```

Closing your host does not guarantee cancellation or a completion notification. Managed work can continue under the local owner; a required current-session step waits. After reopening a host, follow the `codeflow attach RUN_ID --connection ...` command returned by status in that conversation. Attachment requires interactive confirmation and revokes old claims.

The current host can perform read-only planning/review assignments. Exact host model/effort and workspace control are not assumed. Strict model pins and implementation use managed workers. An interrupted writer without a durable result stops for inspection; create a new proposal from its preserved changes rather than blindly rerunning writes.

## Optional preferences

Skip this step unless you want defaults for later proposals:

```sh
codeflow preferences --provider claude --model YOUR_MODEL_ID --effort high
codeflow preferences --personal --provider codex --model YOUR_MODEL_ID
```

Selection order is explicit task setting, project preference, personal preference, then provider default. Actual support is checked when creating the proposal. Preferences never change an accepted run. There are no saved-team or preset-management commands in the initial CLI integration.

`codeflow preferences --preferred-provider claude` sets an optional provider preference. It is reported during discovery so the host can use it when the task leaves the provider unspecified.

## Results and boundaries

The assistant retrieves the actual plan, change summary, or review findings, including paged content when needed. Results identify checks, relevant snapshots, unresolved findings, and the worktree/branch for implementation. Agreement is not proof of correctness; a passing check belongs only to the code snapshot on which it ran.

Models are invoked through the existing official CLI adapters and their own authentication. Managed launch counts include retries; host usage may be unknown. Worktrees are not filesystem read isolation. Provider boundaries differ. Setup/check commands run as the user in the accepted execution environment. No automatic merge, push, or deployment is part of this integration.

Attempt ceilings include transport retries and schema repair for the same assignment. Call/time accounting survives resume. On an unclean crash without a durable invocation settlement, Code Flow conservatively charges that turn's bounded time reservation; parallel reservations are not added as if they ran sequentially. Inspect the returned recovery detail before requesting a new allowance.

To remove only installer-owned project entries:

```sh
codeflow uninstall --project
```

User-modified entries, preferences, history, branches, and worktrees are preserved.

Configuration references: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex skill locations](https://learn.chatgpt.com/docs/build-skills). See the internal [redesign plan](cli-teams/15-conversational-ux-redesign.md) for intended scope and acceptance scenarios.

## Open the shared workspace

In Claude Code or Codex CLI, ask:

> Use Code Flow to plan a login form with Claude Haiku and Codex at high effort. Open it in Code Flow so I can review the approach there.

Code Flow associates the canonical repository with an existing project, or creates a project when needed. The proposal appears as a normal Team chat before any workers start. `codeflow open PROPOSAL_OR_RUN_ID` opens that chat in your browser; opening never approves or starts work. The bridge uses the running owner's actual port, including an automatically started owner's port. Keep the same `CODEFLOW_HOME` in the CLI and UI to use the same workspace.

Approve in either surface, then watch recorded agent participation, checks, reviews, questions and results in the chat. Guidance and pause/resume/cancel actions affect the same execution. A browser edit invalidates an older CLI revision. When continuing the initiative, the host passes the returned `context.chatId`; retaining code additionally uses `context.continueRunId`. A new implementation after planning needs its own approval.

Only Code Flow task data is synchronized. Ordinary messages or work outside Code Flow in the native CLI are not mirrored. Managed workers can continue when the CLI closes; assignments bound to that CLI show **Waiting for CLI** until the host returns. Reopening the browser does not take over that assignment.

The browser is opened only on explicit request. Opening uses a short-lived, one-use local handoff; stable task links and MCP responses contain no login token. In SSH/headless environments, Code Flow returns the stable link instead. Forward the runtime's port to your computer and sign in to that owner before opening it. Full MCP Apps rendering inside hosts is not part of this integration.

After upgrading, rebuild/restart the Code Flow owner once existing work has settled, rerun `codeflow init` to refresh the installed skill, and reconnect the MCP session. Existing saved workflows and historical runs remain available.

## CLI usability and recovery

The first skill invocation checks the live owner connection and project configuration. A connection check performs no agent inference. `doctor` reports whether the owner bridge is reachable; the discovery response inside Claude/Codex confirms that host's connection. If configuration differs, rerun `init` and reconnect Code Flow in the host. Provider authentication remains separate.

MCP tool cards now contain readable summaries while preserving machine-readable structured results. Status distinguishes working, queued for a worker, waiting for a task answer, waiting for the CLI, pause settling, paused, completed and interrupted work. Guidance is shown as queued, delivered or undelivered; a queued message is not represented as already received.

For “implement that plan” or “continue that task,” the host can pass `context.reuseRunId` from the status response into the next proposal. Code Flow resolves the previous result and chat, preserves code for write-task continuations, and inherits matching participant model/effort settings unless explicitly overridden. Changed source requires revalidation. Every new proposal still needs acceptance.

`codeflow init` now prints a short setup summary. Use `--json` for scripts or a detailed dry-run. `codeflow doctor --catalog` checks model discovery without agent inference; it does **not** certify authentication or repository permissions.

Use `codeflow status` to find recent tasks, `codeflow status --unfinished` to narrow the list, and `codeflow status RUN_ID` for readable progress and recorded participation. `--json` retains structured output. `codeflow result RUN_ID --json` includes the complete result body plus status and evidence. Completed runs return “Already completed” when resumed; further work needs a new approach.

The MCP `codeflow_list_runs` tool supplies repository-scoped discovery. `get_run` provides participant dispatch records, the final result reference, the latest recorded snapshot, and continuation context. Artifact discovery pages forward from `artifactCursor: 0` with `nextArtifactCursor`; the final `result` reference does not depend on that page. `get_artifact` returns review/check/snapshot metadata; changed files page with `fileCursor` and `data.nextFileCursor`, independently of body pagination. Changed files describe the recorded commit, not later uncommitted edits.

Attachment limits remain 1 MiB per file and 4 MiB total. The MCP and local HTTP envelopes now allow 8 MiB, with a 7 MiB proposal limit. Valid-sized requests that fail validation return correlated errors. A frame exceeding the hard transport cap may close MCP; reconnect and reduce the payload. No attachment is silently dropped.

For current-session participation, request status from the persistent MCP session before using its attachment command. Terminal status never suggests attaching to its temporary connection. Expired and terminal connections cannot claim the host role.

## Inspect and bring changes into your checkout

After a verified implementation, ask “show me the diff” or “bring these changes into my branch.” The host previews the exact task delta and requests native confirmation to apply it. Terminal equivalents:

```sh
codeflow diff RUN_ID
codeflow diff RUN_ID --json
codeflow apply RUN_ID
```

Application requires a clean checkout on a branch and a diff that applies cleanly. It stages only the task's changes, excluding pre-existing changes captured as source context. It creates no commit or push. The preview is bound to the exact result, destination commit and branch; changed previews must be inspected again. Terminal application shows the diff and requires typing `apply`; there is no unattended approval flag.

Inspect `git diff --cached` afterward and rerun checks in the destination checkout. Recorded check/review evidence still belongs to the original result snapshot, even if the destination has moved. Repeating a successful application request returns its receipt; an interrupted application requires checkout inspection and is never blindly replayed. Partial or unverified runs can be inspected and continued, but cannot use this application path.
