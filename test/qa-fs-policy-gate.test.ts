// The filesystem-restriction gate: every owner route is classified (a misspelled or new route can't
// bypass the pause, as "shells" let /api/shell do), terminals, model discovery and the old frame
// probe are refused under a restriction, the refusal names the project, and saving unchanged rules
// commits nothing. GitHub listings run `gh` with the host's login in the repository they list, so
// they are refused too, even for a repository no project restricts. Real servers on free ports with fake agents; never ports 4317/4318.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilesystemAccess, RESTRICTED_EXECUTION_ROUTES, RESTRICTED_PRIVATE_ROUTES, RESTRICTION_OPEN_ROUTES } from "../src/filesystem-access.js";
import { FilePolicyError, ProjectFilePolicies } from "../src/filesystem-policy.js";
import type { RunManager } from "../src/engine.js";
import type { Projects } from "../src/projects.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const restriction = { read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } };
const open = { read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } };

/** The top-level segments the owner API dispatches on after the gate, in server.ts and the APIs it mounts. */
function routedSegments(): Set<string> {
  const server = readFileSync(join(root, "src/server.ts"), "utf8");
  const routed = server.slice(server.indexOf("await attempt(() => fileAccess.ownerGate("));
  const segments = new Set<string>();
  for (const [, name] of routed.matchAll(/parts\[1\] === "([a-z0-9-]+)"/g)) segments.add(name!);
  for (const [, list] of routed.matchAll(/\[((?:"[a-z0-9-]+",?\s*)+)\]\.includes\(parts\[1\]/g)) for (const [, name] of list!.matchAll(/"([a-z0-9-]+)"/g)) segments.add(name!);
  for (const [, name] of routed.matchAll(/parts\.join\("\/"\) === "api\/([a-z0-9-]+)/g)) segments.add(name!);
  // Mounted handlers that check their own first segment.
  for (const [file, pattern] of [["src/journey-api.ts", /parts\[1\] !== "([a-z0-9-]+)"/g], ["src/code-hosts-api.ts", /parts\[0\] !== "([a-z0-9-]+)"/g], ["src/workspace-api.ts", /parts\[1\] === "([a-z0-9-]+)"/g]] as const)
    for (const [, name] of readFileSync(join(root, file), "utf8").matchAll(pattern)) segments.add(name!);
  return segments;
}

test("every owner route is classified for restrictions, and every classified name is a real route", () => {
  const routed = routedSegments(), classified = new Set([...RESTRICTED_PRIVATE_ROUTES, ...RESTRICTED_EXECUTION_ROUTES, ...RESTRICTION_OPEN_ROUTES]);
  for (const name of ["shell", "model-catalog", "models", "doctor", "github", "runs", "journeys", "code-hosts", "workspace"]) assert.ok(routed.has(name), `the route scan finds ${name}`);
  assert.deepEqual([...routed].filter((name) => !classified.has(name)), [], "a route without a classification would be refused under any restriction; classify it deliberately");
  assert.deepEqual([...classified].filter((name) => !routed.has(name)), [], "a listed name that matches no route protects nothing (\"shells\" never matched /api/shell)");
  assert.deepEqual(RESTRICTION_OPEN_ROUTES.filter((name) => RESTRICTED_PRIVATE_ROUTES.includes(name) || RESTRICTED_EXECUTION_ROUTES.includes(name)), []);
  // Routes that run a host CLI even to read: private, so a GET is refused as well.
  for (const name of ["shell", "model-catalog", "models", "doctor", "github"]) assert.ok(RESTRICTED_PRIVATE_ROUTES.includes(name), `${name} is private`);
  assert.equal(routed.has("frame-policy"), false, "the uncalled outbound frame probe is gone");
});

test("the owner gate refuses terminals, model discovery and unknown routes under a restriction, names the project, and still closes terminals", async () => {
  const home = mkdtempSync(join(tmpdir(), "codeflow-qa-gate-"));
  try {
    const store = new ProjectFilePolicies(home);
    const list = [{ id: "restricted", name: "Secret project", repos: ["/nowhere/restricted"], createdAt: 1 }, { id: "other", name: "Other", repos: ["/nowhere/other"], createdAt: 1 }];
    const projects = { list: () => list, get: (id: string) => list.find((project) => project.id === id) } as unknown as Projects;
    const manager = { relatedRuns: () => [], getAsync: async () => undefined } as unknown as RunManager;
    const access = new FilesystemAccess(store, projects, manager);
    const gate = async (method: string, path: string) => {
      const url = new URL(`http://127.0.0.1${path}`), req = { method, headers: {} } as IncomingMessage;
      try { await access.ownerGate(req, url, url.pathname.split("/").filter(Boolean)); return 200; }
      catch (error) { assert.ok(error instanceof FilePolicyError, String(error)); return error.status; }
      finally { access.end(req); }
    };
    for (const [method, path] of [["GET", "/api/shell"], ["POST", "/api/shell"], ["POST", "/api/model-catalog"], ["GET", "/api/github/issues?repo=/nowhere/other"], ["GET", "/api/brand-new-route"]] as const) assert.equal(await gate(method, path), 200, `${method} ${path} without a restriction`);
    await store.set("restricted", { revision: 0, ...restriction });
    const expected: [string, string, number][] = [
      ["GET", "/api/shell", 403], ["POST", "/api/shell", 409], ["POST", "/api/shell/sh1/input", 409], ["POST", "/api/shell/sh1/resize", 409], ["DELETE", "/api/shell/sh1", 200],
      ["GET", "/api/model-catalog", 403], ["POST", "/api/model-catalog", 409], ["GET", "/api/models", 403], ["GET", "/api/doctor", 403],
      ["POST", "/api/frame-policy", 409], ["GET", "/api/brand-new-route", 403], ["GET", "/api/shells", 403],
      ["GET", "/api/github/issues?repo=/nowhere/other", 403], ["GET", "/api/github/prs?repo=/nowhere/other", 403], ["GET", "/api/github/sweep?repo=/nowhere/other&kind=issues", 403],
      ["GET", "/api/agents", 200], ["GET", "/api/projects", 200], ["GET", "/api/health", 200], ["GET", "/api/runs", 200], ["POST", "/api/runs", 409],
    ];
    for (const [method, path, status] of expected) assert.equal(await gate(method, path), status, `${method} ${path} under a restriction`);
    const url = new URL("http://127.0.0.1/api/doctor"), req = { method: "GET", headers: {} } as IncomingMessage;
    await assert.rejects(access.ownerGate(req, url, ["api", "doctor"]), (error: FilePolicyError) => /“Secret project”/.test(error.message) && /Settings → Projects/.test(error.message) && !/Other/.test(error.message));
    access.end(req);
    assert.deepEqual(access.restrictedProjects(), [{ id: "restricted", name: "Secret project" }]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("saving the rules already in force commits nothing; a changed rule still activates", async () => {
  const home = mkdtempSync(join(tmpdir(), "codeflow-qa-gate-"));
  try {
    const store = new ProjectFilePolicies(home);
    const access = new FilesystemAccess(store, { list: () => [], get: () => undefined } as unknown as Projects, { relatedRuns: () => [] } as unknown as RunManager);
    let activations = 0; const activate = async (commit: () => Promise<void>) => { activations++; await commit(); };
    assert.equal((await access.update("project", { revision: 0, ...open }, activate)).revision, 0, "the unrestricted default stays revision 0");
    const first = await access.update("project", { revision: 0, read: { allow: ["."], deny: ["private/", "private"] }, write: open.write }, activate);
    assert.equal(first.revision, 1); assert.equal(activations, 1);
    const again = await access.update("project", { revision: 1, ...restriction }, activate);
    assert.deepEqual(again, first, "normalized identical rules return the saved snapshot"); assert.equal(activations, 1, "nothing is paused or closed for an unchanged save");
    await assert.rejects(access.update("project", { revision: 0, ...restriction }, activate), /changed/, "a stale revision is still a conflict");
    assert.equal((await access.update("project", { revision: 1, ...open }, activate)).revision, 2); assert.equal(activations, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("under a saved restriction the server opens no terminal, runs no model discovery, says why providers are unavailable, and recovers once cleared", { timeout: 60_000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-gate-server-"))), home = join(directory, "data"), repo = join(directory, "repo"), other = join(directory, "other");
  const token = "qa-fs-policy-gate", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, invocations = join(directory, "invocations.log"), marker = join(repo, "private", "written-under-policy.txt");
  for (const folder of [repo, other]) {
    mkdirSync(join(folder, "private"), { recursive: true }); writeFileSync(join(folder, "private", "secret.txt"), "secret\n"); writeFileSync(join(folder, "README.md"), "fixture\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder }); execFileSync("git", ["add", "."], { cwd: folder }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: folder });
  }
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify([{ id: "restricted", name: "Restricted project", repos: [repo], createdAt: 1, defaults: {} }, { id: "unrestricted", name: "Unrestricted project", repos: [other], createdAt: 1, defaults: {} }]));
  await new ProjectFilePolicies(home).set("restricted", { revision: 0, ...restriction });
  // Provider CLIs that record each call before acting as the fake agent.
  const bin = join(directory, "bin"); mkdirSync(bin);
  for (const binary of ["claude", "codex", "agy"]) { writeFileSync(join(bin, binary), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(invocations)},${JSON.stringify(binary)}+' '+process.argv.slice(2).join(' ')+'\\n');const child=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(root, "test/fake-agent.mjs"))},${JSON.stringify(binary)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(child.status??1);\n`); chmodSync(join(bin, binary), 0o700); }
  // And a GitHub CLI that does the same before acting as the fake gh.
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(invocations)},'gh '+process.argv.slice(2).join(' ')+'\\n');const child=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(root, "test/fake-gh.mjs"))},...process.argv.slice(2)],{stdio:'inherit'});process.exit(child.status??1);\n`); chmodSync(join(bin, "gh"), 0o700);
  const ghState = join(directory, "gh-state.json"); writeFileSync(ghState, JSON.stringify({ issues: [{ number: 7, title: "Fixture issue", body: "", url: "https://github.com/o/r/issues/7", labels: [] }], prs: {} }));
  const free = () => new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const selected = (probe.address() as AddressInfo).port; probe.close(() => resolve(selected)); }); });
  const [port, remotePort] = [await free(), await free()];
  assert.ok(![port, remotePort].some((value) => value === 4317 || value === 4318));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remotePort), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_GH_STATE: ghState, PATH: `${bin}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: process.env.QA_DEBUG ? "inherit" : "ignore" });
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    let healthy = false; for (let attempt = 0; attempt < 150 && !healthy; attempt++) { healthy = await call("/api/health").then((response) => response.ok, () => false); if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.ok(healthy, "the server starts under a saved restriction");
    for (const prefix of ["/api", "/api/v1"]) {
      for (const cwd of [repo, other]) for (const pty of [false, true]) assert.equal((await call(`${prefix}/shell`, { cwd, pty })).status, 409, `${prefix}/shell in ${cwd === repo ? "the restricted" : "another"} repository (pty ${pty})`);
      assert.equal((await call(`${prefix}/shell`)).status, 403);
      const input = await call(`${prefix}/shell/sh-any/input`, { text: `echo bypass > ${marker}` }); assert.equal(input.status, 409);
      assert.equal((await call(`${prefix}/shell/sh-any`, undefined, "DELETE")).status, 404, "closing stays allowed; this terminal just doesn't exist");
      const catalog = await call(`${prefix}/model-catalog`); assert.equal(catalog.status, 403); assert.match((await catalog.json()).error, /“Restricted project”.*Settings → Projects/s);
      for (const body of [{}, { allowResearch: true }]) assert.equal((await call(`${prefix}/model-catalog`, body)).status, 409);
      assert.equal((await call(`${prefix}/frame-policy`, { url: "http://127.0.0.1:1/" })).status, 409, "an unclassified route is refused");
      // GitHub listings run `gh` in the repository with your login: refused even where no project restricts paths.
      for (const path of [`/github/issues?repo=${encodeURIComponent(other)}`, `/github/prs?repo=${encodeURIComponent(other)}`, `/github/sweep?repo=${encodeURIComponent(other)}&kind=issues`]) {
        const listing = await call(prefix + path); assert.equal(listing.status, 403, `${prefix}${path}`); assert.match((await listing.json()).error, /“Restricted project”.*Settings → Projects/s);
      }
    }
    assert.equal(existsSync(marker), false); assert.equal(existsSync(invocations), false, "no provider or GitHub CLI ran"); assert.equal(existsSync(join(home, "model-catalogs")), false, "no catalog was discovered");
    const agents = await call("/api/agents").then((response) => response.json()) as { available: boolean; unavailableReason?: string }[];
    assert.ok(agents.length); for (const agent of agents) assert.deepEqual([agent.available, agent.unavailableReason], [false, "filesystem-policy"]);
    const projects = await call("/api/projects").then((response) => response.json()) as { id: string; filesystemRestricted?: boolean }[];
    assert.deepEqual(projects.map((project) => [project.id, project.filesystemRestricted ?? false]), [["restricted", true], ["unrestricted", false]]);
    const doctor = await call("/api/doctor"); assert.equal(doctor.status, 403); assert.doesNotMatch((await doctor.json()).error, /host authority/, "the refusal is in plain words");
    const saved = await call("/api/projects/restricted/filesystem-policy").then((response) => response.json());
    const same = await call("/api/projects/restricted/filesystem-policy", { revision: saved.revision, ...restriction }, "PUT"); assert.equal(same.status, 200); assert.equal((await same.json()).revision, saved.revision, "an unchanged save is not a new revision");
    const cleared = await call("/api/projects/restricted/filesystem-policy", { revision: saved.revision, ...open }, "PUT"); assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal((await call("/api/agents").then((response) => response.json()) as { unavailableReason?: string }[]).some((agent) => agent.unavailableReason), false);
    assert.equal((await call("/api/frame-policy", { url: "http://127.0.0.1:1/" })).status, 404);
    const issues = await call(`/api/github/issues?repo=${encodeURIComponent(other)}`); assert.equal(issues.status, 200, "GitHub listings work again once cleared");
    const issuePage = await issues.json(); assert.equal(issuePage.truncated, false); assert.deepEqual(issuePage.items.map((issue: { number: number }) => issue.number), [7]); assert.match(readFileSync(invocations, "utf8"), /^gh issue list /m, "the logging gh is the one that lists");
    const shell = await call("/api/shell", { cwd: other }); assert.equal(shell.status, 201, "terminals open again once no project is restricted"); const { id } = await shell.json();
    const blocked = await call("/api/projects/restricted/filesystem-policy", { revision: saved.revision + 1, ...restriction }, "PUT"); assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /Close the open terminal/);
    assert.equal((await call(`/api/shell/${id}`, undefined, "DELETE")).status, 200);
    assert.equal((await call("/api/projects/restricted/filesystem-policy", { revision: saved.revision + 1, ...restriction }, "PUT")).status, 200);
  } finally {
    server.kill("SIGTERM"); await new Promise<void>((resolve) => { if (server.exitCode !== null) return resolve(); server.once("exit", () => resolve()); setTimeout(resolve, 5000).unref(); });
    rmSync(directory, { recursive: true, force: true });
  }
});
