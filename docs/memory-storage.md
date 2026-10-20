# Project memory

Open Project memory to search saved guidance, then use Knowledge graph to follow links to files, runs, commits and source memories. Review provenance before applying an entry to new work.

## Explore project knowledge

Code Flow stores private, team and project memory in `CODEFLOW_HOME/memory.sqlite` (normally `~/.codeflow/memory.sqlite`). Node **22.13 or newer** is required for the built-in `node:sqlite` driver. No database server, native npm addon, downloaded extension or extra SSH deployment asset is needed. This replaces the earlier Node 20 memory-storage baseline. SQLite is experimental in Node 22 and may print a startup warning.

## Storage and migration

The first memory access imports an existing `memory.json`. Import validates the complete legacy document, creates the schema, records every entry including tombstones and provenance, and compares the imported records with the originals before committing. Unsupported/corrupt JSON or database schemas fail closed. IDs, revisions, approvals, operation receipts and feedback are preserved. Passing the old JSON filename to `MemoryStore` resolves to the corresponding SQLite file.

After verified import, the original becomes `memory.json.pre-sqlite` with private permissions. It is a temporary rollback copy, retained until the **first mutation that changes a record**. Before writing changed records, Code Flow removes that copy and old JSON temporary snapshots so edits and deletions do not leave previous bodies in application-owned migration files. A failed database transaction can therefore leave the rollback copy removed, while the original database records remain intact. Import finalization can resume after a crash without importing duplicate records. If JSON conflicts with the import or reappears after a mutation, Code Flow reports the conflict rather than choosing a version.

To roll back before any mutation, stop Code Flow, move `memory.sqlite` aside, and rename `memory.json.pre-sqlite` to `memory.json` before using the older release. After mutations, use an explicit backup/restore workflow; the temporary import copy is no longer a current rollback source. External backups and run transcripts have their own retention.

Each mutation uses `BEGIN IMMEDIATE` and updates changed memory rows, their keyword index and graph relationships in one transaction. Existing permission, exact-revision conflict, approval, provenance and publication checks still run inside that transaction. Connections close after each operation. The database uses full synchronization, DELETE rollback journaling, private file permissions and SQLite secure deletion. Successful deletion removes the entry's text, indexed terms and owned graph edges; descendants keep their own text and provenance references. This is logical/application-file redaction, not a guarantee of erasure from filesystem snapshots or storage hardware.

The existing 32 MiB logical-document limit, 5,000 live project entries and 512 private/team entries per run remain. Mutations still inspect the bounded collection to enforce provenance and collection-wide rules, but only changed rows are written. Scoped reads use a repository/project index. This change does not claim unbounded scale or measured throughput improvements.

Offline encrypted backup recovers any interrupted SQLite transaction before copying the closed database. Restore retains its memories, indexes and graph. Retention uses database fingerprints and existing revision/provenance checks. A preview of an unmigrated JSON store does not itself migrate it.

## Search and graph

The `memories` table holds current versioned entries. `memory_terms` is an indexed Unicode keyword table; title and tag matches carry more weight than body matches. It works on Node builds without FTS5. Search is literal token matching, with at most 32 query terms and 512 matching seeds; it does not use embeddings or an external model.

The graph uses `entities` and `relationships` tables. Every relationship identifies its supplying memory and exact revision. Entities are keyed by repository and project, so identical file names in different projects do not join their graphs.

| Entity or relationship | Source |
| --- | --- |
| Memory → applies to → file/path | The entry's explicit `paths` |
| Memory → learned from → run | Its run ID and `run:` source references |
| Memory → learned from/applies to → commit | `commit:` evidence and branch applicability |
| Memory → verified at → commit | Runtime verification metadata |
| Memory → derived from → memory | Exact `derivedFrom` references |

“Derived from” means the source was in context; it does not assert that its text was copied or its claims are logically proven. The graph does not infer imports, function calls, test coverage or arbitrary relationships from prose. Agent-supplied evidence retains the memory's existing proposal/trust status. Outdated, deleted or inaccessible source-memory revisions are not resolved to current labels.

For retrieval, Code Flow first filters to accepted, visible, current, branch-applicable and path-applicable memories. Text matches seed a traversal of at most two hops through the recorded relationships (at most 1,000 edges). Connected memories receive a small ranking boost, and the selection manifest explains it. This never broadens access or path scope and cannot use a private or stale memory as a hidden bridge. Existing character and entry budgets still apply; replay resolves the exact recorded revisions rather than running search again.

Expand **Project memory → Knowledge graph** to filter connections and inspect their source revisions. The inspector includes proposals for review; it does not approve them. `GET /api/projects/:id/memory/graph?repo=<absolute-path>` exposes the same bounded, authenticated project view and reports truncation.

Run journals, settings and the older recurring-review lessons under `learnings/` retain their existing formats. SQLite is used for the structured agent-memory system; this is not a migration of all application state.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
