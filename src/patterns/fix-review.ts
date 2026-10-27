import type { Pattern } from "../engine.js";
import { pipelinePattern, runPipeline } from "./pipeline.js";

/** Focused repairs keep the pipeline's checks, proof and independent review, without a planner handoff. */
export const fixReviewPattern: Pattern = {
  id: "fix-review",
  name: "Fix & review",
  summary: "One agent fixes the issue, checks run, and a fresh reviewer verifies the result.",
  description: "For GitHub issues and failing dependency updates. Diagnose and fix in one turn, then keep the full verification and review loop. Choose a planning workflow for broader work.",
  roles: [
    { id: "builder", label: "Builder", description: "Diagnoses the failure and implements a focused fix", default: ["codex"] },
    { id: "reviewer", label: "Reviewer", description: "Independently checks the result with fresh context", default: ["claude"], independentOf: ["builder"] },
  ],
  options: pipelinePattern.options,
  run: (ctx) => runPipeline(ctx, false),
};
