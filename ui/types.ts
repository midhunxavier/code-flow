// Types shared with the server: the UI compiles against the same definitions.
export type { AgentEvent, AgentId, AgentSettings, ModelCatalog, ModelInfo } from "../src/adapters/types.js";
export type { Artifact, CheckedReview, FindingCheck, FollowUp, LoopSettings, Note, Proof, ReviewFinding, Run, RunEvent, RunSummary, Step, Pattern, RoleSpec, OptionSpec } from "../src/engine.js";
export type { DiffFile, MergeOutcome } from "../src/ship.js";
export type { MergeMethod, PrMergeInfo } from "../src/github.js";
export type { TreeEntry } from "../src/repo-tree.js";
export type { BranchInfo } from "../src/git.js";
export type { DirListing } from "../src/fs.js";
export type { ProjectDefaults } from "../src/projects.js";
export type { ShellEvent, ShellInfo } from "../src/shell.js";
export type { FileContent } from "../src/repo-tree.js";
export type { DevServer } from "../src/serve.js";
export type { RunContext } from "../src/context.js";
export type { TeamState, TeamMember, TeamTask, TeamMessage, TeamContextManifest } from "../src/teams.js";

import type { AgentId, ModelCatalog } from "../src/adapters/types.js";
import type { Project as SavedProject } from "../src/projects.js";
import type { Pattern } from "../src/engine.js";
import type { BranchInfo } from "../src/git.js";

export type PatternInfo = Omit<Pattern, "run">;
export interface AgentInfo {
  id: AgentId;
  displayName: string;
  binary: string;
  available: boolean;
  blockedReason?: string;
  /** Why it's unavailable when that isn't "not installed": a project's filesystem restriction pauses every provider. */
  unavailableReason?: "filesystem-policy";
}
/** A project as GET /api/projects lists it: `filesystemRestricted` when its policy pauses app-managed work everywhere. */
export type Project = SavedProject & { filesystemRestricted?: boolean };
export type CatalogOrError = ModelCatalog | { error: string };
export interface RepoInfo {
  repo: string;
  worktreeRoot: string;
  current: string | null;
  branches: BranchInfo[];
}
export interface Attachment {
  name: string;
  size: number;
  data: string;
}
export interface ContextItem {
  path: string;
  type: "file" | "dir";
  status?: "M" | "U" | "A";
}
export type { Stats, AgentStats, PatternStats, GroupRun } from "../src/stats.js";
export type { IntegrityIssue } from "../src/integrity.js";
export type { SweepItem, SweepKind, SweepList } from "../src/sweeps.js";
