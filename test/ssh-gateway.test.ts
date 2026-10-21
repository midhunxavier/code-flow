import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { SshGateway, type Runtime } from "../src/ssh-projects/gateway.js";
import type { SshTransport } from "../src/ssh-projects/transport.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const runtime: Runtime = { protocol: 1, port: 12345, token: "a".repeat(64), instance: "b".repeat(32), version: "c".repeat(64), pid: 1 };
const transport = () => ({ close: async () => {}, open: () => { throw new Error("Unexpected transport use"); } }) as unknown as SshTransport;

test("late failed SSH probes cannot reconnect an already recovered transport", async () => {
  const old = transport(), replacement = transport();
  const first = deferred<unknown>(), late = deferred<unknown>();
  let probes = 0, reconnects = 0;
  const gateway = new SshGateway(old, runtime, async () => { reconnects++; return { transport: replacement, runtime }; });
  gateway.json = () => (++probes === 1 ? first.promise : late.promise);
  const a = gateway.ensureConnected(), b = gateway.ensureConnected();
  first.reject(new Error("old transport closed"));
  await a;
  late.reject(new Error("delayed failure from the same old transport"));
  await b;
  assert.equal(reconnects, 1, "late failures must not destroy the replacement's active API streams");
  await gateway.close();
});

test("SSH API forwarding waits for recovery without replaying mutations", async t => {
  const ready = deferred<{ transport: SshTransport; runtime: Runtime }>();
  let oldOpens = 0, requests = 0;
  const old = { ...transport(), open: () => { oldOpens++; throw new Error("Old transport used"); } } as unknown as SshTransport;
  const backend = createServer((req, res) => { requests++; req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end('{"saved":true}'); }); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const port = (backend.address() as AddressInfo).port;
  const next = { ...transport(), open: () => connect(port, "127.0.0.1") } as unknown as SshTransport;
  const gateway = new SshGateway(old, runtime, () => ready.promise);
  t.after(() => gateway.close());
  const restoring = gateway.restore();
  const arrived = deferred<void>();
  const proxy = createServer((req, res) => {
    const forwarding = gateway.forward(req, res, "/api/projects", "http://localhost");
    arrived.resolve();
    void forwarding.catch(error => { res.statusCode = 500; res.end(error.message); });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const response = fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, { method: "POST", body: "{}" });
  await arrived.promise;
  assert.equal(oldOpens, 0);
  ready.resolve({ transport: next, runtime: { ...runtime, port } });
  await restoring;
  assert.deepEqual(await (await response).json(), { saved: true });
  assert.equal(requests, 1, "a mutation is forwarded once after recovery");
});
