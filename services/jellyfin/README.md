# Jellyfin

Status: inactive/unverified candidate desired-state seed

Source evidence:
- archive `jellyfin.sh` plus `/mnt/nas/services/jellyfin` metadata
- Sanitized discovery artifact: `inventory/discovery/emperor-remaining-services-discovery-2026-05-23.json`

Safety notes:
- Candidate only; not applied by Hermes.
- No live container was restarted, recreated, or modified during import.
- Image tags are preserved from archived scripts where no live container exists; pin to digests before applying.
- Review port conflicts and dependencies before any live mutation.

Secret handling:
None identified in the candidate compose.

Import notes:
- Archive includes separate LXC config for a `jellyfin` host at 192.168.0.249, not necessarily critical LXC.
- Privileged + host networking are high-risk and require explicit approval before apply.
