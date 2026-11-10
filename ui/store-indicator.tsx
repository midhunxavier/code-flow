import { useEffect, useState } from "preact/hooks";
import { api } from "./lib.js";
import type { StoreRecord } from "../src/store-identity.js";

type Identity = { store: StoreRecord; path: string; owner: { pid: number; origin: string; startedBy: string } };
export function StoreIndicator() {
  const [identity, setIdentity] = useState<Identity>(), [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => { void api<Identity>("/api/store").then(value => { if (active) setIdentity(value); }).catch(() => { if (active) setIdentity(undefined); }); };
    load();
    window.addEventListener("focus", load);
    return () => { active = false; window.removeEventListener("focus", load); };
  }, []);
  if (!identity) return <span class="muted" role="status">Store unavailable</span>;
  const { store, owner } = identity;
  const label = `${store.name} · ${store.environment}${/^(wsl|docker):/.test(store.environment) ? " · separate store" : ""}`;
  return <div style={{ position: "relative", minWidth: 0 }}>
    <button class="btn ghost" style={{ maxWidth: "28vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label} aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
    {open ? <div role="region" aria-label="Store identity" style={{ position: "absolute", right: 0, top: "100%", zIndex: 20, padding: "12px", background: "var(--bg, #181914)", border: "1px solid var(--border, #666)", width: "min(400px, 80vw)", overflowWrap: "anywhere" }}>
      <strong>{store.name}</strong>
      <div>Store: {store.storeId}</div><div>Path: {identity.path}</div><div>Environment: {store.environment}</div>
      <div>Owner PID: {owner.pid}</div><div>Origin: {owner.origin}</div><div>Started by: {owner.startedBy}</div>
    </div> : null}
  </div>;
}
