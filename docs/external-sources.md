# Read-only external sources

Configure the source integration, select an issue or pull request, and review the imported context before starting work. Imported descriptions remain untrusted task data.

## Bring source context into a run

code-flow can list and import GitLab issues and merge requests, Bitbucket Cloud issues and pull requests, Linear issues, and Jira Cloud issues. Import reads the item's text and metadata. It does not fetch a review request's branch, publish comments, transition issues, push commits or merge remote work.

Configure integrations on the server with `CODEFLOW_INTEGRATIONS_FILE` pointing to a JSON file, or `CODEFLOW_INTEGRATIONS_JSON` containing the array directly. The file takes precedence. Restart code-flow after changing configuration. Credentials are read from named environment variables; the browser receives connection names and availability, never credential values or environment variable names.

```json
[
  {
    "id": "gitlab-project",
    "name": "GitLab application",
    "provider": "gitlab",
    "project": "my-group/my-project",
    "credentialEnv": "MY_GITLAB_READ_TOKEN"
  },
  {
    "id": "bitbucket-project",
    "name": "Bitbucket application",
    "provider": "bitbucket",
    "project": "my-workspace/my-repository",
    "credentialEnv": "MY_BITBUCKET_READ_TOKEN"
  },
  {
    "id": "linear-team",
    "name": "Linear engineering",
    "provider": "linear",
    "project": "ENG",
    "credentialEnv": "MY_LINEAR_READ_KEY"
  },
  {
    "id": "jira-project",
    "name": "Jira application",
    "provider": "jira",
    "baseUrl": "https://my-company.atlassian.net/",
    "project": "APP",
    "credentialEnv": "MY_JIRA_READ_TOKEN",
    "usernameEnv": "MY_JIRA_EMAIL"
  }
]
```

Use credentials restricted to reading the configured project or team. Authentication defaults are `private-token` for GitLab, `bearer` for Bitbucket, `api-key` for Linear personal keys, and `basic` for Jira email/API-token pairs. An explicit `auth` may choose any of those modes; `basic` also requires `usernameEnv`. Linear OAuth tokens use `bearer`.

GitLab's default API base is `https://gitlab.com/api/v4/`; a self-managed instance can provide its own HTTPS API base. Bitbucket uses the Cloud API at `https://api.bitbucket.org/2.0/`; Bitbucket Data Center is not supported by this adapter. Linear uses `https://api.linear.app/`; `project` is the team's key or UUID. Jira requires the site API base and a project key. Its adapter uses enhanced `/rest/api/3/search/jql`, rather than the older search endpoint being removed.

The external-sources screen lists a page of up to 50 items. Selecting **Use as task context** imports the full description, up to 20,000 characters. Server-held imports expire after 30 minutes and a restart; reimport if necessary. A run stores its accepted source snapshot for later inspection and recovery.

Imported content is always untrusted. The browser sends a server-issued `externalSourceId` when starting a run. The server resolves that ID to its own saved snapshot and the engine applies the same restrictions as other untrusted sources: safe agent permissions, no copied secrets, and isolation for commands unless the user explicitly permits host execution. A client-provided body, `trusted` field or text marker cannot establish source authority.

Connections require HTTPS. Requests remain within the configured API origin and path, do not follow redirects, time out after 15 seconds and stop reading at 2 MiB. Credential values and remote error bodies are excluded from error messages. GitLab/Bitbucket numeric pagination stops at page 20 and reports truncation; the UI also limits displayed items to 1,000. Some Bitbucket repositories do not enable their built-in issue tracker; their issue API will report unavailable access while pull requests remain usable.

## Provider extensions

`ReadOnlySourceProvider` in `src/integrations.ts` defines `kinds`, `list` and `get`. Pass additional adapters through the `Integrations` constructor's `adapters` option. Extensions receive the same bounded request client. REST requests use GET; GraphQL accepts named read-only queries and variables. The request client rejects mutation operations and requests outside the configured API base. Normalize results to `ExternalSourceItem`; the class enforces output bounds and issues untrusted import identities.

## API

| Operation | Request |
| --- | --- |
| Connection availability | `GET /api/integrations` |
| List one page | `GET /api/integrations/:id/items?kind=issue` (or `pr`) |
| Continue a listing | Add the returned opaque `cursor` |
| Import full source | `POST /api/integrations/:id/import` with `{ "kind": "issue", "key": "123" }` |
| Attach imported context to a run | Include the returned `id` as `externalSourceId` in `POST /api/runs` |

The API requires the normal code-flow session. Service credentials are configured on the server and cannot be changed through this interface.

## Provider references

Implementation references checked on 18 October 2026:

- [GitLab project issues](https://docs.gitlab.com/api/issues/) and [merge requests](https://docs.gitlab.com/api/merge_requests/).
- [Bitbucket Cloud REST API](https://developer.atlassian.com/cloud/bitbucket/rest/), [pull requests](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/), and [issue tracker](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-issue-tracker/).
- [Linear GraphQL authentication and queries](https://linear.app/developers/graphql).
- [Jira Cloud enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) and [email/API-token authentication](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/).

Automated coverage uses deterministic HTTP fixtures. Live account compatibility depends on each account's current API access and credentials; tests do not spend quota or create remote content.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
