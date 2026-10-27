import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CODEFLOW_HOME } from "./config.js";
import { templatePreferences, validateTeamTemplate, type TeamTemplate } from "./team-templates.js";

interface Library { version: 1; revision: number; entries: TeamTemplate[] }
/** Someone published another version since this one was loaded (409, unlike a malformed request). */
export class TemplateConflictError extends Error {}
/** One atomic library document; all versions remain immutable. Serialized writes enforce CAS. */
export class TeamTemplateStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private home = CODEFLOW_HOME) {}
  private async read(): Promise<Library> {
    let raw: string;
    try { raw = await readFile(join(this.home, "team-templates.json"), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, entries: [] }; throw e; }
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("Team template library exceeds its storage limit");
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.entries)) throw new Error("Invalid team template library; restore a backup before saving");
    return { ...value, entries: value.entries.map(validateTeamTemplate) };
  }
  async list(project?: string, history = false): Promise<{ revision: number; templates: TeamTemplate[] }> {
    const library = await this.read();
    const visible = library.entries.filter(t => t.scope === "personal" || t.project === project);
    return { revision: library.revision, templates: history ? visible : visible.filter(t => !visible.some(other => other.id === t.id && other.version > t.version)) };
  }
  async resolve(id: string, version: number, project?: string): Promise<TeamTemplate> {
    const { templates } = await this.list(project, true);
    const template = templates.find(t => t.id === id && t.version === version);
    if (!template) throw new Error("Template version not found in this project or personal library");
    return template;
  }
  save(raw: unknown, expectedVersion: number): Promise<TeamTemplate> {
    const write = async () => {
      const template = validateTeamTemplate(raw);
      if (template.scope === "builtin") throw new Error("Copy a built-in template to your personal or project library");
      const library = await this.read();
      const prior = library.entries.filter(t => t.id === template.id).sort((a, b) => b.version - a.version)[0];
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("expectedVersion must be the loaded version (0 for a new template)");
      if ((prior?.version ?? 0) !== expectedVersion) throw new TemplateConflictError("Template changed; reload before publishing a new version");
      if (template.version !== expectedVersion + 1) throw new Error(`Publish this edit as version ${expectedVersion + 1}`);
      if (prior && (prior.scope !== template.scope || prior.project !== template.project)) throw new Error("Copy the template with a new ID to change its scope");
      library.entries.push(template); library.revision++;
      const data = JSON.stringify(library, null, 2) + "\n";
      if (Buffer.byteLength(data) > 16 * 1024 * 1024 || library.entries.length > 1000) throw new Error("Team template library is full; export a backup before pruning versions");
      await mkdir(this.home, { recursive: true });
      const temp = join(this.home, `team-templates.${randomUUID()}.tmp`);
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        await rename(temp, join(this.home, "team-templates.json"));
        const dir = await open(this.home, "r"); try { await dir.sync(); } finally { await dir.close(); }
      } finally { await rm(temp, { force: true }); }
      return template;
    };
    const result = this.tail.then(write); this.tail = result.catch(() => {}); return result;
  }
  /** Stable migration identity means retries do not create duplicates; original browser data stays intact. */
  async migrate(raw: unknown, project?: string): Promise<{ imported: number; notes: string[] }> {
    if (!raw || typeof raw !== "object" || (raw as any).schemaVersion !== 1) throw new Error("Expected a version 1 composer library");
    const library = raw as any;
    if (!Array.isArray(library.templates) || !Array.isArray(library.presets) || library.templates.length + library.presets.length > 200 || JSON.stringify(raw).length > 1024 * 1024) throw new Error("Invalid legacy library");
    let imported = 0;
    const notes = ["Original browser library retained. Role/model preferences and workflow options preserved. Run permissions, approval settings, credentials, host bindings, and spending limits were not imported."];
    for (const entry of [...library.templates.map((t: any) => ({ ...t, migrationKind: "template" })), ...library.presets.map((p: any) => ({ ...p, migrationKind: "preset", pattern: p.config?.pattern, task: "{{task}}", criteria: [] }))]) {
      const id = `legacy-${createHash("sha256").update(JSON.stringify([project ?? "personal", entry.migrationKind, entry.id])).digest("hex").slice(0, 24)}`;
      const config = entry.config ?? {}, options = entry.runOptions ?? {}, dropped: string[] = [];
      const present = (value: unknown) => value !== undefined && value !== null && value !== "" && value !== false && (typeof value !== "object" || Object.keys(value).length > 0);
      for (const [key, label] of Object.entries({ check: "verification command", setup: "setup command", baseRef: "starting branch", contextBudget: "context budget", trust: "permissions", toolApprovals: "tool approvals", approvePlan: "plan approval", limits: "execution limits" })) if (present(config[key])) dropped.push(label);
      if (present(options.verification)) dropped.push(`${String(options.verification)} verification profile`);
      if (options.container?.enabled) dropped.push("Docker isolation");
      for (const [key, label] of Object.entries({ taskTeam: "chat team configuration", remoteWorker: "remote worker", toolApprovals: "tool approvals", permissionRequirements: "permission requirements", antigravityExecution: "Antigravity execution mode" })) if (present(options[key])) dropped.push(label);
      const note = dropped.length ? `${entry.name}: ${[...new Set(dropped)].join(", ")} were not imported; they remain in the browser library.` : "";
      if (note) notes.push(note);
      if ((await this.list(project)).templates.some(t => t.id === id)) continue;
      const normalize = (s: string) => s.replace(/\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g, (_, key: string) => `{{${key.replace(/_/g, "-").toLowerCase()}}}`);
      const task = normalize(String(entry.task ?? "{{task}}")), criteria = (entry.criteria ?? []).map((s: string) => normalize(s));
      const params = [...new Set([...[task, ...criteria].join("\n").matchAll(/\{\{([a-z][a-z0-9-]*)\}\}/g)].map(m => m[1]!))];
      const preferences = entry.config ? templatePreferences({ roles: entry.config.roles ?? {}, options: entry.config.options ?? {}, agentSettings: entry.config.agentSettings ?? {}, roleSettings: entry.config.roleSettings ?? {} }) : undefined;
      await this.save({ schemaVersion: 1, id, version: 1, name: entry.name, description: note || "Migrated task/workflow template; original settings remain in the browser backup.", scope: project ? "project" : "personal", ...(project ? { project } : {}), autoEnabled: false, parameters: params, roles: [], tasks: [], contracts: [], workflow: entry.pattern, task, criteria, ...(preferences ? { preferences } : {}) }, 0);
      imported++;
    }
    return { imported, notes };
  }
}
export const teamTemplateStore = new TeamTemplateStore();
