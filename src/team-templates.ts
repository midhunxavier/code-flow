import type { TeamPlan, TeamTask } from "./teams.js";

export interface TemplateTask {
  id: string; title: string; role: string; kind: "implementation" | "investigation";
  instructions: string; dependsOn: string[]; dependencyTypes?: Record<string, "completion" | "artifact" | "knowledge">; paths: string[]; acceptance: string[];
}
/** Portable, closed definitions. Authority and runtime results never belong here. */
export interface TeamTemplate {
  schemaVersion: 1; id: string; version: number; name: string; description: string;
  scope: "builtin" | "personal" | "project"; project?: string; autoEnabled: boolean;
  parameters: string[]; roles: string[]; tasks: TemplateTask[]; contracts: string[];
  workflow?: string; task: string; criteria: string[];
  preferences?: TemplatePreferences;
}
interface TemplateModelPreference { model?: string; effort?: string; variants?: { model: string; effort?: string }[] }
export interface TemplatePreferences {
  roles: Record<string, string[]>;
  options: Record<string, number | boolean>;
  agentSettings: Record<string, TemplateModelPreference>;
  roleSettings: Record<string, Record<string, TemplateModelPreference>>;
}
export interface TemplateUse {
  id: string; templateId: string; version: number;
  inputs: { name: string; value: string }[]; assignments: { role: string; memberId: string }[];
  dependsOn: string[]; requirements: string[]; instructions: string;
}
export interface TemplateSelection { template: TeamTemplate; inputs: Record<string, string> }
const idPattern = /^[a-z][a-z0-9-]{0,39}$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (message: string): never => { throw new Error(message); };
const text = (v: unknown, max = 4000): string => typeof v === "string" && v.length <= max && !v.includes("\0") ? v : fail("Template text is missing or too long");
const ident = (v: unknown): string => typeof v === "string" && idPattern.test(v) ? v : fail("Use lowercase template identifiers (up to 40 characters)");
const list = (v: unknown, max = 24): string[] => Array.isArray(v) && v.length <= max ? v.map(x => text(x)) : fail("Invalid template list");
export function validateTeamTemplate(raw: unknown): TeamTemplate {
  if (!object(raw) || raw.schemaVersion !== 1) return fail("Expected a version 1 team template");
  const keys = ["schemaVersion", "id", "version", "name", "description", "scope", "project", "autoEnabled", "parameters", "roles", "tasks", "contracts", "workflow", "task", "criteria", "preferences"];
  if (Object.keys(raw).some(k => !keys.includes(k))) return fail("Templates cannot contain permissions, credentials, sessions, or unsupported fields");
  if (!Number.isSafeInteger(raw.version) || raw.version < 1 || !["builtin", "personal", "project"].includes(raw.scope) || typeof raw.autoEnabled !== "boolean") return fail("Invalid template version or scope");
  if ((raw.scope === "project") !== (typeof raw.project === "string" && !!raw.project)) return fail("Project templates need a project; personal templates cannot bind one");
  const parameters = list(raw.parameters).map(ident), roles = list(raw.roles, 6).map(ident);
  if (new Set(parameters).size !== parameters.length || new Set(roles).size !== roles.length) return fail("Duplicate template parameters or roles");
  if (!Array.isArray(raw.tasks) || raw.tasks.length > 24) return fail("A template can contain at most 24 tasks");
  const tasks: TemplateTask[] = raw.tasks.map((t: unknown) => {
    if (!object(t) || Object.keys(t).some(k => !["id", "title", "role", "kind", "instructions", "dependsOn", "dependencyTypes", "paths", "acceptance"].includes(k)) || !["implementation", "investigation"].includes(t.kind)) return fail("Invalid template task");
    const task = { id: ident(t.id), title: text(t.title, 200), role: ident(t.role), kind: t.kind, instructions: text(t.instructions, 8000), dependsOn: list(t.dependsOn).map(ident), paths: list(t.paths), acceptance: list(t.acceptance) } as TemplateTask;
    if (t.dependencyTypes !== undefined) {
      if (!object(t.dependencyTypes) || Object.entries(t.dependencyTypes).some(([id, kind]) => !task.dependsOn.includes(id) || !["completion", "artifact", "knowledge"].includes(kind))) return fail("Invalid template dependency types");
      task.dependencyTypes = { ...t.dependencyTypes };
    }
    if (!roles.includes(task.role) || !task.title.trim() || !task.instructions.trim() || !task.acceptance.length || task.acceptance.some(c => !c.trim()) || !task.paths.length) return fail("Every task needs a role, instructions, owned paths, and acceptance criteria");
    for (const path of task.paths) if (!validTemplatePath(path)) return fail("Template paths must be repository relative");
    return task;
  });
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length) return fail("Duplicate template task IDs");
  const seen = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) return fail("Template dependencies contain a cycle");
    if (seen.has(id)) return;
    const task = tasks.find(t => t.id === id); if (!task) return fail(`Unknown template dependency ${id}`);
    visiting.add(id); task.dependsOn.forEach(visit); visiting.delete(id); seen.add(id);
  }; tasks.forEach(t => visit(t.id));
  const workflow = raw.workflow === undefined ? undefined : ident(raw.workflow);
  if (workflow && tasks.length || !workflow && !tasks.length) return fail("Choose a fixed workflow or a task graph");
  if (workflow && raw.autoEnabled) return fail("Fixed workflows are manual templates; Auto composes validated task graphs");
  const result: TeamTemplate = { schemaVersion: 1, id: ident(raw.id), version: raw.version, name: text(raw.name, 100), description: text(raw.description), scope: raw.scope, ...(raw.project ? { project: text(raw.project, 200) } : {}), autoEnabled: raw.autoEnabled, parameters, roles, tasks, contracts: list(raw.contracts), ...(workflow ? { workflow } : {}), task: text(raw.task, 100000), criteria: list(raw.criteria, 100) };
  if (!result.name.trim() || !result.task.trim()) return fail("Give the template a name and a task prompt");
  if (raw.preferences !== undefined) result.preferences = templatePreferences(raw.preferences);
  const body = JSON.stringify([tasks, result.contracts, result.task, result.criteria]);
  for (const match of body.matchAll(/\{\{([a-z][a-z0-9-]*)\}\}/g)) if (!parameters.includes(match[1]!)) return fail(`Undeclared parameter ${match[1]}`);
  if (JSON.stringify(result).length > 150000) return fail("Template is too large");
  return result;
}
export function templatePreferences(raw: unknown): TemplatePreferences {
  if (!object(raw) || Object.keys(raw).some(k => !["roles", "options", "agentSettings", "roleSettings"].includes(k))) return fail("Template preferences may contain only roles, options and model settings");
  const record = <T>(v: unknown, parse: (v: unknown) => T): Record<string, T> => {
    if (!object(v) || Object.keys(v).length > 64 || Object.keys(v).some(k => !/^[a-zA-Z][a-zA-Z0-9_:/.-]{0,150}$/.test(k) || ["constructor", "prototype", "__proto__"].includes(k))) return fail("Invalid template preference record");
    return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, parse(value)]));
  };
  const settings = (v: unknown) => record(v, value => {
    if (!object(value) || Object.keys(value).some(k => !["model", "effort", "variants"].includes(k))) return fail("Only model and effort preferences are supported");
    if (value.variants !== undefined && (!Array.isArray(value.variants) || value.variants.length > 128)) return fail("Invalid model variants");
    const variants = value.variants?.map((v: unknown) => { if (!object(v) || Object.keys(v).some(k => !["model", "effort"].includes(k))) return fail("Invalid model variant"); return { model: text(v.model, 256), ...(v.effort !== undefined ? { effort: text(v.effort, 64) } : {}) }; });
    return { ...(value.model !== undefined ? { model: text(value.model, 256) } : {}), ...(value.effort !== undefined ? { effort: text(value.effort, 64) } : {}), ...(variants ? { variants } : {}) };
  });
  return { roles: record(raw.roles ?? {}, value => list(value, 6)), options: record(raw.options ?? {}, value => typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : fail("Invalid workflow option")), agentSettings: settings(raw.agentSettings ?? {}), roleSettings: record(raw.roleSettings ?? {}, settings) };
}
function validTemplatePath(path: string) {
  return path === "*" || !!path && !/^[/-]|^[A-Za-z]:|[\\\x00-\x1f]/.test(path) && !path.split("/").some(p => !p || p === "." || p === ".." || p === ".git") && !path.includes("*");
}
export function fillTeamTemplate(template: TeamTemplate, inputs: Record<string, string>): TeamTemplate {
  if (Object.keys(inputs).some(k => !template.parameters.includes(k))) return fail("Unknown template input");
  for (const key of template.parameters) if (typeof inputs[key] !== "string" || !inputs[key]!.trim() || inputs[key]!.length > 10000) return fail(`Enter a value for ${key}`);
  const fill = (s: string) => s.replace(/\{\{([a-z][a-z0-9-]*)\}\}/g, (_, key: string) => inputs[key]!);
  return validateTeamTemplate({ ...template, task: fill(template.task), criteria: template.criteria.map(fill), contracts: template.contracts.map(fill), tasks: template.tasks.map(t => ({ ...t, title: fill(t.title), instructions: fill(t.instructions), acceptance: t.acceptance.map(fill), paths: t.paths.map(fill) })) });
}
/** Expansion is pure, bounded and deterministic. Runtime plan validation still checks ownership and requirements. */
export function expandTemplateUses(plan: TeamPlan, catalog: readonly TeamTemplate[]): TeamPlan {
  const tasks = [...plan.tasks], contracts = [...plan.contracts];
  if ((plan.templateUses?.length ?? 0) > 6) return fail("Too many template uses");
  const uses = new Set<string>();
  for (const use of plan.templateUses ?? []) {
    if (!/^[a-z][a-z0-9-]{0,11}$/.test(use.id) || uses.has(use.id)) return fail("Template instance IDs must be unique and at most 12 characters");
    uses.add(use.id);
    const source = catalog.find(t => t.id === use.templateId && t.version === use.version && !t.workflow);
    if (!source) return fail("Template version is not in this run's pinned catalog");
    const inputs = Object.fromEntries(use.inputs.map(i => [i.name, i.value]));
    const assignments = Object.fromEntries(use.assignments.map(a => [a.role, a.memberId]));
    if (Object.keys(inputs).length !== use.inputs.length || Object.keys(assignments).length !== use.assignments.length || Object.keys(assignments).some(r => !source.roles.includes(r))) return fail("Duplicate or unknown template bindings");
    const template = fillTeamTemplate(source, inputs);
    for (const role of template.roles) if (!assignments[role]) return fail(`Assign the ${role} template role`);
    for (const t of template.tasks) {
      const id = `${use.id}-${t.id}`;
      if (id.length > 40) return fail("Expanded task ID is too long");
      tasks.push({ id, title: t.title, kind: t.kind, owner: assignments[t.role]!, instructions: `${t.instructions}${use.instructions ? `\nTask-specific additions:\n${text(use.instructions)}` : ""}`, dependsOn: [...use.dependsOn, ...t.dependsOn.map(d => `${use.id}-${d}`)], ...(t.dependencyTypes ? { dependencyTypes: Object.fromEntries(Object.entries(t.dependencyTypes).map(([id, kind]) => [`${use.id}-${id}`, kind])) } : {}), requirements: [...use.requirements], paths: [...t.paths], acceptance: [...t.acceptance] });
    }
    contracts.push(...template.contracts, ...template.criteria);
  }
  if (tasks.length > 24 || contracts.length > 24) return fail("Expanded templates exceed the run's task or contract limits");
  return { ...plan, tasks, contracts };
}
export function templateFromPlan(plan: TeamPlan, input: { id: string; name: string; scope: "personal" | "project"; project?: string }): TeamTemplate {
  const owners = [...new Set(plan.tasks.map(t => t.owner))];
  const role = (owner: string) => `worker-${owners.indexOf(owner) + 1}`;
  return validateTeamTemplate({ schemaVersion: 1, ...input, version: 1, description: "Strategy saved from a run. Review task-specific instructions and replace them with parameters before reuse.", autoEnabled: false, parameters: ["task"], roles: owners.map(role), task: "{{task}}", criteria: [], contracts: [...plan.contracts], tasks: plan.tasks.map(t => ({ id: t.id, role: role(t.owner), title: t.title, kind: t.kind, instructions: t.instructions, dependsOn: [...t.dependsOn], ...(t.dependencyTypes ? { dependencyTypes: { ...t.dependencyTypes } } : {}), paths: [...t.paths], acceptance: [...t.acceptance] })) });
}
