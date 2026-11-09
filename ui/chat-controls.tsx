import { modelIdProblem } from "../src/model-id.js";
import type { ComponentChildren } from "preact";
import { providerProblem } from "./provider-readiness.js";
import { runProviderProblem } from "../src/run-permissions.js";
import { ModelSelect } from "./model-select.js";
import { freeModelsFirst } from "./model-order.js";
import { useId, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { Menu, MenuItem, MenuTitle } from "./panel-bits.js";
import { agents, catalogs, health, type Trust } from "./state.js";
import { asksForApproval, permissionLabel } from "./composer-permissions.js";
import type { AgentId, AgentInfo } from "./types.js";

export type ChatSettings = { model?: string; effort?: string };
export type ChatPermissions = { trust: Trust; tools: boolean };

/** Choices belong to the next message; changing them never changes an in-flight turn. */
export function ChatControls({ agent, onAgent, settings, onSettings, permissions, onPermissions, restricted = false, approvalsAvailable = true, approvalsUnavailableReason, providers, showPermissions = true, resetPermissionsOnAgentChange = true, unrestricted = false, acpAllowed = false, onAcpAllowed, labeled = false }: {
  agent: AgentId; onAgent?: (id: AgentId) => void;
  settings: ChatSettings; onSettings: (settings: ChatSettings) => void;
  permissions: ChatPermissions; onPermissions: (permissions: ChatPermissions) => void;
  restricted?: boolean; approvalsAvailable?: boolean; approvalsUnavailableReason?: string; providers?: AgentInfo[]; showPermissions?: boolean; resetPermissionsOnAgentChange?: boolean;
  /** Unrestricted Antigravity (agy-native-v1): the trust choice doesn't sandbox it. */
  unrestricted?: boolean;
  /** The run opted in to unrestricted ACP agents (acp-native-v1), so they can be chosen. */
  acpAllowed?: boolean;
  /** Where the provider menu itself is the place to opt in (the chat page has no Advanced section). */
  onAcpAllowed?: (allowed: boolean) => void;
  labeled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const choices = providers ?? agents.value;
  const acpPolicy = acpAllowed ? { acpExecution: "native" as const } : undefined;
  const provider = choices.find((entry) => entry.id === agent);
  const raw = catalogs.value[agent];
  const catalog = raw && !("error" in raw) ? raw : undefined;
  const listError = raw && "error" in raw ? raw.error : "";
  const showCustom = custom || !!settings.model && (!catalog || !catalog.models.some(item => item.id === settings.model));
  const modelError = modelIdProblem(agent, settings.model), errorId = useId();
  const model = catalog?.models.find((entry) => entry.id === (settings.model || catalog.defaultModel));
  const efforts = model?.efforts ?? catalog?.efforts ?? [];
  const modelName = settings.model ? model?.label ?? settings.model : "Default model";
  const effortName = settings.effort || "Default effort";
  const chooseModel = (value: string) => {
    const next = catalog?.models.find((entry) => entry.id === (value || catalog.defaultModel));
    const allowed = next?.efforts ?? catalog?.efforts ?? [];
    onSettings({ model: value, effort: allowed.includes(settings.effort ?? "") ? settings.effort : "" });
  };
  const pick = (selected: boolean, text: string) => <><span>{text}</span>{selected ? <span class="chat-choice-check" aria-label="Selected">✓</span> : null}</>;
  const trigger = (text: string) => <><span>{text}</span><Icon name="chevron" /></>;
  const field = (name: string, control: ComponentChildren) => labeled ? <div class="chat-setting-row"><span class="chat-setting-label" aria-hidden="true">{name}</span>{control}</div> : control;
  return <div class={`chat-controls${labeled ? " chat-controls-labeled" : ""}`}>
    {field("Provider", onAgent ? <Menu above label="Provider" icon="layers" class="chat-choice" trigger={trigger(provider?.displayName ?? agent)}>
      {(close) => <><MenuTitle>Provider</MenuTitle>{choices.map((entry) => <MenuItem key={entry.id} on={entry.id === agent} disabled={!!providerProblem(entry, providers ? null : health.value, acpPolicy)} sub={providerProblem(entry, providers ? null : health.value, acpPolicy) || undefined} onClick={() => { onAgent(entry.id); if (permissions.tools && resetPermissionsOnAgentChange) onPermissions({ trust: "standard", tools: entry.id === "codex" || entry.id === "claude" }); setCustom(false); close(); }}>{pick(entry.id === agent, entry.displayName)}</MenuItem>)}{onAcpAllowed && choices.some(entry => entry.id.startsWith("acp:")) ? <MenuItem on={acpAllowed} sub="OpenCode, Kilo, Cline and other connected CLIs use their own tools and settings: no Code Flow sandbox or subagent limits. Needs Full access." onClick={() => onAcpAllowed(!acpAllowed)}>{pick(acpAllowed, "Allow unrestricted ACP agents")}</MenuItem> : null}</>}
    </Menu> : <span class="chat-provider-fixed" title="Provider stays fixed for this conversation. Start a new run to use another provider.">{provider?.displayName ?? agent}</span>)}
    {field("Model", <ModelSelect compact label="Model" title={`Model · ${provider?.displayName ?? agent}`} value={showCustom ? "__custom" : settings.model ?? ""} placeholder={modelName} note={listError ? `Couldn't list models: ${listError}` : undefined}
      options={[
        { id: "", label: "Default model", description: listError ? "Models unavailable — use the provider's default" : catalog?.defaultModel ?? "Use the provider's default" },
        ...(catalog ? freeModelsFirst(catalog.models) : []),
        ...(catalog?.allowCustom || listError && ["claude", "codex", "agy"].includes(agent) ? [{ id: "__custom", label: "Other model…" }] : []),
      ]}
      onChange={value => { if (value === "__custom") setCustom(true); else { chooseModel(value); setCustom(false); } }} />)}
    {field("Effort", <Menu above label="Effort" icon="sparkle" class="chat-choice" title={`Effort: ${effortName}`} trigger={trigger(effortName)}>
      {(close) => <><MenuTitle>Reasoning effort</MenuTitle>
        <MenuItem on={!settings.effort} sub={model?.defaultEffort ?? catalog?.defaultEffort ?? "Use the provider's default"} onClick={() => { onSettings({ ...settings, effort: "" }); close(); }}>{pick(!settings.effort, "Default effort")}</MenuItem>
        {efforts.map((effort) => <MenuItem key={effort} on={settings.effort === effort} onClick={() => { onSettings({ ...settings, effort }); close(); }}>{pick(settings.effort === effort, effort)}</MenuItem>)}
        {!efforts.length ? <MenuTitle>{listError ? "Effort choices unavailable — models could not be listed" : "This model offers no effort choices"}</MenuTitle> : null}
      </>}
    </Menu>)}
    {showPermissions ? <PermissionMenu agent={agent} permissions={permissions} onPermissions={onPermissions} restricted={restricted} approvalsAvailable={approvalsAvailable} approvalsUnavailableReason={approvalsUnavailableReason} unrestricted={unrestricted} acpAllowed={acpAllowed} /> : null}
    {showCustom ? <><input class="field chat-custom-model" aria-label="Custom model" aria-invalid={!!modelError} aria-describedby={modelError ? errorId : undefined} placeholder="Model ID" value={settings.model ?? ""} onInput={(event) => chooseModel(event.currentTarget.value)} onBlur={(event) => chooseModel(event.currentTarget.value.trim())} />{modelError ? <span id={errorId} class="help" role="status">{modelError}</span> : null}</> : null}
  </div>;
}

export function PermissionMenu({ agent = "codex", permissions, onPermissions, restricted = false, approvalsAvailable = true, approvalsUnavailableReason, unrestricted = false, acpAllowed = false }: {
  agent?: AgentId; permissions: ChatPermissions; onPermissions: (value: ChatPermissions) => void; restricted?: boolean; approvalsAvailable?: boolean; approvalsUnavailableReason?: string; unrestricted?: boolean; acpAllowed?: boolean;
}) {
  const unavailable = runProviderProblem(agent, agent, acpAllowed ? { acpExecution: "native" } : undefined);
  // An unrestricted ACP agent runs only with Full access; its own permission requests can still be answered.
  const acp = acpAllowed && agent.startsWith("acp:");
  const canAsk = approvalsAvailable && !restricted && (agent === "codex" || agent === "claude" || acp);
  // Each item is one trust level; approvals kept at Safe, Trusted or Full access tick that level and show in the label.
  const asking = asksForApproval(permissions, acp);
  const level = (trust: Trust) => !asking && permissions.trust === trust;
  const pick = (selected: boolean, text: string) => <><span>{text}</span>{selected ? <span class="chat-choice-check" aria-label="Selected">✓</span> : null}</>;
  // Unrestricted Antigravity always runs with full native access, whatever trust level is chosen.
  return (
    <Menu above label="Permissions" icon="sliders" class={`chat-choice chat-permissions ${unrestricted || permissions.trust === "full" && !permissions.tools ? "full-access" : ""}`} title={unrestricted ? "Unrestricted Antigravity: no Code Flow sandbox" : undefined} trigger={<><Icon name="sliders" /><span>{unrestricted ? "Unrestricted" : permissionLabel(permissions, acp)}</span><Icon name="chevron" /></>}>
      {(close) => <><MenuTitle>How should actions be approved?</MenuTitle>{unavailable ? <MenuTitle>{unavailable}</MenuTitle> : null}
        {unrestricted ? <MenuTitle>Unrestricted Antigravity is on: it uses your normal profile and settings without Code Flow's sandbox, whichever level is chosen.</MenuTitle> : null}
        {acp ? <MenuTitle>Unrestricted ACP agent: it needs Full access and uses its own tools and settings. Ask for approval sends the permission requests it makes to the approval inbox.</MenuTitle> : null}
        <MenuItem on={level("safe")} disabled={!!unavailable || acp} sub="Edit files only. Claude can't run commands; Codex stays sandboxed." onClick={() => { onPermissions({ trust: "safe", tools: false }); close(); }}>{pick(level("safe"), "Safe")}</MenuItem>
        <MenuItem on={asking} disabled={!!unavailable || !canAsk && !asking} sub={canAsk ? "Show supported tool requests in the approval inbox." : approvalsUnavailableReason ?? "Requires a local Claude or Codex provider with approval support."} onClick={() => { onPermissions({ trust: acp ? "full" : "standard", tools: true }); close(); }}>{pick(asking, "Ask for approval")}</MenuItem>
        <MenuItem on={level("standard")} disabled={restricted || !!unavailable || acp} sub="Allow routine edits and commands. Restricted actions are blocked." onClick={() => { onPermissions({ trust: "standard", tools: false }); close(); }}>{pick(level("standard"), "Approve for me")}</MenuItem>
        <MenuItem on={level("trusted")} disabled={restricted || !!unavailable || acp} sub="Any command for Claude; network inside Codex's sandbox. For repositories you trust." onClick={() => { onPermissions({ trust: "trusted", tools: false }); close(); }}>{pick(level("trusted"), "Trusted")}</MenuItem>
        <MenuItem on={level("full")} disabled={restricted || !!unavailable} sub="No provider sandbox. Commands, network and files outside the worktree." onClick={() => { onPermissions({ trust: "full", tools: false }); close(); }}>{pick(level("full"), "Full access")}</MenuItem>
        {restricted ? <MenuTitle>This run's permission restrictions stay in effect.</MenuTitle> : null}
      </>}
    </Menu>
  );
}
