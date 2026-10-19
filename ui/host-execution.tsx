import { useEffect, useState } from "preact/hooks";
import type { Board, BoardProject, Task } from "../src/collab/model.js";
import type { HostJob, HostProjectPolicy } from "../src/collab/host-execution.js";
import { api, enc, post, usePoll } from "./lib.js";
import { put, teamTick } from "./collab-state.js";
import { roleAtLeast } from "./shared-roles.js";

interface QueueView {
  revision: number; concurrency: number; available: boolean;
  policies: (Partial<HostProjectPolicy> & { projectId: string; agent: string; allowed?: boolean })[];
  jobs: HostJob[];
}
const active = (job: HostJob) => ["queued", "starting", "running", "stopping"].includes(job.state);
function useQueue() {
  const [data, setData] = useState<QueueView | null>(null), [error, setError] = useState("");
  const load = async (current: () => boolean = () => true) => { try { const next = await api<QueueView>("/api/host-execution"); if (current()) { setData(next); setError(""); } } catch (err) { if (current()) setError((err as Error).message); } };
  // Team events wake this view. An idle shared page does not poll and renew its session.
  usePoll(load, 0, [teamTick.value]);
  return { data, error, setError, load };
}

export function HostExecutionSettings({ board }: { board: Board }) {
  const { data, error, setError, load } = useQueue();
  const [concurrency, setConcurrency] = useState(1), [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setConcurrency(data.concurrency); }, [data?.concurrency]);
  const save = async (patch: Record<string, unknown>) => {
    if (!data || busy) return false; setBusy(true); setError("");
    try { await put("/api/host-execution/settings", { revision: data.revision, ...patch }); await load(); return true; }
    catch (err) { await load(); setError((err as Error).message); return false; } finally { setBusy(false); }
  };
  return <section class="settings-card"><h3>Run teammates’ tasks on this computer</h3>
    <p class="help">Grant trusted teammates permission to queue agent tasks using this computer’s installed CLIs and logins. Each task gets a Git worktree. Agent and test commands run with this host’s permissions; a project grant is not an operating-system sandbox.</p>
    <p class="help">Map each repository above to a repository belonging to its project. Teammates can start tasks they own, see progress, cancel their requests and download checkpoints. The host owner handles agent approvals. Terminal access requires a separate grant below.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {!data ? <p class="help">Loading host execution settings…</p> : <>
      {!data.available ? <p class="msg warn">Host execution is unavailable while this computer is linked to another team server or filesystem restrictions are active.</p> : null}
      <div class="settings-actions"><label>Concurrent host tasks<input class="field" type="number" min={1} max={4} value={concurrency} onInput={(event) => setConcurrency(Number(event.currentTarget.value))} /></label><button class="btn small" disabled={busy || concurrency === data.concurrency || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4} onClick={() => void save({ concurrency })}>Save queue limit</button></div>
      {board.projects.map((project) => <ProjectExecution key={project.id} project={project} saved={data.policies.find((p) => p.projectId === project.id) as HostProjectPolicy | undefined} busy={busy} save={save} />)}
      {!board.projects.length ? <p class="help">Create a project and teammate accounts to grant execution.</p> : null}
    </>}
  </section>;
}
function ProjectExecution({ project, saved, busy, save }: { project: BoardProject; saved?: HostProjectPolicy; busy: boolean; save: (patch: Record<string, unknown>) => Promise<boolean> }) {
  const initial = (): HostProjectPolicy => saved ?? { projectId: project.id, enabled: false, userIds: [], agent: "codex", trust: "standard", maxMinutes: 30, maxSteps: 20 };
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial()), [JSON.stringify(saved)]);
  const members = project.members.filter((m) => m.userId !== "owner" && roleAtLeast(m.role, "contributor"));
  const update = (patch: Partial<HostProjectPolicy>) => setDraft({ ...draft, ...patch });
  return <fieldset class="team-keys" disabled={busy}><legend>{project.name}</legend>
    <label><input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.currentTarget.checked })} /> Allow host execution for this project</label>
    <div class="settings-grid">
      <label>Host CLI<select aria-label="Host CLI" class="field" value={draft.agent} onChange={(event) => update({ agent: event.currentTarget.value as HostProjectPolicy["agent"] })}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="agy">Antigravity</option></select></label>
      <label>Agent permissions<select aria-label="Agent permissions" class="field" value={draft.trust} onChange={(event) => update({ trust: event.currentTarget.value as HostProjectPolicy["trust"] })}><option value="safe">Safe</option><option value="standard">Standard</option></select></label>
      <label>Minutes per task<input class="field" type="number" min={1} max={120} value={draft.maxMinutes} onInput={(event) => update({ maxMinutes: Number(event.currentTarget.value) })} /></label>
      <label>Steps per task<input class="field" type="number" min={1} max={100} value={draft.maxSteps} onInput={(event) => update({ maxSteps: Number(event.currentTarget.value) })} /></label>
    </div>
    <p class="help">Choose which project contributors may use this computer:</p>
    {members.map((member) => <label class="row-inline" key={member.userId}><input type="checkbox" checked={draft.userIds.includes(member.userId)} onChange={(event) => update({ userIds: event.currentTarget.checked ? [...draft.userIds, member.userId] : draft.userIds.filter((id) => id !== member.userId) })} />{member.displayName}</label>)}
    {!members.length ? <p class="help">Give a teammate the contributor or maintainer role in Projects &amp; access first.</p> : null}
    <div class="settings-actions"><button class="btn small primary" disabled={busy || JSON.stringify(draft) === JSON.stringify(saved)} onClick={() => void save({ policy: { ...draft, userIds: draft.userIds.filter((id) => members.some((m) => m.userId === id)) } })}>Save host permissions</button></div>
  </fieldset>;
}

