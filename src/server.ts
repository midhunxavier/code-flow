import { SshProjects } from "./ssh-projects/manager.js";
import { readFileSync } from "node:fs";
import { ProjectFilePolicies, FilePolicyError, assertPolicyExecution, configureFilePolicyResolver, filterPolicyDiff, policyIsRestrictive } from "./filesystem-policy.js";
import { FilesystemAccess } from "./filesystem-access.js";
import { createCodeHostsApi } from "./code-hosts-api.js";
import { FilteredTasks, FilteredTaskError } from "./filtered-tasks.js";
import { handleFilteredTasksApi } from "./filtered-tasks-api.js";
import { createServer as createSecureServer } from "node:https";
import { PhoneSessions } from "./phone-sessions.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import {
  agentAvailability,
  AGENT_IDS,
  registerProviderAdapters,
  agentCatalog,
  adapters,
  getAdapter,
  isAgentId,
  validateAgentSettings,
  type AgentId,
} from "./adapters/index.js";
import { listTree, readRepoFile, searchFiles } from "./repo-tree.js";
import { checkGit, doctor } from "./doctor.js";
import { readRepoConfig } from "./repo-config.js";
import { openFolder } from "./serve.js";
import { LaunchProfiles, LaunchProfileError, readLaunchProfiles } from "./launch-profiles.js";
import { TeamRerunError } from "./team-reruns.js";
import { ConventionsStore, ConventionsError } from "./conventions.js";
import { discoverDependencies } from "./dependency-health.js";
import { DeferredRunConflictError, sanitizeDeferredRequest } from "./deferred-runs.js";
import { createDeferredRuns, persistDeferredReceipt, recoverDeferredRuns } from "./deferred-launch.js";
import { validateContextBudget } from "./context-budget.js";
import { RetentionPolicyStore, RetentionPolicyConflictError, previewRetention } from "./retention-policy.js";
import { SharedAccounts, SharedAccountError, type SharedPrincipal } from "./shared-accounts.js";
import { canonicalSharedPath, SharedPathError } from "./shared-access.js";
import { CollaborationReviews, CollaborationReviewError } from "./collaboration-reviews.js";
import { handleSharedApi } from "./shared-api.js";
import { RemoteWorkers } from "./remote-workers/client.js";
import { createCoordinatedApi } from "./coordinated-api.js";
import { Extensions } from "./extensions.js";
import { ShellLimitError, Shells, type ShellEvent } from "./shell.js";
import { cursorSeq, StreamHub, TopicError, type TopicSource } from "./stream.js";
import { replayEvents } from "./run-log.js";
import { previewTarget, Previews } from "./preview.js";
import { SnapshotError, takeSnapshot } from "./snapshot.js";
import { Integrations } from "./integrations.js";
import { Notifications } from "./notifications.js";
import { GithubReviewThreads, ReviewThreadError } from "./github-review-threads.js";
import { approvals } from "./approvals.js";
import { validateAgentContainer } from "./agent-container.js";
import { Notes, NotesConflictError } from "./notes.js";
import { HttpError, readJson, readLoginJson, send } from "./http.js";
import { handleWorkspaceApi } from "./workspace-api.js";
import { TeamPlanEditError } from "./workflow-control.js";
import { analyzeProjectMemory } from "./memory-analysis.js";
import { redactExport } from "./privacy.js";
import { validateVerificationProfile, renderVerificationReport } from "./verification.js";
import { CODEFLOW_HOME, autoTeamEnabled, envNumber, PORT } from "./config.js";
import { RunManager, RunConflictError, UntrustedSourceError, type LoopSettings, type Pattern } from "./engine.js";
import { detectCheckCommand } from "./checks.js";
import { findPattern, patterns } from "./patterns/index.js";
import { listDirectories } from "./fs.js";
import { git, listBranches, repoRoot, worktreeRoot, type GitCwd } from "./git.js";
import { stat } from "node:fs/promises";
import { folderSizes, remoteBranches, removeWorktrees } from "./ship.js";
import { computeStats, rankAgents } from "./stats.js";
import { acquireLock, writeHealth, loadJournal } from "./store.js";
import { reapOrphanGroups } from "./adapters/process.js";
import { logError, logInfo, logWarn } from "./log.js";
import { listIssues, listPullRequests, MERGE_METHODS, type SourceInput } from "./github.js";
import { listSweep, runSweep, sourceKeys, type SweepKind } from "./sweeps.js";
import { resolveAuto } from "./routing.js";
import { improvePrompt, assertImproveEnvironment, ImproveError, MAX_IMPROVE_CHARS, type ImproveRequest } from "./improve.js";
import { templates } from "./templates.js";
import { PrWatcher } from "./watch.js";
import { Automations, describeSchedule, readWebhook, validateSchedule, previewSchedule } from "./automation.js";
import { detectTailscale, isTailscaleIPv4, type TailscaleStatus } from "./tailscale.js";
import { changeRemote, isOwnAddress, lanAddresses, loadRemote, renderRemote, saveRemote, tokenMatches, type RemoteSettings } from "./remote.js";
import { projectOf, Projects } from "./projects.js";
import { memoryStore, MemoryConflictError, type MemoryAuthority, type MemoryEntry } from "./memory.js";
import { adapterTeamCapabilities } from "./adapters/team-tools.js";
import { teamToolBridge } from "./team-tools.js";
import { teamEvaluationStore, buildTeamEvaluation, assessTeamRollout } from "./team-evaluation.js";
import type { Run, RunEvent, RunSummary, SideTurn, StartRunInput } from "./engine.js";

// One server per CODEFLOW_HOME (waits for one that is still shutting down).
const releaseLock = await acquireLock().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
const reviewThreads = new GithubReviewThreads();
process.once("exit", releaseLock);

// A stray rejection or throw must not take every live run down with it: log it and keep
// serving. A burst of uncaught exceptions means state is likely broken, so then stop cleanly
// (runs are interrupted, resumable) rather than limp on.
const recentCrashes: number[] = [];
process.on("unhandledRejection", (reason) => logError("Unhandled promise rejection", reason));
process.on("uncaughtException", (err) => {
  logError("Uncaught exception", err);
  const now = Date.now();
  recentCrashes.push(now);
  while (recentCrashes[0]! < now - 60_000) recentCrashes.shift();
  if (recentCrashes.length >= 10) void stop("too many uncaught exceptions in a minute", 1);
});

// Agents and checks a previous code-flow left running (it crashed, or its terminal closed)
// would keep editing worktrees: stop them before any run is resumed.
const reaped = await reapOrphanGroups();
if (reaped) logInfo(`Stopped ${reaped} process group(s) a previous code-flow left running`);

const extensions = new Extensions({ register: (providers, workflows) => {
  const ids = workflows.map((workflow) => workflow.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !!findPattern(id))) throw new Error("Workflow IDs must be unique and cannot replace installed patterns");
  const available = new Set([...AGENT_IDS, ...providers.map((provider) => provider.id)]);
  if (workflows.some((workflow) => workflow.roles.some((role) => role.default.some((id) => !available.has(id))))) throw new Error("Workflow default roles must name registered providers");
  registerProviderAdapters(providers); patterns.push(...workflows);
} });
const projects = new Projects();
const remoteWorkers = new RemoteWorkers();
await remoteWorkers.load().catch((error) => logError("SSH workers disabled; repair their configuration to enable remote execution", error));
const manager = new RunManager(findPattern, projects, remoteWorkers);
const filePolicies = new ProjectFilePolicies();
const fileAccess = new FilesystemAccess(filePolicies, projects, manager);
const filteredTasks = new FilteredTasks({
  authorize: async (project, repo) => {
    if (!projects.get(project)?.repos.includes(repo)) throw new FilteredTaskError("The project or its explicit repository membership changed", 409);
    const policies = await fileAccess.forRepo(repo);
    if (!projects.get(project)?.repos.includes(repo)) throw new FilteredTaskError("The project or its explicit repository membership changed", 409);
    return policies;
  },
  withRepository: (repo, operation) => manager.withIdleRepository(repo, operation, { kind: "filtered task", owner: "filtered-tasks" }),
});
let filteredTasksReady = false;
configureFilePolicyResolver((repo) => fileAccess.forRepo(repo), { suppressRepositoryCommands: () => fileAccess.hasRestrictions() });
manager.setFilesystemPolicyGuard((repo, run) => fileAccess.execution(repo, run));
let filesystemFeedRevision = 0;
filePolicies.onChange(() => { filesystemFeedRevision++; });
const policyPreparations = new Set<Promise<unknown>>();
function trackPolicyPreparation<T>(operation: () => Promise<T>): Promise<T> {
  const work = Promise.resolve().then(operation); policyPreparations.add(work);
  void work.finally(() => policyPreparations.delete(work)).catch(() => undefined); return work;
}
const conventions = new ConventionsStore();
const retentionPolicy = new RetentionPolicyStore();
const sharedAccounts = new SharedAccounts();
await sharedAccounts.load().catch((error) => logError("Shared accounts unavailable; owner recovery remains available", error));
const collaborationReviews = new CollaborationReviews();
const resolveQueuedProviders: Parameters<typeof createDeferredRuns>[1]["resolveProviders"] = (request) => trackPolicyPreparation(async () => {
    const pattern = findPattern(request.pattern);
    if (!pattern) throw new Error("This pattern no longer exists; cancel and review the saved request");
    const selection = request.loop?.remoteWorker;
    const { roles } = await validateRoles(pattern, request.roles, request.repo, selection);
    const inventory = selection ? (await manager.remoteInventory(selection)).providers : await agentAvailability();
    return { roles, installed: new Set(inventory.filter((entry) => entry.available).map((entry) => entry.id)) };
});
const deferredRuns = createDeferredRuns(manager, { build: buildStartInput, resolveProviders: resolveQueuedProviders });
const coordinatedApi = createCoordinatedApi({ manager, projects, build: buildStartInput, resolveProviders: resolveQueuedProviders });
const launchProfiles = new LaunchProfiles(manager.devServers);
manager.onWorkspaceStop((runId) => launchProfiles.stopMatching(`${runId}/`));
const integrations = new Integrations();
const codeHostsApi = createCodeHostsApi({ integrations, manager, projects, build: buildStartInput });
await integrations.load().catch((error) => logError("External sources disabled: invalid integration configuration", error));
const notifications = new Notifications();
const notificationsReady = await notifications.load().then(() => true, (error) => { logError("Notifications disabled: configuration or delivery state cannot be read", error); return false; });
/** The side panel's terminals and notes. */
const shells = new Shells();
const notes = new Notes();
const watcher = new PrWatcher(manager);
const automations = new Automations(manager, (body, extra) => trackPolicyPreparation(() => startFromBody(body, extra)), (repo, kind) => trackPolicyPreparation(async () => { assertPolicyExecution(await fileAccess.execution(repo), "Automation source discovery"); return listSweep(repo, kind, manager.list()); }));
async function pausePolicyBackground() {
  const results = await Promise.allSettled([watcher.stop(), automations.stop(), deferredRuns.stop(), coordinatedApi.service.stop(), ...(notificationsReady ? [notifications.stop()] : [])]);
  // Queue deadlines do not prove a child readiness request ended. Retain the underlying work too.
  while (policyPreparations.size) await Promise.allSettled([...policyPreparations]);
  const failure = results.find((result) => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
}
function startPolicyBackground() {
  watcher.start(); automations.start(envNumber("CODEFLOW_SCHEDULER_TICK_MS", 30_000, { min: 100 })); deferredRuns.start(); coordinatedApi.service.start();
  if (notificationsReady) notifications.start();
}
let remote: RemoteSettings;
let changingRemote: Promise<unknown> = Promise.resolve();
/** Apply each patch to the latest saved generation so concurrent tabs cannot revive old links. */
function changeSavedRemote(patch: Parameters<typeof changeRemote>[1]): Promise<RemoteSettings> {
  const change = changingRemote.catch(() => undefined).then(async () => {
    const before = remote;
    const next = changeRemote(before, patch);
    if (next.control && !phoneTls && !insecurePhoneDevelopment && patch.control === true) {
      throw new HttpError(400, "Full phone control requires HTTPS. Configure CODEFLOW_TLS_CERT and CODEFLOW_TLS_KEY, then restart Codeflow.");
    }
    // Tailscale encrypts transit, but HTTP cookies can leak to other ports on the same host.
    if (!phoneTls && !insecurePhoneDevelopment) next.control = false;
    await saveRemote(next);
    remote = next;
    return before;
  });
  changingRemote = change.catch(() => undefined);
  return change;
}
const REMOTE_PORT = envNumber("CODEFLOW_REMOTE_PORT", PORT + 1, { min: 1, max: 65_535 });
const indexHtml = fileURLToPath(new URL("../public/index.html", import.meta.url));
const HOST = "127.0.0.1";
const sshProjects = process.env.CODEFLOW_SSH_HOST ? undefined : new SshProjects({ returnUrl: `http://localhost:${PORT}/` });
const tlsConfigured = !!process.env.CODEFLOW_TLS_CERT && !!process.env.CODEFLOW_TLS_KEY;
if (!!process.env.CODEFLOW_TLS_CERT !== !!process.env.CODEFLOW_TLS_KEY) throw new Error("Configure both CODEFLOW_TLS_CERT and CODEFLOW_TLS_KEY");
const phoneTls = tlsConfigured ? { cert: readFileSync(process.env.CODEFLOW_TLS_CERT!), key: readFileSync(process.env.CODEFLOW_TLS_KEY!) } : undefined;
const insecurePhoneDevelopment = process.env.CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL === "1";
const phoneProtocol = phoneTls ? "https" : "http";
const phoneSessions = new PhoneSessions();

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
/** Local apps in the side panel's Browser, each on a port of its own (src/preview.ts). */
const previews = new Previews(
  () => [`http://localhost:${PORT}`, `http://${HOST}:${PORT}`],
  () => [PORT, REMOTE_PORT],
);

// SSH previews are revocable on this host; the local gateway adds the browser overlay.
const sshPreviews = new Previews(() => [], () => [PORT, REMOTE_PORT], undefined, false);

/** This server launches coding agents, so only accept requests from its own page. */
function checkOrigin(req: IncomingMessage) {
  if (!allowedHosts.has(req.headers.host ?? "")) throw new HttpError(403, "Bad Host header");
  const origin = req.headers.origin;
  if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) throw new HttpError(403, "Cross-origin request refused");
}

/**
 * Who may use the API. The Host/Origin checks stop web pages, but not programs on this machine
 * — including the agents code-flow runs, some of which are sandboxed with network access and
 * could otherwise ask this server to run a command outside their sandbox. So the API needs a
 * session cookie that only a browser holds.
 *
 * The token lives only in this process's memory. The first browser to open code-flow gets the
 * cookie ("claims" it) — until a browser has signed in (by claiming it, with the link or with a
 * cookie it already has) or code-flow first starts an agent, a check, or an app, whichever comes
 * first. After that nothing on this machine that isn't already signed in can claim it. Any other
 * browser uses the link printed at startup (`/?token=…`). Scripts can send the token as a
 * Bearer header.
 */
const auth = {
  token: process.env.CODEFLOW_TOKEN || randomBytes(24).toString("hex"),
  claimable: !process.env.CODEFLOW_SSH_HOST && sharedAccounts.available && !sharedAccounts.hasUsers,
};
sharedAccounts.onChange(() => { auth.claimable = false; });
manager.onActivity(() => (auth.claimable = false));
const COOKIE = "codeflow_session";
const SHARED_COOKIE = `codeflow_shared_${PORT}`;
/**
 * Room for a big Cookie header. Cookies ignore ports, so every app on this host name (one in the
 * Browser's preview too) adds to what the browser sends code-flow; Chrome keeps up to 180 of 4 KB
 * each. With Node's default (16 KB), a page that filled the jar would lock you out of code-flow,
 * the ?token= link included, until you cleared the site's data.
 */
const MAX_HEADER_SIZE = 1024 * 1024;

/**
 * Only a browser on this machine may claim the session. The Host header alone doesn't say so:
 * a tunnel (ngrok, cloudflared) forwarding to this port can rewrite it to localhost, and then
 * the first stranger through the tunnel would sign in. Its connection still comes from the
 * tunnel's process on this machine, so the forwarding headers it adds are what give it away.
 */
function mayClaim(req: IncomingMessage): boolean {
  const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip"].some((h) => req.headers[h] !== undefined);
  const address = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
  return auth.claimable && !forwarded && (address === "::1" || address.startsWith("127."));
}

