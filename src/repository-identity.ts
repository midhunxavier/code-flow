import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { readOnlyGitMetadata } from "./agent-container.js";

const identity = (common: string, device: bigint | string, inode: bigint) => createHash("sha256").update(JSON.stringify({ common, device: String(device), inode: String(inode) })).digest("hex");
/** macOS renumbers st_dev across boots. Use the volume UUID, retaining separation between disks. */
async function volumeIdentity(path: string): Promise<string> {
  const options = { timeout: 5000, maxBuffer: 128 * 1024, env: { ...process.env, LC_ALL: "C" } };
  const output = (command: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  const disks = await output("/bin/df", ["-P", path]);
  const disk = disks.trim().split("\n").at(-1)?.match(/^(\/dev\/disk\d+(?:s\d+)*)\s/)?.[1];
  if (!disk) throw new Error("Repository volume identity is unavailable");
  const info = await output("/usr/sbin/diskutil", ["info", "-plist", disk]);
  const uuid = info.match(/<key>VolumeUUID<\/key>\s*<string>([a-f\d-]+)<\/string>/i)?.[1];
  if (!uuid) throw new Error("Repository volume identity is unavailable");
  return `volume:${uuid.toLowerCase()}`;
}
async function metadata(repo: string) {
  const common = readOnlyGitMetadata(repo).at(-1);
  if (!common) throw new Error("Choose a verified local Git repository");
  const path = await realpath(common), info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Repository metadata ownership is unavailable");
  return { path, info };
}

/** Linked worktrees share ownership; replacing the Git metadata changes that identity. */
export async function repositoryIdentity(repo: string): Promise<string> {
  return (await repositoryIdentities(repo)).current;
}

/** Only an exact legacy match may migrate automatically; mismatched history stays on hold. */
export async function repositoryIdentities(repo: string): Promise<{ current: string; legacy: string }> {
  const { path, info } = await metadata(repo);
  const legacy = identity(path, info.dev, info.ino);
  return { current: process.platform === "darwin" ? identity(path, await volumeIdentity(path), info.ino) : legacy, legacy };
}
