import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { projectOnlyCodexArgs } from "../src/cli-teams/terminal.js";

test("terminal boundary disables desktop connections only and rejects malformed inventories", () => {
  const prompt = "literal $(touch nope) `echo nope`";
  assert.deepEqual(projectOnlyCodexArgs([{name:"other"},{name:"codeflow"},{name:"codeflow-repo-123"},{name:"codeflow-repo-123"}], [prompt]), ["-c","mcp_servers.codeflow-repo-123.enabled=false",prompt]);
  assert.deepEqual(projectOnlyCodexArgs([], ["--help"]), ["--help"]);
  for (const invalid of [null, {}, [null], [{name:3}]]) assert.throws(() => projectOnlyCodexArgs(invalid, []));
});

test("terminal command preserves argv, cwd, exit status and config without launching the backend", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codeflow-terminal-")));
  try {
    const bin = join(dir,"bin"), home = join(dir,"state"); await mkdir(bin); await mkdir(home);
    const fixture = `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.join(' ')==='mcp list --json')console.log(JSON.stringify([{name:'codeflow-test-123'},{name:'codeflow'},{name:'other'}]));\nelse {writeFileSync(process.env.RECORD,JSON.stringify({args,cwd:process.cwd()}));process.exit(7);}\n`;
    await writeFile(join(bin,"codex"),fixture,{mode:0o700});
    await writeFile(join(bin,"claude"),fixture,{mode:0o700});
    const record=join(dir,"record.json"), launcher=join(process.cwd(),"bin/codeflow.mjs");
    const env={...process.env,PATH:bin+delimiter+process.env.PATH,CODEFLOW_HOME:home,RECORD:record};
    for (const provider of ["claude","codex"]) {
      assert.throws(()=>execFileSync(process.execPath,[launcher,"terminal",provider,"--","--help","literal $()"],{cwd:dir,env,stdio:"pipe"}), (e:any)=>e.status===7);
      const seen=JSON.parse(await readFile(record,"utf8"));
      assert.deepEqual(seen.args,provider==="codex"?["-c","mcp_servers.codeflow-test-123.enabled=false","--help","literal $()"]:["--help","literal $()"]);
      assert.equal(seen.cwd,dir);
    }
    await assert.rejects(readFile(join(home,"cli-teams-runtime.json")),{code:"ENOENT"});
  } finally {await rm(dir,{recursive:true,force:true});}
});
