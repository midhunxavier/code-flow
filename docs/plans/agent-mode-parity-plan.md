# Agent mode: desktop conversation parity

Status: implemented in the worktree; validation results are recorded in [agent-mode-validation.md](agent-mode-validation.md).
Date: 2026-10-22.
Base: `8a97ced` from `origin/main` (fetched and fast-forwarded on 2026-10-22).
Branch: `codex/agent-mode-parity`.

## Product contract

Make a dependable single-agent conversation the foundation of Codeflow. Use Codex Desktop as the interaction reference, Claude Code in Claude Desktop as the Claude execution reference, and Conductor as the reference for chat tabs within a workspace.

- Rename the visible workflow choices to **Agent** and **Team**. Preserve the existing stored `solo` and `auto-team` identifiers initially so saved history continues to load. Do not rename unrelated automatic provider selection or permission modes.
- An Agent chat has one chosen provider, its native session, a workspace, and an ordered conversation. Follow-ups continue that conversation. Failure or cancellation ends a turn without making the conversation unusable.
- Show user messages, assistant updates, tool activity, permission requests, questions, and the final answer accurately. Preserve the agent's response rather than wrapping it in a team result report.
- Keep the chat focused on the composer and conversation. Provider/model selection, attachments, permissions, send, and stop are sufficient primary controls. Remove run-budget forms, team result cards, and PR/merge workflow buttons from the Agent transcript.
- Let the agent perform commit, push, PR, and other requested work through available tools under the configured permissions. Remove the solo-specific prohibition on these actions and automatic commits after every turn. File preservation and any recovery snapshots must remain separate from user-visible Git commits.
- Switching provider in an established conversation opens a new sibling tab with carried context. The original tab keeps its own provider, session, and history. Selecting a provider before the first message only configures that new chat.
- New empty chat, same-provider fork, cross-provider continuation, and side chat are distinct operations.
- Side chat uses a snapshot of the main conversation and relevant selected context, has its own transcript, and does not redirect the main turn. Match the observed Codex side-chat lifecycle before declaring parity.

Parity means matching observable interaction and lifecycle behavior. It does not mean identical model answers or transferring one vendor's private session state into another vendor's runtime.

## Initial investigation evidence

Observed Claude Desktop's Code interface directly: a session composer with environment, project folder, permission and model controls, plus terminal/browser/files panes. No prompts were submitted in the reference app.

Direct computer inspection of the Codex app was blocked by the environment. Codex behavior in this investigation is grounded in official documentation and the public app-server protocol, not a completed live comparison. Conductor was studied through its official documentation.

| Existing Codeflow behavior | Evidence | Implication |
| --- | --- | --- |
| Solo is a pattern inside the team/run engine; it creates a worktree, commits each turn, checks, and publishes a result | `src/patterns/solo.ts`; follow-up execution in `src/engine.ts` | Give conversations their own lifecycle and remove automatic run finalization from Agent turns |
| Codex app-server ignores text, command-output, and other incremental deltas; the adapter emits completed agent messages | `QUIET` in `src/adapters/codex-app-server.ts`; `handleItem` in `src/adapters/codex.ts` | Implement incremental, identified message updates before judging transcript quality |
| Claude runs one headless CLI process per turn and ignores `stream_event` and control messages | `src/adapters/claude.ts` | Add a supported interactive transport, partial responses, questions, and approval handling |
| The normalized text event carries text but no stable item identity or delta/snapshot semantics | `AgentEvent` in `src/adapters/types.ts` | Extend the conversation event contract to avoid duplication and ordering errors |
| Provider handoff already copies visible history and saved files, but requires an idle clean worktree and starts a new run/worktree | `startProviderChat` in `src/engine.ts`; `src/chat-handoff.ts`; `ProviderChatDialog` in `ui/run.tsx` | Reuse context export, but separate chat identity from workspace identity |
| A new side chat receives the task, a capped pattern summary, and diff statistics | `sideTurn` in `src/engine.ts` | It does not yet receive a full conversation snapshot |
| Side chats already have a tab strip and their own resumed sessions | `ui/side-chat.tsx` | Reuse tab and session handling while correcting context and scheduling |
| Agent conversation components exist, but the page also renders generic run evidence, result experiences and budget controls | `ChatThread`, `TurnBody`, `ConversationBar` and run page in `ui/run.tsx` | Simplify Agent presentation without removing Team workflows |

