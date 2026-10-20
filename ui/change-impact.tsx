import { useEffect, useState } from "preact/hooks";
import { api, enc } from "./lib.js";
import type { ArchitectureGraph } from "../src/architecture.js";

/** Static evidence is requested in the context of the files being edited or reviewed. */
export function ChangeImpact({ folder, paths, refreshKey = "" }: { folder: string; paths: string[]; refreshKey?: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [graph, setGraph] = useState<ArchitectureGraph>();
  useEffect(() => {
    if (!open || !folder) return;
    let current = true;
    setBusy(true); setError(""); setGraph(undefined);
    void api<ArchitectureGraph>(`/api/workspace/dependencies?repo=${enc(folder)}`).then(value => { if (current) setGraph(value); }, error => { if (current) setError(error.message); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [open, folder, paths.join("\0"), refreshKey]);
  const affected = new Set(paths);
  const relationships = graph?.edges.filter(edge => affected.has(edge.from) || affected.has(edge.to)) ?? [];
  return <details class="settings change-impact" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>What could this change affect?</summary>
    <div class="settings-body">
      <p class="help">Static import relationships for {paths.length} selected {paths.length === 1 ? "file" : "files"}, based on saved tracked source. Unsaved edits and runtime dependencies are excluded.</p>
      {busy ? <p role="status">Inspecting related files…</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      {graph ? <><p class="help">{graph.truncated ? "The scan reached its limit; some relationships may be missing. " : ""}{graph.note}</p>{relationships.length ? <ul>{relationships.map((edge, index) => <li key={index}><code>{edge.from}</code> imports <code>{edge.to}</code></li>)}</ul> : <p>No static import relationships found for these files. This does not establish that the change has no impact.</p>}<details><summary>Additional scan evidence</summary><p>{graph.nodes.length} files · {graph.cycles.length} cycles · {graph.unresolved.length} unresolved imports</p><pre>{JSON.stringify({ cycles: graph.cycles, packages: graph.packages, unresolved: graph.unresolved, dynamic: graph.dynamic }, null, 2)}</pre></details></> : null}
    </div>
  </details>;
}
