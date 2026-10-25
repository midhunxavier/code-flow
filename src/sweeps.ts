import { ciRepairTask, issueRepairTask } from "./repair-strategy.js";
import type { RunSummary } from "./engine.js";
import { repoRoot } from "./git.js";
import {
  alertsError,
  isPlainPath,
  LIST_CAP,
  listCodeScanningAlerts,
  listDependabotAlerts,
  listDependabotPrs,
  listOpenIssues,
  listSecretScanningAlerts,
  severityRank,
  type PullRequest,
  type SourceInput,
} from "./github.js";

/**
 * Sweeps: start from a whole list of GitHub work — open issues, Dependabot's pull requests,
 * security alerts — pick the items, and start one run per item. Each result waits in the inbox
 * (like an automation's), and nothing is merged automatically.
 */

export type SweepKind = "issues" | "dependabot" | "alerts";

export interface SweepItem {
  /** Stable id for the item ("issue#12", "pr#34", "dependabot#5", "code-scanning#7", "secret#3"). */
  key: string;
  /** "#12", "3 alerts"… */
  ref: string;
  title: string;
  /** One line under the title: labels, CI state, severity and versions… */
  detail: string;
  url: string;
  severity?: string;
  labels?: string[];
  /** Picked unless there's a reason not to; the reason is in `note`. */
  selected: boolean;
  note?: string;
  /** Never handed to an agent (a leaked secret): listed so you can act on it yourself. */
  manual?: boolean;
  /** Listed for context, but starting a repair would be redundant or premature. */
  blockedReason?: string;
  /** A run that already covers this item. */
  existingRun?: string;
  /** What the item's run gets: its task and where it starts from. */
  task?: string;
  source?: SourceInput;
  /**
   * The key sweeps used for this item before alerts were keyed by number
   * ("dependabot:npm/lodash"), so an automation that remembers it doesn't sweep it again.
   */
  legacyKey?: string;
}

export interface SweepList {
  kind: SweepKind;
  items: SweepItem[];
  /** Parts of the list that couldn't be read, and why (e.g. a missing gh scope). */
  notices: string[];
}

