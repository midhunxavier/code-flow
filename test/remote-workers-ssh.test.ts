import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteWorkers } from "../src/remote-workers/client.js";
import { git, remoteWorkerFixture } from "./remote-worker-fixture.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Explicit opt-in starts only a temporary unprivileged daemon on 127.0.0.1. */
test("actual loopback SSH transfers an exact source, executes a fixture CLI, imports its result and recovers its receipt", { skip: process.env.CODEFLOW_TEST_LOOPBACK_SSH !== "1", timeout: 60_000 }, async (t) => {
  const daemon = process.env.CODEFLOW_TEST_SSHD ?? "/usr/sbin/sshd";
  if (!existsSync(daemon)) { t.skip("No local sshd binary is available"); return; }
  const root = mkdtempSync(join(tmpdir(), "cf-loopback-ssh-")); chmodSync(root, 0o700); let server: ChildProcess | undefined;
  try {
    const f = await remoteWorkerFixture(root), hostKey = join(root, "host-key"), clientKey = join(root, "client-key");
    for (const key of [hostKey, clientKey]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const user = execFileSync("id", ["-un"]).toString().trim(), authorized = join(root, "authorized_keys"), known = join(root, "known_hosts");
    writeFileSync(authorized, readFileSync(`${clientKey}.pub`), { mode: 0o600 }); writeFileSync(known, `codeflow-loopback ${readFileSync(`${hostKey}.pub`, "utf8")}`, { mode: 0o600 });
    const port = await new Promise<number>((done) => { const listener = createServer().listen(0, "127.0.0.1", () => { const value = (listener.address() as AddressInfo).port; listener.close(() => done(value)); }); });
    const configuration = join(root, "sshd_config");
    writeFileSync(configuration, [`Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`, `PidFile ${join(root, "sshd.pid")}`, `AuthorizedKeysFile ${authorized}`, `AllowUsers ${user}`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "UsePAM no", "PermitRootLogin no", "StrictModes yes", "AllowTcpForwarding no", "AllowAgentForwarding no", "X11Forwarding no", "PermitTTY no", "PermitUserEnvironment no", "LogLevel ERROR"].join("\n") + "\n", { mode: 0o600 });
    let output = ""; server = spawn(daemon, ["-D", "-e", "-f", configuration], { stdio: ["ignore", "pipe", "pipe"] }); server.stdout?.on("data", (data) => output += data); server.stderr?.on("data", (data) => output += data);
    await new Promise((done) => setTimeout(done, 250));
    if (server.exitCode !== null) { t.skip(`Unprivileged sshd is unavailable: ${output.trim().slice(0, 500)}`); return; }
    const client = join(root, "ssh_config"); writeFileSync(client, [`Host loopback-fixture`, "  HostName 127.0.0.1", `  Port ${port}`, `  User ${user}`, `  IdentityFile ${clientKey}`, "  IdentitiesOnly yes", "  HostKeyAlias codeflow-loopback", `  UserKnownHostsFile ${known}`, "  GlobalKnownHostsFile /dev/null"].join("\n") + "\n", { mode: 0o600 });
    const wrapper = join(root, "ssh"); writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(client)} "$@"\n`, { mode: 0o700 });
    const config = JSON.parse(f.env.CODEFLOW_REMOTE_WORKERS_JSON); config.workers[0].sshHost = "loopback-fixture";
    const workers = new RemoteWorkers({ home: join(root, "actual-ssh-host"), sshBinary: wrapper, environment: { CODEFLOW_REMOTE_WORKERS_JSON: JSON.stringify(config) } }); await workers.load();
    try { assert.equal((await workers.probe("fixture", { repoMapping: "project" })).capabilities.providers[0]!.available, true); }
    catch (error) { if (/setgroups|privilege|sandbox|not permitted|Permission denied/.test(output)) { t.skip(`Unprivileged sshd cannot authenticate this OS account: ${output.trim().slice(0, 500)}`); return; } throw error; }
    const result = await workers.execute({ workerId: "fixture", repoMapping: "project", repositoryBase: f.repositoryBase, agent: "claude", scope: { runId: "loopback-run", stepId: "loopback-step", threadId: "loopback-thread" }, options: { cwd: f.source, prompt: "WRITE", mode: "write", trust: "safe", timeoutMs: 10_000 } }, () => undefined);
    assert.equal(result.ok, true, result.error); assert.equal(result.remote.state, "completed"); assert.ok(result.artifact); await workers.importArtifact(f.source, result.artifact!, result.remote.baseCommit!);
    assert.equal(git(f.source, "rev-parse", "HEAD"), result.remote.resultHead); assert.equal(readFileSync(join(f.source, "result.txt"), "utf8"), "local exact base\nexplicit staged reference");
    const receipt = await workers.receipt("fixture", result.remote.requestId, { downloadArtifact: false }); assert.equal(receipt.remote.state, "completed"); assert.equal(receipt.artifact, undefined); assert.equal(readFileSync(f.audit, "utf8").trim().split("\n").length, 1);
  } finally {
    if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>((done) => { const timer = setTimeout(() => { server?.kill("SIGKILL"); done(); }, 2000); server?.once("exit", () => { clearTimeout(timer); done(); }); }); }
    rmSync(root, { recursive: true, force: true });
  }
});
