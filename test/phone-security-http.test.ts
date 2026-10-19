import { after, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "../src/engine.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "codeflow-phone-security-"));
const headers = { authorization: "Bearer phone-security-test", "content-type": "application/json" };
const children = new Set<ChildProcess>();
const freePort = () => new Promise<number>((resolve) => { const server = createServer().listen(0, "127.0.0.1", () => { const port = (server.address() as AddressInfo).port; server.close(() => resolve(port)); }); });
interface Instance { child: ChildProcess; port: number; remotePort: number; home: string }
async function stop(instance: Instance) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  instance.child.kill("SIGTERM");
  await new Promise<void>((resolve) => { const timer = setTimeout(() => { instance.child.kill("SIGKILL"); resolve(); }, 5_000); instance.child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  children.delete(instance.child);
}
async function start(tls: boolean, home?: string, extra: Record<string, string> = {}): Promise<Instance> {
  home ??= join(directory, `home-${await freePort()}`);
  const port = await freePort(), remotePort = await freePort();
  const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
  if (tls) {
    try { await readFile(cert); }
    catch { execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" }); }
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, ...extra, CODEFLOW_HOME: home, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remotePort), CODEFLOW_TOKEN: "phone-security-test", CODEFLOW_LAN_ALLOW_LOCAL: "1", CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL: "0", CODEFLOW_TLS_CERT: tls ? cert : "", CODEFLOW_TLS_KEY: tls ? key : "", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  children.add(child);
  let output = ""; child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let index = 0; index < 100; index++) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`, { headers }).then((response) => response.ok, () => false)) return { child, port, remotePort, home };
    if (child.exitCode !== null || index === 99) throw new Error(`Phone security server failed: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("unreachable");
}
async function local(instance: Instance, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
function phone(instance: Instance, path: string, cookie?: string, origin?: string) {
  return new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
    const request = httpsRequest({ host: "127.0.0.1", port: instance.remotePort, path, rejectUnauthorized: false, agent: false, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } }, (response) => {
      let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, cookie: response.headers["set-cookie"]?.[0], body }));
    });
    request.on("error", reject); request.end();
  });
}
after(async () => { for (const child of children) { child.kill("SIGKILL"); } await rm(directory, { recursive: true, force: true }); });

test("phone control requires TLS and secure device sessions remain independently revocable", async () => {
  const insecure = await start(false);
  assert.equal((await local(insecure, "/api/remote", { enabled: true, lan: true, control: true })).status, 400);
  assert.equal((await local(insecure, "/api/remote", { enabled: true, lan: true, transport: "tailscale", control: true })).status, 400, "Tailscale encryption cannot isolate HTTP cookies from other services on the same host");
  await stop(insecure);
  const secure = await start(true);
  try {
    const info = (await local(secure, "/api/remote", { enabled: true, lan: true, control: true })).body;
    assert.equal(info.secure, true);
    assert.ok(info.pairingUntil > Date.now());
    const one = await phone(secure, info.phonePath), two = await phone(secure, info.phonePath);
    assert.equal(one.status, 200);
    assert.match(one.cookie!, /HttpOnly.*SameSite=Strict.*Secure.*Max-Age=2592000/);
    const first = one.cookie!.split(";")[0]!, second = two.cookie!.split(";")[0]!;
    assert.notEqual(first, second);
    assert.equal((await phone(secure, "/api/runs", first)).status, 200);
    assert.equal((await phone(secure, "/api/runs", first, "https://evil.test")).status, 403);
    const devices = (await local(secure, "/api/remote/devices")).body;
    assert.equal(devices.length, 2);
    assert.equal(devices[0].tokenHash, undefined);
    assert.equal((await local(secure, `/api/remote/devices/${devices[0].id}`, undefined, "DELETE")).status, 200);
    assert.equal((await phone(secure, "/api/runs", first)).status, 401);
    assert.equal((await phone(secure, "/api/runs", second)).status, 200);
    assert.ok(!String(await readFile(join(secure.home, "phone-devices.json"))).includes(second.split("=")[1]!));
  } finally { await stop(secure); }
});

