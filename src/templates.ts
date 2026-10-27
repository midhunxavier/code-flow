import { ciRepairTask, issueRepairTask } from "./repair-strategy.js";
import type { SweepKind } from "./sweeps.js";

/**
 * Starting points for common jobs. A template picks the pattern and drafts the task; ones that
 * need an issue or PR ask you to pick it, and "{number}" is filled in from it. The title isn't
 * put in the task: whoever opened the issue wrote it, and agents read the task as instructions.
 * They get the title with the issue's text instead, fenced as information when it's untrusted.
 * A sweep template lists many items instead and starts one run per item you pick.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  pattern: string;
  task: string;
  needs?: "issue" | "pr";
  /** Include the PR's failing CI checks and their logs in what agents are given. */
  ciLogs?: boolean;
  /** A sweep: list this kind of work and start one run per picked item (`task` is for webhooks). */
  sweep?: SweepKind;
}

export const templates: Template[] = [
  {
    id: "fix-issue",
    name: "Fix an issue",
    description: "Diagnose and fix an issue, then run checks and independent review. You approve the pull request.",
    pattern: "fix-review",
    needs: "issue",
    task: issueRepairTask("issue #{number}"),
  },
  {
    id: "fix-ci",
    name: "Fix failing CI",
    description: "Hand a PR's failing checks and their logs to an agent; push the fix to the PR.",
    pattern: "fix-review",
    needs: "pr",
    ciLogs: true,
    task: ciRepairTask("pull request #{number}"),
  },
  {
    id: "review-pr",
    name: "Review a PR as a council",
    description: "Several agents review the PR independently; a chair merges their findings. You choose whether to post it.",
    pattern: "council",
    needs: "pr",
    task: "Review pull request #{number}. Look for bugs, security problems, missing tests, and anything that doesn't match its description.",
  },
  {
    id: "upgrade-dependency",
    name: "Upgrade a dependency",
    description: "Bump a package, read its changelog for breaking changes, and keep the tests green.",
    pattern: "pipeline",
    task: "Upgrade {{package}} to its latest version. Read its changelog for breaking changes, update every call site, and keep the tests passing.",
  },
  {
    id: "sweep-issues",
    name: "Fix open issues",
    description: "Pick issues to fix. Each gets a focused repair, checks and independent review. Results wait in your inbox.",
    pattern: "fix-review",
    sweep: "issues",
    task: issueRepairTask("the GitHub issue below"),
  },
  {
    id: "sweep-dependabot",
    name: "Fix Dependabot PRs",
    description: "Fix failing dependency updates with a focused repair, checks and independent review. Passing PRs need no repair.",
    pattern: "fix-review",
    sweep: "dependabot",
    ciLogs: true,
    task: ciRepairTask("the Dependabot pull request below", true),
  },
  {
    id: "sweep-alerts",
    name: "Fix security alerts",
    description: "Dependabot alerts (one run per package) and code scanning alerts (one per alert). Leaked secrets are listed for you to rotate; agents never get them.",
    pattern: "pipeline",
    sweep: "alerts",
    task: "Fix the security alert below. Fix the cause rather than suppressing the alert, and keep the tests passing.",
  },
];
