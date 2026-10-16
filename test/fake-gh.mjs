#!/usr/bin/env node
// Stand-in for the GitHub CLI in tests. Issues, PRs, checks and comments live in the JSON file
// named by FAKE_GH_STATE; a PR's head is read from the repo's real `origin` remote, so pushes
// made by code-flow are what the fake "CI" sees. A PR's checks fail while its head commit is
// listed in `failOn` (or always, with "all"). Dependabot and code scanning alerts and leaked
// secrets are listed from `dependabotAlerts`, `codeScanningAlerts` and `secretAlerts`; a name in
// `alertErrors` makes that listing fail the way GitHub does when the feature is off.
// `signedOut: true` makes every command fail the way an expired login does (and `gh auth
// status` say so); `failAll: "<message>"` makes every command but `auth status` fail with it.
// `createFails: "<message>"` makes `gh pr create` make the PR and then fail anyway (a timeout).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write("no GitHub remote configured (FAKE_GH_STATE unset)\n");
  process.exit(1);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
// `gh api … --paginate --jq '.[]'`: one item per line, the way gh prints a jq result.
const printList = (list) => (args.includes("--paginate") && flag("--jq") === ".[]" ? process.stdout.write(list.map((x) => JSON.stringify(x) + "\n").join("")) : print(list));

if (args[0] === "auth" && args[1] === "status") {
  if (state.signedOut) fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  process.stdout.write("github.com\n  ✓ Logged in to github.com account me\n");
  process.exit(0);
}
if (state.signedOut) fail("HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login");
if (state.failAll) fail(state.failAll);
const prOf = (ref) => {
  const pr = state.prs[String(ref).match(/(\d+)\/?$/)?.[1]];
  if (!pr) {
    process.stderr.write(`no pull requests found for ${ref}\n`);
    process.exit(1);
  }
  return pr;
};
const headOf = (pr) => execFileSync("git", ["ls-remote", "origin", `refs/heads/${pr.headRefName}`]).toString().split(/\s/)[0];

const failingHead = (pr) => pr.failOn === "all" || (Array.isArray(pr.failOn) && pr.failOn.length > 0 && pr.failOn.includes(headOf(pr)));
/** What `gh pr list --json statusCheckRollup` reports for a PR. */
const rollup = (pr) =>
  pr.noChecks
    ? []
    : pr.pending
      ? [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }]
      : [
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: failingHead(pr) ? "FAILURE" : "SUCCESS" },
        ];
const ALERTS = { dependabot: "dependabotAlerts", "code-scanning": "codeScanningAlerts", "secret-scanning": "secretAlerts" };
const ALERT_ERRORS = {
  dependabot: "gh: Dependabot alerts are disabled for this repository. (HTTP 403)",
  "code-scanning": "gh: Code scanning is not enabled for this repository. (HTTP 404)",
  "secret-scanning": "gh: Resource not accessible by personal access token (HTTP 403)",
};

