# Backup Coverage Matrix

Generated: 2026-05-21T11:02:00Z

## NAS target

- Proxmox storage `NAS` points to NFS server `192.168.0.250:/export/nas`, mounted at `/mnt/pve/NAS`.
- NAS host responds on SSH, HTTP, SMB, NFS/RPC; hostname discovered over SSH: `nas`.
- NAS OS: Debian GNU/Linux 12 / OpenMediaVault-style exports.
- NAS filesystem overview: mergerfs pool `/srv/mergerfs/nas` is approximately 15T total, 7.1T used, 7.4T free; one underlying 7.3T disk is at 98%, pool still around 49%.
- NFS export `/export/nas` is available to `192.168.0.0/24` with `rw`, `sync`, `no_root_squash`. This is functional but security-sensitive.
- SMB shares discovered on 192.168.0.250: `nas`, `cdn`.

## Proxmox vzdump jobs

| VMID | Node | Schedule | Storage | Retention | Mode | Enabled | Current assessment |
|---:|---|---|---|---|---|---:|---|
| 100 | emperor | sun 02:00 | NAS | keep-last=3 | snapshot | 1 | Current and producing artifacts |
| 101 | jester | sun 02:30 | NAS | keep-last=3 | snapshot | 1 | Stale: VMID 101 absent from current cluster resources and all checked node configs |
| 103 | shogun | sun 03:00 | NAS | keep-last=2 | snapshot | 1 | Current and producing artifacts |

## Guest coverage

| VMID | Guest | Type | Node | Status | Scheduled backup | Latest backup observed | Gap |
|---:|---|---|---|---|---|---|---|
| 100 | critical | lxc | emperor | running | yes | 2026-05-17 02:00 local time, `vzdump-lxc-100-2026_05_17-02_00_01.tar.zst` | none obvious |
| 103 | NAS-OMV | qemu | shogun | running | yes | 2026-05-17 03:00 local time, `vzdump-qemu-103-2026_05_17-03_00_05.vma.zst` | role clarification needed: active NAS is 192.168.0.250 |
| 110 | dev | lxc | toyota | running | no | none observed | no scheduled Proxmox backup; no backup artifact observed |
| 111 | staging | lxc | toyota | running | no | none observed | no scheduled Proxmox backup; no backup artifact observed |
| 112 | prod | lxc | toyota | running | no | none observed | no scheduled Proxmox backup; no backup artifact observed |

## VMID 101 stale-job details

- VMID 101 does not have an LXC or QEMU config on `emperor`, `shogun`, `jester`, `tori`, or `toyota`.
- `jester` still has a failed `pve-container-debug@101.service` unit from a failed attempt to start/debug the retired/missing container.
- Last good observed VMID 101 artifact: `vzdump-lxc-101-2026_05_03-02_30_07.tar.zst`.
- 2026-05-10 and 2026-05-17 backup logs for VMID 101 failed while writing/compressing to the NAS dump path with `zstd: /*stdout*: Input/output error`.
- Do not delete VMID 101 backup artifacts without explicit approval.

## Proposed backup-job additions requiring approval

| VMID | Guest | Node | Proposed schedule | Storage | Mode | Retention |
|---:|---|---|---|---|---|---|
| 110 | dev | toyota | sun 03:30 | NAS | snapshot | keep-last=3 |
| 111 | staging | toyota | sun 04:00 | NAS | snapshot | keep-last=3 |
| 112 | prod | toyota | sun 04:30 | NAS | snapshot | keep-last=3 |

Pre-flight blockers before applying:

- NAS backing disk `/dev/sdb1` is already 98% full.
- VMID 101 showed recent backup-time I/O errors on the NAS path.
- Database/application consistency inside `dev`, `staging`, and `prod` needs review.

## Host/service inventory summary

| IP | Hostname | OS | Notable services | Docker containers | Failed units / issues |
|---|---|---|---|---|---|
| 192.168.0.6 | emperor | Debian GNU/Linux 13 (trixie) | 22/ssh, 111/rpcbind, 3128/http |  | `watchdog-mux.service` failed |
| 192.168.0.7 | shogun | Debian GNU/Linux 12 (bookworm) | 22/ssh, 111/rpcbind, 3128/http |  |  |
| 192.168.0.8 | jester | Debian GNU/Linux 12 (bookworm) | 22/ssh, 111/rpcbind, 3128/http | jellyfin | `pve-container-debug@101.service` failed; likely stale VMID 101 state |
| 192.168.0.20 | tori | Debian GNU/Linux 13 (trixie) | 22/ssh, 111/rpcbind, 3128/http |  |  |
| 192.168.0.21 | toyota | Debian GNU/Linux 13 (trixie) | 22/ssh, 80/http, 111/rpcbind, 3128/http |  | hosts VMIDs 110/111/112 without backup jobs |
| 192.168.0.50 | critical | Alpine Linux v3.18 | 22/ssh, 80/http, 443/http, 5432/postgresql, 8084/websnp | proxy, cloudflare, vaultwarden, postgres |  |
| 192.168.0.51 | dev | Ubuntu 24.04 LTS | 22/ssh, 5432/postgresql | personal-dashboard-frontend-1, personal-dashboard-db-1 | backed by VMID 110, no Proxmox backup job |
| 192.168.0.52 | staging | Ubuntu 24.04 LTS | 22/ssh |  | backed by VMID 111, no Proxmox backup job |
| 192.168.0.53 | prod | Ubuntu 24.04 LTS | 22/ssh |  | backed by VMID 112, no Proxmox backup job |
| 192.168.0.57 |  |  | 22/tcpwrapped, 23/telnet, 80/http, 443/http |  | SSH connection reset; printer-like embedded device fingerprint |
| 192.168.0.253 |  |  | 22/tcpwrapped, 23/telnet, 80/http, 443/http |  | SSH connection closed; printer-like embedded device fingerprint |
| 192.168.0.250 | nas | Debian GNU/Linux 12 | SSH, HTTP/nginx, SMB, NFS | unknown | intermittent `quotaon.service` failures; one backing disk 98% full; broad `no_root_squash` export |

## Immediate backup/reliability concerns

- Guest VMIDs 110, 111, 112 have no Proxmox backup jobs discovered.
- Backup job exists for VMID 101, but VMID 101 is absent from the current cluster and all checked node configs.
- VMID 103 is running and backed up, but the active NAS appears to be 192.168.0.250; clarify if VMID 103 is legacy, replacement, or disaster-recovery copy.
- NAS NFS export uses `no_root_squash` for the whole /24. That simplifies Proxmox backups but is high trust; consider narrowing clients or changing export strategy after validating requirements.
- NAS underlying disk `/dev/sdb1` is 98% full while mergerfs pool has free space. Validate mergerfs policy and rebalance if needed.
- Failed units observed: `watchdog-mux.service` on emperor, `pve-container-debug@101.service` on jester, intermittent `quotaon.service` failures on nas.
