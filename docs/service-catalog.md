# Service Catalog

Generated: 2026-05-21T11:02:00Z

This is a living catalog generated from discovery artifacts. It should become the source of truth for ownership, criticality, backup/restore approach, and monitoring.

| Service / host | Address | Platform | Role | Backup state | Monitoring state | Notes |
|---|---|---|---|---|---|---|
| Proxmox cluster `Nippon` | 192.168.0.6, .7, .8, .20, .21 | Proxmox VE | Virtualization cluster | Node-level guest jobs partially configured | Read-only health report added | Nodes: emperor, shogun, jester, tori, toyota |
| `critical` | 192.168.0.50 / VMID 100 | Alpine LXC on emperor | Reverse proxy / Cloudflare / Vaultwarden / Postgres | Scheduled weekly to NAS | Covered by health report backup checks | Docker containers: traefik/proxy, cloudflared, vaultwarden, postgres |
| `NAS-OMV` | VMID 103 on shogun | QEMU | NAS-related VM | Scheduled weekly to NAS | Covered by health report backup checks | Running as of latest probe; clarify relationship to physical NAS 192.168.0.250 |
| `dev` | 192.168.0.51 / VMID 110 | Ubuntu LXC on toyota | Development workloads | No Proxmox backup job discovered | Covered by missing-backup alert | Docker: personal-dashboard frontend and db |
| `staging` | 192.168.0.52 / VMID 111 | Ubuntu LXC on toyota | Staging workloads | No Proxmox backup job discovered | Covered by missing-backup alert | No Docker containers observed in initial inventory |
| `prod` | 192.168.0.53 / VMID 112 | Ubuntu LXC on toyota | Production workloads | No Proxmox backup job discovered | Covered by missing-backup alert | No Docker containers observed in initial inventory |
| `jellyfin` | likely formerly VMID 101 / jester Docker host | LXC/Docker history | Media service | Backup job stale; latest good artifact 2026-05-03 | Stale job alert | Current CT config absent; jester has Docker `jellyfin` container in inventory |
| Physical/active NAS | 192.168.0.250 | Debian 12 / OMV-style | SMB/NFS storage and Proxmox backup target | Stores Proxmox `NAS` dump artifacts | NAS disk/export checks added | `/dev/sdb1` 98%; `/export/nas` uses broad `no_root_squash` |
| Embedded/printer-like device | 192.168.0.57 | Unknown | Unknown | Unknown | Not monitored | TCP 22/23/80/443; SSH reset |
| Embedded/printer-like device | 192.168.0.253 | Unknown | Unknown | Unknown | Not monitored | TCP 22/23/80/443; SSH closed |

## Next catalog improvements

- Add owner, criticality, RPO, RTO, restore command, and dashboard URL columns once confirmed.
- Add app-level backup state for databases inside containers; Proxmox backups alone may not be application-consistent.
- Add restore-test evidence and date for each service.
