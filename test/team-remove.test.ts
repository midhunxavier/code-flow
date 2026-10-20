import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const modulePath = new URL("../src/ssh-projects/team-remove.mjs", import.meta.url).href;
const { removeTeamServer } = await import(modulePath);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "cf-remove-"));
  const root = join(home, ".codeflow/team-server");
  const workspace = join(home, ".codeflow/ssh-host");
  await mkdir(root, { recursive: true }); await mkdir(workspace);
  await writeFile(join(workspace, "keep"), "workspace");
  const runtime = { protocol: 1, port: 4318, pid: 12345, token: "a".repeat(64), instance: "b".repeat(32) };
  await writeFile(join(root, "runtime.json"), JSON.stringify(runtime));
  const unitPath = join(home, ".config/systemd/user/codeflow-team-server.service");
  const calls: string[][] = [];
  const options = { home, alive: () => false, request: async () => { throw new Error("offline"); }, run: async (args: string[]) => { calls.push(args); } };
  return { home, root, workspace, runtime, unitPath, calls, options, cleanup: () => rm(home, { recursive: true, force: true }) };
}
test("permanent removal deletes only team storage and the managed startup unit", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, ".config/systemd/user"), { recursive: true });
    await writeFile(f.unitPath, "# Managed by Code Flow team server setup\nfixture");
    assert.deepEqual(await removeTeamServer(f.options), { removed: true });
    await assert.rejects(access(f.root)); await assert.rejects(access(f.unitPath));
    assert.equal(await readFile(join(f.workspace, "keep"), "utf8"), "workspace");
    assert.deepEqual(f.calls, [["disable", "--now", "codeflow-team-server.service"], ["daemon-reload"]]);
  } finally { await f.cleanup(); }
});
test("busy server refuses deletion and keeps both service and team data", async () => {
  const f = await fixture();
  try {
    await assert.rejects(removeTeamServer({ ...f.options, request: async (url: string) => url.endsWith("/stop") ? new Response("{}", { status: 409 }) : Response.json({ instance: f.runtime.instance }) }), /Finish running team work/);
    await access(f.root); assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});
test("startup failure aborts deletion and leaves team data intact", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, ".config/systemd/user"), { recursive: true }); await writeFile(f.unitPath, "# Managed by Code Flow team server setup\nfixture");
    await assert.rejects(removeTeamServer({ ...f.options, run: async () => { throw new Error("systemd unavailable"); } }), /systemd unavailable/);
    await access(f.root); await access(f.unitPath);
  } finally { await f.cleanup(); }
});
test("unrecognized processes, unmanaged services and redirected storage cannot be removed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(removeTeamServer({ ...f.options, request: async () => Response.json({ instance: "wrong" }) }), /identity changed/);
    await mkdir(join(f.home, ".config/systemd/user"), { recursive: true }); await writeFile(f.unitPath, "unrelated service");
    await assert.rejects(removeTeamServer(f.options), /not managed/);
    await rm(f.root, { recursive: true }); await symlink(f.workspace, f.root);
    await assert.rejects(removeTeamServer(f.options), /symbolic link/);
    assert.equal(await readFile(join(f.workspace, "keep"), "utf8"), "workspace");
  } finally { await f.cleanup(); }
});

test("an active bootstrap lock prevents removal and is preserved", async () => {
  const f = await fixture();
  try {
    const bootId = process.platform === "linux" ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() : undefined;
    const lock = join(f.root, bootId ? `bootstrap.${bootId}.lock` : "bootstrap.lock");
    await mkdir(lock);
    await assert.rejects(removeTeamServer(f.options), /already running/);
    await access(lock); await access(join(f.root, "runtime.json"));
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});
