import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, resolveCommit, git, openDetachedWorktree, removeDetachedWorktree } from "./git.js";
import { readRepoConfig } from "./repo-config.js";
import { checkGit, doctor } from "./doctor.js";
import { detectCheckCommand, runCheck } from "./checks.js";
import { Slots } from "./slots.js";
import { redactText } from "./privacy.js";

export interface ReadinessItem { id: string; label: string; status: "passed" | "failed" | "warning" | "skipped"; detail?: string }
export interface ReadinessInput { repo: string; baseRef?: string; setup?: string; check?: string; execute?: boolean; signal?: AbortSignal }
const validationSlots = new Slots(1);

/** Commands are opt-in and run at a pinned commit in a disposable detached worktree. */
export async function inspectReadiness(input: ReadinessInput) {
  const repo = await repoRoot(input.repo);
  const base = await resolveCommit(repo, input.baseRef || "HEAD");
  const [{ config, found, error }, health, gitHealth, detection, dirty] = await Promise.all([
    readRepoConfig(repo), doctor({}), checkGit(), detectCheckCommand(repo), git(["status", "--porcelain"], repo),
  ]);
  const setup = input.setup === undefined ? config.setup ?? detection?.setup : input.setup.trim();
  const check = input.check === undefined ? config.check ?? detection?.command : input.check.trim();
  const items: ReadinessItem[] = [
    { id: "git", label: "Git", status: gitHealth.ok ? "passed" : "failed", detail: gitHealth.warning ?? gitHealth.version },
    { id: "repository", label: "Repository and base", status: "passed", detail: `${repo} · ${base.slice(0, 12)}` },
    { id: "configuration", label: "Repository configuration", status: error ? "failed" : "passed", detail: error ?? (found ? "Using .codeflow/config.json" : "Using detected defaults") },
    { id: "working-copy", label: "Working copy", status: dirty.stdout.trim() ? "warning" : "passed", detail: dirty.stdout.trim() ? "Uncommitted changes are not part of validation at the selected commit." : "Clean" },
    ...health.map((agent): ReadinessItem => ({ id: `agent-${agent.id}`, label: agent.name, status: !agent.installed ? "skipped" : agent.compatible === false || agent.signedIn === false ? "failed" : agent.signedIn === null ? "warning" : "passed", detail: agent.fix ?? [agent.version, agent.signedIn === true ? "Signed in" : agent.signedIn === null ? "Authentication unknown" : "Not signed in"].filter(Boolean).join(" · ") })),
    { id: "check", label: "Verification command", status: check ? "passed" : "warning", detail: check || "No check configured; completion cannot be independently verified." },
  ];
  if (!health.some((agent) => agent.installed && agent.compatible !== false && agent.signedIn !== false)) items.push({ id: "available-agent", label: "Usable agent", status: "failed", detail: "Install and sign in to at least one compatible coding agent." });
  if (input.execute && !error) {
    await inTemporaryWorktree(repo, base, async (path, opened) => {
      if (opened.warning) items.push({ id: "submodules", label: "Submodules", status: "warning", detail: opened.warning });
      let setupOk = true;
      for (const [id, command] of [["setup-run", setup], ["check-run", check]] as const) {
        if (!command || !setupOk) { items.push({ id, label: id === "setup-run" ? "Setup execution" : "Check execution", status: "skipped", detail: !setupOk ? "Setup failed" : "No command configured" }); continue; }
        const result = await runCheck(path, command, { timeoutMs: 120_000, signal: input.signal });
        items.push({ id, label: id === "setup-run" ? "Setup execution" : "Check execution", status: result.ok ? "passed" : "failed", detail: redactText(result.output.slice(-8000) || `${command}: exit ${result.exitCode}`) });
        if (id === "setup-run") setupOk = result.ok;
      }
    }, input.signal);
  }
  return { ok: !items.some((item) => item.status === "failed"), repo, base, setup, check, executed: input.execute === true, items, checkedAt: Date.now() };
}

export async function inTemporaryWorktree<T>(repo: string, ref: string, run: (path: string, opened: { warning?: string }) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await validationSlots.acquire(signal);
  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), "codeflow-validation-"));
    const path = join(folder, "checkout");
    try {
      const opened = await openDetachedWorktree(repo, path, ref, { signal });
      return await run(path, opened);
    } finally { await removeDetachedWorktree(repo, path); }
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
    release();
  }
}
