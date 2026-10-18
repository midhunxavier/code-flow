import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-launch-module-"));
const { LaunchProfiles, launchDirectory, readLaunchProfiles, validateLaunchProfiles } = await import("../src/launch-profiles.js");
const { DevServers } = await import("../src/serve.js");
type Profile = import("../src/launch-profiles.js").LaunchProfile;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = `${quote(process.execPath)} service.mjs`;
const service = (id: string, fields: Record<string, unknown> = {}) => ({ id, command, cwd: id, health: { path: "/health", timeoutMs: 3000 }, ...fields });
const profile = (services: unknown[]): Profile => validateLaunchProfiles({ version: 1, profiles: [{ id: "development", name: "Development", services }] })[0]!;
const app = `import { createServer } from 'node:http';
if (process.env.FAIL === 'yes') process.exit(7);
if (process.env.SERVICE_NAME === 'web') { const response = await fetch(process.env.API_URL + '/health'); if (!response.ok) process.exit(8); }
await new Promise(resolve => setTimeout(resolve, Number(process.env.READY_DELAY ?? 0)));
const server = createServer((req,res) => {
 if (req.url === '/health' && process.env.HEALTH === 'redirect') { res.writeHead(302,{location: 'http://127.0.0.1:1/'}); return res.end(); }
 if (req.url === '/health' && process.env.HEALTH === 'bad') { res.statusCode=503; return res.end('starting'); }
 res.setHeader('content-type','application/json'); res.end(JSON.stringify({service:process.env.SERVICE_NAME,api:process.env.API_URL,web:process.env.WEB_URL,endpoint:process.env.API_ENDPOINT,privateToken:process.env.CODEFLOW_TOKEN??null}));
});
server.listen(Number(process.env.PORT), process.env.HOST, () => console.log('ready ' + process.env.SERVICE_NAME));
if (process.env.EXIT_AFTER) setTimeout(() => process.exit(9), Number(process.env.EXIT_AFTER));
`;
async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "codeflow-launch-"));
  const servers = new DevServers(); const launches = new LaunchProfiles(servers);
  t.after(() => { launches.stopAll(); servers.stopAll(); return rm(root, { recursive: true, force: true }); });
  for (const id of ["api", "web", "worker"]) { await mkdir(join(root, id)); await writeFile(join(root, id, "service.mjs"), app); }
  return { root, launches, servers };
}
async function eventually(check: () => Promise<boolean> | boolean) { for (let attempt = 0; attempt < 50; attempt++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 30)); } assert.fail("condition did not become true"); }

test("launch configurations validate bounds, safe paths, dependency DAGs and generated environment before commands run", () => {
  assert.equal(profile([service("api"), service("web", { dependsOn: ["api"], env: { API_ENDPOINT: "${API_URL}/v1" } })]).services.length, 2);
  for (const services of [
    [service("api", { cwd: "../outside" })], [service("api", { cwd: ".git" })], [service("api", { cwd: "folder//nested" })],
    [service("api", { dependsOn: ["missing"] })], [service("api", { dependsOn: ["web"] }), service("web", { dependsOn: ["api"] })],
    [service("api", { env: { API_URL: "override" } })], [service("api", { env: { PORT: "123" } })], [service("api", { env: { APP: "${MISSING_URL}" } })],
    [service("api", { health: { path: "//external.test", timeoutMs: 100 } })], [service("api", { health: { path: "/health\r\nheader", timeoutMs: 100 } })],
    Array.from({ length: 7 }, (_, i) => service(`service-${i}`)),
  ]) assert.throws(() => profile(services));
});

test("launch config and working directories reject symlinks without following them", async (t) => {
  const { root } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "codeflow-launch-outside-")); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "linked"));
  await assert.rejects(launchDirectory(root, "linked"), /symbolic link/);
  assert.deepEqual(await readLaunchProfiles(root), { profiles: [], found: false });
  await mkdir(join(root, ".codeflow"));
  await writeFile(join(outside, "launch.json"), JSON.stringify({ version: 1, profiles: [] }));
  await symlink(join(outside, "launch.json"), join(root, ".codeflow", "launch.json"));
  assert.equal((await readLaunchProfiles(root)).profiles.length, 0);
  assert.ok((await readLaunchProfiles(root)).error);
});

