import type { Pattern } from "../engine.js";
import { pipelinePattern } from "./pipeline.js";
import { racePattern } from "./race.js";
import { debatePattern } from "./debate.js";
import { supervisorPattern } from "./supervisor.js";
import { tddPattern } from "./tdd.js";
import { loopPattern } from "./loop.js";
import { councilPattern } from "./council.js";
import { soloPattern } from "./solo.js";
import { autoTeamPattern } from "./auto-team.js";

export const patterns: Pattern[] = [autoTeamPattern, pipelinePattern, loopPattern, racePattern, debatePattern, supervisorPattern, tddPattern, councilPattern, soloPattern];

export function findPattern(id: string): Pattern | undefined {
  return patterns.find((p) => p.id === id);
}
