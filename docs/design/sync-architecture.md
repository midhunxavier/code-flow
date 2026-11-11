# Code Flow synchronization and multi-surface UX: final design

Status: proposal, written 2026-11-10 against commit `2d38420`. Nothing here is implemented yet.

This document is the final design from the Auto team brainstorm. It covers how Code Flow keeps its state consistent, and how it should behave, when someone uses it from Claude Code, the Codex CLI, the Claude and Codex desktop apps, a web browser, the Code Flow desktop app, or another computer. It lists what to remove, what to add and what to re-architect, then gives a phased rollout.

## 0. Evidence base

Every recommendation cites at least one audit finding. Each finding was re-checked against the source at the commit above.

**audit-core** (Opus): how state is stored and synchronized.

| ID | Finding | Evidence |
|---|---|---|
| C1 | The desktop app and `codeflow start` always launch their own server. When a CLI-started owner already holds `server.lock`, they wait 20 s and exit with "Another code-flow server…". | `integrations/desktop/main.cjs:86-92`, `bin/launcher.mjs:120-127`, `src/store.ts:550-551`, `src/server.ts:155` |
| C2 | The owner gets a random port on every launch, both from desktop and as a CLI headless owner. Browser storage and the sign-in cookie are keyed by origin, so they stop matching after a relaunch. | `integrations/desktop/main.cjs:20,67`, `src/cli-teams/client.ts:24-32`, `src/server.ts:399` |
| C3 | The owner's lifetime is tied to whichever launcher started it. Quitting desktop stops the owner that CLI sessions are using. The CLI then waits up to 60 s and starts a new owner on another port. | `src/server.ts:3275` (the audit cited `:3270`, which has drifted), `src/cli-teams/client.ts:58-72` |
| C4 | Project auto-create checks `forRepo` outside the projects mutex and matches repo paths as exact strings. Concurrent sessions, or a git worktree, can therefore create duplicate projects. | `src/cli-teams/workspace.ts:23-25`, `src/projects.ts:166-177` |
| C5 | Each CLI task is stored three times (CLI control journal, then task conversation, then chat) and reconciled only at the next startup. | `src/cli-teams/workspace.ts:28-31`, `src/cli-teams/service.ts:67-73`, `src/cli-teams/service.ts:24`, `src/conversational/service.ts:17`, `src/conversational/chats.ts:25` |
| C6 | `init` and `desktop --hosts codex-app` both register Code Flow in the same Codex config. Team preferences live in browser localStorage, in `~/.codeflow`, and in the repo's `.codeflow/cli-teams.json`. | `src/cli-teams/install.ts:69-73`, `src/cli-teams/desktop.ts:51,61`, `ui/task-team.tsx:28,45`, `src/cli-teams/service.ts:310` |
| C7 | Live updates are inconsistent. Chats send only a "changed" signal, followed by a full refetch, with 15–30 s polling on top. Several panels open their own EventSource outside the shared hub. | `src/conversational/chats.ts:574-580`, `src/server.ts:1402`, `ui/team-terminals.tsx:86`, `ui/main.tsx:126`, `ui/chat-state.ts:39` |
| C8 | Removal candidates: the legacy per-feature SSE endpoints, the full-replay `run` topic and the `legacy` team connection id. | `src/server.ts:2060-2063`, `src/collab/connections.ts:34` |

The longer first audit-core submission also recorded three more items, used below as C9–C11:

- **C9.** The chat and task journals grow without bound and are read whole at startup (`src/conversational/chats.ts:73-77`, `src/store.ts:332-352`).
- **C10.** "Handoff" names four unrelated things: `src/chat-handoff.ts`, `src/cli-teams/handoff.ts`, the team task handover (`src/collab/hub-client.ts:40-41`) and the browser workspace ticket (`src/server.ts:1604`).
- **C11.** Browser-only preferences sit in localStorage (`ui/lib.ts:109-136`).

**audit-surfaces** (Sol): how each surface behaves.

