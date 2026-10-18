# Outbound notifications

Notifications require an explicitly configured destination and a saved opt-in for its events and project scope. New destinations start disabled. No account is connected and no destination can be created from the browser.

Set `CODEFLOW_NOTIFICATIONS_FILE` to a server-side JSON file, or set `CODEFLOW_NOTIFICATIONS_JSON` to its contents:

```json
[
  {
    "id": "team-status",
    "name": "Team status",
    "protocol": "webhook",
    "urlEnv": "TEAM_STATUS_WEBHOOK_URL",
    "secretEnv": "TEAM_STATUS_WEBHOOK_TOKEN"
  },
  {
    "id": "slack-status",
    "name": "Slack status",
    "protocol": "slack",
    "urlEnv": "SLACK_STATUS_WEBHOOK_URL"
  }
]
```

Supply those referenced environment variables to the server. URLs must use HTTPS and cannot contain user credentials or a fragment. `secretEnv` is optional and sends its value as a Bearer authorization header. The Slack protocol uses an existing [Slack incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), with a literal text block and link previews disabled. There are no email, Teams account, or channel-management adapters; a separately configured HTTPS relay can consume the generic webhook protocol.

In Workspace → Notifications, select the destination, its events, and its projects, then save. Available events are run completion, run or verification failure, and requests for attention. “Without a project” covers runs with no project; “All projects” includes future projects. A run that finishes with failed or blocked verification produces a failure event. Sending a test is a separate, explicit action and works before enabling automatic notifications.

Generic webhook requests contain JSON with `version`, `id`, `event`, `runId`, optional `project`, `pattern`, `status`, `result`, and a task `title` limited to 200 characters. A manual test additionally has `test: true`. They exclude repository paths, transcripts, command output, and imported source content. Task titles can contain sensitive business information: opt in only for an appropriate destination. Recognizable secrets and configured credential values are redacted. The browser API exposes destination hostname, scope settings, and delivery metadata; it never exposes the webhook URL, credential names, tokens, or saved payloads.

The local outbox persists an event before sending, keeps at most 200 deliveries and 2,000 recent event identities, and sends at most 20 requests per worker pass. The worker checks every ten seconds, uses a ten-second request timeout, and refuses redirects. HTTP 429, server errors, and connection failures retry up to three total attempts with bounded exponential backoff. `Retry-After` seconds can extend the delay to at most five minutes. Other HTTP errors fail once. Pending deliveries expire after 24 hours without an attempt. When the queue is full, the newest event is dropped and its count and reason appear in the UI. Delivery history exposes failures, attempt counts, and an explicit retry action.

The `Idempotency-Key` request header is the persistent delivery ID. Recipients should deduplicate it. Exactly-once delivery is not guaranteed: a timeout or crash can happen after a recipient accepts a message. A delivery interrupted while sending becomes an unknown-outcome failure on restart and requires an explicit retry. Slack incoming webhooks do not provide an application-level deduplication guarantee. After 2,000 newer event identities have displaced an old identity, replaying that old event may deliver it again.

Changing the configured URL or protocol requires renewed opt-in. Disabling a destination or narrowing its scope cancels pending automatic deliveries, but cannot retract a request already in flight. Restoring an encrypted backup disables saved notification opt-ins and cancels pending or sending deliveries. Corrupt saved state leaves notifications unavailable and preserves the file for repair. Delivery state belongs to one server process; do not share its storage across multiple running servers.
