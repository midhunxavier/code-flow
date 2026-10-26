import type { AgentId, ErrorKind, RunOptions, RunResult } from "./types.js";
import { captureOutput, describeFailure, DOCKER_UNREACHABLE, processErrorKind, runJsonlProcess } from "./process.js";

import { redactText } from "../privacy.js";

class ContainerProbeFailure extends Error {
  constructor(message: string, readonly kind: ErrorKind) { super(message); }
}

/** Availability probes do not prove OS isolation, but unknown CLI controls must never be ignored. */
export async function managedPermissionProblem(provider: AgentId, opts: RunOptions): Promise<RunResult | undefined> {
  const p = opts.permissions;
  if (!p) return;
  const fail = (error: string, errorKind: ErrorKind = "cli_incompatible"): RunResult => ({ ok: false, finalText: "", error, errorKind });
  if ((p.nativeDelegation !== false && !opts.conversation) || p.provider !== provider || p.trust !== (opts.trust ?? "standard") || p.mode !== opts.mode || p.toolApprovals !== !!opts.interactiveApprovals) return fail("Adapter options do not match the resolved run permission policy");
  if (p.toolApprovals && (!["codex", "claude"].includes(provider) || !opts.onApproval)) return fail("The required interactive approval handler is unavailable");
  try {
    // Check the actual CLI on every launch. A cached inventory is insufficient after an
    // installation/configuration change. Container probes run in that image, never on the host.
    const probe = async (args: string[]) => {
      if (!opts.agentContainer) return captureOutput(provider, args, 5000);
      let text = "";
      const result = await runJsonlProcess({ command: provider, args, cwd: opts.cwd, signal: opts.signal, timeoutMs: 5000, agentContainer: { config: opts.agentContainer, mode: "read" }, onText: line => { text += line + "\n"; }, onJson: value => { text += JSON.stringify(value) + "\n"; } });
      if (result.exitCode !== 0 || result.aborted || result.timedOut) {
        const kind = processErrorKind(result) ?? "other";
        if (!result.aborted && !result.timedOut && /No such image|Unable to find image/i.test(result.stderr)) throw new ContainerProbeFailure(`Docker image ${opts.agentContainer.image} is not available locally. Agent isolation never pulls images; build or load it first, then resume.`, "other");
        if (!result.aborted && DOCKER_UNREACHABLE.test(result.stderr)) throw new ContainerProbeFailure("Docker is installed but its daemon is unavailable. Start Docker or check access to it, then resume.", "other");
        throw new ContainerProbeFailure(redactText(describeFailure(`Docker ${provider} probe`, result)).slice(-2000), kind);
      }
      if (text.length > 128000) throw new Error("Container CLI help exceeds the probe output limit");
      return text;
    };
    const help = await probe(["--help"]);
    let nested = p.nativeDelegation || provider === "claude" && ["--disallowedTools", "--settings"].every(flag => help.includes(flag));
    if (provider === "codex" && !p.nativeDelegation) {
      const version = (await probe(["--version"])).match(/codex-cli (\d+)\.(\d+)\.(\d+)/);
      if (!version || Number(version[1]) === 0 && (Number(version[2]) < 162 || Number(version[2]) === 162 && Number(version[3]) < 1)) return fail("codex: managed delegation requires CLI 0.162.1 or newer (agents.enabled control)");
      const features = await probe(["features", "list", "-c", "agents.enabled=false", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2.enabled=false"]);
      nested = ["multi_agent", "multi_agent_v2"].every(key => new RegExp(`^${key}\\s+\\S+\\s+false\\s*$`, "m").test(features));
    }
    const external = provider === "claude" && ["--mcp-config", "--strict-mcp-config", "--disallowedTools", "--no-chrome"].every(flag => help.includes(flag));
    if (!nested) return fail(`${provider}: installed CLI cannot confirm native-delegation controls; update it before launching this managed run`);
    if (p.externalTools === "disabled" && !external) return fail(`${provider}: installed CLI cannot confirm external-tool isolation`);
  } catch (error) { return fail(`Could not verify ${provider} permission controls: ${(error as Error).message}`, error instanceof ContainerProbeFailure ? error.kind : "cli_incompatible"); }
}
