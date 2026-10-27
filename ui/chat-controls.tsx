import { modelIdProblem } from "../src/model-id.js";
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
export function ChatControls({ agent, onAgent, settings, onSettings, permissions, onPermissions, restricted = false, approvalsAvailable = true, approvalsUnavailableReason, providers, showPermissions = true, resetPermissionsOnAgentChange = true, unrestricted = false }: {
  agent: AgentId; onAgent?: (id: AgentId) => void;
  settings: ChatSettings; onSettings: (settings: ChatSettings) => void;
  permissions: ChatPermissions; onPermissions: (permissions: ChatPermissions) => void;
  restricted?: boolean; approvalsAvailable?: boolean; approvalsUnavailableReason?: string; providers?: AgentInfo[]; showPermissions?: boolean; resetPermissionsOnAgentChange?: boolean;
  /** Unrestricted Antigravity (agy-native-v1): the trust choice doesn't sandbox it. */
  unrestricted?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const choices = providers ?? agents.value;
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
  return <div class="chat-controls">
    {onAgent ? <Menu above label="Provider" icon="layers" class="chat-choice" trigger={trigger(provider?.displayName ?? agent)}>
      {(close) => <><MenuTitle>Provider</MenuTitle>{choices.map((entry) => <MenuItem key={entry.id} on={entry.id === agent} disabled={!!providerProblem(entry, providers ? null : health.value)} sub={providerProblem(entry, providers ? null : health.value) || undefined} onClick={() => { onAgent(entry.id); if (permissions.tools && resetPermissionsOnAgentChange) onPermissions({ trust: "standard", tools: entry.id === "codex" || entry.id === "claude" }); setCustom(false); close(); }}>{pick(entry.id === agent, entry.displayName)}</MenuItem>)}</>}
    </Menu> : <span class="chat-provider-fixed" title="Provider stays fixed for this conversation. Start a new run to use another provider.">{provider?.displayName ?? agent}</span>}
    <ModelSelect compact label="Model" title={`Model · ${provider?.displayName ?? agent}`} value={showCustom ? "__custom" : settings.model ?? ""} placeholder={modelName} note={listError ? `Couldn't list models: ${listError}` : undefined}
      options={[
        { id: "", label: "Default model", description: listError ? "Models unavailable — use the provider's default" : catalog?.defaultModel ?? "Use the provider's default" },
        ...(catalog ? freeModelsFirst(catalog.models) : []),
        ...(catalog?.allowCustom || listError && ["claude", "codex", "agy"].includes(agent) ? [{ id: "__custom", label: "Other model…" }] : []),
      ]}
      onChange={value => { if (value === "__custom") setCustom(true); else { chooseModel(value); setCustom(false); } }} />
    <Menu above label="Effort" icon="sparkle" class="chat-choice" title={`Effort: ${effortName}`} trigger={trigger(effortName)}>
      {(close) => <><MenuTitle>Reasoning effort</MenuTitle>
        <MenuItem on={!settings.effort} sub={model?.defaultEffort ?? catalog?.defaultEffort ?? "Use the provider's default"} onClick={() => { onSettings({ ...settings, effort: "" }); close(); }}>{pick(!settings.effort, "Default effort")}</MenuItem>
        {efforts.map((effort) => <MenuItem key={effort} on={settings.effort === effort} onClick={() => { onSettings({ ...settings, effort }); close(); }}>{pick(settings.effort === effort, effort)}</MenuItem>)}
        {!efforts.length ? <MenuTitle>{listError ? "Effort choices unavailable — models could not be listed" : "This model offers no effort choices"}</MenuTitle> : null}
      </>}
    </Menu>
    {showPermissions ? <PermissionMenu agent={agent} permissions={permissions} onPermissions={onPermissions} restricted={restricted} approvalsAvailable={approvalsAvailable} approvalsUnavailableReason={approvalsUnavailableReason} unrestricted={unrestricted} /> : null}
    {showCustom ? <><input class="field chat-custom-model" aria-label="Custom model" aria-invalid={!!modelError} aria-describedby={modelError ? errorId : undefined} placeholder="Model ID" value={settings.model ?? ""} onInput={(event) => chooseModel(event.currentTarget.value)} onBlur={(event) => chooseModel(event.currentTarget.value.trim())} />{modelError ? <span id={errorId} class="help" role="status">{modelError}</span> : null}</> : null}
  </div>;
}

export function PermissionMenu({ agent = "codex", permissions, onPermissions, restricted = false, approvalsAvailable = true, approvalsUnavailableReason, unrestricted = false }: {
  agent?: AgentId; permissions: ChatPermissions; onPermissions: (value: ChatPermissions) => void; restricted?: boolean; approvalsAvailable?: boolean; approvalsUnavailableReason?: string; unrestricted?: boolean;
}) {
  const unavailable = runProviderProblem(agent);
  const canAsk = approvalsAvailable && !restricted && (agent === "codex" || agent === "claude");
  // Each item is one trust level; approvals kept at Safe, Trusted or Full access tick that level and show in the label.
  const asking = asksForApproval(permissions);
  const level = (trust: Trust) => !asking && permissions.trust === trust;
  const pick = (selected: boolean, text: string) => <><span>{text}</span>{selected ? <span class="chat-choice-check" aria-label="Selected">✓</span> : null}</>;
  // Unrestricted Antigravity always runs with full native access, whatever trust level is chosen.
  return (
    <Menu above label="Permissions" icon="sliders" class={`chat-choice chat-permissions ${unrestricted || permissions.trust === "full" && !permissions.tools ? "full-access" : ""}`} title={unrestricted ? "Unrestricted Antigravity: no Code Flow sandbox" : undefined} trigger={<><Icon name="sliders" /><span>{unrestricted ? "Unrestricted" : permissionLabel(permissions)}</span><Icon name="chevron" /></>}>
      {(close) => <><MenuTitle>How should actions be approved?</MenuTitle>{unavailable ? <MenuTitle>{unavailable}</MenuTitle> : null}
        {unrestricted ? <MenuTitle>Unrestricted Antigravity is on: it uses your normal profile and settings without Code Flow's sandbox, whichever level is chosen.</MenuTitle> : null}
        <MenuItem on={level("safe")} disabled={!!unavailable} sub="Edit files only. Claude can't run commands; Codex stays sandboxed." onClick={() => { onPermissions({ trust: "safe", tools: false }); close(); }}>{pick(level("safe"), "Safe")}</MenuItem>
        <MenuItem on={asking} disabled={!!unavailable || !canAsk && !asking} sub={canAsk ? "Show supported tool requests in the approval inbox." : approvalsUnavailableReason ?? "Requires a local Claude or Codex provider with approval support."} onClick={() => { onPermissions({ trust: "standard", tools: true }); close(); }}>{pick(asking, "Ask for approval")}</MenuItem>
        <MenuItem on={level("standard")} disabled={restricted || !!unavailable} sub="Allow routine edits and commands. Restricted actions are blocked." onClick={() => { onPermissions({ trust: "standard", tools: false }); close(); }}>{pick(level("standard"), "Approve for me")}</MenuItem>
        <MenuItem on={level("trusted")} disabled={restricted || !!unavailable} sub="Any command for Claude; network inside Codex's sandbox. For repositories you trust." onClick={() => { onPermissions({ trust: "trusted", tools: false }); close(); }}>{pick(level("trusted"), "Trusted")}</MenuItem>
        <MenuItem on={level("full")} disabled={restricted || !!unavailable} sub="No provider sandbox. Commands, network and files outside the worktree." onClick={() => { onPermissions({ trust: "full", tools: false }); close(); }}>{pick(level("full"), "Full access")}</MenuItem>
        {restricted ? <MenuTitle>This run's permission restrictions stay in effect.</MenuTitle> : null}
      </>}
    </Menu>
  );
}