function sharedTransport(req: IncomingMessage) {
  const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip"].some((header) => req.headers[header] !== undefined);
  const address = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
  return { address, secure: (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true, loopback: !forwarded && (address === "::1" || /^127\./.test(address)) };
}
function sharedMutation(req: IncomingMessage) {
  if (!req.headers.origin || !/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(403, "Shared sign-in and mutations require same-origin JSON requests");
}
const clearCookie = (name: string) => `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
function sharedCookie(token: string, secure: boolean) { return `${SHARED_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`; }
function sharedSession(req: IncomingMessage): { token: string; identity: SharedPrincipal } | undefined {
  const transport = sharedTransport(req);
  if (!transport.secure && !transport.loopback) return;
  for (const token of readCookies(req, SHARED_COOKIE)) { const identity = sharedAccounts.authenticate(token); if (identity) return { token, identity }; }
}

function sessionCookie(): string {
  return `${COOKIE}=${auth.token}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * Every value a cookie has in the request. Cookies ignore ports, so a page on another port of this
 * host (an app in the Browser's preview, say) can set one of the same name with a narrower path,
 * which the browser sends first; it can't replace ours (HttpOnly), so ours is still among them.
 */
function readCookies(req: IncomingMessage, name: string): string[] {
  return String(req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith(`${name}=`))
    .map((c) => c.slice(name.length + 1))
    .filter(Boolean);
}

function signedIn(req: IncomingMessage): boolean {
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (bearer && tokenMatches(bearer, auth.token)) return true;
  return readCookies(req, COOKIE).some((cookie) => tokenMatches(cookie, auth.token));
}

/**
 * Phones sign in with the phone link instead, when full control from the phone is on: opening
 * `/r/<controlToken>` on the network listener sets this cookie and opens the app. That secret is
 * full control's own (the read-only link never signs a phone in) and is saved in remote.json,
 * so the phone stays signed in across restarts for up to 30 days, until you make a new link or
 * turn phone control, the Wi-Fi listener or the phone link off. The name carries the port
 * because cookies ignore ports, and a second code-flow on this machine has a link of its own.
 */
const PHONE_COOKIE = `codeflow_phone_${REMOTE_PORT}`;
const PHONE_COOKIE_DAYS = 30;
const phoneControl = (s: RemoteSettings = remote) => s.enabled && s.lan && s.control && (!!phoneTls || insecurePhoneDevelopment);

function phoneCookie(token: string): string {
  return `${PHONE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${phoneTls ? "; Secure" : ""}; Max-Age=${PHONE_COOKIE_DAYS * 86_400}`;
}

function phoneSignedIn(req: IncomingMessage): boolean {
  return phoneControl() && readCookies(req, PHONE_COOKIE).some((cookie) => phoneSessions.valid(cookie, remote.controlToken));
}

/**
 * The network listener has no fixed host name to check (Wi-Fi addresses change, VPNs add their
 * own), so it only refuses cross-origin requests. A page that rebinds its own name to this
 * address still can't use it: the phone's cookie belongs to the address it signed in on.
 */
function checkLanOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (origin && origin !== `${phoneProtocol}://${req.headers.host}`) throw new HttpError(403, "Cross-origin request refused");
}

const lockedPage = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>code-flow — ${title}</title><style>
:root{--bg:#f8f7f3;--raised:#fdfcf9;--sunken:#f0efe9;--border:#e4e2da;--text:#292a26;--muted:#65675e;--link:#2d6a4b;--shadow:0 2px 6px rgba(34,35,24,.06),0 24px 64px rgba(34,35,24,.16);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#161713;--raised:#1e1f1a;--sunken:#121310;--border:#2e3029;--text:#ecebe4;--muted:#9c9d92;--link:#8fe3c4;--shadow:0 2px 6px rgba(0,0,0,.35),0 24px 64px rgba(0,0,0,.55);color-scheme:dark}}
body{margin:0;padding:0 16px;background:var(--bg);color:var(--text);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:480px;margin:12vh auto;padding:24px;background:var(--raised);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow)}
.brand{font-size:15px;font-weight:600;letter-spacing:-.4px;margin:0 0 18px}.brand span{font-weight:400}
h1{font:400 24px/1.2 Georgia,"Times New Roman",serif;letter-spacing:-.5px;margin:0 0 12px}p{color:var(--muted);margin:8px 0}b{color:var(--text);font-weight:600}a{color:var(--link);font-weight:500}
code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text);background:var(--sunken);padding:1px 5px;border-radius:6px;overflow-wrap:anywhere}
</style></head><body><main><div class="brand">code<span>-flow</span></div>${body}</main></body></html>`;

const LOCKED_PAGE = lockedPage(
  "sign in",
  `<h1>Open code-flow from its link</h1>
<p>This code-flow server is already in use, so it only accepts browsers that open it with its link.</p>
<p>Find the line <code>Open http://localhost:${PORT}/?token=…</code> where code-flow was started (the terminal, or the preview's server log) and open that link here.</p>
<p>Restarting code-flow and reloading this page also works, as long as no run has started yet.</p>`,
);

const PHONE_LOCKED_PAGE = lockedPage(
  "scan the QR code",
  `<h1>Scan the QR code again</h1>
<p>This phone isn't signed in to code-flow. On your computer, open code-flow's <b>Automations</b> page and scan the QR code under <b>Remote access</b>.</p>
<p>Making a new link, or turning off full control from your phone, signs phones out.</p>`,
);

/**
 * What the full-control link answers with: it sets the phone's cookie, then moves on to the app.
 * Not a redirect: a QR scanner hands the link to the browser from another app, so the browser
 * counts it as a cross-site navigation and leaves the SameSite=Strict cookie off a redirect that
 * follows — the phone would land on "Scan the QR code again". This page moving on by itself is
 * same-site, so the cookie goes along; `replace` keeps the link out of the phone's history.
 */
const signingInPage = (target: string) =>
  lockedPage("signing in", `<h1>Signing in…</h1><p><a href="${target}">Open code-flow</a></p><script>location.replace(${JSON.stringify(target)})</script>`);

/**
 * code-flow's pages are never shown inside another page: one elsewhere could lay the app under a
 * decoy and have you click its buttons. The side panel's Browser never frames this page either:
 * it frames apps through their previews, each on a port of its own (src/preview.ts), and a panel
 * popped out is a window of its own.
 */
const NO_FRAMES = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };

/**
 * The app page, public/index.html: the whole UI in one file, about 800 KB, and a third of that
 * compressed. It's compressed once per version of the file rather than per request, and read
 * again once the file changes, so a rebuild shows on the next reload without a restart. The ETag
 * is a hash of the page: with `no-cache` a reload asks again, and gets a 304 instead of the bundle
 * when nothing changed.
 */
interface AppPage {
  hash: string;
  identity: Buffer;
  br: Buffer;
  gzip: Buffer;
}
let appPage: { version: string; page: Promise<AppPage> } | undefined;
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

async function loadAppPage(): Promise<AppPage> {
  const file = await stat(indexHtml);
  const version = `${file.mtimeMs}:${file.size}`;
  if (appPage?.version !== version) {
    const page = (async () => {
      const identity = await readFile(indexHtml);
      const [br, gz] = await Promise.all([
        // Quality 9 rather than brotli's 11: about as small, and ready in a fraction of the time after a rebuild.
        compressBrotli(identity, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: identity.length } }),
        compressGzip(identity, { level: 9 }),
      ]);
      return { hash: createHash("sha256").update(identity).digest("base64url").slice(0, 32), identity, br, gzip: gz };
    })();
    appPage = { version, page };
    // A failed read isn't kept: the next request reads the file again.
    page.catch(() => appPage?.page === page && (appPage = undefined));
  }
  return appPage.page;
}

/** Whether the request takes this content coding: Accept-Encoding names it (or `*`), and not with q=0. */
function acceptsCoding(req: IncomingMessage, coding: string): boolean {
  let any = false;
  for (const part of String(req.headers["accept-encoding"] ?? "").split(",")) {
    const [name, ...params] = part.split(";").map((p) => p.trim().toLowerCase());
    const q = params.find((p) => p.startsWith("q="));
    const ok = !q || Number(q.slice(2)) > 0;
    if (name === coding) return ok;
    if (name === "*") any = ok;
  }
  return any;
}

/**
 * The app page, compressed when the browser takes it, or a 304 when the copy it has is current.
 * Each coding has an ETag of its own (they're different bytes). A response that signs the browser
 * in always has the page, so the cookie isn't left to how a browser treats one on a 304.
 */
async function sendAppPage(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>) {
  const page = await loadAppPage();
  const coding = acceptsCoding(req, "br") ? "br" : acceptsCoding(req, "gzip") ? "gzip" : undefined;
  const etag = `"${page.hash}${coding ? `-${coding}` : ""}"`;
  const common = { ...headers, etag, vary: "Accept-Encoding", "cache-control": "private, no-cache" };
  const cached = String(req.headers["if-none-match"] ?? "")
    .split(",")
    .some((tag) => tag.trim().replace(/^W\//, "") === etag);
  if (cached && !headers["set-cookie"]) {
    res.writeHead(304, common);
    return res.end();
  }
  const body = coding ? page[coding] : page.identity;
  res.writeHead(200, { ...common, "content-type": "text/html; charset=utf-8", "content-length": body.length, ...(coding ? { "content-encoding": coding } : {}) });
  res.end(body);
}

/** Run an action whose errors are the user's to fix (shown as 400 with the message). */
async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(err instanceof TeamPlanEditError || err instanceof TeamRerunError || err instanceof ConventionsError || err instanceof SharedAccountError || err instanceof SharedPathError || err instanceof CollaborationReviewError || err instanceof FilePolicyError ? err.status : err instanceof MemoryConflictError || err instanceof RunConflictError || err instanceof DeferredRunConflictError || err instanceof RetentionPolicyConflictError ? 409 : 400, (err as Error).message);
  }
}

async function requestedRepo(url: URL): Promise<string> {
  return validRepo(url.searchParams.get("repo") ?? "");
}

async function validRepo(requested: string): Promise<string> {
  if (!requested.startsWith("/")) throw new HttpError(400, "Repository must be an absolute path");
  return repoRoot(requested).catch(() => {
    throw new HttpError(400, "Not a git repository");
  });
}

/**
 * The folder the Files panel asks about. A run's worktree comes with the git folder its run's
 * repository has for it (see worktreeGit): agents can rewrite the worktree's `.git`, and git
 * finding the repository through it would read a config of theirs.
 */
async function requestedFolder(url: URL): Promise<GitCwd> {
  const requested = url.searchParams.get("repo") ?? "";
  const worktree = requested.startsWith("/")
    ? await manager.worktreeAt(requested).catch((err: Error) => {
        throw new HttpError(400, err.message);
      })
    : undefined;
  return worktree ?? requestedRepo(url);
}

function describePattern(p: Pattern) {
  const { run: _run, ...rest } = p;
  return rest;
}

/** The agents (or "auto") asked for in each of the pattern's roles. */
function requestedRoles(pattern: Pattern, input: unknown): Record<string, string[]> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const requested: Record<string, string[]> = {};
  for (const spec of pattern.roles) {
    const value = raw[spec.id];
    const list = (Array.isArray(value) ? value : value ? [value] : []).filter((v): v is string => v === "auto" || isAgentId(v));
    requested[spec.id] = spec.multiple ? list.slice(0, 6) : list.slice(0, 1);
  }
  return requested;
}

/** Who fills each role; "auto" picks an installed agent whose plan has room (see routing.ts). */
async function validateRoles(pattern: Pattern, input: unknown, repo?: string, remoteWorker?: LoopSettings["remoteWorker"]): Promise<{ roles: Record<string, AgentId[]>; notes: string[] }> {
  assertPolicyExecution(await fileAccess.execution(repo ?? ""), "Provider selection");
  const requested = requestedRoles(pattern, input);
  const inventory = remoteWorker ? (await manager.remoteInventory(remoteWorker)).providers : await agentAvailability();
  const installed = new Set(inventory.filter((a) => a.available).map((a) => a.id));
  if (pattern.id === "auto-team") {
    const supplied = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (!Array.isArray(supplied.coordinator)) requested.coordinator = ["auto"];
    if (!Array.isArray(supplied.pool)) requested.pool = [...installed];
  }
  const wantsAuto = Object.values(requested).some((list) => list.includes("auto"));
  const rank = wantsAuto && repo ? rankAgents(manager.list(), repo, { pattern: pattern.id }) : undefined;
  const resolved = resolveAuto(requested, manager.quotaForWorker(remoteWorker?.workerId), installed, rank);
  const roles: Record<string, AgentId[]> = {};
  const needed = new Set<AgentId>();
  for (const spec of pattern.roles) {
    const list = resolved.roles[spec.id] ?? [];
    const agents = spec.multiple ? [...new Set(list)] : list.slice(0, 1);
    if (agents.length === 0 && !spec.optional) throw new HttpError(400, `Pick an agent for "${spec.label}"`);
    if (pattern.id !== "auto-team" || spec.id !== "pool") agents.forEach((a) => needed.add(a));
    roles[spec.id] = agents;
  }
  if (pattern.id === "auto-team" && !roles.pool?.some((agent) => installed.has(agent))) throw new HttpError(400, "Select at least one available provider for the worker pool");
  for (const agent of needed) {
    if (!installed.has(agent)) {
      throw new HttpError(400, `${getAdapter(agent).displayName} (\`${getAdapter(agent).binary}\`) is not installed or not on PATH`);
    }
  }
  return { roles, notes: resolved.notes };
}

/** Improve turns running now: a few at most, since each one is a CLI process. */
let improving = 0;
const MAX_IMPROVING = 3;
const improvingControllers = new Set<AbortController>();

/** The composer's Improve: rewrite the task in one read-only turn (see improve.ts). */
async function improveTask(body: any, res: ServerResponse) {
  if (body.execution !== undefined && body.execution !== "local" || body.remoteWorker || body.agentContainer || body.loop?.remoteWorker || body.loop?.agentContainer) throw new HttpError(400, "Prompt improvement supports local execution only; remote and container profiles cannot fall back to a host CLI");
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) throw new HttpError(400, "Write a task to improve first");
  if (text.length > MAX_IMPROVE_CHARS) throw new HttpError(400, `The task is too long to improve (${MAX_IMPROVE_CHARS.toLocaleString("en")} characters at most)`);
  const stop = new AbortController();
  res.once("close", () => stop.abort());
  if (res.destroyed || res.writableEnded) stop.abort();
  const request: ImproveRequest = {
    text,
    repo: await validRepo(typeof body.repo === "string" ? body.repo : ""),
    mode: body.mode === "repo" ? "repo" : "quick",
    context: Array.isArray(body.context) ? body.context.filter((p: unknown): p is string => typeof p === "string" && !!p.trim()).slice(0, 50).map((p: string) => p.slice(0, 300)) : [],
    source:
      body.source && ["issue", "pr", "alert"].includes(body.source.kind) && Number.isInteger(body.source.number)
        ? { kind: body.source.kind, number: body.source.number, title: typeof body.source.title === "string" ? body.source.title.slice(0, 200) : undefined }
        : undefined,
  };
  if (improving >= MAX_IMPROVING) throw new HttpError(429, "Other tasks are being improved right now. Try again in a moment.");
  // Closing the request (Stop in the composer, or leaving the page) stops the turn.
  improving++; improvingControllers.add(stop);
  try {
    return await attempt(() => manager.withIdleRepository(request.repo, async () => {
      await manager.assertExecutionAllowed(request.repo, undefined, "Prompt improvement");
      stop.signal.throwIfAborted();
      const installed = new Set((await agentAvailability()).filter((a) => a.available).map((a) => a.id));
      stop.signal.throwIfAborted();
      const agent = resolveAuto({ improve: [isAgentId(body.agent) ? body.agent : "auto"] }, manager.quota, installed).roles.improve?.[0];
      if (!agent) throw new HttpError(400, "Install the Claude Code, Codex or Antigravity CLI to improve tasks");
      if (!installed.has(agent)) throw new HttpError(400, `${getAdapter(agent).displayName} (\`${getAdapter(agent).binary}\`) is not installed or not on PATH`);
      await manager.assertExecutionAllowed(request.repo, undefined, "Prompt improvement");
      stop.signal.throwIfAborted(); manager.noteActivity();
      try {
        const result = await improvePrompt(agent, request, { signal: stop.signal, onEvent: (event) => { if (event.kind === "quota") manager.recordQuota(agent, event.status, event.windows); } });
        return send(res, 200, { ...result, agent });
      } catch (error) {
        if (!(error instanceof ImproveError)) throw error;
        if (error.kind === "usage_limit") manager.recordLimit(agent, error.resetsAt);
        if (error.kind === "auth") manager.recordQuota(agent, "signed_out", {});
        throw new HttpError(502, error.message);
      }
    }, { kind: "prompt improvement", owner: "composer" }));
  } finally {
    improving--; improvingControllers.delete(stop);
  }
}

/** { kind: "issue" | "pr", number, ciLogs? } or { kind: "alert", tool, number, numbers? } — where a run starts from on GitHub. */
/** A side chat's turn as the UI sends it: which chat (an id it made up), Ask or Change, and a title. */
function sideTurn(input: unknown): SideTurn {
  const v = (input ?? {}) as Record<string, unknown>;
  const chat = typeof v.chat === "string" ? v.chat : "";
  if (!/^[a-z0-9-]{1,40}$/.test(chat)) throw new HttpError(400, "A side chat needs an id: up to 40 lowercase letters, digits or dashes");
  if (v.mode !== "ask" && v.mode !== "change") throw new HttpError(400, 'A side chat is "ask" or "change"');
  const title = typeof v.title === "string" ? v.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return { chat, mode: v.mode, title: title || "Side chat" };
}

