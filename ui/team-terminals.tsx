import { useEffect, useState } from "preact/hooks";
import type { Board, BoardProject } from "../src/collab/model.js";
import type { TeamTerminal, TerminalAudit, TerminalGrant } from "../src/collab/terminals.js";
import { api, apiPath, enc, post, usePoll } from "./lib.js";
import { put, teamTick } from "./collab-state.js";
import { roleAtLeast } from "./shared-roles.js";
import { TermView, type TerminalTransport } from "./terminal.js";

interface TerminalView { revision: number; available: boolean; grants: (Partial<TerminalGrant> & { projectId: string; allowed?: boolean })[]; sessions: TeamTerminal[]; audit: TerminalAudit[]; idleMinutes: number; maxPerUser: number }
function useTerminals() {
  const [data, setData] = useState<TerminalView | null>(null), [error, setError] = useState("");
  const load = async (current: () => boolean = () => true) => { try { const next = await api<TerminalView>("/api/team-terminals"); if (current()) { setData(next); setError(""); } } catch (err) { if (current()) setError((err as Error).message); } };
  usePoll(load, 0, [teamTick.value]); return { data, error, setError, load };
}
const closeTerminal = (id: string) => api(`/api/team-terminals/${enc(id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });

export function TeamTerminalSettings({ board }: { board: Board }) {
  const { data, error, setError, load } = useTerminals(), [busy, setBusy] = useState(false);
  const save = async (grant: TerminalGrant) => {
    if (!data || busy) return; setBusy(true);
    try { await put("/api/team-terminals/settings", { revision: data.revision, grant }); await load(); }
    catch (err) { await load(); setError((err as Error).message); } finally { setBusy(false); }
  };
  const stop = async (id: string) => { setBusy(true); try { await closeTerminal(id); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return <section class="settings-card"><h3>Teammate terminals</h3>
    <p class="help">A separate permission from agent tasks. A terminal runs as your operating-system user and can access files and credentials outside the project. The project selects its starting folder; it does not sandbox commands. Grant this only to people you trust with your computer.</p>
    <p class="help">Two terminals per teammate, eight in total. Sessions close after 30 minutes without keyboard input, on access revocation, or when Code Flow stops. The app shows each terminal’s output only to its creator. Detached processes and changes already made may outlive a closed terminal.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {data ? <>
      {!data.available ? <p class="msg warn">Team terminals are unavailable while linked to another team server or while filesystem restrictions are active.</p> : null}
      {board.projects.map((project) => <TerminalProject key={project.id} project={project} saved={data.grants.find((g) => g.projectId === project.id) as TerminalGrant | undefined} busy={busy} save={save} />)}
      <h4>Open teammate terminals</h4>
      {data.sessions.length ? <ul>{data.sessions.map((s) => <li key={s.id}>{s.displayName} · {board.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId} · {s.repository} <button class="btn small danger" disabled={busy} onClick={() => void stop(s.id)}>Close terminal</button></li>)}</ul> : <p class="help">No open teammate terminals.</p>}
      <details><summary>Recent terminal activity</summary><p class="help">Records opens and closes, without saving command text or output.</p><ul>{data.audit.slice(-20).reverse().map((e, i) => <li key={`${e.at}-${i}`}>{new Date(e.at).toLocaleString()} · {e.session.displayName} · {e.action} · {e.session.repository}{e.reason ? ` · ${e.reason}` : ""}</li>)}</ul></details>
    </> : <p class="help">Loading terminal permissions…</p>}
  </section>;
}
function TerminalProject({ project, saved, busy, save }: { project: BoardProject; saved?: TerminalGrant; busy: boolean; save: (grant: TerminalGrant) => Promise<void> }) {
  const initial = (): TerminalGrant => saved ?? { projectId: project.id, enabled: false, userIds: [] };
  const [draft, setDraft] = useState(initial); useEffect(() => setDraft(initial()), [JSON.stringify(saved)]);
  const members = project.members.filter((m) => m.userId !== "owner" && roleAtLeast(m.role, "contributor"));
  return <fieldset class="team-keys" disabled={busy}><legend>Terminal access · {project.name}</legend>
    <label><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} /> Allow unrestricted host terminals for this project</label>
    {members.map((m) => <label class="row-inline" key={m.userId}><input type="checkbox" checked={draft.userIds.includes(m.userId)} onChange={(e) => setDraft({ ...draft, userIds: e.currentTarget.checked ? [...draft.userIds, m.userId] : draft.userIds.filter((id) => id !== m.userId) })} />{m.displayName}</label>)}
    {!members.length ? <p class="help">Add a project contributor in Projects &amp; access first.</p> : null}
    <div class="settings-actions"><button class="btn small primary" disabled={busy || JSON.stringify(draft) === JSON.stringify(saved)} onClick={() => void save({ ...draft, userIds: draft.userIds.filter((id) => members.some((m) => m.userId === id)) })}>Save terminal permissions</button></div>
  </fieldset>;
}

export function TeamTerminalPanel({ board, project }: { board: Board; project?: string }) {
  const { data, error, setError, load } = useTerminals(), [busy, setBusy] = useState(false);
  const [place, setPlace] = useState(""), [selected, setSelected] = useState("");
  const choices = board.projects.filter((p) => (!project || p.id === project) && data?.grants.some((g) => g.projectId === p.id && g.allowed)).flatMap((p) => p.repositories.map((r) => ({ key: `${p.id}/${r.key}`, projectId: p.id, repository: r.key, label: `${p.name} · ${r.label}` })));
  const choice = choices.find((p) => p.key === place) ?? choices[0];
  const sessions = data?.sessions.filter((s) => !project || s.projectId === project) ?? [];
  const terminal = sessions.find((s) => s.id === selected) ?? sessions[0];
  const create = async (projectId: string, repository: string, replace?: string) => {
    if (busy) return; setBusy(true); setError("");
    try { if (replace) await closeTerminal(replace); const s = await post<TeamTerminal>("/api/team-terminals", { projectId, repository, cols: 100, rows: 24 }); setSelected(s.id); await load(); } catch (err) { await load(); setError((err as Error).message); } finally { setBusy(false); }
  };
  const close = async (id: string) => { setBusy(true); try { await closeTerminal(id); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  if (data && !choices.length && !sessions.length && !error) return null;
  return <section class="team-section"><h3>Your host terminals</h3>
    <p class="help">Commands run on the host computer using its installed tools and user permissions. Each terminal is yours; other teammates cannot attach through Code Flow. Closing this page leaves the shell open until you close it or it reaches the 30-minute input timeout.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <div class="team-actions">
      <label>Starting repository<select class="field" aria-label="Terminal starting repository" value={choice?.key ?? ""} onChange={(e) => setPlace(e.currentTarget.value)}>{choices.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
      <button class="btn small primary" disabled={busy || !choice || !data?.available || (data?.sessions.length ?? 0) >= 2} onClick={() => choice && void create(choice.projectId, choice.repository)}>Open terminal</button>
      {sessions.length ? <label>Open session<select class="field" aria-label="Your terminal session" value={terminal?.id ?? ""} onChange={(e) => setSelected(e.currentTarget.value)}>{sessions.map((s, i) => <option key={s.id} value={s.id}>{s.repository} · terminal {i + 1}</option>)}</select></label> : null}
      {terminal ? <button class="btn small danger" disabled={busy} onClick={() => void close(terminal.id)}>Close terminal</button> : null}
    </div>
    {terminal ? <div class="team-terminal-screen"><TermView key={terminal.id} id={terminal.id} places={[]} split={false} focused={false} shown={true} onFocus={() => {}} onReplace={() => void create(terminal.projectId, terminal.repository, terminal.id)} transport={transportFor(terminal.id)} /></div> : <p class="help">No terminal open. Python 3 PTY support is required on the host.</p>}
  </section>;
}
function transportFor(id: string): TerminalTransport {
  const base = `/api/team-terminals/${enc(id)}`;
  return {
    async input(body) {
      const kind = body.binary === undefined ? "data" : "binary", text = body[kind] ?? "";
      for (const chunk of text.match(/[\s\S]{1,4096}/gu) ?? []) await post(`${base}/input`, { [kind]: chunk });
    },
    resize: (body) => post(`${base}/resize`, { cols: Math.min(500, Math.max(2, body.cols)), rows: Math.min(200, Math.max(1, body.rows)) }),
    watch(receive) {
      const source = new EventSource(apiPath(`${base}/events`));
      source.onmessage = (event) => { try { receive(JSON.parse(event.data)); } catch { /* An incomplete frame is ignored until reconnect. */ } };
      source.onerror = () => receive({ type: "error", status: 0, message: "Terminal connection lost or access ended. Reconnecting if available…" });
      return () => source.close();
    },
  };
}
