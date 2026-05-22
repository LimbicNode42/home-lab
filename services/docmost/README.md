# Docmost

Status: inactive/unverified candidate desired-state seed

Source evidence:
- archive `utils/docmost/init.sh` plus `/mnt/nas/services/docmost` metadata
- Sanitized discovery artifact: `inventory/discovery/emperor-remaining-services-discovery-2026-05-23.json`

Safety notes:
- Candidate only; not applied by Hermes.
- No live container was restarted, recreated, or modified during import.
- Image tags are preserved from archived scripts where no live container exists; pin to digests before applying.
- Review port conflicts and dependencies before any live mutation.

Secret handling:
- Vaultwarden folder `homelab`, item `docmost/app`, field `app_secret`.
- Vaultwarden folder `homelab`, item `docmost/database`, field `database_url`.

Import notes:
- Not currently running on critical during this discovery pass.
- Depends on Redis at 192.168.0.50:6379, but Redis was not running on critical during discovery.
