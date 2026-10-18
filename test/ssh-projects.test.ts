import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SshProjects } from "../src/ssh-projects/manager.js";
import { sshAliases } from "../src/ssh-projects/config.js";
import { parseRuntime } from "../src/ssh-projects/gateway.js";
import { SshTransport, validSshHost } from "../src/ssh-projects/transport.js";
import { buildHost, fixture, pause } from "./ssh-project-fixture.js";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";

test("SSH configuration discovers concrete aliases and includes; rejects command injection", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.directory, "config.d"));
    await writeFile(join(f.directory, "config"), 'Host devbox *.example !except\n Include config.d/*\nHost "quoted-host"\n');
    await writeFile(join(f.directory, "config.d", "extra"), 'Host build-server\nInclude ../config\n');
    assert.deepEqual(await sshAliases(join(f.directory, "config")), ["build-server", "devbox", "quoted-host"]);
    for (const host of ["-oProxyCommand=bad", "x;touch /tmp/bad", "x\nHost bad", "$(whoami)", "user@host:22", ""]) assert.equal(validSshHost(host), false);
    assert.throws(() => parseRuntime('CODEFLOW_SSH_READY {"port":22}'), /invalid/);
  } finally { await f.cleanup(); }
});

test("SSH connection options validate, persist, and keep aliases with different ports distinct", async () => {
  const f = await fixture();
  const options = { home: f.localHome, returnUrl: "http://localhost:4317/" };
  const service = new SshProjects(options);
  try {
    const host = await service.add({ sshHost: "dev@vm", port: 2222, identityFile: "~/.ssh/my key", name: "VM" });
    await service.add({ sshHost: "dev@vm", port: 2223 });
    await service.add({ sshHost: "legacy-alias" });
    await assert.rejects(service.add({ sshHost: "dev@vm", port: 2222, identityFile: "~/.ssh/my key" }), /already saved/);
    const restored = await new SshProjects(options).list();
    assert.equal(restored.hosts.length, 3);
    assert.deepEqual(restored.hosts[0], { ...host, state: "disconnected", error: undefined });
    for (const invalid of [{ port: 0 }, { port: 65536 }, { port: 22.5 }, { port: "22" }, { port: null }, { identityFile: "relative-key" }, { identityFile: "/tmp/key\nfile" }, { identityFile: "~/.ssh/%h" }]) {
      await assert.rejects(service.add({ sshHost: "vm", ...invalid }), /port from/);
      assert.throws(() => new SshTransport("vm", "ssh", invalid as any), /port from/);
    }
    const saved = JSON.parse(await readFile(join(f.localHome, "ssh-hosts.json"), "utf8"));
    saved.hosts[0].port = "-oProxyCommand=bad";
    await writeFile(join(f.localHome, "ssh-hosts.json"), JSON.stringify(saved));
    await assert.rejects(new SshProjects(options).list(), /Repair/);
  } finally { await service.close(); await f.cleanup(); }
});