function validateSource(input: unknown): SourceInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const number = Number(raw.number);
  if (raw.kind !== "issue" && raw.kind !== "pr" && raw.kind !== "alert") throw new HttpError(400, "Source must be an issue, a pull request or an alert");
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, "Source needs an issue, PR or alert number");
  if (raw.kind !== "alert") return { kind: raw.kind, number, ciLogs: raw.ciLogs === true };
  if (raw.tool !== "dependabot" && raw.tool !== "code-scanning") throw new HttpError(400, "An alert comes from Dependabot or code scanning");
  const numbers = Array.isArray(raw.numbers) ? [...new Set(raw.numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50) : [];
  return { kind: "alert", tool: raw.tool, number, numbers: numbers.length ? numbers : undefined };
}

const SWEEP_KINDS: SweepKind[] = ["issues", "dependabot", "alerts"];
/** Most runs one sweep starts at once; agents and checks still queue behind CODEFLOW_MAX_AGENTS/CHECKS. */
const MAX_SWEEP = 25;

/**
 * Start a sweep: one run per item, each starting from its issue, PR or alert, with its result in
 * the inbox. `run` is the composer's run request (team, check, settings) shared by every item.
 * With a schedule, the sweep is also saved as an automation that starts runs for new items.
 */
async function startSweep(body: Record<string, any>) {
  const kind = body.kind as SweepKind;
  if (!SWEEP_KINDS.includes(kind)) throw new HttpError(400, "Unknown kind of sweep");
  const name = String(body.name ?? "").trim().slice(0, 80) || "Sweep";
  const base = body.run && typeof body.run === "object" ? body.run : {};
  const items: { key: string; task: string; source: SourceInput }[] = [];
  for (const i of Array.isArray(body.items) ? body.items : []) {
    const item = { key: String(i?.key ?? "").slice(0, 200), task: String(i?.task ?? "").trim().slice(0, 4_000), source: validateSource(i?.source) };
    if (!item.key || !item.task || !item.source) throw new HttpError(400, "Every item needs a task and a source");
    items.push({ ...item, source: item.source });
  }
  if (!items.length) throw new HttpError(400, "Pick at least one item");
  if (items.length > MAX_SWEEP) throw new HttpError(400, `Pick at most ${MAX_SWEEP} items; the rest can go in a later sweep`);
  const repo = (await buildStartInput({ ...base, task: items[0]!.task })).repo; // same checks as one run, before any starts
  const root = await repoRoot(repo);
  const schedule = body.schedule ? await attempt(async () => validateSchedule(body.schedule)) : undefined;
  const id = `s-${randomBytes(4).toString("hex")}`;
  const saved = schedule
    ? await automations.create({ name, enabled: true, run: { ...automationRun({ ...base, task: templates.find((t) => t.sweep === kind)?.task ?? name }), source: undefined }, schedule, webhook: false, isolate: false, sweep: { kind, max: Math.min(10, Math.max(1, Number(body.max) || 5)) } })
    : undefined;
  const trigger = { id: saved?.id ?? id, name, via: "sweep" as const };
  const outcome = await runSweep({
    repo: root,
    items,
    runs: manager.list(),
    start: (item) => startFromBody({ ...base, task: item.task, source: item.source }, { trigger }),
  });
  if (saved) {
    const started = new Set(outcome.started.map((s) => s.key));
    await automations.markHandled(saved.id, items.filter((i) => started.has(i.key)).flatMap((i) => sourceKeys(i.source)));
  }
  return { sweep: trigger.id, automation: saved?.id, ...outcome };
}

/** Per-role model/effort overrides: { role: { agent: { model, effort } } }, each validated like agentSettings. */
function validateRoleSettings(input: unknown): Record<string, ReturnType<typeof validateAgentSettings>> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, ReturnType<typeof validateAgentSettings>> = {};
  for (const [role, settings] of Object.entries(raw)) {
    if (!/^[\w-]{1,40}$/.test(role)) continue;
    try {
      const valid = validateAgentSettings(settings);
      if (Object.keys(valid).length) out[role] = valid;
    } catch (err) {
      throw new HttpError(400, `${role}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** "Done when" check and budgets from the client; commands are the user's own shell commands. */
function validateLoop(input: unknown): Partial<LoopSettings> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let remoteWorker: LoopSettings["remoteWorker"];
  if (raw.remoteWorker !== undefined) {
    const value = raw.remoteWorker as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["workerId", "repoMapping"].includes(key)) || typeof value.workerId !== "string" || typeof value.repoMapping !== "string" || !remoteWorkers.list().some((worker) => worker.id === value.workerId && worker.repoMappings.includes(value.repoMapping as string))) throw new HttpError(400, "Choose an explicitly registered remote worker and repository mapping");
    remoteWorker = { workerId: value.workerId, repoMapping: value.repoMapping };
  }
  const text = (key: string) => {
    const value = typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
    if (value.length > 1_000) throw new HttpError(400, `${key} command is too long`);
    if (/[\r\n]/.test(value)) throw new HttpError(400, `${key} command must be a single line`);
    return value || undefined;
  };
  const number = (key: string, min: number, max: number) => {
    const n = Number(raw[key]);
    return raw[key] === undefined || raw[key] === "" || !Number.isFinite(n) ? undefined : Math.min(max, Math.max(min, n));
  };
  return {
    remoteWorker,
    check: text("check"),
    setup: text("setup"),
    copy: Array.isArray(raw.copy) ? raw.copy.filter((p): p is string => typeof p === "string" && !!p.trim()).slice(0, 50) : undefined,
    maxMinutes: number("maxMinutes", 1, 720),
    maxSteps: number("maxSteps", 1, 200),
    maxInvocations: number("maxInvocations", 1, 200),
    maxTokens: number("maxTokens", 1, 1_000_000_000),
    maxCostUsd: number("maxCostUsd", 0.001, 1_000_000),
    contextBudget: validateContextBudget(raw.contextBudget),
    checkTimeoutMin: number("checkTimeoutMin", 1, 120),
  };
}

function validateOptions(pattern: Pattern, input: unknown): Record<string, number | boolean> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const options: Record<string, number | boolean> = {};
  for (const spec of pattern.options) {
    const value = raw[spec.id];
    if (spec.type === "boolean") {
      options[spec.id] = typeof value === "boolean" ? value : (spec.default as boolean);
    } else {
      const n = typeof value === "number" ? value : Number(value);
      const fallback = spec.default as number;
      const clamped = Number.isFinite(n) ? Math.min(spec.max ?? n, Math.max(spec.min ?? n, Math.round(n))) : fallback;
      options[spec.id] = clamped;
    }
  }
  return options;
}

/** Validate a run request (from the composer or an automation) into what the engine starts. */
async function buildStartInput(body: Record<string, any>): Promise<StartRunInput> {
  if (body.deferred !== undefined || body.teamRerun !== undefined || body.coordination !== undefined || body.requireProjectRepo !== undefined) throw new HttpError(400, "Launch identities and selective rerun seeds are assigned by the server");
  const pattern = findPattern(String(body.pattern ?? ""));
  if (!pattern) throw new HttpError(400, "Unknown pattern");
  const task = String(body.task ?? "").trim();
  const repo = String(body.repo ?? "").trim();
  if (!task) throw new HttpError(400, "Describe the task");
  if (!repo.startsWith("/")) throw new HttpError(400, "Repository must be an absolute path");
  await attempt(async () => assertPolicyExecution(await fileAccess.execution(repo), "Run preparation"));
  if (body.externalSource !== undefined || (body.externalSourceId !== undefined && typeof body.externalSourceId !== "string")) throw new HttpError(400, "Import the external source through its configured integration first");
  if (body.externalSourceId !== undefined && body.externalSourceRef !== undefined) throw new HttpError(400, "Choose one external source reference");
  const loop = validateLoop(body.loop);
  const { roles, notes } = await validateRoles(pattern, body.roles, await repoRoot(repo).catch(() => repo), loop.remoteWorker);
  let externalSource = typeof body.externalSourceId === "string" ? await attempt(async () => integrations.resolveSource(body.externalSourceId)) : undefined;
  if (body.externalSourceRef) {
    const ref = body.externalSourceRef;
    if (typeof ref.integration !== "string" || !["issue", "pr"].includes(ref.kind) || typeof ref.key !== "string") throw new HttpError(400, "Choose a configured external source");
    externalSource = await attempt(() => integrations.importSource(ref.integration, ref.kind, ref.key));
  }
  if (externalSource && body.source) throw new HttpError(400, "Choose one external source for this run");
  if (body.loop?.verification) loop.verification = await attempt(async () => validateVerificationProfile(body.loop.verification));
  if (body.loop?.agentContainer) loop.agentContainer = await attempt(async () => validateAgentContainer(body.loop.agentContainer));
  if (loop.remoteWorker && (body.approvals?.tools || loop.agentContainer)) throw new HttpError(400, "Remote workers use their provisioned isolation profile and cannot wait for native tool approvals");
  const container = body.loop?.container;
  if (container && typeof container.image === "string" && /^[\w./:@-]{1,200}$/.test(container.image)) {
    loop.container = { image: container.image, network: container.network !== false };
  }
  return {
    pattern,
    task,
    repo,
    project: typeof body.project === "string" && body.project ? body.project : undefined,
    baseRef: body.baseRef ? String(body.baseRef) : undefined,
    branchPrefix: body.branchPrefix ? String(body.branchPrefix) : undefined,
    context: body.context && typeof body.context === "object" ? body.context : undefined,
    loop,
    approvals: { plan: typeof body.approvals?.plan === "boolean" ? body.approvals.plan : pattern.id === "auto-team", tools: body.approvals?.tools === true },
    parentRunId: typeof body.parentRunId === "string" && manager.get(body.parentRunId) ? body.parentRunId : undefined,
    trust: ["safe", "standard", "trusted", "full"].includes(body.trust) ? body.trust : undefined,
    roleSettings: validateRoleSettings(body.roleSettings),
    agentSettings: (() => {
      try {
        return validateAgentSettings(body.agentSettings);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    })(),
    source: validateSource(body.source),
    externalSource,
    allowUntrusted: body.allowUntrusted === true,
    routing: notes,
    roles,
    options: validateOptions(pattern, body.options),
  };
}

/**
 * `untrustedText`: the task carries a webhook caller's text (fenced there already, see
 * automation.ts), so the run is marked the way the engine marks a Dependabot PR's words.
 */
async function startFromBody(body: Record<string, any>, extra: { trigger?: Run["trigger"]; group?: Run["group"]; untrustedText?: boolean } = {}): Promise<Run> {
  const input = await buildStartInput(body);
  return attempt(() => manager.start({ ...input, ...extra }).catch((err: Error) => {
    if (err instanceof UntrustedSourceError) throw Object.assign(new HttpError(409, err.message), { confirm: "allowUntrusted" });
    throw err;
  }));
}

/** The parts of a run request an automation keeps (no attachments: they'd go stale). */
function automationRun(body: Record<string, any>) {
  const keep = ["repo", "project", "pattern", "task", "roles", "options", "baseRef", "loop", "trust", "agentSettings", "roleSettings", "source"];
  const run: Record<string, any> = Object.fromEntries(keep.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  if (typeof body.externalSourceId === "string") {
    try { const source = integrations.resolveSource(body.externalSourceId); run.externalSourceRef = { integration: source.integration, kind: source.kind, key: source.key }; }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }
  else if (body.externalSourceRef) run.externalSourceRef = body.externalSourceRef;
  if (Array.isArray(body.context?.paths)) run.context = { paths: body.context.paths.map((p: any) => ({ path: String(p.path ?? "") })) };
  return run as { repo: string; pattern: string; task: string };
}

function describeAutomation(t: ReturnType<typeof automations.list>[number]) {
  return { ...t, scheduleText: describeSchedule(t.schedule), hookPath: `/hooks/${t.id}` };
}

/** Unauthenticated-origin routes with their own tokens: webhooks and the phone link. */
async function handlePublic(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], via: Via): Promise<boolean> {
  if (parts[0] === "hooks" && parts[1] && req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new HttpError(413, "Payload too large");
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    let caller;
    try {
      caller = automations.authorize(parts[1], req.headers, raw);
    } catch (err) {
      throw new HttpError((err as { status?: number }).status ?? 401, (err as Error).message);
    }
    if (req.headers["x-github-event"] === "ping") return send(res, 200, { ok: true, pong: true }), true;
    let payload: unknown = {};
    try {
      payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      throw new HttpError(400, "Expected a JSON body");
    }
    const wanted = readWebhook(req.headers, payload);
    if (!wanted) return send(res, 200, { ignored: "This event doesn't start a run" }), true;
    // Answered before the run starts: GitHub gives up on a delivery after 10 seconds. Whether it
    // started, waits for a running run, or why not, shows on the automation.
    // A signed body is checked for replays too, with or without a delivery id: the id isn't signed.
    const delivery = typeof req.headers["x-github-delivery"] === "string" ? req.headers["x-github-delivery"].slice(0, 100) : undefined;
    const accepted = automations.accept(caller.trigger.id, wanted, delivery, caller.signed ? raw : undefined);
    send(res, "ignored" in accepted ? 200 : 202, "ignored" in accepted ? accepted : { accepted: true, automation: caller.trigger.id });
    return true;
  }
  if (parts[0] === "r" && req.method === "GET") {
    const token = parts[1] ?? "";
    if (!remote.enabled) throw new HttpError(404, "Not found");
    const base = `/r/${token}`;
    if (via === "lan" && phoneControl() && tokenMatches(token, remote.controlToken)) {
      if (Date.now() >= (remote.pairingUntil ?? 0)) throw new HttpError(403, "This pairing link expired. Choose New link on this computer to pair a phone.");
      const paired = await phoneSessions.pair(String(req.headers["user-agent"] ?? "Phone"), remote.controlToken);
      const run = url.pathname.slice(base.length).match(/^\/run\/([\w-]+)$/)?.[1];
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": phoneCookie(paired.token), "cache-control": "no-store", ...NO_FRAMES, "referrer-policy": "no-referrer" });
      res.end(signingInPage(run ? `/#/run/${run}` : "/"));
      return true;
    }
    // The read-only link only ever shows the read-only view, whatever is turned on.
    if (!tokenMatches(token, remote.token)) throw new HttpError(404, "Not found");
    if (fileAccess.hasRestrictions()) throw new HttpError(403, "Phone views are unavailable under custom filesystem restrictions");
    const html = renderRemote(manager, projects.list(), base, url.pathname.slice(base.length));
    if (!html) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...NO_FRAMES, "referrer-policy": "no-referrer" });
    res.end(html);
    return true;
  }
  return false;
}

function remoteInfo() {
  // What the QR code opens: with full control the sign-in link, otherwise the read-only view.
  const phonePath = `/r/${phoneControl() ? remote.controlToken : remote.token}`;
  const ready = remote.enabled && remote.lan && lanServer?.listening && lanHost === networkHost() && !lanError;
  const tailscaleHost = phoneTls && tailscaleStatus.dnsName ? tailscaleStatus.dnsName : tailscaleStatus.ip;
  return {
    enabled: remote.enabled,
    lan: remote.lan,
    transport: remote.transport ?? "lan",
    tailscale: tailscaleStatus,
    tailscaleUrl: ready && remote.transport === "tailscale" ? `${phoneProtocol}://${tailscaleHost}:${REMOTE_PORT}${phonePath}` : undefined,
    control: phoneControl(),
    secure: !!phoneTls,
    insecureDevelopment: insecurePhoneDevelopment,
    pairingUntil: remote.pairingUntil ?? 0,
    path: `/r/${remote.token}`,
    phonePath,
    local: `http://localhost:${PORT}/r/${remote.token}`,
    lanUrls: ready && remote.transport !== "tailscale" ? lanAddresses().map((ip) => `${phoneProtocol}://${ip}:${REMOTE_PORT}${phonePath}`) : [],
    lanError: remote.enabled && remote.lan ? lanError : undefined,
  };
}

/**
 * A second listener on your network for your phone and webhooks: the phone view, or with phone
 * control the whole app for a phone signed in with the phone link. `signOut` drops the phones'
 * open connections (their live event streams would otherwise keep going).
 *
 * It refuses connections from this machine itself. Programs here (the agents code-flow runs
 * among them) can read ~/.codeflow, phone secrets included; through this listener they could
 * sign in with full control and run anything outside their sandboxes. Binding only to the Wi-Fi
 * addresses wouldn't stop that — a program here can connect to those as well, and its
 * connection then comes from that same address — so each connection's source is checked
 * against all of this machine's addresses instead. CODEFLOW_LAN_ALLOW_LOCAL=1 lifts this for
 * tests that play the phone on the same machine.
 */
