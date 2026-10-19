# ACP coding agents

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
4. Choose **Save connection**. It appears immediately in provider and model selection; no server restart is needed.
5. Select the agent for a run and choose **Full access** in Settings → Run defaults or the composer's permissions controls.

Cline asks for approval before edits and commands by default. Enable **Ask me for tool permissions** in the run's permissions controls and approve requests in the approval inbox. Without it, requests are declined. The preset does not enable Cline's auto-approval flag. Cline starts new ACP sessions in Act mode; read-only code-flow turns still apply the boundaries below. Provider selection stays in the CLI's authentication setup; code-flow's model picker changes the model within that provider.

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

Protocol references: [ACP v1](https://agentclientprotocol.com/protocol/v1/initialization), [session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options). Cline's [native ACP implementation](https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts) advertises both provider and model selectors in the model category; the adapter selects the model control explicitly.

Validation includes process fixtures for streaming, session replay, model selection, permissions, cancellation, failures and timeouts; an engine run that changes a worktree and passes its check; and browser tests covering the Settings lifecycle.

## Real CLI acceptance test

Run the acceptance script explicitly with an installed, authenticated CLI:

```sh
npm run test:acp:live                         # OpenCode (default)
npm run test:acp:live -- --agent kilo
npm run test:acp:live -- --agent cline
```

This is outside the default test suite and consumes normal model usage. Set `CODEFLOW_LIVE_OPENCODE`, `CODEFLOW_LIVE_KILO` or `CODEFLOW_LIVE_CLINE` to an absolute executable path if needed; `CODEFLOW_LIVE_MODEL` optionally selects an advertised model ID. Otherwise the test uses the CLI's discovered default. Missing executables fail before creating a test repository or starting code-flow. Use `--help` for options.

The script creates a temporary repository and a separate code-flow home, saves the connection through the Settings API, and starts a real coding task. It verifies failing baseline tests become passing without test edits, streamed text and tool events, and a clean commit. It then restarts code-flow and sends a follow-up that must reuse the same CLI session and remember a phrase from the first turn. Both code-flow's check and an independent test run must pass. Only reads of the task files and tests, edits to the two task files, and the exact `node --test` command can be approved automatically; unrecognized permission requests stop the test for inspection. Temporary run logs, commits, and a `receipt.json` remain at the printed evidence path; the server stops automatically. The original project and code-flow settings are unchanged.

This two-turn test passed locally on October 19, 2026 with OpenCode 1.18.30 and `opencode/big-pickle`, including session loading after restart and two committed changes. This establishes compatibility for the observed installation, not every ACP agent or OpenCode release.

Kilo and Cline presets are covered by process fixtures and browser Settings tests. Real inference with these two CLIs has not yet been validated; their executables were unavailable in the development environment.