| ID | Finding | Evidence |
|---|---|---|
| S1 | WSL desktop keeps its store at `~/.codeflow-desktop/<installation-id>/state`. Docker desktop keeps it in a home volume keyed by installation and workspace. Neither is the native `~/.codeflow`, so "same computer" does not mean "same state". | `integrations/desktop/wsl/runner.cjs:9,47`, `integrations/desktop/docker.cjs:20`, `integrations/desktop/main.cjs:16` |
| S2 | Claude Desktop Code-mode retrieval is documented as failing (`runtime_unavailable: fetch failed`) even though a separate backend read succeeded. `doctor` checks configuration only, and automatic Claude Desktop setup supports macOS only. | `docs/desktop-mcp.md:97,134`, `src/cli-teams/desktop.ts:43` |
| S3 | Codex CLI inherits the repository-pinned desktop connections next to its own `codeflow` entry. Only the `codeflow terminal` wrapper masks them. | `docs/desktop-mcp.md:66`, `src/cli-teams/terminal.ts:4-10`, `src/cli-teams/desktop.ts:51` |
| S4 | Native approval forms depend on the host's elicitation capability and time out after 5 minutes. The browser approval ticket deliberately cannot sign anyone in, which contradicts the "Single-use sign-in link" comment, so a cold browser hits a sign-in wall. | `src/cli-teams/mcp.ts:49-56,94-95`, `src/server.ts:3084`, `src/server.ts:1616-1619` |
| S5 | Reconnecting creates a fresh connection, but assignments stay bound to the previous host connection. | `src/cli-teams/client.ts:57-72`, `src/cli-teams/service.ts:564` |
| S6 | CLI follow depends on cursors the assistant has to keep, while the browser stream already reconnects with resume. | `src/cli-teams/service.ts:553-554`, `ui/stream.ts:157-170` |
| S7 | Task UI steering classifies messages with a regex, and web operations exclude applying a handoff. | `ui/task-conversation.tsx:198-202`, `src/cli-teams/service.ts:297` |
| S8 | Implicit CLI routing picks the first matching project, and device handoffs ask for an explicit clone destination every time. | `src/projects.ts:165-168`, `ui/collab-task.tsx:139-140` |

Sol also asked that the existing safeguards be kept: exact-revision (hash-pinned) acceptance, idempotent mutations, clean-checkout apply, repository isolation, and stream replay safety. Every change below has to respect them.

## 1. Goals and principles

**Goals**

1. A person can start, approve, follow, steer and apply a task from any supported surface. Every other surface connected to the *same store* then shows it within about a second, with no manual refresh.
2. No surface fails because another surface happens to be running (C1). No surface silently stops work another surface started (C3).
3. Every surface tells the user which state it is looking at, so "missing" history is never a surprise (S1).
4. Integration states are reported truthfully: a host is "supported" only once it has passed a native end-to-end check (S2).

**Principles**

- **P1. One store, one owner, many clients.** A *store* is a `CODEFLOW_HOME` directory. Exactly one owner process serves it, which `server.lock` already enforces (`src/store.ts:550`). Every surface is a client of that owner, and none spawns a second one.
- **P2. Server-side state is the source of truth.** The browser keeps only ephemeral UI state, such as scroll position and which panel is open. Preferences, drafts and trust settings move to the owner (C6, C11).
- **P3. One record per concept.** A task, preference or project is stored once. Other views derive from it; they are not mirrored copies (C5, C6).
- **P4. One event feed with resumable cursors** is shared by the browser, desktop and CLI follow. Polling is a fallback only while the feed is down (C7, S6).
- **P5. Stores have explicit identity, and there is no implicit cross-store sync.** WSL, Docker, remote and other-machine stores are *different stores*. Reaching one from another is an explicit binding that the user can see (S1, team contract). We do not promise that every surface on one machine syncs automatically.
- **P6. Approval is pinned to a revision and never mints a session.** Recovering from an expired or missed approval goes through the normal sign-in and then returns to the same revision (S4).
- **P7. Repositories have a logical identity**, separate from how a path is spelled (C4, S8).
- **P8. Words name one thing.** "Handoff" is retired as an umbrella term (C10).

## 2. Today, in one paragraph

Durable state lives in a store (`~/.codeflow` by default): run logs and journals, `projects.json`, three conversation journals, team/runner directories and preference files. The browser and desktop share one SSE hub, `/api/stream` (`src/server.ts:1402`), across tabs (`ui/stream.ts`), with polling as a backstop. CLI and MCP hosts find the owner through `cli-teams-runtime.json` and use a loopback bearer transport. If no owner is running, they spawn a detached headless one (`src/cli-teams/client.ts:24-37`). Desktop and `codeflow start` skip that discovery entirely (C1). Native desktop uses `~/.codeflow`, but WSL and Docker desktop use their own stores (S1). Machines connect only through the team hub and its runners (`src/collab/runner.ts:588`).

## 3. Target architecture

### 3.1 Store identity and the owner descriptor

Each store gets a **store record**, `store.json`, written once at creation. It holds a random `storeId`, a display name, the creation time and an *environment* tag:

- `native-macos`, `native-linux` or `native-windows`
- `wsl:<distro>`
- `docker:<installation>/<workspace-hash>`
- `remote:<host>`

The owner publishes one **owner descriptor**, extending the existing `cli-teams-runtime.json` (`src/cli-teams/client.ts:17-22`):

- the `storeId` and environment
- a stable `origin` (§3.3)
- the PID and a protocol version
- the bootstrap credential, which already exists
- a `startedBy` field (`desktop`, `cli`, `start` or `service`) and a `lifetime` field (`service` or `attached`)

