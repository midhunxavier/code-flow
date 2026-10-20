import type { TaskIntent } from "../src/experience.js";
import type { AgentId, AgentSettings, PatternInfo } from "./types.js";
import type { RoleValue } from "./roles.js";
import { validateContextBudget, type ContextBudget } from "../src/context-budget.js";

export interface PresetConfig {
  pattern: string;
  roles: Record<string, RoleValue[]>;
  options: Record<string, number | boolean>;
  agentSettings: AgentSettings;
  roleSettings: Record<string, AgentSettings>;
  trust: "safe" | "standard" | "trusted" | "full";
  limits: { maxMinutes: number; maxSteps: number; maxTokens?: number; maxCostUsd?: number };
  approvePlan: boolean;
  toolApprovals?: boolean;
  contextBudget?: ContextBudget;
  check?: string;
  setup?: string;
  baseRef?: string;
}
export interface TeamPreset {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  config: PresetConfig;
  history: Array<{ revision: number; updatedAt: number; config: PresetConfig }>;
}
export interface TaskTemplate {
  id: string;
  name: string;
  pattern: string;
  task: string;
  criteria: string[];
  config?: PresetConfig;
  runOptions?: TemplateRunOptions;
  intent?: TaskIntent;
}
export interface TemplateRunOptions {
  verification: "" | "lightweight" | "standard" | "thorough";
  container: { enabled: boolean; image: string; authVolume: string };
}
export interface ComposerLibrary { schemaVersion: 1; presets: TeamPreset[]; templates: TaskTemplate[] }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const provider = (value: unknown): value is AgentId => typeof value === "string" && (["claude", "codex", "agy"].includes(value) || /^acp:[a-z][a-z0-9-]{0,40}$/.test(value) || /^plugin:[a-z][a-z0-9-]{0,40}\/[a-z][a-z0-9-]{0,40}$/.test(value));
const whole = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const fail = (message: string): never => { throw new Error(message); };

function settings(value: unknown): AgentSettings {
  if (!object(value)) return fail("Model settings must be an object.");
  const out: AgentSettings = {};
  for (const [id, setting] of Object.entries(value)) {
    if (!provider(id) || !object(setting) || (setting.model !== undefined && !text(setting.model, 256)) || (setting.effort !== undefined && !text(setting.effort, 64))) return fail("A preset contains invalid provider model settings.");
    if (setting.variants !== undefined && (!Array.isArray(setting.variants) || setting.variants.length > 128 || setting.variants.some(v => !object(v) || !text(v.model, 256) || !v.model.trim() || v.effort !== undefined && !text(v.effort, 64)))) return fail("Invalid model variants.");
    out[id] = { ...(setting.model !== undefined ? { model: setting.model as string } : {}), ...(setting.effort !== undefined ? { effort: setting.effort as string } : {}), ...(Array.isArray(setting.variants) ? { variants: setting.variants.map(v => ({ model: v.model as string, ...(v.effort !== undefined ? { effort: v.effort as string } : {}) })) } : {}) };
  }
  return out;
}

export function validatePresetConfig(value: unknown, patterns: readonly PatternInfo[]): PresetConfig {
  if (!object(value)) return fail("A preset is missing its configuration.");
  const pattern = patterns.find((p) => p.id === value.pattern);
  if (!pattern) return fail(`Unknown workflow: ${String(value.pattern)}.`);
  if (!object(value.roles) || !object(value.options) || !object(value.roleSettings)) return fail("A preset must contain roles, options and role settings.");
  const roles: Record<string, RoleValue[]> = {};
  for (const [id, values] of Object.entries(value.roles)) {
    const role = pattern.roles.find((r) => r.id === id);
    if (!role || !Array.isArray(values) || values.length > (role.multiple ? 4 : 1) || values.some((v) => v !== "auto" && !provider(v)) || new Set(values).size !== values.length) return fail(`Invalid assignments for role ${id}.`);
    roles[id] = [...values];
  }
  for (const role of pattern.roles) if (!role.optional && !roles[role.id]?.length) return fail(`A preset needs an assignment for ${role.label}.`);
  const options: Record<string, number | boolean> = {};
  for (const [id, v] of Object.entries(value.options)) {
    const option = pattern.options.find((o) => o.id === id);
    if (!option || (option.type === "boolean" ? typeof v !== "boolean" : typeof v !== "number" || !Number.isFinite(v) || v < (option.min ?? 0) || v > (option.max ?? 10000))) return fail(`Invalid workflow option ${id}.`);
    options[id] = v as number | boolean;
  }
  const roleSettings: Record<string, AgentSettings> = {};
  for (const [id, v] of Object.entries(value.roleSettings)) {
    if (!pattern.roles.some((r) => r.id === id)) return fail(`Unknown role settings: ${id}.`);
    roleSettings[id] = settings(v);
  }
  if (!["safe", "standard", "trusted", "full"].includes(String(value.trust)) || typeof value.approvePlan !== "boolean" || !object(value.limits) || !whole(value.limits.maxMinutes, 1, 720) || !whole(value.limits.maxSteps, 1, 200)) return fail("Invalid permissions, approval choice or execution limits.");
  if ((value.limits.maxTokens !== undefined && !whole(value.limits.maxTokens, 1, 1000000000)) || (value.limits.maxCostUsd !== undefined && (typeof value.limits.maxCostUsd !== "number" || !Number.isFinite(value.limits.maxCostUsd) || value.limits.maxCostUsd <= 0 || value.limits.maxCostUsd > 1000000)) || (value.toolApprovals !== undefined && typeof value.toolApprovals !== "boolean")) return fail("Invalid reported usage ceilings or tool approval preference.");
  for (const field of ["check", "setup", "baseRef"] as const) if (value[field] !== undefined && !text(value[field], 10000)) return fail(`Invalid ${field} setting.`);
  const commands = Object.fromEntries(["check", "setup", "baseRef"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const contextBudget = validateContextBudget(value.contextBudget);
  return { ...commands, pattern: pattern.id, roles, options, agentSettings: settings(value.agentSettings), roleSettings, trust: value.trust as PresetConfig["trust"], limits: { maxMinutes: value.limits.maxMinutes, maxSteps: value.limits.maxSteps, ...(value.limits.maxTokens !== undefined ? { maxTokens: value.limits.maxTokens as number } : {}), ...(value.limits.maxCostUsd !== undefined ? { maxCostUsd: value.limits.maxCostUsd as number } : {}) }, approvePlan: value.approvePlan, ...(value.toolApprovals !== undefined ? { toolApprovals: value.toolApprovals } : {}), ...(contextBudget ? { contextBudget } : {}) };
}

export function templateParameters(template: Pick<TaskTemplate, "task" | "criteria">): string[] {
  return [...new Set([...([template.task, ...template.criteria].join("\n").matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,39})\}\}/g))].map((match) => match[1]!))];
}

