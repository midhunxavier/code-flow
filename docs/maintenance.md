# Offline data maintenance

Stop the code-flow server before running maintenance. Every operation against an existing data directory takes the same exclusive `server.lock` as the server and refuses to run while another server holds it. A restore writes a new directory and never merges into existing data.

The commands use `CODEFLOW_HOME` by default. Pass `--home /absolute/data/path` to choose another data directory.

## Encrypted backup and restore

Supply a password through `CODEFLOW_BACKUP_PASSWORD` using your shell or secret manager. Do not put it in command arguments. Passwords must contain 12–1,024 characters. The CLI never prints the password or file contents.

```sh
npx tsx scripts/maintenance.ts backup --output /backups/codeflow.cfb
npx tsx scripts/maintenance.ts restore --input /backups/codeflow.cfb --destination /new/codeflow-data
```

Backups use AES-256-GCM authenticated encryption with a fresh 16-byte salt, 12-byte nonce, and a 32-byte key derived with scrypt (`N=32768`, `r=8`, `p=1`). The compressed manifest contains each file's length and SHA-256 digest. No plaintext archive is written to disk. Output files use mode `0600`; restored directories use `0700` and files `0600` on supported platforms.

Backups are limited to 256 MiB of file data and 20,000 files. Restores bound archive and decompression size and reject invalid manifests, duplicates, traversal paths, damaged data, wrong passwords, and existing destinations. The output directory must exist and the backup must be outside the data directory. Output files are created exclusively and existing backups are never overwritten.

