import type { SweepKind } from "./sweeps.js";

/**
 * Starting points for common jobs. A template picks the pattern and drafts the task; ones that
 * need an issue or PR ask you to pick it, and "{number}" / "{title}" are filled in from it.
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
    description: "Plan, build and review a fix for a GitHub issue; the PR closes it.",
    pattern: "pipeline",
    needs: "issue",
    task: "Fix issue #{number}: {title}. Add a test that fails without the fix.",
  },
  {
    id: "fix-ci",
    name: "Fix failing CI",
    description: "Hand a PR's failing checks and their logs to an agent; push the fix to the PR.",
    pattern: "pipeline",
    needs: "pr",
    ciLogs: true,
    task: "Make CI pass on pull request #{number} ({title}). The failing checks and their logs are below. Fix the cause; don't disable, skip or weaken tests.",
  },
  {
    id: "review-pr",
    name: "Review a PR as a council",
    description: "Several agents review the PR independently; a chair merges their findings. You choose whether to post it.",
    pattern: "council",
    needs: "pr",
    task: "Review pull request #{number}: {title}. Look for bugs, security problems, missing tests, and anything that doesn't match its description.",
  },
  {
    id: "upgrade-dependency",
    name: "Upgrade a dependency",
    description: "Bump a package, read its changelog for breaking changes, and keep the tests green.",
    pattern: "pipeline",
    task: "Upgrade PACKAGE to its latest version. Read its changelog for breaking changes, update every call site, and keep the tests passing.",
  },
  {
    id: "sweep-issues",
    name: "Fix open issues",
    description: "List the open issues, pick the ones to fix, and start one Plan → Build → Review run each. Results wait in your inbox.",
    pattern: "pipeline",
    sweep: "issues",
    task: "Fix the GitHub issue below. Add a test that fails without the fix.",
  },
  {
    id: "sweep-dependabot",
    name: "Fix Dependabot PRs",
    description: "Every Dependabot PR whose CI fails gets a run that fixes it; approving pushes the fix to the PR. Green ones are left for you to merge.",
    pattern: "pipeline",
    sweep: "dependabot",
    ciLogs: true,
    task: "Make CI pass on the Dependabot pull request below by adapting the code to the new version. Don't pin it back, and don't disable, skip or weaken tests.",
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
