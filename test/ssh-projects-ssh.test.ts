import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SshProjects } from "../src/ssh-projects/manager.js";
import { quote } from "../src/ssh-projects/transport.js";
import { buildHost, fixture, pause, port, root } from "./ssh-project-fixture.js";

test("real OpenSSH opens a remote project through the authenticated gateway and restores its backend", { skip: process.env.CODEFLOW_TEST_LOOPBACK_SSH !== "1", timeout: 120_000 }, async (t) => {
  const daemon = process.env.CODEFLOW_TEST_SSHD ?? "/usr/sbin/sshd";
  if (!existsSync(daemon)) { t.skip("No local sshd is installed"); return; }
  buildHost(); const f = await fixture(); let server: ChildProcess | undefined, service: SshProjects | undefined;
  try {
    const hostKey = join(f.directory, "host-key"), clientKey = join(f.directory, "client-key"), known = join(f.directory, "known_hosts"), authorized = join(f.directory, "authorized_keys");
    for (const key of [hostKey, clientKey]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    await writeFile(authorized, await readFile(`${clientKey}.pub`), { mode: 0o600 });
    await writeFile(known, `codeflow-project-test ${await readFile(`${hostKey}.pub`, "utf8")}`, { mode: 0o600 });
    // Confine the test backend to an isolated HOME while exercising the real SSH login transport.
    const command = join(f.directory, "remote-command");
    await writeFile(command, `#!/bin/sh\nexport HOME=${quote(f.remoteHome)} SHELL=${quote(f.login)} PATH=${quote(`${join(root, "test/fake-bin")}:${dirname(process.execPath)}:${process.env.PATH}`)}\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
    const config = join(f.directory, "sshd_config"), sshPort = await port(), user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
    await writeFile(config, [`Port ${sshPort}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`, `PidFile ${join(f.directory, "sshd.pid")}`, `AuthorizedKeysFile ${authorized}`, `AllowUsers ${user}`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "UsePAM no", "StrictModes yes", "AllowTcpForwarding local", "AllowAgentForwarding no", "X11Forwarding no", "PermitTTY no", `ForceCommand ${command}`, "LogLevel ERROR"].join("\n") + "\n", { mode: 0o600 });
    let output = ""; server = spawn(daemon, ["-D", "-e", "-f", config], { stdio: ["ignore", "pipe", "pipe"] });
    server.stdout!.on("data", (data) => output += data); server.stderr!.on("data", (data) => output += data); await pause(300);
    if (server.exitCode !== null) { t.skip(`Unprivileged sshd unavailable: ${output.slice(-500)}`); return; }
    const client = join(f.directory, "ssh_config");
    await writeFile(client, [`Host project-fixture`, " HostName 127.0.0.1", ` Port ${sshPort}`, ` User ${user}`, ` IdentityFile ${clientKey}`, " IdentitiesOnly yes", " HostKeyAlias codeflow-project-test", ` UserKnownHostsFile ${known}`, " GlobalKnownHostsFile /dev/null"].join("\n") + "\n");
    const wrapper = join(f.bin, "real-ssh"); await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(client)} "$@"\n`, { mode: 0o700 });
    service = new SshProjects({ home: f.localHome, returnUrl: "http://localhost:4317/", sshBinary: wrapper });
    const host = await service.add({ sshHost: "project-fixture" });
    let link;
    try { link = await service.connect(host.id); }
    catch (error) { if (/setgroups|privilege|sandbox|not permitted/.test(output)) { t.skip(`Cannot run sshd for this account: ${output.slice(-500)}`); return; } throw error; }
    const opened = await fetch(link.url, { redirect: "manual" }); assert.equal(opened.status, 200);
    const cookie = opened.headers.get("set-cookie")!.split(";")[0]!, origin = new URL(link.url).origin;
    const listing = await fetch(origin + `/api/fs?path=${encodeURIComponent(f.remoteHome)}`, { headers: { cookie } }).then((res) => res.json()); assert.equal(listing.home, f.remoteHome); assert.ok(listing.entries.some((entry: { name: string }) => entry.name === "project"));
    const before = JSON.parse(await readFile(join(f.remoteHome, ".codeflow/ssh-host/runtime.json"), "utf8"));
    await service.disconnect(host.id); await service.connect(host.id);
    const after = JSON.parse(await readFile(join(f.remoteHome, ".codeflow/ssh-host/runtime.json"), "utf8")); assert.equal(after.pid, before.pid);
    await service.stop(host.id);
  } finally { await service?.close(); server?.kill("SIGTERM"); await f.cleanup(); }
});
