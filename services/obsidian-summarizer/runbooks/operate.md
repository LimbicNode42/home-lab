# Operate Obsidian Summarizer

Install the Python package, copy the systemd units, then enable the timer:

```bash
systemctl enable --now obsidian-summarizer.timer
systemctl start obsidian-summarizer.service
obsidian-summarizer --once
```

Outputs are personal data and stay on NAS under `/mnt/nas/services/obsidian-livesync/summaries/`; do not commit them.