test("two real services receive distinct ports and peer URLs, wait for dependencies, expose logs, and stop as a group", async (t) => {
  const { root, launches, servers } = await fixture(t);
  const previous = process.env.CODEFLOW_TOKEN; process.env.CODEFLOW_TOKEN = "private-codeflow-server-token";
  t.after(() => { if (previous === undefined) delete process.env.CODEFLOW_TOKEN; else process.env.CODEFLOW_TOKEN = previous; });
  const result = await launches.start("run/main/launch", root, profile([service("api", { env: { READY_DELAY: "150" } }), service("web", { dependsOn: ["api"], env: { API_ENDPOINT: "${API_URL}/v1" } })]));
  assert.equal(result.status, "ready"); assert.equal(result.services.every((entry) => entry.healthChecked), true);
  assert.notEqual(result.services[0]!.port, result.services[1]!.port);
  const body = await fetch(result.services[1]!.url).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(body.api, result.services[0]!.url); assert.equal(body.web, result.services[1]!.url);
  assert.equal(body.endpoint, `${result.services[0]!.url}/v1`); assert.equal(body.privateToken, null);
  assert.ok(launches.get(result.key)!.services.every((entry) => entry.logs.some((line) => line.includes("ready"))));
  assert.equal(servers.list().length, 2);
  launches.stopMatching("run/");
  assert.equal(launches.get(result.key)?.status, "stopped"); assert.equal(servers.list().length, 0);
  await eventually(() => fetch(result.services[0]!.url).then(() => false, () => true));
});

test("untrusted profiles need explicit confirmation and failed startup cleans up already healthy dependencies", async (t) => {
  const { root, launches, servers } = await fixture(t);
  const config = profile([service("api"), service("web", { dependsOn: ["api"], env: { FAIL: "yes" } })]);
  await assert.rejects(launches.start("blocked", root, config, { lockdown: "Untrusted pull request" }), (error: unknown) => (error as { confirm: string }).confirm === "allowUntrusted");
  assert.equal(servers.list().length, 0); assert.equal(launches.get("blocked"), undefined);
  await assert.rejects(launches.start("confirmed", root, config, { lockdown: "Untrusted pull request", allowUntrusted: true }), /exited/);
  assert.equal(launches.get("confirmed")?.status, "failed"); assert.equal(servers.list().length, 0);
  assert.ok(launches.get("confirmed")?.services[0]?.logs.some((line) => line.includes("ready api")));
});

test("health checks reject redirects and cancellation stops a profile while startup is pending", async (t) => {
  const { root, launches, servers } = await fixture(t);
  await assert.rejects(launches.start("redirect", root, profile([service("api", { health: { path: "/health", timeoutMs: 400 }, env: { HEALTH: "redirect" } })])), /HTTP health/);
  assert.equal(servers.list().length, 0);
  const pending = launches.start("cancel", root, profile([service("api", { env: { HEALTH: "bad" } })]));
  const rejected = assert.rejects(pending, /cancelled/);
  await eventually(() => servers.list().length === 1);
  assert.equal(launches.stop("cancel"), true);
  await rejected;
  assert.equal(launches.get("cancel")?.status, "stopped"); assert.equal(servers.list().length, 0);
  const restarted = await launches.start("cancel", root, profile([service("api")]));
  assert.equal(restarted.status, "ready");
});

test("process-only readiness is explicit and a later service exit stops the whole stack", async (t) => {
  const { root, launches, servers } = await fixture(t);
  const running = await launches.start("process", root, profile([service("api", { health: false }), service("worker", { health: false, env: { EXIT_AFTER: "450" } })]));
  assert.equal(running.services.every((entry) => !entry.healthChecked && entry.status === "running"), true);
  await eventually(() => launches.get("process")?.status === "failed");
  assert.equal(servers.list().length, 0); assert.match(launches.get("process")?.error ?? "", /exited/);
});

test("HTTP readiness has an absolute deadline even when a service dribbles incomplete headers", { timeout: 5000 }, async (t) => {
  const { root, launches, servers } = await fixture(t);
  await writeFile(join(root, "api", "service.mjs"), "import {createServer} from 'node:net'; createServer(socket=>{socket.write('HTTP/1.1 200 OK\\r\\nX-Slow: ');const timer=setInterval(()=>socket.write('x'),20);socket.on('close',()=>clearInterval(timer));socket.on('error',()=>{});}).listen(Number(process.env.PORT),process.env.HOST);\n");
  const before = Date.now();
  await assert.rejects(launches.start("slow", root, profile([service("api", { health: { path: "/health", timeoutMs: 400 } })])), /HTTP health/);
  assert.ok(Date.now() - before < 2500, "streaming partial headers cannot keep a readiness request alive indefinitely");
  assert.equal(servers.list().length, 0);
});
