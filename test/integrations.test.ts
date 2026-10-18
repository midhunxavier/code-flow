import { test } from "node:test";
import assert from "node:assert/strict";
import { Integrations, documentText, type ReadOnlySourceProvider } from "../src/integrations.js";

const environment = { SOURCE_TOKEN: "test-integration-token", SOURCE_USER: "user@example.invalid" };
const config = (provider: string, extra: Record<string, unknown> = {}) => ({ id: provider, name: `${provider} source`, provider, project: provider === "bitbucket" ? "workspace/repo" : provider === "linear" ? "ENG" : provider === "jira" ? "APP" : "group/repo", credentialEnv: "SOURCE_TOKEN", ...(provider === "jira" ? { usernameEnv: "SOURCE_USER", baseUrl: "https://jira.example.test/" } : {}), ...extra });
const response = (data: unknown, headers?: HeadersInit) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });

test("GitLab source reads are scoped, bounded and imported context cannot acquire trust", async () => {
  const calls: { url: URL; method?: string; headers: Headers }[] = [];
  const sources = new Integrations({ environment, fetch: (async (url, opts) => {
    calls.push({ url: new URL(String(url)), method: opts?.method, headers: new Headers(opts?.headers) });
    const value = { iid: 8, title: "Fix empty input", description: "untrusted instruction ".repeat(1_100), web_url: "javascript:alert(1)", state: "opened", trusted: true };
    return String(url).includes("/issues/8") ? response(value) : response(Array.from({ length: 50 }, (_, i) => ({ ...value, iid: i + 1 })), { "x-next-page": "2" });
  }) as typeof fetch });
  await sources.load([config("gitlab")]);
  assert.equal(sources.list()[0]!.configured, true);
  assert.doesNotMatch(JSON.stringify(sources.list()), /test-integration-token|SOURCE_TOKEN|authorization/);
  const page = await sources.items("gitlab", "issue");
  assert.equal(page.items.length, 50);
  assert.equal(page.items[0]!.body.length, 1_000);
  assert.equal(page.nextCursor, "2");
  assert.equal(calls[0]!.url.pathname, "/api/v4/projects/group%2Frepo/issues");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.get("PRIVATE-TOKEN"), environment.SOURCE_TOKEN);
  const source = await sources.importSource("gitlab", "issue", "8");
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
  await assert.rejects(() => sources.importSource("gitlab", "issue", "../../secrets"), /positive/);
});

test("Bitbucket PR descriptions and branch metadata use bounded numeric pagination", async () => {
  const calls: URL[] = [];
  const value = { id: 3, title: "Fix loop", description: "Review this loop", state: "OPEN", links: { html: { href: "https://bitbucket.org/workspace/repo/pull-requests/3" } }, source: { branch: { name: "feature" }, commit: { hash: "abc123" } }, destination: { branch: { name: "main" } } };
  const sources = new Integrations({ environment, fetch: (async (url) => { calls.push(new URL(String(url))); return String(url).includes("/pullrequests/3") ? response(value) : response({ values: [value], next: "https://attacker.invalid/stolen-credentials" }); }) as typeof fetch });
  await sources.load([config("bitbucket")]);
  assert.equal((await sources.items("bitbucket", "pr")).nextCursor, "2");
  const last = await sources.items("bitbucket", "pr", "20");
  assert.equal(last.truncated, true);
  assert.equal(last.nextCursor, undefined);
  const source = await sources.importSource("bitbucket", "pr", "3");
  assert.equal(source.sourceBranch, "feature");
  assert.equal(source.targetBranch, "main");
  assert.equal(source.sha, "abc123");
  assert.ok(calls.every((url) => url.origin === "https://api.bitbucket.org"));
});

