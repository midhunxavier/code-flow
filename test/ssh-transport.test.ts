import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshTransport } from "../src/ssh-projects/transport.js";

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }, source: (directory: string) => string) {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-ssh-stream-"));
  const binary = join(directory, "ssh");
  await writeFile(binary, `#!${process.execPath}\nif (process.argv.includes('-O')) process.exit(0);\n${source(directory)}`, { mode: 0o700 });
  const transport = new SshTransport("fixture", binary); await transport.init();
  t.after(async () => { await transport.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, transport };
}
async function channelPid(directory: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return Number(await readFile(join(directory, "pid"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("SSH fixture did not start");
}
async function waitForExit(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("SSH channel process is still alive");
}

test("SSH drains a buffered HTTP response after its input pipe closes", { timeout: 10_000 }, async t => {
  const body = "buffered response ".repeat(1024);
  const response = `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
  const { directory, transport } = await fixture(t, directory => `
    require('node:fs').writeFileSync(${JSON.stringify(join(directory, "pid"))}, String(process.pid));
    process.stdin.once('data', () => {
      process.stdin.destroy();
      process.stdout.end(${JSON.stringify(response)});
    });
  `);
  const stream = transport.open(12345);
  stream.write("GET /api/fs HTTP/1.1\r\nHost: localhost\r\n\r\n");
  // A slow consumer must still receive all bytes after the SSH process has exited.
  await waitForExit(await channelPid(directory));
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), response);
});

test("SSH cancellation terminates its channel process", { timeout: 10_000 }, async t => {
  const { directory, transport } = await fixture(t, directory => `
    require('node:fs').writeFileSync(${JSON.stringify(join(directory, "pid"))}, String(process.pid));
    process.stdin.resume();
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `);
  const stream = transport.open(12345);
  await once(stream, "data");
  const pid = await channelPid(directory);
  const closed = once(stream, "close"); stream.destroy(); await closed;
  await waitForExit(pid);
});

test("SSH forwards a large response to a paused consumer without losing bytes", { timeout: 10_000 }, async t => {
  const { directory, transport } = await fixture(t, directory => `
    require('node:fs').writeFileSync(${JSON.stringify(join(directory, "pid"))}, String(process.pid));
    process.stdin.once('data', () => {
      process.stdin.destroy();
      process.stdout.end(Buffer.alloc(1024 * 1024, 97));
    });
  `);
  const stream = transport.open(12345);
  stream.write("request");
  await channelPid(directory);
  await new Promise(resolve => setTimeout(resolve, 30));
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(1024 * 1024, 97));
});

test("SSH channel failures retain the process error", { timeout: 10_000 }, async t => {
  const { transport } = await fixture(t, () => "process.stderr.write('fixture connection refused'); process.exitCode = 7;");
  const stream = transport.open(12345);
  const failure = once(stream, "error"); stream.resume();
  const [error] = await failure;
  assert.match(error.message, /SSH connection failed: fixture connection refused/);
});
