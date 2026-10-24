import { constants } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { git } from "./git.js";
import { ghAuthStatus, listIssues } from "./github.js";
import { Integrations, type IntegrationConfig } from "./integrations.js";
import type { Notifications, TargetConfig } from "./notifications.js";

export const CONNECTION_PROVIDERS = ["github", "gitlab", "bitbucket", "linear", "jira", "slack", "webhook"] as const;
export type ConnectionProvider = typeof CONNECTION_PROVIDERS[number];
export interface ConnectionBinding { projectId: string; repository: string; connectionId: string }
interface ConnectionRecord {
  id: string; name: string; provider: ConnectionProvider; scope: string; baseUrl?: string; gitBaseUrl?: string;
  auth?: IntegrationConfig["auth"]; repository?: string; credentialRef?: string; usernameRef?: string; urlRef?: string;
  updatedAt: number;
}
interface ConnectionState { version: 1; connections: ConnectionRecord[]; bindings: ConnectionBinding[]; secrets: Record<string, string> }
export interface ConnectionSummary {
  id: string; name: string; provider: string; scope: string; configured: boolean; administratorManaged: boolean;
  capabilities: string[]; baseUrl?: string; gitBaseUrl?: string; auth?: string; repository?: string;
}
export interface ConnectionDraft {
  id?: string; name?: string; provider: ConnectionProvider; scope?: string; baseUrl?: string; gitBaseUrl?: string;
  auth?: IntegrationConfig["auth"]; repository?: string; credential?: string; username?: string; url?: string;
}
const empty = (): ConnectionState => ({ version: 1, connections: [], bindings: [], secrets: {} });
const identifier = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;
const notify = (provider: string) => provider === "slack" || provider === "webhook";
const capabilities = (provider: string) => provider === "github" ? ["Issues", "Pull requests", "CI logs", "Publish verified results"] : ["gitlab", "bitbucket"].includes(provider) ? ["Issues", "Pull requests", "Publish verified results"] : notify(provider) ? ["Project notifications", "Test notification"] : ["Issues"];
function bounded(value: unknown, name: string, max = 200, required = true): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value) || required && !value.trim()) throw new Error(`Enter a valid ${name}`);
  return value.trim();
}
function https(value: string, label: string, query = false): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error(`Enter a valid HTTPS ${label}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !query && url.search) throw new Error(`Use HTTPS for ${label}, without embedded credentials${query ? "" : " or query parameters"}`);
  return url;
}

/** Extract only public remote identity: userinfo and query strings never reach the browser. */
export function describeGitRemote(value: string): { provider?: ConnectionProvider; scope: string; host: string } | undefined {
  const scp = value.match(/^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/);
  if (scp && !value.includes("://") && !value.includes("@") && !scp[1]!.includes(".") && scp[1] !== "localhost") return;
  let host: string, path: string;
  try { const url = scp && !value.includes("://") ? new URL(`ssh://${scp[1]}/${scp[2]}`) : new URL(value); if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return; host = url.hostname; path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""); } catch { return; }
  if (!path || /[?#\x00-\x1f]/.test(path)) return;
  return { host, scope: path, provider: host === "github.com" ? "github" : host === "gitlab.com" || /^gitlab\./.test(host) ? "gitlab" : host === "bitbucket.org" ? "bitbucket" : undefined };
}
export async function repositoryConnectionHint(repository: string) {
  const result = await git(["remote", "get-url", "origin"], repository, { timeoutMs: 5_000 });
  return result.code === 0 ? describeGitRemote(result.stdout.trim()) : undefined;
}

/** Owner-only connection registry. Credentials are encrypted at rest and never exported to process.env. */
export class IntegrationConnections {
  private state = empty();
  private key?: Buffer;
  private ready = false;
  private queue: Promise<unknown> = Promise.resolve();
  private tests = new Map<string, { record: ConnectionRecord; secrets: Record<string, string>; previous?: number; expiresAt: number }>();
  private readonly directory: string;
  constructor(private readonly options: { integrations: Integrations; notifications: Notifications; directory?: string; fetch?: typeof fetch; githubTest?: (repository: string) => Promise<void> }) {
    this.directory = options.directory ?? join(CODEFLOW_HOME, "integration-secrets");
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" && (info.mode & 0o077)) throw new Error("Integration credential directory must be private to this user");
    const keyPath = join(this.directory, "master.key"), file = join(this.directory, "connections.enc");
    const existing = await this.readPrivate(file);
    let key = await this.readPrivate(keyPath);
    if (!key) {
      if (existing) throw new Error("Integration encryption key is missing; restore the original key before reconnecting");
      key = randomBytes(32); const handle = await open(keyPath, "wx", 0o600);
      try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
    }
    if (key.length !== 32) throw new Error("Integration encryption key is invalid");
    this.key = key;
    if (existing) {
      try {
        const sealed = JSON.parse(existing.toString("utf8"));
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
        decipher.setAAD(Buffer.from("code-flow-integrations-v1")); decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
        if (state.version !== 1 || !Array.isArray(state.connections) || state.connections.length > 40 || !Array.isArray(state.bindings) || state.bindings.length > 500 || !state.secrets || typeof state.secrets !== "object") throw new Error("Invalid state");
        this.state = state;
      } catch { throw new Error("Integration credentials could not be opened. Original files were preserved; restore the matching key and data"); }
    }
    await this.apply(this.state); this.ready = true;
  }
  private assertReady() { if (!this.ready) throw new Error("Integration connection storage is unavailable. Check the server log before reconnecting"); }
  private async readPrivate(file: string) {
    let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1024 * 1024 || process.platform !== "win32" && (stat.mode & 0o077)) throw new Error("Integration credential files must be private regular files under 1 MiB"); return await handle.readFile(); } finally { await handle.close(); }
  }
  private async save(state: ConnectionState) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key!, iv); cipher.setAAD(Buffer.from("code-flow-integrations-v1"));
    const data = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const contents = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    const temporary = join(this.directory, `${identifier("save")}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(this.directory, "connections.enc"));
      if (process.platform !== "win32") { const folder = await open(this.directory, "r"); try { await folder.sync(); } finally { await folder.close(); } }
    } finally { await rm(temporary, { force: true }); }
  }
  private configuration(record: ConnectionRecord, secrets: Record<string, string>) {
    const token = `CODEFLOW_CONNECTION_${record.id.replaceAll("-", "_").toUpperCase()}_TOKEN`, username = `${token}_USER`, url = `${token}_URL`;
    const environment = { [token]: secrets[record.credentialRef ?? ""], [username]: secrets[record.usernameRef ?? ""], [url]: secrets[record.urlRef ?? ""] };
    const integration: IntegrationConfig = { id: record.id, name: record.name, provider: record.provider, project: record.scope, baseUrl: record.baseUrl!, gitBaseUrl: record.gitBaseUrl, auth: record.auth!, credentialEnv: token, ...(record.usernameRef ? { usernameEnv: username } : {}) };
    const notification: TargetConfig = { id: record.id, name: record.name, protocol: record.provider as "slack" | "webhook", urlEnv: url, ...(record.credentialRef ? { secretEnv: token } : {}) };
    return { environment, integration, notification };
  }
  private async apply(state: ConnectionState) {
    const integrations: IntegrationConfig[] = [], notifications: TargetConfig[] = [], sourceEnvironment: NodeJS.ProcessEnv = {}, notificationEnvironment: NodeJS.ProcessEnv = {};
    for (const record of state.connections) {
      if (record.provider === "github") continue;
      const config = this.configuration(record, state.secrets);
      if (notify(record.provider)) { notifications.push(config.notification); Object.assign(notificationEnvironment, config.environment); }
      else { integrations.push(config.integration); Object.assign(sourceEnvironment, config.environment); }
    }
    await this.options.integrations.applyManaged(integrations, sourceEnvironment);
    await this.options.notifications.applyManaged(notifications, notificationEnvironment);
  }
  private change<T>(update: (next: ConnectionState) => T): Promise<T> {
    this.assertReady();
    const work = this.queue.then(async () => {
      const next = structuredClone(this.state), result = update(next);
      const refs = new Set(next.connections.flatMap(c => [c.credentialRef, c.usernameRef, c.urlRef]).filter(Boolean));
      next.secrets = Object.fromEntries(Object.entries(next.secrets).filter(([ref]) => refs.has(ref)));
      try { await this.apply(next); await this.save(next); this.state = next; return result; }
      catch (error) { await this.apply(this.state); throw error; }
    }); this.queue = work.catch(() => undefined); return work;
  }
  list(): ConnectionSummary[] {
    this.assertReady();
    const managed = this.state.connections.map(c => ({ id: c.id, name: c.name, provider: c.provider, scope: c.scope, baseUrl: c.baseUrl, gitBaseUrl: c.gitBaseUrl, auth: c.auth, repository: c.repository, configured: true, administratorManaged: false, capabilities: capabilities(c.provider) }));
    const admin = this.options.integrations.list().filter(c => c.administratorManaged).map(c => ({ id: c.id, name: c.name, provider: c.provider, scope: c.project, configured: c.configured, administratorManaged: true, capabilities: capabilities(c.provider) }));
    const destinations = this.options.notifications.list().filter(c => c.administratorManaged).map(c => ({ id: `notification:${c.id}`, name: c.name, provider: c.protocol, scope: c.host ?? "", configured: c.configured, administratorManaged: true, capabilities: capabilities(c.protocol) }));
    return [...managed, ...admin, ...destinations];
  }
  bindings(projectId: string) { this.assertReady(); return structuredClone(this.state.bindings.filter(b => b.projectId === projectId)); }
  get(id: string) { const connection = this.list().find(c => c.id === id); if (!connection) throw new Error("Connection not found"); return connection; }
  async testDraft(input: ConnectionDraft) {
    this.assertReady();
    if (!input || !CONNECTION_PROVIDERS.includes(input.provider)) throw new Error("Choose a supported service");
    const previous = input.id ? this.state.connections.find(c => c.id === input.id) : undefined;
    if (input.id && !previous) throw new Error("This connection is administrator-managed or no longer exists");
    if (previous && previous.provider !== input.provider) throw new Error("Reconnect the same service");
    const record: ConnectionRecord = { id: previous?.id ?? identifier("connection"), provider: input.provider, name: bounded(input.name || input.provider, "connection name", 80), scope: bounded(input.scope, "repository or workspace", 200, !notify(input.provider)), updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1) };
    const secrets: Record<string, string> = {};
    const credential = (field: "credentialRef" | "usernameRef" | "urlRef", value: unknown, required: boolean, max = 8192) => {
      const secret = value ? bounded(value, "credential", max) : previous?.[field] ? this.state.secrets[previous[field]!] : "";
      if (!secret) { if (required) throw new Error("Enter the credentials for this service"); return; }
      const ref = identifier("secret"); record[field] = ref; secrets[ref] = secret;
    };
    if (input.provider === "github") {
      record.repository = bounded(input.repository, "local repository", 4096);
      await this.checkGithub(record.repository);
      const hint = await repositoryConnectionHint(record.repository);
      if (hint && hint.provider && hint.provider !== "github") throw new Error("Choose a GitHub repository for this connection");
      if (hint) record.scope = hint.scope;
    } else if (notify(input.provider)) {
      credential("urlRef", input.url, true, 4096); credential("credentialRef", input.credential, false);
      const destination = https(secrets[record.urlRef!]!, "webhook URL", true);
      if (input.provider === "slack" && !["hooks.slack.com", "hooks.slack-gov.com"].includes(destination.hostname)) throw new Error("Use a Slack incoming webhook URL");
      record.scope = destination.hostname;
    } else {
      credential("credentialRef", input.credential, true);
      record.auth = input.auth ?? ({ gitlab: "private-token", bitbucket: "bearer", linear: "api-key", jira: "basic" } as const)[input.provider];
      if (record.auth === "basic") credential("usernameRef", input.username, true, 320);
      record.baseUrl = input.baseUrl || ({ gitlab: "https://gitlab.com/api/v4/", bitbucket: "https://api.bitbucket.org/2.0/", linear: "https://api.linear.app/", jira: "" } as const)[input.provider];
      record.baseUrl = https(record.baseUrl, "API address").href;
      if (input.gitBaseUrl) record.gitBaseUrl = https(input.gitBaseUrl, "Git address").href;
      const config = this.configuration(record, secrets), client = new Integrations({ environment: config.environment, fetch: this.options.fetch });
      await client.load([config.integration]); await client.items(record.id, "issue");
    }
    for (const [id, test] of this.tests) if (test.expiresAt <= Date.now()) this.tests.delete(id);
    if (this.tests.size >= 20) this.tests.delete(this.tests.keys().next().value!);
    const testId = identifier("connection-test"), expiresAt = Date.now() + 5 * 60_000;
    this.tests.set(testId, { record, secrets, previous: previous?.updatedAt, expiresAt });
    return { testId, expiresAt, message: notify(record.provider) ? "HTTPS destination validated. After connecting, use Send test notification to verify delivery." : "Connection verified. Repository or workspace is accessible." };
  }
  async connect(testId: string, binding?: Omit<ConnectionBinding, "connectionId">) {
    const test = this.tests.get(testId);
    if (!test || test.expiresAt <= Date.now()) throw new Error("Test this connection again before connecting");
    if (binding && test.record.provider === "github" && binding.repository !== test.record.repository) throw new Error("Connect the GitHub repository that was tested");
    return this.change(next => {
      if (next.connections.find(c => c.id === test.record.id)?.updatedAt !== test.previous) throw new Error("Connection changed. Test again before reconnecting");
      if (!test.previous && next.connections.length >= 40) throw new Error("Connection limit reached; disconnect an unused service");
      next.connections = [...next.connections.filter(c => c.id !== test.record.id), test.record]; Object.assign(next.secrets, test.secrets);
      if (binding) this.setBinding(next, { ...binding, connectionId: test.record.id });
      this.tests.delete(testId); return { id: test.record.id };
    });
  }
  async testExisting(id: string, repository?: string) {
    const connection = this.get(id);
    if (connection.provider === "github") await this.checkGithub(repository || connection.repository!);
    else if (notify(connection.provider)) return { message: "Use Send test notification to verify this destination. Testing sends a message." };
    else await this.options.integrations.items(id, "issue");
    return { message: "Connection verified." };
  }
  private async checkGithub(repository: string) {
    if (this.options.githubTest) return this.options.githubTest(repository);
    if (!(await ghAuthStatus(repository)).ok) throw new Error("Sign in on this computer with gh auth login, then test again. Code Flow reuses that login.");
    try { await listIssues(repository, 1); } catch { throw new Error("GitHub could not read this repository. Check its remote, your gh login and repository access."); }
  }
  private setBinding(next: ConnectionState, binding: ConnectionBinding) {
    next.bindings = next.bindings.filter(b => !(b.projectId === binding.projectId && b.repository === binding.repository && b.connectionId === binding.connectionId));
    if (next.bindings.length >= 500) throw new Error("Project connection limit reached");
    next.bindings.push(binding);
  }
  async associate(binding: ConnectionBinding) {
    const connection = this.get(binding.connectionId);
    if (connection.provider === "github") {
      const hint = await repositoryConnectionHint(binding.repository);
      if (!hint || hint.scope.toLowerCase() !== connection.scope.toLowerCase()) throw new Error("Choose the local repository matching this GitHub connection");
    }
    await this.change(next => this.setBinding(next, binding));
  }
  async detach(binding: ConnectionBinding) { await this.change(next => { next.bindings = next.bindings.filter(b => !(b.projectId === binding.projectId && b.repository === binding.repository && b.connectionId === binding.connectionId)); }); }
  requireBinding(binding: ConnectionBinding) { if (!this.bindings(binding.projectId).some(b => b.repository === binding.repository && b.connectionId === binding.connectionId)) throw new Error("Connect this service to the selected project and repository first"); return this.get(binding.connectionId); }
  async disconnect(id: string) {
    if (this.get(id).administratorManaged) throw new Error("Administrator-managed connections must be removed from the server environment configuration");
    await this.change(next => { next.connections = next.connections.filter(c => c.id !== id); next.bindings = next.bindings.filter(b => b.connectionId !== id); });
  }
}
