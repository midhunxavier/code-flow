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

Symbolic links, special files, temporary files, server locks, process registries, phone settings/device sessions, session credential files, team connection/capability files, `.env` files and private-key files are omitted. The command reports every omitted path. Restore also excludes this material from older archives. Reconfigure phone pairing and credentials after restoring.

Restored automations are disabled, their webhook tokens are rotated, and queued deliveries are cleared. Review each automation, update its webhook sender with the new token, and deliberately enable it again. This prevents old schedules or deliveries from running immediately after recovery.

Restored external notification settings are also disabled. Pending or in-flight notification deliveries are cancelled; destinations must be reviewed and deliberately enabled again.

Git worktrees and repositories outside `CODEFLOW_HOME` are not included. Back them up separately when they contain needed commits or uncommitted work. The password is required for recovery and cannot be recovered from code-flow.

## Run retention

```sh
npx tsx scripts/maintenance.ts retention --days 90
npx tsx scripts/maintenance.ts retention --days 90 --apply
```

The first command previews candidates and byte counts. `--apply` deletes only logs, recovery journals and checkpoints belonging to archived runs whose last log modification predates the cutoff and whose status is `done`, `failed`, or `cancelled`. Running, interrupted, stopped, unarchived, unreadable and recently modified runs are kept. Logs larger than 64 MiB are skipped with a reason.

Retention removes transcripts and recovery evidence for the selected runs. Memory entries may retain descriptive provenance referring to those run IDs; the removed transcripts will no longer be available. Projects, notes, memory bodies, attachments and Git worktrees are kept. Preview the exact candidate IDs and create a backup before deleting data you may need again.

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
