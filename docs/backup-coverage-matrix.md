# Backup Coverage Matrix

Generated: 2026-05-21T10:49:45.194928+00:00

## NAS target

- Proxmox storage `NAS` points to NFS server `192.168.0.250:/export/nas`, mounted at `/mnt/pve/NAS`.
- NAS host responds on SSH, HTTP, SMB, NFS/RPC; hostname discovered over SSH: `nas`.
- NAS OS: Debian GNU/Linux 12 / OpenMediaVault-style exports.
- NAS filesystem overview: mergerfs pool `/srv/mergerfs/nas` is approximately 15T total, 7.1T used, 7.4T free; one underlying 7.3T disk is at 98%, pool still around 49%.
- NFS export `/export/nas` is available to `192.168.0.0/24` with `rw`, `sync`, `no_root_squash`. This is functional but security-sensitive.
- SMB shares discovered on 192.168.0.250: `nas`, `cdn`.

## Proxmox vzdump jobs

| VMID | Node | Schedule | Storage | Retention | Mode | Enabled |
|---:|---|---|---|---|---|---:|
| 100 | emperor | sun 02:00 | NAS | {'keep-last': '3'} | snapshot | 1 |
| 101 | jester | sun 02:30 | NAS | {'keep-last': '3'} | snapshot | 1 |
| 103 | shogun | sun 03:00 | NAS | {'keep-last': '2'} | snapshot | 1 |

## Guest coverage

| VMID | Guest | Type | Node | Status | Scheduled backup | Latest backup observed | Gap |
|---:|---|---|---|---|---|---|---|
| 100 | critical | lxc | emperor | running | yes | 2026-05-17 02:05 705731678 /srv/mergerfs/nas/nas/dump/vzdump-lxc-100-2026_05_17-02_00_01.tar.zst | none obvious |
| 103 | NAS-OMV | qemu | shogun | stopped | yes | 2026-05-17 04:08 21621221464 /srv/mergerfs/nas/nas/dump/vzdump-qemu-103-2026_05_17-03_00_05.vma.zst | none obvious |
| 110 |  | lxc | toyota | unknown | no |  | no scheduled Proxmox backup; no backup artifact observed in sampled NAS tree; status unknown |
| 111 |  | lxc | toyota | unknown | no |  | no scheduled Proxmox backup; no backup artifact observed in sampled NAS tree; status unknown |
| 112 |  | lxc | toyota | unknown | no |  | no scheduled Proxmox backup; no backup artifact observed in sampled NAS tree; status unknown |

## Host/service inventory summary

| IP | Hostname | OS | Notable services | Docker containers | Failed units / issues |
|---|---|---|---|---|---|
| 192.168.0.6 | emperor | Debian GNU/Linux 13 (trixie) | 22/ssh, 111/rpcbind, 3128/http |  | watchdog-mux.service loaded failed failed Proxmox VE watchdog multiplexer |
| 192.168.0.7 | shogun | Debian GNU/Linux 12 (bookworm) | 22/ssh, 111/rpcbind, 3128/http |  |  |
| 192.168.0.8 | jester | Debian GNU/Linux 12 (bookworm) | 22/ssh, 111/rpcbind, 3128/http | jellyfin | pve-container-debug@101.service loaded failed failed PVE LXC Container: 101 |
| 192.168.0.20 | tori | Debian GNU/Linux 13 (trixie) | 22/ssh, 111/rpcbind, 3128/http |  |  |
| 192.168.0.21 | toyota | Debian GNU/Linux 13 (trixie) | 22/ssh, 80/http, 111/rpcbind, 3128/http |  |  |
| 192.168.0.50 | critical | Alpine Linux v3.18 | 22/ssh, 80/http, 443/http, 5432/postgresql, 8084/websnp | proxy, cloudflare, vaultwarden, postgres |  |
| 192.168.0.51 | dev | Ubuntu 24.04 LTS | 22/ssh, 5432/postgresql | personal-dashboard-frontend-1, personal-dashboard-db-1 |  |
| 192.168.0.52 | staging | Ubuntu 24.04 LTS | 22/ssh |  |  |
| 192.168.0.53 | prod | Ubuntu 24.04 LTS | 22/ssh |  |  |
| 192.168.0.57 |  |  | 22/tcpwrapped, 23/telnet, 80/http, 443/http |  | SSH connection reset; printer-like embedded device fingerprint |
| 192.168.0.253 |  |  | 22/tcpwrapped, 23/telnet, 80/http, 443/http |  | SSH connection closed; printer-like embedded device fingerprint |
| 192.168.0.250 | nas | Debian GNU/Linux 12 | SSH, HTTP/nginx, SMB, NFS | unknown | quotaon.service failed; one backing disk 98% full |

## Immediate backup/reliability concerns

- Guest VMIDs 110, 111, 112 have no Proxmox backup jobs discovered.
- Backup job exists for VMID 101, but VMID 101 did not appear in the current cluster guest summary; investigate stale/hidden/stopped guest state.
- NAS VMID 103 is stopped, yet the active NAS appears to be 192.168.0.250; clarify if VMID 103 is legacy, replacement, or disaster-recovery copy.
- NAS NFS export uses `no_root_squash` for the whole /24. That simplifies Proxmox backups but is high trust; consider narrowing clients or changing export strategy after validating requirements.
- NAS underlying disk `/dev/sdb1` is 98% full while mergerfs pool has free space. Validate mergerfs policy and rebalance if needed.
- Failed units observed: `watchdog-mux.service` on emperor, `pve-container-debug@101.service` on jester, `quotaon.service` on nas.
