# Git push requirement & watchdog

Status: active operational policy.

## Why this exists

Ben flagged that `/root/work/home-lab` (remote `github.com/LimbicNode42/home-lab`)
went ~6 weeks without a push despite always wanting the repo current. Root cause:
agents committed locally but did not push, and nothing reminded them. This repo is
the non-secret source of truth, so a local commit that never reaches GitHub is a
completed-but-lost change and a drift from live state.

Two things now enforce the signal:

1. **Skill guidance** — `homelab-operations` and `kanban-worker` both state
   *commit and push*, not just commit.
2. **A recurring watchdog** — a read-only no-agent cron job that alerts when the
   repo is unpushed or stale.

## The push requirement (mandatory for every task that changes this repo)

- A task that changes files in `/root/work/home-lab` must **commit AND push** its
  branch by closeout, unless review-gating deliberately defers the push.
- A deferred push is a **decision**, not an oversight: record it in the handoff.
- Never `git push --all` / `--mirror`. This repo has local-only worktree branches
  that must never reach origin. Push only the intended branch (and `master`).

## Watchdog

- **Script (committed, canonical):** `scripts/home_lab_git_push_watchdog.sh`
- **Scheduler shim (local):** `/root/.hermes/scripts/home_lab_git_push_watchdog.sh`
  — delegates to the committed script (same pattern as homelab-health and
  asx-screener shims).
- **Mode:** read-only no-agent cron. No `git fetch`, no repo mutation, no
  credentials. It only calls `git ls-remote`, `git rev-parse`, `git rev-list`,
  and `git show`.
- **Delivery:** non-empty stdout goes to the ops channel
  (`discord:#👟-hermes-👟`). Empty stdout = silent success (clean repo, no message).
- **Schedule:** twice daily (`0 8,20 * * *`).

### What alerts it emits

1. **Unpushed commits** — local `master` ahead of the live remote tip
   (`git rev-list <remote_tip>..master` count > 0).
2. **Stale remote tip** — `origin/master` committer date older than ~7 days
   (threshold overridable via `HOME_LAB_STALE_DAYS`).
3. **Unreachable remote** — `ls-remote` fails (push state unverifiable).

### Env overrides (for testing, portable)

| Var | Default | Meaning |
|---|---|---|
| `HOME_LAB_REPO` | `/root/work/home-lab` | repo path |
| `HOME_LAB_BRANCH` | `master` | branch to monitor |
| `HOME_LAB_REMOTE` | `origin` | remote name |
| `HOME_LAB_STALE_DAYS` | `7` | staleness threshold (days) |

### Verify the watchdog manually (read-only)

```bash
# clean repo -> no output, exit 0
bash /root/.hermes/scripts/home_lab_git_push_watchdog.sh

# force the stale branch by pointing at a scratch clone with an old/noisy tip
# (see the task receipts; never mutate the real repo to test the alarm)
```

## Registered scheduler entry

```yaml
name:   home-lab-git-push-watchdog
id:     08049cda94ec
schedule: 0 8,20 * * *
script: home_lab_git_push_watchdog.sh
mode:   no-agent
deliver: discord:#👟-hermes-👟
```

The job lives in the default Hermes home (`/root/.hermes/cron/jobs.json`) alongside
the other homelab jobs (`homelab-daily-health-report`, `asx-screener-*`,
`finnick-*`). It is owned by the single gateway scheduler, not the `gremlin`
profile's empty cron directory.

## Runbook

- **Alert fires (unpushed / stale):** the scheduled agent should push the intended
  branch to origin, then confirm `git ls-remote origin refs/heads/master` matches
  local `master`. The next watchdog tick self-clears when the tip is fresh and
  pushed.
- **Alert fires (unreachable remote):** treat as a transient network/DNS problem;
  verify connectivity and retry (same guidance as the homelab-operations push
  failure note). Do not silently drop it.
- **Do not** extend the watchdog to auto-push. Pushing is a write that can expose
  local-only branches if mis-scoped (`--all`/`--mirror` hazard); the watchdog stays
  read-only and only raises the signal.