let lanServer: ReturnType<typeof createServer> | undefined;
let lanHost: string | undefined;
let remoteStopping = false;
let lanError: string | undefined;
const LAN_ALLOW_LOCAL = process.env.CODEFLOW_LAN_ALLOW_LOCAL === "1";
let tailscaleStatus: TailscaleStatus = { state: "unavailable", message: "Tailscale has not been checked yet." };
let detectingTailscale: Promise<void> | undefined;
let detectedTailscaleAt = 0;
let syncingLan: Promise<void> = Promise.resolve();

async function refreshTailscale(force = false): Promise<void> {
  if (process.env.CODEFLOW_SSH_HOST) return;
  if (detectingTailscale) return detectingTailscale;
  if (!force && Date.now() - detectedTailscaleAt < 5_000) return;
  detectingTailscale = detectTailscale().then((status) => {
    tailscaleStatus = status;
    detectedTailscaleAt = Date.now();
  }).finally(() => { detectingTailscale = undefined; });
  return detectingTailscale;
}

function networkHost(): string | undefined {
  if (process.env.CODEFLOW_SSH_HOST || remoteStopping || !remote.enabled || !remote.lan) return undefined;
  if (remote.transport === "tailscale") return tailscaleStatus.state === "connected" ? tailscaleStatus.ip : undefined;
  return "0.0.0.0";
}

/** Serialize changes; a stopped/disconnected Tailscale never falls back to a LAN listener. */
function syncLanServer(signOut = false): Promise<void> {
  const change = syncingLan.catch(() => undefined).then(async () => {
    let host = networkHost();
    if (lanServer && host !== lanHost) {
      const previous = lanServer;
      lanServer = undefined;
      lanHost = undefined;
      await new Promise<void>((resolve) => {
        previous.close(() => resolve());
        previous.closeAllConnections();
      });
      // Another settings change may have been saved while the old listener closed.
      host = networkHost();
    }
    if (!host) { lanError = undefined; return; }
    if (lanServer) {
      if (signOut) lanServer.closeAllConnections();
      return;
    }
    lanError = undefined;
    const transport = remote.transport ?? "lan";
    const receive = listener("lan");
    const handleNetwork = (req: IncomingMessage, res: ServerResponse) => {
      // Settings may change before the socket closes. Old bindings never inherit a new mode.
      if (host !== networkHost() || transport !== (remote.transport ?? "lan")) {
        return send(res, 403, { error: "Remote access changed. Reconnect using the current link." });
      }
      receive(req, res);
    };
    const server = phoneTls ? createSecureServer({ ...phoneTls, maxHeaderSize: MAX_HEADER_SIZE }, handleNetwork) : createServer({ maxHeaderSize: MAX_HEADER_SIZE }, handleNetwork);
    server.on("connection", (socket) => {
      const source = (socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
      if (!LAN_ALLOW_LOCAL && (isOwnAddress(source) || source === host || (transport === "tailscale" && !isTailscaleIPv4(source)))) socket.destroy();
    });
    lanServer = server;
    lanHost = host;
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
      server.on("error", (err: NodeJS.ErrnoException) => {
        lanError = err.code === "EADDRINUSE"
          ? `Port ${REMOTE_PORT} is already in use by another program. Set CODEFLOW_REMOTE_PORT to a free port, then restart code-flow.`
          : transport === "tailscale"
            ? `Codeflow couldn't listen on Tailscale (${host}:${REMOTE_PORT}). Check that Tailscale is connected, then refresh.`
            : `code-flow couldn't listen on your network (port ${REMOTE_PORT}): ${err.message}`;
        logError(lanError, err);
        if (lanServer === server) { lanServer = undefined; lanHost = undefined; }
        server.close();
        resolve();
      });
      server.listen(REMOTE_PORT, host);
    });
  });
  syncingLan = change;
  return change;
}

/**
 * A random id per server start. Event numbers are only comparable within one start (a crash can
 * lose the last few, and they're numbered again), so a client that sees it change starts over.
 */
const EPOCH = randomBytes(6).toString("hex");
/** A client that stops reading (a phone gone to sleep) is dropped after this, rather than buffered for. */
const STALL_MS = envNumber("CODEFLOW_SSE_STALL_MS", 30_000, { min: 100 });

/**
 * An event stream. Each event carries `id: <epoch>:<seq>`, which the browser sends back as
 * Last-Event-ID when it reconnects, so only what it missed is sent again.
 */
function openStream(res: ServerResponse, epoch = EPOCH): { send(event: unknown, seq?: number): void } {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let stalled: ReturnType<typeof setTimeout> | undefined;
  const write = (chunk: string) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.write(chunk) || stalled) return;
    // The client's buffer is full: wait for it to drain, but not forever.
    stalled = setTimeout(() => res.destroy(), STALL_MS);
    res.once("drain", () => {
      clearTimeout(stalled);
      stalled = undefined;
    });
  };
  const ping = setInterval(() => write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    clearTimeout(stalled);
  });
  return { send: (event, seq) => write(`${seq === undefined ? "" : `id: ${epoch}:${seq}\n`}data: ${JSON.stringify(event)}\n\n`) };
}

/** The last event a reconnecting client got (its Last-Event-ID), if it's from this server start. */
function lastEventSeq(req: IncomingMessage, expectedEpoch = EPOCH): number | undefined {
  return cursorSeq(String(req.headers["last-event-id"] ?? ""), expectedEpoch);
}

/**
 * Every run snapshot as it changes, numbered, with the latest few hundred kept so a client that
 * reconnects gets only what it missed. Subscribed before runs load, so none is missed.
 */
const runFeed = { seq: 0, recent: [] as { seq: number; run: RunSummary }[], clients: new Set<(entry: { seq: number; run: RunSummary }) => void>() };
const RUN_FEED_KEEP = 500;
manager.subscribeAll((run) => {
  const entry = { seq: ++runFeed.seq, run };
  runFeed.recent.push(entry);
  if (runFeed.recent.length > RUN_FEED_KEEP) runFeed.recent.shift();
  for (const client of runFeed.clients) client(entry);
});

function streamAllRuns(req: IncomingMessage, res: ServerResponse, limit?: number) {
  const page = limit === undefined ? undefined : fileAccess.page({ limit });
  const epoch = `${EPOCH}-fs${filesystemFeedRevision}`;
  const stream = openStream(res, epoch);
  const after = lastEventSeq(req, epoch);
  const oldest = runFeed.recent[0]?.seq ?? runFeed.seq + 1;
  if (after !== undefined && after >= oldest - 1 && after <= runFeed.seq) {
    stream.send({ type: "hello", epoch, seq: runFeed.seq, resumed: true });
    for (const e of runFeed.recent) if (e.seq > after && !fileAccess.restrictedRun(e.run)) stream.send({ type: "run", seq: e.seq, run: e.run }, e.seq);
  } else {
    // Active and attention items remain visible even when their creation is outside the recent page.
    const attention = page ? manager.attentionPage({ limit: 100, predicate: (run) => !fileAccess.restrictedRun(run) }) : undefined;
    const runs = page ? [...new Map([...page.runs, ...attention!.runs].map((run) => [run.id, run])).values()] : fileAccess.list();
    stream.send({ type: "hello", epoch, seq: runFeed.seq, runs, ...(page ? { nextCursor: page.nextCursor, total: page.total, attentionTotal: attention!.total, attentionTruncated: attention!.truncated, attentionNextCursor: attention!.nextCursor } : {}) }, runFeed.seq);
  }
  const client = (e: { seq: number; run: RunSummary }) => { if (!fileAccess.restrictedRun(e.run)) stream.send({ type: "run", seq: e.seq, run: e.run }, e.seq); };
  runFeed.clients.add(client);
  const stopPolicy = filePolicies.onChange(() => res.end());
  res.on("close", () => { runFeed.clients.delete(client); stopPolicy(); });
}

/**
 * What a window watches (see src/stream.ts). Each starts with what the window needs and then sends
 * live events; `after` is the cursor (`<epoch>:<seq>`) of the last event it got before reconnecting.
 */
const topics: Record<string, TopicSource> = {
  /**
   * Every run's status changes, for the sidebar and notifications. A first connection (or one
   * from before a restart, or that missed too much) starts with the whole list, in step with the
   * stream; a reconnect gets the snapshots it missed.
   */
  runs(_name, after, deliver) {
    const epoch = `${EPOCH}-fs${filesystemFeedRevision}`;
    const from = cursorSeq(after, epoch);
    const oldest = runFeed.recent[0]?.seq ?? runFeed.seq + 1;
    if (from !== undefined && from >= oldest - 1 && from <= runFeed.seq) {
      deliver({ type: "hello", epoch, seq: runFeed.seq, resumed: true });
      for (const e of runFeed.recent) if (e.seq > from && !fileAccess.restrictedRun(e.run)) deliver({ type: "run", seq: e.seq, run: e.run }, e.seq);
    } else {
      const page = fileAccess.page({ limit: 100 });
      const attention = manager.attentionPage({ limit: 100, predicate: (run) => !fileAccess.restrictedRun(run) });
      const runs = [...new Map([...page.runs, ...attention.runs].map((run) => [run.id, run])).values()];
      deliver({ type: "hello", epoch, seq: runFeed.seq, runs, total: page.total, nextCursor: page.nextCursor, attentionTotal: attention.total, attentionTruncated: attention.truncated, attentionNextCursor: attention.nextCursor }, runFeed.seq);
    }
    const client = (e: { seq: number; run: RunSummary }) => { if (!fileAccess.restrictedRun(e.run)) deliver({ type: "run", seq: e.seq, run: e.run }, e.seq); };
    runFeed.clients.add(client);
    return () => runFeed.clients.delete(client);
  },

  /**
   * A run's events. The hello carries the run as it is now (with its steps), so a window never
   * depends on the log holding the latest state (an event may have reached it before a crash lost
   * its best-effort write). Then what it takes to show the run (its latest snapshots, every agent
   * event and log line; see replayEvents), then live ones. Run event numbers are recovered from
   * disk, so a cursor is the run's (`run-<id>:<seq>`), not this server start's: a window that
   * reconnects, even to a restarted server, gets only what it missed. Live events that arrive
   * while the history is still being read wait for it, so the window never gets an older snapshot
   * after a newer one.
   */
  async run(id, after, deliver) {
    if (!manager.get(id)) throw new TopicError(404, "This run doesn't exist. It may have been started by another code-flow, or its files were removed.");
    if (fileAccess.restrictedRun(manager.get(id)!)) throw new TopicError(403, "This run is unavailable under its filesystem policy");
    const generation = filesystemFeedRevision;
    const allowed = () => generation === filesystemFeedRevision && !fileAccess.restrictedRun(manager.get(id)!);
    const epoch = `run-${id}`;
    const requested = cursorSeq(after, epoch);
    let last = 0;
    const send = (e: RunEvent) => {
      if (e.seq <= last || !allowed()) return;
      last = e.seq;
      deliver(e, e.seq);
    };
    let waiting: RunEvent[] | undefined = [];
    const stop = manager.subscribe(id, (e) => (waiting ? waiting.push(e) : send(e)));
    try {
      const history = await manager.events(id);
      if (!allowed()) throw new TopicError(409, "Filesystem policy changed; reconnect to refresh authorization");
      const newest = Math.max(0, history.at(-1)?.seq ?? 0, waiting.at(-1)?.seq ?? 0);
      // A cursor past what's on disk (events lost in a crash) starts over.
      const from = requested !== undefined && requested <= newest ? requested : undefined;
      last = from ?? 0;
      const { steps, ...run } = manager.get(id)!;
      deliver({ type: "hello", epoch, resumed: from !== undefined, snapshot: { run, steps, seq: newest } });
      for (const event of replayEvents(history.filter((e) => e.seq > last))) send(event);
    } catch (err) {
      stop();
      throw err;
    } finally {
      const live = waiting.sort((a, b) => a.seq - b.seq);
      waiting = undefined;
      for (const event of live) send(event);
    }
    return stop;
  },

  /** A terminal of the side panel: what it showed so far, then its output as it comes. */
  shell(id, _after, deliver) {
    if (fileAccess.hasRestrictions()) throw new TopicError(403, "Terminals are paused under filesystem restrictions");
    const shell = shells.get(id);
    if (!shell) throw new TopicError(404, "That terminal is gone (code-flow restarted?)");
    deliver({ type: "hello", shell, history: shells.history(id) });
    return shells.subscribe(id, (e: ShellEvent) => deliver(e)) ?? (() => {});
  },
};
const hub = new StreamHub(topics);
const ownerHubStreams = new Set<ServerResponse>();
let streamSharing = { channelKey: randomBytes(32).toString("hex"), lockId: randomBytes(16).toString("hex") };
function closeOwnerStreams(rotate = false) {
  if (rotate) streamSharing = { channelKey: randomBytes(32).toString("hex"), lockId: randomBytes(16).toString("hex") };
  for (const response of ownerHubStreams) response.end();
}
filePolicies.onChange(() => closeOwnerStreams());

/** A window's one stream (see src/stream.ts), opened with what it watches already. */
function openHubStream(res: ServerResponse, url: URL) {
  const raw = url.searchParams.get("subs") ?? "[]";
  if (raw.length > 16_384) throw new HttpError(400, "Too many subscriptions");
  let subs: unknown;
  try {
    subs = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "subs must be JSON");
  }
  const stream = openStream(res);
  ownerHubStreams.add(res);
  const stopPolicy = filePolicies.onChange(() => res.end());
  const client = hub.open((message) => stream.send(message), subs);
  res.on("close", () => { ownerHubStreams.delete(res); stopPolicy(); hub.close(client); });
}

/**
 * One topic as an event stream of its own, as code-flow served them before src/stream.ts (an
 * older page still open after an update uses these). Events carry `id: <epoch>:<seq>`, so a
 * reconnect (with Last-Event-ID) gets only what it missed.
 */
async function streamTopic(req: IncomingMessage, res: ServerResponse, kind: "runs" | "run" | "shell", name = "") {
  const epoch = kind === "run" ? `run-${name}` : `${EPOCH}-fs${filesystemFeedRevision}`;
  const after = lastEventSeq(req, epoch);
  const stream = openStream(res, epoch);
  let closed = false;
  const stopPolicy = filePolicies.onChange(() => res.end());
  res.on("close", () => { closed = true; stopPolicy(); });
  try {
    const stop = await topics[kind]!(name, after === undefined ? undefined : `${epoch}:${after}`, (data, seq) => stream.send(data, kind === "shell" ? undefined : seq));
    if (closed) stop();
    else res.on("close", stop);
  } catch (err) {
    // As these streams always did: an unknown run or terminal ends the stream.
    if (err instanceof TopicError) return res.end();
    throw err;
  }
}

/** Which listener a request came in on: this machine's, or the one on your network. */
type Via = "local" | "lan";

