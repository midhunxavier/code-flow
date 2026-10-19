# Configuration

## Application settings

Open **Settings** at the bottom of the sidebar, press **⌘, / Ctrl+,**, or search for a settings category in the command palette. Categories have shareable addresses such as `#/settings/ssh`; browser Back and Forward preserve navigation. Search settings by a feature name such as “theme”, “permissions”, “VM”, or “Tailscale”.

- **General:** light, dark, or system appearance; sidebar grouping; archived runs; keyboard shortcuts. Terminals follow the selected appearance.
- **Agents & models:** provider health and usage, model and effort defaults. Sign in through the provider CLI on the current machine.
- **Run defaults:** workflow, plan approval, agent permissions and run limits. These update the composer’s remembered choices and the current draft; running work is unchanged. Project defaults and per-role choices can override model preferences.
- **Workspace:** repository verification, code, dependencies, context, history, services, coordinated changes and filtered tasks.
- **Insights:** run statistics, provider usage, comparisons, evaluation evidence and disk use. The **i** shortcut opens this category.
- **Automations:** schedules, webhooks, the review inbox and deferred runs. The **a** shortcut opens this category; old `#/automations` bookmarks still work.
- **Notifications:** browser notifications and outbound notification destinations.
- **SSH connections:** save and open remote VMs, with optional port and identity-file overrides. See [SSH projects](ssh-projects.md).
- **Remote access:** Tailscale, Wi-Fi, pairing and device access to the local workspace.
- **Team:** connect this computer to a team server as a runner and map repository keys to local clones; on the team server, define each project's repository keys and the owner's display name, read the `https://` address teammates connect to and revoke runners. See [Team collaboration](team-collaboration.md).
- **Integrations, Projects & access, Extensions, Data & storage:** existing source/code-host/worker integrations, project conventions, filesystem policies, shared accounts, extensions and retention controls.
- **Advanced:** collect/export diagnostics and find the server configuration reference. Process-level settings and credentials remain environment configuration and require a restart.

Appearance, run defaults and sidebar preferences save in this browser, separately for each SSH workspace. SSH definitions and the team link with its repository mappings save on the local server; project, access, notification and retention settings save on the machine hosting that workspace; team board tasks, checkpoints and runner registrations save on the team server the link points to. Controls with a **Save** action keep their existing explicit save behavior. Numeric run limits save when you leave the field; invalid values restore the previous setting.

**Settings → Workspace** contains repository tools: verification, code editing, dependency and context inspection, checkpoints, services, coordinated changes and filtered tasks. Workspace, Insights and Automations share the Settings navigation; the sidebar has one Settings entry. Older `#/workspace` and `#/insights` bookmarks (including comparison links) still work.

## Per-repo config

Commit `.codeflow/config.json` and every run in that repo (and every teammate) gets the same defaults. Anything you set in the UI wins.

```json
{
  "check": "npm test",
  "setup": "npm ci",
  "copy": [".env", ".env.local", "config/*.local.json"],
  "run": { "command": "npm run dev", "port": 3000 },
  "models": { "claude": { "model": "opus", "effort": "high" } },
  "limits": { "maxMinutes": 90, "maxSteps": 60 },
  "trust": "standard",
  "image": "node:22",
  "learn": true,
  "prove": true
}
```

