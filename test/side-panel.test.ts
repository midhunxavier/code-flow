// The side panel's server side: reading a file from the Files tab, notes that persist, the
// Terminal's shells (a command's output streams back, `cd` sticks, the exit code is reported,
// a closed shell is gone) and the list of running apps for the Browser tab. A real server on a
// free port with fake agents; never ports 4317/4318.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "side-panel-test-token";
const bearer = { authorization: `Bearer ${TOKEN}` };

const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    if (port !== 4317 && port !== 4318) return port;
  }
};

let base: string;
let child: ChildProcess;
let repo: string;
let home: string;

before(async () => {
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  // The real path: the shell reports $PWD, and on macOS the temp folder is behind a symlink.
  repo = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-side-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "README.md"), "# Side panel\n\nhello\n");
  writeFileSync(join(repo, "src", "index.js"), "export const one = 1;\n");
  writeFileSync(join(repo, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  home = mkdtempSync(join(tmpdir(), "codeflow-side-home-"));
  const port = await freePort();
  child = spawn(join(root, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, CODEFLOW_TOKEN: TOKEN },
    stdio: process.env.SIDE_DEBUG ? "inherit" : "ignore",
  });
  base = `http://localhost:${port}`;
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${base}/api/health`, { headers: bearer }).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server didn't start");
});

after(() => child?.kill("SIGTERM"));

const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const res = await fetch(base + path, { method, headers: { ...bearer, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

/** Read a shell's stream until `until` says the events seen so far are enough (or time runs out). */
async function streamShell(id: string, until: (events: any[]) => boolean, timeoutMs = 10_000): Promise<{ hello: any; events: any[] }> {
  const res = await fetch(`${base}/api/shell/${id}/events`, { headers: bearer });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hello: any;
  const events: any[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: true }), Math.max(0, deadline - Date.now())))]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.type === "hello") hello = event;
      else events.push(event);
    }
    if (hello && until(events)) break;
  }
  await reader.cancel().catch(() => {});
  return { hello, events };
}

test("/api/file reads a file inside the repository, says when it's binary, and refuses to leave the repo", async () => {
  const text = await api(`/api/file?repo=${encodeURIComponent(repo)}&path=src/index.js`);
  assert.equal(text.status, 200);
  assert.deepEqual(text.body, { path: "src/index.js", size: 22, text: "export const one = 1;\n", binary: false, truncated: false });

  const binary = await api(`/api/file?repo=${encodeURIComponent(repo)}&path=logo.bin`);
  assert.equal(binary.status, 200);
  assert.equal(binary.body.binary, true);
  assert.equal(binary.body.text, undefined);

  assert.equal((await api(`/api/file?repo=${encodeURIComponent(repo)}&path=nope.txt`)).status, 404);
  assert.equal((await api(`/api/file?repo=${encodeURIComponent(repo)}&path=src`)).status, 400, "a folder isn't a file");
  const outside = await api(`/api/file?repo=${encodeURIComponent(repo)}&path=../../etc/passwd`);
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /inside the repository/);
});

test("/api/notes keeps a note per repository and a general one, across requests", async () => {
  assert.deepEqual((await api(`/api/notes?key=${encodeURIComponent(repo)}`)).body, { text: "", updatedAt: 0 });
  const saved = await api("/api/notes", { key: repo, text: "check the tests" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.text, "check the tests");
  await api("/api/notes", { key: "", text: "general things" });
  assert.equal((await api(`/api/notes?key=${encodeURIComponent(repo)}`)).body.text, "check the tests");
  assert.equal((await api("/api/notes?key=")).body.text, "general things");
  assert.deepEqual(
    (await api("/api/notes/all")).body.map((n: { key: string }) => n.key).sort(),
    ["general", repo].sort(),
  );
  assert.equal((await api("/api/notes", { key: repo, text: 42 })).status, 400);
});

test("/api/shell: a shell stays open between commands, streams output, reports exit codes and the folder, and can be closed", async () => {
  assert.equal((await api("/api/shell", { cwd: "/" })).status, 400, "only a git repository or its worktrees");
  assert.equal((await api("/api/shell", { cwd: join(repo, "missing") })).status, 404);
  assert.equal((await api("/api/shell", { cwd: "relative" })).status, 400);

  const opened = await api("/api/shell", { cwd: repo });
  assert.equal(opened.status, 201);
  const { id } = opened.body;
  assert.equal(opened.body.cwd, repo);
  assert.equal(opened.body.status, "running");
  assert.ok((await api("/api/shell")).body.some((s: { id: string }) => s.id === id), "listed for reattaching");

  assert.equal((await api(`/api/shell/${id}/input`, { text: "echo first; cd src" })).status, 200);
  assert.equal((await api(`/api/shell/${id}/input`, { text: "pwd && exit 3" })).status, 200);
  const { hello, events } = await streamShell(id, (evs) => evs.some((e) => e.type === "exit"));
  assert.equal(hello.shell.id, id);
  // Everything the shell printed so far is replayed on connect, then the rest streams live.
  const all = [...hello.history, ...events];
  const output = all.filter((e) => e.type === "output").map((e) => e.text).join("");
  assert.match(output, /first\n/);
  assert.match(output, new RegExp(`${join(repo, "src").replace(/[/.]/g, "\\$&")}\n`), "`cd` in one command holds for the next");
  assert.ok(!output.includes("\u001e"), "the markers never reach the client");
  const dones = all.filter((e) => e.type === "done");
  assert.equal(dones.length, 1, "one command finished normally; `exit 3` ends the shell before its marker");
  assert.equal(dones[0].code, 0);
  assert.equal(dones[0].cwd, join(repo, "src"));
  assert.deepEqual(all.filter((e) => e.type === "input").map((e) => e.text), ["echo first; cd src", "pwd && exit 3"]);
  assert.deepEqual(all.find((e) => e.type === "exit"), { type: "exit", code: 3 });
  assert.equal((await api(`/api/shell/${id}`)).body.status, "exited");
  assert.equal((await api(`/api/shell/${id}/input`, { text: "echo more" })).status, 409, "an exited shell takes no more input");

  assert.deepEqual((await api(`/api/shell/${id}`, undefined, "DELETE")).body, { closed: true });
  assert.equal((await api(`/api/shell/${id}`)).status, 404);
});

test("/api/shell: a failing command reports its exit code, and the shell lives on", async () => {
  const { id } = (await api("/api/shell", { cwd: repo })).body;
  await api(`/api/shell/${id}/input`, { text: "ls README.md; false" });
  const { hello, events } = await streamShell(id, (evs) => evs.some((e) => e.type === "done"));
  const all = [...hello.history, ...events];
  assert.deepEqual(
    all.filter((e) => e.type === "done").map((e) => e.code),
    [1],
  );
  assert.match(all.filter((e) => e.type === "output").map((e) => e.text).join(""), /README\.md/);
  assert.equal((await api(`/api/shell/${id}`)).body.status, "running");
  await api(`/api/shell/${id}`, undefined, "DELETE");
});

test("/api/shell: room for a new shell comes from the oldest idle one, never a busy one; all busy is refused", async () => {
  for (const s of (await api("/api/shell")).body) await api(`/api/shell/${s.id}`, undefined, "DELETE");
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push((await api("/api/shell", { cwd: repo })).body.id);
  await api(`/api/shell/${ids[0]}/input`, { text: "sleep 30" });
  const thirteenth = await api("/api/shell", { cwd: repo });
  assert.equal(thirteenth.status, 201);
  let listed: string[] = (await api("/api/shell")).body.map((s: { id: string }) => s.id);
  assert.ok(listed.includes(ids[0]!), "the busy shell stays");
  assert.ok(!listed.includes(ids[1]!), "the oldest idle shell made room");
  for (const id of listed) if (id !== ids[0]) await api(`/api/shell/${id}/input`, { text: "sleep 30" });
  const full = await api("/api/shell", { cwd: repo });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /12 terminals are open and each is running something/);
  listed = (await api("/api/shell")).body.map((s: { id: string }) => s.id);
  for (const id of listed) await api(`/api/shell/${id}`, undefined, "DELETE");
});

test("/api/serve lists the apps started with Run app", async () => {
  assert.deepEqual((await api("/api/serve")).body, []);
});