async function handle(req: IncomingMessage, res: ServerResponse, via: Via) {
  if (stopping) throw new HttpError(503, "The backend is stopping");
  const url = new URL(req.url ?? "/", "http://localhost");
  let parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "api") parts = await attempt(async () => canonicalSharedPath(req.url ?? "/").parts);
  if (await handlePublic(req, res, url, parts, via)) return;
  if (via === "lan") checkLanOrigin(req); else checkOrigin(req);
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const explicitOwner = via === "local" && !!bearer && tokenMatches(bearer, auth.token);
  const shared = explicitOwner ? undefined : sharedSession(req);
  // A revoked shared cookie must never silently fall back to an older owner cookie.
  const sharedPresent = readCookies(req, SHARED_COOKIE).length > 0;
  const owner = explicitOwner || !sharedPresent && (via === "lan" ? phoneSignedIn(req) : signedIn(req));

  if (parts.join("/") === "api/auth/login" && req.method === "POST") {
    sharedMutation(req);
    const body = await readLoginJson(req);
    const session = await attempt(() => sharedAccounts.login({ username: body.username, password: body.password, ...sharedTransport(req) }));
    if (owner) closeOwnerStreams(true);
    res.setHeader("set-cookie", [sharedCookie(session.token, sharedTransport(req).secure), clearCookie(COOKIE), clearCookie(PHONE_COOKIE)]);
    return send(res, 200, { user: session.user, expiresAt: session.expiresAt });
  }
  if (parts.join("/") === "api/auth/self" && req.method === "GET") return send(res, 200, owner ? { kind: "owner", streamSharing } : shared?.identity ?? { kind: "anonymous" });
  if (parts.join("/") === "api/auth/logout" && req.method === "POST") {
    sharedMutation(req);
    for (const token of readCookies(req, SHARED_COOKIE)) await attempt(() => sharedAccounts.logout(token));
    auth.claimable = false;
    if (owner) closeOwnerStreams(true);
    res.setHeader("set-cookie", [clearCookie(SHARED_COOKIE), clearCookie(COOKIE), clearCookie(PHONE_COOKIE)]);
    return send(res, 200, { signedOut: true });
  }
  if (req.method === "GET" && url.pathname === "/") {
    const given = url.searchParams.get("token");
    if (given) {
      if (via === "lan") throw new HttpError(403, "Use a phone pairing link or shared-project account on this listener");
      if (!tokenMatches(given, auth.token)) throw new HttpError(403, "That link is from an earlier code-flow session; use the one printed when it last started");
      auth.claimable = false;
      res.writeHead(302, { location: "/", "set-cookie": [sessionCookie(), clearCookie(SHARED_COOKIE)], "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return res.end();
    }
    const sharedLogin = sharedAccounts.available && sharedAccounts.hasUsers && (via === "local" || !!phoneTls);
    const claim = via === "local" && !owner && !sharedPresent && mayClaim(req);
    if (!owner && !shared && !claim && !sharedLogin) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...NO_FRAMES });
      return res.end(via === "lan" ? PHONE_LOCKED_PAGE : LOCKED_PAGE);
    }
    if (via === "lan" && owner && !phoneControl()) throw new HttpError(404, "Not found");
    if (owner || shared || claim) auth.claimable = false;
    return sendAppPage(req, res, { ...NO_FRAMES, ...(claim ? { "set-cookie": sessionCookie() } : {}) });
  }
  if (parts[0] !== "api") throw new HttpError(404, "Not found");
  if (shared) {
    await attempt(() => fileAccess.sharedGate(req));
    if (req.method !== "GET") sharedMutation(req);
    return attempt(() => handleSharedApi(req, res, url, parts, { accounts: sharedAccounts, token: shared.token, identity: shared.identity, manager, projects, comments: collaborationReviews, canReadFilePolicy: (run) => !fileAccess.restrictedRun(run), onFilePolicyChange: (listener) => filePolicies.onChange(listener), patterns: patterns.map(describePattern), templates }));
  }
  if (via === "lan" && !phoneControl()) throw new HttpError(404, "Not found");
  if (!owner) throw Object.assign(new HttpError(401, "Not signed in: use the owner link or sign in to shared projects"), { signIn: true });
  if (parts.join("/") === "api/ssh-context" && req.method === "GET") return send(res, 200, { kind: process.env.CODEFLOW_SSH_HOST ? "host" : "local" });
  if (process.env.CODEFLOW_SSH_HOST && parts.join("/") === "api/ssh-runtime" && req.method === "GET") return send(res, 200, { instance: process.env.CODEFLOW_SSH_HOST });
  if (parts[1] === "projects" && parts[2] && parts[3] === "filesystem-policy") {
    const project = projects.get(parts[2]); if (!project) throw new HttpError(404, "Project not found");
    if (parts.length !== 4) throw new HttpError(404, "Unknown filesystem policy operation");
    if (req.method === "GET") return send(res, 200, await attempt(() => filePolicies.get(project.id)));
    if (req.method === "PUT") {
      const body = await readJson(req, 64 * 1024);
      return send(res, 200, await attempt(() => fileAccess.update(project.id, body, async (commit, next) => {
        if (!filteredTasksReady || filteredTasks.active()) throw new FilePolicyError("Finish or explicitly cancel and reconcile filtered tasks before changing policy; unavailable task storage must be repaired first", 409);
        if (policyIsRestrictive(next) && extensions.list().length) throw new FilePolicyError("Disable configured extensions and restart before applying a restriction. Previously imported trusted JavaScript can retain background host authority, including a bundle rejected after initialization.", 409);
        if (shells.list().length || manager.devServers.list().some((service) => service.status === "running")) throw new FilePolicyError("Close terminals and stop development services before changing filesystem policy", 409);
        try { await manager.withIdleExecution(async () => { await pausePolicyBackground(); previews.closeAll(); sshPreviews.closeAll(); await commit(); }); }
        finally { if (!fileAccess.hasRestrictions()) startPolicyBackground(); }
      })));
    }
    throw new HttpError(405, "Use GET or PUT for filesystem policy");
  }
  if (parts[1] === "filtered-tasks") {
    await attempt(() => fileAccess.sharedGate(req));
    if (!filteredTasksReady) throw new HttpError(503, "Filtered task storage is unavailable; repair its private records before execution or policy changes");
    auth.claimable = false;
    if (req.method === "POST" && parts.length === 2) manager.noteActivity();
    if (await handleFilteredTasksApi(req, res, url, parts.slice(1), filteredTasks)) return;
  }
  // Check before ownerGate/validRepo: even repository discovery can invoke Git in its cwd.
  if (parts[1] === "improve-prompt") {
    if (req.method !== "POST" || parts.length !== 2) throw new HttpError(404, "Unknown prompt improvement operation");
    await attempt(async () => assertImproveEnvironment());
  }
  await attempt(() => fileAccess.ownerGate(req, url, parts));
  if (parts[1] === "ssh-runtime" && process.env.CODEFLOW_SSH_HOST) {
    if (parts[2] === "preview" && parts.length === 3 && req.method === "POST") {
      if (fileAccess.hasRestrictions()) throw new HttpError(409, "Filesystem restrictions pause remote previews");
      const body = await readJson(req, 8192); const target = previewTarget(String(body.url ?? ""));
      if (!target || target.port === PORT || target.port === REMOTE_PORT) throw new HttpError(400, "Choose a remote development app's localhost HTTP address");
      return send(res, 200, await sshPreviews.show(String(body.url)));
    }
    if (parts[2] === "stop" && parts.length === 3 && req.method === "POST") {
      if (manager.list().some((run) => run.status === "running") || manager.busy.agents.running || manager.busy.checks.running || shells.list().some((shell) => shell.status === "running") || manager.devServers.list().some((service) => service.status === "running")) throw new HttpError(409, "Finish running work and close terminals and development servers before stopping the backend");
      await attempt(() => manager.withIdleExecution(async () => {
        await pausePolicyBackground();
        send(res, 200, { ok: true }); void stop("SSH backend stopped from the app");
      })); return;
    }
    throw new HttpError(404, "Unknown SSH runtime operation");
  }
  if (parts[1] === "ssh-hosts") {
    if (!sshProjects || via !== "local") throw new HttpError(403, "Manage SSH connections from the local app");
    if (fileAccess.hasRestrictions()) throw new HttpError(409, "Filesystem restrictions pause SSH connection management");
    if (parts.length === 2 && req.method === "GET") return send(res, 200, await attempt(() => sshProjects.list()));
    if (parts.length === 2 && req.method === "POST") return send(res, 201, await attempt(async () => sshProjects.add(await readJson(req, 8192))));
    if (parts.length === 3 && req.method === "DELETE") { await attempt(() => sshProjects.remove(parts[2]!)); return send(res, 200, { ok: true }); }
    if (parts.length === 4 && req.method === "POST") {
      if (parts[3] === "connect") return send(res, 200, await attempt(() => sshProjects.connect(parts[2]!, `http://${req.headers.host}/`)));
      if (parts[3] === "disconnect") { await attempt(() => sshProjects.disconnect(parts[2]!)); return send(res, 200, { ok: true }); }
      if (parts[3] === "stop") { await attempt(() => sshProjects.stop(parts[2]!)); return send(res, 200, { ok: true }); }
    }
    throw new HttpError(404, "Unknown SSH connection operation");
  }
  if (parts[1] === "accounts") {
    if (!parts[2] && req.method === "GET") return send(res, 200, await attempt(async () => sharedAccounts.snapshot()));
    const body = await readJson(req);
    if (body.roles) for (const id of Object.keys(body.roles)) if (!projects.get(id)) throw new HttpError(400, "Choose existing projects for shared roles");
    if (!parts[2] && req.method === "POST") return send(res, 201, await attempt(() => sharedAccounts.create(body)));
    if (parts.length === 3 && req.method === "PUT") return send(res, 200, await attempt(() => sharedAccounts.update(parts[2]!, body)));
    if (parts.length === 4 && parts[3] === "revoke-sessions" && req.method === "POST") return send(res, 200, await attempt(() => sharedAccounts.revokeSessions(parts[2]!, body)));
    throw new HttpError(404, "Unknown shared account operation");
  }
  if (await codeHostsApi.handle(req, res, parts.slice(1))) return;
  if (parts[1] === "remote-workers") {
    if (parts.length === 2 && req.method === "GET") return send(res, 200, remoteWorkers.list());
    if (parts.length === 4 && parts[3] === "probe" && req.method === "POST") {
      const body = await readJson(req, 8192);
      if (typeof body.repoMapping !== "string") throw new HttpError(400, "Choose a registered repository mapping");
      return send(res, 200, await attempt(() => remoteWorkers.probe(parts[2]!, { repoMapping: body.repoMapping })));
    }
    throw new HttpError(404, "Unknown remote worker operation");
  }
  if (parts.join("/") === "api/extensions" && req.method === "GET") return send(res, 200, { api: { major: 1, minor: 0 }, extensions: extensions.list() });
  if (parts[1] === "coordinated-changes") return coordinatedApi.handle(req, res, parts);
  if (parts[1] === "runs" && parts.length === 6 && parts[3] === "remote-steps" && ["receipt", "cancel"].includes(parts[5]!) && req.method === "POST") {
    return send(res, 200, redactExport(await attempt(() => manager.inspectRemoteStep(parts[2]!, parts[4]!, { cancel: parts[5] === "cancel" }))));
  }

  if (["readiness", "verification", "workspace", "diagnostics", "v1"].includes(parts[1] ?? "")) {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const result = await attempt(() => handleWorkspaceApi(req, url, parts, manager, abort.signal));
    if (result) return send(res, result.status, result.body);
  }

  if (parts[1] === "integrations") {
    if (req.method === "GET" && !parts[2]) return send(res, 200, integrations.list());
    if (req.method === "GET" && parts[2] && parts[3] === "items") {
      const kind = url.searchParams.get("kind");
      if (kind !== "issue" && kind !== "pr") throw new HttpError(400, "Choose issues or review requests");
      return send(res, 200, await attempt(() => integrations.items(parts[2]!, kind, url.searchParams.get("cursor") ?? undefined)));
    }
    if (req.method === "POST" && parts[2] && parts[3] === "import") {
      const body = await readJson(req);
      if (!["issue", "pr"].includes(body.kind) || typeof body.key !== "string") throw new HttpError(400, "Choose a source item");
      return send(res, 201, await attempt(() => integrations.importSource(parts[2]!, body.kind, body.key)));
    }
    throw new HttpError(404, "Unknown external source operation");
  }
  if (parts[1] === "notifications") {
    if (!notificationsReady) throw new HttpError(503, "Notifications are disabled until their configuration and storage are repaired");
    if (req.method === "GET" && !parts[2]) return send(res, 200, notifications.list());
    if (req.method === "GET" && parts[2] === "deliveries") return send(res, 200, notifications.deliveries());
    if (req.method === "POST" && parts[2] === "deliveries" && parts[3] && parts[4] === "retry") return send(res, 202, await attempt(() => notifications.retry(parts[3]!)));
    if (req.method === "POST" && parts[2] && parts[3] === "test") return send(res, 202, await attempt(() => notifications.test(parts[2]!)));
    if (req.method === "POST" && parts[2] && !parts[3]) return send(res, 200, await attempt(async () => notifications.update(parts[2]!, await readJson(req))));
    throw new HttpError(404, "Unknown notification operation");
  }

  if (parts[1] === "approvals") {
    if (req.method === "GET") return send(res, 200, redactExport(approvals.list(url.searchParams.get("run") ?? undefined)));
    if (req.method === "POST" && parts[2]) {
      const body = await readJson(req);
      if (body.decision !== "approve" && body.decision !== "decline") throw new HttpError(400, "Choose approve or decline");
      const request = approvals.list().find((record) => record.id === parts[2]);
      const run = request ? manager.get(request.runId) : undefined;
      if (!request || !run || run.status !== "running" || !run.approvals.tools || !run.steps.some((step) => step.id === request.stepId && step.status === "running")) throw new HttpError(409, "This approval is no longer active");
      if (!approvals.respond(request.id, body.decision, { runId: run.id, stepId: request.stepId })) throw new HttpError(409, "This approval has expired or was already answered");
      manager.log(run.id, `You ${body.decision === "approve" ? "approved" : "declined"} one ${request.kind} action in ${request.stepId}`);
      return send(res, 200, { resolved: true });
    }
    throw new HttpError(404, "Unknown approval operation");
  }

  if (req.method === "GET" && parts[1] === "team-capabilities") return send(res, 200, await Promise.all(AGENT_IDS.map(adapterTeamCapabilities)));
  if (parts[1] === "team-rollout") {
    if (req.method === "GET") return send(res, 200, await teamEvaluationStore.rollout(autoTeamEnabled()));
    if (req.method === "POST") {
      const body = await readJson(req);
      await attempt(() => teamEvaluationStore.decide({ stage: body.stage, rationale: body.rationale, evaluationIds: body.evaluationIds }));
      return send(res, 200, await teamEvaluationStore.rollout(autoTeamEnabled()));
    }
  }
  if (req.method === "GET" && parts[1] === "team-evaluations") {
    const reports = await teamEvaluationStore.list();
    return send(res, 200, { reports, assessment: assessTeamRollout(reports), rollout: await teamEvaluationStore.rollout(autoTeamEnabled()) });
  }
  if (req.method === "GET" && parts[1] === "agents") return send(res, 200, fileAccess.hasRestrictions() ? Object.values(adapters).map((adapter) => ({ id: adapter.id, displayName: adapter.displayName, binary: adapter.binary, available: false })) : await agentAvailability());
  if (req.method === "GET" && parts[1] === "events") {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new HttpError(400, "History page size must be between 1 and 100");
    return streamAllRuns(req, res, limit);
  }
  if (req.method === "GET" && parts[1] === "stream" && !parts[2]) return openHubStream(res, url);
  if (req.method === "POST" && parts[1] === "stream" && parts[2]) {
    const body = await readJson(req);
    if (!hub.update(parts[2], body)) throw new HttpError(404, "That stream has closed; open a new one");
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && parts[1] === "patterns") return send(res, 200, patterns.map(describePattern));
  if (req.method === "GET" && parts[1] === "fs") {
    const listing = await listDirectories(url.searchParams.get("path") ?? undefined, url.searchParams.get("hidden") === "1")
      .catch((err: NodeJS.ErrnoException) => {
        const status = err.code === "ENOENT" ? 404 : err.code === "EACCES" || err.code === "EPERM" ? 403 : 400;
        throw new HttpError(status, err.code === "ENOENT" ? "Folder not found" : err.message);
      });
    return send(res, 200, listing);
  }
  if (req.method === "GET" && parts[1] === "branches") {
    const repo = await requestedRepo(url);
    return send(res, 200, { repo, worktreeRoot: worktreeRoot(repo), ...(await listBranches(repo)) });
  }
  if (req.method === "GET" && parts[1] === "tree") {
    const repo = await requestedFolder(url);
    const listing = await listTree(repo, url.searchParams.get("path") ?? "").catch((err: NodeJS.ErrnoException) => {
      if (err instanceof FilePolicyError) throw new HttpError(err.status, err.message);
      throw new HttpError(err.code === "ENOENT" ? 404 : 400, err.code === "ENOENT" ? "Folder not found" : err.message);
    });
    return send(res, 200, listing);
  }
  if (req.method === "GET" && parts[1] === "doctor" && parts[2] === "dependencies") return send(res, 200, await discoverDependencies(manager.quota));
  if (req.method === "GET" && parts[1] === "doctor" && parts[2] === "git") return send(res, 200, await checkGit());
  if (req.method === "GET" && parts[1] === "doctor") {
    const health = await doctor(manager.quota);
    // Auto stays away from an agent that's signed out, and goes back once it's signed in again.
    for (const entry of health) {
      if (entry.installed && entry.signedIn === false) manager.recordQuota(entry.id, "signed_out", {});
      else if (entry.signedIn === true && manager.quota[entry.id]?.status === "signed_out") manager.recordQuota(entry.id, "allowed", {});
    }
    return send(res, 200, health);
  }
  if (req.method === "GET" && parts[1] === "health") {
    // interactiveTerminal: false when there's no python3 for the Terminal's pseudo-terminal (src/shell.ts).
    return send(res, 200, { busy: manager.busy, activity: manager.inspectRepositoryActivity(), writes: writeHealth, runs: manager.list().filter((r) => r.status === "running").length, interactiveTerminal: !fileAccess.hasRestrictions() && await shells.interactive(), streams: hub.stats });
  }
  if (req.method === "GET" && parts[1] === "stats") {
    const since = Number(url.searchParams.get("since")) || undefined;
    const repo = url.searchParams.get("repo") ? await requestedRepo(url) : undefined;
    return send(res, 200, computeStats(runsIn(url.searchParams.get("project")), { repo, since }));
  }
  if (req.method === "POST" && parts[1] === "compare") return send(res, 201, await startComparison(await readJson(req)));
  if (req.method === "GET" && parts[1] === "disk") {
    return send(res, 200, await diskUsage(runsIn(url.searchParams.get("project")), url.searchParams.get("repo") ? await requestedRepo(url) : undefined));
  }
  if (req.method === "POST" && parts[1] === "cleanup") {
    const body = await readJson(req);
    return send(res, 200, await cleanUp(runsIn(body.project), Math.max(0, Number(body.olderThanDays ?? 7)), typeof body.repo === "string" ? body.repo : undefined));
  }
  if (parts[1] === "maintenance" && parts[2] === "retention") {
    if (req.method === "GET" && !parts[3]) return send(res, 200, await attempt(() => retentionPolicy.get()));
    if (req.method === "POST" && !parts[3]) {
      const body = await readJson(req);
      return send(res, 200, await attempt(() => retentionPolicy.set({ days: body.days, keepRunIds: body.keepRunIds, keepMemoryIds: body.keepMemoryIds }, body.expectedRevision)));
    }
    if (req.method === "POST" && parts[3] === "preview") return send(res, 200, await attempt(() => previewRetention({ home: CODEFLOW_HOME })));
    throw new HttpError(404, "Retention deletion is an explicit offline CLI operation");
  }
  if (parts[1] === "deferred-runs") {
    const id = parts[2], action = parts[3];
    if (!id && req.method === "GET") return send(res, 200, await attempt(() => deferredRuns.list()));
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      const raw = body.run;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Choose a run configuration to defer");
      if (raw.teamRerun !== undefined || raw.deferred !== undefined) throw new HttpError(400, "Server launch identities cannot be queued");
      if (raw.context?.attachments !== undefined && (!Array.isArray(raw.context.attachments) || raw.context.attachments.length)) throw new HttpError(400, "Attachments cannot be deferred; remove them before queueing");
      const request = await attempt(async () => sanitizeDeferredRequest({ ...automationRun(raw), parentRunId: raw.parentRunId, branchPrefix: raw.branchPrefix }));
      const pattern = findPattern(request.pattern);
      if (!pattern) throw new HttpError(400, "Unknown pattern");
      request.repo = await attempt(() => repoRoot(request.repo));
      if (request.project && !projects.get(request.project)?.repos.includes(request.repo)) throw new HttpError(400, "Choose a repository belonging to this project");
      if (request.parentRunId && manager.get(request.parentRunId)?.repo !== request.repo) throw new HttpError(400, "Choose an existing parent run in the same repository");
      for (const spec of pattern.roles) if (!spec.optional && pattern.id !== "auto-team" && !request.roles[spec.id]?.length) throw new HttpError(400, `Pick an agent for "${spec.label}"`);
      validateLoop(request.loop);
      request.options = validateOptions(pattern, request.options);
      return send(res, 201, await attempt(() => deferredRuns.enqueue({ name: body.name, run: request, notBefore: body.notBefore, waitForProviders: body.waitForProviders, maxAttempts: body.maxAttempts, operationId: body.operationId })));
    }
    if (id && req.method === "POST") {
      const body = await readJson(req);
      if (action === "cancel") return send(res, 200, await attempt(() => deferredRuns.cancel(id, body.expectedRevision)));
      if (action === "retry") return send(res, 200, await attempt(() => deferredRuns.retry(id, body.expectedRevision, { acknowledgeUnknown: body.acknowledgeUnknown === true })));
      if (action === "attach") {
        const job = (await deferredRuns.list()).find((item) => item.id === id), run = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
        if (!job || !run || run.repo !== job.run.repo || job.run.project && run.project !== job.run.project || run.deferred?.jobId !== job.id || run.deferred.claimId !== job.claimId || run.deferred.attempt !== job.attempts) throw new HttpError(409, "This run does not belong to this exact deferred launch claim");
        await attempt(() => persistDeferredReceipt(run));
        return send(res, 200, await attempt(() => deferredRuns.attach(id, body.expectedRevision, run.id)));
      }
    }
    throw new HttpError(404, "Unknown deferred run operation");
  }
  if (parts[1] === "projects") {
    const id = parts[2];
    if (!id && req.method === "GET") return send(res, 200, projects.list());
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      return send(res, 201, await attempt(() => projects.create({ name: body.name, repos: Array.isArray(body.repos) ? body.repos : [] })));
    }
    if (id && !projects.get(id)) throw new HttpError(404, "Project not found");
    if (id && parts[3] === "conventions") {
      const project = projects.get(id)!;
      if (!parts[4] && req.method === "GET") return send(res, 200, await attempt(() => conventions.get(id)));
      if (!parts[4] && req.method === "PUT") return send(res, 200, await attempt(async () => conventions.save(id, await readJson(req))));
      if (parts[4] === "restore-preview" && req.method === "POST") { const body = await readJson(req); return send(res, 200, await attempt(() => conventions.previewRestore(id, body.version))); }
      if (parts[4] === "restore" && req.method === "POST") return send(res, 200, await attempt(async () => conventions.restore(id, await readJson(req))));
      if (parts[4] === "publication" && req.method === "GET") {
        const repo = url.searchParams.get("repo");
        if (!repo || !project.repos.includes(repo)) throw new HttpError(400, "Choose a repository belonging to this project");
        return send(res, 200, await attempt(() => conventions.inspectRepository(repo)));
      }
      if (parts[4] === "publish" && req.method === "POST") {
        const body = await readJson(req);
        if (typeof body.repo !== "string" || !project.repos.includes(body.repo)) throw new HttpError(400, "Choose a repository belonging to this project");
        return send(res, 200, await attempt(() => manager.withIdleRepository(body.repo, () => conventions.publish(id, body, { repos: project.repos, actor: "user", isIdle: () => manager.isRepositoryIdle(body.repo) }), { kind: "conventions-publication", owner: id })));
      }
      throw new HttpError(404, "Unknown conventions operation");
    }
    if (id && parts[3] === "memory") {
      const project = projects.get(id)!;
      const requested = url.searchParams.get("repo");
      if (requested && !project.repos.includes(requested)) throw new HttpError(400, "That repository is not in this project");
      const repos = requested ? [requested] : project.repos;
      if (parts[4] === "analysis") {
        const body = req.method === "POST" ? await readJson(req) : {};
        const repo = typeof body.repo === "string" ? body.repo : requested ?? (project.repos.length === 1 ? project.repos[0] : undefined);
        if (!repo || !project.repos.includes(repo)) throw new HttpError(400, "Choose a repository in this project");
        const entries = await memoryStore.list({ repo, projectId: id, scope: "project" }, { kind: "user", repo, projectId: id });
        const analysis = await attempt(() => analyzeProjectMemory({ repo, projectId: id, entries }));
        if (req.method === "GET" && !parts[5]) return send(res, 200, analysis);
        if (req.method === "POST" && parts[5] === "publish") {
          if (!Array.isArray(body.expectedSources) || JSON.stringify(body.expectedSources) !== JSON.stringify(analysis.onboarding.sourceRefs)) throw new HttpError(409, "The onboarding sources changed. Review the current summary before publishing");
          if (!analysis.onboarding.sourceRefs.length) throw new HttpError(400, "There is no current trusted user guidance to publish");
          return send(res, 201, await attempt(() => memoryStore.propose({ scope: "project", repo, projectId: id, title: analysis.onboarding.title, body: analysis.onboarding.body, tags: ["onboarding-summary"], derivedFrom: analysis.onboarding.sourceRefs, sourceRefs: analysis.onboarding.sourceRefs.map((ref) => `${ref.id}@${ref.revision}`) }, { kind: "user", repo, projectId: id }, { expectedSources: analysis.onboarding.sourceRefs })));
        }
        throw new HttpError(404, "Unknown memory analysis operation");
      }
      if (req.method === "GET" && !parts[4]) {
        const entries = (await Promise.all(repos.map((repo) => memoryStore.list({ repo, projectId: id, scope: "project" }, { kind: "user", repo, projectId: id })))).flat();
        return send(res, 200, entries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)));
      }
      if (req.method === "POST" && parts[4] === "commands" && !parts[5]) {
        const body = await readJson(req);
        try {
          let entry: MemoryEntry;
          if (body.op === "create") {
            const repo = typeof body.repo === "string" ? body.repo : project.repos.length === 1 ? project.repos[0]! : "";
            if (!project.repos.includes(repo)) throw new HttpError(400, "Choose a repository in this project");
            // This authenticated endpoint creates user-authored rules. Caller-provided
            // authority, origins, verification, run IDs and status are never forwarded.
            entry = await memoryStore.propose({
              scope: "project", repo, projectId: id, title: body.title, body: body.body,
              paths: body.paths, tags: body.tags, applicability: body.applicability,
            }, { kind: "user", repo, projectId: id });
          } else {
            if (!["approve", "update", "delete", "feedback"].includes(body.op)) throw new HttpError(400, "Unknown memory command");
            if (typeof body.id !== "string" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw new HttpError(400, "Memory commands need an entry ID and exact revision");
            const entries = (await Promise.all(project.repos.map((repo) => memoryStore.list({ repo, projectId: id, scope: "project" }, { kind: "user", repo, projectId: id })))).flat();
            const existing = entries.find((candidate) => candidate.id === body.id);
            if (!existing) throw new HttpError(404, "Memory entry not found in this project");
            const authority: MemoryAuthority = { kind: "user", repo: existing.repo, projectId: id };
            if (body.op === "approve") entry = await memoryStore.accept(existing.id, body.expectedRevision, authority);
            else if (body.op === "delete") entry = await memoryStore.remove(existing.id, body.expectedRevision, authority);
            else if (body.op === "feedback") {
              if (body.runId !== undefined) {
                const source = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
                if (!source || source.repo !== existing.repo || source.project !== id || !source.memoryManifest?.included.some((ref) => ref.id === existing.id && ref.revision === body.expectedRevision)) throw new HttpError(400, "Feedback must refer to memory actually selected by this project's run");
              }
              entry = await memoryStore.recordFeedback(existing.id, body.expectedRevision, { rating: body.rating, note: body.note, runId: body.runId }, authority);
            }
            else {
              const patch: Parameters<typeof memoryStore.revise>[2] = {};
              for (const key of ["title", "body", "paths", "tags", "applicability"] as const) if (key in body) patch[key] = body[key];
              // Saving an edit never accepts a proposal by itself; `accept: true` says so explicitly.
              entry = await memoryStore.revise(existing.id, body.expectedRevision, patch, authority, { accept: body.accept === true });
            }
          }
          return send(res, body.op === "create" ? 201 : 200, entry);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof MemoryConflictError) throw new HttpError(409, error.message);
          const message = (error as Error).message;
          // A store that cannot be read or written is the server's fault, not the request's.
          if (/^Memory store cannot be read|^Memory storage limit/.test(message)) throw new HttpError(500, message);
          throw new HttpError(400, message);
        }
      }
      throw new HttpError(404, "Unknown project memory route");
    }
    if (id && req.method === "POST") {
      const body = await readJson(req);
      return send(res, 200, await attempt(() => manager.updateProject(id, { name: body.name, repos: Array.isArray(body.repos) ? body.repos : undefined })));
    }
    if (id && req.method === "DELETE") {
      await manager.removeProject(id);
      return send(res, 200, { deleted: true });
    }
  }
  if (req.method === "GET" && parts[1] === "templates") return send(res, 200, templates);
  if (parts[1] === "remote") {
    if (process.env.CODEFLOW_SSH_HOST && req.method !== "GET") throw new HttpError(403, "Use SSH to reach this backend; phone listeners are unavailable on SSH hosts");
    if (parts[2] === "devices") {
      if (req.method === "GET") return send(res, 200, phoneSessions.list(remote.controlToken));
      if (req.method === "DELETE" && parts[3]) return send(res, 200, { revoked: await phoneSessions.revoke(parts[3], remote.controlToken) });
      throw new HttpError(404, "Unknown paired device operation");
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.transport !== undefined && body.transport !== "lan" && body.transport !== "tailscale") throw new HttpError(400, "Choose Wi-Fi or Tailscale for remote access");
      // Turning anything off makes new secrets: old links and phones' cookies stop working.
      const before = await changeSavedRemote({ enabled: body.enabled, lan: body.lan, transport: body.transport, control: body.control, rotate: !!body.rotate }).catch((err) => {
        if (err instanceof HttpError) throw err;
        logError("Couldn't save the phone settings", err);
        throw new HttpError(500, `Couldn't save the phone settings: ${(err as Error).message}`);
      });
      const signOut = remote.controlToken !== before.controlToken || remote.token !== before.token || (phoneControl(before) && !phoneControl());
      // Listening starts now, so the reply's links (or why there are none) are real.
      if (remote.transport === "tailscale") await refreshTailscale();
      // A remote caller must receive its reply before its own connection is closed.
      if (via === "local") await syncLanServer(signOut);
      // Signing out waits until after replying (or a dropped request): the phone may be the one
      // turning itself off.
      if (via === "lan") res.once("close", () => void syncLanServer(signOut));
    } else if (req.method === "GET") {
      await refreshTailscale(url.searchParams.has("refresh"));
      if (via === "local") await syncLanServer();
      else res.once("close", () => void syncLanServer());
    } else throw new HttpError(405, "Method not allowed");
    return send(res, 200, remoteInfo());
  }
  if (parts[1] === "automations") {
    if (parts[2] === "schedule-preview" && req.method === "POST") {
      const body = await readJson(req);
      const schedule = await attempt(async () => validateSchedule(body.schedule));
      if (!schedule) throw new HttpError(400, "Choose a schedule");
      return send(res, 200, { times: await attempt(async () => previewSchedule(schedule, body.after, body.count)) });
    }
    const id = parts[2];
    if (!id && req.method === "GET") return send(res, 200, automations.list().map(describeAutomation));
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (!name) throw new HttpError(400, "Name the automation");
      const run = automationRun(body.run ?? {});
      await buildStartInput(run); // same checks as starting it now
      const schedule = await attempt(async () => validateSchedule(body.schedule));
      if (!schedule && !body.webhook) throw new HttpError(400, "Give it a schedule, a webhook, or both");
      const trigger = await automations.create({ name, enabled: body.enabled !== false, run, schedule, webhook: !!body.webhook, isolate: !!body.isolate, image: typeof body.image === "string" ? body.image.trim() || undefined : undefined });
      return send(res, 201, describeAutomation(trigger));
    }
    if (id && !automations.get(id)) throw new HttpError(404, "Automation not found");
    if (id && parts[3] === "events" && req.method === "GET") return send(res, 200, redactExport(automations.events(id)));
    if (id && parts[3] === "events" && parts[4] && parts[5] === "retry" && req.method === "POST") return send(res, 200, await attempt(() => automations.retryEvent(id, parts[4]!)));
    if (id && parts[3] === "preview" && req.method === "POST") {
      const body = await readJson(req);
      return send(res, 200, redactExport(await attempt(() => automations.dryRun(id, Object.keys(body).length ? body : undefined))));
    }
    if (id && req.method === "DELETE") {
      await automations.remove(id);
      return send(res, 200, { deleted: true });
    }
    if (id && req.method === "POST" && parts[3] === "run") {
      const fired = await attempt(() => automations.fire(id, { via: "manual" }));
      if (fired.skipped) throw new HttpError(409, `Skipped: ${fired.skipped}`);
      return send(res, 201, { id: fired.run?.id ?? fired.runs?.[0]?.id, ids: fired.runs?.map((r) => r.id) });
    }
    if (id && req.method === "POST" && !parts[3]) {
      const body = await readJson(req);
      const patch: Parameters<typeof automations.update>[1] = {};
      if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.webhook === "boolean") patch.webhook = body.webhook;
      if (typeof body.isolate === "boolean") patch.isolate = body.isolate;
      if (typeof body.image === "string") patch.image = body.image.trim() || undefined;
      if ("schedule" in body) patch.schedule = await attempt(async () => validateSchedule(body.schedule));
      if (body.run) { const run = automationRun(body.run); await buildStartInput(run); patch.run = run; }
      if (body.rotateToken) patch.rotateToken = true;
      return send(res, 200, describeAutomation(await automations.update(id, patch)));
    }
  }
  if (req.method === "GET" && parts[1] === "github" && parts[2] === "sweep") {
    const repo = await requestedRepo(url);
    const kind = url.searchParams.get("kind") as SweepKind;
    if (!SWEEP_KINDS.includes(kind)) throw new HttpError(400, "Unknown kind of sweep");
    return send(res, 200, await attempt(() => listSweep(repo, kind, manager.list())));
  }
  if (req.method === "POST" && parts[1] === "sweeps") return send(res, 201, await startSweep(await readJson(req)));
  if (req.method === "GET" && parts[1] === "github" && (parts[2] === "issues" || parts[2] === "prs")) {
    const repo = await requestedRepo(url);
    return send(res, 200, await attempt<unknown[]>(() => (parts[2] === "issues" ? listIssues(repo) : listPullRequests(repo))));
  }
  if (req.method === "GET" && parts[1] === "repo-config") {
    const repo = await requestedRepo(url);
    return send(res, 200, await readRepoConfig(repo));
  }
  if (req.method === "GET" && parts[1] === "check") {
    const repo = await requestedRepo(url);
    return send(res, 200, (await detectCheckCommand(repo)) ?? { command: null });
  }
  if (req.method === "GET" && parts[1] === "search") {
    const repo = await requestedFolder(url);
    return send(res, 200, await searchFiles(repo, url.searchParams.get("q") ?? ""));
  }
  if (req.method === "GET" && parts[1] === "file") {
    const repo = await requestedFolder(url);
    const content = await readRepoFile(repo, url.searchParams.get("path") ?? "").catch((err: NodeJS.ErrnoException) => {
      if (err instanceof FilePolicyError) throw new HttpError(err.status, err.message);
      throw new HttpError(err.code === "ENOENT" ? 404 : 400, err.code === "ENOENT" ? "File not found" : err.message);
    });
    return send(res, 200, content);
  }
  // The side panel's Notes: one per repository, and a general one.
  if (parts[1] === "notes") {
    if (req.method === "GET" && parts[2] === "search") return send(res, 200, await attempt(() => notes.search(url.searchParams.get("q") ?? "")));
    if (req.method === "GET" && parts[2] === "all") return send(res, 200, await notes.keys());
    if (req.method === "GET" && parts[2] === "history") return send(res, 200, await notes.history(url.searchParams.get("key") ?? ""));
    if (req.method === "POST" && parts[2] === "restore") {
      const body = await readJson(req);
      try { return send(res, 200, await notes.restore(String(body.key ?? ""), body.revision, body.expectedRevision)); }
      catch (error) { if (error instanceof NotesConflictError) throw new HttpError(409, error.message); throw error; }
    }
    if (req.method === "GET") return send(res, 200, await notes.get(url.searchParams.get("key") ?? ""));
    if (req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.text !== "string") throw new HttpError(400, "Send the note's text");
      try { return send(res, 200, await notes.set(String(body.key ?? ""), body.text, body.expectedRevision)); }
      catch (error) { if (error instanceof NotesConflictError) return send(res, 409, { error: error.message, current: error.current }); throw new HttpError(400, (error as Error).message); }
    }
  }
  // Every app started with "Run app", for the side panel's Browser.
  if (req.method === "GET" && parts[1] === "serve") return send(res, 200, manager.devServers.list());
  // The side panel's Terminal: shells that stay open, fed over POST, streamed over SSE.
  if (parts[1] === "preview" && req.method === "POST") {
    const body = await readJson(req);
    // On the host name this page was opened with (checkOrigin allows only code-flow's own), so the app is same-site with it.
    return send(res, 200, await attempt(() => previews.show(String(body.url ?? ""), req.headers.host)));
  }
  // Snapshot mode: a screenshot of any page, in a headless Chrome of its own (src/snapshot.ts). It
  // keeps away from this computer, except a local app at the address the Browser's preview takes
  // (http://localhost:<port>), never code-flow's own.
  if (parts[1] === "snapshot" && req.method === "POST") {
    const body = await readJson(req);
    const localApp = (url: URL) => {
      const target = previewTarget(url.href);
      return !!target && target.port !== PORT && target.port !== REMOTE_PORT;
    };
    try {
      return send(res, 200, await takeSnapshot({ url: String(body.url ?? ""), width: Number(body.width), height: body.height === undefined ? undefined : Number(body.height), full: body.full === true }, { localApp }));
    } catch (err) {
      if (err instanceof SnapshotError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }
  if (parts[1] === "shell") {
    const id = parts[2];
    if (!id && req.method === "GET") return send(res, 200, shells.list());
    if (!id && req.method === "POST") {
      const body = await readJson(req);
      const cwd = String(body.cwd ?? "").trim();
      if (!cwd.startsWith("/")) throw new HttpError(400, "The folder must be an absolute path");
      if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) throw new HttpError(404, "Folder not found");
      // A repository or one of its worktrees: not just any folder a request names. A run's
      // worktree is known without asking git, which would go by the `.git` agents can rewrite.
      if (!(await manager.worktreeAt(cwd).then(Boolean, () => false))) {
        await repoRoot(cwd).catch(() => {
          throw new HttpError(400, "The terminal opens in a git repository or one of its worktrees");
        });
      }
      manager.noteActivity(); // commands run on this machine, like Run app
      try {
        // `pty`: a real terminal of `cols` × `rows` (line-based, `interactive: false`, without python3).
        return send(res, 201, await shells.open(cwd, { pty: body.pty === true, cols: body.cols, rows: body.rows }));
      } catch (err) {
        if (err instanceof ShellLimitError) throw new HttpError(409, err.message);
        throw err;
      }
    }
    if (id && !shells.get(id)) throw new HttpError(404, "That terminal is gone (code-flow restarted?)");
    if (id && req.method === "GET" && parts[3] === "events") return streamTopic(req, res, "shell", id);
    if (id && req.method === "GET") return send(res, 200, shells.get(id));
    if (id && req.method === "POST" && parts[3] === "input") {
      const body = await readJson(req);
      // An interactive shell takes keystrokes as typed (`data`: a paste, an arrow key's escape
      // sequence) or bytes (`binary`, one per character: xterm's mouse reports, which aren't
      // UTF-8); `text` is a whole command, sent with Enter, for either kind.
      const keys = typeof body.binary === "string" ? body.binary : body.data;
      if (typeof keys === "string" && shells.get(id)?.interactive) {
        if (keys.length > 1_000_000) throw new HttpError(413, "That paste is too long");
        if (!shells.type(id, keys, typeof body.binary === "string" ? "latin1" : "utf8")) throw new HttpError(409, "That shell has exited; open a new one");
        return send(res, 200, shells.get(id));
      }
      if (typeof body.text !== "string" || body.text.length > 20_000) throw new HttpError(400, "Send a command");
      if (!shells.write(id, body.text)) throw new HttpError(409, "That shell has exited; open a new one");
      return send(res, 200, shells.get(id));
    }
    if (id && req.method === "POST" && parts[3] === "resize") {
      const body = await readJson(req);
      const [cols, rows] = [Number(body.cols), Number(body.rows)];
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new HttpError(400, "Send the size as whole numbers: cols and rows");
      if (!shells.get(id)?.interactive) throw new HttpError(409, "Only an interactive terminal has a size");
      if (!shells.resize(id, cols, rows)) throw new HttpError(409, "That shell has exited; open a new one");
      return send(res, 200, shells.get(id));
    }
    if (id && req.method === "DELETE") return send(res, 200, { closed: shells.close(id) });
  }
  if (req.method === "POST" && parts[1] === "improve-prompt" && parts.length === 2) return improveTask(await readJson(req, 256 * 1024), res);
  if (req.method === "GET" && parts[1] === "models") {
    const agents = await agentAvailability();
    const entries = await Promise.all(
      agents.map(async (a) => {
        if (!a.available) return [a.id, { error: "not installed" }] as const;
        return [a.id, await agentCatalog(a.id).catch((err: Error) => ({ error: err.message }))] as const;
      }),
    );
    return send(res, 200, Object.fromEntries(entries));
  }

  if (parts[1] === "runs") {
    const runId = parts[2];
    if (!runId) {
      if (req.method === "GET") return send(res, 200, url.searchParams.has("limit") ? await attempt(async () => fileAccess.page({ limit: Number(url.searchParams.get("limit")), cursor: url.searchParams.get("cursor") ?? undefined, before: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined, query: url.searchParams.get("q") ?? undefined, project: url.searchParams.get("project") ?? undefined })) : fileAccess.list());
      if (req.method === "POST") {
        const body = await readJson(req);
        const run = await startFromBody(body);
        // The composer asks for its team to be remembered: next time you're in the project it starts
        // from it. A side-panel chat, or a reply (the old run's team), isn't that choice.
        if (run.project && body.remember === true && !body.parentRunId) {
          void projects.remember(run.project, { pattern: run.pattern, roles: requestedRoles(findPattern(run.pattern)!, body.roles), roleSettings: run.roleSettings, agentSettings: validateAgentSettings(body.agentSettings) });
        }
        return send(res, 201, { id: run.id, project: run.project });
      }
    }

    const run = runId ? manager.get(runId) : undefined;
    if (!run) throw new HttpError(404, "Run not found");
    if (parts[3] === "collaboration" && parts.length === 4) {
      if (req.method === "GET") return send(res, 200, await attempt(() => collaborationReviews.list(run.id)));
      if (req.method === "POST") {
        const body = await readJson(req, 16 * 1024, { timeoutMs: 10_000 });
        if (typeof body.branch !== "string" || !run.worktrees.some((tree) => tree.branch === body.branch)) throw new HttpError(400, "Choose an owned result branch");
        return send(res, 201, await attempt(() => collaborationReviews.add(run.id, { branch: body.branch, expectedHead: body.expectedHead, text: body.text }, { id: "owner", name: "Owner" }, async () => (await manager.reviewCoverage(run.id, body.branch)).head)));
      }
      throw new HttpError(405, "Use GET or POST for human collaboration comments");
    }
    if (parts[3] === "pr-threads" && parts.length === 4 && ["GET", "POST"].includes(req.method ?? "")) {
      const branch = url.searchParams.get("branch") ?? "", prUrl = branch ? run.prs[branch] : run.source?.kind === "pr" ? run.source.url : Object.values(run.prs).length === 1 ? Object.values(run.prs)[0] : undefined;
      if (!prUrl) throw new HttpError(400, "Choose a pull request stored on this run");
      const abort = new AbortController(); res.once("close", () => abort.abort());
      try {
        if (req.method === "GET") return send(res, 200, await reviewThreads.list(run.repo, prUrl, abort.signal));
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Provide a review thread action object");
        if (body.action === "load") return send(res, 200, await reviewThreads.detail(run.repo, prUrl, { snapshotId: body.snapshotId, threadId: body.threadId }, abort.signal));
        if (body.action !== "resolve") throw new HttpError(400, "Choose load or an explicit resolve action");
        return send(res, 200, await reviewThreads.setResolved(run.repo, prUrl, body, abort.signal));
      } catch (error) { if (error instanceof HttpError) throw error; if (error instanceof ReviewThreadError) throw new HttpError(error.status, error.message); throw new HttpError(502, (error as Error).message); }
    }
    if (req.method === "GET" && parts.length === 3) return send(res, 200, run);
    if (req.method === "GET" && parts[3] === "evaluation") {
      const report = (await teamEvaluationStore.list()).find((item) => item.runId === run.id && item.at === run.endedAt);
      if (report) return send(res, 200, report);
      const journal = await loadJournal(run.id, { strict: run.pattern === "auto-team" });
      const memoryEntries = run.project && projects.get(run.project)?.repos.includes(run.repo) ? await memoryStore.list({ repo: run.repo, projectId: run.project, scope: "project" }, { kind: "user", repo: run.repo, projectId: run.project }) : [];
      return send(res, 200, buildTeamEvaluation(run, { replay: run.recovery, journal, memoryEntries }));
    }
    if (req.method === "GET" && parts[3] === "export") {
      return send(res, 200, redactExport({ version: 1, exportedAt: Date.now(), run, verificationMarkdown: run.verification ? renderVerificationReport(run.verification) : undefined, events: url.searchParams.get("transcript") === "1" ? await manager.events(run.id) : undefined }));
    }
    if (parts[3] === "review-coverage") {
      if (req.method === "GET") return send(res, 200, await attempt(() => manager.reviewCoverage(run.id, url.searchParams.get("branch") ?? "")));
      if (req.method === "POST") { const body = await readJson(req); return send(res, 200, await attempt(() => manager.recordFileReview(run.id, body))); }
    }
    if (parts[3] === "human-rework" && req.method === "POST") { const body = await readJson(req); return send(res, 201, await attempt(() => manager.recordHumanRework(run.id, body))); }
    if (parts[3] === "launch-profiles") {
      const body = req.method === "POST" ? await readJson(req) : {};
      const name = typeof body.worktree === "string" ? body.worktree : url.searchParams.get("worktree");
      const worktree = run.worktrees.find((tree) => tree.name === name);
      if (!worktree) throw new HttpError(400, "Choose a worktree owned by this run");
      const key = `${run.id}/${worktree.name}/launch`;
      if (req.method === "DELETE") return send(res, 200, { stopped: launchProfiles.stop(key) });
      const config = await readLaunchProfiles(worktree.path);
      if (req.method === "GET") return send(res, 200, redactExport({ ...config, session: launchProfiles.get(key) ?? null }));
      if (req.method === "POST") {
        const profile = config.profiles.find((profile) => profile.id === body.profile);
        if (!profile) throw new HttpError(400, config.error ?? "Choose a configured launch profile");
        const abort = new AbortController(); res.once("close", () => abort.abort());
        try {
          manager.noteActivity();
          return send(res, 201, redactExport(await launchProfiles.start(key, worktree.path, profile, { signal: abort.signal, lockdown: run.lockdown, allowUntrusted: body.allowUntrusted === true })));
        } catch (error) {
          if (error instanceof LaunchProfileError) throw Object.assign(new HttpError(error.status, error.message), { confirm: error.confirm });
          throw new HttpError(400, (error as Error).message);
        }
      }
      throw new HttpError(404, "Unknown launch profile operation");
    }
    if (req.method === "GET" && parts[3] === "events") return await streamTopic(req, res, "run", run.id);
    if (req.method === "POST" && parts[3] === "revise-goal") {
      const body = await readJson(req);
      const revised = await attempt(() => manager.reviseGoal(run.id, { message: body.message, budget: body.budget === undefined ? undefined : { maxSteps: body.budget?.maxSteps, maxInvocations: body.budget?.maxInvocations, maxMinutes: body.budget?.maxMinutes } }));
      return send(res, 201, { id: revised.id });
    }
    if (req.method === "POST" && parts[3] === "rerun-tasks") {
      const body = await readJson(req);
      const child = await attempt(() => manager.rerunTeamTasks(run.id, body));
      return send(res, 201, { id: child.id });
    }
    if (req.method === "POST" && parts[3] === "pause") {
      const body = await readJson(req);
      return send(res, 200, await attempt(async () => manager.setPaused(run.id, body.paused !== false)));
    }
    if (req.method === "POST" && parts[3] === "priority") {
      const body = await readJson(req);
      return send(res, 200, await attempt(async () => manager.setPriority(run.id, body.priority)));
    }
    if (req.method === "POST" && parts[3] === "fork") {
      const body = await readJson(req);
      const checkpoint = typeof body.commit === "string" ? body.commit : undefined;
      if (!checkpoint || !/^[a-f0-9]{40,64}$/i.test(checkpoint)) throw new HttpError(400, "Choose an exact checkpoint commit");
      const owned = await Promise.all(run.worktrees.map(async (tree) => (await git(["merge-base", "--is-ancestor", checkpoint, tree.branch], run.repo)).code === 0));
      if (!owned.some(Boolean)) throw new HttpError(400, "The checkpoint is not part of this run");
      const fork = await startFromBody({ repo: run.repo, project: run.project, pattern: run.pattern, task: typeof body.task === "string" ? body.task : run.task, baseRef: checkpoint, parentRunId: run.id, roles: run.roles, options: run.options, loop: run.loop, agentSettings: run.agentSettings, roleSettings: run.roleSettings, trust: run.trust, approvals: run.approvals });
      return send(res, 201, { id: fork.id });
    }
    if (req.method === "POST" && parts[3] === "cancel") return send(res, 200, { cancelled: manager.cancel(run.id) });
    if (req.method === "POST" && parts[3] === "resume") {
      await manager.resume(run.id).catch((err: Error) => {
        throw new HttpError(400, err.message);
      });
      return send(res, 200, { resumed: true });
    }
    if (req.method === "POST" && parts[3] === "project") {
      const body = await readJson(req);
      if (typeof body.project !== "string" || !projects.get(body.project)) throw new HttpError(400, "Pick a project");
      return send(res, 200, await attempt(() => manager.setProject(run.id, body.project)));
    }
    if (req.method === "POST" && parts[3] === "seen") {
      manager.setSeen(run.id, true);
      return send(res, 200, { seen: true });
    }
    if (req.method === "POST" && parts[3] === "archive") {
      const body = await readJson(req);
      if (body.archived === false) {
        await attempt(async () => manager.setArchived(run.id, false));
        return send(res, 200, { archived: false });
      }
      const result = await attempt(() => manager.archive(run.id, { cleanup: body.cleanup !== false, deleteBranches: !!body.deleteBranches }));
      return send(res, 200, { archived: true, ...result });
    }
    if (req.method === "GET" && parts[3] === "diff") {
      const files = await attempt(() => manager.diff(run.id, url.searchParams.get("branch") ?? "", url.searchParams.get("last") === "1"));
      return send(res, 200, filterPolicyDiff(await fileAccess.forRepo(run.repo, run), files));
    }
    if (req.method === "POST" && parts[3] === "followups") {
      const body = await readJson(req);
      if (!isAgentId(body.agent)) throw new HttpError(400, "Pick an agent");
      const side = body.kind === "side" ? sideTurn(body.side) : undefined;
      await attempt(() =>
        manager.followUp(run.id, {
          kind: side ? "side" : body.kind === "resolve-conflicts" ? "resolve-conflicts" : body.kind === "reply" ? "reply" : "comments",
          side,
          worktree: String(body.worktree ?? ""),
          agent: body.agent,
          message: typeof body.message === "string" ? body.message : undefined,
          mergeFrom: typeof body.mergeFrom === "string" ? body.mergeFrom : undefined,
          budget: body.budget === undefined ? undefined : { maxSteps: body.budget?.maxSteps, maxInvocations: body.budget?.maxInvocations, maxMinutes: body.budget?.maxMinutes },
          attachments: Array.isArray(body.attachments) ? body.attachments.filter((a: any) => a && typeof a.data === "string").map((a: any) => ({ name: String(a.name ?? "file"), data: a.data })) : undefined,
        }),
      );
      return send(res, 200, { ok: true });
    }
    // /api/runs/:id/worktrees/:name/(open|serve)
    if (parts[3] === "worktrees" && parts[4]) {
      const wt = run.worktrees.find((w) => w.name === parts[4]);
      if (!wt) throw new HttpError(404, "Unknown worktree");
      const key = `${run.id}/${wt.name}`;
      if (req.method === "POST" && parts[5] === "open") {
        const body = await readJson(req);
        const target = body.target === "editor" || body.target === "finder" ? body.target : "terminal";
        return send(res, 200, { openedWith: await attempt(() => openFolder(wt.path, target)) });
      }
      if (parts[5] === "serve") {
        if (req.method === "GET") return send(res, 200, manager.devServers.get(key) ?? null);
        if (req.method === "DELETE") return send(res, 200, { stopped: manager.devServers.stop(key) });
        if (req.method === "POST") {
          const body = await readJson(req);
          const command = (typeof body.command === "string" && body.command.trim()) || run.app?.command;
          if (!command) throw new HttpError(400, 'Say how to run the app (e.g. "npm run dev"), or add "run" to .codeflow/config.json');
          if (/[\r\n]/.test(command)) throw new HttpError(400, "The command must be a single line");
          // A locked-down run's code is an outsider's, and the app runs on this machine, never in
          // Docker: the same confirmation its checks would need.
          if (run.lockdown && body.allowUntrusted !== true) {
            throw Object.assign(new HttpError(409, `${run.lockdown}. Run app starts that code on this machine, outside any sandbox or container.`), { confirm: "allowUntrusted" });
          }
          manager.noteActivity(); // the app is the repo's code running on this machine
          return send(res, 200, await manager.devServers.start(key, wt.path, command, run.app?.port));
        }
      }
    }
    if (req.method === "POST" && parts[3] === "notes") {
      const body = await readJson(req);
      const note = await attempt(async () => typeof body.requestId === "string"
        ? manager.answerTeamQuestion(run.id, body.requestId, String(body.text ?? ""))
        : (run.team ? manager.addTeamNote.bind(manager) : manager.addNote.bind(manager))(run.id, String(body.text ?? ""), isAgentId(body.agent) ? body.agent : undefined, typeof body.memberId === "string" ? body.memberId : undefined));
      return send(res, 200, note);
    }
    if (req.method === "POST" && parts[3] === "answer") {
      const body = await readJson(req);
      const decision = body.decision;
      if (decision !== "approve" && decision !== "revise" && decision !== "reject") throw new HttpError(400, "Unknown decision");
      await attempt(async () => manager.answer(run.id, { decision, note: typeof body.note === "string" ? body.note : undefined }));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && parts[3] === "team-plan") {
      const body = await readJson(req);
      return send(res, 200, { team: await attempt(() => manager.editTeamPlan(run.id, body)) });
    }
    if (req.method === "POST" && parts[3] === "merge") {
      const body = await readJson(req);
      const outcome = await attempt(() =>
        manager.merge(run.id, { branch: String(body.branch ?? ""), into: String(body.into ?? ""), archiveAfter: !!body.archiveAfter, requireValidation: body.requireValidation === true }),
      );
      return send(res, 200, outcome);
    }
    if (req.method === "POST" && parts[3] === "validate-merge") {
      const body = await readJson(req);
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      try { return send(res, 200, await manager.validateMerge(run.id, { branch: String(body.branch ?? ""), into: String(body.into ?? ""), allowUntrusted: body.allowUntrusted === true }, abort.signal)); }
      catch (error) { if (error instanceof UntrustedSourceError) throw Object.assign(new HttpError(409, error.message), { confirm: "allowUntrusted" }); throw new HttpError(400, (error as Error).message); }
    }
    if (req.method === "GET" && parts[3] === "pr-merge") {
      return send(res, 200, await attempt(() => manager.prMergeInfo(run.id, url.searchParams.get("branch") ?? "")));
    }
    if (req.method === "POST" && parts[3] === "merge-pr") {
      const body = await readJson(req);
      if (!MERGE_METHODS.includes(body.method)) throw new HttpError(400, "Pick how to merge: merge, squash or rebase");
      const outcome = await attempt(() => manager.mergePr(run.id, { branch: String(body.branch ?? ""), method: body.method, archiveAfter: !!body.archiveAfter }));
      return send(res, 200, outcome);
    }
    if (req.method === "GET" && parts[3] === "pr-targets") {
      // Branches on GitHub a pull request can go into, and the one it would go into by default.
      const targets = await attempt(async () => {
        const { branches } = await remoteBranches(run.repo);
        return { branches, initial: await manager.pullRequestTarget(run.id) };
      });
      return send(res, 200, targets);
    }
    if (req.method === "POST" && parts[3] === "pr") {
      const body = await readJson(req);
      const prUrl = await attempt(() => manager.pullRequest(run.id, { branch: String(body.branch ?? ""), into: String(body.into ?? "") }));
      return send(res, 200, { url: prUrl });
    }
    if (req.method === "POST" && parts[3] === "triage") {
      const body = await readJson(req);
      if (!["approve", "revise", "reject"].includes(body.decision)) throw new HttpError(400, "Unknown decision");
      await attempt(() => manager.triage(run.id, { decision: body.decision, note: typeof body.note === "string" ? body.note : undefined, openPr: !!body.openPr, pushPr: !!body.pushPr, budget: body.budget === undefined ? undefined : { maxSteps: body.budget?.maxSteps, maxInvocations: body.budget?.maxInvocations, maxMinutes: body.budget?.maxMinutes } }));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && parts[3] === "push-pr") {
      const body = await readJson(req);
      return send(res, 200, await attempt(() => manager.pushToPr(run.id, { branch: String(body.branch ?? "") })));
    }
    if (req.method === "POST" && parts[3] === "post-review") {
      return send(res, 200, { url: await attempt(() => manager.postReview(run.id)) });
    }
    if (req.method === "POST" && parts[3] === "watch") {
      const body = await readJson(req);
      const branch = String(body.branch ?? "");
      if (body.stop) {
        await attempt(async () => manager.unwatchPr(run.id, branch));
        return send(res, 200, { watching: false });
      }
      if (!isAgentId(body.agent)) throw new HttpError(400, "Pick the agent that fixes problems");
      const allow = Array.isArray(body.allow) ? body.allow.filter((a: unknown): a is string => typeof a === "string").slice(0, 20) : [];
      const watch = await attempt(async () => manager.watchPr(run.id, { branch, agent: body.agent, maxFixes: Number(body.maxFixes) || undefined, allow }));
      void watcher.poll();
      return send(res, 200, watch);
    }
  }

  throw new HttpError(404, "Not found");
}

