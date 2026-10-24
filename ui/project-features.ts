import { useState } from "preact/hooks";
import { api, usePoll } from "./lib.js";
import type { Board } from "../src/collab/model.js";
import type { Automation } from "./automations.js";
import type { DeferredRunJob } from "../src/deferred-runs.js";
import type { ProjectTeam } from "../src/project-team-model.js";

/** Presentation only. Explicit routes and server authorization remain available independently. */
export function useProjectFeatures(projectId: string) {
  const [features, setFeatures] = useState({ board: false, automation: false, ml: false });
  usePoll(async current => {
    const results = await Promise.allSettled([
      api<Board>("/api/team/board?teamConnection=local"),
      api<Automation[]>("/api/automations"),
      api<DeferredRunJob[]>("/api/deferred-runs"),
      api<{ teams: ProjectTeam[] }>(`/api/project-teams?project=${encodeURIComponent(projectId)}`),
      api<{ configured: boolean }>(`/api/ml/summary?project=${encodeURIComponent(projectId)}`),
    ]);
    if (!current()) return;
    const [board, automations, deferred, missions, ml] = results;
    const hasBoard = board.status === "fulfilled" && (board.value.tasks.some(task => task.projectId === projectId) || board.value.projects.some(project => project.id === projectId && (project.repositories.length > 0 || project.members.some(member => member.userId !== "owner"))));
    const hasAutomation = automations.status === "fulfilled" && automations.value.some(item => item.run.project === projectId) || deferred.status === "fulfilled" && deferred.value.some(item => item.run.project === projectId) || missions.status === "fulfilled" && missions.value.teams.length > 0;
    // Once discovered, tabs stay in place for this project even if a last task is removed.
    setFeatures(previous => ({ board: previous.board || hasBoard, automation: previous.automation || hasAutomation, ml: previous.ml || ml.status === "fulfilled" && ml.value.configured }));
  }, 15_000, [projectId]);
  return features;
}
