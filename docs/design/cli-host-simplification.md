# Code Flow inside provider CLIs: simplification proposal

Status: proposal, nothing here is built. Written 2026-11-12 from the CLI-teams design pack (`docs/cli-teams/`), the tool schemas in `src/cli-teams/tools.ts`, the candidate schema in `src/cli-teams/model.ts` and the installed skill (`integrations/cli-teams/SKILL.md`). No live host run was exercised for this document.

This document covers how Code Flow is used from inside Claude Code, Codex, Antigravity and other agent CLIs: what to change so it is easier to use and fails less, what to remove, and what to add. It does not change the web app or the execution engine.

## 1. The problem

The engine is in good shape: one runtime owner, a durable journal, isolated worktrees, checks tied to the snapshot they ran on, and approval that a model cannot supply. The weak part is the contract with the host model. To run one task, the host has to:

| Step | What the host model must get right |
|---|---|
| Learn the flow | Read a 17 KB skill, then call `codeflow_get_guide` with section `candidate` |
| Propose | Author a candidate: up to 8 participants and up to 64 steps of 7 node kinds, with typed input references, gates and loops |
| Show | Paste the returned proposal card word for word, with its link |
| Start | Call `codeflow_start_run` with the proposal ID, revision and hash; wait up to five minutes on the form |
| Follow | Call `codeflow_get_run` repeatedly, passing `follow.next` back unchanged |
| Deliver | Page `codeflow_get_artifact` until no cursor remains |
| Apply | Page `codeflow_preview_handoff`, then call `codeflow_apply_handoff` with the exact `previewHash` |
| Retry | Reuse the same `operationId` on every retried call |

Each row is a place where a host can go wrong, and each host goes wrong differently. Reliability therefore depends on the host model and its version, which Code Flow does not control. The surface is also expensive when unused: 15 tool definitions and the server instructions are loaded into every session of every host that has the connection.

A second problem is positioning. Hosts now run their own subagents and teams on a single provider. What a host cannot do alone is get an independent opinion from a different provider, in an isolated copy, with a check bound to the exact code that was reviewed. The current entry point does not lead with that.

## 2. Principles

1. The server does the protocol work. The host states intent and reads results.
2. Use what every host already does well: read a file, run a shell command, run git.
3. Keep every safety rule that exists today: only the user approves, plan and review never edit, write scope needs a check, nothing is merged or pushed.
4. Fewer shapes, each tested live, over a general graph tested with fixtures.

## 3. UX changes, in order

### 3.1 One-call entry with fixed recipes

Add an intent-level call. The host passes the task, a mode and optionally providers. The server composes the team.

| Mode | Recipe |
|---|---|
| `review` | One or two reviewers from providers other than the host's, on `head` or `working_changes`. Read-only. |
| `plan` | One drafter, one reviewer from a different provider, one revision. |
| `implement` | One writer, the check command, one reviewer from a different provider, at most one repair pass. |

The call still creates an immutable proposal and still needs the user's approval. What changes is that the host no longer authors the graph or reads a guide first. The candidate schema stays available as an advanced path for the web app and for hosts that ask for something the recipes do not cover.

### 3.2 Lead with a second opinion

Make `review` the first thing the skill, the docs and `codeflow init` output show: "have Codex review what Claude just changed", or the reverse. It is read-only, short, cheap, needs no handoff, and is the clearest case where a second provider adds something.

### 3.3 Results as files

Write the final plan, review or change summary to a file and return its path with a short summary. The host reads it with its own file tool. This replaces most uses of `codeflow_get_artifact` and removes the paging rules from the instructions. Artifacts stay addressable by ID and hash for evidence.

### 3.4 Background by default

Following a run inside the turn blocks the conversation and runs into host tool timeouts; the installed Codex configuration already raises its limit to seven minutes for the approval form alone. Change the default so that start returns at once with the run ID and a link, and the host learns of completion in one of two ways:

- one status call with a bounded wait, for hosts that stay in the turn;
- a blocking terminal command (`codeflow wait RUN_ID`) that the host runs as a background shell task. Hosts that notify on background-command exit get a completion signal with no polling protocol at all.

### 3.5 Git-native delivery

An implementation run already ends on a branch in its own worktree. Return the branch name and the exact command to bring it in. Keep one apply call for users who want Code Flow to stage the change, with the preview folded in as a dry run instead of a separate paged tool.

### 3.6 Native packaging

Ship the connection and a short skill as a Claude Code plugin and the equivalent package for Codex and Antigravity. `codeflow init` remains the fallback. `docs/cli-teams/14-decisions-and-risks.md` already lists marketplace packaging as a future extension; this moves it forward because install and update friction is the first thing a new user meets.