await manager.load();
await projects.load(manager.list());
await fileAccess.all().catch((error) => logError("Filesystem policy is unavailable; protected operations and extension loading remain disabled until the private policy file is repaired", error));
filteredTasksReady = await filteredTasks.load().then(() => true, (error) => { logError("Filtered tasks unavailable; policy activation remains blocked until task receipts are repaired", error); return false; });
if (!fileAccess.hasRestrictions()) await extensions.load().catch((error) => logError("Extension configuration could not be loaded; built-in workflows remain available", error));
else logWarn("Extensions deferred: custom filesystem policy cannot isolate trusted plugin initialization; clear the policy and restart to load extensions");
await codeHostsApi.service.load();
await automations.load();
await deferredRuns.load();
await coordinatedApi.service.load();
await coordinatedApi.recover().catch((error) => logError("A coordinated launch requires manual recovery", error));
await recoverDeferredRuns(deferredRuns, manager).catch((error) => logError("A deferred launch requires manual recovery", error));
remote = await loadRemote();
await phoneSessions.load().catch((error) => logError("Phone pairing disabled: session storage cannot be read", error));
if (notificationsReady) {
  manager.subscribeAll((run) => { void notifications.observe(run).catch((error) => logError("Notification event could not be retained", error)); });
  approvals.subscribe(() => {
    for (const request of approvals.list()) {
      const run = request.status === "pending" ? manager.get(request.runId) : undefined;
      if (run) void notifications.observe(run, `tool-approval:${request.id}`).catch((error) => logError("Approval notification could not be retained", error));
    }
  });
}
if (!fileAccess.hasRestrictions()) startPolicyBackground();
else await pausePolicyBackground();
if (!process.env.CODEFLOW_SSH_HOST) void (async () => {
  if (remote.transport === "tailscale") await refreshTailscale();
  await syncLanServer();
})();
const tailscaleTimer = setInterval(() => {
  if (!process.env.CODEFLOW_SSH_HOST && remote.enabled && remote.lan && remote.transport === "tailscale") {
    void refreshTailscale().then(() => syncLanServer()).catch((err) => logError("Tailscale access refresh failed", err));
  }
}, 10_000);
tailscaleTimer.unref();

