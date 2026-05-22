# Host IaC/CaC import kickoff - 2026-05-23

The services layer has initial IaC/CaC seeds. The next layer is host/platform desired state.

## What was added

- `infrastructure/hosts/README.md` - safety model and layout.
- `infrastructure/hosts/inventory.yml` - curated host inventory seed from existing sanitized discovery artifacts.
- `infrastructure/hosts/ansible/` - read-only-first Ansible workspace scaffold.
- `infrastructure/hosts/proxmox/desired-state/proxmox-cluster.seed.yml` - candidate Proxmox cluster seed.
- `infrastructure/hosts/nas/README.md` - storage/NAS safety notes.
- `infrastructure/hosts/runbooks/host-import-workflow.md` - import workflow.
- `scripts/discovery/host-readonly-discovery.sh` - bounded read-only SSH discovery helper.

## Evidence sources used

- `inventory/homelab-discovery-summary.json`
- `inventory/ssh-host-summary.json`
- `inventory/discovery/proxmox-discovery.json`

These are evidence snapshots, not fresh live state. Run fresh discovery before remediation or apply.

## Initial host classes

- Proxmox nodes: `emperor`, `shogun`, `jester`, `tori`, `toyota`.
- Critical services LXC: `critical` at `192.168.0.50`.
- App LXCs: `dev`, `staging`, `prod`.
- NAS/storage dependency: `192.168.0.250:/export/nas` as Proxmox shared storage `NAS`.

## Explicit approval required before

- Any Ansible mutation.
- Any Terraform/OpenTofu apply.
- Any Proxmox quorum/qdevice change.
- Any NAS export, mount, permission, or data-retention change.
- Any firewall/router/DNS/reverse-proxy exposure change.
- Any restart of critical services/hosts.