## 4. What to cut or demote

| Feature | Why | Proposal |
|---|---|---|
| Host as participant (`codeflow_claim_step`, `codeflow_submit_step`, `codeflow attach`, claim fencing) | Read-only, host model and effort are unverified, adds reconnect and revocation states | Remove from the CLI surface. The host reads the result and comments in the conversation. |
| 15 public tools | Context cost in every session; more ways to call the wrong one | About six: run, start, status, steer and control merged, apply, providers and models merged |
| Host-authored graphs with loops and gates | Largest source of validation failures; tested mostly with fixtures | Advanced path only (section 3.1) |
| Unanimous agreement loops | Agents agreeing is weak evidence next to a passing check | One review and one repair pass in recipes; agreement stays in the advanced path |
| 17 KB skill and nine guide sections | Needed only because the protocol is long | A skill under 1 KB; each tool result carries the next action, as it does today |
| `codeflow_open_task` as a tool | The link is already in every result | Return the link; drop the tool |
| Project, personal and explicit preference layers | Three sources to explain and debug | One preference level plus the explicit task setting |
| Antigravity unrestricted mode and version-pinned sandbox | High upkeep for one provider | Mark Antigravity experimental; reviewer role only until it has live evidence |
| Embedded MCP Apps UI, native transcript mirroring | Already deferred | Stay deferred |

Removing host participation and the preference layers changes behavior that is documented in `docs/cli-conversational-teams.md`. Both need a deprecation note in one release before removal.

## 5. Worth exploring

| Idea | Value | Risk or cost |
|---|---|---|
| Shell path: `codeflow run "…" --mode review --by codex --json` plus an AGENTS.md snippet | Works in any CLI that can run a command, with no MCP or skill support, and in CI | Approval has to happen in the terminal; needs a clear non-interactive refusal |
| Quota-aware routing | When one subscription is rate-limited, the proposal offers the other provider instead of failing mid-run | Needs reliable limit detection per provider |
| Standing approval for small read-only runs | Removes the form for the most common flow | Relaxes "only the user approves each run". Must be set by the user in a terminal, never by a tool call, and bounded by scope and call count. A decision for the owner, see section 8. |
| Usage receipt per run | Calls, time and provider per run make the value and the cost visible | Host usage stays unknown; say so |
| ACP workers (`docs/acp-agents.md`) | New providers without a custom adapter | Capability differences between ACP agents |

## 6. Reliability

1. **Live canary.** The provider-compatibility workflow probes `--version` and `--help` only, and `docs/cli-teams/16-implementation-status.md` says fixture passes are not live evidence. Add a nightly run per host that executes the `review` recipe on a fixture repository with the cheapest model of each provider and records the result.
2. **Host matrix.** Publish, per host and version: native approval form, skill discovery, background completion signal, and the tested fallback for each missing capability.
3. **No long blocking calls.** After 3.4, no tool call should need a raised host timeout. Remove the Codex seven-minute override once the approval form is the only wait left, and give that wait a link-based fallback when it expires.
4. **Funnel metrics, local only.** Tool calls per run, time from proposal to approval, time to first result, and where runs are abandoned, per host. These tell us which step to fix next and are the test of whether this proposal worked.

## 7. Order of work

| Slice | Contents | Depends on |
|---|---|---|
| 1 | `review` recipe behind the one-call entry; result written to a file | none |
| 2 | Background start, bounded status call, `codeflow wait` | 1 |
| 3 | `plan` and `implement` recipes; branch-based delivery; apply with dry run | 1 |
| 4 | Tool surface reduced; host participation and extra preference layers deprecated; short skill | 1 to 3 |
| 5 | Plugin packages; shell path with AGENTS.md snippet | 4 |
| 6 | Live canary, host matrix, funnel metrics | 1 (canary can start as soon as the recipe exists) |

Slice 1 alone is shippable and is the cheapest way to find out whether the simpler entry point is used more.

## 8. Open questions

1. Where do result files live? Inside the run worktree keeps them readable by a host that is limited to the repository; under `CODEFLOW_HOME` keeps the repository untouched but may trigger a host permission prompt.
2. Does the one-call entry show the approval form in the same call, or keep propose and start as two calls? One call is simpler; two calls let the user ask for changes before the form appears.
3. Is standing approval for read-only runs acceptable at all? If yes, what are the bounds?
4. Do any current users rely on host participation or on agreement loops from the CLI? If so, they stay in the advanced path instead of being removed.
5. Which hosts notify the model when a background shell command exits? That decides how much weight `codeflow wait` can carry.
