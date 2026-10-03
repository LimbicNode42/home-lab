#!/usr/bin/env bash
#
# home_lab_git_push_watchdog.sh
#
# Read-only watchdog for the home-lab repo. Detects two failure modes Ben flagged:
#   1. Unpushed local commits on master (agents committed but never pushed).
#   2. A stale origin/master tip (nothing pushed to GitHub in >~7 days).
#
# Emits a line to stdout ONLY when a condition needs attention. Empty stdout on a
# clean repo = silent success, which the Hermes no-agent cron harness turns into
# "no message". No repo mutation, no `git fetch`, no credential handling. Safe to
# run as a scheduler job under the default Hermes home.
#
# Env overrides (for testing / portability):
#   HOME_LAB_REPO    repo path (default /root/work/home-lab)
#   HOME_LAB_BRANCH  branch    (default master)
#   HOME_LAB_REMOTE  remote    (default origin)
#   HOME_LAB_STALE_DAYS  staleness threshold in days (default 7)

set -u  # error on unset vars, but do NOT set -e: we handle failures inline.

REPO="${HOME_LAB_REPO:-/root/work/home-lab}"
BRANCH="${HOME_LAB_BRANCH:-master}"
REMOTE="${HOME_LAB_REMOTE:-origin}"
STALE_DAYS="${HOME_LAB_STALE_DAYS:-7}"

cd "$REPO" 2>/dev/null || {
  echo "home-lab git watchdog: cannot enter repo $REPO"
  exit 0
}

# 1) Live remote tip (read-only network ls-remote; no local ref mutation).
remote_tip="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}' | head -n1)"

if [ -z "$remote_tip" ]; then
  echo "home-lab git watchdog: cannot reach $REMOTE (ls-remote failed); push state unverifiable this tick"
  exit 0
fi

local_tip="$(git rev-parse "$BRANCH" 2>/dev/null || echo "")"

# 2) Unpushed local commits: local master ahead of the live remote tip.
ahead="?"
if [ -n "$local_tip" ] && [ "$local_tip" != "$remote_tip" ]; then
  ahead="$(git rev-list --count "$remote_tip".."$BRANCH" 2>/dev/null || echo "?")"
fi

if [ "$ahead" != "?" ] && [ "$ahead" != "0" ]; then
  echo "home-lab git watchdog: $ahead unpushed commit(s) on $BRANCH (local ahead of $REMOTE). Push required."
elif [ "$ahead" = "?" ] && [ "$local_tip" != "$remote_tip" ]; then
  echo "home-lab git watchdog: local $BRANCH differs from $REMOTE tip (${local_tip:0:8} vs ${remote_tip:0:8}); verify push/merge state."
fi

# 3) Staleness: age of the live remote tip's committer date.
#    Prefer the remote tip object if present locally (canonical repo usually has it);
#    otherwise fall back to the local tracking ref origin/<branch>.
tip_ct="$(git show -s --format=%ct "$remote_tip" 2>/dev/null || echo "")"
if [ -z "$tip_ct" ]; then
  tip_ct="$(git show -s --format=%ct "$REMOTE/$BRANCH" 2>/dev/null || echo "")"
fi

if [ -n "$tip_ct" ]; then
  now="$(date +%s)"
  age_days=$(( (now - tip_ct) / 86400 ))
  if [ "$age_days" -ge "$STALE_DAYS" ]; then
    echo "home-lab git watchdog: $REMOTE/$BRANCH tip is $age_days days old (threshold ${STALE_DAYS}d). Repo needs a push."
  fi
fi

# Nothing emitted above == clean. Exit silently.
exit 0