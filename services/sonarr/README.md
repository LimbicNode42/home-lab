# Sonarr

Status: inactive/unverified candidate desired-state seed

Source evidence:
- archive `utils/arr/init.sh` plus `/mnt/nas/services/sonarr` metadata
- Sanitized discovery artifact: `inventory/discovery/emperor-remaining-services-discovery-2026-05-23.json`

Safety notes:
- Candidate only; not applied by Hermes.
- No live container was restarted, recreated, or modified during import.
- Image tags are preserved from archived scripts where no live container exists; pin to digests before applying.
- Review port conflicts and dependencies before any live mutation.

Secret handling:
None identified in the candidate compose.

Import notes:
- Not currently running on critical during this discovery pass.
- Candidate uses NAS service path; archived script used `/opt/sonarr/config`, which appears inconsistent with NAS metadata.
