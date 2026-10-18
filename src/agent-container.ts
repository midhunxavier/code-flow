import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { childEnv } from "./env.js";
import type { AccessMode } from "./adapters/types.js";

/** An explicitly prepared image and, optionally, a named volume authenticated inside it. */
export interface AgentContainer {
  image: string;
  authVolume?: string;
  /** Inference needs network access. false deliberately disables all container networking. */
  network?: boolean;
  memoryMb?: number;
  cpus?: number;
}
export interface AgentContainerLaunch {
  command: "docker";
  args: string[];
  name: string;
}
// Object identity, never a serialized/client field, carries this internal containment receipt.
const filteredContainers = new WeakMap<AgentContainer, { id: string; readOnly: string[] }>();
export function filteredTaskContainer(raw: AgentContainer, id: string, readOnly: string[] = []): AgentContainer {
  if (raw.authVolume || !/^sha256:[a-f0-9]{64}$/.test(raw.image)) throw new Error("Filtered containers require an immutable image and no authentication volume");
  if (!/^filtered-[a-f0-9]{24}$/.test(id) || readOnly.length > 500 || readOnly.some((path) => !path || path.startsWith("/") || /[\\\x00-\x1f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"))) throw new Error("Invalid filtered container receipt");
  const config = validateAgentContainer(raw); filteredContainers.set(config, { id, readOnly: [...readOnly] }); return config;
}

export function validateAgentContainer(raw: unknown): AgentContainer {
  const value = raw as Partial<AgentContainer> | null;
  if (!value || typeof value !== "object" || typeof value.image !== "string" || !/^[a-zA-Z0-9][\w./:@-]{0,199}$/.test(value.image)) throw new Error("Agent isolation needs a valid prebuilt Docker image");
  if (value.authVolume !== undefined && (typeof value.authVolume !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value.authVolume))) throw new Error("Agent authentication must use an explicitly named Docker volume, never a host path");
  if (value.network !== undefined && typeof value.network !== "boolean") throw new Error("Agent container network must be enabled or disabled explicitly");
  if (value.memoryMb !== undefined && (!Number.isInteger(value.memoryMb) || value.memoryMb < 128 || value.memoryMb > 65_536)) throw new Error("Agent container memory must be 128–65536 MB");
  if (value.cpus !== undefined && (!Number.isFinite(value.cpus) || value.cpus < 0.1 || value.cpus > 64)) throw new Error("Agent container CPUs must be 0.1–64");
  return {
    image: value.image, ...(value.authVolume ? { authVolume: value.authVolume } : {}),
    ...(value.network === undefined ? {} : { network: value.network }),
    ...(value.memoryMb === undefined ? {} : { memoryMb: value.memoryMb }),
    ...(value.cpus === undefined ? {} : { cpus: value.cpus }),
  };
}

/**
 * No shell, host home or host environment is passed into the image. Worktree paths retain
 * their absolute names so official CLIs and Git can use their existing arguments unchanged.
 * Container team-tool bridges are unsupported; adapters must use structured outcomes.
 */
export function agentContainerLaunch(command: string, args: string[], cwd: string, mode: AccessMode, raw: AgentContainer, extraReadOnly: string[] = []): AgentContainerLaunch {
  const filtered = filteredContainers.get(raw);
  const container = validateAgentContainer(raw);
  if (!["claude", "codex", "agy"].includes(command)) throw new Error("Only supported official agent CLIs can run in an agent container");
  const root = realpathSync(cwd);
  if (!lstatSync(root).isDirectory()) throw new Error("Agent workspace must be a directory");
  const mounts = new Map<string, boolean>([[root, mode === "read"]]);
  for (const path of readOnlyGitMetadata(root)) mounts.set(path, true);
  for (const path of extraReadOnly) mounts.set(realpathSync(path), true);
  for (const relative of filtered?.readOnly ?? []) {
    const target = realpathSync(join(root, relative)); if (!target.startsWith(`${root}/`) || !lstatSync(target).isFile()) throw new Error("Filtered read-only mounts must be regular files inside the export"); mounts.set(target, true);
  }
  for (const path of mounts.keys()) if (!isAbsolute(path) || /[,\n\r\0]/.test(path)) throw new Error("Docker isolation cannot mount paths containing commas or line breaks");
  const name = `codeflow-agent-${randomUUID().replace(/-/g, "")}`;
  const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid!()}`] : ["--user", "65532:65532"];
  return {
    command: "docker", name,
    args: [
      "run", "--rm", "--init", "--interactive", "--pull=never", "--name", name,
      "--label", "codeflow.managed-agent=true", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      ...(filtered ? ["--label", `codeflow.filtered-task=${filtered.id}`] : []),
      ...(filtered ? ["--read-only", "--tmpfs", `/home/codeflow:rw,nosuid,nodev,size=134217728,uid=${typeof process.getuid === "function" ? process.getuid() : 65532},gid=${typeof process.getgid === "function" ? process.getgid() : 65532},mode=0700`] : []),
      "--pids-limit", "256", "--memory", `${container.memoryMb ?? 4096}m`, "--cpus", String(container.cpus ?? 2),
      ...user, "--workdir", root,
      ...[...mounts].flatMap(([path, readOnly]) => ["--mount", `type=bind,source=${path},target=${path}${readOnly ? ",readonly" : ""}`]),
      ...(container.authVolume ? ["--mount", `type=volume,source=${container.authVolume},target=/home/codeflow`] : []),
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
      "--env", "HOME=/home/codeflow", "--env", "CODEX_HOME=/home/codeflow/.codex",
      "--env", "GIT_TERMINAL_PROMPT=0", "--env", "GIT_OPTIONAL_LOCKS=0", "--env", "NO_COLOR=1",
      "--env", "GIT_CONFIG_GLOBAL=/dev/null", "--env", "GIT_CONFIG_SYSTEM=/dev/null",
      "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=core.excludesFile", "--env", "GIT_CONFIG_VALUE_0=/dev/null",
      ...(container.network === false ? ["--network", "none"] : []),
      "--entrypoint", command, container.image, ...args,
    ],
  };
}

/** Exact Git mounts for this workspace; linked markers must prove their common-dir backlink. */
export function readOnlyGitMetadata(root: string): string[] {
  const marker = join(root, ".git");
  let info;
  try { info = lstatSync(marker); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (info.isSymbolicLink()) throw new Error("Agent isolation refuses a symlinked .git marker");
  if (info.isDirectory()) return [marker];
  if (!info.isFile()) throw new Error("Agent workspace has an invalid .git marker");
  const gitdir = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, "utf8"));
  if (!gitdir) throw new Error("Agent workspace has an invalid worktree .git marker");
  const admin = realpathSync(resolve(root, gitdir[1]!));
  const common = realpathSync(resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim()));
  const backlink = realpathSync(resolve(admin, readFileSync(join(admin, "gitdir"), "utf8").trim()));
  // A repository-controlled pointer must never turn into a mount of an arbitrary host path.
  if (backlink !== realpathSync(marker) || dirname(admin) !== join(common, "worktrees") || !lstatSync(join(common, "objects")).isDirectory() || !lstatSync(join(common, "HEAD")).isFile()) throw new Error("Agent worktree metadata does not belong to this workspace");
  return [marker, common];
}

export const isAgentContainerName = (name: unknown): name is string => typeof name === "string" && /^codeflow-agent-[a-f0-9]{32}$/.test(name);

/** Docker's daemon owns the container, so stopping its client alone is insufficient. */
export function stopAgentContainer(name: string): Promise<void> {
  if (!isAgentContainerName(name)) return Promise.resolve();
  return new Promise((resolve) => {
    execFile("docker", ["rm", "--force", name], { env: childEnv(), timeout: 5_000 }, () => resolve());
  });
}

/** Exit handlers cannot await; normal cancellation uses the asynchronous variant. */
export function stopAgentContainerSync(name: string): void {
  if (isAgentContainerName(name)) spawnSync("docker", ["rm", "--force", name], { env: childEnv(), timeout: 1_500, stdio: "ignore" });
}

export function agentContainerCapabilities(container: AgentContainer) {
  const configured = validateAgentContainer(container);
  return {
    runtime: "docker" as const, image: configured.image, network: configured.network !== false,
    credentialSource: configured.authVolume ? "named-volume" as const : "image" as const,
    liveTeamTools: false, nativeCodexApprovals: true, hostHomeMounted: false,
  };
}
