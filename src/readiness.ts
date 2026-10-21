import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, resolveCommit, git, openDetachedWorktree, removeDetachedWorktree } from "./git.js";
import { readRepoConfig } from "./repo-config.js";
import { checkGit, doctor } from "./doctor.js";
import { detectCheckCommand, runCheck } from "./checks.js";
import { Slots } from "./slots.js";
import { AGENT_IDS } from "./adapters/index.js";
import { redactText } from "./privacy.js";

export interface ReadinessItem { id: string; label: string; status: "passed" | "failed" | "warning" | "skipped"; detail?: string }
export interface ReadinessInput { repo: string; baseRef?: string; setup?: string; check?: string; execute?: boolean; pattern?: string; roles?: Record<string, string | string[]>; providers?: string[]; signal?: AbortSignal }
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
    ...providerReadiness(input, health),
    { id: "check", label: "Verification command", status: check ? "passed" : "warning", detail: check || "No check configured; completion cannot be independently verified." },
  ];
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

/** Pool members are alternatives; concrete role assignments are requirements. */
function providerReadiness(input: ReadinessInput, health: Awaited<ReturnType<typeof doctor>>): ReadinessItem[] {
  const scoped = input.roles !== undefined || input.providers !== undefined;
  const roles = Object.entries(input.roles ?? {}).map(([role, values]) => [role, typeof values === "string" ? [values] : values] as const);
  const required = new Set(roles.filter(([role]) => input.pattern !== "auto-team" || role !== "pool").flatMap(([, values]) => values).filter((id) => id !== "auto"));
  if (input.roles === undefined) for (const id of input.providers ?? []) if (id !== "auto") required.add(id);
  const autoTeam = input.pattern === "auto-team" && input.roles !== undefined;
  const pool = autoTeam ? roles.find(([role]) => role === "pool")?.[1] ?? [] : input.providers ?? AGENT_IDS;
  const needsAuto = autoTeam || roles.some(([, values]) => values.includes("auto")) || input.providers?.includes("auto") === true;
  const eligible = new Set(pool.filter((id) => id !== "auto" && (!autoTeam || input.providers === undefined || input.providers.includes(id))));
  const usable = (agent: (typeof health)[number]) => agent.installed && agent.compatible !== false && agent.signedIn !== false;
  const items = health.map((agent): ReadinessItem => {
    const needed = !scoped || required.has(agent.id);
    const candidate = scoped && needsAuto && eligible.has(agent.id);
    let status: ReadinessItem["status"];
    if (!needed && !(candidate && usable(agent))) status = "skipped";
    else if (!agent.installed) status = scoped ? "failed" : "skipped";
    else if (!usable(agent)) status = "failed";
    else status = agent.signedIn === null ? "warning" : "passed";
    return { id: `agent-${agent.id}`, label: agent.name, status, detail: !needed && !candidate ? "Not selected for this workflow" : agent.fix ?? [agent.version, agent.signedIn === true ? "Signed in" : agent.signedIn === null ? "Authentication unknown" : "Not signed in"].filter(Boolean).join(" · ") };
  });
  // A selected provider can disappear from the registry between selection and inspection.
  for (const id of required) if (!health.some((agent) => agent.id === id)) items.push({ id: `agent-${id}`, label: id, status: "failed", detail: "Selected provider is unavailable" });
  if (!scoped || needsAuto || !required.size) {
    const available = health.some((agent) => usable(agent) && (!scoped || needsAuto && eligible.has(agent.id)));
    if (!available) items.push({ id: "available-agent", label: "Usable agent", status: "failed", detail: scoped ? "Select at least one usable provider within the permitted pool." : "Install and sign in to at least one compatible coding agent." });
  }
  return items;
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
