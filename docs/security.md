# Security, subscriptions and caveats

## How code-flow uses your subscriptions

code-flow does not read agent login files. Each adapter launches the vendor's **official, unmodified CLI** in headless mode, and that CLI uses its own login. Explicit external integrations and notification destinations use server-side environment credential references; those variables are stripped from child processes and filtered from exports:

| Agent | Command used | Login | Sandbox / permissions |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | Pro/Max (or API key) via `claude` | read: edit tools disabled, git read-only commands allowed (never with `--output`, which writes anywhere, or `--no-index`, which reads anywhere) · write: `acceptEdits` + an allow-list of build/test commands (`bypassPermissions` with Full access) |
| Codex | `codex app-server` (JSON-RPC over stdio: `thread/start` or `thread/resume`, `turn/start`, `turn/steer`); `codex exec --json` / `codex exec resume` when app-server isn't available | ChatGPT plan (or API key) via `codex login` | Codex sandbox: `read-only` / `workspace-write` (`danger-full-access` with Full access); optional one-action approval inbox on supported app-server turns |
| Antigravity | `agy -p --output-format stream-json` | Google AI Pro/Ultra via an interactive `agy` login | `--sandbox` (verified: blocks writes outside the worktree; dropped in write steps with Full access) + `--dangerously-skip-permissions` (see [caveats](#caveats)) |

**Read-only is enforced by code-flow itself, for every agent.** Before a read-only step (plan, review, judge, debate) code-flow snapshots its worktree: the commit, uncommitted changes and untracked files. Afterwards it puts back anything the step changed, including commits, and logs a warning. A side chat's **Ask** is the exception: you may be working in that worktree at the same time, so what changed is named in a warning and left in place.

This is the boundary each vendor draws for personal use. Don't extend code-flow to read or reuse the CLIs' OAuth tokens; Anthropic and Google both prohibit that, and Google has suspended accounts for it. If you ever turn this into a product for other people, each user must sign in with their own account, and Anthropic's terms then require API keys for products.

> Gemini CLI stopped serving Google AI Pro/Ultra/free personal accounts on 2026-06-18. `agy` is the CLI that serves those plans now.

## The server

- It listens on `127.0.0.1` only, checks the Host and Origin headers, and wants a session cookie or Bearer token on every API call (see [signing in](getting-started.md#signing-in)).
- The first browser to open code-flow signs in without the link only when it connects directly from this machine, and only until a browser has signed in (that way, with the link, or with its cookie) or code-flow has started an agent, a check or an app. After that, a program here can't get a session by asking for the page. A tunnel (ngrok, cloudflared) forwarding to the port can rewrite the Host header to `localhost`, so a request carrying forwarding headers (`X-Forwarded-For`, `Forwarded`…) never signs in that way.
- code-flow's pages are never shown inside another page (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so a page elsewhere can't lay them under a decoy and have you click. The side panel's Browser frames your app through its preview, on a port of its own, never code-flow itself.
- Choosing **Wi-Fi · local network** under **Remote access** exposes the phone view and webhooks on your local network. Configure HTTPS through **Set up secure remote access**, using a Tailscale certificate or an imported certificate/key pair. Legacy `CODEFLOW_TLS_CERT` and `CODEFLOW_TLS_KEY` overrides are also supported. Saved keys have owner-only permissions; setup is local-owner-only, validates identity and dates, and revokes pairing when replacing certificates. Invalid or expired saved certificates disable the listener without an HTTP fallback. Full phone control on Wi-Fi requires HTTPS; `CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1` is an explicit development exception. See [Automations](automations.md#phone-view).
- **Tailscale · access anywhere** binds the remote listener only to the IPv4 address reported by the local Tailscale client. Read-only links can use HTTP inside Tailscale's encrypted connection. Full control still requires HTTPS: Tailscale does not stop browsers from sending non-Secure cookies to other HTTP services on the same IP. Non-Tailscale source addresses and this computer's own connections are refused. Missing/disconnected Tailscale and bind errors never fall back to a LAN listener. Code-flow reads Tailscale status and requests a certificate during secure-access setup. It subsequently renews that saved Tailscale certificate automatically for the same verified computer name; renewal never changes the host identity or enables full control. It does not configure the tailnet or enable public access. Switching transports rotates access tokens and invalidates paired sessions; switching to Wi-Fi without TLS disables full control. See [Tailscale setup](automations.md#remote-access-with-tailscale).
- That network listener refuses connections from this computer itself, from loopback or any of its own addresses. Programs here, the agents code-flow runs among them, can read `~/.codeflow`, phone secrets included; through the network listener they could otherwise sign in with full control and run commands outside their sandboxes. (Binding it to the Wi-Fi addresses alone wouldn't stop that: a program here can connect to those too.)
- **Full control from remote devices** signs in with a separate pairing link that expires after ten minutes, including across restarts. Pairing creates a separate 30-day session for each device; only token hashes are stored, TLS cookies are Secure, and individual devices can be revoked. **New link** and disabling remote/full control rotate the generation and invalidate earlier sessions. Cross-origin requests are refused. Paired devices have the owner's full control; this is not a shared-project roles system. See [Full control from your phone](automations.md#full-control-from-your-phone).
- Webhooks: each automation has its own secret (a Bearer token, or GitHub's signature). Secrets live in `~/.codeflow` (webhook secrets in `triggers.json`), which programs running as you can read, the agents included. So text a webhook sends (`details`) reaches the agents fenced as information, not instructions, and its run's reviews aren't learned as lessons. A GitHub delivery sent again is ignored, whatever its delivery id (the signature doesn't cover the id), and webhooks start a limited number of runs an hour. See [Webhooks](automations.md#webhooks).
- The Browser's **Snapshot** loads pages in a headless Chrome on this computer, so it refuses addresses on this computer and link-local ones (where cloud machines keep their metadata service), checking every address a name resolves to. What the page asks for as it loads, redirects included, is checked the same way. The exception is a local app at its `http://localhost:<port>` address, as the Browser shows it, never code-flow's own port. Private network addresses are fine. Not covered: WebSockets, requests from workers, and a name that resolves differently a moment later (DNS rebinding).

## Running the agents' code

Composer Improve uses an empty private Git repository for Quick mode and a bounded
committed snapshot for repository mode. It copies no source Git history, remotes,
hooks, working-copy drafts or executable provider configuration. Cleanup removes
only that private directory and never resets the source checkout. Native Safe/read
permissions remain a CLI boundary rather than an OS filesystem sandbox; filesystem
restrictions block Improve entirely. See [Improve setup and limits](getting-started.md#your-first-run).
App-managed subprocesses use absolute PATH entries, including explicit environment
overrides. On macOS/Linux, an absent or unusable PATH falls back to `/usr/bin:/bin`
so repository-owned tools cannot be selected through the current directory.

Local shared-project accounts grant scoped viewer, reviewer, contributor and
maintainer access through closed shared review and team-board API surfaces. Roles alone do not delegate execution or the owner's phone capability. Separately, the owner can grant per-project host execution to individual contributors through the [host queue](team-collaboration.md#let-teammates-run-tasks-on-the-host). Its dedicated routes accept only task identity and revision, use owner-selected CLIs and limits, and enforce queue ownership and live grants. This is trusted host execution, not an OS sandbox; agents and repository checks retain the host's available authority. Generic owner shell APIs remain unavailable. A separate, default-off [terminal grant](team-collaboration.md#give-trusted-teammates-an-interactive-terminal) permits individual contributors to open their own interactive shell as the host OS user. Project grants determine the starting folder, not a filesystem boundary. Shell users can reach host files, credentials and other processes; only grant this to trusted people. The app enforces session ownership, bounded input/output, live revocation and a 30-minute keyboard idle timeout. Closing a session does not undo changes or reliably stop detached processes.
Browser sessions expire and revoke immediately. Shared-review projections omit raw transcripts, private context and
host paths; explicitly granted terminals return raw output to their creator and can reveal those details. See [shared projects](shared-projects.md).

[Team collaboration](team-collaboration.md) adds a per-machine runner credential
bound to a shared account. It is shown once, stored only as a hash on the team
server, reaches only the team routes and is revoked there in one step; the
owner's own token is matched before a bearer is read as a runner credential, and
the file that holds the credential on a linked computer (`team-link.json`) is
left out of backups like the other credential stores. The team server never
reaches into a teammate's machine: every connection is outbound from that
machine, to the exact address its owner entered (a redirect or an untrusted
certificate is refused), and execution starts only from each computer's own
code-flow, with that person's own CLI logins, in a worktree there. Progress,
checkpoints and discussion are the only things that travel; transcripts, local
paths and copied secret files stay where the run is, and the reasons published
for failed, stopped or lost attempts have local paths replaced by `<local path>`.
Teammates' comments never enter a prompt; an instruction they send to an agent
reaches it only after the task's owner, or a maintainer of its project (the team
server's owner is one everywhere), approves it, and then as a message to the run
attributed to its author; a hand-over checkpoint's context arrives fenced as
information, not instructions.

Custom [filesystem policies](filesystem-policy.md) enforce application reads,
writes and filtered diffs, and pause ordinary code execution globally where its
backend cannot enforce those rules. Saved restrictions are checked before
trusted extension code is imported. [Extensions](extensions.md) are explicit,
version/hash-pinned owner-trusted server code with full process authority, not
untrusted sandboxed plugins.

[SSH workers](remote-workers.md) use provisioned targets, strict host keys,
worker-local credentials and durable private receipts. A disconnected accepted
turn is uncertain; reconnecting does not execute it again. [GitLab/Bitbucket
code workflows](code-hosts.md) require prepared agent containers for fetched PR
code and use exact-ref Git leases for publication. Provider-native approval
policy and PR closure cannot be transacted atomically with a Git push; unknown
policies and unsupported queues fail closed.

A check runs the agents' code (tests, scripts) on your machine, outside Codex's and agy's sandboxes, as your CI would. With **Full access** the agents themselves run without a sandbox too (see [What agents may do](configuration.md#what-agents-may-do-while-building)). Use code-flow on repos and tasks you trust, or run checks in Docker ([isolation](automations.md#isolation)), or code-flow itself inside a container or VM.

Text from issues, PRs, comments and CI logs is treated as untrusted, and runs started from people outside the repo are locked down. Dependabot's PR descriptions and CI logs are fenced as untrusted text too, and so are code scanning messages, which quote the code they flag. **▶ Run app** on a locked-down run asks before it starts that code on your machine. See [Untrusted text](github.md#untrusted-text).

Files copied into worktrees from your checkout (`copy`, e.g. `.env`) never go into the agents' commits, and neither do new files named like secrets. They're never copied through a symlink an agent left in the worktree. See [Per-repo config](configuration.md#per-repo-config).

## Your checkout and the worktrees

A broken worktree is never mistaken for your checkout. Worktrees live inside your repository (`.worktrees/<run>/<name>`), and the `.git` file that ties each one to it is a file in the worktree that any agent can change. Without it, git run in the worktree would find your checkout instead. So code-flow guards its own git:

- code-flow's git in a worktree never reads the worktree's `.git`. It's told the worktree's git folder (`GIT_DIR`, `GIT_WORK_TREE`), which it finds from your repository's side: the folder in your repository's git folder that names the worktree. That holds for everything code-flow runs there, reads included: the Files panel, diffs, status, the test-integrity checks, snapshots. So an agent that points `.git` at a git folder of its own can't bring in its config, whose filter, textconv or external diff code-flow would otherwise run outside the agent's sandbox just by looking.
- Before it changes a worktree (undoing a read-only step, putting back test files, committing, merging, resetting a scratch checkout, removing it, or starting an agent there), code-flow also checks that the worktree's `.git` is still the file git wrote: it points to the worktree's own folder in your repository's git folder, and that folder points back. Before anything that moves a branch (undoing commits, committing, merging), the worktree must be on its run's branch. If any of that fails, the step fails and the run log says what's wrong ("its .git is missing", "it's on another branch…"). Nothing in the worktree or your checkout is changed. Remove the run's worktree, or put its `.git` back, before running it again. The git that then makes the change uses the git folder that was checked, so a `.git` rewritten in between changes nothing.
- code-flow's git never looks above the folder it runs in (`GIT_CEILING_DIRECTORIES`), so a worktree without `.git` is an error, not your checkout.
- code-flow's git runs without `core.fsmonitor` and without hooks, whatever a config file says. Your own hooks still run where you'd expect them: when code-flow merges a result into your checkout, and when it pushes (Git LFS uploads its files in `pre-push`).
- code-flow's diffs never run an external diff program or a textconv filter (`--no-ext-diff --no-textconv`), and a snapshot saves untracked files as they are, without clean filters.
- Not covered: submodules. To tell whether a submodule has changes, git runs itself in the submodule's folder, and that git goes by the `.git` there, which an agent can rewrite too. In a worktree with submodules (or a git repository an agent made inside it and code-flow committed), `git status` and `git add` can still run a filter that the agent's config names. Run untrusted tasks on repositories with submodules in a container or VM.

## Caveats

- **agy permissions** (tested with agy 1.3.5): when headless agy hits a tool it isn't allowed to use, it doesn't work around it. The turn ends with an empty answer, which code-flow reports as a failed step that names the denied action. That's why code-flow passes `--dangerously-skip-permissions` together with `--sandbox` by default. The sandbox confines writes to the worktree, and code-flow reverts any changes made during read-only steps. Older agy versions printed nothing when piped; code-flow reports that as an error too.
- Native permission requests are declined by default. Interactive Codex app-server runs can explicitly enable the one-action approval inbox. Requests expire, are scoped to the active run/step/thread/turn and worktree, and cannot grant session-wide permission or policy amendments. Read-only work cannot gain file writes. Unattended and locked-down source runs never wait for native approvals. Other transports keep their existing denial behavior. Team questions remain separate from tool permissions.
- **Mid-turn notes are Codex-only, and app-server is experimental.** Mid-turn delivery needs `codex app-server`, which Codex labels experimental (written against codex-cli 0.162). If the installed Codex lacks it, or speaks a protocol this client doesn't, code-flow falls back to `codex exec` and logs that once. It then sticks with exec until the server restarts, so restart code-flow after upgrading Codex. A note is marked delivered as soon as Codex accepts it into the turn. If Codex rejects it (the turn just ended), it goes to the next turn instead. A note for "anyone" goes to a running Codex turn, not to whoever starts next.
- Claude's write mode can run allow-listed commands such as `npm`, `node` and `make`, and those can run arbitrary project scripts. Only run it on repos you trust. Codex is additionally confined by its own sandbox.
- agy needs `--dangerously-skip-permissions` for read-only steps too, so for agy the snapshot-and-restore is what enforces read-only. A side chat's **Ask** isn't restored, so what agy changes there stays, and the next **Change** commits it: ask Claude or Codex when that matters. Changes to gitignored files during a read-only step aren't detected.
- The test-integrity checks catch the common ways to game a check, not every one. A flagged result is a prompt to look, and an unflagged one isn't proof.

Auto team's [memory boundary](auto-team.md#three-memory-scopes) keeps source trust separate from execution permissions. Agent messages cannot authorize actions. Private memory is isolated in context assembly and APIs, not from fully trusted local processes. Untrusted/unknown project-memory proposals require explicit revision approval; source provenance follows derived memories. Deleting a memory removes it from retrieval; entries written with it in context keep their own text and inherit its provenance. Deletion does not touch source run transcripts, provider conversations or backups.

Auto team live collaboration uses a separate loopback bridge and an expiring capability for a single run/member/attempt. The general API token is never delegated. Credentials are kept in mode-0600 temporary files, revoked after the turn and excluded from prompts, logs and arguments. Members run as the same user, so a member with a shell could read another member's credential in the brief window before the bridge client deletes it; such a capability is scoped to that member's attempt, never to the application token or to you. Claude turns receive the bridge with `--strict-mcp-config`, so your own and the repository's MCP servers are not loaded in Auto team turns. Every mutation rechecks the active assignment and uses runtime-derived provenance. Collaboration does not widen the CLI's existing filesystem or network permissions. Native nested agents are disabled for supported Claude/Codex team turns; unsupported capabilities stay explicit. See [Auto team](auto-team.md#adapter-capabilities).
