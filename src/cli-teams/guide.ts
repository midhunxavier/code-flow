import { readFile } from "node:fs/promises";

// Hosts cap MCP server instructions (Claude Code keeps 4,096 characters by default),
// so startup carries only CORE.md. The full workflow contract stays in SKILL.md and
// is served on demand through codeflow_get_guide.
export const GUIDE_SECTIONS = ["prepare", "candidate", "start", "follow", "deliver", "workspace", "find", "connection", "handoff"] as const;
export type GuideSection = typeof GUIDE_SECTIONS[number] | "all";
const HEADINGS: Record<typeof GUIDE_SECTIONS[number], string> = {
  prepare: "Prepare", candidate: "Candidate contract", start: "Preview and start", follow: "Participate, monitor, and steer", deliver: "Deliver",
  workspace: "Shared visual workspace", find: "Find work and report evidence", connection: "Connection, progress and follow-ups", handoff: "Bring completed changes into the checkout",
};
const text = (file: string) => readFile(new URL(`../../integrations/cli-teams/${file}`, import.meta.url), "utf8");
const body = async () => (await text("SKILL.md")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

export async function startupInstructions(projectRoot: string, nativeForm: boolean) {
  return [
    `This connection is bound exclusively to repository ${JSON.stringify(projectRoot)}. Show this repository when proposing work; never assume it is the current chat's working directory. Tools cannot switch repositories.`,
    nativeForm ? "Call codeflow_start_run to show native approval in this session." : "This host has no form elicitation; use the Code Flow workspace or terminal confirmation returned by codeflow_propose_run.",
    "",
    (await text("CORE.md")).trim(),
  ].join("\n");
}

export async function guideText(section: GuideSection) {
  const all = await body();
  if (section === "all") return all;
  const heading = HEADINGS[section as typeof GUIDE_SECTIONS[number]];
  if (!heading) throw new Error(`Unknown guide section: ${section}`);
  const start = all.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`Guide section is missing: ${heading}`);
  const next = all.indexOf("\n## ", start + 1);
  return all.slice(start + 1, next < 0 ? undefined : next).trim();
}
