import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { cantRunMessage } from "./checks.js";
import { CODEFLOW_HOME } from "./config.js";
import type { Run, RunManager, RunSummary } from "./engine.js";
import { logError } from "./log.js";
import { projectOf, type Project } from "./projects.js";

/**
 * code-flow on your phone, behind a secret link. By default it's a read-only view: what's
 * running, what needs you, and each run's result, as plain server-rendered HTML that refreshes
 * itself and has no buttons. With `control` on (and the Wi-Fi listener), a link with a secret
 * of its own signs the phone in to the full app instead — see server.ts.
 */

export interface RemoteSettings {
  enabled: boolean;
  /** The read-only view's secret (`/r/<token>`). That link never signs a phone in. */
  token: string;
  /**
   * Full control's own secret: its link signs a phone in, and the phone's cookie carries it. Kept
   * apart from `token`, so a read-only link someone saw can't become a full-control one.
   */
  controlToken: string;
  /** Enable the network listener, on Wi-Fi or the selected Tailscale address. */
  lan: boolean;
  /** Missing in older settings: the existing Wi-Fi listener. */
  transport?: "lan" | "tailscale";
  /** The link opens the whole app on the network listener: start, answer, merge — everything. */
  control: boolean;
  /** Persisted pairing deadline. Existing device sessions have their own expiry. */
  pairingUntil?: number;
}

const FILE = join(CODEFLOW_HOME, "remote.json");
const validToken = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{32,}$/.test(t);
const fresh = (): RemoteSettings => ({ enabled: false, token: newToken(), controlToken: newToken(), lan: false, control: false });

/**
 * The phone settings. A remote.json that can't be read is moved aside (`remote.json.corrupt-<time>`)
 * and logged, and code-flow starts with phone access off rather than with a new link.
 */
export async function loadRemote(file = FILE): Promise<RemoteSettings> {
  unreadable.delete(file);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // There but unreadable (permissions, an I/O error): kept as it is, and never written over
      // until code-flow can read it, or its links and settings would be lost for good.
      logError(`Couldn't read ${file}; phone access is off until it can be read`, err);
      unreadable.set(file, (err as Error).message);
    }
    return fresh();
  }
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || !validToken(raw.token)) {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(file, aside).then(
      () => logError(`${file} couldn't be read: moved it to ${aside}; phone access is off`),
      (err) => logError(`${file} couldn't be read, nor moved aside; phone access is off`, err),
    );
    return fresh();
  }
  const settings: RemoteSettings = {
    enabled: raw.enabled === true,
    token: raw.token,
    // Saved before full control had a secret of its own: phones sign in again, once.
    controlToken: validToken(raw.controlToken) && raw.controlToken !== raw.token ? raw.controlToken : newToken(),
    // Unknown transports must not silently become a listener on every LAN interface.
    lan: raw.lan === true && (raw.transport === undefined || raw.transport === "lan" || raw.transport === "tailscale"),
    transport: raw.transport === "tailscale" ? "tailscale" : "lan",
    control: raw.control === true,
    ...(Number.isSafeInteger(raw.pairingUntil) && raw.pairingUntil > 0 ? { pairingUntil: raw.pairingUntil } : {}),
  };
  // Saved right away, or every restart would make a new one and sign the phone out again.
  if (settings.controlToken !== raw.controlToken) {
    await saveRemote(settings, file).catch((err) => logError(`Couldn't save ${file}; the full-control link changes at the next start`, err));
  }
  return settings;
}

/** remote.json files that exist but couldn't be read at load, and why. */
const unreadable = new Map<string, string>();

