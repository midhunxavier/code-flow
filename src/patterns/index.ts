import type { Pattern } from "../engine.js";
import { fixReviewPattern } from "./fix-review.js";
import { pipelinePattern } from "./pipeline.js";
import { racePattern } from "./race.js";
import { debatePattern } from "./debate.js";
import { supervisorPattern } from "./supervisor.js";
import { tddPattern } from "./tdd.js";
import { loopPattern } from "./loop.js";
import { councilPattern } from "./council.js";
import { soloPattern } from "./solo.js";
import { autoTeamPattern } from "./auto-team.js";
import { taskReviewPattern } from "./task-review.js";
import { taskDraftPattern } from "./task-draft.js";

export const patterns: Pattern[] = [autoTeamPattern, fixReviewPattern, pipelinePattern, loopPattern, racePattern, debatePattern, supervisorPattern, tddPattern, councilPattern, soloPattern];

export function findPattern(id: string): Pattern | undefined {
  if (id === taskReviewPattern.id) return taskReviewPattern;
  if (id === taskDraftPattern.id) return taskDraftPattern;
  return patterns.find((p) => p.id === id);
}
