/**
 * Starting points for common jobs. A template picks the pattern and drafts the task; ones that
 * need an issue or PR ask you to pick it, and "{number}" / "{title}" are filled in from it.
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
];
