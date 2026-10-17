/**
 * JSON Schemas for structured hand-offs. All three CLIs enforce them (claude --json-schema,
 * codex --output-schema, agy --json-schema). Every property is required and no extra keys are
 * allowed, which is what strict structured-output modes expect; use "" or [] for "nothing".
 */

const obj = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string" };
const strings = { type: "array", items: str };
/** A test that shows an issue: a test file to add (path, contents), the plain command that runs it, or both ("" for none). */
const repro = obj({ path: str, contents: str, command: str });

export const REVIEW_SCHEMA = obj({
  verdict: { type: "string", enum: ["approve", "changes_requested"] },
  issues: {
    type: "array",
    items: obj({ severity: { type: "string", enum: ["high", "medium", "low"] }, file: str, problem: str, fix: str, repro }),
  },
});

export const JUDGE_SCHEMA = obj({ winner: str, ranking: strings, reasons: str });

export const SUBTASKS_SCHEMA = obj({
  /** What every part must agree on (interfaces, names, data shapes); each worker gets it. */
  contracts: str,
  subtasks: { type: "array", items: obj({ id: str, title: str, instructions: str, agent: str }) },
});

export const TEST_SPEC_SCHEMA = obj({ test_command: str, test_files: strings });

export const TEST_VERDICT_SCHEMA = obj({ verdict: { type: "string", enum: ["pass", "fail"] }, failures: strings });

export const COUNCIL_SCHEMA = obj({
  verdict: { type: "string", enum: ["approve", "changes_requested"] },
  summary: str,
  findings: {
    type: "array",
    items: obj({ severity: { type: "string", enum: ["high", "medium", "low"] }, file: str, problem: str, fix: str, raised_by: strings, repro }),
  },
});
