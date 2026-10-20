# Filtered Docker tasks

Use a filtered task when only selected project files should reach a container. Inspect the snapshot, provision its runtime explicitly, and review the returned branch before importing changes.

## Run against a bounded snapshot

Project → Repository tools → Filtered tasks → Filtered Docker task runs one explicitly requested provider turn against a bounded, isolated committed snapshot. This is the enforcing execution path for custom project file policies. Normal native, SSH, automated and multi-agent runs remain refused while any custom restriction is active.

Select the project/repository, supported provider (`claude`, `codex`, `agy`), an already prepared local Docker image, instructions and a 1–30 minute limit. Network defaults off; enable it deliberately when the provider needs remote inference. The service resolves the local image to an immutable SHA-256 ID and uses that ID for dispatch. No images are pulled, no host-provider probe or login runs, and no fallback launches a host CLI. A local Docker context is required.

## Filesystem and runtime boundary

Only policy-readable regular committed files are exported. Every applicable current project policy and pinned policy intersects; choosing a different project cannot widen access. The export is a fresh Git repository with one synthetic commit and no original objects, history, remotes, alternates, hooks or configuration. Ignored/uncommitted files, private application memory, notes, context attachments and host credentials are not copied. Readable source symlinks/Gitlinks, path collisions and unsupported names are refused. Export limits are 500 files, 512 KB per file and 16 MB aggregate content.

The container receives only that export, its synthetic Git metadata mounted read-only, any readable copied files denied writes mounted read-only, and an exact generated schema file when the official adapter needs one. The parent job store, original repository/common Git directory, host home, authentication volumes, environment and Docker socket are never mounted or forwarded. Container labels and extra readonly mounts come from a server-only object-identity capability; serialized client settings cannot grant it.

The image root filesystem is read-only. `/tmp` is a 256 MB tmpfs and a fresh `/home/codeflow` is a 128 MB tmpfs, owned by the runtime UID/GID. Capabilities are dropped, privilege escalation is disabled, and PID, memory and CPU limits apply. The export is watched for excessive entries, depth, logical/allocated bytes and unsupported links; excess aborts the task and requires confirmed daemon removal. Final scans have the same aggregate entry/deadline bounds. Bind-directory monitoring is best-effort polling, **not an OS disk quota**: output can overshoot between scans. Newly generated forbidden output is refused wholesale; it never reaches the original repository.

An owner-prepared image and Docker's own isolation are trusted inputs. Its intentionally provisioned provider identity can access that provider, and enabled network can reach external services; this feature is not an internet-egress allowlist. The app does not inspect image credentials. Other owner-controlled OS processes and external repository edits are outside the container boundary.

## Preparing authentication without host caches

A login baked under `/home/codeflow` is hidden by the fresh home mount. Ordinary `agentContainer.authVolume` profiles are intentionally unsupported for filtered tasks: a shared volume can retain conversations or repository data from another policy. Prepare a private runtime with a launcher that copies **only its deliberately provisioned credential file** from an immutable in-image seed into the fresh runtime home, then executes the official CLI. Do not copy a host home, provider session directory, Git configuration or repository into the image.

For example, install the official Codex binary in a reviewed base image at `/opt/vendor/bin/codex`, and provide this `/usr/local/bin/codex` launcher:

```sh
#!/bin/sh
set -eu
umask 077
mkdir -p "$CODEX_HOME"
cp /opt/codeflow-credential-seed/codex/auth.json "$CODEX_HOME/auth.json"
printf 'cli_auth_credentials_store = "file"\n' > "$CODEX_HOME/config.toml"
exec /opt/vendor/bin/codex "$@"
```

