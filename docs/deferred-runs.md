# Deferred runs

Configure a task in the composer and choose a time, provider capacity, or both as its start condition.

## Queue a one-time task

Inspect and manage the queue in **Scheduling → Run once later**. Save a new deferred request from the composer after configuring its task. **AI team** works only in a live Agent conversation, so a request with it switched on is refused: turn it off to defer one agent, or choose **Team — dynamic plan** in Advanced to defer a team.

Deferred runs save one explicit run request for later execution. They are separate from recurring automations. A job can start at or after a chosen local time, when selected providers have capacity, or after both conditions are satisfied. The application must be running; closing it preserves the queue for the next launch.

When you choose **At or after a chosen time**, the earliest start suggests an hour from now. An untouched suggestion that passes while the form is open moves forward again and asks you to review it before saving; a time you entered is kept exactly.

The queue uses the application's reported provider windows and current availability. A known provider reset is a waiting condition. An unknown reset is periodically checked; it is not presented as a promised reset time, and the queue never makes a billable inference call to probe quota. Provider selection and source references are validated again when the job launches.

Deferred requests use Safe mode, disable native tool and plan approval waits, and suppress ignored-file copying. Uploaded attachments cannot be saved in the queue. Repository context paths remain references to the repository and are revalidated on launch. GitHub sources are stored as issue, PR or alert references. External sources are stored as configured integration/kind/key references and fetched again; imported text and client-supplied authority are never persisted as trusted execution context. Missing parent runs must fail validation, rather than silently losing inherited source restrictions. Deferred runs never grant permission to run untrusted source checks on the host.

Each launch claim is written atomically and synced before the launch callback executes. Local queue instances share a transaction lock; the application server's exclusive ownership lock is required across processes. Only one automatic claim can win for a queued revision. The launch callback must persist and sync the created run's initial snapshot before returning its run ID, and include the job ID, claim ID and attempt number in that snapshot.

A crash, timeout or unexpected launch error leaves an **unknown** outcome, because a run may already exist. Unknown launches never retry automatically. The recovery UI displays the exact claim and lets you link a matching run, cancel queue recovery, or explicitly acknowledge that another attempt may duplicate work. The server must verify the linked run's persisted claim and repository/project scope. Late receipts are retained in bounded history, including receipts for older attempts. A known rejection before launch side effects is distinct from an unknown outcome and can be explicitly retried after correction.

Cancellation before claiming prevents execution. Cancelling a job that is already cancelled, for example from a second tab, succeeds without changing it; any other action on a job that changed since you loaded it is refused, and the card shows the job's current status. A known rejection with attempts left can be retried or cancelled. Cancellation during launch aborts the callback and may produce an unknown outcome; if a late receipt identifies a run, the configured cancellation callback receives it. Cancelling unknown queue recovery does not imply that an unknown existing run stopped. Started runs are stopped through the normal run controls.

Limits are explicit: at most 100 open jobs (pending, launching, unknown, or rejected with attempts left), 200 retained jobs, 30 history events per job, three user-requested launch attempts, 96 KiB per request, and a 32 MiB queue file. Beyond 200 records the oldest finished ones (started, cancelled, or rejected with no attempts left) are removed first; a rejection you can still retry is never removed automatically. **Remove record** on a card, or **Clear finished** for the listed scope, removes finished records yourself; started runs stay in your runs. No run is retried solely because the server restarted. Corrupt or unsupported queue files fail closed and are preserved for repair: the rest of the application keeps running, **Run once later** shows the read error once and stops checking in the background (**Refresh queue** checks again), the server logs it once at startup, and nothing in the queue launches until you repair the file and restart code-flow. Configuration and history are saved in `CODEFLOW_HOME/deferred-runs.json` with owner-only permissions and atomic synced replacement.

The saved request includes the exact task and command text you entered. Reference environment variable names for credentials; inline credential values would become part of that local configuration. Provider authentication files and environment values are never automatically captured. Diagnostic history is redacted, while executable configuration is preserved so redaction cannot silently change a command's behavior.

The reusable service is `DeferredRuns` in `src/deferred-runs.ts`; `ready`, `launch` and optional `cancelRun` callbacks connect it to the application. Call `load()` once, reconcile unknown claims against durable run snapshots, then `start()`. Stop the queue before shutting down the engine. Tests use fake launch callbacks and provider windows, without real provider credentials or quota.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
