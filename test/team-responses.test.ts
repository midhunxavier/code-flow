import test from "node:test";
import assert from "node:assert/strict";
import { inlineTeamResponses, latestWorkerSteps, teamResponses } from "../ui/team-responses.js";
import type { AgentEvent, Step } from "../ui/types.js";
import { taskResponseEvidence } from "../src/team-responses.js";
import type { Run } from "../src/engine.js";

test("review and the lead receive the public deliverable without private checkpoints", () => {
  const evidence = taskResponseEvidence({ team: { tasks: [{ id: "protocols", title: "Protocol assessment", status: "submitted", handover: "KNX: building automation.", checkpoint: "Private notes" }] }, steps: [
    { id: "old", status: "done", finalText: JSON.stringify({ taskId: "protocols", status: "submitted", findings: [{ title: "Old report", body: "Earlier proposal" }] }) },
    { id: "latest", status: "done", finalText: JSON.stringify({ taskId: "protocols", status: "submitted", checkpoint: "Private reasoning", findings: [{ title: "Recommendations", body: "M-Bus: utility meters." }] }) },
  ] } as unknown as Run);
  assert.equal(evidence[0]!.handover, "KNX: building automation.");
  assert.deepEqual(evidence[0]!.findings, [{ title: "Recommendations", body: "M-Bus: utility meters." }]);
  assert.equal(evidence[0]!.stepId, "latest");
  assert.doesNotMatch(JSON.stringify(evidence), /Private|Old report/);
});

test("proposal artifacts remain accessible when a later handoff omits them", () => {
  const steps = [
    { id: "first", title: "Attempt 1", kind: "agent", finalText: JSON.stringify({ taskId: "readme", findings: [{ title: "Proposed README", body: "# Full proposal\nNo files changed." }] }) },
    { id: "later", title: "Attempt 2", kind: "agent", finalText: JSON.stringify({ taskId: "readme", findings: [{ title: "Evidence", body: "Only supporting evidence here" }] }) },
  ] as Step[];
  const text = "# Revised README\n" + "Complete proposed content. ".repeat(60);
  const transcripts = new Map<string, AgentEvent[]>([["later", [
    { kind: "text", messageId: "answer", text: "# Revised", delta: true },
    { kind: "text", messageId: "answer", text },
  ]]]);
  const responses = teamResponses(steps, transcripts);
  assert.equal(responses.filter(response => response.body === text).length, 1, "stream deltas are replaced by the full message");
  assert.equal(responses.find(response => response.title === "Proposed README")?.source, "Attempt 1");
  assert.equal(responses.find(response => response.title === "Revised README")?.body, text);
  assert.equal(teamResponses([{ id: "plan", title: "Plan", kind: "agent", finalText: '{"findings":[{"title":"not a worker","body":"ignored"}]}' } as Step]).length, 0);
});

test("the chat reply shows the latest complete proposal without earlier attempts, commentary or private fields", () => {
  const steps = [
    { id: "old", title: "Old attempt", finalText: JSON.stringify({ taskId: "readme", findings: [{ title: "Old README", body: "Superseded content" }] }) },
    { id: "new", title: "Revised attempt", finalText: JSON.stringify({ taskId: "readme", checkpoint: "Private reasoning", findings: [{ title: "Evidence", body: "Supporting details" }] }) },
    { id: "review", title: "Review", finalText: JSON.stringify({ verdict: "changes_requested" }) },
  ] as Step[];
  const proposal = "# Proposed README\n\nInstall with npm install, then start the app.\n\n## License\nMIT.";
  const transcripts = new Map<string, AgentEvent[]>([["new", [
    { kind: "text", messageId: "a", delta: true, text: "middle of a truncated stream" },
    { kind: "text", messageId: "a", text: proposal },
    { kind: "text", phase: "commentary", text: "I will inspect another file." },
    { kind: "text", text: steps[1]!.finalText! },
  ]]]);
  assert.deepEqual(latestWorkerSteps(steps).map(step => step.id), ["new"]);
  const responses = inlineTeamResponses(steps, transcripts, "The team submitted a proposal; review needs attention.");
  assert.deepEqual(responses.map(response => response.body), [proposal]);
  assert.deepEqual(inlineTeamResponses(steps, transcripts, `Here is the proposal:\n\n${proposal}\n\nReview is pending.`), [], "a full proposal already in the lead reply appears once");
});

test("structured findings and short answers remain visible when no complete transcript message was saved", () => {
  const steps = [
    { id: "proposal", finalText: JSON.stringify({ taskId: "readme", findings: [{ title: "README proposal", body: "# Start\nRun npm start." }] }) },
    { id: "short", finalText: JSON.stringify({ taskId: "answer", handover: "KNX: building automation.", checkpoint: "Private notes" }) },
  ] as Step[];
  const transcripts = new Map<string, AgentEvent[]>([["proposal", [{ kind: "text", text: "only the end of a delta", delta: true }]]]);
  const responses = inlineTeamResponses(steps, transcripts);
  assert.deepEqual(responses.map(response => response.body), ["# Start\nRun npm start.", "KNX: building automation."]);
  assert.doesNotMatch(JSON.stringify(responses), /Private|delta/);
});
