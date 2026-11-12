# Code Flow in Claude Desktop and the Codex app

Connect either desktop app to the same local Code Flow MCP bridge. Describe a task in the app, review the proposed team and scope, then follow its progress and retrieve results in that conversation. The Code Flow workspace shows the same proposals, runs, decisions, and artifacts.

Desktop setup currently supports **both apps on macOS**. Codex configuration can also be generated on Linux with `--hosts codex-app` for clients reading that configuration. Automatic Claude Desktop setup on Windows/WSL is not supported: Windows needs a cross-environment launcher, not a Linux executable path in its desktop configuration.

## Setup

Install Node.js 22.13+, Git 2.38+, and at least one supported coding CLI, then sign in to that CLI. A desktop chat subscription alone does not install or authenticate a managed coding CLI. Enable shared updates below to copy a built release into persistent storage. Without shared updates, use a persistent installation because desktop configuration records absolute launch paths.

For a source checkout, install dependencies and build the local runtime first:

```sh
npm ci
npm run package:npm
```

Use `node /absolute/path/to/code-flow/dist/npm/bin/codeflow.mjs` in place of `codeflow` below, or install that package with your normal package installation workflow.

From the Git repository you want Code Flow to work on:

```sh
codeflow desktop setup --dry-run
codeflow desktop setup
codeflow desktop doctor
```

To choose one app or an explicit repository:

```sh
codeflow desktop setup --hosts claude-desktop --project-root /absolute/path/to/project
codeflow desktop setup --hosts codex-app --project-root /absolute/path/to/project
```

Setup does not start workers, run inference, or open a browser. `--dry-run` reports the files it would change without writing anything. `--json` returns structured output. Keep desktop configuration editors closed during setup, then load the connection in the selected host:

- **Codex app:** enable the generated `codeflow-<project>-<hash>` connection in **Settings → MCP servers**, then open a **fresh chat** for the native smoke test. Existing chats can retain the MCP configuration loaded before installation; toggling the server and sending another turn did not refresh that registry in the tested app version. The settings **Restart** button restarts the whole app, not just this MCP connection—avoid it while other chats are working. Use `/mcp` in the composer to inspect connected servers.
- **Claude Desktop:** fully quit and reopen the app, then verify the connection in its MCP settings.

Enable/trust the connection through the host's settings if requested. Organization policies may restrict local servers.

The setup command merges an entry named `codeflow-<project>-<hash>` into:

- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`.
- Codex app: `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is unset. Codex CLI also reads this configuration.

Each entry invokes the same bridge with an absolute Node executable, Code Flow launcher, and canonical repository path. It records the setup terminal's absolute PATH entries for Git/provider discovery and an absolute `CODEFLOW_HOME` for the shared execution store. An explicitly configured `CODEX_HOME` is also forwarded so Codex workers use the same profile. Other environment variables and provider credentials are not copied. Use the same `CODEFLOW_HOME` as your Code Flow workspace. Without shared updates, rerun setup after moving or upgrading the installation. With either setup, rerun it after changing Node versions or provider executable locations.

State is shared only by surfaces using the same store. WSL and Docker desktop environments can use separate stores even on the same computer; do not assume their tasks or projects appear in the native store.

These are **app-wide connections bound to specific repositories**. They remain bound even when another repository is open in the conversation. The MCP instructions identify the repository; proposals show it again before execution. Install separate connections for additional repositories and select the intended connection in the host. Use a small number of enabled connections to keep tool discovery manageable.

If you also ran `codeflow init`, its user-level `codeflow` connection (which follows the folder Codex starts in) may appear alongside these repository-bound desktop connections in Codex. Choose one route per repository to avoid duplicate tools. `codeflow uninstall --user` removes the user-level CLI connections and skills; it preserves history, preferences, and modified entries. Desktop connections supply their workflow instructions directly over MCP and do not require project skill installation.

## Global app access and optional project terminals

Desktop connections are installed in each app's user configuration and remain bound to the repository shown in their name and instructions. You can turn access off and back on independently for either app:

