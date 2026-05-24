# NAS VM backup lock incident - 2026-05-24

Status: mitigated/recovered on 2026-05-25. NAS VM is running, NAS NFS storage is active again, and the unsafe VM103-to-NAS backup job is disabled. Temporary quorum recovery is still in effect because node `tori` retains a runtime vote count of 2 until the remaining cluster/qdevice state can be normalized safely.

## Symptom

NAS VM `103` (`NAS-OMV`) on Proxmox node `shogun` is stopped and reports `lock: backup` / `config locked (backup)`. NAS-backed Proxmox storage is offline.

## Read-only evidence

Collected from `tori` and `shogun` on 2026-05-24.

### Cluster/quorum

`pvecm status` reports the `Nippon` cluster is not quorate:

```text
Nodes:            4
Quorate:          No
Expected votes:   8
Total votes:      4
Quorum:           5 Activity blocked
Qdevice (votes 4)
```

Reachable nodes observed in the partition:

- `emperor` / `192.168.0.6`
- `jester` / `192.168.0.8`
- `shogun` / `192.168.0.7`
- `tori` / `192.168.0.20`

`toyota` was not present in this partition. Qdevice votes are expected but not contributing. This is the known qdevice/NAS dependency failure mode: qdevice/qnetd depends on infrastructure that is unavailable when the NAS VM is down.

### NAS VM state

On `shogun`:

```text
qm status 103 --verbose
status: stopped
qmpstatus: stopped
lock: backup
name: NAS-OMV
```

`qm config 103` also contains:

```text
lock: backup
```

No running `qemu-system` process for VM 103 was observed.

### Backup task state

`/var/log/pve/tasks/active` on `shogun` contains an active backup task:

```text
UPID:shogun:0033F5E7:110A8027:6A11DD1B:vzdump:103:root@pam: 0
```

The process is still present:

```text
PID      STAT WCHAN                  CMD
3405287  Ds   folio_wait_bit_common  task UPID:shogun:0033F5E7:110A8027:6A11DD1B:vzdump:103:root@pam:
3405316  Dl   folio_wait_bit_common  zstd --threads=1
```

Kernel stack for the backup task shows it blocked flushing/closing an NFS file:

```text
nfs_wb_all
nfs_file_flush
filp_flush
__arm64_sys_close
```

### Backup log

`/var/log/vzdump/qemu-103.log` shows the 03:00 scheduled backup started while the VM was running and attempted to write the archive to NAS storage:

```text
2026-05-24 03:00:11 INFO: Starting Backup of VM 103 (qemu)
2026-05-24 03:00:11 INFO: status = running
2026-05-24 03:00:11 INFO: VM Name: NAS-OMV
2026-05-24 03:00:14 INFO: backup mode: snapshot
2026-05-24 03:00:14 INFO: creating vzdump archive '/mnt/pve/NAS/dump/vzdump-qemu-103-2026_05_24-03_00_11.vma.zst'
```

The log has no completion line.

### Storage state

`pvesm status` reports:

```text
storage 'NAS' is not online
NAS nfs inactive
```

The NFS mount on `shogun` is configured as a hard NFS mount:

```text
192.168.0.250:/export/nas on /mnt/pve/NAS type nfs (...,hard,...)
```

## Root-cause hypothesis

The scheduled `vzdump` job for VM 103 tried to back up the NAS VM to storage provided by that same NAS VM. During/after the backup, the NAS VM became stopped and the NAS NFS target became unavailable. The backup process is now blocked in uninterruptible sleep on hard-NFS writeback/close, leaving the VM config locked as `backup`.

The cluster is simultaneously non-quorate because the qdevice votes are unavailable and expected votes remain inflated. This prevents ordinary cluster-safe config changes and repeats the known qdevice-on-NAS dependency deadlock pattern.

## Safety implications

Do not blindly delete backup artifacts or edit NAS exports. Do not treat the active backup process as cleanly stale without acknowledging it is still present and blocked in kernel NFS writeback.