/** Labels that usually mean "not a bug to fix": such issues start unpicked. */
const NOT_A_FIX = /^(question|wontfix|won't fix|duplicate|invalid|discussion|needs[- ]info)$/i;

export async function listSweep(repo: string, kind: SweepKind, runs: RunSummary[]): Promise<SweepList> {
  const list = kind === "issues" ? await issueItems(repo) : kind === "dependabot" ? await dependabotItems(repo) : await alertItems(repo);
  // Runs record the repo's resolved root; compare against the same spelling of the path.
  const root = await repoRoot(repo).catch(() => repo);
  for (const item of list.items) {
    const covering = item.source ? coveringRun(runs, root, item.source) : undefined;
    if (covering) {
      item.existingRun = covering.id;
      item.selected = false;
      item.note = covering.status === "running" ? "A run is working on it" : "Already has a run";
      item.blockedReason = item.note;
    }
  }
  return list;
}

/** Says that GitHub had more than a sweep lists. */
const cutShort = (what: string, cap: number) => `Only the first ${cap} ${what} are listed; sweep again once these are done`;

async function issueItems(repo: string): Promise<SweepList> {
  const issues = await listOpenIssues(repo);
  return {
    kind: "issues",
    notices: issues.truncated ? [cutShort("open issues", LIST_CAP)] : [],
    items: issues.items.map((i) => {
      const skip = i.labels.find((l) => NOT_A_FIX.test(l));
      return {
        key: `issue#${i.number}`,
        ref: `#${i.number}`,
        title: i.title,
        detail: i.labels.join(" · "),
        labels: i.labels,
        url: i.url,
        selected: !skip,
        note: skip ? `Labelled “${skip}”` : undefined,
        // Not the title: whoever opened the issue wrote it, and the task is read as instructions.
        // The run gets the title with the issue's text, fenced as information.
        task: issueRepairTask(`issue #${i.number}`),
        source: { kind: "issue", number: i.number },
      };
    }),
  };
}

const CI_NOTE = { pass: "CI passes — no repair needed. Review on GitHub.", pending: "CI is still running — wait for a result", none: "No CI checks reported — inspect on GitHub first" } as const;

async function dependabotItems(repo: string): Promise<SweepList> {
  const prs = await listDependabotPrs(repo);
  return {
    kind: "dependabot",
    notices: prs.truncated ? [cutShort("Dependabot pull requests", prs.items.length)] : [],
    items: prs.items.map((pr) => ({
      key: `pr#${pr.number}`,
      ref: `#${pr.number}`,
      title: pr.title,
      detail: `${pr.ci === "fail" ? "CI failing" : pr.ci === "pass" ? "CI green" : pr.ci === "pending" ? "CI running" : "no CI"} · ${pr.headRefName}`,
      url: pr.url,
      // Only a failing PR needs an agent; code-flow never merges the green ones for you.
      selected: pr.ci === "fail" && !pr.isDraft,
      note: pr.isDraft ? "Draft PR — mark ready on GitHub before repairing" : pr.ci === "fail" ? undefined : CI_NOTE[pr.ci],
      blockedReason: pr.isDraft ? "Draft PR — mark ready on GitHub before repairing" : pr.ci === "fail" ? undefined : CI_NOTE[pr.ci],
      // The PR's title stays out of the task: package names and versions come from upstream.
      task: ciRepairTask(`Dependabot's pull request #${pr.number}`, true),
      source: { kind: "pr", number: pr.number, ciLogs: true },
    })),
  };
}

async function alertItems(repo: string): Promise<SweepList> {
  const [dependabot, codeScanning, secrets, prs] = await Promise.allSettled([
    listDependabotAlerts(repo),
    listCodeScanningAlerts(repo),
    listSecretScanningAlerts(repo),
    listDependabotPrs(repo),
  ]);
  const notices: string[] = [];
  const items: SweepItem[] = [];
  const openPrs = prs.status === "fulfilled" ? prs.value.items : [];
  const note = (what: string, list: { items: unknown[]; truncated: boolean }) => list.truncated && notices.push(cutShort(what, list.items.length));

  if (dependabot.status === "fulfilled") {
    items.push(...dependabotAlertItems(dependabot.value.items, openPrs));
    note("Dependabot alerts", dependabot.value);
  } else notices.push(alertsError("Dependabot alerts", dependabot.reason));

  if (codeScanning.status === "fulfilled") {
    note("code scanning alerts", codeScanning.value);
    for (const a of codeScanning.value.items) {
      const rule = a.rule ?? {};
      const where = a.most_recent_instance?.location ?? {};
      const severity = String(rule.security_severity_level ?? rule.severity ?? "unknown");
      // Security-relevant findings start picked; style notes and low-severity ones don't.
      const serious = severityRank(severity) <= severityRank("medium");
      const title = rule.description || rule.name || rule.id;
      const at = where.path ? `${where.path}${where.start_line ? `:${where.start_line}` : ""}` : "";
      items.push({
        key: `code-scanning#${a.number}`,
        ref: `#${a.number}`,
        title,
        detail: [at, a.tool?.name].filter(Boolean).join(" · "),
        url: a.html_url,
        severity,
        selected: serious,
        note: serious ? undefined : "Low severity",
        // The path is the code's: one that carries words stays out of the task (the run's prompt
        // has it in the alert's fence).
        task: `Fix code scanning alert #${a.number}: ${title}${at && isPlainPath(at) ? ` in ${at}` : ""}. Fix the cause rather than suppressing the alert, and add a test where it makes sense.`,
        source: { kind: "alert", tool: "code-scanning", number: a.number },
      });
    }
  } else notices.push(alertsError("Code scanning alerts", codeScanning.reason));

  if (secrets.status === "fulfilled") {
    note("leaked secrets", secrets.value);
    for (const a of secrets.value.items) {
      items.push({
        key: `secret#${a.number}`,
        ref: `#${a.number}`,
        title: a.secret_type_display_name || a.secret_type || "Leaked secret",
        detail: "Leaked secret — revoke and rotate it, then close the alert",
        url: a.html_url,
        severity: "critical",
        selected: false,
        manual: true,
        note: "Needs you: agents never get secrets",
      });
    }
  } else notices.push(alertsError("Secret scanning alerts", secrets.reason));

  items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.key.localeCompare(b.key));
  return { kind: "alerts", items, notices };
}

/**
 * Dependabot alerts, one item per package: upgrading it fixes them together. The item is keyed
 * by its alerts' numbers, not the package, so a new alert on a package swept before is new work.
 */
