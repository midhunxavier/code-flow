import type { TeamTask } from "./teams.js";

/** Dependency changes invalidate every transitive consumer, including knowledge dependencies. */
export function dependentTaskClosure(tasks: Pick<TeamTask, "id" | "dependsOn">[], selected: Iterable<string>): Set<string> {
  const included = new Set(selected);
  for (let pass = 0; pass < tasks.length; pass++) {
    let changed = false;
    for (const task of tasks) if (!included.has(task.id) && task.dependsOn.some((id) => included.has(id))) { included.add(task.id); changed = true; }
    if (!changed) break;
  }
  return included;
}
