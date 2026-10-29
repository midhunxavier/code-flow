import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryIdentity, repositoryIdentities } from "../src/repository-identity.js";

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(tmpdir(), "codeflow-identity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo"); await fs.mkdir(repo);
  const git = (...args: string[]) => childProcess.execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
  return { repo, directory, git };
}

test("linked worktrees share identity and replaced Git metadata does not", async t => {
  const { repo, directory, git } = await fixture(t);
  const before = await repositoryIdentity(repo), linked = join(directory, "linked");
  git("worktree", "add", "--detach", linked, "main");
  assert.equal(await repositoryIdentity(linked), before);
  await fs.rename(join(repo, ".git"), join(directory, "old-git"));
  git("init", "-q", "-b", "main");
  assert.notEqual(await repositoryIdentity(repo), before);
});

test("macOS disk renumbering preserves ownership but a different volume does not", { skip: process.platform !== "darwin" }, async t => {
  const { repo } = await fixture(t), before = await repositoryIdentities(repo);
  const lstat = fs.lstat;
  const stats = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const info = await lstat(...args);
    return new Proxy(info, { get: (target, key) => key === "dev" ? BigInt(target.dev) + 3n : Reflect.get(target, key) });
  });
  syncBuiltinESMExports();
  t.after(() => { stats.mock.restore(); syncBuiltinESMExports(); });
  const renumbered = await repositoryIdentities(repo);
  assert.equal(renumbered.current, before.current);
  assert.notEqual(renumbered.legacy, before.legacy);

  const exec = childProcess.execFile;
  const diskutil = t.mock.method(childProcess, "execFile", (...args: any[]) => {
    if (args[0] === "/usr/sbin/diskutil") {
      const callback = args.at(-1);
      args[args.length - 1] = (error: Error | null, stdout: string, stderr: string) => callback(error,
        stdout.replace(/(<key>VolumeUUID<\/key>\s*<string>)[^<]+/,
          (_: string, prefix: string) => `${prefix}00000000-0000-0000-0000-000000000000`), stderr);
    }
    return (exec as Function)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { diskutil.mock.restore(); syncBuiltinESMExports(); });
  assert.notEqual(await repositoryIdentity(repo), before.current, "path and inode cannot hide a volume replacement");
});
