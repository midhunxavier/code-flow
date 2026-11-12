## Code Flow: second opinions and agent teams

This computer has Code Flow (`codeflow`). Use it when the user asks for a review, plan or implementation by another coding agent, or for a second opinion on your work. Run it from the repository.

- Review the current changes with another provider (read-only): `codeflow run "what to review" --mode review --wait`
- Reviewed plan (read-only): `codeflow run "what to plan" --mode plan --wait`
- Implementation in a separate worktree, checked and independently reviewed: `codeflow run "what to build" --mode implement --check "the project's test command" --wait`
- Add `--by codex`, `--by claude` or `--by claude,codex` only when the user named a provider.

The command prints a proposal and an approval command. Only the user approves: show them the proposal and ask them to run the printed `codeflow approve ...` command in their own terminal. Never run `codeflow approve` yourself. With `--wait` the command then continues until the task finishes, so run it as a background command and keep working.

When it finishes it prints `Result file: PATH`. Read that file and present the result. Exit codes: 0 finished, 1 stopped or cancelled, 2 needs the user, 3 not approved yet, 4 still working at the timeout (`codeflow wait RUN_ID` continues waiting).

A review or plan never edits files. An implementation stays on its own branch until the user applies it with `codeflow apply RUN_ID` in their terminal. Do not run other agent CLIs yourself to do this work, and never start Code Flow from inside a Code Flow worker.
