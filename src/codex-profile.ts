import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";

/**
 * The Codex profile runs use, chosen in Settings → Agents (or CODEFLOW_CODEX_PROFILE,
 * which wins). Codex layers `$CODEX_HOME/<name>.config.toml` over its base config for it: another
 * model provider (Ollama, an OpenAI-compatible endpoint), model or sandbox defaults.
 *
 * `codex --profile` applies to `codex exec` but not to `codex app-server`, so a profile makes
 * every Codex turn use exec. Codex itself ignores a profile whose file is missing; here that is
 * an error, so a typo never silently runs on your default account.
 */
const SETTINGS = "codex-settings.json";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SUFFIX = ".config.toml";

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
export const codexProfileFile = (name: string) => join(codexHome(), `${name}${SUFFIX}`);

/** The profiles Codex would accept: `<name>.config.toml` files in its home. */
export function listCodexProfiles(): string[] {
  try {
    return readdirSync(codexHome(), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(SUFFIX) && NAME.test(entry.name.slice(0, -SUFFIX.length)))
      .map(entry => entry.name.slice(0, -SUFFIX.length)).sort();
  } catch { return []; }
}

/** Why `name` can't be used, or undefined when it can. */
export function codexProfileProblem(name: string): string | undefined {
  if (!NAME.test(name)) return "A Codex profile is a plain name such as `work`: letters, digits, `-` and `_`";
  if (!existsSync(codexProfileFile(name))) return `Codex has no profile “${name}”: create ${codexProfileFile(name)} first`;
}

function saved(home: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(home, SETTINGS), "utf8")).profile;
    return typeof value === "string" && value ? value : undefined;
  } catch { return undefined; }
}

/** Read on every turn, so changing it needs no restart. */
export function codexProfile(home = CODEFLOW_HOME): { name?: string; source?: "environment" | "settings" } {
  const fromEnvironment = process.env.CODEFLOW_CODEX_PROFILE?.trim();
  if (fromEnvironment) return { name: fromEnvironment, source: "environment" };
  const name = saved(home);
  return name ? { name, source: "settings" } : {};
}

/** Save the profile for new turns; an empty name goes back to Codex's base config. */
export function saveCodexProfile(name: string, home = CODEFLOW_HOME): void {
  const profile = name.trim();
  if (profile) { const problem = codexProfileProblem(profile); if (problem) throw new Error(problem); }
  mkdirSync(home, { recursive: true });
  const file = join(home, SETTINGS), temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile ? { profile } : {})}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function codexProfileStatus(home = CODEFLOW_HOME) {
  const { name, source } = codexProfile(home);
  return { profile: name ?? "", source: source ?? null, problem: name ? codexProfileProblem(name) ?? null : null, available: listCodexProfiles(), codexHome: codexHome() };
}
