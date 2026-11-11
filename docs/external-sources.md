# Read-only external sources

External sources bring an issue or pull request from a service other than GitHub into a run as untrusted task data. Code Flow ships no source providers. GitHub issues and pull requests use the [GitHub workflows](github.md) and the project's **Connections** tab instead; see [project integrations](project-integrations.md).

## Provider interface

`ReadOnlySourceProvider` in `src/integrations.ts` defines `kinds`, `list` and `get`. A build adds providers through the `Integrations` constructor's `adapters` option; the server registers none, and `CODEFLOW_INTEGRATIONS_FILE` / `CODEFLOW_INTEGRATIONS_JSON` entries naming any other provider are rejected with a warning in **Settings → Integrations**.

Providers receive a bounded request client. REST requests use GET; GraphQL accepts named read-only queries and variables. The client rejects mutation operations and requests outside the configured API base. Normalize results to `ExternalSourceItem`; the `Integrations` class enforces output bounds and issues untrusted import identities.

A configuration entry names its provider, project, HTTPS `baseUrl` and the server environment variable holding the credential (`credentialEnv`, plus `usernameEnv` for `basic` authentication). Authentication is `bearer` (the default), `api-key` or `basic`. The browser receives connection names and availability, never credential values or environment variable names.

Requests remain within the configured API origin and path, do not follow redirects, time out after 15 seconds and stop reading at 2 MiB. Credential values and remote error bodies are excluded from error messages. Listings return up to 50 items per page.

## Trust

Imported content is always untrusted. The browser or a script sends a server-issued `externalSourceId` when starting a run. The server resolves that ID to its own saved snapshot and the engine applies the same restrictions as other untrusted sources: safe agent permissions, no copied secrets, and isolation for commands unless the user explicitly permits host execution. A client-provided body, `trusted` field or text marker cannot establish source authority. Server-held imports expire after 30 minutes and a restart. A run stores its accepted source snapshot for later inspection and recovery.

## API

| Operation | Request |
| --- | --- |
| Connection availability | `GET /api/integrations` |
| List one page | `GET /api/integrations/:id/items?kind=issue` (or `pr`) |
| Continue a listing | Add the returned opaque `cursor` |
| Import full source | `POST /api/integrations/:id/import` with `{ "kind": "issue", "key": "123" }` |
| Attach imported context to a run | Include the returned `id` as `externalSourceId` in `POST /api/runs` |

The API requires the normal code-flow session. Service credentials are configured on the server and cannot be changed through this interface.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