Symbolic links, special files, temporary files, server locks, process registries, phone settings/device sessions, shared account password/session stores, session credential files, team connection/capability files, the team link file `team-link.json` (this computer's runner credential for a team server, with its temporary and set-aside copies), remote-worker private capability receipts, `.env` files and private-key files are omitted. The command reports every omitted path. Restore also excludes this material from older archives. Recreate shared accounts, reconfigure phone pairing and credentials and connect a linked computer to its team server again after restoring; the team board itself (`team/`) and the local attempt records (`team-link/attempts/`) are included.

Restored automations are disabled, their webhook tokens are rotated, and queued deliveries are cleared. Review each automation, update its webhook sender with the new token, and deliberately enable it again. This prevents old schedules or deliveries from running immediately after recovery.

Restored external notification settings are also disabled. Pending or in-flight notification deliveries are cancelled; destinations must be reviewed and deliberately enabled again.

Restored deferred jobs are never dispatched automatically. Pending, waiting, claimed, failed and unknown jobs become cancelled with a restore-history entry. Existing started receipts remain metadata. Review the recovered configuration and explicitly retry a cancelled job only when you intend to launch it; saved claim and run IDs remain available for investigation. Malformed deferred storage aborts the restore.

Restored coordinated changes also disable all implicit dispatch. Exact launch, dependency and shipping receipts remain available for manual investigation; pending tasks become cancelled, and claimed side effects become unknown. Deliberately recover or retry only after reviewing existing runs and local commits. Invalid coordinated storage aborts the restore.

Git worktrees and repositories outside `CODEFLOW_HOME` are not included. Back them up separately when they contain needed commits or uncommitted work. The password is required for recovery and cannot be recovered from code-flow.

## Saved per-type retention

Open **Settings → Data & storage** to save separate ages for archived run records, attachments, private/team memory and linked workspaces. Every type starts disabled; a blank age keeps that data. You can protect specific run and memory IDs. Settings are revisioned, and concurrent saves cannot overwrite each other. Saving settings never deletes data.

Select **Preview saved retention policy**, review the exact targets and protected reasons, then download the manifest. The preview fixes the cutoff, policy revision, source references and file identities. It contains paths and IDs, without memory bodies or titles. It expires after 24 hours. Stop the server before applying that downloaded file:

```sh
npm run maintenance -- retention-policy --plan /downloads/codeflow-retention.json --apply --home /absolute/data/path
```

For an entirely offline workflow, save settings from a JSON file, produce a preview and then apply that exact preview. An existing output file is never overwritten:

```sh
npm run maintenance -- retention-settings --input /path/retention-settings.json
npm run maintenance -- retention-policy --output /path/reviewed-plan.json
npm run maintenance -- retention-policy --plan /path/reviewed-plan.json --apply
```

Example settings keep attachments and workspaces indefinitely, retain private/team memory for 180 days, and retain eligible archived run records for 90 days:

```json
{
  "days": { "archivedRuns": 90, "attachments": null, "memory": 180, "worktrees": null },
  "keepRunIds": ["important-run-id"],
  "keepMemoryIds": []
}
```

Apply takes the exclusive server lock and rebuilds the manifest using its original cutoff. Any changed policy, file identity, source reference, worktree state or supplied manifest rejects the entire plan before deletion starts. A partial scan cannot be applied. The scan bounds are 2,000 runs, 50,000 live memory entries, 1,000 targets, 100,000 files and 256 MiB of read data; individual logs are limited to 64 MiB. Keep other tools from changing repositories during offline apply. If an I/O error occurs after deletion begins, the result lists applied, failed and remaining targets; stop and create a fresh preview before another attempt.

Running, paused, interrupted, stopped, unarchived, pinned and watched runs are protected. Retained child runs, selective-rerun baselines, enabled automations and pending deferred jobs preserve their parent sources. Retained coordinated-change launch, dependency and shipping receipts protect their exact run records. Project knowledge is never bulk-deleted. Pinned memory, memory used by active/resumable/kept runs, and sources referenced by retained derived memory are protected. Remaining live memory preserves its origin transcripts, attachments and workspaces.

Eligible old private/team memory bodies are erased atomically while their provenance tombstones remain. Attachment retention deletes only bounded regular files in known staging/generated context directories and refuses tracked repository files or symlinked ancestors. Workspace retention requires verified managed linked Git ownership, a clean index and worktree, no hidden tracked changes, no nested repository/submodule, and no Git lock. Removal uses Git without force and preserves branches. Run retention removes only the selected terminal archived logs, journals and checkpoints. These changes remove recovery evidence, so review the preview and back up data you still need.

The older `retention --days 90` command remains an age-only report and does not assess pins or provenance. Its unguarded `--apply` behavior has been removed. Existing scripts must migrate to a reviewed `retention-policy` manifest; the compatibility alias `retention --plan /path/reviewed-plan.json --apply` uses the same protected exact-plan apply.

## Log compaction

```sh
npx tsx scripts/maintenance.ts compact --id RUN_ID
npx tsx scripts/maintenance.ts compact --id RUN_ID --apply
```

Compaction previews savings unless `--apply` is supplied. It keeps the first and latest run metadata snapshots and every transcript, step, check, and log event. Recovery journals remain byte-for-byte unchanged. Intermediate metadata snapshots are removed; their event sequence numbers are not renumbered. The replacement is synced and renamed atomically, and its old optional checkpoint is invalidated. Only terminal run logs up to 64 MiB are supported; incomplete or corrupt logs are rejected.

## Startup checkpoints

`appendLine(file, event, { checkpoint: { seq, run } })` captures a complete run snapshot, including steps, at call time. The existing serialized writer appends the authoritative event, reads its exact file identity, and atomically writes `<run-id>.checkpoint.json` before the next queued append.

`readRunCheckpoint<T>(id)` returns `{ run, seq }` only when the version, checksum, run ID, steps, safe sequence number and source file identity match. Source identity includes length, nanosecond modification/change times, device and inode. A subsequent append, replacement, malformed or oversized cache, or missing file falls back to journal reconstruction. Reads are bounded to 16 MiB. Cache write failures update `checkpointHealth` and never reject an authoritative append or poison the write queue.

Checkpoints speed up startup but are optional projections. JSONL logs and recovery journals remain the source of truth and are preserved until an explicit retention or compaction operation.