test("expired pairing links stay expired after restart while existing device sessions retain their expiry", async () => {
  let instance = await start(true);
  try {
    const info = (await local(instance, "/api/remote", { enabled: true, lan: true, control: true })).body;
    const paired = await phone(instance, info.phonePath);
    const cookie = paired.cookie!.split(";")[0]!;
    const devices = (await local(instance, "/api/remote/devices")).body;
    const expiresAt = devices[0].expiresAt;
    const home = instance.home;
    await stop(instance);
    const settings = JSON.parse(await readFile(join(home, "remote.json"), "utf8"));
    settings.pairingUntil = Date.now() - 1;
    await writeFile(join(home, "remote.json"), JSON.stringify(settings));
    instance = await start(true, home);
    assert.equal((await phone(instance, info.phonePath)).status, 403);
    // Cookie names include the port, so preserve the token with this restarted listener's name.
    const currentCookie = cookie.replace(/^codeflow_phone_\d+=/, `codeflow_phone_${instance.remotePort}=`);
    assert.equal((await phone(instance, "/api/runs", currentCookie)).status, 200);
    assert.equal((await local(instance, "/api/remote/devices")).body[0].expiresAt, expiresAt);
    await stop(instance);
    delete settings.pairingUntil; // Upgrade from a version whose links had no durable expiry.
    await writeFile(join(home, "remote.json"), JSON.stringify(settings));
    instance = await start(true, home);
    assert.equal((await phone(instance, info.phonePath)).status, 403, "legacy pairing links fail closed on upgrade");
    const renewed = await local(instance, "/api/remote", { rotate: true });
    assert.ok(renewed.body.pairingUntil > Date.now());
    assert.equal((await phone(instance, renewed.body.phonePath)).status, 200);
  } finally { await stop(instance); }
});

test("concurrent remote settings requests save complete generations and never revive rotated sessions", async () => {
  const instance = await start(true);
  try {
    const info = (await local(instance, "/api/remote", { enabled: true, lan: true, control: true })).body;
    const paired = await phone(instance, info.phonePath);
    const cookie = paired.cookie!.split(";")[0]!;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => local(instance, "/api/remote", index % 2 ? { enabled: true } : { rotate: true })));
    assert.ok(results.every((result) => result.status === 200), JSON.stringify(results));
    assert.equal((await phone(instance, "/api/runs", cookie)).status, 401);
    const final = (await local(instance, "/api/remote")).body;
    assert.notEqual(final.phonePath, info.phonePath);
    const disk = JSON.parse(await readFile(join(instance.home, "remote.json"), "utf8"));
    assert.equal(final.phonePath, `/r/${disk.controlToken}`);
  } finally { await stop(instance); }
});

