import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const modulePath = new URL("../src/ssh-projects/team-autostart.mjs", import.meta.url).href;
const { configureAutostart, serviceUnit } = await import(modulePath);

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "cf-autostart-"));
  const root = join(home, ".codeflow/team-server"), unitPath = join(home, ".config/systemd/user/codeflow-team-server.service");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "service-bootstrap.mjs"), "// fixture"); await writeFile(join(root, "service-package.json"), "{}");
  let enabled = false, linger = false, refuseLinger = false, refuseEnable = false;
  const calls: { file: string; args: string[] }[] = [];
  const options = { home, platform: "linux", uid: 1234, node: "/opt/node bin/node", path: "/opt/node bin:/usr/bin", run: async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === "loginctl") {
      if (args.includes("enable-linger")) { if (refuseLinger) throw new Error("denied"); linger = true; return ""; }
      return linger ? "yes" : "no";
    }
    if (args.includes("enable") && !refuseEnable) enabled = true;
    if (args.includes("disable")) enabled = false;
    if (args.includes("is-enabled")) return enabled ? "enabled" : "disabled";
    return "";
  } };
  return { home, root, unitPath, calls, options, refuseLinger: () => { refuseLinger = true; }, refuseEnable: () => { refuseEnable = true; }, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("automatic startup verifies both systemd enablement and linger; disabling preserves running work and other user services", async () => {
  const f = await fixture();
  try {
    assert.equal((await configureAutostart("status", f.options)).enabled, false);
    const enabled = await configureAutostart("enable", f.options);
    assert.equal(enabled.enabled, true); assert.equal(enabled.linger, true);
    assert.equal((await stat(f.unitPath)).mode & 0o777, 0o600);
    const content = await readFile(f.unitPath, "utf8");
    assert.ok(content.includes('ExecStart="/opt/node bin/node"')); assert.ok(content.includes("--team-server --service"));
    assert.ok(!content.includes("CODEFLOW_TOKEN"));
    assert.equal((await configureAutostart("enable", f.options)).enabled, true);
    assert.equal(f.calls.filter(call => call.args.includes("enable-linger")).length, 1, "repeated setup does not repeat account changes");
    assert.equal((await configureAutostart("disable", f.options)).enabled, false);
    assert.equal((await configureAutostart("status", f.options)).linger, true);
    assert.ok(!f.calls.some(call => call.args.some(arg => ["--now", "start", "restart", "stop", "disable-linger"].includes(arg))));
  } finally { await f.cleanup(); }
});

test("denied boot permission provides a specific administrator action without claiming success", async () => {
  const f = await fixture();
  try {
    f.refuseLinger();
    const result = await configureAutostart("enable", f.options);
    assert.equal(result.enabled, false); assert.equal(result.command, "sudo loginctl enable-linger 1234");
    await assert.rejects(readFile(f.unitPath), { code: "ENOENT" });
    assert.ok(!f.calls.some(call => call.args.includes("enable")));
  } finally { await f.cleanup(); }
});

test("failed enable verification cannot report automatic startup as ready", async () => {
  const f = await fixture();
  try { f.refuseEnable(); assert.equal((await configureAutostart("enable", f.options)).enabled, false); }
  finally { await f.cleanup(); }
});

test("unsupported systems, unavailable user managers and existing foreign units are left unchanged", async () => {
  const f = await fixture();
  try {
    assert.equal((await configureAutostart("enable", { ...f.options, platform: "darwin" })).supported, false);
    assert.equal(f.calls.length, 0);
    assert.equal((await configureAutostart("enable", { ...f.options, run: async () => { throw new Error("no bus"); } })).supported, false);
    await mkdir(join(f.home, ".config/systemd/user"), { recursive: true }); await writeFile(f.unitPath, "# Somebody else's service\n");
    await assert.rejects(configureAutostart("enable", f.options), /not managed/);
    assert.equal(await readFile(f.unitPath, "utf8"), "# Somebody else's service\n");
    await assert.rejects(configureAutostart("execute anything", f.options), /Unknown/);
  } finally { await f.cleanup(); }
});

test("service paths and executable arguments remain literal without systemd specifier or variable expansion", () => {
  const unit = serviceUnit('/home/a %u $USER "quote"', '/node %n $PATH/bin/node', '/custom/%u/$PATH:/usr/bin');
  assert.ok(unit.includes('ExecStart="/node %%n $$PATH/bin/node"'));
  assert.ok(unit.includes('Environment="PATH=/custom/%%u/$PATH:/usr/bin"'));
  assert.throws(() => serviceUnit("/home/a\nExecStart=bad", "/node", "/bin"), /control characters/);
});
