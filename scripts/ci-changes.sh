#!/usr/bin/env bash
# Decides whether CI has to run its jobs for this event, and writes
# code=true|false plus reason=... to $GITHUB_OUTPUT (stdout when unset).
#
# The jobs are skipped in two cases:
# - a push to main whose tree is identical to the head of a merged pull request
#   whose "CI result" check passed (the usual merge of an up-to-date branch), and
# - a change that only touches documentation (docs/, site/, README.md, LICENSE).
#   The Documentation workflow builds and tests those.
# Anything unexpected (API errors, a manual run, an unknown event) runs everything.
set -uo pipefail

EVENT="${EVENT:-${GITHUB_EVENT_NAME:-}}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
SHA="${SHA:-${GITHUB_SHA:-}}"
BEFORE="${BEFORE:-}"
DOCS_ONLY='^(docs/|site/|README\.md$|LICENSE$)'

decide() {
  printf 'code=%s\nreason=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  echo "CI jobs run: $1 ($2)" >&2
  exit 0
}

files=""
case "$EVENT" in
  pull_request)
    # actions/checkout checks out the test merge commit; its first parent is the base branch tip.
    # --no-renames lists both sides of a move, so moving code into docs/ still counts as code.
    files=$(git diff --no-renames --name-only HEAD^1 HEAD) || decide true "could not diff the pull request"
    ;;
  push)
    tree=$(git rev-parse "$SHA^{tree}") || decide true "could not read the pushed tree"
    heads=$(gh api "repos/$REPO/commits/$SHA/pulls" --jq '.[] | select(.merged_at != null) | .head.sha') || heads=""
    for head in $heads; do
      head_tree=$(gh api "repos/$REPO/git/commits/$head" --jq .tree.sha) || continue
      [ "$head_tree" = "$tree" ] || continue
      # The merge gate is the "CI result" check from GitHub Actions (app 15368), not the whole run,
      # which also fails when a non-required job such as Browser acceptance flakes.
      passed=$(gh api "repos/$REPO/commits/$head/check-runs?check_name=CI%20result&app_id=15368&filter=latest" --jq '[.check_runs[] | select(.conclusion == "success")] | length') || continue
      [ "${passed:-0}" -gt 0 ] && decide false "identical to pull request head $head, whose CI result passed"
    done
    [[ -z "$BEFORE" || "$BEFORE" =~ ^0+$ ]] && decide true "no previous commit to compare with"
    # A renamed file also reports its old path, so moving code into docs/ still counts as code.
    files=$(gh api "repos/$REPO/compare/$BEFORE...$SHA" --jq '.files[] | .filename, (.previous_filename // empty)') || decide true "could not compare with the previous commit"
    # The compare API lists at most 300 files.
    [ "$(printf '%s\n' "$files" | grep -c .)" -ge 300 ] && decide true "too many changed files to inspect"
    ;;
  *)
    decide true "a $EVENT event always runs everything"
    ;;
esac

code_files=$(printf '%s\n' "$files" | grep -v '^$' | grep -vE "$DOCS_ONLY")
[ -n "$code_files" ] && decide true "$(printf '%s\n' "$code_files" | grep -c .) non-documentation files changed"
[ -n "$files" ] && decide false "only documentation changed"
decide false "no files changed"
