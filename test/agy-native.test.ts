import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "codeflow-agy-native-test-"));
process.env.CODEFLOW_HOME = root;
const oldPath = process.env.PATH;
process.env.PATH = `${root}:${oldPath}`;
const { createAgyAdapter } = await import("../src/adapters/agy.js");
const { createRunPermissions, resolveRunPermissions } = await import("../src/run-permissions.js");
type RunOptions = import("../src/adapters/types.js").RunOptions;
after(async () => { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); });
async function fixture(fail = false) {
  await writeFile(join(root, "agy"), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(root, "launch.json"))},JSON.stringify({args,home:process.env.HOME}));
const log=args[args.indexOf('--log-file')+1];fs.writeFileSync(log,${JSON.stringify(fail ? 'auth.go:42] failed to persist refreshed token SYNTHETIC_SECRET' : '')});
if(args.includes('models')){console.log('fixture-model\\tFixture');process.exit(0);}
console.log('private diagnostic SYNTHETIC_SECRET');
console.log(JSON.stringify({event:'init',conversation_id:'private-session'}));
${fail ? '' : `console.log(JSON.stringify({event:'step_update',step_update:{step_type:'tool',tool_name:'run_command',state:'DONE'}}));`}
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'done',conversation_id:'private-session'}}));
`, { mode: 0o700 });
  const permissions = resolveRunPermissions({ policy: createRunPermissions("standard", false, false, [], "native"), provider: "agy", mode: "write", currentTrust: "standard", currentTools: false });
  const opts: RunOptions = { cwd: root, prompt: "Fixture", mode: "write", trust: "full", permissions };
  const adapter = createAgyAdapter(async () => { throw new Error("Native must not prepare isolation"); });
  return { opts, adapter };
}
test("explicit native execution retains HOME, permits terminal, suppresses sessions and cleans private logs", async () => {
  const { opts, adapter } = await fixture();
  const events: unknown[] = [];
  const result = await adapter.run(opts, e => events.push(e));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sessionId, undefined);
  assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET|private-session/);
  assert.match(JSON.stringify(events), /run_command/);
  const launch = JSON.parse(await readFile(join(root, "launch.json"), "utf8"));
  assert.equal(launch.home, process.env.HOME);
  assert.ok(launch.args.includes("--dangerously-skip-permissions"));
  for (const flag of ["--sandbox", "--agent", "--conversation"]) assert.ok(!launch.args.includes(flag));
  await assert.rejects(access(launch.args[launch.args.indexOf("--log-file") + 1]));
  assert.equal((await adapter.run({ ...opts, resumeSessionId: "old" }, () => {})).errorKind, "session_not_found");
});
test("native auth persistence failure overrides successful inference without exposing diagnostics", async () => {
  const { opts, adapter } = await fixture(true);
  const events: unknown[] = [];
  const result = await adapter.run(opts, e => events.push(e));
  assert.equal(result.ok, false); assert.equal(result.errorKind, "auth"); assert.equal(result.finalText, "");
  assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET|private-session/);
});
test("native receipt rejects mismatched boundaries and approvals before any launch", async () => {
  const { opts, adapter } = await fixture();
  for (const patch of [{ nativeDelegation: false }, { isolation: "os-sandbox" }, { required: ["workspace-writes"] }, { provider: "codex" }, { trust: "standard" }, { toolApprovals: true }, { mode: "read" }]) {
    const result = await adapter.run({ ...opts, permissions: { ...opts.permissions, ...patch } as any }, () => {});
    assert.equal(result.errorKind, "cli_incompatible");
  }
});


test("native discovery checks private refresh diagnostics and cleans them before accepting models", async () => {
  for (const fail of [false, true]) {
    const { adapter } = await fixture(fail);
    if (fail) await assert.rejects(adapter.discoverModels!({}), /could not verify the existing native login/);
    else assert.deepEqual((await adapter.discoverModels!({})).models.map(m => m.id), ["fixture-model"]);
    const launch = JSON.parse(await readFile(join(root, "launch.json"), "utf8"));
    assert.equal(launch.home, process.env.HOME);
    assert.ok(launch.args.includes("models"));
    await assert.rejects(access(launch.args[launch.args.indexOf("--log-file") + 1]));
  }
});
