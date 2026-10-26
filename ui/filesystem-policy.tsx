import { completeSentence } from "./lib.js";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FilePolicySnapshot, FileRules } from "../src/filesystem-policy.js";
import { confirmAction } from "./confirm-state.js";
import { api, ApiError, enc } from "./lib.js";
import { loadAgents, loadHealth, loadModels, loadProjects } from "./state.js";
import type { ShellInfo } from "./types.js";

type Rules = { read: FileRules; write: FileRules };
const UNRESTRICTED: Rules = { read: { allow: ["."], deny: [] }, write: { allow: ["."], deny: [] } };
/** As src/filesystem-policy.ts decides it (that module reads files, so the page can't import it). */
const restrictive = (rules: Rules) => [rules.read, rules.write].some((list) => list.allow.length !== 1 || list.allow[0] !== "." || list.deny.length > 0);

export function FilePolicyPanel({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const [saved, setSaved] = useState<FilePolicySnapshot | null>(null), [readAllow, setReadAllow] = useState("."), [readDeny, setReadDeny] = useState(""), [writeAllow, setWriteAllow] = useState("."), [writeDeny, setWriteDeny] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [terminals, setTerminals] = useState<ShellInfo[]>([]); const generation = useRef(0), currentProject = useRef(projectId), attempted = useRef<Rules>(); currentProject.current = projectId;
  const useSaved = (value: Rules) => { setReadAllow(value.read.allow.join("\n")); setReadDeny(value.read.deny.join("\n")); setWriteAllow(value.write.allow.join("\n")); setWriteDeny(value.write.deny.join("\n")); };
  const load = async (replace: boolean) => { const request = ++generation.current; setBusy(true); setError(""); setTerminals([]); try { const result = await api<FilePolicySnapshot>(`/api/projects/${enc(projectId)}/filesystem-policy`); if (request !== generation.current) return; setSaved(result); if (replace) useSaved(result); else setNotice("Latest saved revision loaded; your draft is kept. Compare the saved rules before applying it."); } catch (error) { if (request === generation.current) setError((error as Error).message); } finally { if (request === generation.current) setBusy(false); } };
  useEffect(() => { setSaved(null); setNotice(""); void load(true); return () => { generation.current++; }; }, [projectId]);
  // As the server normalizes them. Whether a save changes anything is the server's call: it alone knows the current revision.
  const paths = (value: string) => [...new Set(value.split(/\r?\n/).map((path) => path.trim().replace(/(.)\/$/, "$1")).filter(Boolean))].sort();
  const draft = (): Rules => ({ read: { allow: paths(readAllow), deny: paths(readDeny) }, write: { allow: paths(writeAllow), deny: paths(writeDeny) } });
  const name = projectName ? `“${projectName}”` : "this project";
  /** Save `rules`. A first restriction pauses work in every project, so it asks first; `confirmed` when the caller already did. */
  const apply = async (rules: Rules, confirmed = false) => {
    if (!saved || busy) return;
    const selected = projectId; setError(""); setNotice(""); setTerminals([]);
    if (!confirmed && restrictive(rules) && !restrictive(saved) && !await confirmAction(`Restrict file access for ${name}?\n\nWhile any project has a custom restriction, agents, terminals, setup and checks, development services, previews, automations, PR watches and notifications pause in every project, and unscoped history, statistics and memory are hidden. Runs already started keep their pinned policy.`, { title: "Pause execution in every project?", confirmLabel: "Apply restriction", danger: true })) return;
    if (selected !== currentProject.current) return;
    const request = ++generation.current; attempted.current = rules; setBusy(true);
    try {
      const result = await api<FilePolicySnapshot>(`/api/projects/${enc(projectId)}/filesystem-policy`, { method: "PUT", body: JSON.stringify({ revision: saved.revision, ...rules }) });
      if (selected !== currentProject.current || request !== generation.current) return;
      setSaved(result); useSaved(result); setNotice(result.revision === saved.revision ? `No changes to apply: revision ${saved.revision} already has these rules.` : `Filesystem policy revision ${result.revision} applied.`);
      // What's paused (providers, terminals, the composer) follows the new policy everywhere in the app.
      void loadAgents().then(() => Promise.all([loadProjects(), loadModels(), loadHealth()])).catch(() => {});
    } catch (error) {
      if (selected !== currentProject.current || request !== generation.current) return;
      setError((error as Error).message);
      // Open terminals block a change: offer to close them here, where the side panel may not show them.
      if (error instanceof ApiError && error.status === 409 && /terminal/i.test(error.message)) void api<ShellInfo[]>("/api/shell").then((list) => { if (request === generation.current) setTerminals(list.filter((shell) => shell.status === "running")); }, () => {});
    } finally { if (selected === currentProject.current && request === generation.current) setBusy(false); }
  };
  const closeTerminals = async () => {
    const busyShells = terminals.filter((shell) => shell.busy);
    if (busyShells.length && !await confirmAction(`Stop ${busyShells.map((shell) => shell.running ?? "what's running").join(", ")} and close ${terminals.length === 1 ? "the terminal" : `all ${terminals.length} terminals`}?`, { title: "Stop and close terminals?", confirmLabel: "Stop and close", danger: true })) return;
    setBusy(true);
    try { await Promise.all(terminals.map((shell) => api(`/api/shell/${enc(shell.id)}`, { method: "DELETE" }).catch(() => {}))); } finally { setBusy(false); }
    setTerminals([]);
    if (attempted.current) await apply(attempted.current, true);
  };
  const removeRestrictions = async () => {
    if (!await confirmAction(`Remove the filesystem restrictions on ${name}?\n\nIts rules go back to allowing every path (allow ., no denies). App-managed execution resumes once no project restricts file access; extensions load after a restart. Runs already started keep their pinned policy.`, { title: "Remove restrictions?", confirmLabel: "Remove restrictions" })) return;
    useSaved(UNRESTRICTED); await apply(UNRESTRICTED, true);
  };
  return <section class="wb-card filesystem-policy" aria-label="Project filesystem policy"><h2>Filesystem policy{projectName ? ` · ${projectName}` : ""}</h2>
    <p class="help">Allow and deny literal repository paths, one per line. A path covers its directory descendants. Use <code>.</code> for the repository root; an empty allow list denies every path. Deny rules take precedence. Git internals, credential paths and symbolic escapes stay blocked in application file operations.</p>
    <p class="help">Any custom restriction pauses all app-managed agent, terminal, setup, checks and service execution across projects because the current host, Docker and SSH backends cannot enforce a filtered filesystem boundary. Close terminals/services and wait for all executions and unresolved remote receipts to finish before applying a policy. Existing runs retain their pinned restrictions; start a new run after deliberately changing policy. Extensions are deferred on restricted startup; clearing policy requires a restart to load them.</p>
    {saved && restrictive(saved) ? <p class="msg warn">This policy restricts file access, so app-managed execution is paused in every project.</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void apply(draft()); }}>
      <fieldset disabled={busy || !saved}><legend>Project file access</legend><div class="filesystem-policy-grid"><label>Read allow paths<textarea class="field" rows={4} value={readAllow} onInput={(event) => setReadAllow(event.currentTarget.value)} /></label><label>Read deny paths<textarea class="field" rows={4} value={readDeny} onInput={(event) => setReadDeny(event.currentTarget.value)} /></label><label>Write allow paths<textarea class="field" rows={4} value={writeAllow} onInput={(event) => setWriteAllow(event.currentTarget.value)} /></label><label>Write deny paths<textarea class="field" rows={4} value={writeDeny} onInput={(event) => setWriteDeny(event.currentTarget.value)} /></label></div></fieldset>
      <div class="filesystem-policy-actions"><button class="btn primary" disabled={busy || !saved} type="submit">{busy ? "Applying…" : "Apply policy"}</button>{saved && restrictive(saved) ? <button class="btn" type="button" disabled={busy} onClick={() => void removeRestrictions()}>Remove restrictions</button> : null}<button class="btn" type="button" disabled={busy} onClick={() => void load(false)}>Reload saved policy and keep draft</button><button class="btn" type="button" disabled={busy || !saved} onClick={() => { if (saved) useSaved(saved); setNotice("Draft replaced with the saved policy."); }}>Use saved policy</button></div>
    </form>{saved ? <details><summary>Saved revision {saved.revision} · {saved.hash.slice(0, 12)}</summary><pre class="filesystem-policy-saved">{JSON.stringify({ read: saved.read, write: saved.write }, null, 2)}</pre></details> : null}{error ? <div class="msg err" role="alert"><p>{completeSentence(error)} Your draft is kept.</p>{terminals.length ? <button class="btn small" type="button" disabled={busy} onClick={() => void closeTerminals()}>{`Close ${terminals.length === 1 ? "the open terminal" : `${terminals.length} open terminals`} and apply`}</button> : null}</div> : null}{notice ? <p class="help" role="status">{notice}</p> : null}
  </section>;
}