Recovery requires explicit approval because it may involve cluster quorum manipulation, forcibly clearing a VM backup lock while a backup process still exists, or rebooting a Proxmox node.

## Candidate recovery path requiring explicit approval

Preferred bounded approach, if approved:

1. Confirm the same four-node partition still exists and there is no competing partition.
2. Temporarily restore quorum on the largest real partition, using the previously documented safe qdevice recovery approach rather than `expected 1`.
3. On `shogun`, clear only VM 103's backup config lock if needed to break the dependency cycle.
4. Start only NAS VM 103.
5. Verify NFS/qnetd services at `192.168.0.250` and `pvesm status`.
6. Let the stuck `vzdump`/`zstd` processes unblock and finish/fail; then verify `/var/log/pve/tasks/active` and `qm config 103` no longer show the stale backup lock.
7. Restore qdevice client state and reset any temporary vote changes.
8. Disable or redesign the VM 103 backup job so it does not back up the NAS VM to storage exported by itself.
9. Follow up by moving qdevice/qnetd off cluster-dependent NAS infrastructure.

Fallback if the blocked NFS writeback does not unwind after NAS returns: consider a controlled `shogun` reboot after verifying hosted workload impact and preserving local disk state.

## Follow-up prevention

- Disable or replace the `vzdump` job for VM 103 that targets storage `NAS`.
- Back up the NAS VM to storage that is independent of the NAS VM itself, or use a host-local/PBS target and replicate externally.
- Move qdevice/qnetd away from the NAS VM / cluster-dependent storage.

## Recovery actions applied - 2026-05-25

Approved bounded recovery was performed from `tori`.

1. Stopped `corosync-qdevice` clients on the reachable Proxmox partition:
   - `emperor` / `192.168.0.6`
   - `shogun` / `192.168.0.7`
   - `jester` / `192.168.0.8`
2. Temporarily restored quorum by assigning node `tori` (`nodeid 4`) two votes with `corosync-quorumtool -v 2 -n 4`.
3. Cleared the VM 103 backup lock on `shogun` with `qm unlock 103`.
4. Started VM 103 (`NAS-OMV`) with `qm start 103`.
5. Verified NAS network and NFS readiness:
   - `192.168.0.250` ping responsive.
   - TCP ports `111` and `2049` open.
   - `showmount -e 192.168.0.250` exports `/export` and `/export/nas` to `192.168.0.0/24`.
   - `pvesm status` reports storage `NAS` active.
6. Disabled the unsafe scheduled backup job `e0a8bf3c-88d0-4316-9dad-4b61ac30943e` by setting `enabled: 0`.
7. Restarted `corosync-qdevice` on `emperor`, `shogun`, and `jester`.

Verification after recovery:

```text
VM 103: running
VM 103 lock: absent
NAS storage: active
Unsafe backup job enabled: 0
Stuck vzdump/zstd processes: no longer present
Task UPID:shogun:0033F5E7:110A8027:6A11DD1B:vzdump:103:root@pam: status: stopped, exitstatus: job errors
```

Important residual state:

```text
Quorate: Yes
Expected votes: 9
Total votes: 5
Node 4 / tori votes: 2
Qdevice row: votes 4 configured, but currently contributing 0 votes
```

Attempting to restore `tori` to one vote immediately with `corosync-quorumtool -v 1 -n 4` failed with `CS_ERR_INVALID_PARAM`. Because the reachable partition currently has only four ordinary votes and qdevice is not contributing, removing the extra runtime vote would likely make the partition non-quorate again. Leave the temporary vote in place until the missing node/qdevice state is repaired or a safer quorum normalization procedure is planned.

## Remaining follow-up

- Normalize quorum/qdevice state and return `tori` to one vote without dropping cluster quorum.
- Move qnetd/qdevice dependency off the NAS VM and any cluster-dependent storage.
- Replace the disabled VM 103 backup job with a backup target independent of VM 103 itself.
