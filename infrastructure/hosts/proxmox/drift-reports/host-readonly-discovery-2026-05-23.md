# Host read-only discovery report - 2026-05-23

Source artifact: `inventory/discovery/host-readonly-discovery-2026-05-23.json`

Status: read-only SSH probe. No live changes were made. Some hosts were unreachable and should not be assumed decommissioned until verified from Proxmox/router state.

## Summary

| Host | IP | Probe status | Observed OS | Failed units | Docker containers seen | NAS NFS mounted |
|---|---:|---|---|---|---:|---|
| `emperor` | `192.168.0.6` | reachable | Debian GNU/Linux 13 (trixie) | watchdog-mux.service | 0 | yes |
| `shogun` | `192.168.0.7` | reachable | Debian GNU/Linux 12 (bookworm) | none observed | 0 | yes |
| `jester` | `192.168.0.8` | reachable | Debian GNU/Linux 12 (bookworm) | mnt-pve-NAS.mount, pve-firewall.service, pvestatd.service | 1 | no |
| `tori` | `192.168.0.20` | reachable | Debian GNU/Linux 13 (trixie) | none observed | 0 | yes |
| `toyota` | `192.168.0.21` | ssh: connect to host 192.168.0.21 port 22: No route to host | unreachable | none observed | 0 | no |
| `critical` | `192.168.0.50` | reachable | Alpine Linux v3.18 | none observed | 4 | yes |
| `dev` | `192.168.0.51` | ssh: connect to host 192.168.0.51 port 22: Connection timed out | unreachable | none observed | 0 | no |
| `staging` | `192.168.0.52` | ssh: connect to host 192.168.0.52 port 22: Connection timed out | unreachable | none observed | 0 | no |
| `prod` | `192.168.0.53` | ssh: connect to host 192.168.0.53 port 22: Connection timed out | unreachable | none observed | 0 | no |

## Notable findings

- `emperor` has failed systemd unit `watchdog-mux.service` in this pass.
- `jester` has failed systemd unit `mnt-pve-NAS.mount` in this pass.
- `jester` has failed systemd unit `pve-firewall.service` in this pass.
- `jester` has failed systemd unit `pvestatd.service` in this pass.
- `toyota` (`192.168.0.21`) was not reachable by SSH in this pass: `ssh: connect to host 192.168.0.21 port 22: No route to host`.
- `dev` (`192.168.0.51`) was not reachable by SSH in this pass: `ssh: connect to host 192.168.0.51 port 22: Connection timed out`.
- `staging` (`192.168.0.52`) was not reachable by SSH in this pass: `ssh: connect to host 192.168.0.52 port 22: Connection timed out`.
- `prod` (`192.168.0.53`) was not reachable by SSH in this pass: `ssh: connect to host 192.168.0.53 port 22: Connection timed out`.
- NAS NFS dependency `192.168.0.250:/export/nas` is mounted on reachable Proxmox hosts; preserve qdevice/NAS deadlock remediation as a separate approved change.

## Follow-up candidates

- Refresh Proxmox API/CLI discovery to reconcile `toyota`, `dev`, `staging`, and `prod` reachability with cluster guest/node state.
- Create non-mutating Ansible check playbooks for baseline drift checks.
- Keep qdevice/qnetd relocation as a separately-approved Proxmox quorum remediation, not part of inventory import.
- Do not apply host configuration changes until a bounded plan and rollback path are approved.
