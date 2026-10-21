import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RemoteWorkers } from "../src/remote-workers/client.js";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const app = resolve(import.meta.dirname, "..");
export function git(repo: string, ...args: string[]) { return execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
export async function remoteWorkerFixture(root: string) {
  const workerScript = join(root, "worker.mjs"); if (!existsSync(workerScript)) execFileSync(process.execPath, ["scripts/build-worker.mjs", workerScript], { cwd: app });
  const folder = mkdtempSync(join(root, "case-")), source = join(folder, "source"), mapping = join(folder, "mapping"), home = join(folder, "host"), workerHome = join(folder, "worker-home"), workerRoot = join(folder, "worker-data"), bin = join(folder, "bin");
  for (const path of [source, workerHome, bin]) mkdirSync(path, { recursive: true });
  git(source, "init", "-q", "-b", "main"); writeFileSync(join(source, "README.md"), "initial\n"); git(source, "add", "."); git(source, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  git(folder, "clone", "-q", "--no-hardlinks", source, mapping); const repositoryBase = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "local.txt"), "local exact base\n"); git(source, "add", "."); git(source, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "host-only base");
  mkdirSync(join(source, ".codeflow-context")); writeFileSync(join(source, ".codeflow-context", "reference.txt"), "explicit staged reference");
  git(source, "config", "core.excludesFile", join(folder, "exclude")); writeFileSync(join(folder, "exclude"), ".codeflow-context/\n");
  const configFile = join(folder, "worker.json"); writeFileSync(configFile, JSON.stringify({ version: 1, root: workerRoot, repos: { project: mapping }, providers: ["claude"], allowedTrust: ["safe", "standard"] }));
  const audit = join(folder, "audit.jsonl");
  const agent = join(bin, "claude"); writeFileSync(agent, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--help')) { console.log('--settings --no-chrome --disallowedTools --allowedTools --mcp-config --strict-mcp-config --json-schema --resume'); process.exit(0); }
if (process.argv.includes('--version')) { console.log('2.1.300'); process.exit(0); }
let prompt=''; for await (const data of process.stdin) prompt+=data;
appendFileSync(${JSON.stringify(audit)},JSON.stringify({pid:process.pid,ppid:process.ppid,cwd:process.cwd(),args:process.argv.slice(2),prompt,hostSecret:process.env.HOST_PRIVATE_SECRET,codeflowToken:process.env.CODEFLOW_TOKEN})+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'remote-session-never-returned'}));
if (prompt.includes('SLOW')) { console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'worker started'}]}})); await new Promise(r=>setTimeout(r,3000)); }
if (prompt.includes('WRITE')) writeFileSync('result.txt',readFileSync('local.txt','utf8')+readFileSync(existsSync('.codeflow-context/reference.txt')?'.codeflow-context/reference.txt':'.codeflow-context/attachments/reference.txt','utf8'));
if (prompt.includes('MUTATE')) writeFileSync('README.md','read mode modified');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'separate worker completed',session_id:'remote-session-never-returned',usage:{input_tokens:5,output_tokens:3}}));
`); chmodSync(agent, 0o755);
  const launcher = join(folder, "launch.sh"); writeFileSync(launcher, `#!/bin/sh\nexport HOME=${quote(workerHome)}\nexport CODEFLOW_HOME=${quote(join(workerRoot, "runtime"))}\nexport PATH=${quote(`${bin}:${process.env.PATH}`)}\nexec ${quote(process.execPath)} ${quote(workerScript)} --config ${quote(configFile)}\n`); chmodSync(launcher, 0o755);
  const ssh = join(folder, "ssh"); const sshAudit = join(folder, "ssh-audit.jsonl");
  writeFileSync(ssh, `#!${process.execPath}
import { spawn } from 'node:child_process'; import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sshAudit)},JSON.stringify({args:process.argv.slice(2),hostSecret:process.env.HOST_PRIVATE_SECRET,codeflowToken:process.env.CODEFLOW_TOKEN})+'\\n');
const child=spawn('/bin/sh',['-c',process.argv.at(-1)],{stdio:['pipe','pipe','inherit']});process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
// DROP transport fixture disconnects output after the real worker accepted and invoked its real adapter.
let buf='',drop=false;process.stdin.on('data',d=>{buf+=d; if(buf.includes('DROP'))drop=true;});
child.stdout.on('data',d=>{if(drop&&d.toString().includes('worker started')){child.stdout.unpipe(process.stdout);process.stdout.destroy();process.stdin.unpipe(child.stdin);child.stdin.end();setTimeout(()=>process.exit(23),100);}});
process.on('SIGTERM',()=>{child.kill('SIGTERM');}); child.on('exit',c=>process.exit(c??1));
`); chmodSync(ssh, 0o755);
  const env = { CODEFLOW_REMOTE_WORKERS_JSON: JSON.stringify({ version: 1, workers: [{ id: "fixture", name: "Fixture worker", sshHost: "explicit-fixture", command: quote(launcher), repoMappings: ["project"] }] }) };
  const workers = new RemoteWorkers({ home, sshBinary: ssh, environment: env }); await workers.load();
  const execute = (prompt: string, mode: "write" | "read" = "write", extra: Record<string, unknown> = {}) => workers.execute({ workerId: "fixture", repoMapping: "project", repositoryBase, agent: "claude", scope: { runId: "run", stepId: "step", threadId: "thread" }, options: { cwd: source, prompt, mode, trust: "safe", timeoutMs: 10_000 }, ...extra }, () => undefined);
  return { folder, source, mapping, workers, execute, repositoryBase, audit, workerRoot, configFile, sshAudit, env, ssh, home };
}
