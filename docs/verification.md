# Verification and review

Open Project → Repository tools → Verification to inspect the repository’s checks. Select the profile in the composer, then review each required gate and criterion mapping on the final result.

## Verify a result

In the composer, select a verification profile instead of the single legacy check. Lightweight, standard and thorough presets detect existing repository commands. In **Project → Repository tools → Verification**, review/edit the detected commands, add bounded custom gates, map acceptance criteria to checks, and run them at a pinned commit. A baseline comparison runs the same profile on both commits; repeated attempts distinguish consistent failures from flaky results. Export the report or profile for reuse through the API.

Every required gate must pass. Skipped gates, mixed results, missing criterion mappings and failing mapped checks cannot produce `verified`. A criterion mapping is your assertion that the chosen checks exercise its behavior; passing a command is not a semantic proof of an arbitrary requirement. Finished work without independent verification is labeled accordingly.

Thorough detection recognizes `test:mutation`/`mutation`, `test:visual`, and `test:a11y`/`test:accessibility` scripts when present. These are explicit mutation, visual and accessibility gates. The repository supplies its testing tools, mutation thresholds, image baselines, target URLs and accessibility rules. code-flow executes the commands and retains their exit/output evidence; it does not install those tools or invent screenshot baselines. Set optional gates to required when their failure must block verification.

Profiles support at most 12 checks, 48 criteria, 30 minutes per check, three repeats and a one-hour suite deadline. Detected gates get the time limit the repository's check gets in a run (`limits.checkTimeoutMin` in `.codeflow/config.json`, ten minutes by default); change a gate's **Timeout** before running it. Unless a deadline is given, a verification allows each gate its own timeout for every attempt, up to the one-hour deadline. A gate its timeout stopped says so in its result, so a slow suite isn't mistaken for a failing one. **Cancel verification** stops a running verification. Setup has a separate two-minute bound.

In a run, a required gate that can't run here (its runner isn't installed, say) is treated like a [check that can't run](patterns.md): it runs once more on the base commit, and when it fails the same way there, no fix rounds are spent on it and the result is labeled Blocked. A run's check that names the same script as a gate (`npm test` and `npm run test`) doesn't add a second gate. Profile checks must preserve tracked files, the index and HEAD; changing tested code or hiding files with Git index flags blocks the result before another gate can run. Ignored or untracked build output is allowed. Temporary worktrees are removed on failure and cancellation.

The **Changes** side tab records human review of individual files at an exact commit, exposes heuristic change-risk reasons, and records time spent correcting a result. Review coverage becomes stale when the branch moves. Agent activity is not counted as human rework, and a clean test run does not mark files reviewed.

The result's merge panel can **Validate merge result** against the current local target branch. This constructs the combined tree in a disposable checkout and runs the configured setup/profile. Requiring validation pins source, target and merged tree; moving refs, rewriting checks or a different merge result invalidates it. A verified merge into a checkout runs the same hooks as any other merge there (pre-merge-commit, post-merge); a hook that changes the merged tree is detected, with rollback of the application's own clean merge when possible. GitHub PR merges still use the repository's remote checks and policies; this local validation does not replace a remote merge queue.

Checks execute repository code. Use a check container or explicitly trust host execution, especially with imported source text. Agent isolation and check isolation are separate settings. See [security](security.md), [agent containers](agent-containers.md), and the [API contract](api.md).

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
