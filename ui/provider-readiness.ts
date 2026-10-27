import type { AgentInfo } from "./types.js";
import type { Health } from "./state.js";
import { runProviderProblem } from "../src/run-permissions.js";
export const POLICY_PAUSED = "Paused by filesystem policy";

export function providerProblem(entry: AgentInfo, diagnostics: readonly Health[] | null = null): string {
  if (!entry.available) return entry.unavailableReason === "filesystem-policy" ? POLICY_PAUSED : "Not installed";
  const unsupported = runProviderProblem(entry.id, entry.displayName);
  if (unsupported) return unsupported;
  const health = diagnostics?.find(item => item.id === entry.id);
  if (health?.signedIn === false) return "Signed out — sign in from Settings → Agents & models";
  if (health?.compatible === false) return "Update CLI — open Settings → Agents & models";
  return "";
}

export function providerSetupProblem(entries: readonly AgentInfo[], diagnostics: readonly Health[] | null): string {
  if (entries.some(entry => !providerProblem(entry, diagnostics))) return "";
  const signedOut = diagnostics?.find(item => item.installed && item.signedIn === false);
  if (signedOut) return `${signedOut.name} isn't signed in — open Settings → Agents & models`;
  const installed = entries.find(entry => entry.available);
  return installed ? `${installed.displayName}: ${providerProblem(installed, diagnostics)}` : "Connect a provider first — open Settings → Agents & models";
}
