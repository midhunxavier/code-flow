import type { RunSummary } from "./engine.js";
import { repoRoot } from "./git.js";
import {
  alertsError,
  listCodeScanningAlerts,
  listDependabotAlerts,
  listDependabotPrs,
  listIssues,
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
  /** Stable id for the item ("issue#12", "pr#34", "dependabot:npm/lodash", "code-scanning#7", "secret#3"). */
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
  /** A run that already covers this item. */
  existingRun?: string;
  /** What the item's run gets: its task and where it starts from. */
  task?: string;
  source?: SourceInput;
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
    }
  }
  return list;
}

async function issueItems(repo: string): Promise<SweepList> {
  const issues = await listIssues(repo, 100);
  return {
    kind: "issues",
    notices: [],
    items: issues.map((i) => {
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
        task: `Fix issue #${i.number}: ${i.title}. Add a test that fails without the fix.`,
        source: { kind: "issue", number: i.number },
      };
    }),
  };
}

const CI_NOTE = { pass: "CI passes — ready for you to merge", pending: "CI is still running", none: "No CI checks reported" } as const;

async function dependabotItems(repo: string): Promise<SweepList> {
  const prs = await listDependabotPrs(repo);
  return {
    kind: "dependabot",
    notices: [],
    items: prs.map((pr) => ({
      key: `pr#${pr.number}`,
      ref: `#${pr.number}`,
      title: pr.title,
      detail: `${pr.ci === "fail" ? "CI failing" : pr.ci === "pass" ? "CI green" : pr.ci === "pending" ? "CI running" : "no CI"} · ${pr.headRefName}`,
      url: pr.url,
      // Only a failing PR needs an agent; code-flow never merges the green ones for you.
      selected: pr.ci === "fail",
      note: pr.ci === "fail" ? undefined : CI_NOTE[pr.ci],
      task:
        `Make CI pass on Dependabot's pull request #${pr.number} (${pr.title}). The failing checks and their logs are below. ` +
        "Fix the cause by adapting the code to the new version; don't pin it back, and don't disable, skip or weaken tests.",
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
  const openPrs = prs.status === "fulfilled" ? prs.value : [];

  if (dependabot.status === "fulfilled") items.push(...dependabotAlertItems(dependabot.value, openPrs));
  else notices.push(alertsError("Dependabot alerts", dependabot.reason));

  if (codeScanning.status === "fulfilled") {
    for (const a of codeScanning.value) {
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
        task: `Fix code scanning alert #${a.number}: ${title}${at ? ` in ${at}` : ""}. Fix the cause rather than suppressing the alert, and add a test where it makes sense.`,
        source: { kind: "alert", tool: "code-scanning", number: a.number },
      });
    }
  } else notices.push(alertsError("Code scanning alerts", codeScanning.reason));

  if (secrets.status === "fulfilled") {
    for (const a of secrets.value) {
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

/** Dependabot alerts, one item per package: upgrading it fixes them together. */
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
      key: `dependabot:${key}`,
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

/** A run in `repo` that already covers this source and still counts (not rejected, failed or archived). */
export function coveringRun(runs: RunSummary[], repo: string, source: SourceInput): RunSummary | undefined {
  const numbers = source.numbers?.length ? source.numbers : [source.number];
  return runs.find((r) => {
    if (r.repo !== repo || r.archived || r.triage?.state === "rejected" || r.status === "failed" || r.status === "cancelled") return false;
    const s = r.source;
    if (!s || s.kind !== source.kind) return false;
    if (s.kind === "alert") return s.alert?.tool === source.tool && (s.alert?.numbers ?? [s.number]).some((n) => numbers.includes(n));
    return s.number === source.number;
  });
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
}): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { started: [], skipped: [], failed: [] };
  const root = await repoRoot(input.repo).catch(() => input.repo);
  const queue = [...input.items];
  const seen = new Set<string>();
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
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

/** The items a recurring sweep starts this time: picked by default, not handled before, at most `max`. */
export function nextSweepItems(list: SweepList, handled: Set<string>, max: number): SweepRequestItem[] {
  return list.items
    .filter((i) => i.selected && !i.manual && i.source && i.task && !handled.has(i.key))
    .slice(0, max)
    .map((i) => ({ key: i.key, task: i.task!, source: i.source! }));
}
