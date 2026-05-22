# Hosts IaC/CaC

Status: initial host-level IaC/CaC scaffold. These files are candidate desired state and inventory seeds generated from existing sanitized discovery evidence. Refresh against live hosts before any apply.

## Scope

This area covers host/platform configuration rather than application services:

- Proxmox nodes and cluster-level intent.
- LXCs/VMs that provide platform capacity.
- NAS/storage exports and backup surfaces.
- Base OS configuration, packages, users, SSH, mounts, Docker runtime, and monitoring agents.
- Host-level runbooks and drift reports.

## Safety model

Allowed without further approval:

- Read-only discovery over SSH/API.
- Updating inventory, documentation, runbooks, and candidate desired-state files.
- Syntax validation, dry-runs, and secret scans.

Requires explicit approval:

- Ansible runs that mutate hosts.
- Terraform/OpenTofu applies.
- Proxmox quorum/qdevice changes.
- Firewall, router, DNS, or reverse-proxy exposure changes.
- NAS export or permission changes.
- Restarts of critical services or hosts.
- Destructive cleanup, data movement/deletion, or secret rotation.

## Layout

```text
infrastructure/hosts/
├── inventory.yml                 # Curated host inventory seed.
├── ansible/                      # Read-only-first Ansible workspace.
├── proxmox/                      # Proxmox cluster desired-state seeds and drift reports.
├── nas/                          # NAS/export/backup-surface notes.
└── runbooks/                     # Host operations runbooks.
```

## Workflow

1. Refresh read-only discovery into `inventory/discovery/`.
2. Promote sanitized facts into `infrastructure/hosts/inventory.yml` and role-specific desired-state seeds.
3. Document any drift between desired state and live state under `infrastructure/hosts/proxmox/drift-reports/` or host-specific runbooks.
4. Validate and secret-scan changes.
5. Commit non-secret artifacts.
6. Ask for explicit approval before any live mutation.