Every surface shows the store name and environment in a persistent indicator: the browser header, the desktop title bar and tray, and a CLI status line or `codeflow status`. A click (or `codeflow status`) shows the full identity: store path, environment, owner PID, origin and who started it. This is the UX answer to S1: when a different environment shows different history, the indicator says so up front.

> Update, 2026-11-10: the browser header indicator was removed again at the owner's request, to keep the top bar clear. The browser no longer shows the store; `GET /api/store` still reports the full identity. The desktop and CLI parts of this section stand.

### 3.2 Attach-or-start, for every entry point

There is one discovery routine, extracted from `connectRuntime` (`src/cli-teams/client.ts:56-72`) and shared by desktop (`integrations/desktop/main.cjs:66-92`), `codeflow start` (`bin/launcher.mjs:120-127`), and `codeflow mcp`/`terminal`:

1. Read the descriptor and check that the PID is alive and the protocol is compatible. If it is, **attach**: open the window or browser at the descriptor's origin.
2. If no descriptor exists, take the lock (`acquireLock` already arbitrates simultaneous starts, as noted in the `src/cli-teams/client.ts` header comment) and start the owner as a **service** (§3.4).
3. If the descriptor is incompatible (an older version), use the existing managed handover (`src/server.ts:3308-3312`) instead of failing.

The "Another code-flow server…" error (C1) then becomes unreachable in normal use. It stays only as a last-resort diagnostic, with a "Connect to it" action.

### 3.3 Stable origin and session

- Each store gets a **stable port**, chosen once, stored in `store.json` and reused (default 4317, as in `bin/launcher.mjs:27`; on a collision, pick a port and persist it). This fixes the origin-keyed cookie (`src/server.ts:399`), and localStorage (`ui/lib.ts:109`) (C2).
- The owner token persists for the store's lifetime instead of being regenerated on each desktop launch (`integrations/desktop/main.cjs:20`). It is rotated only on explicit sign-out or reset.

### 3.4 Owner lifetime separate from windows

- The owner runs as a **service** with `lifetime: service`. It is not a child that dies on `disconnect` (`src/server.ts:3275`). Desktop becomes a client with a tray. It already has one (`integrations/desktop/main.cjs:160-166`) and a running-agents check on quit (`main.cjs:172-185`).
- Quitting the desktop window closes the client only. A separate, explicit **Stop Code Flow service** action stops the owner. Before it does, it lists running work grouped by the surface that started it ("2 runs started from Claude Code"). The existing "Agents are still working" dialog is kept, scoped to that action.
- An idle owner with no clients and no running work may exit after a configurable idle period, using the existing managed-handover path. The next client restarts it through §3.2 on the same port.

### 3.5 Single source of truth for data

- **Projects:** `projects.resolveRepo(path)` runs *inside* the projects mutex (`src/projects.ts:160-177`). It canonicalizes with `realpath` and the git common dir, so a worktree maps to its main repo's project. It returns the repo's **default project**, not "the first match" (`src/projects.ts:165`). `workspace.ts:23-25` calls only this (C4, S8).
- **CLI tasks:** one task record, the task conversation. The CLI control state becomes the *CLI session view* of it (connection, host binding, cursors), and the chat becomes a *projection* that is computed, not written separately. This removes the startup-only `reconcileWorkspace` repair (`src/cli-teams/service.ts:67-73`, C5). If a full merge is too large for one phase, the interim is one transactional write path plus continuous reconciliation on every `sync` (`workspace.ts:28-31`).
- **Preferences and drafts:** a server-side `preferences` record with three scopes, *user* (store), *project*, and *repository* (the committed `.codeflow/cli-teams.json`). Resolution is explicit: the repo file supplies team defaults, and user and project overrides apply on top. The browser's `taskTeamPreferences`, `roleSel`, trust and `interactiveApprovals` move there (C6, C11). Drafts are stored per chat on the owner, so a draft started in the browser is still there in desktop.
- **Journals:** chat and task journals are compacted (snapshot plus tail) so startup reads stay bounded (C9).

### 3.6 Sync and event protocol

There is one feed per store. It is an evolution of `/api/stream` (`src/server.ts:1402-1556`).

