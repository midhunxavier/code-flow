import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CODEFLOW_HOME } from "./config.js";
import { registerPrivateEnvNames } from "./env.js";
import { redactExport } from "./privacy.js";
import type { AgentAdapter } from "./adapters/types.js";
import type { Pattern } from "./engine.js";

export const EXTENSION_API = { major: 1, minor: 0, capabilities: ["provider-adapter", "workflow-pattern"] } as const;
export interface ExtensionManifest { id: string; version: string; module: string; sha256: string; api: { major: number; minimumMinor: number }; requires: string[] }
export interface CodeFlowExtension { api: { major: 1; minor: number }; providers?: AgentAdapter[]; workflows?: Pattern[] }
export interface ExtensionStatus { id: string; version: string; sha256: string; state: "loaded" | "rejected"; api?: { major: number; minor: number }; providers: string[]; workflows: string[]; error?: string }
export interface ExtensionConfiguration { state: "none" | "loaded" | "deferred" | "error"; source?: "file" | "json"; error?: string }
export interface ExtensionBinding { id: string; version: string; sha256: string }
const bindings = new Map<string, ExtensionBinding>();
export function extensionBindings(pattern: string, roles: Record<string, readonly string[]>): ExtensionBinding[] {
  const used = [...new Set([pattern, ...Object.values(roles).flat()].filter((id) => id.startsWith("plugin:")))];
  const result = used.map((id) => { const binding = bindings.get(id); if (!binding) throw new Error(`Restore the exact reviewed extension bundle and SHA-256 pin for ${id}, then restart; or create a new run. Check Settings → Extensions`); return binding; });
  return [...new Map(result.map((value) => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id)).map((value) => ({ ...value }));
}
export function assertExtensionBindings(run: { pattern: string; roles: Record<string, readonly string[]>; extensions?: ExtensionBinding[] }) {
  const current = extensionBindings(run.pattern, run.roles);
  if (JSON.stringify(current) !== JSON.stringify(run.extensions ?? [])) throw new Error("This run's provider/workflow extension version changed; restore its exact SHA-256 pin or create a new run");
}
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = /^[a-z][a-z0-9-]{0,40}$/;
const bounded = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max && !/[\x00-\x08\x0e-\x1f]/.test(value);
async function readBundle(path: string, ceiling: number) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const info = await file.stat(); if (!info.isFile() || info.size > ceiling) throw new Error("Extension file exceeds its regular-file bound"); const buffer = Buffer.alloc(ceiling + 1); let read = 0; while (read <= ceiling) { const next = await file.read(buffer, read, buffer.length - read, read); if (!next.bytesRead) break; read += next.bytesRead; } if (read > ceiling) throw new Error("Extension file grew beyond its bound"); return buffer.subarray(0, read); } finally { await file.close(); }
}
export function negotiateExtension(manifest: ExtensionManifest) {
  if (manifest.api.major !== EXTENSION_API.major || manifest.api.minimumMinor > EXTENSION_API.minor) throw new Error(`Extension requires API ${manifest.api.major}.${manifest.api.minimumMinor}; host supports ${EXTENSION_API.major}.${EXTENSION_API.minor}`);
  const missing = manifest.requires.filter((name) => !(EXTENSION_API.capabilities as readonly string[]).includes(name));
  if (missing.length) throw new Error(`Unsupported extension capabilities: ${missing.join(", ")}`);
  return { major: EXTENSION_API.major, minor: EXTENSION_API.minor };
}
function parseManifests(value: unknown): ExtensionManifest[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.extensions) || value.extensions.length > 16) throw new Error("Configure version 1 with at most 16 explicit extensions");
  const ids = new Set<string>();
  return value.extensions.map((raw: unknown) => {
    if (!object(raw) || Object.keys(raw).some((key) => !["id", "version", "module", "sha256", "api", "requires"].includes(key)) || typeof raw.id !== "string" || !identifier.test(raw.id) || ids.has(raw.id) || typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(raw.version) || !bounded(raw.module, 4000) || !isAbsolute(raw.module) || !/\.mjs$/.test(raw.module) || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256) || !object(raw.api) || Object.keys(raw.api).some((key) => !["major", "minimumMinor"].includes(key)) || !Number.isInteger(raw.api.major) || !Number.isInteger(raw.api.minimumMinor) || raw.api.minimumMinor < 0 || !Array.isArray(raw.requires) || raw.requires.length > 16 || raw.requires.some((item: unknown) => !bounded(item, 100))) throw new Error("Invalid extension identity, pinned bundle, version or capability requirements");
    ids.add(raw.id); return structuredClone(raw) as ExtensionManifest;
  });
}
/** Explicit local trusted-code plugins. Never discovers or executes a repository's plugin files. */
export class Extensions {
  private statuses: ExtensionStatus[] = [];
  private config: ExtensionConfiguration = { state: "none" };
  constructor(private readonly options: { home?: string; environment?: NodeJS.ProcessEnv; register: (providers: AgentAdapter[], workflows: Pattern[]) => void }) {}
  list() { return redactExport(structuredClone(this.statuses)); }
  configuration(): ExtensionConfiguration { return redactExport(structuredClone(this.config)); }
  defer(reason: string) {
    const environment = this.options.environment ?? process.env;
    const source = environment.CODEFLOW_EXTENSIONS_FILE ? "file" : environment.CODEFLOW_EXTENSIONS_JSON ? "json" : undefined;
    this.config = source ? { state: "deferred", source, error: reason.slice(0, 1000) } : { state: "none" };
  }
  async load() {
    this.statuses = [];
    try { await this.loadConfigured(); }
    catch (error) { this.config = { ...this.config, state: "error", error: (error as Error).message.slice(0, 1000) }; throw error; }
  }
  private async loadConfigured() {
    const environment = this.options.environment ?? process.env;
    registerPrivateEnvNames(["CODEFLOW_EXTENSIONS_FILE", "CODEFLOW_EXTENSIONS_JSON"]);
    this.config = { state: "none", ...(environment.CODEFLOW_EXTENSIONS_FILE ? { source: "file" as const } : environment.CODEFLOW_EXTENSIONS_JSON ? { source: "json" as const } : {}) };
    if (environment.CODEFLOW_EXTENSIONS_FILE && environment.CODEFLOW_EXTENSIONS_JSON) throw new Error("Choose one extension configuration source");
    let text = environment.CODEFLOW_EXTENSIONS_JSON;
    if (environment.CODEFLOW_EXTENSIONS_FILE) { const path = environment.CODEFLOW_EXTENSIONS_FILE; if (!isAbsolute(path)) throw new Error("Extension configuration must have an absolute path"); try { text = (await readBundle(path, 128 * 1024)).toString("utf8"); } catch (error) { throw new Error(`Extension configuration could not be read (${(error as NodeJS.ErrnoException).code ?? "file bounds"}). Use a readable regular file under 128 KiB.`); } }
    if (!text && !this.config.source) return;
    text ??= "";
    if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Extension configuration exceeds 128 KiB");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("Extension configuration is not valid JSON. Repair the configured document and restart."); }
    const manifests = parseManifests(parsed);
    this.config = { ...this.config, state: "loaded" };
    for (const manifest of manifests) {
      const status: ExtensionStatus = { id: manifest.id, version: manifest.version, sha256: manifest.sha256, state: "rejected", providers: [], workflows: [] };
      this.statuses.push(status);
      try {
        const negotiated = negotiateExtension(manifest);
        const info = await lstat(manifest.module); if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error("Plugin must be a bundled regular .mjs file under 512 KiB");
        const contents = await readBundle(manifest.module, 512 * 1024);
        if (contents.length > 512 * 1024 || createHash("sha256").update(contents).digest("hex") !== manifest.sha256) throw new Error("Plugin bundle changed; review it and update its SHA-256 pin explicitly");
        const directory = join(this.options.home ?? CODEFLOW_HOME, "extension-cache"); await mkdir(directory, { recursive: true, mode: 0o700 });
        const cacheInfo = await lstat(directory); if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) throw new Error("Extension cache must be a regular private directory");
        const cached = join(directory, `${manifest.id}-${manifest.sha256}.mjs`), temp = cached + `.${process.pid}.tmp`;
        // Import only captured, pinned bytes. Configuration changes take effect after restart.
        try { const file = await open(temp, "wx", 0o600); try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); } await rename(temp, cached); } finally { await unlink(temp).catch(() => undefined); }
        const extension: unknown = (await import(pathToFileURL(cached).href)).default;
        if (!object(extension) || !object(extension.api) || extension.api.major !== negotiated.major || !Number.isInteger(extension.api.minor) || extension.api.minor < manifest.api.minimumMinor || extension.api.minor > negotiated.minor || Object.keys(extension).some((key) => !["api", "providers", "workflows"].includes(key))) throw new Error("Plugin export does not match its negotiated API");
        const providers = extension.providers ?? [], workflows = extension.workflows ?? [];
        if (!Array.isArray(providers) || !Array.isArray(workflows) || providers.length > 8 || workflows.length > 8 || !providers.length && !workflows.length) throw new Error("Plugin must export 1–8 providers or workflows");
        for (const provider of providers) if (!object(provider) || !new RegExp(`^plugin:${manifest.id}/[a-z][a-z0-9-]{0,40}$`).test(provider.id) || !bounded(provider.displayName, 120) || !bounded(provider.binary, 200) || ["available", "catalog", "run"].some((key) => typeof provider[key] !== "function")) throw new Error("Provider needs a namespaced ID and the AgentAdapter contract");
        for (const workflow of workflows) {
          if (!object(workflow) || !new RegExp(`^plugin:${manifest.id}/[a-z][a-z0-9-]{0,40}$`).test(workflow.id) || !bounded(workflow.name, 120) || !bounded(workflow.summary, 500) || !bounded(workflow.description, 8000) || typeof workflow.run !== "function" || !Array.isArray(workflow.roles) || !workflow.roles.length || workflow.roles.length > 16 || !Array.isArray(workflow.options) || workflow.options.length > 16) throw new Error("Workflow needs a namespaced ID and the Pattern contract");
          const roles = new Set<string>();
          for (const role of workflow.roles) { if (!object(role) || !identifier.test(role.id) || roles.has(role.id) || !bounded(role.label, 120) || !bounded(role.description, 1000) || !Array.isArray(role.default) || role.default.length > 6 || role.default.some((id: unknown) => typeof id !== "string")) throw new Error("Invalid workflow role"); roles.add(role.id); }
          const options = new Set<string>();
          for (const option of workflow.options) { if (!object(option) || !identifier.test(option.id) || options.has(option.id) || !bounded(option.label, 120) || !["number", "boolean"].includes(option.type) || typeof option.default !== option.type || option.type === "number" && (!Number.isFinite(option.default) || option.min !== undefined && !Number.isFinite(option.min) || option.max !== undefined && !Number.isFinite(option.max) || option.min !== undefined && option.max !== undefined && option.min > option.max)) throw new Error("Invalid workflow option"); options.add(option.id); }
        }
        this.options.register(providers as AgentAdapter[], workflows as Pattern[]);
        const binding = { id: manifest.id, version: manifest.version, sha256: manifest.sha256 };
        for (const value of [...providers, ...workflows]) bindings.set(value.id, binding);
        status.state = "loaded"; status.api = negotiated; status.providers = providers.map((provider) => provider.id); status.workflows = workflows.map((workflow) => workflow.id);
      } catch (error) { status.error = (error as Error).message.slice(0, 1000); }
    }
  }
}
