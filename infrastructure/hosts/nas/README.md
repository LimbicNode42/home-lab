# NAS/storage host configuration

Status: scaffold only.

This area will hold sanitized NAS/export/backup-surface desired state and drift notes. Current known storage evidence says Proxmox uses shared NFS storage named `NAS` from `192.168.0.250:/export/nas`, mounted by Proxmox nodes at `/mnt/pve/NAS`, and service data paths under `/mnt/nas/services/` are used by the `critical` LXC.

Safety boundary: do not change NAS exports, permissions, filesystems, retention, or backup targets without explicit approval. Bulk-copying NAS service directories into Git is not allowed because application directories commonly contain keys, tokens, databases, sessions, and encryption material.
