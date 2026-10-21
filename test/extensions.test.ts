import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const home = mkdtempSync(join(tmpdir(), "cf-extensions-home-"));
process.env.CODEFLOW_HOME = home;
const { Extensions, negotiateExtension, extensionBindings, assertExtensionBindings } = await import("../src/extensions.js");
const { registerProviderAdapters, getAdapter, isAgentId } = await import("../src/adapters/index.js");
const { patterns, findPattern } = await import("../src/patterns/index.js");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const configuration = (id: string, text: string, extra = {}) => { const module = join(home, `${id}.mjs`); writeFileSync(module, text); return { id, version: "1.0.0", module, sha256: hash(text), api: { major: 1, minimumMinor: 0 }, requires: ["provider-adapter", "workflow-pattern"], ...extra }; };
const source = (id: string) => `import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
export default {api:{major:1,minor:0},providers:[{id:'plugin:${id}/local',displayName:'Fixture provider',binary:'fixture-only',available:async()=>true,catalog:async()=>({models:[],efforts:[],allowCustom:true}),run:async(opts,event)=>{event({kind:'usage',inputTokens:12,outputTokens:4}); await writeFile(join(opts.cwd,'plugin-result.txt'),'fixture artifact'); return{ok:true,finalText:'Fixture result'};}}],workflows:[{id:'plugin:${id}/workflow',name:'Fixture workflow',summary:'Run a local fixture',description:'Exercises actual plugin provider dispatch',roles:[{id:'agent',label:'Provider',description:'Fixture provider',default:['plugin:${id}/local']}],options:[],requiresCheck:true,run:async(ctx)=>{const tree=await ctx.worktree('plugin');const result=await ctx.ask({title:'Plugin turn',role:'agent',agent:ctx.agent('agent'),mode:'write',cwd:tree,prompt:ctx.task}); await ctx.commit(tree,'plugin fixture');const check=await ctx.check(tree);ctx.setVerdict(check.ok?'passed':'failing');await ctx.artifact('Plugin result',tree);return result.finalText;}}]};`;

test("pinned extensions register and run their adapter, but managed runs reject unverified permissions", async () => {
  const id = "contract-fixture", text = source(id), manifest = configuration(id, text), workflows: string[] = [];
  const loader = new Extensions({ home, environment: { CODEFLOW_EXTENSIONS_JSON: JSON.stringify({ version: 1, extensions: [manifest] }) }, register(providers, values) { registerProviderAdapters(providers); patterns.push(...values); workflows.push(...values.map((value) => value.id)); } });
  await loader.load(); assert.equal(loader.list()[0]!.state, "loaded"); assert.equal(isAgentId(`plugin:${id}/local`), true); assert.equal(isAgentId("toString"), false);
  const roles = { agent: [`plugin:${id}/local`] as const }, bindings = extensionBindings(workflows[0]!, roles);
  assert.deepEqual(bindings, [{ id, version: "1.0.0", sha256: manifest.sha256 }]); assert.doesNotThrow(() => assertExtensionBindings({ pattern: workflows[0]!, roles, extensions: bindings })); assert.throws(() => assertExtensionBindings({ pattern: workflows[0]!, roles, extensions: [{ ...bindings[0]!, sha256: "f".repeat(64) }] }), /version changed/);
  const { execFileSync } = await import("node:child_process"), repo = mkdtempSync(join(tmpdir(), "cf-extension-repo-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "fixture"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: repo });
    const { RunManager } = await import("../src/engine.js"), manager = new RunManager(findPattern);
    await assert.rejects(manager.start({ pattern: findPattern(workflows[0]!)!, repo, task: "Exercise pinned plugin", roles: { agent: [`plugin:${id}/local`] }, options: {}, loop: { check: "test -f plugin-result.txt", setup: "", copy: [] }, trust: "safe" }), /cannot enforce.*native-delegation/);
    assert.equal(manager.list().length, 0, "no unprotected run is created");
    const result = await getAdapter(`plugin:${id}/local`).run({ cwd: repo, prompt: "Adapter contract", mode: "write" }, () => {});
    assert.equal(result.ok, true); assert.equal(readFileSync(join(repo, "plugin-result.txt"), "utf8"), "fixture artifact");
    await manager.shutdown();
  } finally { rmSync(repo, { recursive: true, force: true }); }
  assert.throws(() => registerProviderAdapters([getAdapter(`plugin:${id}/local`)]), /unique/);
});
test("incompatible APIs, hash changes and symlink bundles are rejected before plugin code executes", async () => {
  const marker = join(home, "MUST_NOT_EXECUTE"), text = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');export default{api:{major:1,minor:0}};`;
  for (const [id, extra] of [["new-api", { api: { major: 2, minimumMinor: 0 } }], ["new-capability", { requires: ["network-server"] }], ["changed-hash", { sha256: "0".repeat(64) }]] as const) {
    const manifest = configuration(id, text, extra), loader = new Extensions({ home, environment: { CODEFLOW_EXTENSIONS_JSON: JSON.stringify({ version: 1, extensions: [manifest] }) }, register() { throw new Error("Must not register"); } }); await loader.load(); assert.equal(loader.list()[0]!.state, "rejected"); assert.equal(existsSync(marker), false);
  }
  const manifest = configuration("symlink", text), link = join(home, "link.mjs"); symlinkSync(manifest.module, link); const loader = new Extensions({ home, environment: { CODEFLOW_EXTENSIONS_JSON: JSON.stringify({ version: 1, extensions: [{ ...manifest, module: link }] }) }, register() {} }); await loader.load(); assert.equal(loader.list()[0]!.state, "rejected"); assert.equal(existsSync(marker), false);
  assert.throws(() => negotiateExtension({ ...manifest, api: { major: 1, minimumMinor: 1 } }), /requires API/);
  for (const id of [undefined, ["coerced-id"]]) {
    const invalid = new Extensions({ home, environment: { CODEFLOW_EXTENSIONS_JSON: JSON.stringify({ version: 1, extensions: [{ ...manifest, id }] }) }, register() { throw new Error("Must not register"); } });
    await assert.rejects(invalid.load(), /Invalid extension identity/); assert.equal(existsSync(marker), false);
  }
});
