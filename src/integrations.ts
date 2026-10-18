import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerPrivateEnvNames } from "./env.js";

export type ExternalSourceKind = "issue" | "pr";
export interface IntegrationConfig {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** GitLab project path/ID, Bitbucket workspace/repository, Linear team key/ID, or Jira project key. */
  project: string;
  credentialEnv: string;
  usernameEnv?: string;
  auth: "bearer" | "basic" | "api-key" | "private-token";
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
}
export interface ExternalSourcePage { items: ExternalSourceItem[]; nextCursor?: string; truncated: boolean }
export type IntegrationRequest = (path: string, query?: { query: string; variables: Record<string, unknown> }) => Promise<{ data: any; headers: Headers }>;
/** Extensions receive a host-bound, bounded, read-only request client. No account mutation API exists. */
export interface ReadOnlySourceProvider {
  kinds: ExternalSourceKind[];
  list(config: IntegrationConfig, kind: ExternalSourceKind, request: IntegrationRequest, cursor?: string): Promise<ExternalSourcePage>;
  get(config: IntegrationConfig, kind: ExternalSourceKind, key: string, request: IntegrationRequest): Promise<ExternalSourceItem>;
}

const DEFAULTS: Record<string, { base: string; auth: IntegrationConfig["auth"] }> = {
  gitlab: { base: "https://gitlab.com/api/v4/", auth: "private-token" },
  bitbucket: { base: "https://api.bitbucket.org/2.0/", auth: "bearer" },
  linear: { base: "https://api.linear.app/", auth: "api-key" },
  jira: { base: "", auth: "basic" },
};
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const PAGE_SIZE = 50;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const IMPORT_TTL = 30 * 60_000;
const text = (value: unknown, limit = 20_000) => typeof value === "string" ? value.slice(0, limit) : "";
const urlOf = (value: unknown) => { try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const numberKey = (key: string) => { if (!/^[1-9]\d{0,11}$/.test(key)) throw new Error("Source key must be a positive issue or pull request number"); return key; };
const pageNumber = (cursor?: string) => { const page = Number(cursor ?? "1"); if (!Number.isInteger(page) || page < 1 || page > 20) throw new Error("Page must be between 1 and 20"); return page; };
const item = (config: IntegrationConfig, kind: ExternalSourceKind, values: Omit<ExternalSourceItem, "integration" | "provider" | "kind">): ExternalSourceItem => ({ integration: config.id, provider: config.provider, kind, ...values });

/** Converts Jira's structured description to bounded plain text without interpreting HTML. */
export function documentText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 20_000);
  let visited = 0;
  const parts: string[] = [];
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12 || ++visited > 3_000) return;
    if (typeof node.text === "string") parts.push(node.text.slice(0, 20_000));
    if (node.type === "hardBreak") parts.push("\n");
    if (Array.isArray(node.content)) for (const child of node.content.slice(0, 500)) visit(child, depth + 1);
    if (["paragraph", "heading", "listItem"].includes(node.type)) parts.push("\n");
  };
  visit(value, 0); return parts.join("").trim().slice(0, 20_000);
}

