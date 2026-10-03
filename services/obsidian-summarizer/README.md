# Obsidian Summarizer

Read-only pipeline for the Obsidian source-of-truth lane. It scans Markdown in `/mnt/nas/obsidian/vault/` and writes derived summaries outside the vault at `/mnt/nas/services/obsidian-livesync/summaries/` so machine output never syncs back into human notes.

Default ingestion:

- `Diary/YYYY-MM-DD.md` -> `summaries/diary/YYYY-MM-DD.md`
- `Goals/*.md` with frontmatter `status` -> `summaries/goals/digest.md`
- `Inbox/`, `.obsidian/`, `Personal/`, and `Work/` are excluded by default.

On-demand trigger:

```bash
obsidian-summarizer --once
```

Scheduled trigger uses the same code path. The generic Linux units are in `systemd/` (`obsidian-summarizer.service` + `.timer`, daily 21:30 local); the live `critical` host is Alpine/OpenRC, so its deployable service/cron pair lives in `openrc/`. On `critical`, the cron line also refreshes the Home Dashboard runtime snapshot cache after a successful summary run, because the dashboard container mounts that host-local cache read-only rather than the NAS output directory directly. The dashboard reads `summaries/meta/last-run.json` for status/freshness and serves summary previews through authenticated `/api/obsidian/summary`.

No secrets are committed. Runtime paths are configured by environment variables only.