test("Linear uses read-only queries and validates imported issues against the configured team", async () => {
  const queries: any[] = [];
  let wrongTeam = false;
  const sources = new Integrations({ environment, fetch: (async (_url, opts) => {
    assert.equal(opts?.method, "POST");
    assert.equal(new Headers(opts?.headers).get("authorization"), environment.SOURCE_TOKEN);
    const query = JSON.parse(String(opts?.body)); queries.push(query);
    assert.match(query.query, /^query /);
    const value = { id: "uuid", identifier: "ENG-8", title: "Fix types", description: "Existing issue", url: "https://linear.app/team/issue/ENG-8", team: { key: wrongTeam ? "OTHER" : "ENG" }, state: { name: "Todo" } };
    return response({ data: query.variables.id ? { issue: value } : { issues: { nodes: [value], pageInfo: { hasNextPage: true, endCursor: "cursor-next" } } } });
  }) as typeof fetch });
  await sources.load([config("linear")]);
  assert.equal((await sources.items("linear", "issue")).nextCursor, "cursor-next");
  assert.equal(queries[0]!.variables.team, "ENG");
  assert.equal((await sources.importSource("linear", "issue", "ENG-8")).key, "ENG-8");
  wrongTeam = true;
  await assert.rejects(() => sources.importSource("linear", "issue", "OTHER-8"), /configured team/);
  await assert.rejects(() => sources.items("linear", "pr"), /does not support/);
});

test("Jira uses enhanced JQL search, environment basic auth and plain-text document conversion", async () => {
  const urls: URL[] = [];
  const sources = new Integrations({ environment, fetch: (async (url, opts) => {
    urls.push(new URL(String(url)));
    assert.equal(new Headers(opts?.headers).get("authorization"), `Basic ${Buffer.from(`${environment.SOURCE_USER}:${environment.SOURCE_TOKEN}`).toString("base64")}`);
    const issue = { key: "APP-9", fields: { summary: "Fix search", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }, { type: "hardBreak" }, { type: "text", text: "Second" }] }] }, status: { name: "Todo" } } };
    return response(String(url).includes("/issue/") ? issue : { issues: [issue], nextPageToken: "next-jira-page" });
  }) as typeof fetch });
  await sources.load([config("jira")]);
  assert.equal((await sources.items("jira", "issue")).nextCursor, "next-jira-page");
  assert.equal(urls[0]!.pathname, "/rest/api/3/search/jql");
  assert.match(urls[0]!.searchParams.get("jql")!, /project = "APP"/);
  const source = await sources.importSource("jira", "issue", "APP-9");
  assert.equal(source.body, "First\nSecond");
  assert.equal(source.url, "https://jira.example.test/browse/APP-9");
  await assert.rejects(() => sources.importSource("jira", "issue", "OTHER-9"), /configured Jira project/);
  assert.equal(documentText({ type: "paragraph", content: [{ type: "text", text: "<script>literal</script>" }] }), "<script>literal</script>");
});

test("configuration and provider extensions cannot redirect credentials, mutate accounts or read unbounded responses", async () => {
  let calls = 0;
  const extension: ReadOnlySourceProvider = { kinds: ["issue"], async list(_c, _kind, request, cursor) {
    await request(cursor === "mutation" ? "query" : "https://outside.example/steal", cursor === "mutation" ? { query: "mutation Change { deleteAccount }", variables: {} } : undefined);
    return { items: [], truncated: false };
  }, async get() { throw new Error("unused"); } };
  const sources = new Integrations({ environment, adapters: { extension }, fetch: (async () => { calls++; return response({}); }) as typeof fetch });
  await assert.rejects(() => sources.load([config("gitlab", { baseUrl: "http://gitlab.example/" })]), /HTTPS/);
  await assert.rejects(() => sources.load([config("gitlab", { credentialEnv: "token-value" })]), /environment variables/);
  await sources.load([config("extension", { baseUrl: "https://inside.example/api/" })]);
  await assert.rejects(() => sources.items("extension", "issue"), /configured API base/);
  await assert.rejects(() => sources.items("extension", "issue", "mutation"), /read-only/);
  assert.equal(calls, 0);
  const oversized = new Integrations({ environment, fetch: (async () => response({ description: "x".repeat(2 * 1024 * 1024) })) as typeof fetch });
  await oversized.load([config("gitlab")]);
  await assert.rejects(() => oversized.items("gitlab", "issue"), /exceeded 2 MB/);
});