const gitlab: ReadOnlySourceProvider = {
  kinds: ["issue", "pr"],
  async list(c, kind, request, cursor) {
    const page = pageNumber(cursor);
    const { data, headers } = await request(`projects/${encodeURIComponent(c.project)}/${kind === "pr" ? "merge_requests" : "issues"}?state=opened&per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(data)) throw new Error("GitLab returned an invalid source list");
    const more = !!headers.get("x-next-page") || data.length >= PAGE_SIZE;
    return { items: data.slice(0, PAGE_SIZE).map((v) => gitlabItem(c, kind, v)), nextCursor: more && page < 20 ? String(page + 1) : undefined, truncated: more && page >= 20 };
  },
  async get(c, kind, key, request) {
    const { data } = await request(`projects/${encodeURIComponent(c.project)}/${kind === "pr" ? "merge_requests" : "issues"}/${numberKey(key)}`);
    return gitlabItem(c, kind, data);
  },
};
function gitlabItem(c: IntegrationConfig, kind: ExternalSourceKind, v: any) {
  if (!v || !Number.isSafeInteger(v.iid) || v.iid < 1) throw new Error("GitLab returned an invalid source");
  return item(c, kind, { key: String(v.iid), title: text(v.title, 500), body: text(v.description), url: urlOf(v.web_url), state: text(v.state, 80), sourceBranch: text(v.source_branch, 250) || undefined, targetBranch: text(v.target_branch, 250) || undefined, sha: text(v.sha, 100) || undefined });
}

const bitbucket: ReadOnlySourceProvider = {
  kinds: ["issue", "pr"],
  async list(c, kind, request, cursor) {
    const page = pageNumber(cursor);
    const { data } = await request(`${bitbucketPath(c)}/${kind === "pr" ? "pullrequests" : "issues"}?pagelen=${PAGE_SIZE}&page=${page}${kind === "pr" ? "&state=OPEN" : ""}`);
    if (!Array.isArray(data?.values)) throw new Error("Bitbucket returned an invalid source list");
    return { items: data.values.slice(0, PAGE_SIZE).map((v: any) => bitbucketItem(c, kind, v)), nextCursor: data.next && page < 20 ? String(page + 1) : undefined, truncated: !!data.next && page >= 20 };
  },
  async get(c, kind, key, request) {
    const { data } = await request(`${bitbucketPath(c)}/${kind === "pr" ? "pullrequests" : "issues"}/${numberKey(key)}`);
    return bitbucketItem(c, kind, data);
  },
};
const bitbucketPath = (c: IntegrationConfig) => `repositories/${c.project.split("/").map(encodeURIComponent).join("/")}`;
function bitbucketItem(c: IntegrationConfig, kind: ExternalSourceKind, v: any) {
  if (!v || !Number.isSafeInteger(v.id) || v.id < 1) throw new Error("Bitbucket returned an invalid source");
  return item(c, kind, { key: String(v.id), title: text(v.title, 500), body: text(kind === "pr" ? v.description : v.content?.raw), url: urlOf(v.links?.html?.href), state: text(v.state, 80), sourceBranch: text(v.source?.branch?.name, 250) || undefined, targetBranch: text(v.destination?.branch?.name, 250) || undefined, sha: text(v.source?.commit?.hash, 100) || undefined });
}

const LINEAR_FIELDS = "id identifier title description url state { name } team { id key }";
const linear: ReadOnlySourceProvider = {
  kinds: ["issue"],
  async list(c, kind, request, cursor) {
    const uuid = /^[0-9a-f-]{36}$/i.test(c.project);
    const connection = `nodes { ${LINEAR_FIELDS} } pageInfo { hasNextPage endCursor }`;
    const body = uuid ? `team(id: $team) { issues(first: 50, after: $after) { ${connection} } }` : `issues(first: 50, after: $after, filter: { team: { key: { eq: $team } } }) { ${connection} }`;
    const { data } = await request("graphql", { query: `query SourceIssues($team: String!, $after: String) { ${body} }`, variables: { team: c.project, after: cursor ?? null } });
    const page = uuid ? data?.data?.team?.issues : data?.data?.issues;
    if (!Array.isArray(page?.nodes)) throw new Error("Linear returned an invalid source list");
    return { items: page.nodes.slice(0, PAGE_SIZE).map((v: any) => linearItem(c, kind, v)), nextCursor: page.pageInfo?.hasNextPage ? text(page.pageInfo.endCursor, 1_000) || undefined : undefined, truncated: false };
  },
  async get(c, kind, key, request) {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) && !/^[0-9a-f-]{36}$/i.test(key)) throw new Error("Use a Linear issue identifier or UUID");
    const { data } = await request("graphql", { query: `query SourceIssue($id: String!) { issue(id: $id) { ${LINEAR_FIELDS} } }`, variables: { id: key } });
    return linearItem(c, kind, data?.data?.issue);
  },
};
function linearItem(c: IntegrationConfig, kind: ExternalSourceKind, v: any) {
  if (!v || typeof v.identifier !== "string" || ![v.team?.id, v.team?.key].includes(c.project)) throw new Error("Linear issue is absent from the configured team");
  return item(c, kind, { key: text(v.identifier, 100), title: text(v.title, 500), body: text(v.description), url: urlOf(v.url), state: text(v.state?.name, 80) });
}

const jira: ReadOnlySourceProvider = {
  kinds: ["issue"],
  async list(c, kind, request, cursor) {
    const query = new URLSearchParams({ jql: `project = "${c.project}" ORDER BY updated DESC`, maxResults: String(PAGE_SIZE), fields: "summary,description,status" });
    if (cursor) query.set("nextPageToken", cursor);
    const { data } = await request(`rest/api/3/search/jql?${query}`);
    if (!Array.isArray(data?.issues)) throw new Error("Jira returned an invalid source list");
    return { items: data.issues.slice(0, PAGE_SIZE).map((v: any) => jiraItem(c, kind, v)), nextCursor: text(data.nextPageToken, 1_000) || undefined, truncated: false };
  },
  async get(c, kind, key, request) {
    if (!new RegExp(`^${c.project}-[1-9]\\d*$`, "i").test(key)) throw new Error("Use an issue key from the configured Jira project");
    const { data } = await request(`rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status`);
    return jiraItem(c, kind, data);
  },
};
function jiraItem(c: IntegrationConfig, kind: ExternalSourceKind, v: any) {
  if (!v || typeof v.key !== "string" || !v.key.toUpperCase().startsWith(`${c.project.toUpperCase()}-`)) throw new Error("Jira issue is absent from the configured project");
  return item(c, kind, { key: text(v.key, 100), title: text(v.fields?.summary, 500), body: documentText(v.fields?.description), url: new URL(`browse/${encodeURIComponent(v.key)}`, c.baseUrl).href, state: text(v.fields?.status?.name, 80) });
}

export class Integrations {
  private configs: IntegrationConfig[] = [];
  private readonly imported = new Map<string, ExternalSource>();
  private readonly adapters: Record<string, ReadOnlySourceProvider>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch;
  constructor(options: { adapters?: Record<string, ReadOnlySourceProvider>; environment?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.adapters = { gitlab, bitbucket, linear, jira, ...options.adapters };
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
      if (raw.provider === "bitbucket" && !/^[\w.-]+\/[\w.-]+$/.test(raw.project)) throw new Error("Bitbucket project must be workspace/repository");
      if (raw.provider === "jira" && !/^[A-Za-z][A-Za-z0-9_]*$/.test(raw.project)) throw new Error("Jira project must be a project key");
      if (typeof raw.credentialEnv !== "string" || !ENV_NAME.test(raw.credentialEnv) || raw.usernameEnv !== undefined && (typeof raw.usernameEnv !== "string" || !ENV_NAME.test(raw.usernameEnv))) throw new Error("Credentials must name server environment variables");
      const auth = raw.auth ?? DEFAULTS[raw.provider]?.auth ?? "bearer";
      if (!["bearer", "basic", "api-key", "private-token"].includes(auth) || auth === "basic" && !raw.usernameEnv) throw new Error("Basic authentication also needs usernameEnv");
      let base: URL;
      try { base = new URL(raw.baseUrl ?? DEFAULTS[raw.provider]?.base); } catch { throw new Error("Integration needs a valid HTTPS API base URL"); }
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Integration API base URL must use HTTPS without credentials, query or fragment");
      if (!base.pathname.endsWith("/")) base.pathname += "/";
      return { id: raw.id, name: text(raw.name, 80) || raw.id, provider: raw.provider, baseUrl: base.href, project: raw.project.trim(), credentialEnv: raw.credentialEnv, usernameEnv: raw.usernameEnv, auth };
    });
    this.configs = configs;
    registerPrivateEnvNames(configs.flatMap((config) => [config.credentialEnv, ...(config.usernameEnv ? [config.usernameEnv] : [])]));
    this.imported.clear();
  }
  list() {
    return this.configs.map((c) => ({ id: c.id, name: c.name, provider: c.provider, project: c.project, kinds: this.adapters[c.provider]!.kinds, configured: !!this.environment[c.credentialEnv] && (c.auth !== "basic" || !!this.environment[c.usernameEnv!]) }));
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
    return { items: page.items.slice(0, PAGE_SIZE).map((value) => ({ ...this.bounded(c, kind, value), body: text(value.body, 1_000) })), nextCursor: text(page.nextCursor, 1_000) || undefined, truncated: page.truncated || page.items.length > PAGE_SIZE };
  }
  async importSource(id: string, kind: ExternalSourceKind, key: string): Promise<ExternalSource> {
    const c = this.config(id, kind);
    if (typeof key !== "string" || !key || key.length > 100) throw new Error("Invalid source key");
    const value = await this.adapters[c.provider]!.get(c, kind, key, this.request(c));
    const importedAt = Date.now();
    const source: ExternalSource = { ...this.bounded(c, kind, value), id: `source-${randomBytes(16).toString("hex")}`, importedAt, expiresAt: importedAt + IMPORT_TTL, trusted: false, untrusted: true };
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
      const token = this.environment[c.credentialEnv];
      if (!token) throw new Error(`Credentials are unavailable for integration ${c.id}`);
      const headers: Record<string, string> = { accept: "application/json" };
      if (c.auth === "private-token") headers["PRIVATE-TOKEN"] = token;
      else if (c.auth === "api-key") headers.authorization = token;
      else if (c.auth === "basic") {
        const username = this.environment[c.usernameEnv!];
        if (!username) throw new Error(`Credentials are unavailable for integration ${c.id}`);
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
