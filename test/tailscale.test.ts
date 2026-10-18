import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTailscale, isTailscaleIPv4, parseTailscaleStatus } from "../src/tailscale.js";
import { changeRemote, loadRemote, saveRemote } from "../src/remote.js";

const running = { BackendState: "Running", TUN: true, TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"], Self: { Online: true, DNSName: "workstation.tail-test.ts.net." }, Peer: { private: { UserID: 1234 } } };
const parse = (value: object) => parseTailscaleStatus(JSON.stringify(value));

test("Tailscale status exposes only this device's validated address and readiness", () => {
  assert.deepEqual(parse(running), { state: "connected", message: "Tailscale is connected.", ip: "100.101.102.103", dnsName: "workstation.tail-test.ts.net" });
  for (const [BackendState, state] of [["Stopped", "stopped"], ["NeedsLogin", "needs-login"], ["NeedsMachineAuth", "needs-approval"], ["Starting", "starting"], ["NoState", "unavailable"]]) {
    const result = parse({ ...running, BackendState });
    assert.equal(result.state, state);
    assert.equal(result.ip, undefined, "stale IPs must not enable listening");
  }
  for (const value of [{ ...running, TUN: false }, { ...running, Self: { Online: false } }, { ...running, TailscaleIPs: ["127.0.0.1", "0.0.0.0", "192.168.1.2"] }]) assert.equal(parse(value).state, "unavailable");
  assert.equal(parse({ ...running, Self: { DNSName: "host.ts.net/evil" } }).dnsName, undefined);
  for (const ip of ["127.0.0.1", "0.0.0.0", "100.63.255.255", "100.128.0.1", "100.99.99.999", "100.99.99.1; command"]) assert.equal(isTailscaleIPv4(ip), false);
  assert.ok(isTailscaleIPv4("100.64.0.0") && isTailscaleIPv4("100.127.255.255"));
});

test("detector falls back only for a missing executable, uses CLI mode and handles failed status commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-tailscale-cli-"));
  try {
    const script = join(dir, "tailscale");
    const set = (body: string) => writeFile(script, `#!${process.execPath}\n${body}`, { mode: 0o755 });
    assert.equal((await detectTailscale([join(dir, "missing")])).state, "not-installed");
    await set(`if (process.env.TAILSCALE_BE_CLI !== '1' || process.argv.slice(2).join(' ') !== 'status --json --peers=false') process.exit(2); console.log(${JSON.stringify(JSON.stringify(running))});`);
    assert.equal((await detectTailscale([join(dir, "missing"), script])).ip, "100.101.102.103");
    await set(`console.log('{"BackendState":"NeedsLogin"}'); process.exitCode = 1;`);
    assert.equal((await detectTailscale([script])).state, "needs-login");
    await set(`console.log('invalid JSON');`);
    assert.equal((await detectTailscale([script])).state, "unavailable");
    await set(`setTimeout(() => {}, 30000);`);
    assert.equal((await detectTailscale([script])).state, "unavailable", "an unresponsive service is bounded by the detector timeout");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("transport switches revoke both links, renew pairing, and preserve legacy Wi-Fi settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-tailscale-settings-"));
  const file = join(dir, "remote.json");
  try {
    const before = { enabled: true, lan: true, control: true, token: "a".repeat(48), controlToken: "b".repeat(48) };
    await saveRemote(before, file);
    assert.equal((await loadRemote(file)).transport, "lan");
    const tailnet = changeRemote(before, { transport: "tailscale" });
    assert.notEqual(tailnet.token, before.token);
    assert.notEqual(tailnet.controlToken, before.controlToken);
    assert.ok(tailnet.pairingUntil! > Date.now());
    await saveRemote(tailnet, file);
    assert.deepEqual(await loadRemote(file), tailnet);
    const wifi = changeRemote(tailnet, { transport: "lan" });
    assert.notEqual(wifi.controlToken, tailnet.controlToken);
    assert.deepEqual(changeRemote(tailnet, { transport: "tailscale" }), tailnet);
    await writeFile(file, JSON.stringify({ ...tailnet, transport: "unknown" }));
    assert.equal((await loadRemote(file)).lan, false, "an unknown transport never falls back to LAN access");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