const [group, command, target] = args;
const alertPath = group === "api" ? command?.match(/^repos\/\{owner\}\/\{repo\}\/(dependabot|code-scanning|secret-scanning)\/alerts(?:\/(\d+))?(?:\?.*)?$/) : null;
if (alertPath) {
  const [, tool, number] = alertPath;
  if ((state.alertErrors ?? []).includes(tool)) {
    process.stderr.write(`${ALERT_ERRORS[tool]}\n`);
    process.exit(1);
  }
  const alerts = state[ALERTS[tool]] ?? [];
  if (!number) {
    const open = alerts.filter((a) => (a.state ?? "open") === "open");
    // Without --paginate, gh reads only the first page (per_page in the query, 30 by default).
    printList(args.includes("--paginate") ? open : open.slice(0, Number(command.match(/per_page=(\d+)/)?.[1] ?? 30)));
  } else {
    const alert = alerts.find((a) => a.number === Number(number));
    if (!alert) {
      process.stderr.write("gh: Not Found (HTTP 404)\n");
      process.exit(1);
    }
    print(alert);
  }
} else if (group === "api" && command === "user") print({ login: process.env.FAKE_GH_USER ?? "me" });
else if (group === "api" && /^repos\/\{owner\}\/\{repo\}\/issues\/\d+$/.test(command)) {
  // Issues and PRs share GitHub's issues endpoint, which says who wrote them.
  const number = Number(command.split("/").pop());
  const item = state.issues.find((i) => i.number === number) ?? state.prs[number];
  if (!item) {
    process.stderr.write("HTTP 404: Not Found\n");
    process.exit(1);
  }
  print({ number, user: { login: item.author?.login ?? "me" }, author_association: item.authorAssociation ?? "OWNER" });
} else if (group === "issue" && command === "list") print(state.issues.slice(0, Number(flag("--limit") ?? 30)));
else if (group === "issue" && command === "view") {
  const issue = state.issues.find((i) => i.number === Number(target));
  if (!issue) process.exit(1);
  print(issue);
} else if (group === "pr" && command === "list") {
  const app = flag("--app");
  const head = flag("--head");
  const base = flag("--base");
  const open = Object.values(state.prs)
    .filter((p) => p.state === "OPEN" && (!app || new RegExp(app).test(p.author?.login ?? "")) && (!head || p.headRefName === head) && (!base || p.baseRefName === base))
    .slice(0, Number(flag("--limit") ?? 30));
  print(flag("--json")?.includes("statusCheckRollup") ? open.map((p) => ({ ...p, statusCheckRollup: rollup(p) })) : open);
}
else if (group === "pr" && command === "view") {
  const pr = prOf(target);
  print({ ...pr, headRefOid: headOf(pr), reviews: pr.reviews ?? [] });
} else if (group === "pr" && command === "checks") {
  const pr = prOf(target);
  const head = headOf(pr);
  const failing = pr.failOn === "all" || (pr.failOn ?? []).includes(head);
  const checks = pr.pending
    ? [{ name: "test", state: "IN_PROGRESS", bucket: "pending", link: "https://github.com/o/r/actions/runs/77/job/1" }]
    : [
        { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://github.com/o/r/actions/runs/76/job/1" },
        { name: "test", state: failing ? "FAILURE" : "SUCCESS", bucket: failing ? "fail" : "pass", link: "https://github.com/o/r/actions/runs/77/job/1" },
      ];
  print(checks);
  process.exit(failing || pr.pending ? 1 : 0);
} else if (group === "run" && command === "view" && args.includes("--log-failed")) {
  process.stdout.write(`test\tRun npm test\tAssertionError: expected 1 to equal 2 (run ${target})\n`);
} else if (group === "pr" && command === "comment") {
  const pr = prOf(target);
  pr.comments.push({ id: `c${Date.now()}`, author: { login: "me" }, authorAssociation: "OWNER", body: readFileSync(0, "utf8"), createdAt: new Date().toISOString() });
  save();
} else if (group === "pr" && command === "create") {
  // Like GitHub: one open PR per head branch.
  const existing = Object.values(state.prs).find((p) => p.state === "OPEN" && p.headRefName === flag("--head"));
  if (existing) fail(`a pull request for branch "${flag("--head")}" into branch "${existing.baseRefName}" already exists:\n${existing.url}`);
  const body = flag("--body") ?? (flag("--body-file") === "-" ? readFileSync(0, "utf8") : "");
  if (body.length > 65_536) fail("GraphQL: Body is too long (maximum is 65536 characters) (createPullRequest)");
  const number = Math.max(0, ...Object.keys(state.prs).map(Number)) + 1;
  const url = `https://github.com/o/r/pull/${number}`;
  state.prs[number] = { number, title: flag("--title"), body, url, headRefName: flag("--head"), baseRefName: flag("--base"), author: { login: "me" }, isDraft: false, isCrossRepository: false, state: "OPEN", comments: [] };
  const failAfter = state.createFails;
  delete state.createFails;
  save();
  if (failAfter) fail(failAfter);
  process.stdout.write(`${url}\n`);
} else {
  process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
  process.exit(2);
}
