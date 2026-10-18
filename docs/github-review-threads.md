# GitHub review threads

Runs started from a GitHub pull request and result branches with an opened pull request show a **GitHub review threads** disclosure. It reads actual GraphQL thread IDs, diff sides, line ranges, original locations, outdated flags, resolution state, authors and replies. This complements conversation comments and review summaries; a REST root-comment ID is not used as a resolution thread ID.

GitHub discussion is untrusted reference material. Comments are rendered as plain text, credential-like values are redacted and shortened bodies are labeled. Reading or resolving a thread does not send its content to an agent, approve a pull request or mark local checks and requirements complete.

The owner can explicitly press **Resolve thread on GitHub** or **Reopen thread on GitHub** when the current GitHub login has permission. There is no automatic resolution based on agent output, check results or a local review. A server-issued snapshot pins the repository, pull request node ID and current head, together with the thread location, resolution, permission state and all loaded comments and updates. Before a mutation, code-flow re-reads that exact thread and PR, and rejects changed heads, edited comments, new replies, changed locations or resolution state. Refresh and review the current discussion before acting again.

GitHub’s resolve/unresolve mutation does not accept an expected head or thread revision. Therefore a remote edit can race between the final comparison and the mutation. Code-flow rechecks afterward and reports a warning if the current head/state cannot be confirmed. It does not claim that this is an atomic GitHub compare-and-swap. A dropped mutation response is explicitly ambiguous, old snapshots are invalidated, and code-flow never retries the mutation automatically. Inspect the fresh state before another action.

Listings use four explicit pages of 25 threads. Each initially shows up to ten comments. **Load complete thread** reads at most four pages of 25 comments; threads with more than 100 comments remain read-only here and must be handled on GitHub. Thread and comment truncation are visible. Displayed bodies are capped at 8,000 characters per comment and 2 MiB of characters for the list. Each GraphQL subprocess has a ten-second deadline and an 8 MiB response bound. Snapshots expire after 20 minutes and at most 200 are kept; restart requires a refresh.

The application uses the owner’s installed `gh` login against the explicit hostname from the run’s stored HTTPS PR URL. Arbitrary client URLs and unknown result branches are rejected. GraphQL bodies go to stdin, not a shell command, and pagination is bounded by the application rather than `gh --paginate`. The CLI owns its authentication and HTTP redirect policy; this feature does not read or export GitHub tokens or claim a separate application-enforced no-redirect transport. See the official [GitHub CLI API manual](https://cli.github.com/manual/gh_api), [review thread fields](https://docs.github.com/en/graphql/reference/pulls#pullrequestreviewthread) and [resolution mutation inputs](https://docs.github.com/en/graphql/reference/pulls#resolvereviewthreadinput).

## API

`GET /api/runs/:id/pr-threads?branch=<owned-result-branch>` returns a snapshot with `snapshotId`, `prId`, `head`, `state`, `threads`, truncation flags and `expiresAt`. Without a branch, the run’s source PR is used, or its sole stored result PR. An unknown branch or missing PR returns 400. No caller-supplied PR URL is used.

`POST` on the same route with `{action:"load",snapshotId,threadId}` returns the bounded complete thread and its updated `revision`.

`POST` with `{action:"resolve",snapshotId,threadId,expectedHead,expectedRevision,resolved:true|false}` performs one explicit resolution action. A stale/foreign/expired snapshot, changed PR/thread or incomplete comments returns 409; missing GitHub permission returns 403; malformed requests return 400. A failed or ambiguous remote mutation returns 502 with instructions to refresh. A confirmed action returns `{applied:true,refreshRequired:true,thread?,warning?}`. Any old snapshot for that PR is invalidated before mutation.

Automated tests use injected GraphQL and a fake `gh` process only. Browser acceptance covers stale-reply rejection, refresh, resolve and reopen, forged snapshot rejection and separation from local verification. No live GitHub mutations were performed during development.
