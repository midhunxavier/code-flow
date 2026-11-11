# Folder projects: design

Status: slice 1 is implemented (`src/folders.ts`, see section 6). Slices 2 to 4 are proposals and are not built.

This document covers letting Code Flow work on any folder, not only a Git repository: a folder of documents, a data directory, a script collection, a project that was never put under Git. The goal is the experience of the Claude and ChatGPT desktop apps (pick a folder, ask for work) while keeping what Code Flow adds on top: agents work on a copy, results are checked before they reach your files, and nothing changes in the folder until you apply.

## 1. Why the check can't simply be removed

Git is not only how Code Flow opens a project. The engine uses it for three jobs:

| Job | Where | What it needs |
|---|---|---|
| Isolation | `openWorktree` in `src/git.ts`, worktrees in `<repo>/.worktrees/<run>/` (`worktreeRoot`, `WORKTREE_DIR` in `src/config.ts:43`) | a repository to add worktrees to |
| Seeing what changed | `diffSince`, `changedFiles`, snapshots (`src/cli-teams/snapshots.ts`), resume and replay at a recorded commit | commits |
| Handing results back | `mergeInto` (`src/ship.ts:169`) for app runs, `git apply --check --index` (`src/cli-teams/handoff.ts:36`) for CLI runs | a checkout to merge or apply into |

Several hardened paths also read `<repo>/.git` straight from disk instead of asking git:

- `readOnlyGitMetadata` (`src/agent-container.ts:88`) decides what an agent container mounts read-only;
- `repositoryIdentity` (`src/repository-identity.ts`) keys stores and memory on the git folder's inode and volume;
- `src/retention-policy.ts:105` and `:230` and `src/merge-validation.ts:21` check the `.git` marker before removing or validating a workspace.

The refusals a user sees today come from `checkRepos` and `canonicalRepo` (`src/projects.ts:354`, `:367`), `src/workspace-api.ts:49`, the terminal (`src/server.ts:2605`), code hosts (`src/code-hosts.ts:165`), team links (`src/collab/runner.ts:241`, `src/collab/link.ts:174`) and the CLI connection, which serves an error-only MCP server outside a repository (`serveOutsideRepository`, `src/cli-teams/mcp.ts:176`).

## 2. Options considered

| Option | How | Verdict |
|---|---|---|
| A. `git init` for the user | A button runs `git init` and a first commit in the folder. | Keep as a shortcut. Wrong as the only answer: it writes `.git` into Dropbox folders, Documents, thesis directories. |
| B. Pinned git folder | Keep the git folder in `~/.codeflow`, point git at the user's folder with `GIT_DIR` and `GIT_WORK_TREE`. The `Checkout` type in `src/git.ts` already pins both. | Rejected. Every `git(args, repo)` call with a string path would need the pin, and the direct `.git` readers above would all need a folder-aware path. That touches the most security-sensitive code. Git would also run with the user's folder as its work tree. |
| C. Mirror repository | Code Flow keeps a real repository of its own whose files are a copy of the folder. Runs use the mirror exactly as they use a repository today. Two new operations move files between folder and mirror. | **Chosen.** The engine, sandboxes, identity and retention code see an ordinary repository and stay unchanged. All new code sits at the folder boundary. |
| D. Edit in place | One agent edits the folder directly, with before and after snapshots for undo, like the desktop apps. | Not now. No parallel teams and no checked-before-apply guarantee. Could come later as a per-run option on top of C. |

The cost of C is disk space (one copy of the folder, bounded by the limits in 4.3) and the time to copy changed files at each import.

## 3. Terms

- **Folder**: the user's directory, as they picked it (real path).
- **Mirror**: `~/.codeflow/folders/<id>/source/`, an ordinary non-bare Git repository on branch `main`, owned by Code Flow. The user never edits it.
- **Import**: copy the folder's current files into the mirror and commit them.
- **Export**: write a result's changed files from the mirror back into the folder.
- **Manifest**: for the last import, each path's size, modification time, mode and blob hash.

## 4. Design

### 4.1 Projects

A folder joins a project as its mirror: `Project.repos` (`src/projects.ts:30`) holds the mirror's path, and a run records `repo = mirror`. Every consumer of `run.repo` keeps working against a real repository.

The mirror records which folder it copies, in `~/.codeflow/folders/<id>/folder.json`:

```ts
interface FolderMeta {
  version: 1;
  path: string;        // the user's folder, real path
  inode: string;       // the folder's inode when added, to notice a folder that was replaced
  createdAt: number;
}
```

`<id>` is `f-` and the first 16 hex digits of the SHA-256 of the folder's real path, so one folder has one mirror, whichever projects hold it. Projects don't save the folder. Each copy of a project a caller gets carries `folders: { mirror, path }[]`, read from the mirrors. Code that talks to the user's files finds the folder with `folderOfMirror(run.repo)`.

