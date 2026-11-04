import { useEffect } from "preact/hooks";
import { agents, catalogs } from "./state.js";
import { improveSettings, setImproveSettings } from "./improve-settings.js";
import { defaultImproveChoice, improveEfforts, IMPROVE_AGENTS, IMPROVE_NAMES, type ImproveAgent, type ImproveChoice } from "../src/improve-settings.js";

export function PromptImprovementSettings() {
  const settings = improveSettings.value;
  const save = (agent: ImproveAgent, change: ImproveChoice = {}) => {
    const previous = settings.providers[agent]?.[settings.defaultMode] ?? {};
    const defaults = defaultImproveChoice(agent, settings.defaultMode);
    const choice = { model: previous.model ?? defaults.model ?? "", effort: previous.effort ?? defaults.effort ?? "", ...change };
    setImproveSettings({ ...settings, agent, providers: { ...settings.providers, [agent]: { quick: choice, repo: choice } } });
  };
  // Migrate the old automatic/mode-specific preferences to one explicit choice.
  useEffect(() => {
    if (settings.agent === "auto" && agents.value.length) {
      const agent = IMPROVE_AGENTS.find(id => agents.value.some(entry => entry.id === id && entry.available)) ?? "claude";
      save(agent);
    } else if (settings.agent !== "auto") {
      const provider = settings.providers[settings.agent];
      if (!provider?.quick || !provider.repo || JSON.stringify(provider.quick) !== JSON.stringify(provider.repo) || provider.quick.model === undefined || provider.quick.effort === undefined) save(settings.agent);
    }
  }, [settings, agents.value]);
  const agent = settings.agent === "auto" ? IMPROVE_AGENTS.find(id => agents.value.some(entry => entry.id === id && entry.available)) ?? "claude" : settings.agent;
  const catalogValue = catalogs.value[agent], catalog = catalogValue && !("error" in catalogValue) ? catalogValue : undefined;
  const choice = settings.providers[agent]?.[settings.defaultMode] ?? {};
  const defaults = defaultImproveChoice(agent, settings.defaultMode);
  const model = choice.model ?? defaults.model ?? "";
  const effort = choice.effort ?? defaults.effort ?? "";
  const efforts = improveEfforts(agent, model, catalog);
  return <section class="settings-card improve-settings-compact" aria-label="Prompt improvement">
    <div class="improve-settings-heading"><h3>Prompt improvement</h3><div class="segmented small" role="group" aria-label="Default improvement mode">{(["quick", "repo"] as const).map(mode => <button type="button" key={mode} class={settings.defaultMode === mode ? "on" : ""} aria-pressed={settings.defaultMode === mode} onClick={() => setImproveSettings({ ...settings, defaultMode: mode })}>{mode === "quick" ? "Quick" : "Repo"}</button>)}</div></div>
    <div class="improve-settings-fields"><label>Provider<select class="field" aria-label="Prompt improvement provider" value={agent} onChange={event => save(event.currentTarget.value as ImproveAgent)}>{IMPROVE_AGENTS.map(id => <option value={id} key={id}>{IMPROVE_NAMES[id]}</option>)}</select></label>
    <label>Model{catalog?.allowCustom === false ? <select class="field" aria-label="Prompt improvement model" value={model} onChange={event => save(agent, { model: event.currentTarget.value, effort: "" })}><option value="">CLI default</option>{catalog.models.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select> : <><input class="field" aria-label="Prompt improvement model" list={`improve-${agent}-models`} placeholder="CLI default" value={model} maxLength={200} onInput={event => save(agent, { model: event.currentTarget.value, effort: "" })} /><datalist id={`improve-${agent}-models`}>{catalog?.models.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</datalist></>}</label>
    <label>Effort<select class="field" aria-label="Prompt improvement effort" value={effort} disabled={!efforts.length} onChange={event => save(agent, { effort: event.currentTarget.value })}><option value="">{efforts.length ? "CLI default" : "No effort choices"}</option>{effort && !efforts.includes(effort) ? <option value={effort}>{effort}{catalog ? " · unavailable for this model" : " · loading choices"}</option> : null}{efforts.map(value => <option value={value} key={value}>{value}</option>)}</select></label></div>
    <p class="help">{settings.defaultMode === "quick" ? "Quick improves your text only." : "Repo also reads committed files; local edits are excluded."}</p>
  </section>;
}
