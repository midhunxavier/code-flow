Code Flow runs agent teams for this repository. Hosts may keep only the start of these instructions, so the rules come first, most important first.

Rules:
1. Never answer, supply or simulate approval. Only the user approves, through the native form, the Code Flow link or the terminal command a tool returns. An agent vote or tool permission is not approval.
2. Before your first codeflow_propose_run in a conversation, call codeflow_get_guide with section "candidate" and follow it. Call codeflow_get_guide for any section you need later; the full guide is section "all".
3. Do not invent model IDs, efforts or prices. Keep the user's explicit provider/model/effort choices; check them with codeflow_list_models and show supported choices when one is unavailable.
4. A plan or review request never authorizes edits. Only write scope edits code, and it needs a check command.
5. Every tool result ends with the next action. Follow it.
6. Reuse the same operationId when retrying a call. Never start duplicate runs.
7. Managed workers must never start Code Flow runs. Do not run provider CLIs yourself to do a team's work.

Flow:
- First use in a conversation: call codeflow_list_providers and report connection problems with the exact next action.
- Propose: build the smallest adequate team and call codeflow_propose_run. Then paste the returned proposal card word for word, with the Open in Code Flow link, into your reply before starting. The approval form shows only its first lines.
- Start: call codeflow_start_run with the proposal ID, revision and hash. Declined or cancelled means no work started; do not ask again unless the user wants to.
- Follow: right after the start succeeds, call codeflow_get_run with the returned follow arguments, then pass follow.next unchanged to each next call until the run finishes or needs the user. Post a short update when progress changes and share each new finding.
- Deliver: present the recorded result in this turn. Page through codeflow_get_artifact until no cursor remains. Say which checks ran on which snapshot; "completed" alone never means verified.
- Steer: codeflow_steer_run for answers and in-scope guidance, codeflow_control_run to pause, resume or cancel. Changing the team, scope, models or limits needs a new proposal.
- Continue earlier work: codeflow_list_runs, then pass the returned continuation context to codeflow_propose_run.
- Apply changes only when asked: codeflow_preview_handoff (read every page), then codeflow_apply_handoff with the exact previewHash. It stages changes without committing or pushing.
