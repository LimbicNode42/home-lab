# home-lab

Git-backed, non-secret source of truth for Ben's homelab.

This repository is being reorganized around auditable infrastructure-as-code / configuration-as-code. The current priority is to document and import reality safely before using automation to change live systems.

## Current structure

- `docs/` - runbooks, architecture notes, decisions, migration plans, service catalogues.
- `inventory/` - discovery snapshots and machine-readable evidence from the live homelab.
- `scripts/` - active helper scripts and read-only/safe automation.
- `services/` - active per-service desired-state documentation and future manifests.
- `infrastructure/` - future IaC/CaC for hosts, Proxmox, NAS, networking, and shared platform components.
- `archive/legacy-tools/` - preserved legacy scripts/configs that are not current desired state.

See `docs/architecture/repository-structure.md` for the full layout and promotion workflow. Delivery policy, including dashboard completion visibility requirements for agent-built/user-facing work, lives in `docs/delivery-conventions.md`.

## Secrets

Do not commit secret values.

Vaultwarden is the selected homelab secrets backend for runtime values. For now, homelab items will live in Ben's personal Vaultwarden vault under a folder named `homelab`.

Canonical local Vaultwarden URL:

```text
http://192.168.0.50:8084
```

Commit references like item names and field names, not values. Example:

```text
Vaultwarden folder: homelab
Vaultwarden item: postgres/admin
Field: password
```

Details: `docs/secrets/vaultwarden-secrets-backend.md`.

## Safety policy

- Treat archived scripts as historical reference only.
- Verify live state before remediation.
- Prefer importing/documenting current state before changing it.
- Require explicit approval before destructive actions, data movement/deletion, live IaC applies, firewall/router/DNS exposure changes, or secret rotation.

## Delivery policy

- User-facing or homelab-facing implementation epics must add/update a Home Dashboard, status, docs, or report surface that makes completion visible to Ben, or explicitly justify why no such surface is useful.
- When live dashboard changes are in scope, include deploy and post-deploy verification tasks in the Kanban graph.
- Purely internal refactors do not require dashboard UI changes unless they create an operational signal worth showing.

Details: `docs/delivery-conventions.md`.