/** Saved through a temporary file, so a crash mid-write can't leave half a file. */
export async function saveRemote(settings: RemoteSettings, file = FILE) {
  const why = unreadable.get(file);
  if (why) throw new Error(`Phone settings can't be changed: ${file} couldn't be read when code-flow started (${why}). Fix its permissions, then restart code-flow.`);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Settings after a change from the Phone section. Turning something off signs out whatever it
 * let in: the phone link, the Wi-Fi listener or full control off makes new secrets, so turning
 * it back on later doesn't revive old links or phones' cookies. `rotate` (New link) makes both.
 */
export function changeRemote(before: RemoteSettings, patch: { enabled?: boolean; lan?: boolean; transport?: "lan" | "tailscale"; control?: boolean; rotate?: boolean }): RemoteSettings {
  const next = { ...before };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.lan === "boolean") next.lan = patch.lan;
  if (patch.transport === "lan" || patch.transport === "tailscale") next.transport = patch.transport;
  if (typeof patch.control === "boolean") next.control = patch.control;
  const turnedOff = (key: "enabled" | "lan" | "control") => before[key] && !next[key];
  const changedTransport = (before.transport ?? "lan") !== (next.transport ?? "lan");
  if (patch.rotate || turnedOff("enabled") || turnedOff("lan") || changedTransport) {
    next.token = newToken();
    next.controlToken = newToken();
  } else if (turnedOff("control")) {
    next.controlToken = newToken();
  }
  const wasControl = before.enabled && before.lan && before.control;
  const isControl = next.enabled && next.lan && next.control;
  if (isControl && (patch.rotate || changedTransport || !wasControl)) next.pairingUntil = Date.now() + 10 * 60_000;
  else if (!isControl) delete next.pairingUntil;
  return next;
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function tokenMatches(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** This machine's addresses on the local network (for the phone link). */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
}

/**
 * A connection from this machine: loopback, or any of its own addresses (a program here that
 * connects to the Wi-Fi address arrives from that address, not from 127.0.0.1). An address
 * that can't be told counts as local.
 */
export function isOwnAddress(address: string | undefined): boolean {
  if (!address) return true;
  const plain = address.replace(/^::ffff:/i, "").replace(/%.*$/, "").toLowerCase();
  if (plain === "::1" || plain === "::" || plain === "0.0.0.0" || plain.startsWith("127.")) return true;
  return Object.values(networkInterfaces())
    .flat()
    .some((i) => !!i && i.address.replace(/%.*$/, "").toLowerCase() === plain);
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATUS: Record<string, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  stopped: "Stopped at limit",
  interrupted: "Interrupted",
};

function badge(run: RunSummary): string {
  if (run.awaiting || (run.status === "running" && run.team?.awaitingRequestId)) return `<span class="b warn">Waiting for you</span>`;
  if (run.team?.status === "blocked") return `<span class="b warn">Team needs attention</span>`;
  if (run.triage?.state === "pending") return `<span class="b warn">In your inbox</span>`;
  const watch = Object.values(run.watches ?? {}).find((w) => w.state === "needs-you");
  if (watch) return `<span class="b warn">PR needs you</span>`;
  const failing = run.status === "done" && run.verdict === "failing";
  if (run.status === "done" && !failing && run.checkCantRun) return `<span class="b warn">Done · check can't run</span>`;
  const cls = run.status === "running" ? "run" : run.status === "done" && !failing ? "ok" : "bad";
  return `<span class="b ${cls}">${esc(failing ? "Done · check failing" : STATUS[run.status] ?? run.status)}</span>`;
}

const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

function page(title: string, body: string, refresh = true): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="15">' : ""}<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
:root{--bg:#f8f7f3;--raised:#fdfcf9;--sunken:#f0efe9;--text:#292a26;--muted:#65675e;--border:#e4e2da;--border-strong:#d4d2c7;--link:#2d6a4b;--mint:#36b98a;--ok:#2d6a4b;--ok-soft:#e5f4ea;--warn:#87662e;--warn-soft:#f6efdd;--bad:#a44a36;--bad-soft:#f7e9e4;--shadow:0 1px 2px rgba(34,35,24,.05);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#161713;--raised:#1e1f1a;--sunken:#121310;--text:#ecebe4;--muted:#9c9d92;--border:#2e3029;--border-strong:#3d4036;--link:#8fe3c4;--mint:#4fd0a0;--ok:#8fe3c4;--ok-soft:#19362a;--warn:#eac77f;--warn-soft:#3a2f18;--bad:#f0a08d;--bad-soft:#3d201a;--shadow:0 1px 2px rgba(0,0,0,.3);color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:16px 16px calc(32px + env(safe-area-inset-bottom))}
h1{font:400 23px/1.2 Georgia,"Times New Roman",serif;letter-spacing:-.5px;margin:8px 0 12px;overflow-wrap:anywhere}h2,h3{font-size:12px;font-weight:500;color:var(--muted);margin:24px 0 8px}
h2.project{font:400 20px/1.25 Georgia,"Times New Roman",serif;letter-spacing:-.3px;color:var(--text);margin:32px 0 0;padding-top:20px;border-top:1px solid var(--border)}
section:first-of-type h2.project{margin-top:20px;padding-top:0;border-top:0}h2.project+h3{margin-top:12px}
a{color:var(--link);text-decoration:none;font-weight:500}a:hover{text-decoration:underline}
.card{display:block;background:var(--raised);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin:8px 0;color:var(--text);font-weight:400;box-shadow:var(--shadow)}
.card:hover{border-color:var(--border-strong);text-decoration:none}
.t{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.m{font-size:12px;color:var(--muted)}.card .m{margin-top:4px}
.b{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;line-height:1;vertical-align:1px;background:var(--sunken);color:var(--text)}
.b.ok,.b.run{background:var(--ok-soft);color:var(--ok)}.b.warn{background:var(--warn-soft);color:var(--warn)}.b.bad{background:var(--bad-soft);color:var(--bad)}
.b.run:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--mint)}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--sunken);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:8px 0}
ul,ol{padding-left:20px}li{margin:6px 0}li b{font-weight:600}.foot{font-size:12px;color:var(--muted);margin-top:32px}
@media (min-width:640px){h1{font-size:26px}}
</style></head><body><main>${body}<p class="foot">Read-only view of code-flow · refreshes every 15 s</p></main></body></html>`;
}

/**
 * Render `/r/<token>/…`; `path` is what follows the token. Returns null for unknown pages.
 * `projects` are the server's: runs are listed under their project (projectOf), as in the app.
 */
export function renderRemote(manager: RunManager, projects: Project[], base: string, path: string): string | null {
  if (path === "" || path === "/") {
    const runs = manager.list().filter((r) => !r.archived);
    const needs = runs.filter((r) => r.awaiting || (r.status === "running" && r.team?.awaitingRequestId) || r.team?.status === "blocked" || r.triage?.state === "pending" || Object.values(r.watches ?? {}).some((w) => w.state === "needs-you") || (r.status !== "running" && !r.seen));
    const running = runs.filter((r) => r.status === "running" && !needs.includes(r));
    const recent = runs.filter((r) => !needs.includes(r) && !running.includes(r)).slice(0, 15);
    const card = (r: RunSummary) =>
      `<a class="card" href="${base}/run/${esc(r.id)}"><div class="t">${esc(r.task.split("\n")[0])}</div><div class="m">${badge(r)} · ${esc(r.pattern)} · ${esc(r.repo.split("/").pop())}${r.trigger ? ` · ⏱ ${esc(r.trigger.name)}` : ""} · ${ago(r.createdAt)}</div></a>`;
    const group = (tag: "h2" | "h3", title: string, list: RunSummary[]) => (list.length ? `<${tag}>${title} (${list.length})</${tag}>${list.map(card).join("")}` : "");
    const groups = (tag: "h2" | "h3", keep: (r: RunSummary) => boolean = () => true) =>
      group(tag, "Needs you", needs.filter(keep)) + group(tag, "Running", running.filter(keep)) + group(tag, "Recent", recent.filter(keep));
    // A project for each run shown: the ones that need you come first, then running, then recent; no project last.
    const ids = [...new Set([...needs, ...running, ...recent].map((r) => projectOf(r, projects)))].sort((a, b) => Number(a === undefined) - Number(b === undefined));
    const name = (id?: string) => projects.find((p) => p.id === id)?.name ?? "No project";
    const body =
      ids.length === 1 && ids[0] === undefined
        ? groups("h2") // every run in no project (or no projects at all): nothing to group by
        : ids.map((id) => `<section><h2 class="project">${esc(name(id))}</h2>${groups("h3", (r) => projectOf(r, projects) === id)}</section>`).join("");
    return page("code-flow", `<h1>code-flow</h1>${body}${runs.length ? "" : '<p class="m">No runs yet.</p>'}`);
  }
  const match = path.match(/^\/run\/([\w-]+)$/);
  const run = match ? manager.get(match[1]!) : undefined;
  if (!run) return null;
  return page(run.task.split("\n")[0]!.slice(0, 60), renderRun(run, base, projects.find((p) => p.id === projectOf(run, projects))), run.status === "running");
}

/** A run's page; it names the run's project, unless that's just named after the repo. */
function renderRun(run: Run, base: string, project?: Project): string {
  const steps = run.steps
    .map((s) => `<li>${s.status === "done" ? "✓" : s.status === "running" ? "…" : s.status === "failed" ? "✕" : "■"} ${esc(s.title)} <span class="m">${esc(s.agent ?? s.kind)}${s.endedAt ? ` · ${Math.round((s.endedAt - s.startedAt) / 1000)}s` : ""}</span></li>`)
    .join("");
  const review = run.review
    ? `<h2>Review</h2><p>${esc(run.review.verdict === "approve" ? "Approve" : "Changes requested")}${run.review.summary ? ` — ${esc(run.review.summary)}` : ""}</p><ol>${run.review.findings
        .map((f) => `<li><b>${esc(f.severity)}</b> ${esc(f.file)} — ${esc(f.problem)} <span class="m">(${esc(f.raisedBy.join(", "))})</span></li>`)
        .join("")}</ol>`
    : "";
  const watches = Object.values(run.watches ?? {})
    .map((w) => `<li>${esc(w.pr)} — <b>${esc(w.state)}</b>: ${esc(w.detail)}</li>`)
    .join("");
  const artifacts = run.artifacts.map((a) => `<li><b>${esc(a.label)}</b> <span class="m">${esc(a.branch)}</span>${a.stat ? `<pre>${esc(a.stat)}</pre>` : ""}</li>`).join("");
  const team = run.team;
  const memberName = (id: string) => id === "user" ? "You" : team?.members.find((member) => member.id === id)?.name ?? id;
  const teamView = team ? [
    `<h2>Team and workflow</h2><p>${esc(team.status)} · revision ${team.revision} · ${team.metrics.invocations} lifetime calls (${team.metrics.coordinatorInvocations} coordinating)</p>`,
    `<ul>${team.tasks.map((task) => `<li><b>${esc(task.title)}</b> · ${esc(memberName(task.owner))} · ${esc(task.status ?? "planned")}${task.dependsOn.length ? `<br><span class="m">Needs ${task.dependsOn.map((id) => esc(team.tasks.find((item) => item.id === id)?.title ?? id)).join(", ")}</span>` : ""}</li>`).join("")}</ul>`,
    team.messages.some((message) => message.kind === "question" && message.status === "open") ? `<h2>Open questions</h2><ul>${team.messages.filter((message) => message.kind === "question" && message.status === "open").map((message) => `<li><b>${esc(memberName(message.sender))} → ${esc(memberName(message.recipient))}</b>: ${esc(message.body)}${message.recipient === "user" ? `<br><span class="m">Open the full-control app or code-flow on your computer to answer.</span>` : ""}${message.deadlineAt ? `<br><span class="m">Deadline ${esc(new Date(message.deadlineAt).toLocaleString())}</span>` : ""}</li>`).join("")}</ul>` : "",
    team.gaps.length ? `<h2>Unresolved work</h2><ul>${team.gaps.map((gap) => `<li>${esc(gap)}</li>`).join("")}</ul>` : "",
    team.verification ? `<p class="m">Verification: ${esc(team.verification.check)} · independent review ${team.verification.reviewed ? team.verification.approved ? "approved" : "changes requested" : "pending"} · ${esc(team.verification.head.slice(0, 12))}</p>` : "",
  ].join("") : "";
  return [
    `<p><a href="${base}/">← All runs</a></p>`,
    `<h1>${esc(run.task.split("\n")[0])}</h1>`,
    `<p class="m">${badge(run)} · ${esc(run.pattern)} · ${project && project.name !== run.repo.split("/").pop() ? `${esc(project.name)} · ` : ""}${esc(run.repo.split("/").pop())} · started ${ago(run.createdAt)}${run.trigger ? ` · by ${run.trigger.via === "sweep" ? "sweep" : "automation"} “${esc(run.trigger.name)}”` : ""}</p>`,
    run.awaiting ? `<h2>Waiting for you</h2><p>${esc(run.awaiting.title)} — open code-flow on your computer to answer.</p><pre>${esc(run.awaiting.content.slice(0, 4_000))}</pre>` : "",
    run.triage?.state === "pending" ? "<h2>In your inbox</h2><p>Approve, revise or reject it in code-flow on your computer.</p>" : "",
    run.error ? `<h2>Error</h2><pre>${esc(run.error)}</pre>` : "",
    run.checkCantRun ? `<h2>Check</h2><p>${esc(cantRunMessage(run.checkCantRun.reason))}.</p>` : "",
    teamView,
    review || (run.summary ? `<h2>Summary</h2><pre>${esc(run.summary.slice(0, 8_000))}</pre>` : ""),
    artifacts ? `<h2>Results</h2><ul>${artifacts}</ul>` : "",
    watches ? `<h2>Pull requests</h2><ul>${watches}</ul>` : "",
    steps ? `<h2>Steps</h2><ul>${steps}</ul>` : "",
  ].join("");
}
