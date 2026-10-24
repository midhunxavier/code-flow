import type { TeamMember, TeamTask } from "./teams.js";
export interface TeamSteeringRequest { id: string; text: string; taskIds: string[]; at: number; parentId: string; noteId: string }

/** Resolve explicit task/member/file references, then include dependent work.
 * Ambiguous instructions conservatively affect the whole graph, never a guessed
 * worker. This changes assignments, not permissions or acceptance requirements. */
export function steeringTargets(text: string, tasks: TeamTask[], members: TeamMember[]): string[] {
  // Excluded sibling work is a constraint, not a target. A stand-alone "leave X
  // alone" still targets X so its current writer is stopped. Dependency closure
  // remains mandatory: dependent tasks receive the full constraint and revalidate.
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'");
  const positive = normalized.replace(/\b(?:leave|keep)\s+[^;!?\n]*?\b(?:alone|unchanged|as is)\b/g, " ")
    .replace(/\b(?:do not|don't|without)\s+(?:change|changing|touch|touching|update|updating|edit|editing)\s+[^,;!?\n]+/g, " ");
  const matching = /\b(?:update|change|fix|revise|implement|rename|build|add|remove|only)\b/.test(positive) ? positive : normalized;
  const words = new Set((matching.match(/[a-z0-9_./-]+/g) ?? []).map(word => word.replace(/^\.+|\.+$/g, "")));
  const ignore = new Set(["implement", "implementation", "worker", "task", "change", "changes", "update", "build", "create", "current", "code", "files", "file", "team", "the", "and", "with"]);
  const hits = (value: string) => value.toLowerCase().split(/[^a-z0-9_./-]+/).some(word => word.length >= 3 && !ignore.has(word) && words.has(word));
  const selected = new Set(tasks.filter(task => hits(task.id) || hits(task.title) || task.paths.some(path => path !== "*" && (hits(path) || hits(path.split("/").at(-1)!))) || members.some(member => member.id === task.owner && (hits(member.id) || hits(member.name)))).map(task => task.id));
  if (!selected.size) return tasks.map(task => task.id);
  for (let changed = true; changed;) { changed = false; for (const task of tasks) if (!selected.has(task.id) && task.dependsOn.some(id => selected.has(id))) { selected.add(task.id); changed = true; } }
  return [...selected];
}
