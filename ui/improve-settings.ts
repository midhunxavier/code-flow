import { signal } from "@preact/signals";
import { store } from "./lib.js";
import { defaultImproveChoice, parseImproveSettings, type ImproveSettings } from "../src/improve-settings.js";

function singleChoice(settings: ImproveSettings): ImproveSettings {
  const agent = settings.agent === "auto" ? "claude" : settings.agent;
  const saved = settings.providers[agent]?.[settings.defaultMode] ?? {};
  const defaults = defaultImproveChoice(agent, settings.defaultMode);
  const choice = { model: saved.model ?? defaults.model ?? "", effort: saved.effort ?? defaults.effort ?? "" };
  return { ...settings, agent, providers: { ...settings.providers, [agent]: { quick: choice, repo: choice } } };
}

function read(): ImproveSettings {
  try { const saved = store.get("improveSettings"); if (saved) return singleChoice(parseImproveSettings(JSON.parse(saved))); } catch {}
  return singleChoice({ agent: "claude", defaultMode: store.get("improveMode") === "repo" ? "repo" : "quick", providers: {} });
}
export const improveSettings = signal<ImproveSettings>(read());
export function setImproveSettings(value: ImproveSettings) {
  improveSettings.value = parseImproveSettings(value);
  store.set("improveSettings", JSON.stringify(improveSettings.value));
}
