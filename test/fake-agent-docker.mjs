#!/usr/bin/env node
// A daemon/client separation fixture: agent children outlive a killed `docker run` client,
// and only a separate `docker rm --force` invocation stops them.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const directory = process.env.FAKE_DOCKER_RECORD_DIR;
if (!directory) throw new Error("Fake Docker needs its record directory");
mkdirSync(directory, { recursive: true });
if (args[0] === "rm") {
  const name = args.at(-1);
  appendFileSync(join(directory, "removed.jsonl"), JSON.stringify({ name }) + "\n");
  try {
    const pid = Number(readFileSync(join(directory, `${name}.pid`), "utf8"));
    process.kill(-pid, "SIGKILL");
    rmSync(join(directory, `${name}.pid`), { force: true });
  } catch { /* Already stopped, just as with a real Docker --rm container. */ }
  process.exit(0);
}
if (args[0] !== "run") throw new Error(`Unsupported fake Docker invocation: ${args.join(" ")}`);
const name = args[args.indexOf("--name") + 1];
const cwd = args[args.indexOf("--workdir") + 1];
const entrypoint = args.indexOf("--entrypoint");
const command = args[entrypoint + 1];
const image = args[entrypoint + 2];
const cliArgs = args.slice(entrypoint + 3);
const insideEnvironment = {};
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "--env") continue;
  const pair = args[++index];
  const separator = pair.indexOf("=");
  insideEnvironment[pair.slice(0, separator)] = pair.slice(separator + 1);
}
const fakeControls = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("FAKE_")));
const child = spawn(command, cliArgs, {
  cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH, CODEFLOW_HOME: process.env.CODEFLOW_HOME, ...insideEnvironment, ...fakeControls },
});
writeFileSync(join(directory, `${name}.pid`), String(child.pid));
writeFileSync(join(directory, `${name}.json`), JSON.stringify({ args, name, image, command, cliArgs, insideEnvironment, clientPid: process.pid, agentPid: child.pid }));
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => { process.stderr.write(error.message); process.exit(1); });
child.on("close", (code) => process.exit(code ?? 1));
