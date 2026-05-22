# Private Docker Registry

Status: inactive/unverified candidate desired-state seed

Source evidence:
- archive `utils/init.sh` plus `/mnt/nas/services/repo` metadata
- Sanitized discovery artifact: `inventory/discovery/emperor-remaining-services-discovery-2026-05-23.json`

Safety notes:
- Candidate only; not applied by Hermes.
- No live container was restarted, recreated, or modified during import.
- Image tags are preserved from archived scripts where no live container exists; pin to digests before applying.
- Review port conflicts and dependencies before any live mutation.

Secret handling:
- Vaultwarden folder `homelab`, item `repo/registry`, field `http_secret`.
- Registry htpasswd file should be generated from Vaultwarden credentials outside Git and mounted from `/mnt/nas/services/repo/config/htpasswd`.

Import notes:
- Not currently running on critical during this discovery pass.
- Archived script contained a literal htpasswd password command; candidate replaces this with Vaultwarden-backed guidance only.
