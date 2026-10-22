import { test } from "node:test";
import assert from "node:assert/strict";
import { antigravityExecution, createRunPermissions, validateRunPermissions, narrowerTrust, resolveRunPermissions } from "../src/run-permissions.js";

test("workers inherit run authority, while turn overrides can only narrow it", () => {
  const policy = createRunPermissions("standard", false, false);
  for (const provider of ["claude", "codex"] as const) {
    const worker = resolveRunPermissions({ policy, provider, mode: "write", currentTrust: "standard", currentTools: false, turnTrust: "full", tools: true });
    assert.equal(worker.trust, "standard"); assert.equal(worker.toolApprovals, false); assert.equal(worker.nativeDelegation, false);
    const planner = resolveRunPermissions({ policy, provider, mode: "read", currentTrust: "standard", currentTools: true });
    assert.equal(planner.mode, "read"); assert.equal(worker.mode, "write", "planner's turn mode does not change worker authority");
    assert.equal(resolveRunPermissions({ policy, provider, mode: "write", currentTrust: "safe", currentTools: false }).trust, "safe", "revocations narrow resumed turns");
  }
  assert.equal(narrowerTrust("full", "safe"), "safe");
});
test("provider replacement cannot weaken mandatory enforcement", () => {
  const policy = createRunPermissions("standard", false, false, ["workspace-writes", "no-command-network"]);
  assert.equal(resolveRunPermissions({ policy, provider: "codex", mode: "write", currentTrust: "standard", currentTools: false }).commandNetwork, "denied");
  assert.throws(() => resolveRunPermissions({ policy, provider: "claude", mode: "write", currentTrust: "standard", currentTools: false }), /workspace write boundary/);
  if (process.platform === "darwin") assert.equal(resolveRunPermissions({ policy, provider: "agy", mode: "write", currentTrust: "standard", currentTools: false }).isolation, "os-sandbox");
  else assert.throws(() => resolveRunPermissions({ policy, provider: "agy", mode: "write", currentTrust: "standard", currentTools: false }), /macOS/);
});

test("Antigravity remains file-only at every trust level and rejects unsupported environments", () => {
  for (const trust of ["safe", "standard", "trusted", "full"] as const) {
    for (const solo of [false, true]) for (const mode of ["read", "write"] as const) {
      for (const environment of [{}, { container: true }, { remote: true }]) {
        const resolve = () => resolveRunPermissions({ policy: createRunPermissions(trust, false, solo, ["workspace-writes", "no-command-network", "no-external-tools"]), provider: "agy", mode, currentTrust: trust, currentTools: false, ...environment });
        if (process.platform !== "darwin" || "remote" in environment || "container" in environment) assert.throws(resolve, /macOS/);
        else {
          const p = resolve();
          assert.equal(p.trust, trust); assert.equal(p.mode, mode); assert.equal(p.nativeDelegation, false);
          assert.equal(p.externalTools, "disabled"); assert.equal(p.commandNetwork, "denied"); assert.equal(p.isolation, "os-sandbox");
          assert.equal(p.implementation, "macos-file-only-v1");
        }
      }
    }
  }
  assert.throws(() => resolveRunPermissions({ policy: createRunPermissions("standard", true, false), provider: "agy", mode: "write", currentTrust: "standard", currentTools: true }), /interactive approvals/);
});
test("Solo and unattended launches cannot obtain extra approval or delegation authority", () => {
  const policy = createRunPermissions("trusted", true, true);
  assert.equal(policy.delegation, "none");
  assert.throws(() => resolveRunPermissions({ policy, provider: "claude", mode: "write", currentTrust: "trusted", currentTools: true, unattended: true }), /interactive approvals/);
  const result = resolveRunPermissions({ policy: createRunPermissions("trusted", false, true), provider: "claude", mode: "write", currentTrust: "trusted", currentTools: false, unattended: true });
  assert.equal(result.nativeDelegation, false);
});

