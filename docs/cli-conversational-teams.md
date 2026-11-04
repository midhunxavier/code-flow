# Agent teams in your CLI conversation

The conversational CLI integration builds a team and process from your task. You can choose Claude Code, Codex, individual models, and supported effort values in the same instruction. Existing web workflows and saved web teams are unchanged.

This integration is experimental. Automated tests exercise the project installer, public MCP protocol, worktrees, checks, agreement loops, host participation, and recovery with fixture providers. Native discovery was also checked on Claude Code 2.1.316 and Codex CLI 0.165.0: both found the skill and the then-current ten tools without inference. Workspace opening and task discovery bring the surface to twelve; its current validation uses protocol and browser fixtures. These checks do not establish that a model will follow every instruction correctly or certify other CLI versions.

For Claude Desktop and the Codex app, use the [desktop MCP setup](desktop-mcp.md). It reuses this bridge and supplies the workflow instructions without requiring project skill discovery.

Claude Code and Codex CLI also support [automatic shared runtime updates](desktop-mcp.md#automatic-shared-updates). Enable updates from a built release, then rerun `init` once to move their MCP entries to the stable launcher. Active sessions and runs keep their original release until safe handover.

## Install and connect

Use Node.js 22.13+, Git 2.38+, and at least one installed and signed-in Claude Code or Codex CLI. Use the installed Code Flow launcher on PATH. For a source build, run `npm ci`, `npm run package:npm`, then install the resulting `dist/npm` package using your normal local/global package installation method.

From your target Git project:

```sh
codeflow init --dry-run
codeflow init
codeflow doctor
```

`init` detects installed providers. You can choose `--providers claude`, `--providers codex`, or `--providers claude,codex`; both providers are not required for a task using only one. Setup merges project configuration and installs the `codeflow` skill. It does not run repository setup commands or agent inference. Existing unrelated MCP entries are preserved. It refuses to overwrite an existing or user-modified Code Flow entry.

Trust the project and approve its MCP connection through your native CLI. Reload the CLI if the skill/connection does not appear. Codex uses `.codex/config.toml` and `.agents/skills/codeflow/`; Claude uses `.mcp.json` and `.claude/skills/codeflow/`. Generated configuration contains the installed `codeflow` executable and relative project arguments, not credentials or machine-specific executable paths. It expects the native host to launch the project MCP server in that project's directory.

Code Flow connects to the existing local owner. If none is running, it starts one without opening a browser. It does not start a competing execution store or take over an incompatible owner. Close/restart an older owner if it lacks the CLI bridge. Codex configuration explicitly forwards `CODEFLOW_HOME`; use an absolute path for a custom state directory shared across projects.

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

When your host declares MCP form elicitation support, Code Flow displays the full proposal in a native confirmation dialog inside your Claude/Codex session. Approve and submit the form to start that exact revision. Declining or cancelling starts no work. The assistant requests this dialog by calling `codeflow_start_run`; it cannot supply an approval boolean as a tool argument.

The confirmation waits up to five minutes. The installed Codex configuration allows seven minutes per MCP call so its tool timeout leaves room for confirmation and owner communication. This does not increase the run's managed execution allowance. See [Claude Code's elicitation documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests) and [Codex's native elicitation protocol](https://learn.chatgpt.com/docs/app-server#mcp-server-elicitation-requests).

Every new CLI proposal also has an **Open in Code Flow** link. If your host cannot display the native form, open that chat and use **Start planning**, **Start implementation**, or **Start review**. The CLI and browser share the same acceptance and execution, so returning to the CLI does not start duplicate work.

You can also use the interactive terminal fallback:

```sh
codeflow approve PROPOSAL_ID --revision 1
```

The fallback displays the complete proposal. Type `start` to accept that exact revision, then return to your conversation so the host can start it. There is no unattended `--yes` bypass. Native provider tool permissions are separate from this workflow acceptance.

After upgrading an earlier install, rerun `codeflow init` with the same `CODEFLOW_HOME` to refresh installer-owned skills, then reconnect Code Flow from `/mcp` or restart the native host. A running MCP process retains its previously loaded code and a host conversation may retain the earlier skill instructions.

Normal reviews and repairs inside the accepted bounds do not require repeated workflow confirmation. Plan-only work never expands into implementation without a new proposal.

## Progress and changes

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

`codeflow init` now prints a short setup summary. Use `--json` for scripts or a detailed dry-run. `codeflow doctor --catalog` checks model discovery without agent inference; it does **not** certify authentication or repository permissions.

Use `codeflow status` to find recent tasks, `codeflow status --unfinished` to narrow the list, and `codeflow status RUN_ID` for readable progress and recorded participation. `--json` retains structured output. `codeflow result RUN_ID --json` includes the complete result body plus status and evidence. Completed runs return “Already completed” when resumed; further work needs a new approach.

The MCP `codeflow_list_runs` tool supplies repository-scoped discovery. `get_run` provides participant dispatch records, the final result reference, the latest recorded snapshot, and continuation context. Artifact discovery pages forward from `artifactCursor: 0` with `nextArtifactCursor`; the final `result` reference does not depend on that page. `get_artifact` returns review/check/snapshot metadata; changed files page with `fileCursor` and `data.nextFileCursor`, independently of body pagination. Changed files describe the recorded commit, not later uncommitted edits.

Attachment limits remain 1 MiB per file and 4 MiB total. The MCP and local HTTP envelopes now allow 8 MiB, with a 7 MiB proposal limit. Valid-sized requests that fail validation return correlated errors. A frame exceeding the hard transport cap may close MCP; reconnect and reduce the payload. No attachment is silently dropped.

For current-session participation, request status from the persistent MCP session before using its attachment command. Terminal status never suggests attaching to its temporary connection. Expired and terminal connections cannot claim the host role.