test("full remote backend browses, edits, runs checks and agents, streams terminals, previews and reconnects", { timeout: 180_000 }, async () => {
  buildHost(); const f = await fixture();
  const service = new SshProjects({ home: f.localHome, returnUrl: "http://localhost:4317/", sshBinary: f.ssh });
  let origin = "", cookie = "";
  const open = async (id: string) => { const link = await service.connect(id); const response = await fetch(link.url, { redirect: "manual" }); assert.equal(response.status, 200); cookie = response.headers.get("set-cookie")!.split(";")[0]!; origin = new URL(link.url).origin; assert.equal((await fetch(link.url, { redirect: "manual" })).status, 401, "pairing ticket is single use"); };
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => { const response = await fetch(origin + path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const value = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`); return value; };
  let app: ReturnType<typeof createServer> | undefined;
  try {
    const state = join(f.remoteHome, ".codeflow/ssh-host/state");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "remote.json"), JSON.stringify({ enabled: true, lan: true, transport: "lan", token: "a".repeat(48), controlToken: "b".repeat(48) }));
    const host = await service.add({ sshHost: "fixture", name: "Remote fixture", port: 2222, identityFile: "~/.ssh/key with spaces" });
    await open(host.id);
    const remote = JSON.parse(await readFile(join(f.remoteHome, ".codeflow/ssh-host/runtime.json"), "utf8"));
    assert.equal((await fetch(`http://127.0.0.1:${remote.port}/api/fs`)).status, 401, "remote backend cannot be claimed by a local browser");
    assert.equal((await fetch(origin + "/api/fs")).status, 401);
    assert.equal((await fetch(origin + "/api/fs", { headers: { cookie, origin: "https://evil.example" } })).status, 403);
    assert.equal(await new Promise<number>((resolve, reject) => { request(origin + "/api/fs", { headers: { cookie, host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end(); }), 403);
    assert.equal((await call("/api/fs")).home, f.remoteHome);
    assert.equal((await call("/api/ssh-context")).name, "Remote fixture");
    const network = await call("/api/remote?refresh=1");
    assert.deepEqual(network.lanUrls, [], "saved remote-access settings cannot start a listener from an SSH backend");
    assert.equal(network.lanError, undefined);
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect(f.networkPort, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    assert.equal(listening, false, "neither startup nor refreshing remote access opens the network port");
    const pageResponse = await fetch(origin + "/", { headers: { cookie } });
    const html = await pageResponse.text();
    assert.equal(pageResponse.status, 200, html.slice(0, 1000));
    assert.ok(html.includes(`window.__CODEFLOW_WORKSPACE="${host.id}"`));
    assert.ok(!html.includes(remote.token), "backend token is never exposed to the browser");
    const file = await call(`/api/workspace/file?repo=${encodeURIComponent(f.repo)}&path=remote.txt`);
    await call("/api/workspace/file", { repo: f.repo, path: "remote.txt", text: "EDITED_REMOTELY\n", expectedHash: file.hash });
    assert.equal(await readFile(join(f.repo, "remote.txt"), "utf8"), "EDITED_REMOTELY\n");
    f.git("add", "."); f.git("commit", "-qm", "Remote edit");
    const symbols = await call(`/api/workspace/search?repo=${encodeURIComponent(f.repo)}&q=remoteFunction&mode=semantic`);
    assert.ok(JSON.stringify(symbols).includes("remoteFunction"), "the packaged semantic worker runs without node_modules");
    const readiness = await call("/api/readiness", { repo: f.repo, execute: true, check: "node check.mjs" });
    assert.ok(JSON.stringify(readiness).includes("CHECK_RAN_ON_REMOTE"));
    const shell = await call("/api/shell", { cwd: f.repo, pty: true });
    const abort = new AbortController();
    const stream = await fetch(`${origin}/api/shell/${shell.id}/events`, { headers: { cookie }, signal: abort.signal });
    assert.equal(stream.status, 200); const reader = stream.body!.getReader();
    await call(`/api/shell/${shell.id}/input`, { text: "echo SSH_TERMINAL_OK; pwd" });
    let output = ""; const timer = setTimeout(() => abort.abort(), 15_000);
    try { while (!output.includes("SSH_TERMINAL_OK") || !output.includes(f.repo)) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); } } finally { clearTimeout(timer); abort.abort(); }
    assert.match(output, /SSH_TERMINAL_OK/); assert.ok(output.includes(f.repo));
    await call(`/api/shell/${shell.id}`, undefined, "DELETE");
    app = createServer((req, res) => { assert.ok(!req.headers.cookie?.includes("codeflow_")); res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Remote app</title><p>REMOTE_PREVIEW_OK</p>"); });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    const preview = await call("/api/preview", { url: `http://localhost:${(app.address() as AddressInfo).port}` });
    const page = await fetch(preview.url, { headers: { cookie, referer: origin + "/" } }); assert.equal(page.status, 200); const pageText = await page.text(); assert.match(pageText, /REMOTE_PREVIEW_OK/); assert.equal(pageText.match(/<script src="\/__codeflow\/overlay.js"/g)?.length, 1);
    app.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nREMOTE_HOT_RELOAD"); });
    const upgraded = await new Promise<string>((resolve, reject) => {
      const req = request(preview.url, { headers: { connection: "Upgrade", upgrade: "websocket", origin: preview.origin } });
      const timer = setTimeout(() => { req.destroy(); reject(new Error("Remote WebSocket upgrade timed out")); }, 5000);
      req.on("upgrade", (_res, socket, head) => { let bytes = head.toString(); socket.on("data", (data) => bytes += data); socket.on("end", () => { clearTimeout(timer); socket.destroy(); resolve(bytes); }); socket.on("error", reject); });
      req.on("error", (error) => { clearTimeout(timer); reject(error); }); req.end();
    });
    assert.match(upgraded, /REMOTE_HOT_RELOAD/);
    const created = await call("/api/runs", { repo: f.repo, task: "SSH: exercise the full remote workflow", pattern: "pipeline", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {} });
    assert.ok(created.id);
    await service.disconnect(host.id); await open(host.id);
    assert.equal(JSON.parse(await readFile(join(f.remoteHome, ".codeflow/ssh-host/runtime.json"), "utf8")).pid, remote.pid, "reconnect reuses the running backend");
    let run;
    for (let i = 0; i < 200; i++) { run = await call(`/api/runs/${created.id}`); if (run.status !== "running") break; await pause(100); }
    assert.equal(run.status, "done", JSON.stringify(run.steps.map((step: any) => ({ status: step.status, error: step.error, output: step.output }))).slice(-2000));
    assert.ok(run.worktreeDir.startsWith(f.git("rev-parse", "--show-toplevel")));
    assert.equal((await call("/api/runs")).filter((item: { id: string }) => item.id === created.id).length, 1, "reconnection does not repeat the run");
    const audit = await readFile(f.audit, "utf8");
    for (const line of audit.trim().split("\n")) {
      const args: string[] = JSON.parse(line);
      assert.equal(args[args.indexOf("-p") + 1], "2222");
      assert.equal(args[args.indexOf("-i") + 1], "~/.ssh/key with spaces");
    } assert.match(audit, /StrictHostKeyChecking=yes/); assert.match(audit, /ForwardAgent=no/); assert.match(audit, /ClearAllForwardings=yes/);
    assert.equal((await readFile(join(f.localHome, "ssh-hosts.json"), "utf8")).includes(remote.token), false);
    const project = (await call("/api/projects"))[0];
    const policy = await call(`/api/projects/${project.id}/filesystem-policy`);
    await call(`/api/projects/${project.id}/filesystem-policy`, { revision: policy.revision, read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } }, "PUT");
    assert.ok(await fetch(preview.url).then((response) => response.status >= 400, () => true), "a remote policy change revokes already-open preview forwards");
    await call(`/api/projects/${project.id}/filesystem-policy`, { revision: policy.revision + 1, read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } }, "PUT");
    await service.stop(host.id);
  } finally { await service.close(); if (app) await new Promise<void>((resolve) => app!.close(() => resolve())); await f.cleanup(); }
});