One project can hold repositories and folders together; a run works in one of them, as today.

`checkRepos` gains a folder branch: a path that is not inside a repository becomes the folder's mirror after the guards in 4.2 (`ensureFolderMirror`). A path inside a repository still resolves to that repository. A path inside a folder that already has a mirror resolves to that mirror.

### 4.2 Which folders are allowed

Refused, with a message that says why:

- `/` and its first-level folders (such as `/Users` and `/Volumes`), the home folder itself and `~/Library`;
- system folders: `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/etc`, `/private`, `/var`, `/dev`, `/opt`, `/cores`, except the temporary folder and `/private/tmp` (Windows equivalents are not built yet);
- `CODEFLOW_HOME`, anything inside it, and any folder that holds it (its tokens would be copied);
- a folder inside a Git repository (use the repository);
- a folder whose first import exceeds the limits in 4.3.

A nested `.git` directory inside the folder is not imported. Its subtree is skipped and the import lists it (`reason: "repository"`); slice 4 shows "Skipped `sub/`: it is a Git repository; add it as one."

### 4.3 Import (folder to mirror)

When it runs: before a run starts (built), and, in later slices, before a side chat starts, before an export (4.5), and when the Files panel refreshes. There is no file watcher. A folder's first import happens when its mirror is created.

How:

1. Walk the folder with Node, without following symbolic links.
2. Skip built-in excludes: `.git/`, `node_modules/`, `.DS_Store`, `Thumbs.db`, `__pycache__/`, `.venv/`, `.codeflow-context/`, and the mirror's own `.worktrees/`.
3. Honour the folder's own `.gitignore` files: copy them into the mirror first, then filter candidate paths with `git check-ignore --stdin` in the mirror (the same call `src/repo-tree.ts:93` uses).
4. Copy only paths whose size, modification time or mode differ from the manifest, and delete mirror files whose folder file is gone. Each file is written to a temporary name and renamed.
5. A relative symbolic link whose target stays inside the folder is copied as a link. Any other link is skipped and listed: an absolute link into the folder would still point into the user's folder from a worktree. Files are opened with `O_NOFOLLOW`, so a file swapped for a link mid-import is not followed.
6. `git add -A` and commit `Folder snapshot` with the fixed Code Flow identity, only if the tree changed. Write the new manifest.

Limits (`CODEFLOW_FOLDER_MAX_FILES`, `CODEFLOW_FOLDER_MAX_MB`, `CODEFLOW_FOLDER_MAX_FILE_MB`; defaults to be agreed): 20,000 files, 1 GiB in total, 50 MiB per file. A file over the per-file limit is skipped and listed. A folder over the total limits is refused, with the largest directories named so the user can add a `.gitignore`.

The import commit is the run's `baseRef`. Setup, the check, verification-profile detection and readiness run against the mirror with no changes.

### 4.4 Runs

Almost no engine change. `RunManager.start` and `validateStart` accept a folder path that already has a mirror, and the run's preparation imports the folder before it resolves the base commit. Worktrees live in `<mirror>/.worktrees/` (the default `worktreeRoot`). The mirror's `info/exclude` lists Code Flow's folders (`ensureCodeflowExcludes`), and the import never touches them.

### 4.5 Export (mirror to folder)

A result reaches the mirror's `main` through the existing paths: `mergeInto` for app runs and handoff apply for CLI runs. The mirror's checkout is Code Flow's and is clean after an import, so neither path changes. Export then writes the result into the folder.

1. **Import first.** This captures edits the user made during the run.
2. **List the changes.** List the paths that differ between the run's base import commit and the new `main`.
3. **Preflight every path before writing anything.** A path is safe when the folder's current file has the hash the manifest recorded at the base import, or when it is absent at both. Anything else is a conflict: the user edited a file the result also changes. If any path conflicts, nothing is written, and the paths go to **Resolve conflicts** with the base, the user's version and the result.
4. **Refuse unsafe targets.** Refuse any path whose parent resolves outside the folder, or that passes through a symbolic link.
5. **Write.** Write each file to a temporary name in the same directory, keep its mode, and rename.
6. **Deletions.** Deleted paths move to `~/.codeflow/folders/<id>/removed/<timestamp>/`; nothing is deleted outright.
7. **Record.** Record the export, so **Undo apply** can restore the written and removed files. Undo runs the same preflight against the result.

CLI handoff (`codeflow_apply_handoff`) says "Applied to the folder" instead of "staged". A folder has no index.

### 4.6 What a folder project does not offer

These are hidden for folder sources and refused by their APIs with "This project is a folder, not a Git repository":

