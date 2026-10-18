// The side panel's server side: reading a file from the Files tab, notes that persist, the
// Terminal's shells (a command's output streams back, `cd` sticks, the exit code is reported,
// a closed shell is gone; an interactive one in a pseudo-terminal takes keystrokes, has a size,
// replays its history and closes everything it started) and the list of running apps for the
// Browser tab. A real server on a free port with fake agents; never ports 4317/4318.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
let shellHome: string;

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
  // The terminals' login shell is bash with a home of its own: nobody's dotfiles, a known prompt.
  shellHome = mkdtempSync(join(tmpdir(), "codeflow-side-user-"));
  writeFileSync(join(shellHome, ".bash_profile"), "PS1='pty$ '\n");
  const port = await freePort();
  child = spawn(join(root, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, CODEFLOW_TOKEN: TOKEN, SHELL: "/bin/bash", HOME: shellHome, BASH_SILENCE_DEPRECATION_WARNING: "1" },
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
async function streamShell(id: string, until: (events: any[], hello: any) => boolean, timeoutMs = 10_000): Promise<{ hello: any; events: any[] }> {
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
    if (hello && until(events, hello)) break;
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
  assert.deepEqual((await api(`/api/notes?key=${encodeURIComponent(repo)}`)).body, { text: "", updatedAt: 0, revision: 0 });
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

/** Everything an interactive shell has shown: its replayed history, then what streamed after. */
/**
 * What the terminal printed. Bash with readline turns bracketed paste on at each prompt and off
 * before running the line (`ESC[?2004h` / `ESC[?2004l` and a carriage return, on Ubuntu's bash):
 * those go, so a command's output follows the line it was typed on.
 */
const shown = (events: any[], hello: any) =>
  [...(hello?.history ?? []), ...events]
    .filter((e) => e.type === "output")
    .map((e) => e.text)
    .join("")
    .replace(/\x1b\[\?2004[hl]\r?/g, "");
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("/api/shell: a shell with a job in the background isn't closed to make room, in a terminal or a line-based shell", async () => {
  for (const s of (await api("/api/shell")).body) await api(`/api/shell/${s.id}`, undefined, "DELETE");
  const ids: string[] = [(await api("/api/shell", { cwd: repo, pty: true })).body.id];
  for (let i = 1; i < 12; i++) ids.push((await api("/api/shell", { cwd: repo })).body.id);
  // Both get their prompt back, so neither is busy; each still has a job running.
  await api(`/api/shell/${ids[0]}/input`, { data: "sleep 309 & echo pty-bg=$!\r" });
  await api(`/api/shell/${ids[1]}/input`, { text: "sleep 310 & echo lines-bg=$!" });
  const pty = await streamShell(ids[0]!, (evs, hello) => /pty-bg=\d+\r\n/.test(shown(evs, hello)));
  const lines = await streamShell(ids[1]!, (evs) => evs.some((e) => e.type === "done"));
  const pids = [Number(shown(pty.events, pty.hello).match(/pty-bg=(\d+)/)?.[1]), Number(shown(lines.events, lines.hello).match(/lines-bg=(\d+)/)?.[1])];
  assert.ok(pids.every((p) => p > 1), `found both jobs: ${pids}`);
  assert.equal((await api(`/api/shell/${ids[0]}`)).body.busy, false);
  assert.equal((await api(`/api/shell/${ids[1]}`)).body.busy, false);

  assert.equal((await api("/api/shell", { cwd: repo })).status, 201);
  const listed: string[] = (await api("/api/shell")).body.map((s: { id: string }) => s.id);
  assert.ok(listed.includes(ids[0]!) && listed.includes(ids[1]!), "the shells with jobs stay");
  assert.ok(!listed.includes(ids[2]!), "the oldest shell without one made room");
  assert.ok(pids.every((p) => !gone(p)), "both jobs are still running");
  for (const id of listed) await api(`/api/shell/${id}`, undefined, "DELETE");
  for (let i = 0; i < 60 && !pids.every(gone); i++) await new Promise((r) => setTimeout(r, 100));
});

test("/api/shell with pty: a real terminal takes keystrokes, has the size you set, replays its history and closes everything it started", async () => {
  const opened = await api("/api/shell", { cwd: repo, pty: true, cols: 100, rows: 30 });
  assert.equal(opened.status, 201);
  const { id } = opened.body;
  assert.equal(opened.body.interactive, true, "python3 is there, so the terminal is a real one");
  assert.deepEqual([opened.body.cols, opened.body.rows], [100, 30]);
  assert.equal((await api("/api/health")).body.interactiveTerminal, true);
  const typed = (data: string) => api(`/api/shell/${id}/input`, { data });

  // Keystrokes are echoed by the terminal, and the command's output follows.
  assert.equal((await typed("echo hi-$((40+2)) h\u00e9llo\r")).status, 200);
  let seen = await streamShell(id, (evs, hello) => /hi-42 h\u00e9llo\r\n/.test(shown(evs, hello)));
  assert.match(shown(seen.events, seen.hello), /echo hi-\$\(\(40\+2\)\) h\u00e9llo/, "the typed line is echoed");
  assert.match(shown(seen.events, seen.hello), /\r\nhi-42 h\u00e9llo\r\n/, "UTF-8 comes through whole");

  // A resize reaches the programs in the terminal.
  assert.equal((await api(`/api/shell/${id}/resize`, { cols: 91, rows: 27 })).status, 200);
  assert.equal((await api(`/api/shell/${id}/resize`, { cols: "wide", rows: 27 })).status, 400);
  await typed("stty size\r");
  seen = await streamShell(id, (evs, hello) => /\r\n27 91\r\n/.test(shown(evs, hello)));
  assert.match(shown(seen.events, seen.hello), /\r\n27 91\r\n/, "stty sees the new size");
  assert.deepEqual([(await api(`/api/shell/${id}`)).body.cols, (await api(`/api/shell/${id}`)).body.rows], [91, 27]);

  // Bytes (xterm's mouse reports in its default encoding) go in as they are, not UTF-8 encoded.
  await typed("stty raw -echo; echo raw-on; head -c 3 | od -An -tx1; stty sane\r");
  await streamShell(id, (evs, hello) => /\r\nraw-on\n/.test(shown(evs, hello)));
  assert.equal((await api(`/api/shell/${id}/input`, { binary: "éÿ\u0080" })).status, 200);
  seen = await streamShell(id, (evs, hello) => /e9\s+ff\s+80/.test(shown(evs, hello)));
  assert.match(shown(seen.events, seen.hello), /e9\s+ff\s+80/, "three bytes, as sent");

  // A client that connects again gets what the terminal showed so far.
  const again = await streamShell(id, () => true);
  assert.equal(again.hello.shell.interactive, true);
  assert.match(shown([], again.hello), /hi-42 h\u00e9llo[\s\S]*27 91/, "the history is replayed on reconnect");

  // A program in the foreground makes it busy; closing it ends the job in the background and the
  // one in the foreground, even though that one ignores the hang-up (and SIGTERM).
  await typed("sleep 301 & echo bg=$!\r");
  await typed("sh -c 'trap \"\" HUP TERM; echo fg=$$; exec sleep 300'\r");
  seen = await streamShell(id, (evs, hello) => /fg=\d+\r\n/.test(shown(evs, hello)) && /bg=\d+\r\n/.test(shown(evs, hello)));
  const pids = ["bg", "fg"].map((k) => Number(shown(seen.events, seen.hello).match(new RegExp(`${k}=(\\d+)`))?.[1]));
  assert.ok(pids.every((p) => p > 1), `found both jobs: ${pids}`);
  let info: any;
  for (let i = 0; i < 50 && !(info?.busy && info?.running); i++) {
    info = (await api(`/api/shell/${id}`)).body;
    if (!(info.busy && info.running)) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(info.busy, true, "busy while sleep is in the foreground");
  assert.equal(info.running, "sleep");
  assert.ok(pids.every((p) => !gone(p)), "both jobs are running");

  assert.deepEqual((await api(`/api/shell/${id}`, undefined, "DELETE")).body, { closed: true });
  for (let i = 0; i < 60 && !pids.every(gone); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(pids.every(gone), `closing the terminal ended both jobs: ${pids.filter((p) => !gone(p))} still running`);
  assert.equal((await api(`/api/shell/${id}`)).status, 404);
});

test("/api/shell with pty: `exit` ends it with the shell's exit code, and a command can still be sent as text", async () => {
  const { id } = (await api("/api/shell", { cwd: repo, pty: true })).body;
  assert.equal((await api(`/api/shell/${id}/input`, { text: "cd src && echo in-$(basename $PWD)" })).status, 200, "text is a command, sent with Enter");
  await api(`/api/shell/${id}/input`, { data: "exit 4\r" });
  const { hello, events } = await streamShell(id, (evs, h) => [...h.history, ...evs].some((e: any) => e.type === "exit"));
  assert.match(shown(events, hello), /\r\nin-src\r\n/);
  assert.deepEqual([...hello.history, ...events].find((e) => e.type === "exit"), { type: "exit", code: 4 });
  assert.equal((await api(`/api/shell/${id}/input`, { data: "x" })).status, 409, "an exited terminal takes no more keys");
  assert.equal((await api(`/api/shell/${id}/resize`, { cols: 80, rows: 24 })).status, 409);
  await api(`/api/shell/${id}`, undefined, "DELETE");
});

/**
 * Run `body` in a code-flow process of its own, with `Shells` imported: bash with the test's home is
 * its login shell, and what it tracks goes to a home of its own. Returns the last line it prints.
 */
function inOwnProcess(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-side-own-"));
  const script = join(dir, "script.mts");
  writeFileSync(script, `import { Shells } from ${JSON.stringify(pathToFileURL(join(root, "src/shell.ts")).href)};\n${body}`);
  const out = execFileSync(join(root, "node_modules/.bin/tsx"), [script], {
    cwd: root,
    timeout: 30_000,
    env: { ...process.env, CODEFLOW_HOME: join(dir, "home"), SHELL: "/bin/bash", HOME: shellHome, BASH_SILENCE_DEPRECATION_WARNING: "1" },
  });
  return out.toString().trim().split("\n").at(-1)!;
}

test("when code-flow stops, an interactive terminal still hangs up its jobs, nohup'd and disowned ones too", async () => {
  // A terminal with two jobs that leave the shell's process group (and ignore or never get the
  // shell's hang-up), then code-flow stops as the server does: closeAll, exit.
  const out = inOwnProcess(`const shells = new Shells();
const sh = await shells.open(${JSON.stringify(repo)}, { pty: true });
let seen = "";
const started = new Promise<void>((resolve) => shells.subscribe(sh.id, (e) => {
  if (e.type === "output") seen += e.text;
  if (/nohup=\\d+\\r\\n/.test(seen) && /disowned=\\d+\\r\\n/.test(seen)) resolve();
}));
shells.type(sh.id, "nohup sleep 307 >/dev/null 2>&1 & echo nohup=$!\\r");
shells.type(sh.id, "sleep 308 & disown; echo disowned=$!\\r");
await started;
console.log(JSON.stringify(["nohup", "disowned"].map((k) => Number(seen.match(new RegExp(k + "=(\\\\d+)"))?.[1]))));
shells.closeAll();
process.exit(0);
`);
  const pids: number[] = JSON.parse(out);
  try {
    assert.ok(pids.length === 2 && pids.every((p) => p > 1), `found both jobs: ${pids}`);
    for (let i = 0; i < 60 && !pids.every(gone); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(pids.every(gone), `stopping ended both jobs: ${pids.filter((p) => !gone(p))} still running`);
  } finally {
    for (const p of pids) if (p > 1 && !gone(p)) process.kill(p, "SIGKILL");
  }
});

test("a repository that pins a Python its version manager doesn't have still gets a terminal", async () => {
  // A stand-in for a pyenv/asdf/mise shim: it picks the interpreter by the folder it runs in.
  const bin = mkdtempSync(join(tmpdir(), "codeflow-side-shim-"));
  const shim = join(bin, "python3");
  writeFileSync(shim, `#!/bin/sh\nif [ -f .python-version ]; then echo "pyenv: version \\\`$(cat .python-version)' is not installed" >&2; exit 1; fi\nexec python3 "$@"\n`, { mode: 0o755 });
  const pinned = mkdtempSync(join(tmpdir(), "codeflow-side-pinned-"));
  writeFileSync(join(pinned, ".python-version"), "2.7.18\n");
  const out = inOwnProcess(`const shells = new Shells({ python: ${JSON.stringify(shim)} });
const sh = await shells.open(${JSON.stringify(pinned)}, { pty: true });
let seen = "";
const result = await new Promise<string>((resolve) => {
  shells.subscribe(sh.id, (e) => {
    if (e.type === "output") seen += e.text;
    if (/ok-2\\r\\n/.test(seen)) resolve("ok");
    if (e.type === "exit") resolve("exited");
  });
  shells.type(sh.id, "echo ok-$((1+1))\\r");
  setTimeout(() => resolve("timed out"), 10_000);
});
console.log(JSON.stringify({ interactive: sh.interactive, result, seen: seen.slice(-300) }));
shells.closeAll();
process.exit(0);
`);
  const { interactive, result, seen } = JSON.parse(out);
  assert.equal(interactive, true);
  assert.equal(result, "ok", `the terminal works in the pinned folder: ${seen}`);
});

test("without python3, a terminal asked for as interactive is the line-based shell, and says so", async () => {
  // In this process: the processes it tracks go to a home of its own, not the server's.
  process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-side-nopty-"));
  const { Shells } = await import("../src/shell.js");
  const shells = new Shells({ python: join(home, "no-python3-here") });
  try {
    assert.equal(await shells.interactive(), false);
    const sh = await shells.open(repo, { pty: true, cols: 120, rows: 40 });
    assert.equal(sh.interactive, false);
    assert.equal(sh.cols, undefined);
    assert.equal(shells.resize(sh.id, 100, 30), false, "a line-based shell has no size");
    assert.equal(shells.type(sh.id, "ls\r"), false, "nor keystrokes");
    const done = new Promise<any[]>((resolve) => {
      const seen: any[] = [];
      shells.subscribe(sh.id, (e) => (seen.push(e), e.type === "done" && resolve(seen)));
    });
    assert.ok(shells.write(sh.id, "echo still-works"));
    const seen = await done;
    assert.match(seen.filter((e) => e.type === "output").map((e) => e.text).join(""), /still-works\n/);
  } finally {
    shells.closeAll();
  }
});

test("/api/serve lists the apps started with Run app", async () => {
  assert.deepEqual((await api("/api/serve")).body, []);
});

test("/api/preview: a local app through its own port, with the overlay, frameable, and only for requests addressed to it", async () => {
  const { createServer: createHttp, request } = await import("node:http");
  const { connect } = await import("node:net");
  // A stand-in for a dev server: a page that refuses frames, a JSON echo, a redirect, and a WebSocket-ish upgrade that echoes.
  const app = createHttp((req, res) => {
    if (req.url === "/echo") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null }));
    if (req.url === "/old") return res.writeHead(302, { location: `http://localhost:${(app.address() as AddressInfo).port}/new` }).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
    res.end("<!doctype html><html><head><title>App</title></head><body>hi</body></html>");
  });
  app.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
  });
  const appPort = await new Promise<number>((r) => app.listen(0, "127.0.0.1", () => r((app.address() as AddressInfo).port)));
  try {
    assert.equal((await api("/api/preview", { url: "https://example.com/" })).status, 400, "only apps on this computer");
    const shown = await api("/api/preview", { url: `http://127.0.0.1:${appPort}/?x=1` });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.match(shown.body.url, /^http:\/\/localhost:\d+\/\?x=1$/, "the host you opened code-flow with, so the preview is same-site");
    assert.notEqual(new URL(shown.body.url).port, String(appPort), "a port of its own: a different origin from the app and from code-flow");
    assert.equal((await api("/api/preview", { url: `http://127.0.0.1:${appPort}/` })).body.origin, shown.body.origin, "the same app keeps its port");

    const page = await fetch(shown.body.url);
    const html = await page.text();
    assert.match(html, /<head><script src="\/__codeflow\/overlay\.js"><\/script><title>/);
    assert.equal(page.headers.get("x-frame-options"), null);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'self' http:\/\/localhost:\d+/, "frameable by code-flow");
    assert.doesNotMatch(csp, /'none'/, "and not refused outright");
    const overlay = await (await fetch(`${shown.body.origin}/__codeflow/overlay.js`)).text();
    assert.match(overlay, new RegExp(`const PARENTS = \\["http://localhost:${new URL(base).port}"`));

    const echo = await (await fetch(`${shown.body.origin}/echo`, { method: "POST", headers: { origin: shown.body.origin } })).json();
    assert.deepEqual(echo, { host: `127.0.0.1:${appPort}`, origin: `http://127.0.0.1:${appPort}` }, "the app sees its own host and origin");
    const moved = await fetch(`${shown.body.origin}/old`, { redirect: "manual" });
    assert.equal(moved.headers.get("location"), `http://localhost:${appPort}/new`, "a redirect to another host is left alone");

    // A request that names another host (DNS rebinding) is refused.
    const port = Number(new URL(shown.body.origin).port);
    const status = await new Promise<number>((resolve) => request({ host: "127.0.0.1", port, path: "/", headers: { host: `evil.example:${port}` } }, (r) => resolve(r.statusCode ?? 0)).end());
    assert.equal(status, 403);

    // WebSockets (hot reload) go through.
    const echoed = await new Promise<string>((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
      let seen = "";
      s.on("data", (d) => {
        seen += d.toString();
        if (seen.includes("\r\n\r\n") && !seen.includes("ping")) s.write("ping");
        if (seen.includes("ping")) (s.end(), resolve(seen));
      });
      s.on("error", reject);
    });
    assert.match(echoed, /^HTTP\/1\.1 101/);
    assert.match(echoed, /ping$/);
  } finally {
    app.close();
  }
});
