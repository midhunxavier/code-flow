import type { AccessMode, AgentId } from "./adapters/types.js";
import type { Trust } from "./repo-config.js";

/** Authority belongs to the run. Provider settings and templates are never authority. */
export interface RunPermissionPolicy {
  version: 1;
  revision: number;
  trust: Trust;
  toolApprovals: boolean;
  delegation: "managed" | "none";
  required: PermissionRequirement[];
  antigravityExecution?: AntigravityExecution;
}
export type AntigravityExecution = "isolated" | "native";
export function antigravityExecution(value: unknown, parent?: RunPermissionPolicy): AntigravityExecution | undefined {
  if (value !== undefined && value !== "isolated" && value !== "native") throw new Error("Invalid Antigravity execution mode");
  if (parent && value === "native" && parent.antigravityExecution !== "native") throw new Error("A child run cannot enable unrestricted Antigravity permissions");
  return (value as AntigravityExecution | undefined) ?? parent?.antigravityExecution;
}
export const AGY_NATIVE_LIMITATION = "Unrestricted Antigravity uses your existing login and normal provider configuration. Terminal, browser, MCP, hooks and native agents are not restricted by Code Flow. Read-only requests are advisory; native child usage is outside Code Flow's worker budget. A valid saved login is required.";
export type PermissionRequirement = "workspace-writes" | "no-command-network" | "no-external-tools";
export interface EffectivePermissions {
  policyRevision: number;
  required: PermissionRequirement[];
  delegation: RunPermissionPolicy["delegation"];
  provider: AgentId;
  trust: Trust;
  mode: AccessMode;
  toolApprovals: boolean;
  nativeDelegation: boolean;
  isolation: "container" | "provider-sandbox" | "os-sandbox" | "tool-rules" | "none";
  implementation?: string;
  commandNetwork: "denied" | "allowed" | "provider-configured";
  externalTools: "disabled" | "provider-configured" | "task-scoped";
  limitations: string[];
}
const levels: Trust[] = ["safe", "standard", "trusted", "full"];
export function narrowerTrust(run: Trust, turn?: Trust): Trust {
  if (!levels.includes(run) || turn !== undefined && !levels.includes(turn)) throw new Error("Unknown turn permissions");
  return levels[Math.min(levels.indexOf(run), levels.indexOf(turn ?? run))]!;
}
export function permissionRequirements(value: unknown): PermissionRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3 || value.some(v => !["workspace-writes", "no-command-network", "no-external-tools"].includes(v))) throw new Error("Unknown required permission enforcement");
  return [...new Set(value)] as PermissionRequirement[];
}
/** Persisted authority is untrusted input on recovery and remote receipt replay. */
export function validateRunPermissions(value: unknown): RunPermissionPolicy {
  const p = value as RunPermissionPolicy;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(k => !["version", "revision", "trust", "toolApprovals", "delegation", "required", "antigravityExecution"].includes(k)) || p.version !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 1 || !levels.includes(p.trust) || typeof p.toolApprovals !== "boolean" || !["managed", "none"].includes(p.delegation) || !Array.isArray(p.required)) throw new Error("Invalid run permission policy");
  antigravityExecution(p.antigravityExecution);
  return { ...p, required: permissionRequirements(p.required) };
}
export function createRunPermissions(trust: Trust, tools: boolean, solo: boolean, required?: unknown, execution?: AntigravityExecution): RunPermissionPolicy {
  return validateRunPermissions({ version: 1, revision: 1, trust, toolApprovals: tools, delegation: solo ? "none" : "managed", required: permissionRequirements(required), ...(execution !== undefined ? { antigravityExecution: antigravityExecution(execution) } : {}) });
}
export const supportsRunPermissions = (provider: string): boolean => provider === "claude" || provider === "codex" || provider === "agy";
/** Connections may be inspected before their adapter can enforce a run's policy. */
export function runProviderProblem(provider: string, displayName = provider): string | undefined {
  if (!supportsRunPermissions(provider)) return `${displayName} is unavailable for runs: this adapter cannot enforce Code Flow's native-delegation restriction. Choose Claude Code, Codex or Antigravity.`;
}
/** A sandbox flag or a custom-agent tool list alone is not an inherited run policy. */
export const AGY_MANAGED_PERMISSION_PROBLEM = "Antigravity managed execution requires the verified local macOS executor and existing Keychain login. Remote/container execution and interactive approvals are unsupported. Choose Claude or Codex for other environments.";
/** The common case on a working Mac: the run's "Ask for approval", not the executor, is what Antigravity can't do. */
export const AGY_APPROVALS_PROBLEM = "Antigravity can't take interactive approvals. Turn off Ask for approval for this run, or choose Claude or Codex instead of Antigravity.";
export function permissionProviderProblem(provider: AgentId, policy?: RunPermissionPolicy, displayName: string = provider): string | undefined {
  if (policy && provider === "agy" && policy.antigravityExecution !== "native" && (typeof process === "undefined" || process.platform !== "darwin")) return AGY_MANAGED_PERMISSION_PROBLEM;
  if (policy) return runProviderProblem(provider, displayName);
}
export function resolveRunPermissions(input: {
  policy: RunPermissionPolicy; provider: AgentId; mode: AccessMode; currentTrust: Trust;
  turnTrust?: Trust; tools?: boolean; currentTools: boolean; container?: boolean; remote?: boolean; unattended?: boolean;
}): EffectivePermissions {
  const { provider, mode } = input;
  const policy = validateRunPermissions(input.policy);
  if (!["read", "write"].includes(mode)) throw new Error("Invalid turn access mode");
  const problem = permissionProviderProblem(provider, policy);
  if (problem) throw new Error(problem);
  const trust = narrowerTrust(narrowerTrust(policy.trust, input.currentTrust), input.turnTrust);
  if (provider === "agy" && policy.antigravityExecution === "native") {
    if (input.remote || input.container || input.unattended || policy.toolApprovals || policy.required.length || trust === "safe" || trust !== policy.trust) throw new Error("Unrestricted Antigravity requires a local attended run without mandatory boundaries, Safe mode, narrowed trust or interactive approvals");
    return { required: [], delegation: policy.delegation, policyRevision: policy.revision,
      provider, trust: "full", mode, nativeDelegation: true, toolApprovals: false,
      isolation: "none", implementation: "agy-native-v1", commandNetwork: "allowed", externalTools: "provider-configured",
      limitations: [AGY_NATIVE_LIMITATION, "Each managed turn starts fresh using portable context; native sessions are not resumed."] };
  }
  if (provider === "agy") {
    if (input.remote || input.container) throw new Error(AGY_MANAGED_PERMISSION_PROBLEM);
    if (policy.toolApprovals && input.currentTools && input.tools !== false && mode === "write") throw new Error(AGY_APPROVALS_PROBLEM);
    const shared = !policy.required.includes("no-external-tools");
    return {
      required: [...policy.required], delegation: policy.delegation, policyRevision: policy.revision,
      provider, trust, mode, nativeDelegation: false, toolApprovals: false,
      isolation: "os-sandbox", implementation: shared ? "macos-task-tools-v2" : "macos-file-only-v1", commandNetwork: "denied", externalTools: shared ? "task-scoped" : "disabled",
      limitations: [shared ? "Workspace file tools and Code Flow's task-scoped browser/computer bridge are available. Native browser, arbitrary MCP servers, terminal, hooks and native delegation are disabled. Computer actions require Full access." : "Antigravity has file tools only; terminal, browser, MCP, hooks and native delegation are disabled.", "The official CLI uses the existing macOS Keychain login; inference networking remains enabled.", "System runtime files and the native security helper remain accessible; model file tools are denied authentication and runtime state.", "Code Flow runs setup and checks in their separately configured command environment.", "Every turn starts with a fresh provider profile and portable context; native sessions are not resumed."],
    };
  }
  const externalTools = policy.required.includes("no-external-tools") ? "disabled" : "provider-configured";
  if (externalTools === "disabled" && provider !== "claude") throw new Error(`${provider} has no verified external-tool isolation in this adapter`);
  const isolation = input.container ? "container" : trust === "full" && mode === "write" ? "none" : provider === "codex" ? "provider-sandbox" : "tool-rules";
  const commandNetwork = provider === "codex" && (mode === "read" || trust === "safe" || trust === "standard") ? "denied" : trust === "full" || trust === "trusted" ? "allowed" : "provider-configured";
  if (policy.required.includes("workspace-writes") && (isolation === "none" || isolation === "tool-rules" || input.remote || input.container)) throw new Error(`${provider} cannot enforce the required workspace write boundary in this environment`);
  if (policy.required.includes("no-command-network") && (commandNetwork !== "denied" || input.remote || input.container)) throw new Error(`${provider} cannot enforce the required command network restriction in this environment`);
  const wantsApprovals = policy.toolApprovals && input.currentTools && input.tools !== false && mode === "write";
  if (wantsApprovals && policy.required.some(r => r === "workspace-writes" || r === "no-command-network")) throw new Error("Interactive command approvals cannot be combined with mandatory sandbox boundaries");
  if (wantsApprovals && (!["codex", "claude"].includes(provider) || input.remote || input.container || input.unattended)) throw new Error(`${provider} cannot provide the run's required interactive approvals in this environment`);
  return {
    required: [...policy.required], delegation: policy.delegation,
    policyRevision: policy.revision, provider, trust, mode, nativeDelegation: false,
    toolApprovals: policy.toolApprovals && input.currentTools && input.tools !== false && !input.container && !input.remote && !input.unattended && mode === "write",
    isolation, commandNetwork, externalTools,
    limitations: ["Worktrees do not restrict file reads.", "Setup and check commands use the run’s separately configured command environment.", ...(isolation === "tool-rules" ? ["CLI tool rules are not an operating-system filesystem sandbox."] : []), ...(externalTools === "provider-configured" ? ["Browser and external MCP permissions follow the provider configuration; terminal network policy does not restrict them."] : [])],
  };
}
