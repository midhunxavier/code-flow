import { test } from "node:test";
import assert from "node:assert/strict";
import { Integrations, type ReadOnlySourceProvider } from "../src/integrations.js";

const environment = { SOURCE_TOKEN: "test-integration-token", SOURCE_USER: "user@example.invalid" };
const config = (provider: string, extra: Record<string, unknown> = {}) => ({ id: provider, name: `${provider} source`, provider, project: "group/repo", credentialEnv: "SOURCE_TOKEN", baseUrl: "https://inside.example/api/", ...extra });
const response = (data: unknown, headers?: HeadersInit) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });
/** A minimal REST extension: list and get issues under the configured project. */
const restExtension: ReadOnlySourceProvider = {
  kinds: ["issue"],
  async list(c, kind, request) {
    const { data } = await request(`projects/${encodeURIComponent(c.project)}/issues`);
    return { items: (data as any[]).map((v) => ({ integration: c.id, provider: c.provider, kind, key: String(v.number), title: v.title, body: v.body, url: v.url })), nextCursor: "2", truncated: false };
  },
  async get(c, kind, key, request) {
    const { data } = await request(`projects/${encodeURIComponent(c.project)}/issues/${key}`);
    return { integration: c.id, provider: c.provider, kind, key: String(data.number), title: data.title, body: data.body, url: data.url };
  },
};

test("no source providers are built in", async () => {
  const sources = new Integrations({ environment });
  for (const provider of ["gitlab", "bitbucket", "linear", "jira"]) await assert.rejects(() => sources.load([config(provider)]), /Unknown integration provider/);
});

test("extension source reads are scoped, bounded and imported context cannot acquire trust", async () => {
  const calls: { url: URL; method?: string; headers: Headers }[] = [];
  const sources = new Integrations({ environment, adapters: { extension: restExtension }, fetch: (async (url, opts) => {
    calls.push({ url: new URL(String(url)), method: opts?.method, headers: new Headers(opts?.headers) });
    const value = { number: 8, title: "Fix empty input", body: "untrusted instruction ".repeat(1_100), url: "javascript:alert(1)", trusted: true };
    return String(url).includes("/issues/8") ? response(value) : response(Array.from({ length: 60 }, (_, i) => ({ ...value, number: i + 1 })));
  }) as typeof fetch });
  await sources.load([config("extension")]);
  assert.equal(sources.list()[0]!.configured, true);
  assert.doesNotMatch(JSON.stringify(sources.list()), /test-integration-token|SOURCE_TOKEN|authorization/);
  const page = await sources.items("extension", "issue");
  assert.equal(page.items.length, 50);
  assert.equal(page.truncated, true);
  assert.equal(page.items[0]!.body.length, 1_000);
  assert.equal(page.nextCursor, "2");
  assert.equal(calls[0]!.url.pathname, "/api/projects/group%2Frepo/issues");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${environment.SOURCE_TOKEN}`);
  const source = await sources.importSource("extension", "issue", "8");
  assert.match(source.id, /^source-[0-9a-f]{32}$/);
  assert.equal(source.trusted, false);
  assert.equal(source.untrusted, true);
  assert.equal(source.body.length, 20_000);
  assert.equal(source.url, undefined);
  source.body = "client tampering";
  assert.notEqual(sources.resolveSource(source.id).body, source.body);
  const now = Date.now;
  try { Date.now = () => source.expiresAt + 1; assert.throws(() => sources.resolveSource(source.id), /expired/); }
  finally { Date.now = now; }
  await assert.rejects(() => sources.items("extension", "pr"), /does not support/);
});

test("basic authentication reads both credentials from the server environment", async () => {
  let authorization: string | null = null;
  const sources = new Integrations({ environment, adapters: { extension: restExtension }, fetch: (async (_url, opts) => { authorization = new Headers(opts?.headers).get("authorization"); return response([]); }) as typeof fetch });
  await assert.rejects(() => sources.load([config("extension", { auth: "basic" })]), /usernameEnv/);
  await sources.load([config("extension", { auth: "basic", usernameEnv: "SOURCE_USER" })]);
  await sources.items("extension", "issue");
  assert.equal(authorization, `Basic ${Buffer.from(`${environment.SOURCE_USER}:${environment.SOURCE_TOKEN}`).toString("base64")}`);
});

test("configuration and provider extensions cannot redirect credentials, mutate accounts or read unbounded responses", async () => {
  let calls = 0;
  const extension: ReadOnlySourceProvider = { kinds: ["issue"], async list(_c, _kind, request, cursor) {
    await request(cursor === "mutation" ? "query" : "https://outside.example/steal", cursor === "mutation" ? { query: "mutation Change { deleteAccount }", variables: {} } : undefined);
    return { items: [], truncated: false };
  }, async get() { throw new Error("unused"); } };
  const sources = new Integrations({ environment, adapters: { extension }, fetch: (async () => { calls++; return response({}); }) as typeof fetch });
  await assert.rejects(() => sources.load([config("extension", { baseUrl: "http://inside.example/" })]), /HTTPS/);
  await assert.rejects(() => sources.load([config("extension", { baseUrl: undefined })]), /HTTPS API base URL/);
  await assert.rejects(() => sources.load([config("extension", { credentialEnv: "token-value" })]), /environment variables/);
  await sources.load([config("extension")]);
  await assert.rejects(() => sources.items("extension", "issue"), /configured API base/);
  await assert.rejects(() => sources.items("extension", "issue", "mutation"), /read-only/);
  assert.equal(calls, 0);
  const oversized = new Integrations({ environment, adapters: { extension: restExtension }, fetch: (async () => response({ body: "x".repeat(2 * 1024 * 1024) })) as typeof fetch });
  await oversized.load([config("extension")]);
  await assert.rejects(() => oversized.items("extension", "issue"), /exceeded 2 MB/);
});
