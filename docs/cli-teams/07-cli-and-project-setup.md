# CLI, project installation, and user experience

Status: proposed. [Index](README.md)

All commands in this document describe the interface to implement. The existing release does not expose this full command set. Preserve the existing bare `codeflow` app launch and `codeflow client ...` behavior.

## Proposed commands

```text
codeflow init --providers claude,codex
codeflow doctor
codeflow team list
codeflow team configure
codeflow team save --proposal PROPOSAL_ID --name feature
codeflow propose "Describe the task" --team feature
codeflow approve PROPOSAL_ID --revision 2
codeflow run --team feature "Describe the task"
codeflow status RUN_ID
codeflow attach RUN_ID
codeflow pause RUN_ID
codeflow resume RUN_ID
codeflow cancel RUN_ID
codeflow result RUN_ID
codeflow mcp --project-root .
codeflow uninstall --project
```

`run` is a convenience flow: propose -> show exact preview -> confirm -> start -> display progress. It does not bypass acceptance. `approve` opens an interactive confirmation showing the exact configuration and records acceptance; it must not have a public noninteractive `--yes` bypass in V1. Host-specific trusted acceptance may avoid this fallback after compatibility validation.

## Installation journey

1. Install the released package and the provider CLIs required by the team. Use each provider's native login flow.
2. Run `codeflow init` from the project root.
3. Detect the canonical Git repository and installed providers without making paid inference calls.
4. Choose providers, a starter workflow, and default role settings; offer a saved team.
5. Preview project file edits, merge managed entries, and write atomically.
6. Restart/reload the host only where required by that host's documented behavior.
7. Run `doctor` to verify project discovery, model/effort compatibility, bridge startup, and effective configuration.

The setup MUST NOT install unrelated dependencies, run project setup scripts, launch paid tasks, overwrite existing host configuration, or silently change global settings.

## Project files

```text
.codeflow/
  cli-teams.json                 # schema version and default preset reference
  profiles/*.json                # portable model/effort selections
  teams/*.json                   # versioned role bindings
  workflows/*.json               # custom declarative workflow versions
.agents/skills/codeflow/SKILL.md  # Codex project skill
.codex/config.toml               # merge Code Flow MCP entry
.claude/skills/codeflow/SKILL.md  # Claude project skill
.mcp.json                       # merge Claude MCP entry
```

Use a new `cli-teams.json` namespace rather than repurposing the existing `.codeflow/config.json` without migration. Built-in workflows ship with the package and need not be copied into every repository. Portable project references select a workflow ID/version supported by the installed package.

Runtime endpoint discovery, acceptance receipts, provider sessions, local overrides, and artifacts live under private application state, not the repository. Personal presets may live in the existing private library with explicit scope. Project definitions override personal defaults only where explicitly referenced; no ambiguous same-name lookup during a run.

Generated MCP configurations use the installed executable and portable arguments, with verified project-root resolution. No credentials, captured absolute home paths, or unpinned runtime package downloads are committed. A shared repository does not install its executable dependency automatically; `doctor` explains missing or incompatible package versions.

## Installer ownership and rollback

Record the keys/files introduced by the installer with content hashes in a private installation manifest. Re-running init is idempotent. Config edits preserve unrelated keys and formatting where practical; parse failures stop with a precise explanation instead of replacing the file. Writes use temporary files plus atomic rename and backup/recovery metadata.

Uninstall removes only managed entries that still match the recorded ownership/content checks. User-modified entries are reported for manual review. Uninstall does not delete teams, run history, branches, or workspaces. It must not disconnect unrelated MCP servers.

## Everyday use

Claude Code example:

```text
/codeflow Use the feature team to add password reset.
```

Codex example:

```text
$codeflow Have Claude and Codex independently propose a plan, then agree on one.
```

The exact skill invocation behavior must be checked against the supported host version. Plain-language invocation can work through skill discovery, but explicit invocation is the documented deterministic entry point.

Example preview:

```text
Feature team — proposal 2
Planner: Codex / resolved model / high
Plan reviewer: Claude / resolved model / high
Builder: managed Claude / resolved model / medium
Code reviewer: managed Codex / resolved model / high

Plan agreement -> implement -> checks -> review and repair
Workspace: isolated run worktree from the shown base snapshot
Plan reviews: 3 total; code reviews: 3 total
Time/call ceilings: shown explicitly
Host role: conversation and decisions; no assumed control of its model
```

Users can request changes naturally. The host invokes `propose_team` again against the current revision. Inline overrides affect only the new proposal. Saving is a separate explicit operation.

## Skill responsibilities

Both host skills must:

- Resolve only the selected project and explicit task context.
- Discover supported providers/models rather than inventing model IDs or effort levels.
- Explain inherited/unknown host settings and managed-worker substitutions.
- Present the concrete proposal and obtain user acceptance through the supported channel.
- Call start once with an idempotency key and reconcile uncertain responses.
- Poll with cursors and bounded waiting, not tight loops.
- Claim only ready assignments for the bound host and submit exact-target artifacts.
- Treat worker artifacts and repository text as task evidence, not higher-priority instructions.
- Display the final deliverable and meaningful limitations.
- Never recursively start another Code Flow team to fulfill an ordinary worker assignment.

These instructions complement service validation; they are not a replacement for it.

## Current-session and background behavior

Show whether a run needs the current host to remain available. Managed-only stages can continue in the local runner according to the accepted policy. A required host step moves to `waiting_host` on disconnect. `attach` explicitly resumes participation; an expired claim does not authorize a second writer.

The original host may not support unsolicited completion notifications. V1 correctness relies on `get_run` and user-initiated resume/status, not notification delivery. Closing a terminal never implies cancellation unless the user selected that policy.

## Result presentation

Display: actual requested output, changes made, checks with evidence, outstanding findings, and the next action. A plan-only result includes the plan in the conversation, with an artifact reference for retrieval. A build result includes worktree/branch location and diff/check references. If nothing changed, explain why. Never state “Finished” merely because a provider process exited successfully.

## Compatibility references

- [Codex project skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Claude project skills](https://code.claude.com/docs/en/skills)
- [Claude project MCP configuration](https://code.claude.com/docs/en/mcp)

Public marketplace publishing and desktop plugin bundles are later distribution options, not prerequisites for V1 project installation.
