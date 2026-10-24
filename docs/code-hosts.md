# GitLab and Bitbucket code workflows

Configure the GitLab or Bitbucket connection, fetch the change into an isolated review workflow, and inspect the pinned result before commenting, pushing or opening a pull request.

## Review on another code host

Open the project’s **Connections** tab, connect GitLab or Bitbucket, then choose **Choose issue or PR → Review pull request → Load PR preview**. This opens the explicit owner workflow with the project and repository preserved. Jira, Linear and source-provider extensions remain read-only. No provider account is contacted in the fixture tests.

Use the guided [connection setup](project-integrations.md), or keep administrator-managed integrations in `CODEFLOW_INTEGRATIONS_JSON` or `CODEFLOW_INTEGRATIONS_FILE`:

```json
[
  {"id":"gitlab","provider":"gitlab","project":"group/repository","credentialEnv":"GITLAB_TOKEN"},
  {"id":"bitbucket","provider":"bitbucket","project":"workspace/repository","credentialEnv":"BITBUCKET_TOKEN"}
]
```

Tokens remain server environment references. GitLab defaults to its v4 API and GitLab HTTPS Git root; Bitbucket defaults to its Cloud v2 API and bitbucket.org Git root. Self-hosted GitLab may set `baseUrl` and `gitBaseUrl`. A custom Bitbucket API base requires an explicit HTTPS `gitBaseUrl`; Bitbucket Data Center APIs are not supported. Neither root may contain credentials, query parameters or fragments. Fork paths must remain within the configured Git host/root; cross-host credential redirects are refused.

Choose a configured host, PR number and local Git repository. Loading a preview reads bounded provider metadata, discussions and available merge policy. Fetch explicitly imports exact source/target objects and their actual merge base into random application refs, without checking out or executing incoming code. Each snapshot expires after 15 minutes and all snapshots disappear on restart. Changed heads, targets, discussion revisions and project membership require a fresh preview. Truncated discussion lists cannot be resolved or replied to here; inspect the remaining discussion in the provider UI.

Fetched-code review runs require an explicitly prepared agent Docker image and optional named authentication volume. Build the image with the official CLI and authenticate inside that image/volume first. No host credential directory is mounted, images are never pulled automatically, and there is no native host fallback. The container runs with the host UID, dropped capabilities and resource limits; the CLI needs its own configured network access for inference. Check/setup commands run in a separate network-disabled container. Safe mode alone is not filesystem isolation. See the existing agent-container setup in the application architecture documentation.

The run begins at the fetched source commit, reads conventions from the trusted merge base, uses Safe mode, inherits no uploads or parent run, copies no ignored files, and cannot wait for native tool approvals. It needs at least one required verification command. Raw client `externalSource` or commit-provenance objects cannot establish authority. A restored or resumed run still needs its prepared agent container.

Review actions include general and new-file inline comments, replies, resolution/reopening, and GitLab exact-SHA approval/removal. Comments label the observed source and target commits. GitLab inline positions include its base/head/start diff identities. Bitbucket inline comments and approvals do not expose an atomic expected-head precondition: comments explicitly label the observed commit, postflight drift is reported, and commit-bound Bitbucket approval is deliberately unavailable here. Use Bitbucket's native UI for its approval action. Review content remains untrusted reference text.

Push starts with a preview of a completed, owned, currently verified result branch. The result must descend from the observed PR source and include current required check evidence. Push sends only that exact commit to the observed source branch with `--force-with-lease=<ref>:<observed-head>`; arbitrary force pushes are not available. GitLab fork pushes require a separately configured source integration. No push occurs when merely loading the preview.

New PR creation accepts a completed owned verified result, configured destination host, title/body and target branch. The result must contain new commits descending from that exact current target. Its preview shows a unique server-generated source branch, source/target commits and outgoing text. The explicit action creates the source branch with an expected-absent Git lease, then sends the native GitLab MR or Bitbucket PR creation request. Those two remote actions are not atomic. A timeout preserves the exact branch/commit/run receipt as unknown; inspect that branch and the provider before another attempt. The application never retries creation automatically or deletes ambiguous remote branches.

Merge is an explicitly labelled **pinned Git merge**, not a provider-native merge queue. A completed owned result must exactly match the current PR source and required verification/review evidence. The actual source-plus-target tree is built and checked in a disposable worktree using network-disabled check isolation and tracked-file/index/HEAD drift guards. The final commit has exactly the pinned target and source as parents. Its push uses an atomic exact-target Git lease. Source advancement cannot add unreviewed code; target advancement refuses the push. The local target branch is unchanged.

Provider policy must be readable and pass at preview and immediately before the action. GitLab approval state, exact-head pipeline requirements, discussion requirements, external checks and protected-branch metadata are inspected. Native trains, merged pipelines and enforced squash/rebase workflows are blocked. Bitbucket mergeability checks and complete branch restrictions must be readable, including the admin scope required by the restrictions API. Native queues, custom on-merge checks, dependency-merge requirements, incomplete results and unknown restriction types block merging. Direct target push permission is required and the Git server still enforces its push permissions. Provider APIs do not offer an atomic approval-policy snapshot tied to the Git ref update; organizations requiring exclusively native policy enforcement should merge in the provider UI.

GitLab's native merge endpoint pins the source SHA but does not pin the target SHA. Bitbucket's native merge endpoint does not expose an expected-head precondition and can queue its operation. Consequently this application does not call either native merge endpoint while claiming an exact validated target. A confirmed Git merge receipt does not imply atomic PR closure; the current provider state is reported separately and the PR may remain open. No native merge queue parity is claimed.

Credentialed Git runs in a private temporary bare repository with no user/global Git config, hooks, credential helper, redirects or submodules. Authentication is a process-only URL-scoped HTTPS header. Local object imports receive no provider credential. Fetches are bounded in time, output, file count and temporary storage (256 MiB); oversized histories fail closed. Local application refs keep imported objects reachable and are normal repository data; no credential is stored in them.

The bounded `code-host-operations.json` ledger retains at most 200 explicit actions and safe identity/commit/run/branch facts. Unknown receipts are never silently evicted: if all slots are unresolved, new actions stop until the owner explicitly records manual inspection of one exact outcome. Inspection is labelled separately from provider confirmation and never replays the action. The ledger stores no tokens, comment bodies, tasks or executable callbacks. Claims are fsynced before remote mutation; interrupted or restored claims become unknown metadata, all server previews are lost, and there is no startup dispatch or automatic replay. Retention protects referenced run receipts. Encrypted restore also excludes executable extension caches and live identity/session credentials. Any custom filesystem policy blocks all code-host POST operations, and shared project sessions cannot access these owner-only routes.

Provider protocol references: [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/), [GitLab discussions](https://docs.gitlab.com/api/discussions/), [GitLab approvals](https://docs.gitlab.com/api/merge_request_approvals/), [GitLab external status checks](https://docs.gitlab.com/api/status_checks/), [Bitbucket Cloud pull requests](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/), [Bitbucket branch restrictions](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-branch-restrictions/), [GitLab HTTPS tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/), [Bitbucket HTTPS access tokens](https://support.atlassian.com/bitbucket-cloud/docs/using-access-tokens/).

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
