# Service Catalog

Generated: 2026-05-21T11:02:00Z

This is a living catalog generated from discovery artifacts. It should become the source of truth for ownership, criticality, backup/restore approach, and monitoring.

| Service / host | Address | Platform | Role | Backup state | Monitoring state | Notes |
|---|---|---|---|---|---|---|
| Proxmox cluster `Nippon` | 192.168.0.6, .7, .8, .20, .21 | Proxmox VE | Virtualization cluster | Node-level guest jobs partially configured | Read-only health report added | Nodes: emperor, shogun, jester, tori, toyota |
| `critical` | 192.168.0.50 / VMID 100 | Alpine LXC on emperor | Reverse proxy / Cloudflare / Vaultwarden / Postgres | Scheduled weekly to NAS | Covered by health report backup checks | Docker containers: traefik/proxy, cloudflared, vaultwarden, postgres |
| `NAS-OMV` | VMID 103 on shogun | QEMU | NAS-related VM | Scheduled NAS-target backup disabled; needs independent target | Covered by health report backup checks | Running after 2026-05-25 recovery; self-referential backup to `NAS` deadlocked VM103/quorum |
| `dev` | 192.168.0.51 / VMID 110 | Ubuntu LXC on toyota | Development workloads | Weekly Proxmox job enabled; first artifact pending; current status unknown while toyota offline | Covered by backup-artifact alert | Historical Docker: personal-dashboard frontend and db; candidate seed in `services/personal-dashboard/` |
| `staging` | 192.168.0.52 / VMID 111 | Ubuntu LXC on toyota | Staging workloads | Weekly Proxmox job enabled; first artifact pending; current status unknown while toyota offline | Covered by backup-artifact alert | No Docker containers observed in initial inventory |
| `prod` | 192.168.0.53 / VMID 112 | Ubuntu LXC on toyota | Production workloads | Weekly Proxmox job enabled; first artifact pending; current status unknown while toyota offline | Covered by backup-artifact alert | No Docker containers observed in initial inventory |
| `jellyfin` | jester Docker host / legacy VMID 101 | LXC/Docker history | Media service | Stale VMID 101 backup job disabled; latest good artifact 2026-05-03 | Stale failed unit cleared | Active host Docker `jellyfin` observed on jester; legacy CT 101 stopped pending reconciliation |
| Physical/active NAS | 192.168.0.250 | Debian 12 / OMV-style | SMB/NFS storage and Proxmox backup target | Stores Proxmox `NAS` dump artifacts | NAS disk/export checks added | `/dev/sdb1` 98%; `/export/nas` uses broad `no_root_squash`; `nas/media` drives branch imbalance |
| Embedded/printer-like device | 192.168.0.57 | Unknown | Unknown | Unknown | Not monitored | TCP 22/23/80/443; SSH reset |
| Embedded/printer-like device | 192.168.0.253 | Unknown | Unknown | Unknown | Not monitored | TCP 22/23/80/443; SSH closed |

## Next catalog improvements

- Add owner, criticality, RPO, RTO, restore command, and dashboard URL columns once confirmed.
- Add app-level backup state for databases inside containers; Proxmox backups alone may not be application-consistent.
- Add restore-test evidence and date for each service.
