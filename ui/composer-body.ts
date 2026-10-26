import type { PatternInfo } from "./types.js";
import type { VerificationProfile } from "../src/verification.js";
import { intentDraft } from "./experience.js";
import { journeyDraft } from "./journeys.js";
import { selectedTeamTemplate } from "./team-template-state.js";
import { rerunDraft, sourceForRerun } from "./rerun-draft.js";
import { contextBudget } from "./context-budget.js";
import { taskWithCriteria } from "./composer-tools.js";
import { toolApprovalState } from "./composer-permissions.js";
import { readProjectDefaults } from "./project-defaults.js";
import { store } from "./lib.js";
import { composerRunOptions, repo, projectsStatus, composerProject, task, acceptanceCriteria, optionsFor, baseRef, source, branchPrefix, externalSource, contextPaths, attachments, agentSettings, CHECKPOINTS, planApprovalFor, trust, roleModels, checkCmd, setupCmd, limits, repoConfig, rolesFor } from "./state.js";

/** Build the current saved draft independently of which screen happens to be mounted. */
export function composerRunBody(p: PatternInfo, profile?: VerificationProfile | null): Record<string, any> {
  const options = composerRunOptions.value, restored = rerunDraft.value;
  const { taskTeam, remoteWorker, permissionRequirements = [], antigravityExecution } = options;
  const nativeAntigravity = antigravityExecution === "native";
  const container = options.container ?? readProjectDefaults(repo.value).container;
  const { enabled: containerEnabled, image: containerImage, authVolume: containerVolume } = container;
  const verificationProfile = profile === undefined ? options.verificationProfile : profile;
  const single = p.id === "solo", roles = rolesFor(p), soloAgent = roles.agent?.[0];
  const soloSettings = soloAgent && soloAgent !== "auto" ? { ...agentSettings.value[soloAgent], ...roleModels.value[p.id]?.agent?.[soloAgent] } : {};
  const savedApprovals = store.get("interactiveApprovals");
  const approvals = toolApprovalState({ choice: options.toolApprovals ?? (savedApprovals === null ? undefined : savedApprovals === "1"), trust: externalSource.value ? "safe" : trust.value, p, roles, remote: !!remoteWorker, container: containerEnabled, external: !!externalSource.value });
  return ({
    intent: journeyDraft.value?.repo === repo.value ? "bug" : intentDraft.value,
    journeyId: journeyDraft.value?.repo === repo.value ? journeyDraft.value.id : undefined,
    repo: repo.value,
    project: projectsStatus.value.available ? composerProject.value || undefined : undefined,
    projectSelection: projectsStatus.value.available ? "explicit" : undefined,
    parentRunId: restored?.id,
    task: taskWithCriteria(task.value, acceptanceCriteria.value),
    pattern: p.id,
    taskTeam: single && taskTeam?.enabled && !remoteWorker && !containerEnabled ? taskTeam : undefined,
    checkpointOnFinish: restored?.checkpointOnFinish,
    templateRef: selectedTeamTemplate.value ? { id: selectedTeamTemplate.value.template.id, version: selectedTeamTemplate.value.template.version, inputs: selectedTeamTemplate.value.inputs } : undefined,
    roles,
    options: optionsFor(p),
    baseRef: baseRef.value,
    source: sourceForRerun(source.value, restored?.source),
    branchPrefix: branchPrefix.value.trim(),
    externalSourceId: externalSource.value?.id,
    context: {
      paths: [...contextPaths.value.values()].map((c) => ({ path: c.path })),
      attachments: attachments.value.map((a) => ({ name: a.name, data: a.data })),
    },
    agentSettings: single && soloAgent && soloAgent !== "auto" ? { ...agentSettings.value, [soloAgent]: soloSettings } : agentSettings.value,
    approvals: { plan: !!CHECKPOINTS[p.id] && planApprovalFor(p.id), tools: approvals.tools },
    trust: trust.value,
    permissionRequirements,
    antigravityExecution: nativeAntigravity ? "native" : "isolated",
    roleSettings: roleModels.value[p.id] ?? {},
    loop: {
      ...restored?.loop,
      check: checkCmd.value.trim(),
      setup: setupCmd.value.trim(),
      maxMinutes: limits.value.maxMinutes,
      maxSteps: limits.value.maxSteps,
      maxTokens: limits.value.maxTokens,
      maxCostUsd: limits.value.maxCostUsd,
      contextBudget: contextBudget.value,
      verification: verificationProfile ?? undefined,
      remoteWorker,
      agentContainer: containerEnabled && !remoteWorker ? { ...restored?.loop.agentContainer, image: containerImage.trim(), authVolume: containerVolume.trim() || undefined, network: restored?.loop.agentContainer?.network ?? true } : undefined,
      copy: remoteWorker ? [] : restored ? restored.loop.copy ?? [] : repoConfig.value?.config.copy,
    },
  });
}
