import { useState } from "preact/hooks";
import type { Board } from "../src/collab/model.js";
import { api, collaborationHref, enc, usePoll, workspaceId } from "./lib.js";
import { useDialog } from "./app.js";
import { repositoryChoice } from "./team-repository-choice.js";
import { ProjectInvitations } from "./project-invitations.js";

/** Project pages always share their owning computer's project, regardless of the selected team. */
export function ProjectShare({ project }: { project: { id: string; name: string } }) {
  const [open, setOpen] = useState(false), [count, setCount] = useState<number | null>(null);
  usePoll(async current => {
    try { const b = await api<Board>("/api/team/board?teamConnection=local"); if (current()) setCount(b.projects.find(p => p.id === project.id)?.members.length ?? null); }
    catch { if (current()) setCount(null); }
  }, 15_000, [project.id, open]);
  return <><a class="btn project-member-count" href={collaborationHref(`#/project/${enc(project.id)}/people`, "local")}>{count === null ? "People and access" : `${count} ${count === 1 ? "member" : "members"}`}</a>
    <button class="btn" onClick={() => setOpen(true)}>Share</button>
    {open ? <ProjectShareDialog project={project} onClose={() => setOpen(false)} /> : null}</>;
}

export function ProjectShareDialog({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const prepareRepositories = async () => {
    const b = await api<Board>("/api/team/board?teamConnection=local");
    const existing = b.projects.find(p => p.id === project.id);
    if (!existing || existing.repositories.length) return;
    const projects = await api<{ id: string; repos: string[] }[]>("/api/projects");
    const folders = projects.find(p => p.id === project.id)?.repos ?? [];
    const repositories: { key: string; label: string }[] = [];
    for (const folder of folders) repositories.push(repositoryChoice(folder, repositories.map(r => r.key)));
    if (repositories.length) await api(`/api/team/projects/${enc(project.id)}/repositories?teamConnection=local`, { method: "PUT", body: JSON.stringify({ revision: b.revision, repositories }) });
  };
  return <dialog class="picker project-share-dialog" ref={ref} aria-labelledby="project-share-title"><div class="picker-inner">
    <div class="picker-head"><h3 id="project-share-title">Share {project.name}</h3><p class="help">Invite someone to this project’s tasks, discussions, and results.</p></div>
    <div class="dialog-body"><ProjectInvitations projects={[project]} projectId={project.id} prefix={workspaceId ? `/computer/${workspaceId}` : ""} compact beforeCreate={prepareRepositories} /></div>
    <div class="picker-foot"><a class="btn" href={collaborationHref(`#/project/${enc(project.id)}/people`, "local")} onClick={onClose}>People and access</a><button class="btn" onClick={onClose}>Done</button></div>
  </div></dialog>;
}
