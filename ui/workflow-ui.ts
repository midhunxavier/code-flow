import { computed, effect, signal } from "@preact/signals";
import { composerRunBody } from "./composer-body.js";
import { composerLoading, composerRunOptions, draftsReady, pattern, repo } from "./state.js";
import { readProjectDefaults, projectDefaultsVersion } from "./project-defaults.js";
import { api, enc } from "./lib.js";
import type { VerificationProfile } from "../src/verification.js";
const profile = signal<{ key: string; value?: VerificationProfile; error?: string } | null>(null);
const profileKey = computed(() => {
  projectDefaultsVersion.value;
  if (!draftsReady.value || composerLoading.value || !repo.value) return "";
  const preset = composerRunOptions.value.verification ?? readProjectDefaults(repo.value).verification;
  return preset && preset !== "restored" ? `${repo.value}\n${preset}` : "";
});
effect(() => {
  const key = profileKey.value; if (!key) return;
  let live = true; const [repository, preset] = key.split("\n");
  void api<VerificationProfile>(`/api/verification/profile?repo=${enc(repository!)}&preset=${enc(preset!)}`).then(value => { if (live) profile.value = { key, value }; }, error => { if (live) profile.value = { key, error: error.message }; });
  return () => { live = false; };
});
export const comparisonDraftProblem = computed(() => profileKey.value && profile.value?.key === profileKey.value && profile.value.error ? `Verification profile unavailable: ${profile.value.error}` : profileKey.value && (profile.value?.key !== profileKey.value || !profile.value.value) ? "Loading verification profile…" : "");
/** Restored drafts remain usable on a direct Insights visit; project switches invalidate them. */
export const comparisonDraft = computed<Record<string, any> | null>(() => draftsReady.value && !composerLoading.value && !comparisonDraftProblem.value && pattern.value ? composerRunBody(pattern.value, profileKey.value ? profile.value?.value : composerRunOptions.value.verification === "restored" ? composerRunOptions.value.verificationProfile : null) : null);
