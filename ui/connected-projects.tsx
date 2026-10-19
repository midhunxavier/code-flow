import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { localApi, workspaceId, workspaceUrl } from "./lib.js";
import { executionHost } from "./ssh-projects.js";
import { projects } from "./state.js";

interface Computer { id: string; name: string; projects: { id: string; name: string }[]; error?: string }
interface Directory { currentComputerId: string; computers: Computer[] }

export function useComputerProjects() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const localProjects = projects.value;
  useEffect(() => {
    if (executionHost.value.kind === "host") return;
    let active = true, pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await localApi<Directory>("/api/workspace-projects");
        if (active) { setDirectory({ ...next, currentComputerId: workspaceId ?? "local" }); setError(""); }
      } catch { if (active) { setDirectory(null); setError("Connected projects unavailable"); } }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    window.addEventListener("focus", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [localProjects]);
  return { directory, error };
}

/** All computers share one order; the active workspace renders in its existing slot. */
export function ComputerProjects({ directory, error, query, children }: { directory: Directory | null; error: string; query: string; children: ComponentChildren }) {
  if (!directory) return error || executionHost.value.kind === "host" ? <>{children}{error ? <p class="rail-empty" role="status">{error}</p> : null}</> : <p class="rail-empty" role="status">Loading projects…</p>;
  if (directory.computers.length === 1) return <>{children}</>;
  return <>{directory.computers.map((computer) => {
    const current = computer.id === directory.currentComputerId;
    const matches = computer.projects.filter((project) => `${computer.name} ${project.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (!current && query.trim() && !matches.length) return null;
    return <details class="computer-projects" open key={computer.id} data-computer-id={computer.id}>
      <summary class="rail-title">{computer.name}<span class="computer-project-count">{current ? "Current" : computer.projects.length}</span></summary>
      <div role="group" aria-label={`${computer.name} projects`}>
        {current ? children : computer.error ? <p class="rail-empty" role="status">{computer.error}</p> : matches.length ? matches.map((project) => {
          const destination = workspaceUrl(computer.id, `#/project/${encodeURIComponent(project.id)}`);
          return <a class="connected-project-link" key={project.id} href={destination} title={`Open ${project.name} on ${computer.name}`}><span>{project.name}</span></a>;
        }) : <p class="rail-empty">No projects yet</p>}
      </div>
    </details>;
  })}</>;
}
