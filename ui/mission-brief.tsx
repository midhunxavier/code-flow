import { hashFor } from "./navigation.js";
import type { RunSummary } from "./types.js";

/**
 * A mission run's task as its owner reads it. The stored task also carries the mission and
 * evidence as JSON for the agents (see ProjectTeams.launch); those become labelled fields here.
 */
export interface MissionBrief {
  summary: string;
  /** The owner's instructions, or the discovered problem being implemented. */
  problem?: string;
  proposal?: string;
  acceptance: string[];
  mission?: { mission?: string; users?: string; baseBranch?: string; mode?: string; paths?: string[]; excludedPaths?: string[]; check?: string; maxFiles?: number; maxLines?: number };
}

const MISSION = "\nOwner mission and constraints:\n";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const parse = (text: string | undefined) => { try { return text === undefined ? undefined : JSON.parse(text) as unknown; } catch { return undefined; } };
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function missionBrief(task: string): MissionBrief | undefined {
  const at = task.indexOf(MISSION);
  if (at < 0) return;
  const rest = task.slice(at + MISSION.length);
  const mission = parse(rest.split("\n", 1)[0]);
  const evidence = parse(/<project_evidence>\n([\s\S]*)\n<\/project_evidence>/.exec(rest)?.[1]);
  const opportunity = object(evidence) && object(evidence.opportunity) ? evidence.opportunity : undefined;
  const problem = typeof opportunity?.problem === "string" ? opportunity.problem : undefined, proposal = typeof opportunity?.proposal === "string" ? opportunity.proposal : undefined;
  return { summary: task.slice(0, at).trim(), problem, proposal: proposal !== problem ? proposal : undefined, acceptance: strings(opportunity?.acceptance), mission: object(mission) ? {
    mission: typeof mission.mission === "string" ? mission.mission : undefined,
    users: typeof mission.users === "string" ? mission.users : undefined,
    baseBranch: typeof mission.baseBranch === "string" ? mission.baseBranch : undefined,
    mode: typeof mission.mode === "string" ? mission.mode : undefined,
    paths: strings(mission.paths), excludedPaths: strings(mission.excludedPaths),
    check: typeof mission.check === "string" ? mission.check : undefined,
    maxFiles: typeof mission.maxFiles === "number" ? mission.maxFiles : undefined,
    maxLines: typeof mission.maxLines === "number" ? mission.maxLines : undefined,
  } : undefined };
}

/** The task bubble of a mission run: what was asked, then the mission's limits on request. */
export function MissionTask({ brief }: { brief: MissionBrief }) {
  const m = brief.mission;
  const rows: [string, string | undefined][] = m ? [
    ["Mission", m.mission], ["Intended users", m.users], ["Base branch", m.baseBranch],
    ["Autonomy", m.mode === "propose" ? "Proposals only" : m.mode === "build-within-scope" ? "Build within scope" : m.mode],
    ["Allowed paths", m.paths?.join(", ")], ["Excluded paths", m.excludedPaths?.join(", ")], ["Required check", m.check || undefined],
    ["Change limits", m.maxFiles !== undefined && m.maxLines !== undefined ? `${m.maxFiles} files · ${m.maxLines} lines` : undefined],
  ] : [];
  return <div class="mission-task">
    <p>{brief.summary}</p>
    {brief.problem ? <p>{brief.problem}</p> : null}
    {brief.proposal ? <p>{brief.proposal}</p> : null}
    {brief.acceptance.length ? <><p class="help">Acceptance criteria</p><ul>{brief.acceptance.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
    {rows.some(([, value]) => value) ? <details><summary>Mission and limits sent to the team</summary><dl>{rows.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details> : null}
  </div>;
}

export const missionHref = (run: Pick<RunSummary, "project">) => run.project ? hashFor({ view: "project", id: run.project, section: "automation", kind: "missions" }) : "#/";

/** In place of the composer on a finished mission run: its result continues only through the mission. */
export function MissionRunNote({ run }: { run: RunSummary }) {
  return <div class="convo">
    <div class="convo-inner">
      <p class="help" role="note">This run belongs to a project mission. Replies, resumes and new runs from here are off; approve the result, request a revision or reject it from the mission. <a href={missionHref(run)}>Open the mission</a></p>
    </div>
  </div>;
}
