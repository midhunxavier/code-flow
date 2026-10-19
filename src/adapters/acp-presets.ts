import type { AcpConnection } from "./acp-types.js";

/** Shared by Settings and the opt-in live acceptance runner. No credentials or approval overrides. */
export const acpPresets = [
  {
    key: "opencode", name: "OpenCode", command: "opencode", args: ["acp"],
    install: "npm install -g opencode-ai", login: "opencode auth login",
    docs: "https://opencode.ai/docs/acp/",
  },
  {
    key: "kilo", name: "Kilo", command: "kilo", args: ["acp"],
    install: "npm install -g @kilocode/cli", login: "kilo auth login",
    docs: "https://kilo.ai/docs/code-with-ai/platforms/cli-reference",
  },
  {
    key: "cline", name: "Cline", command: "cline", args: ["--acp"],
    install: "npm install -g cline", login: "cline auth",
    docs: "https://docs.cline.bot/usage/acp",
    help: "Cline asks before edits and commands by default. Enable Ask me for tool permissions in the run’s permissions controls to approve these requests.",
  },
] as const;

export type AcpPreset = typeof acpPresets[number];
export function acpPresetConnection(preset: AcpPreset): AcpConnection {
  return { id: `acp:${preset.key}`, name: preset.name, command: preset.command, args: [...preset.args], enabled: true };
}