### Baseline verification

Installed locked dependencies in this worktree using `npm ci --ignore-scripts --no-audit --no-fund`.

Ran:

```sh
node --import tsx --test --test-concurrency=4 --test-reporter=spec \
  test/chat-views.test.ts test/chat-options.test.ts \
  test/transcript-feed-ui.test.ts test/codex-app-server.test.ts \
  test/provider-contract.test.ts
```

Result: **37 passed, 0 failed, 0 skipped**, approximately 28 seconds. These are fixture/unit/integration checks of existing behavior. They do not prove live provider authentication, actual model behavior, visual rendering in a browser, or equivalence with either desktop app. Existing provider compatibility documentation also distinguishes version/help probes from live inference.

## Investigation method

1. Use one disposable repository and a fixed script of interactions in each reference app and Codeflow. Record the app/runtime version, input, visible state changes, provider events when exposed, and filesystem result.
2. Cover first response, follow-up, long output, tools, clarification, permission decisions, message during work, interruption, resumption, side questions, forks, provider changes, and reopen/reconnect.
3. Label each behavior as directly observed, officially documented, inferred, or unverified. Resolve differences by using the product contract above; the reference apps do not behave identically in every detail.
4. Convert observations into repeatable tests. Compare structural behavior and outcomes rather than exact generated wording.
5. Inspect public runtime protocols and source before investigating private implementation details. REA is an optional tool for a concrete unresolved local desktop/Electron behavior, with a bounded target and evidence retained. Its README was reviewed; it was not installed or executed, because public protocols and Codeflow source already explain the first gaps.

## Implementation order

### 1. Persistent conversation foundation

Introduce or extract conversation, turn, item, workspace, and provider-session identities. Reuse existing storage, process execution, adapters and worktree management where sound. Keep Team execution working through its existing orchestration layer.

Persist events with stable IDs and sequence cursors before publishing them. A replayed event updates the same item. A completed item reconciles its accumulated deltas. Separate assistant progress from the final response, preserve all final content blocks, and keep partial output when a turn fails.

Model idle, running, waiting for user/permission, interrupted, failed, and completed turns explicitly. Sending, queuing, steering and retrying need distinct delivery receipts. Reloading the UI must not relaunch a tool or resend a prompt.

### 2. Complete the provider transports

Codex: extend the current app-server integration for live item deltas, message phases, tool output, questions, native resume/fork, interrupt, and recovery. Bind all notifications to the correct thread, turn and item.

Claude: validate a supported bidirectional runtime integration for partial responses, follow-ups, interrupt, permission requests and questions. Preserve the existing official CLI authentication path where supported; evaluate SDK authentication compatibility before selecting an SDK transport. An API-key SDK must not be assumed interchangeable with a logged-in CLI.

Expose a provider capability contract for stream, resume, fork, queue, steer, approval, question, attachments and context accounting. Advertise only tested capabilities. Where native steering is unavailable, clearly queue for the next turn. Start live acceptance with Claude and Codex, then apply the same suite to the other advertised providers.

### 3. Agent conversation UI

Render one coherent stream of messages and expandable tool activity. A final answer appears once and remains visible when the next turn starts. Handle Markdown, code fences, links, attachments and long outputs while streaming.

Follow new output only when the user is already at the bottom; preserve their reading position otherwise. Keep drafts, scroll position, unread state and pending input scoped to their tab. Move run-oriented controls out of Agent chat. Apply the Agent/Team terminology with compatibility for saved runs.

### 4. Forks and provider-switch tabs

Separate a conversation from its workspace: sibling tabs normally share the current workspace and current files. A separate worktree is an explicit fork option, not a consequence of changing provider. Coordinate writers in a shared workspace; use separate worktrees for independent concurrent edits.

