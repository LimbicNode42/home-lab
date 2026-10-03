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

Scheduled trigger uses the same code path through `systemd/obsidian-summarizer.service` and `systemd/obsidian-summarizer.timer` (daily 21:30 local). The dashboard reads `summaries/meta/last-run.json` for status/freshness and serves summary previews through authenticated `/api/obsidian/summary`.

No secrets are committed. Runtime paths are configured by environment variables only.
