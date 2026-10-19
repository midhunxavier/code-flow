# ACP coding agents

Settings → Agents & models → **Connect OpenCode** adds OpenCode through the shared Agent Client Protocol (ACP) v1 adapter. **Add compatible CLI** connects other agents implementing the same stdio protocol.

## Connect OpenCode

1. Install OpenCode on the machine running code-flow and run `opencode auth login` there.
2. Open Settings → Agents & models and choose **Connect OpenCode**. The preset uses executable `opencode` and argument `acp`. If code-flow cannot find it, enter its absolute executable path.
3. Choose **Check connection**. This initializes ACP and creates a session in a temporary directory without sending a prompt. The result shows protocol compatibility, available models and advertised session loading. It does not verify inference, account quota or access to every advertised model.
4. Choose **Save connection**. It appears immediately in provider and model selection; no server restart is needed.
5. Select the agent for a run and choose **Full access** in Settings → Run defaults or the composer's permissions controls.

The CLI keeps its own authentication. code-flow does not read or copy its credential files. A connection check can perform the CLI's normal startup work, including loading the user's configured plugins. Use executable invocations you trust.

## Other compatible CLIs

Enter a stable connection ID, display name, executable, and arguments, one argument per line. For example, an agent whose documented ACP invocation is `my-agent --acp` uses executable `my-agent` and one argument `--acp`. Executables must be names on the server's PATH or absolute paths. Arguments are passed directly with no shell expansion; paths with spaces need no quoting. Do not place credentials in these fields.

Use **Edit**, **Disable**, **Enable**, or **Remove** to manage connections. Disabled connections retain their settings but are unavailable for new dispatch. **Reload connections** recovers after an edit in another window. The API rejects saves based on an older settings revision.

Models and effort options are discovered from ACP session configuration; legacy `models` responses are also supported. Only advertised model/effort choices can be selected. Agents without model discovery can still use their CLI default. Changes to the command or arguments invalidate cached catalogs and the connection identity pinned by existing runs. Restore the original invocation to resume those runs, or start a new run. An already-running process retains its original invocation; subsequent operations check its pin again. This pin covers the invocation, not the executable's bytes or external CLI configuration.

## Execution boundaries

- ACP connections require **Full access** on the current application host. ACP does not provide a standard sandbox contract. Safe, Standard and Trusted permission profiles, SSH workers, agent containers, automated triggers and locked-down external-source runs are unavailable for these connections. Auto role selection excludes ACP unless Full access is selected.
- Read-only turns request read-only behavior and decline permission requests for file changes and execution. The engine's existing worktree change checks still apply. This is not OS-level read-only isolation; the CLI may allow actions without consulting the client.
- With **Ask me for tool permissions** enabled for an interactive run, ACP permission requests enter the existing approval inbox. Only `allow_once` can be approved; persistent permission grants are never selected. Requests are otherwise declined. Cancellation aborts pending approvals and sends `session/cancel` before bounded process cleanup.
- The client advertises no filesystem or terminal capabilities. The agent uses its own tools. Agents that require host-provided file or terminal operations are not supported by this first version.
- Session loading is used only when advertised. Replayed history is excluded from new turn output. Live mid-turn steering and the scoped code-flow team-tool bridge are unavailable; normal subsequent turns and structured team outcomes remain available.
- ACP has no standard constrained-JSON output option. The adapter adds the requested schema to the prompt and the engine validates the returned result. Context-window occupancy and cumulative session costs are not reported as per-turn token usage or cost.

## Storage and API

Connections are owner-managed and saved in `CODEFLOW_HOME/acp-connections.json` with private file permissions and atomic replacement. The file is excluded from portable backups because it authorizes executable invocations. Reconnect agents explicitly after restoring on another host. Corrupt settings are not overwritten; repair the file and restart.

Owner-only endpoints:

- `GET /api/acp-connections`: version, revision and saved connections.
- `POST /api/acp-connections`: `{ revision, connection: { id, name, command, args, enabled } }`. IDs use `acp:<lowercase-name>`.
- `POST /api/acp-connections/check`: `{ connection }`, checks an unsaved or saved invocation without prompting.
- `DELETE /api/acp-connections/:id?revision=N`: removes the saved connection.

Custom filesystem restrictions block connection mutation/probing and agent execution. Shared-project accounts cannot manage or probe connections.

Protocol references: [ACP v1](https://agentclientprotocol.com/protocol/v1/initialization), [session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options), [OpenCode ACP](https://opencode.ai/docs/acp/).

Validation includes process fixtures for streaming, session replay, model selection, permissions, cancellation, failures and timeouts; an engine run that changes a worktree and passes its check; and browser tests covering the Settings lifecycle.

## Real OpenCode acceptance test

Run `npm run test:acp:live` explicitly to test the installed OpenCode CLI using its configured authentication and a real model. This is outside the default test suite and consumes normal model usage. Set `CODEFLOW_LIVE_OPENCODE` to an absolute executable path if needed; `CODEFLOW_LIVE_MODEL` optionally selects an advertised model ID. Otherwise the test uses OpenCode's discovered default.

The script creates a temporary repository and a separate code-flow home, saves the connection through the Settings API, and starts a real coding task. It verifies failing baseline tests become passing without test edits, streamed text and tool events, and a clean commit. It then restarts code-flow and sends a follow-up that must reuse the same OpenCode session and remember a phrase from the first turn. Both code-flow's check and an independent test run must pass. Temporary run logs, commits, and a `receipt.json` remain at the printed evidence path; the server stops automatically. The original project and code-flow settings are unchanged.

This two-turn test passed locally on October 19, 2026 with OpenCode 1.18.30 and `opencode/big-pickle`, including session loading after restart and two committed changes. This establishes compatibility for the observed installation, not every ACP agent or OpenCode release.