Use a native fork for the same provider when its verified protocol supports it. For a different provider, create a new native session and import a provider-neutral context package anchored to a source message/event boundary. Include user constraints, visible messages, decisions, current task state, changed files, test results, relevant tool evidence and attachments. Keep source references and an inspectable record of what was carried over.

Do not import hidden reasoning, credentials, or opaque vendor session IDs. Do not silently drop long context: retain the full exported reference and use an explicit bounded summary when required. Exclude undelivered queued prompts from completed history. Distinguish the conversation fork point from the current filesystem state; copying history does not rewind files.

Capture active-turn forks consistently. If a provider cannot fork an active turn, use a stable completed boundary and explain which context was included. Failure to prepare the new tab leaves the original chat usable.

### 5. Codex-style side chat

Open from the main composer or selected transcript text. Capture parent context at a known boundary, preserve relevant attachments and references, and give it an independent conversation identity. Prefer a native contextual fork where available; otherwise use the same portable context mechanism.

Keep the main agent running while a side question is answered. Do not place side questions into the main run's follow-up queue. Default the question workflow to reading and explanation, and validate exact permission and lifetime details against Codex. Returning to the main chat preserves its transcript, active work, draft and scroll state. Sharing a side answer back is an explicit user action.

### 6. Acceptance and release gate

| Scenario | Required outcome |
| --- | --- |
| Simple question and follow-up | Complete answer, correct ordering, remembered constraints |
| Long streamed Markdown/code | Visible incremental output; valid final rendering; no duplicate final answer |
| Read/edit/test workflow | Correct tool activity and file changes; no unsolicited Git commit |
| User asks a question mid-turn | Delivery is accurately shown as queued or steered; no loss or double delivery |
| Provider asks for clarification/approval | Interactive request can be answered/declined; no silent disappearance or stale approval |
| Stop during a command, then continue | Turn and owned processes settle; partial output survives; conversation remains usable |
| Provider failure, rate limit, missing session | Honest recoverable state; no false success or blind replay of side effects |
| UI reload, disconnect, host restart | Ordered history is restored; active work is reconciled; no duplicate execution |
| Same-provider fork | Independent session with context through the selected boundary |
| Claude to Codex and Codex to Claude | New sibling tab, source intact, constraints/files/pending work correctly carried |
| Side question while main agent works | Context-aware answer in separate transcript; main work continues |
| Two tabs sharing files | Writer coordination prevents conflicting simultaneous edits |
| Close/reopen tabs and long history | Correct drafts, history, selection, unread state, scroll and performance |
| Additional provider | Same acceptance suite, with explicit handling of unsupported native capabilities |

Use three evidence layers: deterministic event replay tests; browser interaction and visual checks with a controlled backend; live authenticated end-to-end runs against supported provider versions in a disposable repository. Inject failures and replay events to test recovery. Repeat the critical live paths to check stability, and record versions, traces and screenshots.

Agent mode is ready only when these core scenarios pass for Claude and Codex with live evidence, the same suite passes for other providers claimed to support the experience, and relevant Team regression checks remain green. Additional Team features come after this gate.

## Primary references

- [Codex app-server: threads, turns, item events, steering, interruptions and forks](https://learn.chatgpt.com/docs/app-server)
- [Codex commands: forks and ephemeral side chats](https://learn.chatgpt.com/docs/developer-commands)
- [Codex desktop keyboard commands](https://learn.chatgpt.com/docs/reference/commands)
- [OpenAI: side chats and workflow context](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)
- [Claude Code Desktop: sessions, workspace panes and side questions](https://code.claude.com/docs/en/desktop)
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude session persistence, resume and fork](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude SDK integration and authentication requirements](https://code.claude.com/docs/en/agent-sdk/overview)
- [Conductor: harnesses and chat/workspace boundaries](https://www.conductor.build/docs/reference/harnesses)
- [Conductor: chat and fork shortcuts](https://www.conductor.build/docs/reference/keyboard-shortcuts)
- [REA: supported analysis and setup](https://github.com/morluto/rea)
