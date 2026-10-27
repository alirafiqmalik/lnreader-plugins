#!/bin/bash
# Fork-only helper: manage request branches that the fork publishes.
# Usage: .github/fork/branch.sh {new|activate|retire|publish|status} [branch]

set -euo pipefail

LIST='.github/fork/active-branches'
FORK_REPO='alirafiqmalik/lnreader-plugins'
UPSTREAM_REPO='lnreader/lnreader-plugins'
NAME_PATTERN='^(feat|fix|perf|refactor|docs|chore)/[a-z0-9][a-z0-9-]*$'

cd "$(git rev-parse --show-toplevel)"

die() {
  echo "error: $*" >&2
  exit 1
}

need_branch() {
  [ -n "${1:-}" ] || die 'missing branch name'
  [[ "$1" =~ $NAME_PATTERN ]] || die "branch must match $NAME_PATTERN"
}

# Print active branch names from master, without comments or blank lines.
active_branches() {
  { git show "origin/master:$LIST" 2>/dev/null || true; } | sed 's/#.*//; s/[[:space:]]//g; /^$/d'
}

# Apply a change to the list on origin/master in a temporary worktree.
# $1: commit message, $2: function that edits the list file in the worktree.
update_list() {
  local message=$1 edit=$2 tmp status=0
  git fetch -q origin master
  tmp=$(mktemp -d)
  git worktree add -q --detach "$tmp" origin/master
  (cd "$tmp" && "$edit" && git add "$LIST" && git commit -q -m "$message" &&
    git push -q origin HEAD:refs/heads/master) || status=$?
  git worktree remove --force "$tmp"
  [ "$status" -eq 0 ] || die 'could not update the list on master'
}

cmd=${1:-}
branch=${2:-}

case "$cmd" in
  new)
    need_branch "$branch"
    git fetch -q upstream master
    git switch -c "$branch" upstream/master
    ;;

  activate)
    need_branch "$branch"
    git push -u origin "$branch"
    git fetch -q origin master
    if active_branches | grep -qxF "$branch"; then
      # Already listed: the list push will not trigger a run, so start one.
      gh workflow run fork-publish.yml --repo "$FORK_REPO" --ref master
      echo "Republishing with $branch."
    else
      add_line() { echo "$branch" >> "$LIST"; }
      update_list "chore(fork): activate $branch" add_line
      echo "Activated $branch. The push to master starts the publish run."
    fi
    ;;

  retire)
    need_branch "$branch"
    git fetch -q origin master
    active_branches | grep -qxF "$branch" || die "$branch is not active"
    remove_line() { sed -i "\#^$branch\$#d" "$LIST"; }
    update_list "chore(fork): retire $branch" remove_line
    echo "Retired $branch. The push to master starts the publish run."
    ;;

  publish)
    gh workflow run fork-publish.yml --repo "$FORK_REPO" --ref master
    echo 'Started the publish run.'
    ;;

  status)
    git fetch -q origin master
    branches=$(active_branches)
    [ -n "$branches" ] || { echo 'No active branches. The app gets fork master.'; exit 0; }
    for b in $branches; do
      pr=$(gh api "repos/$UPSTREAM_REPO/pulls?head=${FORK_REPO%%/*}:$b&state=all" \
        --jq '.[0] | if . == null then "no PR" elif .merged_at then "merged #\(.number)" elif .state == "closed" then "WARNING: closed without merge #\(.number)" else "open #\(.number)" end')
      echo "$b: $pr"
    done
    ;;

  *)
    die 'usage: branch.sh {new|activate|retire|publish|status} [branch]'
    ;;
esac