function listener(via: Via) {
  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, via).catch((err: Error & { confirm?: string; signIn?: boolean }) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) logError(`${req.method} ${req.url?.split("?")[0]} failed`, err);
      if (res.headersSent) return res.end();
      send(res, status, { error: err.message, confirm: err.confirm, signIn: err.signIn });
    }).finally(() => fileAccess.end(req));
  };
}

const server = createServer({ maxHeaderSize: MAX_HEADER_SIZE }, listener("local")).listen(PORT, HOST, async () => {
  const agents = fileAccess.hasRestrictions() ? [] : await trackPolicyPreparation(() => agentAvailability());
  const runs = manager.list();
  console.log(`code-flow running at http://localhost:${PORT}  (${runs.length} runs loaded from ${CODEFLOW_HOME})`);
  console.log(`  Open http://localhost:${PORT}/?token=${auth.token}  (the first browser to open code-flow signs in without it)`);
  for (const a of agents) console.log(`  ${a.available ? "✓" : "✗"} ${a.displayName} (${a.binary})`);
  const gitHealth = await checkGit();
  if (!gitHealth.ok) {
    console.log(`  ✗ ${gitHealth.warning}`);
    logWarn(gitHealth.warning ?? "git check failed");
  }
  const interrupted = runs.filter((r) => r.status === "interrupted").length;
  if (interrupted) console.log(`  ${interrupted} interrupted run(s) can be resumed from the UI`);
});

