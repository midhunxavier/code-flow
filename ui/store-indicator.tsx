import { useEffect, useState } from "preact/hooks";
import { api } from "./lib.js";
import { Icon } from "./icons.js";
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
  // Shared contributors have no store to show, and an empty top bar slot is better than a placeholder crowding it.
  if (!identity) return null;
  const { store, owner } = identity;
  const label = `${store.name} · ${store.environment}${/^(wsl|docker):/.test(store.environment) ? " · separate store" : ""}`;
  return <div class="store-indicator">
    {/* a narrow top bar keeps only the icon; the name stays in the accessible name and the panel */}
    <button class="btn ghost store-btn" title={label} aria-label={`Store: ${label}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="layers" />
      <span class="store-label">{label}</span>
    </button>
    {open ? <div class="store-panel" role="region" aria-label="Store identity">
      <strong>{store.name}</strong>
      <div>Store: {store.storeId}</div><div>Path: {identity.path}</div><div>Environment: {store.environment}</div>
      <div>Owner PID: {owner.pid}</div><div>Origin: {owner.origin}</div><div>Started by: {owner.startedBy}</div>
    </div> : null}
  </div>;
}
