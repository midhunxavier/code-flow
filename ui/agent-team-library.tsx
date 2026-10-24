import { useEffect, useState } from "preact/hooks";
import type { AgentTeamConfiguration, AgentTeamSnapshot } from "../src/project-team-model.js";
import type { AgentId } from "../src/adapters/types.js";
import { agents, loadModels } from "./state.js";
import { ModelRow } from "./composer.js";
import { post } from "./lib.js";

export type TeamProvider = { id: string; name: string; available: boolean; reason?: string };
export function AgentTeamLibrary({ definitions, providers, canAssign, assign, changed }: { definitions: AgentTeamSnapshot[]; providers: TeamProvider[]; canAssign: boolean; assign: (team: AgentTeamSnapshot) => void; changed: () => unknown }) {
  const [editing, setEditing] = useState<AgentTeamSnapshot | "new">();
  return <details class="agent-team-library">
    <summary>Reusable agent teams ({definitions.length})</summary>
    <p class="help">Save a team once and assign it to projects. Each project keeps its own mission, permissions, budget and history.</p>
    <button class="btn small" onClick={() => setEditing("new")}>Create agent team</button>
    {definitions.map((team) => <article class="pt-team" key={team.id}>
      <h3>{team.name} <span class="help">version {team.revision}</span></h3>
      <p class="help">Coordinator: {team.configuration.coordinator} · Workers and reviewer: {team.configuration.pool.join(", ")}</p>
      <div class="pt-actions"><button class="btn small" disabled={!canAssign} onClick={() => assign(team)}>Assign to this project</button><button class="btn small" onClick={() => setEditing(team)}>Edit reusable team</button></div>
    </article>)}
    {editing && <DefinitionForm key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`} definition={editing === "new" ? undefined : editing} providers={providers} saved={() => { setEditing(undefined); void changed(); }} cancel={() => setEditing(undefined)} />}
  </details>;
}

function DefinitionForm({ definition, providers, saved, cancel }: { definition?: AgentTeamSnapshot; providers: TeamProvider[]; saved: () => void; cancel: () => void }) {
  const eligible = providers.filter((p) => p.available && !p.reason);
  const [name, setName] = useState(definition?.name ?? ""), [configuration, setConfiguration] = useState<AgentTeamConfiguration>(definition?.configuration ?? { coordinator: (eligible[0]?.id ?? "claude") as AgentId, pool: eligible.map((p) => p.id as AgentId), agentSettings: {} });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [operationId] = useState(() => crypto.randomUUID());
  useEffect(() => { void loadModels(); }, []);
  const [separateModels, setSeparateModels] = useState(!!configuration.roleSettings);
  const models = agents.value.filter((a) => configuration.pool.includes(a.id) || configuration.coordinator === a.id);
  const submit = async (event: Event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await post(`/api/project-teams/definitions${definition ? `/${definition.id}` : ""}`, { operationId, ...(definition ? { revision: definition.revision } : {}), name, configuration }); saved(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <form class="pt-form" aria-label={definition ? "Edit reusable agent team" : "Create reusable agent team"} onSubmit={submit}>
    <label>Agent team name<input class="field" required maxLength={80} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
    <label>Team coordinator<select class="field" aria-label="Team coordinator" required value={configuration.coordinator} onChange={(e) => setConfiguration({ ...configuration, coordinator: e.currentTarget.value as AgentId, roleSettings: { ...configuration.roleSettings, coordinator: {} } })}>{providers.map((p) => <option key={p.id} value={p.id} disabled={!p.available || !!p.reason}>{p.name}{p.reason ? ` — ${p.reason}` : !p.available ? " — unavailable" : ""}</option>)}</select></label>
    <fieldset><legend>Team workers and reviewer</legend>{providers.map((p) => <label key={p.id}><input type="checkbox" checked={configuration.pool.includes(p.id as AgentId)} disabled={!p.available || !!p.reason} onChange={(e) => {
      const pool = e.currentTarget.checked ? [...configuration.pool, p.id as AgentId] : configuration.pool.filter((id) => id !== p.id);
      setConfiguration({ ...configuration, pool, roleSettings: { ...configuration.roleSettings, pool: Object.fromEntries(Object.entries(configuration.roleSettings?.pool ?? {}).filter(([id]) => pool.includes(id as AgentId))) } });
    }} />{p.name}</label>)}</fieldset>
    <fieldset><legend>Default models and reasoning</legend>{models.map((agent) => <ModelRow key={agent.id} agent={agent} used settings={configuration.agentSettings[agent.id] ?? {}} onChange={(patch) => setConfiguration({ ...configuration, agentSettings: { ...configuration.agentSettings, [agent.id]: { ...configuration.agentSettings[agent.id], ...patch } } })} />)}</fieldset>
    <label><input type="checkbox" checked={separateModels} onChange={(e) => { setSeparateModels(e.currentTarget.checked); if (!e.currentTarget.checked) setConfiguration({ ...configuration, roleSettings: undefined }); }} />Use separate models for coordinator and workers</label>
    {separateModels && ([ ["coordinator", "Coordinator models"], ["pool", "Worker and reviewer models"] ] as const).map(([role, label]) => <fieldset key={role}><legend>{label}</legend>{models.filter((agent) => role === "coordinator" ? agent.id === configuration.coordinator : configuration.pool.includes(agent.id)).map((agent) => <ModelRow key={agent.id} agent={agent} used settings={configuration.roleSettings?.[role]?.[agent.id] ?? {}} onChange={(patch) => setConfiguration({ ...configuration, roleSettings: { ...configuration.roleSettings, [role]: { ...configuration.roleSettings?.[role], [agent.id]: { ...configuration.roleSettings?.[role]?.[agent.id], ...patch } } } })} />)}</fieldset>)}
    {error && <p role="alert">{error}</p>}
    <div class="pt-actions"><button class="btn primary" disabled={busy || !eligible.length || !configuration.pool.length}>{busy ? "Saving…" : definition ? "Save new team version" : "Save reusable team"}</button><button type="button" class="btn" disabled={busy} onClick={cancel}>Cancel team edit</button></div>
  </form>;
}
