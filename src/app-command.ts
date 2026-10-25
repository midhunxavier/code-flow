import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { readRepoConfig } from "./repo-config.js";

/** Discover a launch command without executing repository code. The caller still authorizes startup. */
export async function appCommand(folder: string, fallback?: { command: string; port?: number }): Promise<{ command: string; port?: number } | undefined> {
  const { config, error } = await readRepoConfig(folder);
  if (error) throw new Error(error);
  if (config.run) return config.run;
  if (fallback?.command) return fallback;
  let pkg: { scripts?: Record<string, unknown>; packageManager?: string };
  try { pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const script = ["dev", "start"].find(name => typeof pkg.scripts?.[name] === "string" && (pkg.scripts[name] as string).trim());
  if (!script) return;
  const has = (file: string) => access(join(folder, file)).then(() => true, () => false);
  const manager = /^pnpm@/.test(pkg.packageManager ?? "") || await has("pnpm-lock.yaml") ? "pnpm"
    : /^yarn@/.test(pkg.packageManager ?? "") || await has("yarn.lock") ? "yarn"
    : /^bun@/.test(pkg.packageManager ?? "") || await has("bun.lock") || await has("bun.lockb") ? "bun" : "npm";
  const contents = pkg.scripts![script] as string;
  // These common web servers ignore PORT unless passed explicitly. Other scripts
  // receive PORT through DevServers; unusual or nested apps can be configured by the agent.
  const webServer = /^(?:vite(?:\s|$)|(?:astro|nuxt|next)\s+(?:dev|start)(?:\s|$))/.test(contents.trim()) && !/[;&|]/.test(contents);
  const flags = webServer && !/--port(?:\s|=)|\s-p\s/.test(contents) ? ' --port "$PORT"' : "";
  return { command: `${manager} run ${script}${flags ? `${manager === "npm" ? " --" : ""}${flags}` : ""}` };
}
