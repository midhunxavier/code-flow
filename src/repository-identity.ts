import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { readOnlyGitMetadata } from "./agent-container.js";

/** Linked worktrees share ownership; replacing the Git metadata changes that identity. */
export async function repositoryIdentity(repo: string): Promise<string> {
  const common = readOnlyGitMetadata(repo).at(-1);
  if (!common) throw new Error("Choose a verified local Git repository");
  const path = await realpath(common), info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Repository metadata ownership is unavailable");
  return createHash("sha256").update(JSON.stringify({ common: path, device: String(info.dev), inode: String(info.ino) })).digest("hex");
}
