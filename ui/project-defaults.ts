import { signal } from "@preact/signals";
import { store } from "./lib.js";

export interface ProjectRunDefaults {
  verification: string;
  container: { enabled: boolean; image: string; authVolume: string };
}
export const projectDefaultsVersion = signal(0);
export function readProjectDefaults(repository: string): ProjectRunDefaults {
  const saved = store.json<Partial<ProjectRunDefaults> | null>(`runDefaults:${repository}`, {}) ?? {};
  return { verification: ["lightweight", "standard", "thorough"].includes(saved.verification ?? "") ? saved.verification! : "", container: { enabled: saved.container?.enabled === true, image: saved.container?.image ?? "", authVolume: saved.container?.authVolume ?? "" } };
}
export function saveProjectDefaults(repository: string, value: ProjectRunDefaults) {
  store.set(`runDefaults:${repository}`, JSON.stringify(value));
  projectDefaultsVersion.value++;
}
