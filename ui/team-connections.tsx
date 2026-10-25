import { useState } from "preact/hooks";
import { api, selectedTeamConnection, usePoll } from "./lib.js";
import type { TeamLinkInfo } from "./collab-state.js";

type Connection = TeamLinkInfo & { id: string; connection: string };
export function selectTeamConnection(id: string) {
  const url = new URL(location.href); url.searchParams.set("team", id); url.searchParams.delete("token");
  if (!url.hash.startsWith("#/settings/")) url.hash = "#/team";
  location.assign(url.href);
}
/** Selection is in the URL, so bookmarks and separate browser tabs keep their own team. */
export function TeamConnectionPicker({ hideWhenEmpty = false, compact = false }: { hideWhenEmpty?: boolean; compact?: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([]), [error, setError] = useState("");
  usePoll(async (current) => {
    try { const data = await api<{ connections: Connection[] }>("/api/team-link/connections"); if (current()) { setConnections(data.connections); setError(""); } }
    catch (err) { if (current()) setError((err as Error).message); }
  }, 15_000, []);
  const remotes = connections.filter((entry) => entry.id !== "local");
  const selected = selectedTeamConnection || (remotes.length === 1 ? remotes[0]!.id : remotes.length === 0 ? "local" : "");
  if (hideWhenEmpty && !remotes.length && !error) return null;
  return <section class={`settings-card team-connection-picker${compact ? " compact" : ""}`} aria-label="Team connections">
    <label class="lbl">Team connection<select class="field" value={selected} onChange={(event) => selectTeamConnection(event.currentTarget.value)}>
      <option value="" disabled>Choose a team…</option>
      {selected && connections.length > 0 && !connections.some((entry) => entry.id === selected) ? <option value={selected} disabled>Connection unavailable</option> : null}
      {connections.map((entry) => <option key={entry.id} value={entry.id}>{entry.id === "local" ? "This computer’s own board" : `${entry.hubName || entry.url} · ${entry.user?.username ?? ""} · ${entry.connection}`}</option>)}
    </select></label>
    <p class="help">{compact ? "Switch teams without interrupting running tasks." : "Each team keeps its own projects, account and repository mappings. Switching teams keeps other connections and running tasks active."}</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <a class="btn small" href="#/settings/connections/join">Manage team connections</a>
  </section>;
}
