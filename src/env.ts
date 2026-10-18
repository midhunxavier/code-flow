import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** code-flow's own install folder: its node_modules/.bin must not leak into your repo's checks. */
const INSTALL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Variables that belong to code-flow itself, never to the processes it starts. */
const SECRET_VARS = ["CODEFLOW_TOKEN", "CODEFLOW_TEAM_CAPABILITY", "CODEFLOW_TEAM_ENDPOINT"];

/**
 * Environment for everything code-flow starts (agent CLIs, checks, setup, Run app, gh, git):
 * yours, minus code-flow's own secrets and tooling. `npm start` puts code-flow's
 * node_modules/.bin first on PATH and sets npm_* variables; a repo's `tsc` or `vitest` must
 * come from that repo, or a check can pass with tools the repo doesn't have.
 */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SECRET_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    // npm's settings (a registry or proxy you exported) are yours and kept; what npm sets about
    // code-flow's own script (its package, its lifecycle, its folder) isn't.
    if (key.startsWith("npm_config_") && key !== "npm_config_local_prefix") continue;
    if (key.startsWith("npm_") || key === "INIT_CWD") delete env[key];
  }
  if (env.PATH) env.PATH = cleanPath(env.PATH);
  return { ...env, ...extra };
}

/** PATH without the bin folders npm adds for code-flow's own scripts. */
export function cleanPath(path: string, installDir = INSTALL_DIR): string {
  const sepChar = process.platform === "win32" ? ";" : ":";
  const ancestors = new Set<string>();
  for (let dir = installDir; ; dir = dirname(dir)) {
    ancestors.add(join(dir, "node_modules", ".bin"));
    if (dirname(dir) === dir) break;
  }
  return path
    .split(sepChar)
    .filter((entry) => {
      if (!entry) return false;
      const normalized = resolve(entry);
      if (ancestors.has(normalized)) return false;
      // npm's own shim folder for lifecycle scripts
      return !normalized.includes(`${sep}@npmcli${sep}run-script${sep}`);
    })
    .join(sepChar);
}