```sh
codeflow desktop disable --hosts claude-desktop --project-root /absolute/path/to/project
codeflow desktop enable --hosts claude-desktop --project-root /absolute/path/to/project
codeflow desktop disable --hosts codex-app --project-root /absolute/path/to/project
codeflow desktop enable --hosts codex-app --project-root /absolute/path/to/project
```

`enable` and `disable` are aliases for the ownership-aware setup/removal commands. They change the app connection only; they never stop the backend, cancel runs, or delete history. Reload the affected MCP connection to apply the change. A host's own tool toggle can also hide tools in a conversation. Tasks assigned to the current host session can wait for reconnection; managed workers continue independently.

Claude Desktop has its own config, separate from Claude Code. **Codex app and Codex CLI share global config**, so plain `codex` also inherits enabled desktop connections. To keep terminal Codeflow access project-only, launch it through:

```sh
codeflow terminal codex
codeflow terminal claude
```

The Codex wrapper disables the `codeflow-*` desktop connections for that terminal process only. It leaves the user-level `codeflow` connection and unrelated MCP servers alone. Claude uses its normal project configuration. Neither command installs anything or changes the global configuration. Provider arguments follow `--`, for example `codeflow terminal codex -- --model MODEL`. Explicit provider configuration overrides remain under your control.

Set up terminal access once with `codeflow init --providers claude,codex`; it follows the repository each CLI starts in. Remove it with `codeflow uninstall --user`, then reconnect terminal sessions. Project trust and provider authentication still apply. Existing globally installed Codeflow entries from other installation methods should be removed separately if you want strict project-only access.

## Try a task

In either app, ask:

> Use Code Flow for this repository. Have Claude draft a login form plan and Codex review it. Plan only. Show the proposed work before starting.

The connection exposes the same tools as the CLI integration: six by default, and the advanced ones after `codeflow tools all`. Both hosts receive the rules and the flow through MCP initialization. The candidate format for the advanced tools is served by `codeflow_get_guide`.

When the host advertises form elicitation, starting a proposal opens its native confirmation form. Otherwise, follow **Open in Code Flow** to review and start the exact proposal. The interactive `codeflow approve` command remains a fallback. A host's generic tool permission or an assistant's approval claim does not replace proposal acceptance. Declining starts no work; retrying the same accepted proposal does not create a second run.

Ask for progress, retrieve the actual result, steer the task, or pause/cancel it in the same chat. Managed workers can continue when the desktop app closes. Current-session read-only assignments wait for their bound host and require the existing attachment flow after reconnecting. Ordinary desktop chats are not mirrored, and the full Code Flow interface is opened separately rather than embedded inside the host.

## Check and remove

```sh
codeflow desktop doctor --hosts claude-desktop,codex-app --json
codeflow desktop remove --dry-run
codeflow desktop remove
```

`doctor` checks configuration ownership and whether it matches the current executable paths, PATH, repository, and state directory. It reports `configured`, `disabled`, `missing`, `modified`, `needs_update`, `invalid`, or `interrupted`, and exits nonzero unless every selected connection is configured. It does not launch MCP, verify provider login, or certify native app discovery.

For a native smoke check, reload the connection as described above, verify the six `codeflow_*` tools appear, ask it to list Code Flow runs, then try the plan-only example. Check that the displayed repository is correct, decline one proposal, approve a fresh one, retrieve its result, and confirm the same run appears in Code Flow. This uses your installed CLIs and can consume provider quota once you approve a task. Retrieving a result with a separate CLI or stdio probe confirms the bridge works, but does not verify that the desktop chat can call its native MCP tools.

Setup refuses to overwrite an existing unowned or modified entry. Removal deletes only entries still matching the private ownership record and preserves other MCP servers/settings. Modified entries are reported and retained. Use the same `CODEFLOW_HOME` for setup and removal; ownership records are stored there. An interrupted transaction is recovered on the next non-dry setup/removal. Private transaction records can temporarily contain configuration snapshots and are written with owner-only file permissions.

