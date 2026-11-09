import { getAdapter, type ModelCatalog } from "../adapters/index.js";
import { modelCatalogStore } from "../model-catalog.js";
import { fail, type AntigravityMode, type Participant, type Preferences, type Provider, type ResolvedParticipant } from "./model.js";

/** Why Code Flow's sandbox for managed agy is unavailable here, if it is. */
export async function antigravitySandboxProblem() {
  return getAdapter("agy").managedAvailability?.();
}
const SANDBOX_HINT = "Only if the user explicitly asks for their normal agy setup, propose again with candidate.antigravity \"unrestricted\"; otherwise choose Claude or Codex.";

/** Models as the run will execute them: managed agy lists models from inside its sandbox unless the run is unrestricted. */
export async function catalog(provider: Provider, refresh = false, antigravity: AntigravityMode = "isolated"): Promise<ModelCatalog> {
  const isolated = provider === "agy" && antigravity === "isolated";
  if (isolated) { const problem = await antigravitySandboxProblem(); if (problem) fail("provider_unavailable", `agy: ${problem} ${SANDBOX_HINT}`); }
  const c = await modelCatalogStore.get(provider, { force: refresh, ...(isolated ? { context: { isolatedAgy: true } } : {}) });
  if (c.state !== "current") fail("provider_unavailable", `${provider}: ${c.issue ?? "refresh the model catalog after signing in"}`);
  return { models: c.models.filter(m => m.availability === "reported" && m.compatibility === "advertised").map(m => ({ id: m.id, label: m.label, aliases: m.aliases, efforts: m.efforts ?? undefined, defaultEffort: m.defaultEffort })), efforts: [], defaultModel: c.defaultModel, allowCustom: false };
}
export async function resolveParticipant(p: Participant, project: Preferences, personal: Preferences, options: { antigravity?: AntigravityMode; fetchCatalog?: (provider: Provider) => Promise<ModelCatalog> } = {}): Promise<ResolvedParticipant> {
  if (!await getAdapter(p.provider).available()) fail("provider_unavailable", `${p.provider} is not installed on PATH`);
  const projectSettings = project.providers?.[p.provider], personalSettings = personal.providers?.[p.provider];
  const requested = { ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) };
  const provenance = { model: p.model ? "task" : projectSettings?.model ? "project preference" : personalSettings?.model ? "personal preference" : "provider default", effort: p.effort ? "task" : projectSettings?.effort ? "project preference" : personalSettings?.effort ? "personal preference" : "provider default" };
  if (p.binding === "current_session") {
    if (p.model || p.effort) fail("unsupported_settings", "The current session's exact settings cannot be verified; use a managed participant for pinned model/effort settings");
    return { ...p, requested, provenance: { model: "current session (unverified)", effort: "current session (unverified)" }, modelDefaultUnknown: true, effortDefaultUnknown: true };
  }
  const c = await (options.fetchCatalog ?? (provider => catalog(provider, false, options.antigravity)))(p.provider);
  const selected = p.model ?? projectSettings?.model ?? personalSettings?.model ?? c.defaultModel;
  const matches = c.models.filter(m => m.id === selected || m.aliases?.includes(selected ?? ""));
  if (selected && matches.length !== 1) fail("unsupported_settings", `Unknown or ambiguous ${p.provider} model '${selected}'`, { models: c.models.map(m => ({ id: m.id, aliases: m.aliases })) });
  const model = matches[0], selectedEffort = p.effort ?? projectSettings?.effort ?? personalSettings?.effort;
  if (selectedEffort && !(model?.efforts ?? c.efforts).includes(selectedEffort)) fail("unsupported_settings", `${model?.id ?? p.provider} does not advertise effort '${selectedEffort}'`, { efforts: model?.efforts ?? c.efforts });
  const effort = selectedEffort ?? model?.defaultEffort ?? c.defaultEffort;
  return { ...p, model: model?.id, effort, requested, provenance, modelDefaultUnknown: !model, effortDefaultUnknown: !effort };
}