export function HostTaskControl({ task, meId }: { task: Task; meId?: string }) {
  const { data, error, setError, load } = useQueue(), [busy, setBusy] = useState(false);
  const grant = data?.policies.find((p) => p.projectId === task.projectId);
  const jobs = data?.jobs.filter((j) => j.taskId === task.id) ?? [], job = [...jobs].reverse().find(active) ?? jobs.at(-1);
  const canStart = data?.available && grant?.allowed && task.owner?.userId === meId;
  const execute = async (path: string, body: unknown) => {
    if (busy) return; setBusy(true); setError("");
    try { await post(path, body); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <div class="team-section"><h3>Host computer</h3>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {job ? <p role="status">{job.state === "queued" ? "Queued for the host computer" : `Host task: ${job.state}`} · requested by {job.displayName}{job.message ? ` · ${job.message}` : ""}</p> : null}
    {canStart && !jobs.some(active) ? <button class="btn small primary" disabled={busy || task.status === "done" || task.attempts.some((a) => ["claimed", "running", "unknown"].includes(a.state)) || task.handoff?.state === "offered"} onClick={() => void execute(`/api/host-execution/tasks/${enc(task.id)}`, { revision: task.revision })}>Run on host computer</button> : null}
    {job && active(job) && job.userId === meId ? <button class="btn small" disabled={busy || job.state === "stopping"} onClick={() => void execute(`/api/host-execution/jobs/${enc(job.id)}/cancel`, {})}>{job.state === "queued" ? "Remove from queue" : "Stop host task"}</button> : null}
    <p class="help">{grant?.allowed ? `Uses ${grant.agent} on the host. Your browser can close after queuing. Progress and downloadable checkpoints appear on this task.` : "The host owner can grant execution in Settings → Team. You can also run this task from your own linked Code Flow installation."}</p>
    {grant?.allowed && task.owner?.userId !== meId ? <p class="help">Take ownership of this task to queue it on the host.</p> : null}
  </div>;
}

export function HostQueue({ board, project }: { board: Board; project?: string }) {
  const { data, error, setError, load } = useQueue(), [busy, setBusy] = useState("");
  const jobs = (data?.jobs ?? []).filter((j) => (!project || j.projectId === project) && active(j));
  const cancel = async (job: HostJob) => { setBusy(job.id); try { await post(`/api/host-execution/jobs/${enc(job.id)}/cancel`, {}); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(""); } };
  return <section class="team-section" aria-label="Host execution queue"><h3>Host queue</h3>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {!data && !error ? <p class="help">Loading…</p> : !jobs.length ? <p class="help">No host tasks queued or running.</p> : <ol>{jobs.map((job) => <li key={job.id}><a href={`#/team/task/${enc(job.taskId)}`}>{board.tasks.find((t) => t.id === job.taskId)?.title ?? job.taskId}</a> · {job.state} · {job.displayName}{job.message ? ` · ${job.message}` : ""} {(board.me.userId === "owner" || board.me.userId === job.userId) && job.state !== "stopping" ? <button class="btn small" disabled={!!busy} onClick={() => void cancel(job)}>{job.state === "queued" ? "Remove" : "Stop"}</button> : null}</li>)}</ol>}
    {data ? <p class="help">Up to {data.concurrency} host task{data.concurrency === 1 ? "" : "s"} at a time, in queue order. You see tasks in your projects.</p> : null}
  </section>;
}
