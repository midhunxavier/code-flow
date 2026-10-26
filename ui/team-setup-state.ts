import type { Board } from "../src/collab/model.js";

export function wizardProject(projects: { id: string }[], board: Pick<Board, "projects">, remembered?: string | null, current?: string): string {
  return [remembered, ...board.projects.filter(project => project.repositories.length).map(project => project.id).reverse(), current, projects[0]?.id].find(id => id && projects.some(project => project.id === id)) ?? "";
}

type Request = <T>(path: string, body?: object, method?: string) => Promise<T>;
/** The caller supplies paths belonging to the target host. Existing explicit mappings win. */
export async function rememberSetupMappings(request: Request, projectId: string, rows: { key: string; sourcePath?: string }[]): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const link = await request<{ mappings: Record<string, Record<string, string>> }>("/api/team-link?teamConnection=local");
    for (const row of rows) {
      const key = row.key.trim();
      if (!row.sourcePath || link.mappings[projectId]?.[key]) continue;
      try { await request("/api/team-link/mappings?teamConnection=local", { projectId, repository: key, path: row.sourcePath }, "PUT"); }
      catch (error) { warnings.push(`${key}: ${(error as Error).message}`); }
    }
  } catch (error) { warnings.push((error as Error).message); }
  return warnings;
}