- **Events carry deltas.** Each entity change emits `{topic, entityId, revision, op, patch | snapshot}`. Chats move from the "changed" signal plus refetch (`src/conversational/chats.ts:574-580`) to deltas (C7).
- **Cursors** use the store-wide `generation:sequence` format that chats already use (`chats.ts:580`). Clients resume with their last cursor. If the server has compacted past it, it replies `reset`, the client reloads a snapshot, and then it continues from there.
- **Every client uses the same feed.** The browser and desktop already do through the hub (`ui/stream.ts`). Terminals and other panels become topics on the shared stream instead of their own EventSource (`ui/team-terminals.tsx:86`, C7). CLI and MCP follow become a **server-held subscription**: the client holds a subscription id, the owner keeps the cursor, and `codeflow_get_run` with `follow` resumes from it. This replaces the assistant-retained cursors (`src/cli-teams/service.ts:553-554`, S6). Unread results get a receipt, so a missed final result appears once on the next call from any surface.
- **Polling** (`ui/main.tsx:126`, `ui/chat-state.ts:39`, `ui/state.ts:1172`) runs only while the feed is in `reconnecting` or `offline`.
- **Mutations** keep the existing idempotency keys and revision checks. Each response includes the cursor at which the change is visible, so the acting surface can wait for its own echo instead of refetching.

### 3.7 Reconnection and ownership fencing

- Every client runs the same connection state machine: `connected`, then `reconnecting` (with backoff, which the browser already has at `ui/stream.ts:163-170`), then `offline`, plus a separate `replaced` state for when a newer owner took over. The CLI version reuses `connectRuntime`'s 60 s successor wait (`src/cli-teams/client.ts:58-72`).
- **Host-bound assignments carry a lease epoch.** When a CLI session reconnects under a new connection id, it presents its prior binding token. The owner moves the binding (`state.hostConnection`, `src/cli-teams/service.ts:564`) and bumps the epoch, and outputs from the stale epoch are rejected (fencing). If a host never returns, the run shows "Waiting for Claude Code session to reconnect" with **Reassign to managed agent** and **Cancel** actions. The run does not hang silently (S5).
- When the client could not tell whether a mutation landed, it re-asks the owner using the idempotency key before retrying. The existing `unsent` and `gone` split (`client.ts:41-48`) stays as the transport-level rule.

### 3.8 Identity, auth and approval

- **One owner session per store and origin.** Because the origin is stable (§3.3), browser and desktop sign-ins last across restarts.
- **Approvals get a durable destination.** Each proposal revision has a stable URL, `/approve/<proposalId>@<revisionHash>`, valid until the proposal changes or expires. It is not a 10-minute ticket (`src/server.ts:3085`). A browser that is not signed in follows the normal sign-in and then returns to that exact revision. The approval link still never signs anyone in (`src/server.ts:1618`). The contradictory comment in `src/cli-teams/mcp.ts:56` gets corrected (S4).
- **When a native form times out** (`mcp.ts:49`), the proposal stays approvable. The timeout message offers the durable link and `codeflow open <id>` instead of telling the user to check the shared task.
- **Approval is surface-neutral.** An approval made in any surface on the same store resolves the pending native prompt in every other surface, using the existing `settle` path in `mcp.ts:48`.

### 3.9 One MCP connection per provider

- One user-level `codeflow` MCP entry per provider config (`src/cli-teams/install.ts:67-73`). The repository is chosen **per conversation**, from the host's roots or working directory when the host supplies one; otherwise the user picks it, and every proposal card shows it clearly ("Repository: …/code-flow (main)").
- For Codex, the repo-pinned `codeflow-<repo>-<hash>` entries (`src/cli-teams/desktop.ts:51,61`) are no longer needed and get migrated away. Removal uses the existing ownership records and preserves any entry the user modified (`docs/desktop-mcp.md`, "Setup refuses to overwrite…"). Afterwards `codeflow terminal`'s masking (`src/cli-teams/terminal.ts:4-10`) is unnecessary (S3, C6).
- **Integration status is tiered.** Instead of `doctor`'s single "configured" level (`docs/desktop-mcp.md:97`), each host reports `configured`, then `discovered` (the host listed the tools), then `connected` (the bridge reached the owner), then `authenticated`, then `verified` (a native propose, decline, start, follow and result check passed). The Integrations page shows the highest level reached and the next step (S2).

### 3.10 Cross-environment and cross-machine binding

Per the team contract and S1, separate stores stay separate unless the user binds them.

- **Environment switcher.** Desktop and the browser list the stores they know: native, WSL distros, Docker workspaces, remote hosts, and linked hubs. Each entry shows its environment tag and `storeId`. Switching between them is explicit, and each window shows one store at a time.
- **WSL bridge.** The WSL desktop backend publishes its owner descriptor at a path the user can bind to. `codeflow connect --store <id>` inside the same distro points that CLI at the desktop's store, instead of the default `~/.codeflow` it would otherwise use (`integrations/desktop/wsl/runner.cjs:47`). The alternative is an opt-in setting that makes the WSL desktop use the distro's `~/.codeflow`. Either way, the binding is recorded and shown in the identity indicator.
- **Docker** stays isolated by design: each workspace gets a volume (`integrations/desktop/docker.cjs:20`). The UI labels it "Isolated container store, not shared with your CLI". Moving work in or out uses team handovers or export, not shared files.
- **Other machines** stay on the team hub, linked runners and task handovers (`src/collab/runner.ts:588`). The hub adds a **logical repository identity**: the normalized remote URL plus root commit. Each device stores its own clone path for that identity once, so accepting or fetching a handover pre-fills the path (`ui/collab-task.tsx:139-140`, S8).

