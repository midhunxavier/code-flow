import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerPrivateEnvNames } from "./env.js";
import { redactText } from "./privacy.js";

export type ExternalSourceKind = "issue" | "pr";
export interface IntegrationConfig {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** The provider's project, repository or team identifier. */
  project: string;
  credentialEnv: string;
  usernameEnv?: string;
  auth: "bearer" | "basic" | "api-key";
}
export interface ExternalSourceItem {
  integration: string;
  provider: string;
  kind: ExternalSourceKind;
  key: string;
  title: string;
  body: string;
  url?: string;
  state?: string;
  sourceBranch?: string;
  targetBranch?: string;
  sha?: string;
}
/** Only a server-held import may become execution context; client bodies never establish trust. */
export interface ExternalSource extends ExternalSourceItem {
  id: string;
  importedAt: number;
  expiresAt: number;
  trusted: false;
  untrusted: true;
  /** Project context chosen and validated by the server when importing. */
  projectContext?: { project: string; repository: string };
}
export interface ExternalSourcePage { items: ExternalSourceItem[]; nextCursor?: string; truncated: boolean }
export type IntegrationRequest = (path: string, query?: { query: string; variables: Record<string, unknown> }) => Promise<{ data: any; headers: Headers }>;
/** No source providers are built in. Extensions receive a host-bound, bounded, read-only request client. No account mutation API exists. */
export interface ReadOnlySourceProvider {
  kinds: ExternalSourceKind[];
  list(config: IntegrationConfig, kind: ExternalSourceKind, request: IntegrationRequest, cursor?: string): Promise<ExternalSourcePage>;
  get(config: IntegrationConfig, kind: ExternalSourceKind, key: string, request: IntegrationRequest): Promise<ExternalSourceItem>;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const PAGE_SIZE = 50;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const IMPORT_TTL = 30 * 60_000;
const text = (value: unknown, limit = 20_000) => typeof value === "string" ? value.slice(0, limit) : "";
const urlOf = (value: unknown) => { try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };

export class Integrations {
  private configs: IntegrationConfig[] = [];
  private readonly imported = new Map<string, ExternalSource>();
  private readonly adapters: Record<string, ReadOnlySourceProvider>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  constructor(options: { adapters?: Record<string, ReadOnlySourceProvider>; environment?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.adapters = { ...options.adapters };
    this.environment = options.environment ?? process.env;
    this.fetcher = options.fetch ?? fetch;
  }
  async load(input?: unknown): Promise<void> {
    if (input === undefined) {
      const contents = this.environment.CODEFLOW_INTEGRATIONS_FILE ? await readFile(this.environment.CODEFLOW_INTEGRATIONS_FILE, "utf8") : this.environment.CODEFLOW_INTEGRATIONS_JSON;
      if (contents && contents.length > 256_000) throw new Error("Integration configuration exceeds 256 KB");
      try { input = contents ? JSON.parse(contents) : []; } catch { throw new Error("Integration configuration is not valid JSON"); }
    }
    if (!Array.isArray(input) || input.length > 20) throw new Error("Configure at most 20 read-only source integrations");
    const ids = new Set<string>();
    const configs = input.map((raw: any): IntegrationConfig => {
      if (!raw || typeof raw !== "object" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || ids.has(raw.id)) throw new Error("Integration IDs must be unique lowercase names");
      ids.add(raw.id);
      if (!Object.hasOwn(this.adapters, raw.provider)) throw new Error("Unknown integration provider");
      if (typeof raw.project !== "string" || !raw.project.trim() || raw.project.length > 200 || /[\x00-\x1f]/.test(raw.project)) throw new Error("Integration needs a project, repository or team");
      if (typeof raw.credentialEnv !== "string" || !ENV_NAME.test(raw.credentialEnv) || raw.usernameEnv !== undefined && (typeof raw.usernameEnv !== "string" || !ENV_NAME.test(raw.usernameEnv))) throw new Error("Credentials must name server environment variables");
      const auth = raw.auth ?? "bearer";
      if (!["bearer", "basic", "api-key"].includes(auth) || auth === "basic" && !raw.usernameEnv) throw new Error("Basic authentication also needs usernameEnv");
      let base: URL;
      try { base = new URL(raw.baseUrl); } catch { throw new Error("Integration needs a valid HTTPS API base URL"); }
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Integration API base URL must use HTTPS without credentials, query or fragment");
      if (!base.pathname.endsWith("/")) base.pathname += "/";
      return { id: raw.id, name: text(raw.name, 80) || raw.id, provider: raw.provider, baseUrl: base.href, project: raw.project.trim(), credentialEnv: raw.credentialEnv, usernameEnv: raw.usernameEnv, auth };
    });
    this.configs = configs;
    registerPrivateEnvNames(configs.flatMap((config) => [config.credentialEnv, ...(config.usernameEnv ? [config.usernameEnv] : [])]));
    this.imported.clear();
  }
  list() {
    return this.configs.map((c) => ({ id: c.id, name: c.name, provider: c.provider, project: c.project, kinds: this.adapters[c.provider]!.kinds, administratorManaged: true, configured: !!this.credential(c.credentialEnv) && (c.auth !== "basic" || !!this.credential(c.usernameEnv!)) }));
  }
  private credential(name: string) { return this.environment[name]; }
  private redact<T>(value: T): T {
    const secrets = this.configs.flatMap(c => [this.credential(c.credentialEnv), c.usernameEnv ? this.credential(c.usernameEnv) : undefined]).filter((secret): secret is string => !!secret);
    const visit = (item: unknown): unknown => typeof item === "string" ? redactText(item, secrets) : Array.isArray(item) ? item.map(visit) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)])) : item;
    return visit(value) as T;
  }
  private config(id: string, kind: ExternalSourceKind): IntegrationConfig {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error("Integration not found");
    if (!this.adapters[config.provider]!.kinds.includes(kind)) throw new Error("This integration does not support that source kind");
    return config;
  }
  async items(id: string, kind: ExternalSourceKind, cursor?: string): Promise<ExternalSourcePage> {
    const c = this.config(id, kind);
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 1_000 || /[\x00-\x1f]/.test(cursor))) throw new Error("Invalid integration page cursor");
    const page = await this.adapters[c.provider]!.list(c, kind, this.request(c), cursor);
    if (!Array.isArray(page.items)) throw new Error("Integration returned an invalid source list");
    return this.redact({ items: page.items.slice(0, PAGE_SIZE).map((value) => ({ ...this.bounded(c, kind, value), body: text(value.body, 1_000) })), nextCursor: text(page.nextCursor, 1_000) || undefined, truncated: page.truncated || page.items.length > PAGE_SIZE });
  }
  async importSource(id: string, kind: ExternalSourceKind, key: string, projectContext?: ExternalSource["projectContext"]): Promise<ExternalSource> {
    const c = this.config(id, kind);
    if (typeof key !== "string" || !key || key.length > 100) throw new Error("Invalid source key");
    const value = this.redact(await this.adapters[c.provider]!.get(c, kind, key, this.request(c)));
    const importedAt = Date.now();
    const source: ExternalSource = { ...this.bounded(c, kind, value), id: `source-${randomBytes(16).toString("hex")}`, importedAt, expiresAt: importedAt + IMPORT_TTL, trusted: false, untrusted: true, ...(projectContext ? { projectContext: { ...projectContext } } : {}) };
    this.expire();
    if (this.imported.size >= 200) this.imported.delete(this.imported.keys().next().value!);
    this.imported.set(source.id, structuredClone(source));
    return source;
  }
  resolveSource(id: string): ExternalSource {
    this.expire();
    const source = this.imported.get(id);
    if (!source) throw new Error("Imported source expired or is unknown; import it again");
    return structuredClone(source);
  }
  private expire() { for (const [id, source] of this.imported) if (source.expiresAt <= Date.now()) this.imported.delete(id); }
  private bounded(c: IntegrationConfig, kind: ExternalSourceKind, value: ExternalSourceItem): ExternalSourceItem {
    return { integration: c.id, provider: c.provider, kind, key: text(value.key, 100), title: text(value.title, 500), body: text(value.body), url: urlOf(value.url), state: text(value.state, 80) || undefined,
      sourceBranch: text(value.sourceBranch, 250) || undefined, targetBranch: text(value.targetBranch, 250) || undefined, sha: text(value.sha, 100) || undefined };
  }
  private request(c: IntegrationConfig): IntegrationRequest {
    return async (path, query) => {
      const base = new URL(c.baseUrl), url = new URL(path, base);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) throw new Error("Integration requests must stay within the configured API base");
      if (query && (!/^\s*query\b/.test(query.query) || /\bmutation\s*(?:\w+\s*)?[({]/.test(query.query))) throw new Error("Only read-only GraphQL queries are supported");
      const token = this.credential(c.credentialEnv);
      if (!token) throw new Error(`Credentials are unavailable for ${c.name}`);
      const headers: Record<string, string> = { accept: "application/json" };
      if (c.auth === "api-key") headers.authorization = token;
      else if (c.auth === "basic") {
        const username = this.credential(c.usernameEnv!);
        if (!username) throw new Error(`Credentials are unavailable for ${c.name}`);
        headers.authorization = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
      } else headers.authorization = `Bearer ${token}`;
      if (query) headers["content-type"] = "application/json";
      let response: Response;
      try { response = await this.fetcher(url, { method: query ? "POST" : "GET", headers, body: query ? JSON.stringify(query) : undefined, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
      catch { throw new Error(`Could not read ${c.provider}: connection, TLS or timeout failure`); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`${c.provider} read failed (HTTP ${response.status}); check credentials and read permissions`); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("Integration response exceeded 2 MB"); } chunks.push(value); } } finally { reader.releaseLock(); }
      let data: any;
      try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error(`${c.provider} returned invalid JSON`); }
      if (Array.isArray(data?.errors) && data.errors.length) throw new Error(`${c.provider} query was rejected; check project access and read permissions`);
      return { data, headers: response.headers };
    };
  }
}