Provision a separate container from that base, with no host mounts or repository, using the vendor's own login flow. For Codex, choose file credential storage, set `CODEX_HOME=/opt/codeflow-credential-seed/codex`, then run the installed binary's `login --device-auth` flow if your account permits device login. Keep only the credential file in the seed, set its ownership for the runtime UID/GID, and save the deliberately authenticated runtime as a **private local image**. The app runs containers as the host UID/GID (65532 where unavailable). Follow [OpenAI's authentication documentation](https://developers.openai.com/codex/auth/) for file storage, device-login requirements and token handling.

The seed is itself a credential: anyone who can read the image can read it. Never publish that image. Its runtime copy can refresh during a turn, but the refreshed home is discarded; when its seed expires or is invalidated, provision a fresh private image instead of copying shared session caches back into the application. Claude and Antigravity need equivalent provider-specific launchers using their own supported login/storage flow. The app never reads, exports or copies OAuth credentials itself. An offline prepared provider needs no credential seed and can keep networking disabled.

The real Docker fixture tests this exact fresh-home launcher mechanism with an in-image dummy credential and fake provider binary, plus actual namespace/readonly enforcement. It does not authenticate real providers or consume model quota.

## Review, import, cancellation and cleanup

After the turn, daemon container absence must be confirmed before inspecting output. Untrusted exported `.git` is removed; the host never asks it to execute Git commands. Bounded regular bytes, additions, deletions and executable modes are validated directly. Changed paths must be both readable and writable under the pinned/current policies. Policy/project membership and source HEAD are rechecked before dispatch, after completion, preview and import. Stored policy snapshots must have valid content hashes; enforcement uses freshly authorized canonical rules. Stored source blob identities must match their exact original committed paths.

Preview shows bounded original/result content, hashes and any binary/truncation flags. **Import into new review branch** is separate and explicit. Import checks the exact job revision/result hash/source HEAD, current policy identities, original changed-file bytes/modes, original staged blob/mode and new-path absence. These checks repeat after the durable importing receipt. Host Git uses a sanitized environment, disabled replacements/lazy fetch/fsmonitor/hooks/global/system attributes, disabled automatic maintenance and object-only writes without filters. A private index starts from the original source tree; only permitted changes are replaced. An atomic Git transaction verifies original HEAD and creates a uniquely named `codeflow/filtered-…` branch. Original checkout, index and denied base-tree files stay unchanged. The permanent commit message contains only the task ID; private instructions stay in the application record.

Preparing/running/importing receipts are fsynced before their effects. A restart converts unfinished phases to `unknown`, never retries or imports them. A running/preparing cancellation aborts preparation/provider work, waits for it to settle, removes owned labelled daemon containers and verifies absence before marking stopped. An interrupted import requires **Inspect interrupted import receipt**: an exact matching branch proves publication; proven absence permits a separately requested future import; a mismatched branch stays blocked. Unknown daemon receipts also block policy activation until explicitly cancelled and confirmed stopped.

History holds at most 100 jobs. **Delete private task and export** uses the current revision and is available only for terminal, confirmed-stopped jobs without an ambiguous import. It removes the private record/export, fsyncs the parent and preserves any imported review branch. There is no implicit retention deletion, branch removal or automatic merge.

## API and tests

All endpoints are owner-only, including `/api/v1` aliases. `GET /api/filtered-tasks?project=…` returns metadata; `GET /:id` returns detail only while its current policy identity still matches. `POST /api/filtered-tasks` accepts `{project,repo,task,agent,image,network?,maxMinutes?}` and returns 202. `POST /:id/preview-import` produces a bounded preview; `/import` accepts `{revision,expectedHead,resultHash}`. `/cancel` and `/receipt` accept `{revision}`. `DELETE /:id` accepts `{revision}`. Closed routes reject extra path segments. These requests participate in the filesystem activation barrier; policy activation refuses any preparation, import or unconfirmed daemon work.

Run the regular filtered task, lifecycle, limits and browser suites for CAS/races/restore/UI evidence. Run `CODEFLOW_TEST_DOCKER=1 node --import tsx --test test/filtered-tasks-docker.test.ts` for real Docker namespace, original Git/denied blob absence, readonly mounts, fresh-home credential seeding, branch import and cancellation removal. The Docker fixture builds/removes its own small image and never contacts a model provider.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
