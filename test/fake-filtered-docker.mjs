#!/usr/bin/env node
// Browser-only daemon fixture. Actual namespace containment is tested with real Docker separately.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2), state = process.env.FAKE_FILTERED_DOCKER_STATE; if (!state) throw new Error("Missing filtered fixture state"); mkdirSync(state, { recursive: true });
if (args[0] === "context") { process.stdout.write("unix:///filtered-fixture.sock\n"); process.exit(0); }
if (args[0] === "image") { process.stdout.write(`sha256:${"a".repeat(64)}\n`); process.exit(0); }
const records = () => readdirSync(state).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(state, name), "utf8")));
if (args[0] === "ps") { const filter = args.find((arg) => arg.startsWith("label=codeflow.filtered-task="))?.split("=").at(-1); for (const record of records()) { try { process.kill(record.pid, 0); if (!filter || filter === record.job) process.stdout.write(record.id + "\n"); } catch { rmSync(join(state, `${record.id}.json`), { force: true }); } } process.exit(0); }
if (args[0] === "rm") { for (const record of records()) if (args.includes(record.id) || args.includes(record.name)) { try { process.kill(-record.pid, "SIGKILL"); } catch {} rmSync(join(state, `${record.id}.json`), { force: true }); } process.exit(0); }
if (args[0] !== "run") throw new Error("Unsupported filtered Docker fixture command");
const name = args[args.indexOf("--name") + 1], cwd = args[args.indexOf("--workdir") + 1], job = args.find((arg) => arg.startsWith("codeflow.filtered-task="))?.split("=")[1], id = createHash("sha256").update(name).digest("hex").slice(0, 12);
if (!job || !args.includes("--read-only")) throw new Error("Filtered job lost its server-owned containment receipt");
const program = `import {writeFileSync} from 'node:fs';let prompt='';for await(const part of process.stdin)prompt+=part;if(prompt.includes('linger')){process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'filtered-browser'})+'\\n');setInterval(()=>{},1000);}else{writeFileSync('src/allowed.txt','filtered browser result\\n');process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Allowed browser edit complete'})+'\\n');}`;
const child = spawn(process.execPath, ["--input-type=module", "-e", program], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } }); writeFileSync(join(state, `${id}.json`), JSON.stringify({ id, name, job, pid: child.pid }));
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.on("close", (code) => { rmSync(join(state, `${id}.json`), { force: true }); process.exit(code ?? 1); }); child.on("error", (error) => { process.stderr.write(error.message); process.exit(1); });
