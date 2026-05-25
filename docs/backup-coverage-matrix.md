# Backup Coverage Matrix

Generated: 2026-05-21T11:16:00Z

## NAS target

- Proxmox storage `NAS` points to NFS server `192.168.0.250:/export/nas`, mounted at `/mnt/pve/NAS`.
- NAS host responds on SSH, HTTP, SMB, NFS/RPC; hostname discovered over SSH: `nas`.
- NAS OS: Debian GNU/Linux 12 / OpenMediaVault-style exports.
- NAS filesystem overview: mergerfs pool `/srv/mergerfs/nas` is approximately 15T total, 7.1T used, 7.4T free; one underlying 7.3T disk is at 98%, pool still around 49%.
- NFS export `/export/nas` is available to `192.168.0.0/24` with `rw`, `sync`, `no_root_squash`. This is functional but security-sensitive.
- Active NFS connections observed from all five Proxmox nodes: `192.168.0.6`, `.7`, `.8`, `.20`, `.21`.
- SMB shares discovered on 192.168.0.250: `nas`, `cdn`.

## Proxmox vzdump jobs

| VMID | Node | Schedule | Storage | Retention | Mode | Enabled | Job ID | Current assessment |
|---:|---|---|---|---|---|---:|---|---|
| 100 | emperor | sun 02:00 | NAS | keep-last=3 | snapshot | 1 | `0a0b23aa-8390-4b21-b8f5-1220a990ac61` | Current and producing artifacts |
| 101 | jester | sun 02:30 | NAS | keep-last=3 | snapshot | 0 | `dcee4477-dea2-4354-a67a-66c31c65a46d` | Disabled stale job; VMID 101 absent from current cluster resources and all checked node configs |
| 103 | shogun | sun 03:00 | NAS | keep-last=2 | snapshot | 0 | `e0a8bf3c-88d0-4316-9dad-4b61ac30943e` | Disabled 2026-05-25 after self-referential NAS backup deadlocked VM103 and cluster quorum |
| 110 | toyota | sun 03:30 | NAS | keep-last=3 | snapshot | 1 | `e2a54e82-31de-42d0-90ba-e143d6c1153d` | Added; awaiting first successful artifact |
| 111 | toyota | sun 04:00 | NAS | keep-last=3 | snapshot | 1 | `56f23a19-e97b-4ade-ba85-1b6492339570` | Added; awaiting first successful artifact |
| 112 | toyota | sun 04:30 | NAS | keep-last=3 | snapshot | 1 | `d8067c84-8472-40c0-8c46-a58e7a8202f3` | Added; awaiting first successful artifact |

## Guest coverage

| VMID | Guest | Type | Node | Status | Scheduled enabled backup | Latest backup observed | Gap |
|---:|---|---|---|---|---|---|---|
| 100 | critical | lxc | emperor | running | yes | 2026-05-17 02:00 local time, `vzdump-lxc-100-2026_05_17-02_00_01.tar.zst` | none obvious |
| 103 | NAS-OMV | qemu | shogun | running | no | 2026-05-17 03:00 local time, `vzdump-qemu-103-2026_05_17-03_00_05.vma.zst` | scheduled backup disabled because backing up VM103 to NAS storage exported by VM103 caused a deadlock; replace with independent target |
| 110 | dev | lxc | toyota | unknown; toyota offline in 2026-05-25 discovery | yes | none observed | new job added; artifact pending first successful backup; verify after toyota returns |
| 111 | staging | lxc | toyota | unknown; toyota offline in 2026-05-25 discovery | yes | none observed | new job added; artifact pending first successful backup; verify after toyota returns |
| 112 | prod | lxc | toyota | unknown; toyota offline in 2026-05-25 discovery | yes | none observed | new job added; artifact pending first successful backup; verify after toyota returns |

## VMID 101 stale-job details

