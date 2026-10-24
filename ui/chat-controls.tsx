import { ModelSelect } from "./model-select.js";
import { freeModelsFirst } from "./model-order.js";
import { useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { Menu, MenuItem, MenuTitle } from "./panel-bits.js";
import { agents, catalogs, type Trust } from "./state.js";
import type { AgentId, AgentInfo } from "./types.js";

export type ChatSettings = { model?: string; effort?: string };
export type ChatPermissions = { trust: Trust; tools: boolean };

/** Choices belong to the next message; changing them never changes an in-flight turn. */
export function ChatControls({ agent, onAgent, settings, onSettings, permissions, onPermissions, restricted = false, approvalsAvailable = true, providers, showPermissions = true, resetPermissionsOnAgentChange = true }: {
  agent: AgentId; onAgent?: (id: AgentId) => void;
  settings: ChatSettings; onSettings: (settings: ChatSettings) => void;
  permissions: ChatPermissions; onPermissions: (permissions: ChatPermissions) => void;
  restricted?: boolean; approvalsAvailable?: boolean; providers?: AgentInfo[]; showPermissions?: boolean; resetPermissionsOnAgentChange?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const choices = providers ?? agents.value;
  const provider = choices.find((entry) => entry.id === agent);
  const raw = catalogs.value[agent];
  const catalog = raw && !("error" in raw) ? raw : undefined;
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
      {(close) => <><MenuTitle>Provider</MenuTitle>{choices.map((entry) => <MenuItem key={entry.id} on={entry.id === agent} disabled={!entry.available} sub={!entry.available ? "Not installed" : undefined} onClick={() => { onAgent(entry.id); if (permissions.tools && resetPermissionsOnAgentChange) onPermissions({ trust: entry.id.startsWith("acp:") ? "full" : "standard", tools: entry.id === "codex" || entry.id === "claude" || entry.id.startsWith("acp:") }); setCustom(false); close(); }}>{pick(entry.id === agent, entry.displayName)}</MenuItem>)}</>}
    </Menu> : <span class="chat-provider-fixed" title="Provider stays fixed for this conversation. Start a new run to use another provider.">{provider?.displayName ?? agent}</span>}
    <ModelSelect compact label="Model" title={`Model · ${provider?.displayName ?? agent}`} value={settings.model ?? ""} placeholder={modelName}
      options={[
        { id: "", label: "Default model", description: catalog?.defaultModel ?? "Use the provider's default" },
        ...(catalog ? freeModelsFirst(catalog.models) : []),
        ...(catalog?.allowCustom ? [{ id: "__custom", label: "Other model…" }] : []),
      ]}
      onChange={value => { if (value === "__custom") setCustom(true); else { chooseModel(value); setCustom(false); } }} />
    <Menu above label="Effort" icon="sparkle" class="chat-choice" title={`Effort: ${effortName}`} trigger={trigger(effortName)}>
      {(close) => <><MenuTitle>Reasoning effort</MenuTitle>
        <MenuItem on={!settings.effort} sub={model?.defaultEffort ?? catalog?.defaultEffort ?? "Use the provider's default"} onClick={() => { onSettings({ ...settings, effort: "" }); close(); }}>{pick(!settings.effort, "Default effort")}</MenuItem>
        {efforts.map((effort) => <MenuItem key={effort} on={settings.effort === effort} onClick={() => { onSettings({ ...settings, effort }); close(); }}>{pick(settings.effort === effort, effort)}</MenuItem>)}
        {!efforts.length ? <MenuTitle>This model offers no effort choices</MenuTitle> : null}
      </>}
    </Menu>
    {showPermissions ? <PermissionMenu agent={agent} permissions={permissions} onPermissions={onPermissions} restricted={restricted} approvalsAvailable={approvalsAvailable} /> : null}
    {custom ? <input class="field chat-custom-model" aria-label="Custom model" placeholder="Model ID" value={settings.model ?? ""} onInput={(event) => chooseModel(event.currentTarget.value.trim())} /> : null}
  </div>;
}

export function PermissionMenu({ agent = "codex", permissions, onPermissions, restricted = false, approvalsAvailable = true }: {
  agent?: AgentId; permissions: ChatPermissions; onPermissions: (value: ChatPermissions) => void; restricted?: boolean; approvalsAvailable?: boolean;
}) {
  const permissionName = permissions.tools ? "Ask for approval" : ({ safe: "Safe", standard: "Approve for me", trusted: "Trusted", full: "Full access" } as const)[permissions.trust];
  const canAsk = approvalsAvailable && !restricted && (agent === "codex" || agent === "claude" || agent.startsWith("acp:"));
  const pick = (selected: boolean, text: string) => <><span>{text}</span>{selected ? <span class="chat-choice-check" aria-label="Selected">✓</span> : null}</>;
  return (
    <Menu above label="Permissions" icon="sliders" class={`chat-choice chat-permissions ${permissions.trust === "full" && !permissions.tools ? "full-access" : ""}`} trigger={<><Icon name="sliders" /><span>{permissionName}</span><Icon name="chevron" /></>}>
      {(close) => <><MenuTitle>How should actions be approved?</MenuTitle>
        <MenuItem on={permissions.tools} disabled={!canAsk} sub={canAsk ? "Show supported tool requests in the approval inbox." : "Requires a local Claude, Codex or ACP provider with approval support."} onClick={() => { onPermissions({ trust: agent.startsWith("acp:") ? "full" : "standard", tools: true }); close(); }}>{pick(permissions.tools, "Ask for approval")}</MenuItem>
        <MenuItem on={!permissions.tools && permissions.trust === "standard"} disabled={restricted || agent.startsWith("acp:")} sub="Allow routine edits and commands. Restricted actions are blocked." onClick={() => { onPermissions({ trust: "standard", tools: false }); close(); }}>{pick(!permissions.tools && permissions.trust === "standard", "Approve for me")}</MenuItem>
        <MenuItem on={!permissions.tools && permissions.trust === "full"} disabled={restricted} sub="No provider sandbox. Commands, network and files outside the worktree." onClick={() => { onPermissions({ trust: "full", tools: false }); close(); }}>{pick(!permissions.tools && permissions.trust === "full", "Full access")}</MenuItem>
        {restricted ? <MenuTitle>This run's permission restrictions stay in effect.</MenuTitle> : null}
      </>}
    </Menu>
  );
}
