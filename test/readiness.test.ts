import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { RunManager } from "../src/engine.js";

const directory = mkdtempSync(join(tmpdir(), "codeflow-readiness-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = join(directory, "home");
const { inspectReadiness } = await import("../src/readiness.js");
const { adapters, registerProviderAdapters } = await import("../src/adapters/index.js");
const { handleWorkspaceApi } = await import("../src/workspace-api.js");
const { HttpError } = await import("../src/http.js");
const repo = join(directory, "repo");
before(() => {
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "Readiness fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"], { cwd: repo });
});
after(() => rmSync(directory, { recursive: true, force: true }));

async function withEnv(vars: Record<string, string>, run: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try { await run(); } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
const inspect = (scope: { pattern?: string; roles?: Record<string, string | string[]>; providers?: string[] } = {}) => inspectReadiness({ repo, check: "node --version", ...scope });
const status = (report: Awaited<ReturnType<typeof inspect>>, id: string) => report.items.find((item) => item.id === id)?.status;

test("pipeline readiness ignores installed but signed-out Claude when Antigravity and Codex are selected", async () => {
  await withEnv({ FAKE_SIGNED_OUT: "claude" }, async () => {
    const report = await inspect({ pattern: "pipeline", roles: { planner: "agy", builder: ["codex"], reviewer: ["agy"] } });
    assert.equal(report.ok, true, JSON.stringify(report.items));
    assert.equal(status(report, "agent-claude"), "skipped");
    assert.equal(status(report, "agent-codex"), "passed");
    assert.equal(status(report, "agent-agy"), "passed");
  });
});

test("all selected providers unusable blocks readiness even with a healthy unselected provider", async () => {
  await withEnv({ FAKE_SIGNED_OUT: "claude", FAKE_UNKNOWN_FLAG: "--output-schema" }, async () => {
    const report = await inspect({ pattern: "pipeline", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } });
    assert.equal(report.ok, false);
    assert.equal(status(report, "agent-claude"), "failed");
    assert.equal(status(report, "agent-codex"), "failed");
    assert.equal(status(report, "agent-agy"), "skipped");
  });
});

test("selected uninstalled providers fail rather than being skipped", async () => {
  const binary = adapters.claude.binary;
  adapters.claude.binary = join(directory, "missing-claude");
  try {
    const report = await inspect({ providers: ["claude"] });
    assert.equal(report.ok, false);
    assert.equal(status(report, "agent-claude"), "failed");
  } finally { adapters.claude.binary = binary; }
});

test("auto roles accept healthy alternatives but cannot escape an explicit provider pool", async () => {
  await withEnv({ FAKE_SIGNED_OUT: "claude" }, async () => {
    assert.equal((await inspect({ roles: { builder: ["auto"] } })).ok, true);
    assert.equal((await inspect({ roles: { builder: ["auto"] }, providers: ["claude", "codex"] })).ok, true);
    const restricted = await inspect({ roles: { builder: ["auto"] }, providers: ["claude"] });
    assert.equal(restricted.ok, false);
    assert.equal(status(restricted, "available-agent"), "failed");
    assert.equal((await inspect({ roles: { builder: "auto" }, providers: [] })).ok, false);
    assert.equal((await inspect({ providers: [] })).ok, false);
  });
});

test("Auto-team pool members are alternatives; coordinator remains required", async () => {
  await withEnv({ FAKE_SIGNED_OUT: "claude" }, async () => {
    const scope = { pattern: "auto-team", roles: { coordinator: ["codex"], pool: ["claude", "codex"] } };
    assert.equal((await inspect(scope)).ok, true);
    assert.equal((await inspect({ ...scope, providers: ["claude"] })).ok, false);
    assert.equal((await inspect({ ...scope, roles: { coordinator: ["codex"], pool: ["claude"] } })).ok, false);
    assert.equal((await inspect({ ...scope, roles: { coordinator: ["claude"], pool: ["codex"] } })).ok, false);
    assert.equal((await inspect({ ...scope, roles: { coordinator: ["codex"], pool: [] } })).ok, false);
  });
});

test("unscoped callers retain installed-provider health checks", async () => {
  await withEnv({ FAKE_SIGNED_OUT: "claude" }, async () => {
    const report = await inspect();
    assert.equal(report.ok, false);
    assert.equal(status(report, "agent-claude"), "failed");
  });
});

async function request(scope: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify({ repo, check: "node --version", ...scope }))]) as unknown as IncomingMessage;
  Object.assign(req, { method: "POST", headers: { "content-type": "application/json" } });
  return handleWorkspaceApi(req, new URL("http://localhost/api/readiness"), ["api", "readiness"], { list: () => [] } as unknown as RunManager, new AbortController().signal);
}

test("readiness API rejects malformed scope and unregistered providers with HTTP 400", async () => {
  for (const scope of [
    { pattern: 42 }, { pattern: "" }, { pattern: "x".repeat(129) }, { pattern: "pipeline\0" },
    { roles: null }, { roles: [] }, { roles: { builder: 42 } }, { roles: { builder: [null] } },
    { roles: { builder: ["unknown"] } }, { roles: { builder: ["toString"] } },
    { roles: { ["x".repeat(129)]: "codex" } }, { roles: { builder: Array(129).fill("codex") } },
    { roles: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`r${i}`, "codex"])) },
    { providers: "codex" }, { providers: null }, { providers: [42] }, { providers: ["unknown"] },
    { providers: Array(129).fill("codex") },
  ]) await assert.rejects(request(scope), (error: unknown) => error instanceof HttpError && error.status === 400, JSON.stringify(scope));
});

test("readiness API forwards selection and preserves unscoped requests", async () => {
  await withEnv({ FAKE_SIGNED_OUT: "claude" }, async () => {
    const selected = await request({ pattern: "pipeline", roles: { planner: "agy", builder: ["codex"], reviewer: ["agy"] } });
    assert.equal(selected?.status, 200);
    assert.equal((selected?.body as { ok: boolean }).ok, true);
    assert.equal(((await request({}))?.body as { ok: boolean }).ok, false);
    assert.equal(((await request({ roles: { builder: "auto" }, providers: ["claude"] }))?.body as { ok: boolean }).ok, false);
  });
});


test("readiness API accepts registered namespaced provider and workflow IDs", async () => {
  registerProviderAdapters([{ ...adapters.codex, id: "plugin:readiness-test/member", displayName: "Fixture provider", available: async () => true }]);
  const result = await request({ pattern: "plugin:readiness-test/workflow", roles: { builder: ["plugin:readiness-test/member"] } });
  assert.equal(result?.status, 200);
  const report = result?.body as Awaited<ReturnType<typeof inspect>>;
  assert.equal(report.ok, true);
  assert.equal(status(report, "agent-plugin:readiness-test/member"), "warning", "unverified plugin authentication keeps the existing warning policy");
});