test("malformed recorded policies are rejected instead of relaxing their restrictions", () => {
  const policy = createRunPermissions("standard", false, false);
  for (const patch of [{ trust: "invalid" }, { toolApprovals: "false" }, { required: undefined }, { delegation: "native" }, { version: 2 }, { required: ["unknown"] }, { extraGrant: true }]) assert.throws(() => validateRunPermissions({ ...policy, ...patch }));
  assert.throws(() => createRunPermissions("invalid" as any, false, false));
  assert.equal(resolveRunPermissions({ policy: createRunPermissions("standard", true, false), provider: "claude", mode: "write", currentTrust: "standard", currentTools: true }).toolApprovals, true, "Claude now supports scoped interactive approvals");
});

test("child environment inheritance cannot drop isolation, change workers or enable container networking", async () => {
  const { inheritRunEnvironment } = await import("../src/run-environment.js");
  const parent = { permissions: createRunPermissions("standard", false, false), loop: { agentContainer: { image: "fixture", network: false }, container: { image: "checks", network: false }, remoteWorker: { workerId: "fixture", repoMapping: "repo" } } } as any;
  const inherited = inheritRunEnvironment({ maxSteps: 10 }, parent) as any;
  assert.deepEqual(inherited.agentContainer, parent.loop.agentContainer);
  assert.deepEqual(inherited.remoteWorker, parent.loop.remoteWorker);
  assert.notEqual(inherited.agentContainer, parent.loop.agentContainer);
  assert.equal(inherited.maxSteps, 10);
  for (const request of [{ agentContainer: null }, { agentContainer: { image: "fixture", network: true } }, { remoteWorker: { workerId: "other", repoMapping: "repo" } }, { container: { image: "checks", network: true } }]) assert.throws(() => inheritRunEnvironment(request, parent), /execution boundary/);
});

test("mandatory sandbox requirements cannot be bypassed by one-shot command approvals", () => {
  const policy = createRunPermissions("standard", true, false, ["workspace-writes", "no-command-network"]);
  assert.throws(() => resolveRunPermissions({ policy, provider: "codex", mode: "write", currentTrust: "standard", currentTools: true }), /mandatory sandbox boundaries/);
});


test("native Antigravity requires explicit run authority and leaves other providers unchanged", () => {
  const baseline = createRunPermissions("standard", false, false);
  const policy = createRunPermissions("standard", false, false, [], "native");
  const input = { policy, provider: "agy" as const, mode: "write" as const, currentTrust: "standard" as const, currentTools: false };
  const receipt = resolveRunPermissions(input);
  assert.equal(receipt.isolation, "none"); assert.equal(receipt.trust, "full"); assert.equal(receipt.nativeDelegation, true);
  assert.equal(receipt.externalTools, "provider-configured");
  for (const provider of ["claude", "codex"] as const) assert.deepEqual(resolveRunPermissions({ ...input, provider }), resolveRunPermissions({ ...input, provider, policy: baseline }));
  for (const patch of [{ remote: true }, { container: true }, { unattended: true }, { currentTrust: "safe" as const }, { turnTrust: "safe" as const }, { policy: { ...policy, required: ["no-external-tools" as const] } }, { policy: { ...policy, toolApprovals: true } }]) assert.throws(() => resolveRunPermissions({ ...input, ...patch }), /Unrestricted Antigravity/);
  assert.equal(validateRunPermissions(JSON.parse(JSON.stringify(policy))).antigravityExecution, "native");
  assert.equal(validateRunPermissions(baseline).antigravityExecution, undefined);
  assert.throws(() => antigravityExecution("native", baseline), /child run/);
  assert.equal(antigravityExecution(undefined, policy), "native");
  assert.equal(antigravityExecution("isolated", policy), "isolated");
  assert.throws(() => antigravityExecution(true));
  assert.throws(() => validateRunPermissions({ ...policy, antigravityExecution: "automatic" }));
});