If tools do not appear, inspect the host's MCP logs and run `doctor`. Check that the configured Node executable and Code Flow installation still exist. If Codex logs show this connection as `ready` in a newer chat but it is absent in an older chat, open a fresh chat before changing the server configuration. A short-lived settings discovery connection is not evidence that the active chat loaded the tools. The native enabled toggle is recognized as a preference, not reported as a modified installation. Restarting the Code Flow backend does not refresh a desktop chat's tool list and can interrupt active runs. If a running owner is incompatible, let existing work settle and restart it with the installed version. If the host cannot display confirmation, use the shared workspace link. After removing a connection, reload it in the host; removal does not cancel existing work.

## Automatic shared updates

From a built release, enable updates once, then migrate each existing desktop/project connection using its setup command:

```sh
codeflow updates enable --channel preview
codeflow desktop setup --project-root /absolute/path/to/project
codeflow init --providers claude,codex
codeflow updates status
```

The desktop apps, Claude Code, and Codex CLI now use one stable launcher under `CODEFLOW_HOME/integration-runtime`. Reload their MCP connections once after migration. Existing modified or unowned host entries remain protected by the installers. Managed skills installed by `init` in your user settings are small entry points that defer to the running release's workflow instructions supplied by MCP initialization. User-edited skill files are never automatically overwritten.

The launcher checks the official npm registry for `@midhunxavier/code-flow` on first use and every six hours while a managed session or headless backend is running. `preview` follows published preview releases; choose `latest` for the stable channel. Checks only adopt a newer version advertising managed-runtime protocol 1. They verify SHA-512 integrity, install offline with lifecycle scripts disabled, validate startup, and atomically select an immutable release directory. Failed or offline checks retain the selected version and record the error in `updates status`. npm must be available for installing downloaded releases. Release directories are retained so running processes never lose files beneath them.

A new release switches over on its own once no work is running. Connected MCP sessions and open browser tabs do not hold it back. The managed headless backend checks every 15 seconds. It waits while any of these is going on: a run, a start, a side turn, a check, validation, a repository lease, unresolved remote work, a terminal, an active request, or an open start/apply confirmation. Then it closes admission atomically and shuts down gracefully. Its successor starts on the same port with the same sign-in and the same history, so an open tab reconnects by itself. Each open Claude Code or Codex session then moves to the new release within a few seconds, without being reconnected. The host is told its tool list may have changed. `updates status` shows the release of the backend and each session, and what the switch is waiting for. A backend started outside shared updates is never replaced automatically.

**An older or manually launched backend is never killed by the updater.** It continues serving its existing runs; the first managed version takes over after that backend exits normally. No process is declared idle by scanning saved run files. Disabling updates stops registry checks but retains the launcher, installed releases, and any already-selected release.

```sh
codeflow updates check          # check now; reports download/validation errors
codeflow updates status --json  # selected release, backend, sessions, last error
codeflow updates disable       # stop automatic registry checks
```

To install a local build explicitly, run `updates enable` from that build's `dist/npm/bin/codeflow.mjs`. Host paths remain stable. Updating this runtime does not update Node.js, the desktop apps, or the provider CLIs themselves.

## Validation and scope

Known limitation from native validation: a fresh Codex desktop chat successfully discovered and called the read tools. Claude Desktop's Code mode discovered the same tools, but run retrieval returned `runtime_unavailable: fetch failed` while an independent backend read succeeded. Claude-to-backend connectivity remains unresolved; native result retrieval in Claude Desktop's normal chat mode is not yet verified. Do not restart a backend with active runs to work around this failure.

Automated tests cover setup/removal, preserved settings and edits, separate repositories, interrupted-install recovery, launcher routing, both generated configurations launching the shared stdio bridge from an unrelated working directory, tool discovery, native/fallback approval, result retrieval, and repository isolation. Managed Codex workers disable the owner MCP entries, including desktop connections, in both exec and app-server transports; Claude workers use strict scoped MCP configuration.

These tests use simulated MCP hosts and fixture providers. They do not certify a particular Claude Desktop or Codex app release, infer model compliance, or validate paid provider authentication. The local configuration route is implemented here; distributing a `.mcpb` extension is a separate packaging option.

References: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Desktop local MCP servers](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), and [Code Flow conversational teams](cli-conversational-teams.md).
