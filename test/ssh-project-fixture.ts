import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const port = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cf-ssh-project-"));
  const remoteHome = join(directory, "remote"), localHome = join(directory, "local"), bin = join(directory, "bin"), repo = join(remoteHome, "project");
  for (const path of [remoteHome, localHome, bin, repo]) await mkdir(path, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "SSH fixture"); git("config", "user.email", "ssh@example.invalid");
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "remote-project", scripts: { test: "node check.mjs" } }));
  await writeFile(join(repo, "check.mjs"), "console.log('CHECK_RAN_ON_REMOTE');\n");
  await writeFile(join(repo, "remote.txt"), "REMOTE_ONLY\n");
  await writeFile(join(repo, "example.ts"), "export function remoteFunction() { return 42; }\nremoteFunction();\n");
  git("add", "."); git("commit", "-qm", "Initial remote project");
  const login = join(directory, "login-shell");
  await writeFile(login, '#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$1"; fi\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 });
  const ssh = join(bin, "ssh"), audit = join(directory, "ssh-audit.jsonl");
  // Exercises the real bootstrap and HTTP gateway with a separate host home. Only the
  // encrypted transport is replaced; a separate opt-in test exercises OpenSSH itself.
  await writeFile(ssh, `#!${process.execPath}\n` + `
const { spawn } = require('node:child_process'), { connect } = require('node:net'), { appendFileSync } = require('node:fs');
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(audit)}, JSON.stringify(args) + '\\n');
if (args.includes('-O')) process.exit(0);
if (args.includes('-W')) {
 const target = args[args.indexOf('-W') + 1], p = Number(target.split(':').pop());
 const socket = connect(p, '127.0.0.1', () => process.stdin.pipe(socket).pipe(process.stdout));
 socket.on('error', err => { console.error(err.message); process.exit(1); });
 socket.on('close', () => process.exit());
} else {
 const child = spawn('/bin/sh', ['-c', args[args.length-1]], { stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(remoteHome)}, SHELL: ${JSON.stringify(login)}, PATH: ${JSON.stringify(`${join(root, "test/fake-bin")}:${dirname(process.execPath)}:${process.env.PATH}`)} } });
 child.on('exit', code => process.exit(code ?? 1));
 process.on('SIGTERM', () => child.kill());
}
`, { mode: 0o700 });
  const cleanup = async () => {
    try { const state = JSON.parse(await readFile(join(remoteHome, ".codeflow/ssh-host/runtime.json"), "utf8")); process.kill(state.pid, "SIGTERM"); for (let i = 0; i < 50; i++) { try { process.kill(state.pid, 0); } catch { break; } await pause(100); } } catch { /* never started or already stopped */ }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { directory, remoteHome, localHome, bin, repo, ssh, audit, git, login, cleanup };
}
export function buildHost() { execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); execFileSync(process.execPath, ["scripts/build-host.mjs"], { cwd: root }); }