### 3.11 Steering and apply parity

- One **intent endpoint** on the owner classifies a steering message as control, status question or change request. The browser, desktop and CLI all use it, replacing the browser-side regex (`ui/task-conversation.tsx:198-202`). The UI shows the classification it applied, and the user can override it with one click (S7).
- **Applying a result to a checkout** joins the web operations (`src/cli-teams/service.ts:297`). It stays hash-pinned and requires a clean checkout, and it runs on the owner against a local repo path, so any surface on the same store can apply (S7).

### 3.12 Vocabulary

"Handoff" is split into four distinct names (C10):

- **Chat context import:** `src/chat-handoff.ts`
- **Apply to checkout:** `src/cli-teams/handoff.ts`, transport `/handoff-*`
- **Team handover:** `src/collab/hub-client.ts:40-41`
- **Open in browser link:** `src/server.ts:1604`

The UI copy, docs and new APIs use these names. The old routes stay as aliases for one release.

## 4. Remove

| # | Remove | Why | Evidence | Replacement |
|---|---|---|---|---|
| R-1 | Unconditional server spawn in desktop and `codeflow start` | It collides with a running owner and fails after 20 s | C1: `integrations/desktop/main.cjs:86-92`, `bin/launcher.mjs:120-127` | Attach-or-start (§3.2) |
| R-2 | Random per-launch port and per-launch desktop token | They split cookies and localStorage | C2: `main.cjs:20,67`, `client.ts:24-32` | Stable port and token per store (§3.3) |
| R-3 | Owner stopping when the launcher disconnects | Quitting desktop kills CLI-started work | C3: `src/server.ts:3275` | Service lifetime (§3.4) |
| R-4 | Per-repo `codeflow-<repo>-<hash>` Codex entries, and in time the `codeflow terminal` masking | They duplicate tool sets and risk the wrong repo | C6, S3: `desktop.ts:51,61`, `terminal.ts:4-10` | One broker entry with per-conversation repo selection (§3.9) |
| R-5 | Startup-only `reconcileWorkspace` mirror repair, and in time the separate chat copy of CLI tasks | Three stores drift apart | C5: `service.ts:67-73`, `workspace.ts:28-31` | One task record plus projections (§3.5) |
| R-6 | Browser-only `taskTeamPreferences`, `roleSel`, trust and `interactiveApprovals` in localStorage | They are invisible to other surfaces and lost when the origin changes | C6, C11: `ui/task-team.tsx:28,45`, `ui/lib.ts:109-136` | Server-side preferences (§3.5) |
| R-7 | Legacy SSE endpoints `/api/events`, `/api/runs/:id/events` and `/api/shell/:id/events` | They duplicate the hub and use up browser connection slots | C8: `src/server.ts:2060-2063` | Hub topics (§3.6) |
| R-8 | Full-replay `run` topic | Kept only for older SSH hosts | C8: `ui/run-feed.ts:85-87`, `src/server.ts:1499-1529` | Cursor-based `run-page` and deltas, after a version gate for SSH hosts |
| R-9 | Per-panel EventSources (terminals, interactive browser, shared events) | They bypass the shared hub | C7: `ui/team-terminals.tsx:86` | Hub topics (§3.6) |
| R-10 | Chat "changed" signal plus full refetch, and steady-state polling | Slow, wasteful and inconsistent | C7: `chats.ts:574-580`, `ui/main.tsx:126` | Delta events; polling only while offline |
| R-11 | `legacy` team connection id sharing the `team-link` dir | A migration leftover that makes runner journals ambiguous | C8: `src/collab/connections.ts:34` | Migrate it into `team-runners/<id>` |
| R-12 | "Handoff" as an umbrella term in UI and docs | It names four unrelated things | C10 | The names in §3.12 |
| R-13 | Blanket "everything on one machine shares one store" claims in docs and help | False for WSL and Docker | S1 | Capability-aware wording and the identity indicator |
| R-14 | Regex steering classification in the browser | It disagrees with other surfaces and misreads messages | S7: `ui/task-conversation.tsx:198-202` | Server intent endpoint (§3.11) |
| R-15 | "Single-use sign-in link" comment and copy | It contradicts how the server behaves | S4: `mcp.ts:56` vs `server.ts:3084,1618` | Accurate copy and the durable approval link |

