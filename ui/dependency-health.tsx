import { useRef, useState } from "preact/hooks";
import { api } from "./lib.js";
import type { DependencyHealthReport } from "../src/dependency-health.js";

export function DependencyDiscovery() {
  const [report, setReport] = useState<DependencyHealthReport | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const request = useRef(0);
  const inspect = async () => {
    const seq = ++request.current; setBusy(true); setError("");
    try { const result = await api<DependencyHealthReport>("/api/doctor/dependencies"); if (seq === request.current) setReport(result); }
    catch (err) { if (seq === request.current) setError((err as Error).message); }
    finally { if (seq === request.current) setBusy(false); }
  };
  const providersReady = report?.providers.filter((provider) => provider.installed && provider.compatible === true && provider.signedIn === true) ?? [];
  return <section aria-label="Guided dependency discovery" class="dependency-discovery">
    <h3>Check this computer</h3><p class="help">Git and one compatible, signed-in provider are needed to run a team. Python terminals, browser snapshots and Docker isolation are optional. These checks read installed tools; they do not install software, sign in, pull images or change settings.</p>
    <button class="btn" disabled={busy} onClick={inspect}>{busy ? "Checking dependencies…" : report ? "Check dependencies again" : "Check all dependencies"}</button>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {report ? <div class="dependency-results"><p role="status">{report.node.ok && report.git.ok && providersReady.length ? "Core tools are ready." : "Core tools need attention."} Checked {new Date(report.checkedAt).toLocaleTimeString()}.</p>
      <h4>Required tools</h4><ul class="readiness-results"><li><span class={`badge ${report.node.ok ? "ok" : "err"}`}>{report.node.ok ? "Ready" : "Too old"}</span><span><b>Node.js {report.node.version}</b>{!report.node.ok ? <span class="help">Run code-flow with Node.js 22.13 or newer.</span> : null}</span></li>
      <li><span class={`badge ${report.git.ok ? "ok" : "err"}`}>{report.git.ok ? "Ready" : report.git.installed ? "Too old" : "Missing"}</span><span><b>Git {report.git.version ?? ""}</b>{report.git.warning ? <span class="help">{report.git.warning}</span> : null}</span></li>
      {report.providers.map((provider) => <li key={provider.id}><span class={`badge ${provider.installed && provider.signedIn === true && provider.compatible === true ? "ok" : provider.installed && (provider.compatible === false || provider.signedIn === false) ? "warn" : ""}`}>{!provider.installed ? "Missing" : provider.compatible === false ? "Incompatible" : provider.signedIn === false ? "Signed out" : provider.signedIn === null || provider.compatible === undefined ? "Unknown" : "Ready"}</span><span><b>{provider.name}{provider.version ? ` · ${provider.version}` : ""}</b>{provider.fix ? <span class="help">{provider.fix}</span> : null}{provider.warnings?.map((warning) => <span class="help" key={warning}>{warning}</span>)}</span></li>)}</ul>
      <h4>Optional tools</h4><ul class="readiness-results">{report.optional.map((dependency) => <li key={dependency.id}><span class={`badge ${dependency.ready ? "ok" : ""}`}>{dependency.ready ? "Ready" : dependency.installed ? "Unavailable" : "Not installed"}</span><span><b>{dependency.name}{dependency.version ? ` · ${dependency.version}` : ""}</b><span class="help">{dependency.detail}</span>{dependency.fix ? <span class="help">{dependency.fix}</span> : null}</span></li>)}</ul>
    </div> : null}
  </section>;
}
