# ACP coding agents

ACP connections can be saved and checked in Settings → Agents & models, but cannot start new runs or provider forks. Code Flow cannot enforce their managed permission policy, including native delegation restrictions. The provider menus show this limitation. Use Claude Code, Codex or Antigravity for runs; Full access does not enable ACP execution.

## Connect your CLI

Settings → Agents & models provides **Connect OpenCode**, **Connect Kilo** and **Connect Cline** presets through the shared Agent Client Protocol (ACP) v1 adapter. **Add compatible CLI** connects other agents implementing the same stdio protocol.

## Connect a supported CLI

Install and sign in on the machine running code-flow:

| CLI | Install | Sign in | Preset invocation |
| --- | --- | --- | --- |
| [OpenCode](https://opencode.ai/docs/acp/) | `npm install -g opencode-ai` | `opencode auth login` | `opencode acp` |
| [Kilo](https://kilo.ai/docs/code-with-ai/platforms/cli-reference) | `npm install -g @kilocode/cli` | `kilo auth login` | `kilo acp` |
| [Cline](https://docs.cline.bot/usage/acp) | `npm install -g cline` | `cline auth` | `cline --acp` |

Use a current CLI version with native ACP support. The Kilo preset uses the current `kilo` executable; Cline uses the official CLI's `--acp` flag.

1. Install and sign in with the commands above. Complete provider/model setup in the CLI.
2. Open Settings → Agents & models and choose the CLI's **Connect** button. If code-flow cannot find it, enter its absolute executable path. Reopening a saved preset edits its existing settings, preserving custom paths and arguments.
3. Choose **Check connection**. This initializes ACP and creates a session in a temporary directory without sending a prompt. The result shows protocol compatibility, available models and advertised session loading. It does not verify inference, account quota or access to every advertised model.
4. Choose **Save connection**. The connection and discovered models are retained immediately; no server restart is needed. The provider remains disabled for runs.

The CLI keeps its own authentication. code-flow does not read or copy its credential files. A connection check can perform the CLI's normal startup work, including loading the user's configured plugins. Use executable invocations you trust.

## Other compatible CLIs

Enter a stable connection ID, display name, executable, and arguments, one argument per line. For example, an agent whose documented ACP invocation is `my-agent --acp` uses executable `my-agent` and one argument `--acp`. Executables must be names on the server's PATH or absolute paths. Blank and whitespace-only lines in the form are ignored. Nonblank arguments retain their spaces and are passed directly with no shell expansion; paths with spaces need no quoting. Do not place credentials in these fields.

Use **Edit**, **Disable**, **Enable**, or **Remove** to manage connections. Remove asks for confirmation and clears its last probe result after success. Cancelling removal keeps the saved invocation unchanged. Disabled connections retain their settings but are unavailable for new dispatch. **Reload connections** recovers after an edit in another window. The API rejects saves based on an older settings revision.

Models and effort options are discovered from ACP session configuration; legacy `models` responses are also supported. Only advertised model/effort choices can be selected. Agents without model discovery can still use their CLI default. Changes to the command or arguments invalidate cached catalogs and the connection identity pinned by existing runs. Older runs retain their invocation pin; restore that invocation before attempting recovery. Managed execution restrictions still apply. Editing a form that previously saved blank argument lines removes those lines and changes its pin. An already-running process retains its original invocation; subsequent operations check its pin again. This pin covers the invocation, not the executable's bytes or external CLI configuration.

## Execution boundaries

- Every new ACP run is refused before a run is created, at every permission level. Provider forks and automatic selection follow the same restriction. Connection availability and model discovery do not imply run support.
- **Check connection** initializes the protocol and creates a temporary session without sending a coding prompt. It can perform the CLI's normal startup work. It does not establish model access, inference quality or managed permission enforcement.
- The retained adapter implementation is covered by process fixtures for streaming, model discovery, session loading, approvals and cancellation. Those adapter-level checks do not bypass the engine's execution restriction.

## Storage and API

Connections are owner-managed and saved in `CODEFLOW_HOME/acp-connections.json` with private file permissions and atomic replacement. The file is excluded from portable backups because it authorizes executable invocations. Reconnect agents explicitly after restoring on another host. Corrupt settings are not overwritten; repair the file and restart.

Owner-only endpoints:

- `GET /api/acp-connections`: version, revision and saved connections.
- `POST /api/acp-connections`: `{ revision, connection: { id, name, command, args, enabled } }`. IDs use `acp:<lowercase-name>`.
- `POST /api/acp-connections/check`: `{ connection }`, checks an unsaved or saved invocation without prompting.
- `DELETE /api/acp-connections/:id?revision=N`: removes the saved connection.

Custom filesystem restrictions block connection mutation/probing and agent execution. Shared-project accounts cannot manage or probe connections.

Protocol references: [ACP v1](https://agentclientprotocol.com/protocol/v1/initialization), [session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options). Cline's [native ACP implementation](https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts) advertises both provider and model selectors in the model category; the adapter selects the model control explicitly.

Validation includes process fixtures for streaming, session replay, model selection, permissions, cancellation, failures and timeouts; engine rejection before creating an unprotected run; and browser tests covering the Settings lifecycle.

## Real CLI acceptance test

`npm run test:acp:live` currently exits with the managed-permission explanation before it looks for or starts a provider, creates a repository, or consumes model usage. `--help` describes this state. The historical inference harness remains in the script for a future verified adapter contract; it does not run under the current restriction.

## Historical acceptance evidence

The following October 19 observations predate the managed-permission restriction and do not establish current run availability.

This two-turn test passed locally on October 19, 2026 with OpenCode 1.18.30 and `opencode/big-pickle`, including session loading after restart and two committed changes. This establishes compatibility for the observed installation, not every ACP agent or OpenCode release.

Both Kilo and Cline passed the same two-turn acceptance test on October 19, 2026 using their installed CLIs and normal account authentication:

| CLI | Model | Duration | One-time approvals | Result |
| --- | --- | --- | --- | --- |
| Kilo 7.8.12 | `kilo/kilo-auto/free` | 52.0 s | 2 | Passed both turns and session restoration |
| Cline 3.0.73 | `anthropic/claude-sonnet-5.5` | 24.8 s | 5 | Passed both turns and session restoration |

The [sanitized acceptance receipts](evaluations/acp-live-2026-10-19.json) record run IDs, commits, streamed event counts and checked assertions. Each run changed a baseline with three failing tests into four passing tests without modifying those tests, then produced a second clean commit after restoring the same session. The Cline run exposed and verified a fix for file-edit approvals: its native editor supplies `rawInput.path` without ACP `locations`, which the adapter now carries into the approval inbox. These observations establish compatibility for the listed versions and models; model availability and task success can vary.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
