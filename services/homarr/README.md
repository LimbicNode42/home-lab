# Homarr

Status: inactive/unverified candidate desired-state seed

Source evidence:
- archive `utils/homarr/init.sh` plus `/mnt/nas/services/homarr` metadata
- Sanitized discovery artifact: `inventory/discovery/emperor-remaining-services-discovery-2026-05-23.json`

Safety notes:
- Candidate only; not applied by Hermes.
- No live container was restarted, recreated, or modified during import.
- Image tags are preserved from archived scripts where no live container exists; pin to digests before applying.
- Review port conflicts and dependencies before any live mutation.

Secret handling:
- Vaultwarden folder `homelab`, item `homarr/app`, field `secret_encryption_key`.

Import notes:
- Not currently running on critical during this discovery pass.
- Docker socket mount gives high privilege; review before apply.
- Archived script exposed 6379; candidate omits that host binding because Redis is a dependency/service, not Homarr UI.
