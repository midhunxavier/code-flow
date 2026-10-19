import { signal } from "@preact/signals";
import { store } from "./lib.js";
import { parseImproveSettings, type ImproveSettings } from "../src/improve-settings.js";

function read(): ImproveSettings {
  try { const saved = store.get("improveSettings"); if (saved) return parseImproveSettings(JSON.parse(saved)); } catch {}
  return { agent: "auto", defaultMode: store.get("improveMode") === "repo" ? "repo" : "quick", providers: {} };
}
export const improveSettings = signal<ImproveSettings>(read());
export function setImproveSettings(value: ImproveSettings) {
  improveSettings.value = parseImproveSettings(value);
  store.set("improveSettings", JSON.stringify(improveSettings.value));
}