test("forking an untrusted run preserves lockdown and does not recopy ignored credentials", async () => {
  const repo = await realpath(await mkdtemp(join(directory, "repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, ".codeflow", "config.json"), JSON.stringify({ copy: [".env"] }));
  await writeFile(join(repo, ".gitignore"), ".env\n");
  await writeFile(join(repo, "README.md"), "Untrusted fork fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  await writeFile(join(repo, ".env"), "CREDENTIAL_FIXTURE=private\n");
  const state = join(directory, "gh.json");
  await writeFile(state, JSON.stringify({ issues: [{ number: 6, title: "External issue", body: "Untrusted text", url: "https://github.com/o/r/issues/6", labels: [], author: { login: "outsider" }, authorAssociation: "NONE" }], prs: {} }));
  const instance = await start(false, undefined, { FAKE_GH_STATE: state });
  const finished = async (id: string) => {
    for (let index = 0; index < 150; index++) { const run = (await local(instance, `/api/runs/${id}`)).body as Run; if (run.status !== "running") return run; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error("Fork fixture did not finish");
  };
  try {
    const started = await local(instance, "/api/runs", { repo, pattern: "solo", task: "Inspect external issue", roles: { agent: ["codex"] }, source: { kind: "issue", number: 6 }, loop: { check: "", maxSteps: 3 } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const original = await finished(started.body.id);
    assert.equal(original.status, "done", original.error);
    const commit = execFileSync("git", ["rev-parse", original.worktrees[0]!.branch], { cwd: repo }).toString().trim();
    const forked = await local(instance, `/api/runs/${original.id}/fork`, { commit });
    assert.equal(forked.status, 201, JSON.stringify(forked.body));
    const fork = await finished(forked.body.id);
    assert.equal(fork.parentRunId, original.id);
    assert.ok(fork.lockdown);
    assert.equal(fork.source?.trusted, false);
    assert.equal(fork.trust, "safe");
    assert.equal(fork.loop.copy, undefined);
    await assert.rejects(readFile(join(fork.worktrees[0]!.path, ".env")), { code: "ENOENT" });
  } finally { await stop(instance); }
});

test("Settings installs HTTPS live, persists it and refuses invalid replacements or remote certificate administration", async () => {
  const { certificateFixture } = await import("./remote-tls-fixture.js");
  const fixtureDirectory = await mkdtemp(join(directory, "import-"));
  const pair = await certificateFixture(fixtureDirectory);
  let instance = await start(false);
  try {
    const original = (await local(instance, "/api/remote", { enabled: true, lan: true, control: false })).body;
    const bad = await local(instance, "/api/remote/tls", { mode: "import", hostname: "wrong.example", cert: pair.cert, key: pair.key });
    assert.equal(bad.status, 400);
    assert.equal((await local(instance, "/api/remote")).body.secure, false);
    const applied = await local(instance, "/api/remote/tls", { mode: "import", hostname: "localhost", cert: pair.cert, key: pair.key });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.secure, true);
    assert.equal(applied.body.control, false);
    assert.notEqual(applied.body.phonePath, original.phonePath);
    assert.match(applied.body.lanUrls[0], /^https:\/\/localhost:/);
    assert.equal(applied.body.tls.hostname, "localhost");
    assert.ok(!JSON.stringify(applied.body).includes("PRIVATE KEY"));
    const enabled = (await local(instance, "/api/remote", { control: true })).body;
    const paired = await phone(instance, enabled.phonePath);
    assert.match(paired.cookie!, /; Secure/);
    const cookie = paired.cookie!.split(";")[0]!;
    assert.equal((await phone(instance, "/api/remote/tls", cookie)).status, 403);
    assert.equal(JSON.parse((await phone(instance, "/api/remote", cookie)).body).tls.editable, false);
    const home = instance.home;
    await stop(instance); instance = await start(false, home);
    assert.equal((await local(instance, "/api/remote")).body.secure, true, "saved HTTPS loads without environment variables");
    const invalid = await local(instance, "/api/remote/tls", { mode: "import", hostname: "localhost", cert: pair.cert, key: "invalid PRIVATE_SENTINEL" });
    assert.equal(invalid.status, 400); assert.ok(!JSON.stringify(invalid.body).includes("SENTINEL"));
    assert.equal((await local(instance, "/api/remote")).body.control, true, "invalid replacement leaves the active certificate and controls intact");
    await stop(instance);
    await writeFile(join(home, "remote-tls.json"), "corrupt");
    instance = await start(false, home);
    const broken = (await local(instance, "/api/remote")).body;
    assert.equal(broken.secure, false); assert.deepEqual(broken.lanUrls, []);
    assert.match(broken.tls.error, /invalid or expired/);
    assert.equal((await local(instance, "/api/remote", { control: true })).status, 400);
  } finally { await stop(instance); }
});
