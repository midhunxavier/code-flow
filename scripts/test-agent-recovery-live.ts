/** Opt-in cancellation/recovery test with real providers; only a disposable repository is touched. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
if (process.env.CODEFLOW_TEST_LIVE_AGENTS !== "1") throw new Error("Set CODEFLOW_TEST_LIVE_AGENTS=1 to use real provider subscriptions");
const directory = await mkdtemp(join(tmpdir(), "codeflow-agent-recovery-"));
process.env.CODEFLOW_HOME = join(directory, "state");
const repo = join(directory, "repo"); await mkdir(repo);
const git = (...args: string[]) => execFileSync("git", args, {cwd:repo});
git("init", "-q", "-b", "main"); await writeFile(join(repo,"README.md"), "Recovery fixture\n"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Fixture");
const {RunManager} = await import("../src/engine.js"), {findPattern} = await import("../src/patterns/index.js");
const manager = new RunManager(findPattern);
async function until(test: () => boolean, timeout=120000) { const end=Date.now()+timeout; while(!test()) { if(Date.now()>end) throw new Error("Live recovery timed out"); await new Promise(resolve=>setTimeout(resolve,100)); } }
const evidence: unknown[]=[];
try {
  for(const provider of ["claude", "codex"] as const) {
    const run=await manager.start({pattern:findPattern("solo")!,repo,roles:{agent:[provider]},options:{},trust:"standard",loop:{maxMinutes:3},task:'Remember recovery-542. Run node -e \'setTimeout(() => console.log("finished"), 30000)\' using your shell tool. Do not change files. Wait for the command before giving your final answer.'});
    let started=false;
    const stop=manager.subscribe(run.id,event=>{if(event.type==="agent"&&event.event.kind==="tool_call"&&event.event.input.includes("setTimeout")) started=true;});
    await until(()=>started||run.status!=="running"); assert.ok(started,"The real provider started the cancellable command");
    await new Promise(resolve=>setTimeout(resolve,500)); manager.cancel(run.id); stop();
    await until(()=>run.status!=="running",15000); assert.equal(run.status,"cancelled");
    const session=run.steps.find(step=>step.kind==="agent")?.sessionId; assert.ok(session);
    await manager.followUp(run.id,{kind:"reply",agent:provider,worktree:"solo",message:"The wait was cancelled intentionally. Do not repeat the command or use tools. Reply with the token I gave you."});
    await until(()=>run.status!=="running"); assert.equal(run.status,"done",run.error); assert.match(run.summary??"",/recovery-542/);
    assert.equal(run.steps.filter(step=>step.kind==="agent").at(-1)?.sessionId,session);
    evidence.push({provider,run:run.id,cancelled:true,continued:true,session}); console.log(provider,"PASS: cancel a running tool and continue the same native session");
  }
} finally { await manager.shutdown(); await writeFile(join(directory,"evidence.json"),JSON.stringify(evidence,null,2)); console.log("Evidence:",directory); }
