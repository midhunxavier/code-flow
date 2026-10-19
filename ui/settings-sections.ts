import type { IconName } from "./icons.js";

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: "sliders", group: "Preferences", description: "Make code-flow feel at home.", keywords: "appearance theme light dark system sidebar group shortcuts keyboard" },
  { id: "agents", label: "Agents & models", icon: "sparkle", group: "Preferences", description: "Choose the models and effort your agents use.", keywords: "claude codex antigravity providers login health quota" },
  { id: "runs", label: "Run defaults", icon: "layers", group: "Preferences", description: "Set the starting point for your next run.", keywords: "workflow permissions trust sandbox limits minutes steps tokens cost approval" },
  { id: "notifications", label: "Notifications", icon: "bell", group: "Preferences", description: "Decide how code-flow gets your attention.", keywords: "desktop browser alerts slack webhook delivery" },
  { id: "ssh", label: "SSH connections", icon: "terminal", group: "Connections", description: "Your workspace, on any machine.", keywords: "remote vm server host port key identity linux connect" },
  { id: "remote-access", label: "Remote access", icon: "phone", group: "Connections", description: "Access this workspace from your other devices.", keywords: "tailscale wifi phone tablet pairing network" },
  { id: "team", label: "Team", icon: "people", group: "Connections", description: "Share a task board and hand work over to teammates.", keywords: "team board tasks hand over handoff teammates runner tailscale collaboration shared" },
  { id: "integrations", label: "Integrations", icon: "globe", group: "Connections", description: "Connect issues, code hosts and remote workers.", keywords: "github gitlab bitbucket sources ssh worker" },
  { id: "workspace", label: "Workspace", icon: "files", group: "Tools & activity", description: "Inspect code, verify changes and manage repository operations.", keywords: "repository files verification dependencies context history checkpoints services coordination filtered tasks" },
  { id: "insights", label: "Insights", icon: "chart", group: "Tools & activity", description: "Understand run results, usage and comparisons.", keywords: "statistics analytics costs tokens agents patterns comparisons evaluations disk" },
  { id: "automations", label: "Automations", icon: "clock", group: "Tools & activity", description: "Manage schedules, webhooks, deferred runs and the review inbox.", keywords: "schedule recurring sweep trigger queue deferred inbox review" },
  { id: "projects", label: "Projects & access", icon: "project", group: "Management", description: "Manage project conventions and who can access them.", keywords: "repositories filesystem policy permissions shared accounts rules instructions" },
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