- VMID 101 does not have an LXC or QEMU config on `emperor`, `shogun`, `jester`, `tori`, or `toyota`.
- `jester` stale failed unit state for `pve-container-debug@101.service` was cleared with `systemctl reset-failed`.
- Last good observed VMID 101 artifact: `vzdump-lxc-101-2026_05_03-02_30_07.tar.zst`.
- 2026-05-10 and 2026-05-17 backup logs for VMID 101 failed while writing/compressing to the NAS dump path with `zstd: /*stdout*: Input/output error`.
- Do not delete VMID 101 backup artifacts without explicit approval.

## NAS capacity details

- `/dev/sdb1` is 98% used and contains `nas/media` at about 6.9T.
- `/dev/sdc1` is about 1% used.
- This imbalance should be fixed with a deliberate rebalance plan before running large manual backup batches.

## Host/service inventory summary

| IP | Hostname | OS | Notable services | Docker containers | Failed units / issues |
|---|---|---|---|---|---|
| 192.168.0.6 | emperor | Debian GNU/Linux 13 (trixie) | 22/ssh, 111/rpcbind, 3128/http |  | `watchdog-mux.service` failed |
| 192.168.0.7 | shogun | Debian GNU/Linux 12 (bookworm) | 22/ssh, 111/rpcbind, 3128/http |  |  |
| 192.168.0.8 | jester | Debian GNU/Linux 12 (bookworm) | 22/ssh, 111/rpcbind, 3128/http | jellyfin | stale VMID 101 failed state cleared |
| 192.168.0.20 | tori | Debian GNU/Linux 13 (trixie) | 22/ssh, 111/rpcbind, 3128/http |  |  |
| 192.168.0.21 | toyota | Debian GNU/Linux 13 (trixie) | 22/ssh, 80/http, 111/rpcbind, 3128/http |  | hosts VMIDs 110/111/112; backup jobs now enabled |
| 192.168.0.50 | critical | Alpine Linux v3.18 | 22/ssh, 80/http, 443/http, 5432/postgresql, 8084/websnp | proxy, cloudflare, vaultwarden, postgres |  |
| 192.168.0.51 | dev | Ubuntu 24.04 LTS | 22/ssh, 5432/postgresql | personal-dashboard-frontend-1, personal-dashboard-db-1 | backed by VMID 110; backup job enabled, artifact pending |
| 192.168.0.52 | staging | Ubuntu 24.04 LTS | 22/ssh |  | backed by VMID 111; backup job enabled, artifact pending |
| 192.168.0.53 | prod | Ubuntu 24.04 LTS | 22/ssh |  | backed by VMID 112; backup job enabled, artifact pending |
| 192.168.0.57 |  |  | 22/tcpwrapped, 23/telnet, 80/http, 443/http |  | SSH connection reset; printer-like embedded device fingerprint |
| 192.168.0.253 |  |  | 22/tcpwrapped, 23/telnet, 80/http, 443/http |  | SSH connection closed; printer-like embedded device fingerprint |
| 192.168.0.250 | nas | Debian GNU/Linux 12 | SSH, HTTP/nginx, SMB, NFS | unknown | intermittent `quotaon.service` failures; one backing disk 98% full; broad `no_root_squash` export |

## Immediate backup/reliability concerns

- New backup jobs for VMIDs 110, 111, and 112 need first-run verification and restore-test evidence; current 2026-05-25 discovery shows `toyota` offline and those guests unknown.
- VMID 103 is running, but its scheduled backup to storage `NAS` is disabled because it is self-referential. Replace with a host-local, PBS, or otherwise independent backup target before marking VM103 covered again.
- NAS NFS export uses `no_root_squash` for the whole /24. That simplifies Proxmox backups but is high trust; consider narrowing clients via OMV-managed config after validating requirements.
- NAS underlying disk `/dev/sdb1` is 98% full while mergerfs pool has free space. Validate mergerfs policy and rebalance if needed.
- Failed unit still observed: `watchdog-mux.service` on emperor.
