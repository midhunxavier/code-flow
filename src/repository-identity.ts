import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { readOnlyGitMetadata } from "./agent-container.js";

const identity = (common: string, device: bigint, inode: bigint) => createHash("sha256").update(JSON.stringify({ common, device: String(device), inode: String(inode) })).digest("hex");
async function metadata(repo: string) {
  const common = readOnlyGitMetadata(repo).at(-1);
  if (!common) throw new Error("Choose a verified local Git repository");
  const path = await realpath(common), info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Repository metadata ownership is unavailable");
  return { path, info };
}

/** Linked worktrees share ownership; replacing the Git metadata changes that identity. */
export async function repositoryIdentity(repo: string): Promise<string> {
  const { path, info } = await metadata(repo);
  return identity(path, info.dev, info.ino);
}
