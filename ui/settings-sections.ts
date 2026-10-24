import type { IconName } from "./icons.js";

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: "sliders", group: "Preferences", description: "Make code-flow feel at home.", keywords: "appearance theme light dark system sidebar group shortcuts keyboard desktop app updates version restart ml machine learning model training fine tuning llm gpu enable disable" },
  { id: "agents", label: "Agents & models", icon: "sparkle", group: "Preferences", description: "Connect coding agents and choose their models and effort.", keywords: "claude codex antigravity opencode kilo cline acp cli connection providers login health quota prompt improvement improve rewrite quick repo" },
  { id: "runs", label: "Run defaults", icon: "layers", group: "Preferences", description: "Set the starting point for your next run.", keywords: "workflow permissions trust sandbox limits minutes steps tokens cost approval" },
  { id: "notifications", label: "Notifications", icon: "bell", group: "Preferences", description: "Decide how code-flow gets your attention.", keywords: "desktop browser alerts slack webhook delivery" },
  { id: "connections", label: "Connections", icon: "terminal", group: "Connections", description: "Work on another computer, delegate execution, or share access.", keywords: "ssh remote vm server host worker runner port keys tailscale phone tablet people team accounts collaboration handoff board teammates" },
  { id: "integrations", label: "Integrations", icon: "globe", group: "Connections", description: "Connect issues and code hosts.", keywords: "github gitlab bitbucket sources" },
  { id: "workspace", label: "Repository tools", icon: "files", group: "Tools & activity", description: "Inspect code, verify changes and manage repository operations.", keywords: "repository files verification dependencies context history checkpoints services coordination filtered tasks" },
  { id: "insights", label: "Insights", icon: "chart", group: "Tools & activity", description: "Understand run results, usage and comparisons.", keywords: "statistics analytics costs tokens agents patterns comparisons evaluations disk" },
  { id: "automations", label: "Scheduling", icon: "clock", group: "Tools & activity", description: "Run once later, repeat tasks, process a backlog or pursue a project mission.", keywords: "schedule recurring sweep trigger queue deferred inbox review" },
  { id: "projects", label: "Projects", icon: "project", group: "Management", description: "Configure project defaults, templates, conventions and filesystem policies.", keywords: "repositories setup checks verification isolation docker templates readiness filesystem policy permissions rules instructions" },
  { id: "extensions", label: "Extensions", icon: "plus", group: "Management", description: "Manage trusted providers and workflows.", keywords: "plugins bundles" },
  { id: "data", label: "Data & storage", icon: "archive", group: "Management", description: "Choose how long to keep your workspace data.", keywords: "retention cleanup history logs memory" },
  { id: "advanced", label: "Advanced", icon: "keyboard", group: "Management", description: "Inspect health and troubleshoot your environment.", keywords: "diagnostics export server configuration environment versions" },
] as const satisfies readonly { id: string; label: string; icon: IconName; group: string; description: string; keywords: string }[];
export type SettingsSection = typeof SETTINGS_SECTIONS[number]["id"];
export function settingsSection(value?: string): SettingsSection {
  return SETTINGS_SECTIONS.some((item) => item.id === value) ? value as SettingsSection : "general";
}
export function searchSettings(query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return SETTINGS_SECTIONS.filter((item) => terms.every((term) => `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(term)));
}
