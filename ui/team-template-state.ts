import { effect, signal } from "@preact/signals";
import { fillTeamTemplate, validateTeamTemplate, type TemplateSelection } from "../src/team-templates.js";
import { store } from "./lib.js";
function restored(): TemplateSelection | null {
  try {
    const value = store.json<TemplateSelection | null>("selectedTeamTemplate", null);
    if (!value) return null;
    const template = validateTeamTemplate(value.template);
    fillTeamTemplate(template, value.inputs);
    return { template, inputs: value.inputs };
  } catch { return null; }
}
export const selectedTeamTemplate = signal<TemplateSelection | null>(restored());
effect(() => {
  if (selectedTeamTemplate.value) store.set("selectedTeamTemplate", JSON.stringify(selectedTeamTemplate.value));
  else store.remove("selectedTeamTemplate");
});