export function fillTemplate(template: TaskTemplate, values: Record<string, string>): { task: string; criteria: string[] } {
  for (const name of templateParameters(template)) if (!values[name]?.trim()) return fail(`Enter a value for ${name}.`);
  const fill = (value: string) => value.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,39})\}\}/g, (_, name: string) => values[name]!.trim());
  return { task: fill(template.task), criteria: template.criteria.map(fill) };
}

export function parseComposerLibrary(value: unknown, patterns: readonly PatternInfo[]): ComposerLibrary {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.presets) || !Array.isArray(value.templates) || value.presets.length > 100 || value.templates.length > 100) return fail("Expected a version 1 code-flow library with at most 100 presets and 100 templates.");
  const presets = value.presets.map((p): TeamPreset => {
    if (!object(p) || !identifier(p.id) || !text(p.name, 80) || !p.name.trim() || !whole(p.revision, 1, 1000000) || !whole(p.updatedAt, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(p.history) || p.history.length > 10) return fail("Invalid team preset metadata.");
    const history = p.history.map((h) => {
      if (!object(h) || !whole(h.revision, 1, p.revision as number - 1) || !whole(h.updatedAt, 0, Number.MAX_SAFE_INTEGER)) return fail("Invalid preset revision history.");
      return { revision: h.revision, updatedAt: h.updatedAt, config: validatePresetConfig(h.config, patterns) };
    });
    if (new Set(history.map((h) => h.revision)).size !== history.length) return fail("Duplicate preset revision.");
    return { id: p.id, name: p.name.trim(), revision: p.revision, updatedAt: p.updatedAt, config: validatePresetConfig(p.config, patterns), history };
  });
  const templates = value.templates.map((t): TaskTemplate => {
    if (!object(t) || !identifier(t.id) || !text(t.name, 80) || !t.name.trim() || !patterns.some((p) => p.id === t.pattern) || !text(t.task, 100000) || !t.task.trim() || !Array.isArray(t.criteria) || t.criteria.length > 100 || t.criteria.some((c) => !text(c, 2000))) return fail("Invalid task template.");
    if (t.intent !== undefined && !["bug", "feature", "review", "explore"].includes(String(t.intent))) return fail("Invalid template task intent.");
    const template = { ...(t.intent ? { intent: t.intent as TaskIntent } : {}), id: t.id, name: t.name.trim(), pattern: t.pattern as string, task: t.task, criteria: t.criteria as string[] };
    if (templateParameters(template).length > 24) return fail("A template can have at most 24 parameters.");
    const config = t.config === undefined ? undefined : validatePresetConfig(t.config, patterns);
    if (config && config.pattern !== template.pattern) return fail("Template workflow and agent configuration must match.");
    let runOptions: TemplateRunOptions | undefined;
    if (t.runOptions !== undefined) {
      const options = t.runOptions;
      if (!object(options) || !["", "lightweight", "standard", "thorough"].includes(String(options.verification)) || !object(options.container) || typeof options.container.enabled !== "boolean" || !text(options.container.image, 500) || !text(options.container.authVolume, 500)) return fail("Invalid template execution settings.");
      runOptions = { verification: options.verification as TemplateRunOptions["verification"], container: { enabled: options.container.enabled, image: options.container.image, authVolume: options.container.authVolume } };
    }
    return { ...template, ...(config ? { config } : {}), ...(runOptions ? { runOptions } : {}) };
  });
  if (new Set(presets.map((p) => p.id)).size !== presets.length || new Set(templates.map((t) => t.id)).size !== templates.length) return fail("Duplicate library identifiers.");
  return { schemaVersion: 1, presets, templates };
}

export function taskWithCriteria(task: string, criteria: string[]): string {
  const items = criteria.map((c) => c.trim()).filter(Boolean);
  return items.length ? `${task.trim()}\n\nAcceptance criteria:\n${items.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : task;
}
