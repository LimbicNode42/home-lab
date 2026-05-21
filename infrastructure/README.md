# Infrastructure

Future home for homelab infrastructure-as-code and configuration-as-code.

Use this directory for shared platform and host-level desired state, including:

- Proxmox nodes, guests, storage, and backup jobs
- NAS exports, backup targets, and restore-test definitions
- Network/DNS/firewall/reverse-proxy configuration
- Base OS and host configuration
- Shared monitoring and alerting

Current status: placeholder. Existing legacy scripts have been preserved under `archive/legacy-tools/2026-05-21-import/` and should be reviewed before promotion.

## Rules

1. Import and document live state before changing it.
2. Keep secrets in Vaultwarden, not Git.
3. Keep generated state files and local caches out of Git.
4. Use dry-runs/read-only probes before mutation where tools support it.
5. Get explicit approval before applying live infrastructure changes.