- branches, push, pull requests, GitHub and code hosts, review threads;
- team-collaboration hub sync and checkpoints, until a design covers mirrors;
- webhook-triggered automations (schedules still work).

**Make it a Git repository** (option A) is offered where these would be. It runs `git init` and a first commit in the folder, after showing the user exactly what it will write. It then converts the source to a repository and, after the user confirms, removes the mirror. Run history stays in the project.

The terminal (`src/server.ts:2605`) opens in the folder for a folder project.

### 4.7 CLI and MCP connection

`serveMcp` (`src/cli-teams/mcp.ts:21`) currently calls `serveOutsideRepository` when started outside a repository. Instead:

- If the folder passes 4.2, serve folder mode. Proposals and the proposal card show "Folder (not a Git repository)" and the folder path. Results are applied by export (4.5).
- If it fails 4.2, which is common because CLIs often start in the home folder, keep today's error with the reason, and suggest starting in a project folder.

The messages in `src/cli-teams/install.ts:28`, `:162` and `src/cli-teams/cli.ts:83` change from "any Git repository" to "any project folder".

### 4.8 Identity, memory and moved folders

`repositoryIdentity(mirror)` works unchanged, so stores and memory are keyed on the mirror. An import of a folder that moved or was deleted fails with "The folder … no longer exists". Slice 4 adds **Locate** to the project. Locate accepts a folder only when its inode matches the one recorded in `folder.json`, or when the user confirms that it is the same folder; this stops a different folder from receiving a result. Slice 2 checks the inode before every export. Removing a folder project deletes its mirror after confirmation.

### 4.9 UI

- **Adding a project:** **Open folder…** next to **Add repository**. When the picked folder is inside a repository, offer the repository instead.
- **First folder project:** a one-line note: "Code Flow works on a private copy. Your folder changes only when you apply a result."
- **Composer and run header:** show a folder badge.
- **Diff view:** handles binary files ("binary file changed", sizes).

## 5. Security

- **Mirror placement:** the mirror sits under `CODEFLOW_HOME`, which also holds tokens. Checked for slice 1 by reading the adapters, not by running each provider: write access follows the run's worktree (Codex `workspace-write` with no extra writable roots, the agy sandbox profile's workspace subpath, container mounts of the worktree and its git metadata). None of them grants anything because the worktree is under `CODEFLOW_HOME`, and what a provider could already read is unchanged. Moving mirrors to a separate root (`CODEFLOW_FOLDERS_DIR`) stays possible if a provider check shows otherwise. See open question 1.
- **No git in the user's folder:** import and export never run git with the user's folder as a work tree, and never follow symbolic links.
- **Mirror config:** the mirror's git config is Code Flow's: no hooks, no filters. A `.gitattributes` copied from the folder that names a filter driver has no effect, because the driver is not defined.
- **Export scope:** export writes only paths in the result's diff, never `.codeflow-context/`, and only inside the folder.

## 6. Slices

1. **Folder sources and runs on a mirror (implemented).** Covers 4.1 to 4.4. Any pattern can run on a folder, because nothing it produces can leave the mirror yet: merging, pull requests and pushes (`managedShipping` in `src/engine.ts`) and CLI handoff (`prepareHandoff` in `src/cli-teams/handoff.ts`) are refused for a mirror, saying that applying to a folder isn't available yet. A run started on a folder path (`POST /api/runs`) creates the folder's mirror on first use. A run started on a mirror imports the folder first. A project created or edited with a folder path takes the folder's mirror. Tests: `test/folders.test.ts` covers the guards, the import (ignores, links, limits, nested repositories, incremental copy, Code Flow's own folders in the mirror), projects, and a run that starts from a fresh import and can't be merged back. Not yet: the UI still names a mirror by its last path segment (`source`) in places such as the composer; slice 4 fixes that.
2. **Write runs and export.** Covers 4.5 (preflight, conflicts, removal folder, undo) and the 4.6 refusals. Tests: an edit during a run conflicts, nothing is partly written, undo, paths outside the folder are refused.
3. **CLI and MCP folder mode.** Covers 4.7.
4. **UI.** Covers 4.9, **Make it a Git repository**, and **Locate**. The browser e2e covers adding a folder, a run and an apply, with accessibility at zero violations.

## 7. Open questions

1. **Mirror location:** inside `CODEFLOW_HOME` (as built) or in a separate root (see section 5)? Confirm with a real run on each provider.
2. **Limits:** are 20,000 files, 1 GiB and 50 MiB per file the right defaults?
3. **Import timing:** is importing at defined moments enough, or do users expect the Files panel to follow their edits live?
4. **Edit in place (option D):** should it come later for single-agent chats that feel like the desktop apps?
5. **Team collaboration:** should a linked runner ever work on a folder project, and how would a checkpoint name a folder?