function dependabotAlertItems(alerts: any[], prs: PullRequest[]): SweepItem[] {
  const byPackage = new Map<string, any[]>();
  for (const a of alerts) {
    const pkg = a.dependency?.package ?? a.security_vulnerability?.package ?? {};
    const key = `${pkg.ecosystem}/${pkg.name}`;
    byPackage.set(key, [...(byPackage.get(key) ?? []), a]);
  }
  return [...byPackage.entries()].map(([key, group]) => {
    group.sort((a, b) => severityRank(a.security_advisory?.severity) - severityRank(b.security_advisory?.severity));
    const worst = group[0];
    const pkg = worst.dependency?.package ?? worst.security_vulnerability?.package ?? {};
    const numbers = group.map((a) => a.number as number).sort((a, b) => a - b);
    const severity = String(worst.security_advisory?.severity ?? "unknown");
    const patched = group
      .map((a) => a.security_vulnerability?.first_patched_version?.identifier as string | undefined)
      .filter((v): v is string => !!v)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    const covered = prs.find((pr) => upgrades(pr, pkg.name));
    const manifest = worst.dependency?.manifest_path;
    const count = numbers.length > 1 ? `${numbers.length} Dependabot alerts` : `Dependabot alert #${numbers[0]}`;
    return {
      key: `dependabot#${numbers[0]}`,
      legacyKey: `dependabot:${key}`,
      ref: numbers.length > 1 ? `${numbers.length} alerts` : `#${numbers[0]}`,
      title: `${pkg.name} (${pkg.ecosystem})`,
      detail: [`${worst.security_vulnerability?.vulnerable_version_range ?? "?"} → ${patched ?? "no fix yet"}`, worst.security_advisory?.summary].filter(Boolean).join(" · "),
      url: worst.html_url,
      severity,
      selected: !covered && !!patched,
      note: covered ? `Dependabot PR #${covered.number} already upgrades it` : patched ? undefined : "No patched version yet",
      task: patched
        ? `Fix ${count} in ${pkg.name} (${pkg.ecosystem}): upgrade it to ${patched} or later${manifest ? ` in ${manifest}` : ""}. Update anything the upgrade breaks and keep the tests passing.`
        : `Mitigate ${count} in ${pkg.name} (${pkg.ecosystem}): no patched version exists yet. Avoid the vulnerable code path or replace the package, and explain what you did.`,
      source: { kind: "alert", tool: "dependabot", number: numbers[0]!, numbers },
    };
  });
}