## 5. Add

| # | Add | Why | Evidence |
|---|---|---|---|
| A-1 | `store.json` with `storeId` and environment, plus the extended owner descriptor (`startedBy`, `lifetime`, `origin`) | The foundation for identity, attaching and bridging | S1, C1 |
| A-2 | Store and environment indicator on every surface, and `codeflow status` | Users can see which state they are in | S1, C2 |
| A-3 | Shared attach-or-start library used by desktop, `start`, CLI and MCP | One way to find the owner | C1, C3 |
| A-4 | Owner service mode, a tray "Stop service" action with runs grouped by origin, and idle exit | Owner lifetime separate from any one window | C3; existing dialog `main.cjs:172-185` |
| A-5 | Atomic `resolveRepo` with realpath and git-common-dir canonicalization, plus a per-repo default project | Ends duplicate projects and "first match" routing | C4, S8 |
| A-6 | Server-side preferences with user, project and repo scopes, and per-chat drafts | Consistent settings everywhere | C6, C11 |
| A-7 | Delta events and resumable cursors on `/api/stream`, with `reset` handling for compacted history | Live, consistent updates | C7 |
| A-8 | Server-held follow subscriptions and unread-result receipts for CLI and MCP | Durable follow | S6 |
| A-9 | Lease epochs and rebinding for host-bound assignments, plus a "waiting for host" state with Reassign and Cancel | Recovery after reconnecting | S5 |
| A-10 | Durable, revision-pinned approval URL with sign-in recovery and return | Approvals survive timeouts and cold browsers | S4 |
| A-11 | Tiered integration status (configured, discovered, connected, authenticated, verified) and a native smoke command | Truthful host support | S2 |
| A-12 | Explicit store binding: an environment switcher and `codeflow connect --store`, with the WSL bridge | Cross-environment use without false promises | S1, team contract |
| A-13 | Logical repository identity on the hub, with per-device clone mappings | Handovers without retyping paths | S8 |
| A-14 | Owner intent endpoint for steering, and browser and desktop "Apply to checkout" | Parity across surfaces | S7 |
| A-15 | Journal compaction (snapshot plus tail) | Bounded startup | C9 |

## 6. Re-architect

| # | Area | From | To | Evidence |
|---|---|---|---|---|
| X-1 | Owner process model | Whoever launches it owns it, on a random port, and it dies with its parent | A per-store service on a stable origin; all surfaces are clients | C1–C3 |
| X-2 | CLI task data model | CLI journal, task and chat mirrored, repaired at startup | One task record; CLI session and chat are views | C5 |
| X-3 | Live sync | Signal plus refetch, polling, extra EventSources | One delta feed with cursors; polling only offline | C7, S6 |
| X-4 | MCP topology | A user entry plus per-repo entries, masked by a wrapper | One broker per provider with per-conversation repository scope | C6, S3 |
| X-5 | Approval flow | Native form or 10-minute ticket, 5-minute timeout | Revision-pinned approval that works from any surface on the same store | S4 |
| X-6 | Host binding | Fixed to the connection id | Leased binding with fencing and rebinding | S5 |
| X-7 | Project resolution | Exact path, first match, outside the lock | Canonical repo identity, default project, inside the lock | C4, S8 |
| X-8 | Environment model | Implicit store per launcher (native, WSL or Docker) | Named stores with explicit bindings | S1 |

## 7. Per-surface UX expectations

Each surface answers the same five questions the same way: *Which store am I on? Is it live? What needs me? How do I approve? How do I get the result into my checkout?*

**Claude Code CLI**
- After `codeflow init`, it attaches to the running owner or starts it as a service. It never fails because desktop is open (A-3).
- The proposal card shows the repository, the project and the store name.
- Approval uses the native form when the host supports elicitation (`mcp.ts:94-95`); otherwise it gives the durable approval link. A timeout never loses the proposal (A-10).
- Follow resumes on its own after the computer sleeps or the owner updates (A-8). If the session drops while it is the host, the run shows "waiting for host", and the next session can take it over (A-9).
- `codeflow status` prints the store, environment, origin and owner.

**Codex CLI**
- Same as Claude Code.
- After migration (A-4/R-4) there is exactly one `codeflow` tool set, so plain `codex` and `codeflow terminal codex` behave the same.

**Claude Desktop app**
- Supported only at the tier it has actually reached (A-11). Today the Integrations page should show "configured, discovered; result retrieval not verified" (S2), not "connected".
- On Windows, the page explains that automatic setup is macOS-only (`desktop.ts:43`) and offers the manual steps.
- The repository is chosen per conversation and confirmed on each proposal card.

**Codex desktop app**
- Same broker entry as Codex CLI.
- Its verified tier is shown. Read tools are documented as working (`docs/desktop-mcp.md:134`); propose, approve and result need the native check.

