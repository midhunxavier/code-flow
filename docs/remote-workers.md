# Remote agent workers

Provision and verify a worker before assigning it work. Keep source and result receipts available so interrupted connections can be reconciled without launching duplicate work.

## Choose an execution target

An explicitly registered SSH worker runs agent turns in disposable Git worktrees on another machine. The application transfers an exact commit, the turn prompt and regular files from the run’s `.codeflow-context` folder. Official agent CLIs use the worker’s own login. SSH agent forwarding, environment forwarding, port forwarding and automatic host-key acceptance are disabled.

This is an operator provisioned service: it does not discover hosts, install remote dependencies, copy local provider credentials or automatically fetch repositories from the network. Commands and checks outside agent turns still run where the application server runs. Choose the remote worker in the composer’s advanced controls.

## Provision a worker

Use Node 22.13 or newer, Git and the official CLI for each selected provider. Sign in on the worker itself. A dedicated OS account and disk/process limits are recommended for executable repository content. The worker account needs write access to its own state directory and provisioned repository mappings. A mapping can be a clone or a bare Git repository with an existing commit; it is not an arbitrary path supplied by a run.

Build the standalone entry point in this checkout:

```sh
npm run build:worker
```

Copy `dist/remote-worker.mjs` to the worker through your normal administration process. Configure an existing SSH host alias with its known host key and noninteractive authentication. Code-flow runs `ssh` with strict host-key checking and never accepts a new fingerprint for you. [OpenSSH’s manual](https://man.openbsd.org/ssh) describes identity selection and forwarding options.

Create a private worker configuration, for example `/srv/codeflow/worker.json`:

```json
{
  "version": 1,
  "root": "/srv/codeflow/state",
  "repos": { "application": "/srv/codeflow/repos/application.git" },
  "providers": ["claude", "codex"],
  "allowedTrust": ["safe", "standard"]
}
```

Register it on the application server with `CODEFLOW_REMOTE_WORKERS_FILE=/absolute/remote-workers.json` (or the same JSON in `CODEFLOW_REMOTE_WORKERS_JSON`):

```json
{
  "version": 1,
  "workers": [{
    "id": "build-linux",
    "name": "Linux build worker",
    "sshHost": "codeflow-linux",
    "command": "node /srv/codeflow/remote-worker.mjs --config /srv/codeflow/worker.json",
    "repoMappings": ["application"]
  }]
}
```

The command is an explicit operator configuration; task content never becomes part of the SSH command. Keep these files outside agent workspaces. Public worker metadata contains names, IDs, mapping names and optional container profile names, without SSH commands, host details, credentials or recovery capabilities.

The worker view probes the registered channel and installed CLIs. A successful probe does not claim a provider login is valid; the official CLI reports authentication failures when a turn runs. Missing mappings, providers or container profiles fail explicitly. Remote selection never falls back to this computer.

## Exact source and returned changes

The client pins the clean tracked checkout commit. If the worker already has it, no source upload is needed. Otherwise code-flow creates a Git bundle using an exclusive temporary `refs/codeflow/transfers/<requestId>` reference, deletes that reference with compare-and-swap, and uploads the bounded bundle over SSH. When the worker confirms the repository’s original base is present, the bundle excludes that history. If the bundle is too large, sync the provisioned mapping through your administration process and retry explicitly. No remote URL from task content is fetched.

The worker verifies the bundle’s sole advertised reference, enables Git object validation on import and creates a detached request worktree. It never checks out or changes the mapping’s main branch. Read turns must preserve `HEAD`, the staged tree and tracked files; changed files are discarded and the turn fails. Write turns return a worker-created commit descended from the exact accepted base. Agent attempts to rewrite checkout history fail.

Returned result bundles have an exact request-owned reference and SHA-256 digest. Before importing, the client verifies the digest, advertised commit, Git object integrity and ancestry, then requires the local worktree’s original commit and clean tracked state. It fast-forwards that owned checkout only; concurrent local changes cause a visible failure. Disposable worktrees and imported temporary references are cleaned after execution. See Git’s [bundle](https://git-scm.com/docs/git-bundle) and [worktree](https://git-scm.com/docs/git-worktree) documentation for those primitives.

Gitlinks/submodules and repositories declaring checkout filters such as Git LFS are rejected: a parent Git bundle does not contain their materialized contents. Configured clean, smudge and process filters are suppressed during scoped checkout, staging and result import, so these steps do not secretly execute filters or fetch LFS content. Use local execution for those repositories.

Only staged reference files are copied as context. Symlinks, special files, `.env` files, private key extensions, traversal and arbitrary host paths are rejected. There are at most 100 regular files, 8 MiB per file and 16 MiB total. Host home directories, agent sessions and host environment variables are not part of the transfer.

## Receipts, cancellation and ambiguous outcomes

Each invocation has a random request ID, a distinct private capability and a run/step/thread scope. Before invoking a provider, the worker exclusively claims the ID, fsyncs its receipt and directories, and reports acceptance. It records heartbeats and terminal results. The private capability is stored in the server’s `remote-worker-private` directory with owner-only file permissions and pinned to the exact configured SSH host, command and container profile. Replacing a worker alias cannot send an old recovery capability to its new target. Run records contain only worker ID, request ID, fingerprint and outcome metadata.

A reconnect inspects the same durable receipt. Reusing an ID never launches another provider process. A broken connection, missing receipt or expired heartbeat becomes **unknown**, even when the provider might already have performed work. There is no automatic execution retry or local fallback for that outcome. Inspect or cancel the request, and deliberately create a new invocation only after assessing its prior effects. Terminal receipts can re-download the validated result bundle without repeating execution. Open the agent step’s transcript and choose **Inspect remote receipt**. **Cancel remote execution** requires an explicit confirmation. These controls never launch a new turn; Resume is a separate owner action after reconciliation.

Cancellation uses the stored capability and a separate SSH control channel. The active worker checks the cancellation marker, stops the official CLI and records cancellation. A disconnected channel also aborts the scoped worker process. During a worker crash or lost host, termination cannot be confirmed until the host is inspected; an unknown receipt must not be interpreted as proof that execution stopped.

Four worker execution slots and 100 request directories are retained at most. A crashed worker can leave its slot unresolved. Inspect its recorded PID, request receipt and host processes before manually archiving the terminal request directory and clearing a stale slot file. Code-flow deliberately does not reclaim an ambiguous slot and launch duplicate work. The client keeps at most 2,000 private receipts and 32 downloaded result spools pending import or discard. Metadata-only inspection does not download a result bundle. Encrypted application backups exclude private worker capabilities, so a restored server cannot cancel or recover old remote authority automatically.

## Worker-local containers and boundaries

Optional named `containers` profiles use the same explicit agent-container configuration as local runs. Register a `containerProfile` on the server target to select a worker-local profile. Its image and authentication volume must exist and be provisioned on the worker. Local container images, host credential volumes and home folders are never inferred or copied to the worker. Availability probes run the provider’s version command inside that exact prebuilt image with no network or credential volumes; a host CLI installation is unnecessary for a container profile. The image is never pulled automatically.

Remote turns currently start fresh CLI sessions and use structured question/reply outcomes across turns. Live team tools, mid-turn steering and native interactive approval prompts are unsupported. Every result omits resumable session IDs. Final verification and independent reviews still apply to imported results. The server must enforce run/project access before exposing receipt or cancellation operations.

Source and result transfers are each limited to 64 MiB, with binary Git output capped before a transfer file is written. A source tree has at most 20,000 entries and 256 MiB of file data. Protocol frames are capped at 2 MiB, streamed events at 16 MiB and provider turns at 30 minutes. Uploads have a 30-second deadline. These transfer and application bounds do not replace OS disk quotas or a container sandbox: executable repository commands and Git object decompression can consume additional worker resources. Do not give mutually untrusted users a shared worker OS account or broader SSH credentials than their work requires.

## Validation status

The automated acceptance fixture launches the standalone worker in a separate process through an injected SSH transport. It exercises the official adapter against a fake CLI, source/context transfer, bundle import, read-only rejection, private capability ownership, restart recovery, dropped transport, cancellation, tampered bundles and changed local heads. No provider quota or external messages are used.

An additional opt-in acceptance test passed over real encrypted loopback OpenSSH: a temporary unprivileged daemon bound to 127.0.0.1, temporary host/client keys and isolated ssh -F configuration, the bundled worker process, a fake CLI, exact source transfer, result import and receipt recovery. Run it with `CODEFLOW_TEST_LOOPBACK_SSH=1 npx tsx --test test/remote-workers-ssh.test.ts`. It never modifies user SSH configuration or system settings, and reports a skip if unprivileged sshd is unavailable. No external SSH host or live provider login was tested. Validate those on an explicitly configured host before relying on unattended work. Container inventory uses an injected Docker fixture; an actual Docker worker image was not exercised in this acceptance run.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
