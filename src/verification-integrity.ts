import { git } from "./git.js";

export class VerificationIntegrityError extends Error {}

/** Checks attributed to a commit must keep its tracked checkout and index unchanged. */
export async function verificationIntegrity(repo: string, signal?: AbortSignal) {
  const options = { signal, timeoutMs: 10_000 };
  const initial = await git(["rev-parse", "--verify", "HEAD^{commit}"], repo, options);
  const tree = await git(["rev-parse", "--verify", "HEAD^{tree}"], repo, options);
  if (initial.code || tree.code) throw new VerificationIntegrityError("Cannot pin the verification checkout commit");
  const assert = async (stage: string) => {
    if (signal?.aborted) throw new VerificationIntegrityError("Verification was cancelled");
    const [head, index, unstaged, flags] = await Promise.all([
      git(["rev-parse", "--verify", "HEAD^{commit}"], repo, options),
      git(["write-tree"], repo, options),
      git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--quiet", "--exit-code", "--"], repo, options),
      git(["ls-files", "-v", "-z"], repo, options),
    ]);
    if (signal?.aborted) throw new VerificationIntegrityError("Verification was cancelled");
    const hiddenFiles = flags.stdout.split("\0").some((file) => /^[a-zS] /.test(file));
    if (head.code || index.code || unstaged.code || flags.code || hiddenFiles || head.stdout.trim() !== initial.stdout.trim() || index.stdout.trim() !== tree.stdout.trim()) throw new VerificationIntegrityError(`Verification ${stage} changed tracked files, the staged tree or the checkout commit, or hid tracked files from comparison. The original commit was not verified.`);
  };
  await assert("starting checkout");
  return { head: initial.stdout.trim(), assert };
}
