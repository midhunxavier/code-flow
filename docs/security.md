# Security, subscriptions and caveats

## How code-flow uses your subscriptions

code-flow never handles credentials. Each adapter launches the vendor's **official, unmodified CLI** in headless mode, and that CLI uses the login it already has:

| Agent | Command used | Login | Sandbox / permissions |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | Pro/Max (or API key) via `claude` | read: edit tools disabled, git read-only commands allowed · write: `acceptEdits` + an allow-list of build/test commands (`bypassPermissions` with Full access) |
| Codex | `codex app-server` (JSON-RPC over stdio: `thread/start` or `thread/resume`, `turn/start`, `turn/steer`); `codex exec --json` / `codex exec resume` when app-server isn't available | ChatGPT plan (or API key) via `codex login` | Codex sandbox: `read-only` / `workspace-write` (`danger-full-access` with Full access), approvals off |
| Antigravity | `agy -p --output-format stream-json` | Google AI Pro/Ultra via an interactive `agy` login | `--sandbox` (verified: blocks writes outside the worktree; dropped in write steps with Full access) + `--dangerously-skip-permissions` (see [caveats](#caveats)) |

**Read-only is enforced by code-flow itself, for every agent.** Before a read-only step (plan, review, judge, debate) code-flow snapshots its worktree: the commit, uncommitted changes and untracked files. Afterwards it puts back anything the step changed, including commits, and logs a warning.

This is the boundary each vendor draws for personal use. Don't extend code-flow to read or reuse the CLIs' OAuth tokens; Anthropic and Google both prohibit that, and Google has suspended accounts for it. If you ever turn this into a product for other people, each user must sign in with their own account, and Anthropic's terms then require API keys for products.

> Gemini CLI stopped serving Google AI Pro/Ultra/free personal accounts on 2026-06-18. `agy` is the CLI that serves those plans now.

## The server

- It listens on `127.0.0.1` only, checks the Host and Origin headers, and wants a session cookie or Bearer token on every API call (see [signing in](getting-started.md#signing-in)).
- The first browser to open code-flow signs in without the link only when it connects directly from this machine. A tunnel (ngrok, cloudflared) forwarding to the port can rewrite the Host header to `localhost`, so a request carrying forwarding headers (`X-Forwarded-For`, `Forwarded`…) never signs in that way.
- The phone view and webhooks are only on your network when you turn on *Reachable from my Wi-Fi*, over plain HTTP. See [Automations](automations.md#phone-view).
- That network listener refuses connections from this computer itself, from loopback or any of its own addresses. Programs here, the agents code-flow runs among them, can read `~/.codeflow`, phone secrets included; through the network listener they could otherwise sign in with full control and run commands outside their sandboxes. (Binding it to the Wi-Fi addresses alone wouldn't stop that: a program here can connect to those too.)
- *Full control from my phone* serves the whole app on that network listener, to a phone signed in with the phone link. That link has a secret of its own, apart from the read-only link's, so a read-only link someone saw never becomes a full-control one. The phone's cookie is bound to that address and lasts 30 days; **New link**, or turning off full control, *Reachable from my Wi-Fi* or the phone link, makes new secrets and signs every phone out, and turning it back on doesn't sign them back in. Cross-origin requests are refused there too. Whoever has the link can do everything you can, so treat it like a password. See [Full control from your phone](automations.md#full-control-from-your-phone).
- Webhooks: each automation has its own secret (a Bearer token, or GitHub's signature). A GitHub delivery sent again is ignored, and webhooks start a limited number of runs an hour. See [Webhooks](automations.md#webhooks).

## Running the agents' code

A check runs the agents' code (tests, scripts) on your machine, outside Codex's and agy's sandboxes, as your CI would. With **Full access** the agents themselves run without a sandbox too (see [What agents may do](configuration.md#what-agents-may-do-while-building)). Use code-flow on repos and tasks you trust, or run checks in Docker ([isolation](automations.md#isolation)), or code-flow itself inside a container or VM.

Text from issues, PRs, comments and CI logs is treated as untrusted, and runs started from people outside the repo are locked down. Dependabot's PR descriptions and CI logs are fenced as untrusted text too. **▶ Run app** on a locked-down run asks before it starts that code on your machine. See [Untrusted text](github.md#untrusted-text).

## Caveats

- **agy permissions** (tested with agy 1.3.5): when headless agy hits a tool it isn't allowed to use, it doesn't work around it. The turn ends with an empty answer, which code-flow reports as a failed step that names the denied action. That's why code-flow passes `--dangerously-skip-permissions` together with `--sandbox` by default. The sandbox confines writes to the worktree, and code-flow reverts any changes made during read-only steps. Older agy versions printed nothing when piped; code-flow reports that as an error too.
- Native headless permission prompts remain denied. Auto team members can ask you or another member a structured question, end their turn, and receive an answer on a later turn. This does not grant tool permissions. Codex runs with approvals off (`approvalPolicy: "never"`); if it asks for an approval anyway, code-flow declines.
- **Mid-turn notes are Codex-only, and app-server is experimental.** Mid-turn delivery needs `codex app-server`, which Codex labels experimental (written against codex-cli 0.162). If the installed Codex lacks it, or speaks a protocol this client doesn't, code-flow falls back to `codex exec` and logs that once. It then sticks with exec until the server restarts, so restart code-flow after upgrading Codex. A note is marked delivered as soon as Codex accepts it into the turn. If Codex rejects it (the turn just ended), it goes to the next turn instead. A note for "anyone" goes to a running Codex turn, not to whoever starts next.
- Claude's write mode can run allow-listed commands such as `npm`, `node` and `make`, and those can run arbitrary project scripts. Only run it on repos you trust. Codex is additionally confined by its own sandbox.
- agy needs `--dangerously-skip-permissions` for read-only steps too, so for agy the snapshot-and-restore is what enforces read-only. Changes to gitignored files during a read-only step aren't detected.
- The test-integrity checks catch the common ways to game a check, not every one. A flagged result is a prompt to look, and an unflagged one isn't proof.

Auto team's [memory boundary](auto-team.md#three-memory-scopes) keeps source trust separate from execution permissions. Agent messages cannot authorize actions. Private memory is isolated in context assembly and APIs, not from fully trusted local processes. Untrusted/unknown project-memory proposals require explicit revision approval; source provenance follows derived memories. Deleting a memory removes it and derived memory content from retrieval, but does not delete source run transcripts, provider conversations or backups.

Auto team live collaboration uses a separate loopback bridge and an expiring capability for a single run/member/attempt. The general API token is never delegated. Credentials are kept in mode-0600 temporary files, revoked after the turn and excluded from prompts, logs and arguments. Every mutation rechecks the active assignment and uses runtime-derived provenance. Collaboration does not widen the CLI's existing filesystem or network permissions. Native nested agents are disabled for supported Claude/Codex team turns; unsupported capabilities stay explicit. See [Auto team](auto-team.md#adapter-capabilities).
