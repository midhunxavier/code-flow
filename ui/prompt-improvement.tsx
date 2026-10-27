import { agents, catalogs } from "./state.js";
import { POLICY_PAUSED } from "./policy-pause.js";
import { improveSettings, setImproveSettings } from "./improve-settings.js";
import { defaultImproveChoice, improveEfforts, IMPROVE_AGENTS, IMPROVE_NAMES, type ImproveAgent, type ImproveChoice, type ImproveMode } from "../src/improve-settings.js";

export function PromptImprovementSettings() {
  const settings = improveSettings.value;
  const save = (agent: ImproveAgent, mode: ImproveMode, change: ImproveChoice) => {
    const providers = settings.providers;
    setImproveSettings({ ...settings, providers: { ...providers, [agent]: { ...providers[agent], [mode]: { ...providers[agent]?.[mode], ...change } } } });
  };
  return <section class="settings-card" aria-label="Prompt improvement"><h3>Prompt improvement</h3>
    <p class="help">Improve rewrites your task before you run it. It preserves your intent, clarifies the goal and completion criteria, and flags unclear details. Undo restores your original text.</p>
    <div class="settings-row"><div><strong>Agent</strong><p>Independent of your main task’s agents. Uses your local CLI account and subscription.</p></div><div class="settings-row-control"><select class="field" aria-label="Prompt improvement agent" value={settings.agent} onChange={event => setImproveSettings({ ...settings, agent: event.currentTarget.value as typeof settings.agent })}>{(["auto", ...IMPROVE_AGENTS] as const).map(agent => <option value={agent}>{IMPROVE_NAMES[agent]}</option>)}</select></div></div>
    <p class="help">{settings.agent === "auto" ? "Auto prefers Claude Code, then Codex, then Antigravity, using installation and quota availability. Configure each provider’s models below." : `${IMPROVE_NAMES[settings.agent]} will perform every rewrite. If it is unavailable, Improve shows an error without switching agents.`}</p>
    <div class="settings-row"><div><strong>Default mode</strong><p>Quick uses your text only. Repo also reads a private snapshot of committed files; uncommitted changes are excluded.</p></div><div class="settings-row-control"><select class="field" aria-label="Default improvement mode" value={settings.defaultMode} onChange={event => setImproveSettings({ ...settings, defaultMode: event.currentTarget.value as ImproveMode })}><option value="quick">Quick</option><option value="repo">Repo</option></select></div></div>
    {(settings.agent === "auto" ? IMPROVE_AGENTS : [settings.agent]).map(agent => {
      const value = catalogs.value[agent], catalog = value && !("error" in value) ? value : undefined;
      const entry = agents.value.find(item => item.id === agent), installed = entry?.available;
      return <fieldset class="improve-provider" key={agent}><legend>{IMPROVE_NAMES[agent]}{installed === false ? entry?.unavailableReason === "filesystem-policy" ? ` · ${POLICY_PAUSED}` : " · Not installed" : ""}</legend>
        {(["quick", "repo"] as const).map(mode => {
          const choice = settings.providers[agent]?.[mode] ?? {}, defaults = defaultImproveChoice(agent, mode);
          const model = choice.model ?? defaults.model ?? "";
          const efforts = improveEfforts(agent, model, catalog);
          const label = `${mode === "quick" ? "Quick" : "Repo"} model · ${IMPROVE_NAMES[agent]}`;
          return <div class="improve-model-row" key={mode}>
            <label>{mode === "quick" ? "Quick model" : "Repo model"}{catalog?.allowCustom === false ? <select class="field" aria-label={label} value={model} onChange={event => save(agent, mode, { model: event.currentTarget.value, effort: undefined })}><option value="">CLI default</option>{catalog.models.map(item => <option value={item.id}>{item.label}</option>)}</select> : <><input class="field" aria-label={label} list={`improve-${agent}-${mode}-models`} placeholder="CLI default" value={model} maxLength={200} onInput={event => save(agent, mode, { model: event.currentTarget.value, effort: undefined })} /><datalist id={`improve-${agent}-${mode}-models`}>{catalog?.models.map(item => <option value={item.id}>{item.label}</option>)}</datalist></>}</label>
            <label>Reasoning effort<select class="field" aria-label={`${mode === "quick" ? "Quick" : "Repo"} effort · ${IMPROVE_NAMES[agent]}`} disabled={!efforts.length} value={choice.effort ?? "__recommended__"} onChange={event => save(agent, mode, { effort: event.currentTarget.value === "__recommended__" ? undefined : event.currentTarget.value })}><option value="__recommended__">{efforts.length ? `Improve default${defaults.effort && efforts.includes(defaults.effort) ? ` · ${defaults.effort}` : ""}` : "No effort choices"}</option><option value="">CLI default</option>{choice.effort && !efforts.includes(choice.effort) ? <option value={choice.effort}>{choice.effort}{catalog ? " · unavailable for this model" : " · loading choices"}</option> : null}{efforts.map(effort => <option value={effort}>{effort}</option>)}</select></label>
          </div>;
        })}
        <p class="help">{catalog ? catalog.allowCustom ? "Choose a suggested model or enter its model ID. Leave the model empty to use the CLI default." : "Choose a supported model or use the CLI default." : "Model choices are unavailable. You can enter a model ID; refresh providers to load supported effort choices."}</p>
      </fieldset>;
    })}
    <div class="settings-actions"><button class="btn small" onClick={() => setImproveSettings({ agent: "auto", defaultMode: "quick", providers: {} })}>Reset Improve defaults</button><span class="help">Saved automatically in this browser for this workspace.</span></div>
    <p class="help">The note below your task shows which agent actually completed the rewrite. Improve does not implement the task.</p>
  </section>;
}