/** Dependabot's PR for `name`: "Bump name from…" or a branch like dependabot/npm_and_yarn/name-1.2.3. */
function upgrades(pr: PullRequest, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bbump ${escaped} from\\b`, "i").test(pr.title) || new RegExp(`/${escaped.replace(/\//g, "\\/")}-\\d`).test(pr.headRefName);
}

/**
 * A run in `repo` that already covers this source and still counts (not rejected, failed or
 * archived). Alerts are covered only when every one of them is: a new alert on a package that
 * already has a run is new work.
 */
export function coveringRun(runs: RunSummary[], repo: string, source: SourceInput): RunSummary | undefined {
  const standing = runs.filter(
    (r) => r.repo === repo && !r.archived && r.triage?.state !== "rejected" && r.status !== "failed" && r.status !== "cancelled" && r.source?.kind === source.kind,
  );
  if (source.kind !== "alert") return standing.find((r) => r.source!.number === source.number);
  const numbers = source.numbers?.length ? source.numbers : [source.number];
  const covers = numbers.map((n) => standing.find((r) => r.source!.alert?.tool === source.tool && (r.source!.alert?.numbers ?? [r.source!.number]).includes(n)));
  return covers.every(Boolean) ? covers[0] : undefined;
}

/**
 * What a sweep remembers once it started a run for `source`: one key per issue, PR or alert
 * ("issue#12", "pr#3", "dependabot#5", "code-scanning#7"). Webhooks and schedules use the same
 * keys, so one alert is never swept by both.
 */
export function sourceKeys(source: SourceInput): string[] {
  if (source.kind !== "alert") return [`${source.kind}#${source.number}`];
  const numbers = source.numbers?.length ? source.numbers : [source.number];
  return numbers.map((n) => `${source.tool ?? "alert"}#${n}`);
}

/** The kind of GitHub item each sweep works on; a webhook for anything else is ignored. */
const SWEEP_SOURCE: Record<SweepKind, SourceInput["kind"]> = { issues: "issue", dependabot: "pr", alerts: "alert" };
export const sweepTakes = (kind: SweepKind, source: SourceInput) => SWEEP_SOURCE[kind] === source.kind;

/** The listed item a webhook's source points at (for alerts: the item that includes that alert). */
export function findSweepItem(list: SweepList, source: SourceInput): SweepItem | undefined {
  return list.items.find((i) => {
    const s = i.source;
    if (!s || s.kind !== source.kind) return false;
    if (s.kind !== "alert") return s.number === source.number;
    return s.tool === source.tool && (s.numbers ?? [s.number]).includes(source.number);
  });
}

/**
 * Sweeps used to remember a package's Dependabot alerts as one key ("dependabot:npm/lodash").
 * Where an old key matches a listed package, its alerts open right now become handled by
 * number and the old key is dropped, so it can't keep a later alert on that package from being
 * swept. Returns whether `handled` changed.
 */
export function upgradeLegacyKeys(list: SweepList, handled: Set<string>): boolean {
  let changed = false;
  for (const item of list.items) {
    if (!item.legacyKey || !item.source || !handled.has(item.legacyKey)) continue;
    handled.delete(item.legacyKey);
    for (const key of sourceKeys(item.source)) handled.add(key);
    changed = true;
  }
  return changed;
}

export interface SweepRequestItem {
  key: string;
  task: string;
  source: SourceInput;
}

export interface SweepOutcome {
  started: { key: string; id: string }[];
  skipped: { key: string; why: string }[];
  failed: { key: string; error: string }[];
}

/**
 * Start one run per item, a few at a time; items that already have a run are skipped. A run
 * that can't start (an untrusted issue without Docker, say) is reported and the rest go on.
 */
export async function runSweep(input: {
  repo: string;
  items: SweepRequestItem[];
  runs: RunSummary[];
  start: (item: SweepRequestItem) => Promise<{ id: string }>;
  concurrency?: number;
  /** Fresh GitHub listing, so stale selections do not start unnecessary or closed work. */
  list?: SweepList;
}): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { started: [], skipped: [], failed: [] };
  const root = await repoRoot(input.repo).catch(() => input.repo);
  const queue = [...input.items];
  const seen = new Set<string>();
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      if (input.list) {
        const requested = item;
        const current = input.list.items.find(entry => entry.key === requested.key && entry.source?.kind === requested.source.kind &&
          entry.source.number === requested.source.number && entry.source.tool === requested.source.tool &&
          JSON.stringify(sourceKeys(entry.source).sort()) === JSON.stringify(sourceKeys(requested.source).sort()));
        const why = !current ? "No longer in the open GitHub list. Refresh and try again." : current.manual || !current.task || !current.source ? "Needs manual action on GitHub" : current.blockedReason;
        if (why) { outcome.skipped.push({ key: item.key, why }); continue; }
        // Always reload CI evidence for PR repairs; the client's stale snapshot is not authoritative.
        item = { ...item, source: current!.source! };
      }
      const covering = coveringRun(input.runs, root, item.source);
      if (covering) {
        outcome.skipped.push({ key: item.key, why: `already has run ${covering.id}` });
        continue;
      }
      try {
        const run = await input.start(item);
        outcome.started.push({ key: item.key, id: run.id });
      } catch (err) {
        outcome.failed.push({ key: item.key, error: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, input.concurrency ?? 2) }, worker));
  // Report in the order you picked them, whatever order they finished starting in.
  const order = new Map(input.items.map((item, i) => [item.key, i]));
  for (const list of [outcome.started, outcome.skipped, outcome.failed]) list.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  return outcome;
}

/**
 * The items a recurring sweep starts this time: picked by default, not handled before, at most
 * `max`. An item is handled once every alert (or the issue or PR) it covers is.
 */
export function nextSweepItems(list: SweepList, handled: Set<string>, max: number): SweepRequestItem[] {
  return list.items
    .filter((i) => i.selected && !i.manual && !i.blockedReason && i.source && i.task && !sourceKeys(i.source).every((k) => handled.has(k)))
    .slice(0, max)
    .map((i) => ({ key: i.key, task: i.task!, source: i.source! }));
}
