import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

test("same-origin computers keep requests, composer drafts and file recovery separate", async () => {
  const folder = await mkdtemp(join(tmpdir(), "codeflow-workspace-routing-"));
  const storage = new Map<string, string>(), asked: string[] = [];
  const browserStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  Object.assign(globalThis, { window: {}, location: { hostname: "localhost" }, localStorage: browserStorage, sessionStorage: browserStorage,
    fetch: async (path: string) => { asked.push(path); return new Response("{}"); } });
  try {
    const bundled = await build({ stdin: { contents: 'export { api, localApi, apiPath, store } from "./lib.ts"; export * from "./file-drafts.ts";', resolveDir: fileURLToPath(new URL("../ui", import.meta.url)), loader: "ts" }, bundle: true, write: false, format: "esm", logLevel: "silent" });
    const load = async (id?: string) => {
      Object.assign(globalThis, { window: { __CODEFLOW_WORKSPACE: id } });
      const path = join(folder, `${id ?? "local"}.mjs`);
      await writeFile(path, bundled.outputFiles[0]!.text);
      return import(pathToFileURL(path).href);
    };
    const local = await load(), remote = await load("0123456789abcdef"), other = await load("fedcba9876543210");
    for (const [scope, draft] of [[local, "local draft"], [remote, "remote draft"], [other, "other draft"]] as const) {
      scope.store.set("draftTask", draft);
      scope.retainFileDraft("/work/project", { path: "README.md", text: "base", hash: "same" }, draft);
    }
    for (const [scope, draft] of [[local, "local draft"], [remote, "remote draft"], [other, "other draft"]] as const) {
      assert.equal(scope.store.get("draftTask"), draft);
      assert.equal(scope.loadFileDraft("/work/project", "README.md").draft, draft);
    }
    await local.api("/api/runs");
    await remote.api("/api/runs");
    await other.api("/api/runs");
    await remote.localApi("/api/ssh-hosts");
    await remote.api("/api/auth/logout", { method: "POST" });
    assert.deepEqual(asked, ["/api/runs", "/computer/0123456789abcdef/api/runs", "/computer/fedcba9876543210/api/runs", "/api/ssh-hosts", "/api/auth/logout"]);
    assert.equal(remote.apiPath("/api/stream?subs=[]"), "/computer/0123456789abcdef/api/stream?subs=[]");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