// A previous instance may still be shutting down (e.g. a dev restart): wait for the port
// instead of crashing.
let listenAttempts = 0;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && ++listenAttempts <= 40) {
    if (listenAttempts === 1) console.log(`Port ${PORT} is busy; waiting for it to be released…`);
    setTimeout(() => server.listen(PORT, HOST), 500);
    return;
  }
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is still in use. Is code-flow already running?` : err);
  process.exit(1);
});

/**
 * Compare setups: start the same task with several patterns or teams at once (optionally a few
 * times each), as one group. Insights shows them side by side: did it pass, how long, how many
 * steps and tokens, did it touch the tests.
 */
async function startComparison(body: Record<string, any>) {
  const variants = Array.isArray(body.variants) ? body.variants.slice(0, 6) : [];
  if (variants.length < 2) throw new HttpError(400, "Add at least two setups to compare");
  const repeat = Math.min(3, Math.max(1, Math.round(Number(body.repeat) || 1)));
  if (variants.length * repeat > 9) throw new HttpError(400, "That's more than 9 runs; compare fewer setups or repeat less");
  const base = body.run && typeof body.run === "object" ? body.run : {};
  // Check every setup before starting any, so a typo doesn't leave half a comparison running.
  const inputs = await Promise.all(
    variants.map(async (v: Record<string, any>, i: number) => {
      const label = String(v.label ?? "").trim().slice(0, 40) || `Setup ${i + 1}`;
      return {
        label,
        input: await buildStartInput({ ...base, pattern: v.pattern ?? base.pattern, roles: v.roles ?? base.roles, options: v.options ?? base.options, roleSettings: v.roleSettings ?? base.roleSettings }),
      };
    }),
  );
  const group = { id: `g${Date.now().toString(36)}${randomBytes(2).toString("hex")}` };
  const started: string[] = [];
  for (let n = 1; n <= repeat; n++) {
    for (const { label, input } of inputs) {
      const run = await manager.start({ ...input, group: { id: group.id, label: repeat > 1 ? `${label} #${n}` : label } }).catch((err: Error) => {
        throw new HttpError(400, `${label}: ${err.message}`);
      });
      started.push(run.id);
    }
  }
  return { group: group.id, runs: started };
}

/** Runs in a project ("none": in no project), or all runs. */
function runsIn(project: unknown) {
  const all = manager.list();
  if (typeof project !== "string" || !project) return all;
  const list = projects.list();
  return all.filter((r) => (projectOf(r, list) ?? "none") === project);
}

/** Disk space taken by each run's worktrees (every worktree holds its own node_modules…). */
async function diskUsage(all: ReturnType<typeof manager.list>, repo?: string) {
  const runs = all.filter((r) => !repo || r.repo === repo);
  const sizes = await folderSizes(runs.map((r) => r.worktreeDir));
  const list = runs
    .filter((r) => sizes[r.worktreeDir] !== undefined)
    .map((r) => ({ id: r.id, task: r.task.split("\n")[0]!.slice(0, 100), repo: r.repo, status: r.status, archived: r.archived, endedAt: r.endedAt, bytes: sizes[r.worktreeDir]! }))
    .sort((a, b) => b.bytes - a.bytes);
  return { total: list.reduce((n, r) => n + r.bytes, 0), runs: list };
}

/**
 * Remove the worktrees (not the branches) of runs that finished more than `days` ago and need
 * nothing from you: seen, not waiting in the inbox, not watching a PR. Committed work stays on
 * its branch and comes back if you resume or follow up.
 */
async function cleanUp(all: ReturnType<typeof manager.list>, days: number, repo?: string) {
  const cutoff = Date.now() - days * 86_400_000;
  const done: string[] = [];
  let removed = 0;
  for (const r of all) {
    if (repo && r.repo !== repo) continue;
    if (r.status === "running" || !r.endedAt || r.endedAt > cutoff || !r.seen) continue;
    if (r.triage?.state === "pending" || Object.values(r.watches).some((w) => ["watching", "fixing", "green"].includes(w.state))) continue;
    const result = await removeWorktrees(r.repo, r.worktrees, false).catch((err: Error) => ({ removed: [], deletedBranches: [], failed: [err.message] }));
    if (result.failed.length) manager.log(r.id, `Clean-up couldn't remove everything: ${result.failed.join("; ")}`, "warn");
    if (!result.removed.length) continue;
    removed += result.removed.length;
    done.push(r.id);
    if (!r.archived) manager.setArchived(r.id, true);
    manager.log(r.id, `Cleaned up: removed ${result.removed.length} worktree(s); branches kept`);
  }
  return { runs: done.length, worktrees: removed };
}

// Stop cleanly: running agents are stopped and their runs marked "interrupted" (resumable).
// SIGHUP too: closing the terminal that runs code-flow must not leave its agents running.
let stopping = false;
async function stop(reason: string, code = 0) {
  if (stopping) process.exit(1); // second Ctrl-C: don't wait
  stopping = true;
  console.log(`\nStopping code-flow (${reason}): interrupting running runs so they can be resumed…`);
  logInfo(`Stopping: ${reason}`);
  let automationsSaved: Promise<unknown> = Promise.resolve();
  try {
    server.close();
    remoteStopping = true;
    clearInterval(tailscaleTimer);
    lanServer?.close();
    lanServer?.closeAllConnections();
    watcher.stop();
    approvals.close();
    launchProfiles.stopAll();
    shells.closeAll();
    previews.closeAll();
    sshPreviews.closeAll();
    automationsSaved = automations.stop();
  } catch {
    // still starting up: nothing is listening yet
  }
  await sshProjects?.close();
  await coordinatedApi.service.stop().catch((err) => logError("Coordinated changes shutdown failed", err));
  await deferredRuns.stop().catch((err) => logError("Deferred queue shutdown failed", err));
  for (const controller of improvingControllers) controller.abort();
  await filteredTasks.close().catch((err) => logError("Filtered task shutdown failed; inspect its durable unknown receipt before retrying", err));
  await manager.shutdown().catch((err) => logError("Shutdown failed", err));
  await teamToolBridge.close().catch(() => undefined);
  await automationsSaved;
  await notifications.stop();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void stop(signal));
}
