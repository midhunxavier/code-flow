import { signal } from "@preact/signals";
import { useEffect, useState, useRef } from "preact/hooks";
import { api, post } from "./lib.js";
import { executionPaused } from "./state.js";
import { PolicyPauseNotice } from "./policy-pause.js";
import type { CapabilityCatalog } from "../src/model-catalog.js";
import type { ModelCatalog } from "../src/adapters/types.js";
interface Inventory {
    allowResearch: boolean;
    offline: boolean;
    providers: {
        provider: string;
        available: boolean;
        blockedReason?: string;
        limitations?: string[];
        catalog: CapabilityCatalog;
    }[];
}
export const discoveredCatalogs = signal<Record<string, ModelCatalog>>({});
export function WorkerModelCatalog({ remote, nativeAntigravity = false }: {
    remote: boolean;
    nativeAntigravity?: boolean;
}) {
    const generation = useRef(0);
    const [data, setData] = useState<Inventory>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function load(refresh = false, allowResearch?: boolean) {
        const request = ++generation.current;
        setBusy(true);
        setError("");
        try {
            const result: Inventory = refresh ? await post("/api/model-catalog", { ...(allowResearch === undefined ? {} : { allowResearch }), antigravityExecution: nativeAntigravity ? "native" : "isolated" }) : await api(`/api/model-catalog?antigravityExecution=${nativeAntigravity ? "native" : "isolated"}`);
            if (request !== generation.current) return;
            setData(result);
            discoveredCatalogs.value = Object.fromEntries(result.providers.map(p => [p.provider, { models: p.catalog.models.filter(m => m.availability === "reported").map(m => ({ id: m.id, label: m.label, efforts: m.efforts ?? [] })), efforts: [], defaultModel: p.catalog.defaultModel, allowCustom: false }]));
        }
        catch (e) {
            if (request === generation.current) setError((e as Error).message);
        }
        finally {
            if (request === generation.current) setBusy(false);
        }
    }
    // Discovery runs provider CLIs, which a filesystem restriction pauses: don't ask, say why.
    const paused = executionPaused.value;
    useEffect(() => { setData(undefined); setError(""); discoveredCatalogs.value = {}; if (!remote && !paused) void load(); return () => { generation.current++; }; }, [remote, nativeAntigravity, paused]);
    return <section class="section" aria-label="Automatic worker models"><h4>Automatic worker selection</h4><p class="help">Auto chooses each worker's provider, model and effort. Your coordinator stays fixed. Use the worker pool and model selections below to restrict or pin workers.</p>
    {remote ? <p class="help">Models are discovered in the selected execution environment when the run starts. Local model lists do not establish remote or container compatibility.</p> : paused ? <PolicyPauseNotice what="Model discovery is paused" /> : <>
    <button class="btn" disabled={busy} onClick={() => void load(true)}>{busy ? "Discovering models…" : "Refresh model catalog"}</button>
    <label class="checkpoint"><input type="checkbox" checked={data?.allowResearch ?? false} disabled={busy || data?.offline} onChange={e => void load(true, e.currentTarget.checked)}/><span>Allow research from official provider documentation</span></label>
    <p class="help">{data?.offline ? "Offline: using cached information. " : ""}CLI listings report candidates; they do not prove account access or successful execution. Unknown facts stay unknown.</p>
    {data?.providers.map(p => <details key={p.provider}><summary>{p.provider} · {p.catalog.state} · {p.catalog.models.length} models</summary>{p.blockedReason ? <p class="help">Unsupported for managed workers: {p.blockedReason}</p> : null}{p.limitations?.map(text => <p class="help" key={text}>{text}</p>)}{p.catalog.issue ? <p class="help">{p.catalog.issue}</p> : null}<ul>{p.catalog.models.map(m => <li key={m.id}><code>{m.id}</code> · {m.efforts === null ? "Effort support unknown" : m.efforts.length ? m.efforts.join(", ") : "No effort control"}<p class="help">{m.source} · {new Date(m.verifiedAt).toLocaleString()} · {m.availability}. Context: {m.documented?.contextTokens ?? "unknown"}; pricing: {m.documented?.pricing ? `$${m.documented.pricing.inputPerMillion}/$${m.documented.pricing.outputPerMillion} per million input/output tokens` : "unknown"}. {m.observations.length} run observations.</p></li>)}</ul></details>)}
    </>}{error ? <p role="alert">{error}</p> : null}</section>;
}