**Web browser**
- Opens at the store's stable origin; sign-in persists.
- Header shows the store and environment. The connection pill shows `connected`, `reconnecting` or `offline`, and polling only runs while it is not `connected`.
- Drafts and team preferences follow the user into desktop and CLI-launched views (A-6).
- Approvals made here clear native prompts in CLI sessions on the same store.
- "Apply to checkout" is available (A-14).
- A run started from another surface on the same store appears within a second (A-7).

**Code Flow desktop, macOS and Linux native**
- A client of the native `~/.codeflow` store. Opening it while a CLI owner runs simply attaches (A-3).
- Closing the window keeps the service running. The tray shows running work. "Stop service" warns with runs grouped by origin (A-4).

**Code Flow desktop, Windows (WSL backend)**
- The title bar and indicator show `wsl:<distro>` and say it is not the same store as a CLI in that distro unless bound.
- The first run offers "Use this distro's Code Flow store" or "Keep separate" (A-12).
- The CLI in the distro can bind with `codeflow connect --store`.

**Code Flow desktop, Docker mode**
- Labeled "Isolated container store for <workspace>".
- Changing workspace folders shows a store switch, not lost history (S1).
- Work moves in or out only through team handovers.

**Another computer, team hub**
- The task shows its logical repository. Accepting or fetching a handover pre-fills the clone path saved for this device (A-13).
- The UI calls it a "team handover" (§3.12), never just a "handoff".

## 8. Reconciled disagreements and corrections

1. **"One machine, one store" versus S1.** The earlier chat summary (in the attached handoff) said every entry point on one machine shares `~/.codeflow`. audit-core treated Docker as the only exception (C11 in its long form). Sol showed that WSL is separate too (`wsl/runner.cjs:9,47`). **Resolution:** the design adopts S1 and the team contract. Stores are named, and binding them is explicit. No same-machine auto-sync is promised (P5, §3.10).
2. **Fixing duplicate Codex entries.** audit-core proposed deleting the per-repo codex-app entries (C6). Sol proposed one broker with explicit repository selection while preserving modified entries (S3). **Resolution:** both, in order. First add per-conversation repo selection to the broker, then migrate the per-repo entries through ownership records and leave any modified entries in place (X-4).
3. **Quit behaviour.** C3 says quitting desktop stops the owner. Re-reading the code shows desktop already warns when agents are running (`main.cjs:172-185`). **Resolution:** the warning is real but does not solve the problem. Its only choices are to keep the window or to stop everything, including CLI-started work. The design keeps the dialog but moves it to the explicit "Stop service" action (A-4).
4. **Line drift.** C3 cited `src/server.ts:3270`; the disconnect handler is at `src/server.ts:3275` in this checkout.
5. **Reconnection.** audit-core saw transport reconnection as handled (`client.ts:58-72`). Sol found that run state still points at the old connection (S5). **Resolution:** both are true at different layers. Transport recovery stays as it is, and lease rebinding is added at the run layer (§3.7).
6. **The approval link comment.** `mcp.ts:56` says "Single-use sign-in link", but `server.ts:3084` and `:1618` make it never a sign-in. **Resolution:** keep the server behaviour, which is the security property Sol asked to preserve, and fix the copy (R-15, A-10).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Moving to a service changes process ownership. Orphaned owners could keep running unexpectedly. | Idle exit, a visible tray item, `codeflow status`/`codeflow stop`, and the existing PID-checked lock |
| A stable port collides with another app | Persist a fallback port per store, and always discover through the descriptor, never a hard-coded port |
| Migrating Codex entries could break user-edited configs | Remove only entries matching the ownership records; report modified ones (`docs/desktop-mcp.md` setup rules) |
| Merging the task model (X-2) is large and touches three journals | Ship the interim transactional sync first, then migrate behind a store version with a backup |
| Delta events can diverge from snapshots | Each event carries the entity revision; clients reload a snapshot on any revision gap or `reset` |
| Durable approval URLs make proposals reachable for longer | Revision-pinned, owner-session-gated, no session minting, revoked on change or cancel |
| Binding WSL to the distro store could expose Windows-side credentials | Binding is opt-in, scoped to the store, and listed in the indicator |
| Native host behaviour changes between provider releases (S2) | Tiered status is re-verified per host version; the smoke check is part of releases |
| Moving localStorage preferences to the server loses existing values | A one-time import from localStorage on first load at the stable origin |

## 10. Phased rollout

Each phase can ship on its own and has observable acceptance signals.

