import { useState } from "preact/hooks";
import { api, usePoll } from "./lib.js";
import type { Board } from "../src/collab/model.js";
import type { Automation } from "./automations.js";
import { readDeferredRuns } from "./deferred-queue.js";

/** Presentation only. Explicit routes and server authorization remain available independently. */
export function useProjectFeatures(projectId: string) {
  const [features, setFeatures] = useState({ board: false, automation: false });
  usePoll(async current => {
    const results = await Promise.allSettled([
      api<Board>("/api/team/board?teamConnection=local"),
      api<Automation[]>("/api/automations"),
      readDeferredRuns({ background: true }),
    ]);
    if (!current()) return;
    const [board, automations, deferred] = results;
    const hasBoard = board.status === "fulfilled" && (board.value.tasks.some(task => task.projectId === projectId) || board.value.projects.some(project => project.id === projectId && (project.repositories.length > 0 || project.members.some(member => member.userId !== "owner"))));
    const hasAutomation = automations.status === "fulfilled" && automations.value.some(item => item.run.project === projectId) || deferred.status === "fulfilled" && deferred.value.some(item => item.run.project === projectId);
    setFeatures(previous => ({ board: previous.board || hasBoard, automation: previous.automation || hasAutomation }));
  }, 15_000, [projectId]);
  return features;
}
