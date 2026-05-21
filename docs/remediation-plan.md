# Homelab Remediation Plan

Generated: 2026-05-21T11:02:00Z

This plan separates low-risk read-only visibility work from changes that need explicit approval before touching live infrastructure.

## Current critical findings

### Backup coverage

- VMID 110 `dev` is running on `toyota` and has no discovered Proxmox backup job or NAS backup artifact.
- VMID 111 `staging` is running on `toyota` and has no discovered Proxmox backup job or NAS backup artifact.
- VMID 112 `prod` is running on `toyota` and has no discovered Proxmox backup job or NAS backup artifact.
- Backup job `dcee4477-dea2-4354-a67a-66c31c65a46d` still targets VMID 101 on `jester`, but VMID 101 is absent from every current Proxmox node checked.
- The last good VMID 101 backup artifact observed is `vzdump-lxc-101-2026_05_03-02_30_07.tar.zst`.
- Later VMID 101 backup logs from 2026-05-10 and 2026-05-17 failed with `zstd: /*stdout*: Input/output error` while writing to the NAS path.
- VMID 103 `NAS-OMV` is currently running on `shogun` and has recent backup artifacts, but its role must be clarified because the active network NAS is the physical/host `192.168.0.250`.

### Failed units

- `emperor`: `watchdog-mux.service` failed about one month ago. Needs root-cause review before restart/remediation.
- `jester`: `pve-container-debug@101.service` failed because VMID 101 no longer has a config on the node. This appears stale if VMID 101 was intentionally removed.
- `nas`: `quotaon.service` has intermittent failures with `File exists` / `NOPERMISSION` on ext4 quota startup. It sometimes succeeds later, so treat as configuration/noise investigation before changing quota settings.

### NAS risk

- NAS mergerfs pool `/srv/mergerfs/nas` is about 49% used overall.
- One backing disk `/dev/sdb1` is 98% used with only about 170G free.
- NFS export `/export/nas` includes `no_root_squash` for `192.168.0.0/24`, which is functional for Proxmox backup writes but too broad for least privilege.

## Low-risk actions already implemented

- Added `scripts/homelab_health_report.py`, a read-only health reporter that checks:
  - Proxmox guest inventory
  - Proxmox backup-job coverage
  - Latest NAS backup artifacts
  - Stale backup jobs pointing at absent guests
  - Failed systemd units on Proxmox nodes
  - NAS backing-disk fullness
  - NAS `no_root_squash` exposure
- Captured the latest report at `inventory/discovery/homelab-health-report-latest.txt`.
- Captured raw read-only probe evidence at `inventory/discovery/remediation-readonly-probe.json`.
- Created a Hermes daily no-agent cron job `homelab-daily-health-report` (`7b2504ab9f36`) scheduled for 08:00 local time, delivered to `discord:#👟-hermes-👟`.

## Changes requiring explicit approval

These are not applied automatically because they modify live infrastructure or can impact availability/security.

### Proposed backup jobs for VMIDs 110/111/112

Recommended first pass: add weekly Proxmox vzdump jobs to storage `NAS` after VMID 103 completes, retaining three copies.

Candidate schedule:

| VMID | Guest | Node | Proposed schedule | Storage | Mode | Retention |
|---:|---|---|---|---|---|---|
| 110 | dev | toyota | sun 03:30 | NAS | snapshot | keep-last=3 |
| 111 | staging | toyota | sun 04:00 | NAS | snapshot | keep-last=3 |
| 112 | prod | toyota | sun 04:30 | NAS | snapshot | keep-last=3 |

Pre-flight before applying:

1. Confirm that `snapshot` mode works for LXC rootfs on `toyota` local storage.
2. Confirm expected quiescing needs for any databases or persistent app data inside the containers.
3. Confirm NAS write stability after VMID 101 showed backup-time I/O errors.
4. Confirm retention does not push `/dev/sdb1` from 98% to fully exhausted.

### Proposed stale VMID 101 cleanup

If VMID 101 was intentionally retired:

1. Remove or disable the VMID 101 backup job.
2. Clear stale failed unit state on `jester` only after verifying no current CT 101 exists.
3. Preserve historical VMID 101 backup artifacts until Ben explicitly approves deletion/archival.

### Proposed NAS work

Do not delete or move data without approval. Recommended investigation/remediation order:

1. Identify mergerfs branch policy and which top-level directories are consuming `/dev/sdb1`.
2. Plan a safe rebalance from `/dev/sdb1` to the less-full backing disk.
3. Verify open files and active NAS writes before any move.
4. Narrow NFS export clients from `/24` to the Proxmox nodes only, or use a Proxmox backup-specific subnet/ACL, after confirming all consumers.

## Verification commands

Run from `/root/work/home-lab` on the Hermes manager:

```bash
./scripts/homelab_health_report.py
```

The script loads secrets from `/root/.hermes/.env` and prints a sanitized report. It does not print tokens or passwords.
