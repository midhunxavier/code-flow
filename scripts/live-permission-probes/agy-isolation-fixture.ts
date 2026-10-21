import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/**
 * Experimental, offline containment fixture. Not a managed adapter or an authentication
 * workaround. No capability receipt from this experiment can enable production routing.
 */
export async function prepareAgyIsolationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-agy-isolation-")));
  const workspace = join(root, "workspace"), home = join(root, "home"), scratch = join(root, "scratch");
  const cli = join(home, ".gemini", "antigravity-cli");
  const customization = join(home, ".gemini", "config");
  for (const path of [workspace, scratch, cli, join(customization, "agents"), join(workspace, ".agents")]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, "fixture.txt"), "ISOLATED_WORKSPACE\n");
  await writeFile(join(workspace, ".agents", "hooks.json"), '{"fixture":"MUST_NOT_BE_READ"}\n');
  const settings = join(cli, "settings.json");
  await writeFile(settings, JSON.stringify({
    enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox", allowNonWorkspaceAccess: false,
    permissions: { allow: [], ask: [], deny: ["unsandboxed(*)", "mcp(*)", "read_url(*)", "execute_url(*)"] },
  }, null, 2), { mode: 0o400 });
  await writeFile(join(customization, "hooks.json"), "{}\n", { mode: 0o400 });
  await writeFile(join(cli, "mcp_config.json"), '{"mcpServers":{}}\n', { mode: 0o400 });
  await writeFile(join(customization, "agents", "codeflow-isolated-probe.md"), `---
name: codeflow-isolated-probe
description: Experimental file-only isolation probe
tools:
  - view_file
  - list_dir
  - grep_search
mainAgent: true
subagent: false
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---
Read only the requested fixture. Report unavailable operations without trying alternatives.
`, { mode: 0o400 });
  const profile = join(root, "offline.sb");
  // An allowlist of readable paths also excludes ambient user and ancestor configuration.
  await writeFile(profile, offlineAgyProfile({ workspace, home, scratch }), { mode: 0o400 });
  const env: NodeJS.ProcessEnv = {
    HOME: home, TMPDIR: scratch, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  };
  return { root, workspace, home, scratch, settings, profile, env };
}

/** Paths must be host-canonicalized before calling; no arbitrary SBPL or shell input. */
export function offlineAgyProfile(paths: { workspace: string; home: string; scratch: string }): string {
  const values = Object.values(paths);
  for (const path of values) if (!isAbsolute(path) || path === "/" || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid isolation path");
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    if (values[i] === values[j] || values[i]!.startsWith(values[j]! + sep) || values[j]!.startsWith(values[i]! + sep)) throw new Error("Isolation paths must not overlap");
  }
  const quote = (value: string) => JSON.stringify(value);
  return `(version 1)
(deny default)
(allow process-exec process-fork signal sysctl-read mach-lookup)
(allow file-read-metadata)
(allow file-read* file-map-executable
  (literal "/")
  (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")
  (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/dev")
  (subpath ${quote(paths.workspace)}) (subpath ${quote(paths.home)}) (subpath ${quote(paths.scratch)}))
(allow file-write* (subpath ${quote(paths.workspace)}) (subpath ${quote(paths.scratch)}) (literal "/dev/null"))
(deny file-read* file-write* (subpath ${quote(join(paths.workspace, ".agents"))}))
(deny network*)
`;
}