**Phase 0: be truthful (small, immediate)**
- Work: A-1 (`store.json` and descriptor fields), A-2 (indicator, `codeflow status`), A-11 (tiered integration status), R-13 (docs wording), R-15 (approval copy), and the vocabulary in §3.12 for new UI copy.
- Acceptance:
  - Every surface shows the store name and environment.
  - WSL and Docker desktop say "separate store".
  - The Integrations page shows Claude Desktop at "discovered", not "connected".
  - No doc claims universal same-machine sync.

**Phase 1: one owner per store**
- Work: A-3 (attach-or-start), R-1, R-2 (stable port and token), A-4 and R-3 (service lifetime).
- Acceptance:
  - Starting a CLI task, then opening desktop, then `codeflow start` gives one owner PID, and no "Another code-flow server" error appears.
  - Quitting the desktop window leaves a CLI-started run `running`.
  - A relaunch keeps the same origin, sign-in and drafts.
  - An e2e test covers CLI-first, desktop-first and simultaneous starts.

**Phase 2: one record per concept**
- Work: A-5 (atomic `resolveRepo` and default project), A-6 and R-6 (server-side preferences and drafts, with the localStorage import), X-2 interim (transactional sync, R-5 startup repair retired), then the full task-model merge; A-15 compaction.
- Acceptance:
  - Ten concurrent CLI sessions in one repo, plus one worktree, produce exactly one project.
  - A team preference set in the CLI shows in the browser and the reverse.
  - Killing the owner in the middle of `sync` leaves no divergent task or chat after restart, without relying on startup repair.
  - Startup time stays flat as chat history grows.

**Phase 3: live, resumable, recoverable**
- Work: A-7 and R-10 (delta feed), R-7 and R-9 (legacy endpoints and per-panel streams retired), A-8 (server-held follow), A-9 (lease rebinding), A-10 (durable approvals), A-14 (intent endpoint and browser apply), R-14.
- Acceptance:
  - A change made on one surface appears on another within 1 s, with no polling requests while connected.
  - CLI follow survives sleep and an owner update with no lost or duplicated output.
  - A host session that reconnects keeps its assignments, and stale-epoch output is rejected.
  - A native approval that timed out can still be approved from the link after sign-in.
  - Approving in the browser clears the CLI prompt.
  - The axe e2e count stays at 0.

**Phase 4: one MCP entry and explicit bindings**
- Work: X-4 and R-4 (broker with per-conversation repo selection, then Codex entry migration), A-12 (environment switcher, `codeflow connect --store`, WSL bridge), A-13 (logical repo identity and device mappings), R-11 (`legacy` connection migration), R-8 (full-replay topic removed behind an SSH host version gate).
- Acceptance:
  - `codex mcp list` shows one Code Flow entry, with modified user entries preserved.
  - A CLI in WSL bound to the desktop store sees desktop runs. Unbound, the indicator says "separate".
  - Accepting a team handover on a device that has mapped the repo needs no path input.
  - Claude Desktop and Codex desktop each reach the `verified` tier, or keep their lower tier on display.

## 11. Open questions and decisions

1. **The WSL default.** Should WSL desktop bind to the distro's `~/.codeflow` by default (simpler; one store per distro) or stay isolated with an opt-in bridge (safer; matches today's per-installation intent at `wsl/runner.cjs:9`)? This design recommends opt-in for the first release.
2. **Claude Desktop repo selection.** Claude Desktop may not expose a working directory or roots per conversation. If it doesn't, does it keep a repo-pinned entry as a documented exception to X-4?
3. **Service mechanism.** Should the owner be a detached process (as the CLI does today, `client.ts:32-33`) or register with the OS (launchd or systemd user unit, Windows task)? The second survives logout but needs installer work.
4. **Full replay and SSH hosts.** What minimum SSH-host version allows removing the full-replay `run` topic (R-8), and how is it detected?
5. **Store precedence for preferences.** When a committed `.codeflow/cli-teams.json` and a user override disagree, should the UI show the conflict, or should the user value win silently?
6. **The Claude Desktop root cause.** The documented Code-mode failure (S2) has not been reproduced in this audit. Its root cause (host networking, sandbox or bridge) decides whether Phase 4 can reach `verified` for Claude Desktop.

### Decisions

1. Keep WSL stores separate by default; bridging is opt-in.
2. If Claude Desktop exposes no roots, retain a repo-pinned entry as a documented exception to the broker rule.
3. Run the owner as a detached process; do not register an OS service in this round.
4. Retain the full-replay `run` topic only for SSH hosts reporting a protocol version below the version introduced by store identity; use the reported protocol version as the gate.
5. Preferences resolve in order: repo defaults, then project, then user override. Show differing values in the UI.
6. The Claude Desktop failure's root cause remains unverified. Keep its lower integration tier until a native smoke check verifies it.

---

This design is prose only. It changes no code, so it ships without a fail-to-pass test. Integration, configured checks and independent review are owned by the Code Flow engine.