- `check` and `setup`: the composer suggests both from the repo (see [Checks](patterns.md#checks-loops-and-limits)), but set them here when the guess is wrong. A uv workspace whose tests live in their own member might use:

  ```json
  { "setup": "uv sync --all-packages", "check": "cd tests && uv run --no-sync pytest -q" }
  ```

  Setup runs once per worktree outside the agents' sandboxes, so the check can run without network (`--no-sync`). When a run's check can't run at all (not installed, nothing collected, `conftest.py` can't import the project), the run says so and asks you to set these.
- `copy` brings files git doesn't carry (like `.env`) from your checkout into every new worktree. Only regular files that git ignores are copied. Symlinks are refused, since a cloned repo's `.env` could point at your credentials, and so are files git would commit. Patterns can't reach outside the repo, and nothing is copied through a symlink in the worktree.
  - Copied files are never committed, even when an agent un-ignores one or runs `git add -f`. Neither are new files named like secrets (`.env`, `.env.*` other than `.env.example`, `.env.sample` and `.env.template`, `*.pem`, `id_rsa*`, `id_ed25519*`). They stay in the worktree, and a warning names what was left out. Commit such a file yourself if it belongs in the repo.
- `image` is the Docker image for running checks in isolation (automations, untrusted sources). `learn` passes recurring review problems on to later runs. `prove` checks that each passing result has a test that fails without it ([fail-to-pass](patterns.md#checks-loops-and-limits)); set it to `false` when the check is too slow to run twice.
- A result's worktree that was removed (archived) is set up again when you follow up on it: files copied, setup run, context restored, and the files you sent with the follow-up added. If its branch was deleted, that follow-up fails with a clear message; the run itself stays finished. A follow-up also fails, rather than delete anything, when the worktree's folder is there but holds something else: move that folder away, then send it again.
- **Try it:** each result has **Terminal**, **Editor** (Cursor, VS Code, Zed or Sublime, whichever is installed) and **Folder** buttons that open its worktree, plus **▶ Run app**.
  - Run app starts your dev server in the worktree on a free port (passed as `$PORT`), with logs and **Stop app**. Servers stop when the run is archived or code-flow shuts down.

## What agents may do while building

**Settings → Run defaults → Agent permissions:**

| Mode | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Safe | edits files; no shell beyond read-only git | edits inside its sandbox | sandboxed to the worktree |
| Standard (default) | edits + common build/test commands (npm, node, pytest, uv, poetry, cargo, go, make…) | sandboxed, no network | sandboxed to the worktree |
| Trusted | any command | sandboxed, with network | sandboxed to the worktree |
| Full access | any tool, no permission checks (`bypassPermissions`) | no sandbox (`danger-full-access`) | no sandbox (no `--sandbox`) |

**Full access** turns every agent's sandbox off in steps that build: an agent can run anything, use the network, and change files outside its worktree with your credentials. Use it only on repos and tasks you trust completely. To keep it a choice you make:

- It's picked per run in the composer, which warns while it's on, and the run shows ⚠ full access. A repo's `.codeflow/config.json` can't turn it on: `"trust": "full"` there is ignored.
- Planning, reviewing and judging steps stay read-only, as in every mode.
- Runs nobody watches get less: automations and sweeps run with Trusted, and fixes for watched pull requests with Standard.
- A run started from someone outside the repo is locked down to Safe whatever you picked (see [Untrusted text](github.md#untrusted-text)).

Whatever the mode, code-flow never merges or pushes on its own.

## Models

Per provider in **Settings → Models & effort**, and per role right under each role's agents in the team. See [Getting started](getting-started.md#models-and-effort).

## Light or dark

code-flow follows your system's appearance until you pick one with the sun/moon button in the top bar. The pick is kept in that browser, and a side panel popped out into its own window follows it.

## Health

Click the agent dots at the bottom of the sidebar to see, for each CLI, whether it's installed, its version, and whether it's signed in. It uses `claude auth status`, `codex login status`, and for agy whether it can list models; credentials are never read. Claude's 5-hour and 7-day usage windows are shown from its own reports, with how to fix anything that's wrong. A run won't start with an agent that's signed out, and Auto skips an agent that turned out to be signed out for 15 minutes. If agy can't reach its servers, its sign-in shows as unknown rather than signed out.

Health also checks that each installed CLI still accepts the flags and subcommands code-flow passes (from its `--help`), and warns when one is missing: after a CLI update, that's the difference between "healthy" and every step failing on an unknown option. It also checks for git 2.38 or newer, which Merge needs.

Once an agent CLI reports its final result, it gets 10 seconds to exit; one that's still running then (a hook or MCP server that hangs on shutdown) is stopped and its result kept. A single output line over 16 MB is skipped, not read into memory.

## Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | Server port |
| `CODEFLOW_HOME` | `~/.codeflow` | Run logs and code-flow's own files (see [below](#files-in-codeflow)) |
| `CODEFLOW_WORKTREE_DIR` | `.worktrees` | Worktree folder; relative paths are inside each repo, absolute paths are used as-is |
| `CODEFLOW_STEP_TIMEOUT_MIN` | `30` | Timeout per agent step |
| `CODEFLOW_STEP_IDLE_MIN` | `15` | An agent CLI that prints nothing for this long is stuck (a login prompt, a stalled network, a hook that never returns) and is stopped. Keep it above your longest silent test run |
| `CODEFLOW_GIT_TIMEOUT_SEC` | `300` | Longest a git command may run, hooks included; cloning a new worktree's submodules gets 10 minutes |
| `CODEFLOW_MERGE_TIMEOUT_SEC` | `1800` | Longest **Merge…** may take in a checkout, your hooks included (a post-merge `npm install`, Git LFS). If git is stopped after it made the merge commit, the merge counts as done, with a warning |
| `CODEFLOW_MAX_AGENTS` | `6` | Agent CLIs running at once, across all runs |
| `CODEFLOW_MAX_CHECKS` | `3` | Check and setup commands running at once, across all runs |
| `CODEFLOW_RETRY_DELAYS_MS` | `20000,60000` | Waits before retrying an agent turn that failed for a passing reason |
| `CODEFLOW_TOKEN` | random per start | The session token (set it to keep browsers signed in across restarts; anything that can read it can use the API) |
| `CODEFLOW_MAX_DIFF_CHARS` | `60000` | Diffs longer than this are fitted (whole files first) before being passed to another agent |
| `CODEFLOW_CLAUDE_WRITE_TOOLS` | build/test allow-list | Comma-separated Claude tool rules for write mode, e.g. `Edit,Bash` |
| `CODEFLOW_REMOTE_PORT` | `PORT+1` | Port for the phone view (or the full app, with phone control) and webhooks on your network, when Wi-Fi or Tailscale is selected under **Remote access** |
| `CODEFLOW_TLS_CERT`, `CODEFLOW_TLS_KEY` | unset | Optional certificate/key file paths overriding saved HTTPS setup in Settings → Remote access. Configure both together; full control requires TLS on Wi-Fi and Tailscale so browser session cookies remain Secure |
| `CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL` | unset | Explicit `1` permits full phone control over HTTP for development |
| `CODEFLOW_INTEGRATIONS_FILE`, `CODEFLOW_INTEGRATIONS_JSON` | unset | Explicit external source definitions with server credential references; imports are read-only, while [GitLab/Bitbucket code actions](code-hosts.md) require separate explicit previews/actions |
| `CODEFLOW_REMOTE_WORKERS_FILE`, `CODEFLOW_REMOTE_WORKERS_JSON` | unset | Explicit provisioned SSH targets and repository mapping names; see [remote workers](remote-workers.md) |
| `CODEFLOW_EXTENSIONS_FILE`, `CODEFLOW_EXTENSIONS_JSON` | unset | Explicit trusted bundled provider/workflow plugins with API negotiation and SHA-256 pins; choose one configuration source; see [extensions](extensions.md) |
| `CODEFLOW_NOTIFICATIONS_FILE`, `CODEFLOW_NOTIFICATIONS_JSON` | unset | Explicit outbound destinations; targets remain disabled until event/project opt-in; see [notifications](notifications.md) |
| `CODEFLOW_SCHEDULER_TICK_MS` | `30000` | How often due automations are checked |
| `CODEFLOW_WATCH_INTERVAL_MS` | `60000` | How often watched PRs are checked for CI results and new comments. A PR that stays green with no new comments is checked less often, up to every 10 minutes |
| `CODEFLOW_CODEX_TRANSPORT` | `auto` | `auto`: `codex app-server` when the installed Codex has it, else `codex exec`. A Codex without app-server is re-checked every 10 minutes; a slow or failed app-server start fails only that turn. `app-server`: require it. `exec`: always `codex exec` (your notes then wait for Codex's next turn) |
| `CODEFLOW_PYTHON` | `python3` | The Python 3 that runs the side panel Terminal's pseudo-terminal (`scripts/pty.py`). It's found once and run by its full path, so a repository that pins another Python (pyenv, asdf, mise) still gets a terminal. Without a working one, terminals are line-based (`interactiveTerminal: false` in `/api/health`) |
| `CODEFLOW_CHROME` | first one installed | The Chrome, Chromium, Edge or Brave the side panel Browser's **Snapshot** runs headless. Without one, Snapshot says so |
| `CODEFLOW_AGY_SKIP_PERMISSIONS` | `1` | Set to `0` to stop passing `--dangerously-skip-permissions` to agy; then configure `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` |

A numeric setting that isn't a valid number (`30m`, say) or is out of range falls back to its default, with a warning in the terminal.

Child processes exclude the application API token, scoped team capabilities, integration/notification configuration and their registered server credential variables. They also exclude npm lifecycle variables about code-flow itself and its own dependency bin paths; your `npm_config_*` settings remain. A check's tools come from its repository. Explicit agent containers use a smaller environment and only their configured authentication volume; see [container setup](agent-containers.md).

## Files in `~/.codeflow`

| File | What it is |
|---|---|
| `runs/<run>.jsonl` | Each run's event log, appended as it happens; runs are rebuilt from it at startup. A run snapshot after the first is written as what changed; logs from older versions are compacted once, in the background. Unreadable lines (a crash mid-write) are skipped and noted in `server.log` |
| `runs/<run>.journal.jsonl` | The result of each completed step, written to disk at once, so **Resume** replays them instead of running them again |
| `runs/<run>.cold-index.json`, `runs/<run>.cold-detail.json` | Optional source-validated archived projections; corrupt/stale projections rebuild from the event log. Full archived detail uses a bounded cache; see [run storage](run-storage.md) |
| `shared-accounts.json` | Private password/session hashes, expiring accounts and project roles. Never exported in backups; see [shared projects](shared-projects.md) |
| `shared-reviews/<run>.json` | Commit-anchored human comments, separate from agent notes and prompts |
| `team/` | The team board this instance serves: `board.json` (each project's repository keys and its tasks with attempts, checkpoint manifests, discussion, decisions, instructions, reviews, hand-overs and audit), `runners.json` (runner names and credential hashes, never credentials), `inbox.json` and `checkpoints/<checkpoint id>.bundle`. Written whole through temporary files (heartbeats and progress reports reach `board.json` with the next durable change or within 30 s); one that can't be read is moved aside to `<name>.corrupt-<time>` and logged. At startup, temporary files and bundles that no available checkpoint lists are removed from `checkpoints/` and the removal is logged. Included in backups; see [team collaboration](team-collaboration.md) |
| `team-link.json` | This computer's link to a team server: its address, this computer's runner credential, your account, your repository mappings and defaults (mode 0600). Never exported in backups, like `shared-accounts.json`, and skipped by a restore; after restoring a backup on a linked computer, connect it again in **Settings → Team** and re-enter its repository mappings and defaults |
| `team-link/attempts/<attempt>.json` | Which local run belongs to which board attempt, and what was published; read at startup, by the recovery pass every minute and after a restore to reconcile with the team server, never to start anything again |
| `team-link/bundles/<checkpoint id>.bundle` | A checkpoint bundle this computer created, kept until the team server has received it; a failed upload is retried with the same file, and the file of a checkpoint that was given up is deleted |
| `filesystem-policies/<project>.json` | Revisioned read/write rules and content hashes; see [filesystem policy](filesystem-policy.md) |
| `filtered-tasks/` | Private filtered exports, exact policy/source/result records and explicit import receipts; never a startup execution queue |
| `remote-worker-private/` | Private SSH receipt capabilities; excluded from ordinary result projections and restore authority |
| `code-host-operations.json` | Safe confirmed/unknown code-host mutation receipts; no automatic replay after restart or restore |
| `extension-cache/` | Captured trusted plugin bundles; excluded from backup/restore and rebuilt only from explicit reviewed configuration |
| `projects.json` | Your [projects](runs.md#projects): names, repositories, and the team each one last used. Written whole (through a temporary file); a change that can't be saved fails and is undone. One that can't be read is moved aside to `projects.json.corrupt-<time>` and logged; if it can't be moved either, projects are off (runs start without one) until it's fixed |
| `server.log` | code-flow's own log, one JSON line per entry: failed requests, unhandled errors, failed writes, processes it cleaned up. Past 5 MB it moves to `server.log.1` (one old file is kept) |
| `processes.json` | The process groups code-flow has started and not seen finish. If code-flow dies without a clean exit (a crash, `kill -9`, a closed terminal), the next start stops what's left before resuming anything, so an orphaned agent can't keep editing a worktree. Pids from before a reboot, or reused by another program, are left alone |
| `server.lock` | One server per `CODEFLOW_HOME`. It records the server's pid, start time and the boot, so a lock left by a crash is taken over even when another program now has that pid, or after a reboot |

## Dynamic teams

`CODEFLOW_AUTO_TEAM_ENABLED=false` disables new Auto team runs while preserving saved-run viewing and recovery. Auto remains opt-in; the rollout record and evaluation evidence are shown in Insights. The recorded stage is informational (and a composer default when set to `default`); only `CODEFLOW_AUTO_TEAM_ENABLED` changes whether new Auto runs can start. Existing runs without the `eventDriven` option retain dependency-wave replay; newly created Auto runs default it on.

The authenticated run API accepts `loop.maxInvocations` as an additional per-allocation ceiling on actual CLI launches, including retries. Auto already caps launches with its step budget. Follow-up requests can specify `budget: { maxSteps, maxInvocations, maxMinutes }`; the UI exposes this fresh allocation and retains lifetime usage.

Project memory is in `memory.json`; evaluation reports and the explicit rollout decision live under the evaluation store in `CODEFLOW_HOME`. Both use durable replacement writes. See [Auto team](auto-team.md) for scope, trust, revision and deletion semantics.

## Standing project teams

Click **Enable Standing teams** on a project page to enable the feature immediately and save the choice for this host across restarts. `CODEFLOW_PROJECT_TEAMS_ENABLED=true` is an optional initial default; a saved UI choice takes precedence. `CODEFLOW_AUTO_TEAM_ENABLED` must also permit Auto team execution. Each team is separately activated by its owner. Schedules, budgets, missions, recovery and provider limits are described in [Standing project teams](project-teams.md).
