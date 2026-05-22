# Repository structure

Status: active working structure as of 2026-05-21.

This repository is the non-secret source of truth for Ben's homelab. It should describe desired state, inventory, runbooks, and safe automation without committing credentials or runtime-only files.

## Top-level layout

```text
.
├── README.md
├── archive/
│   └── legacy-tools/
│       └── 2026-05-21-import/
├── docs/
│   ├── architecture/
│   └── secrets/
├── infrastructure/
├── inventory/
├── scripts/
└── services/
    └── vaultwarden/
```

## Directory purposes

### `archive/`

Historical or currently-unused tools/configs live here instead of being deleted. Material under `archive/legacy-tools/` is preserved for reference, but should not be treated as current desired state without being reviewed, sanitized, and promoted back into an active directory.

Rules:

- Do not run archived scripts blindly.
- Do not assume archived config matches live state.
- Sanitize any archived files that contain sample secret exports or historical credentials.
- If a legacy tool becomes active again, move it out of `archive/` in a dedicated commit with notes about current ownership and validation.

### `docs/`

Human-readable architecture notes, runbooks, migration plans, service catalogues, and operational decisions.

### `infrastructure/`

Host, network, Proxmox, NAS, Terraform/OpenTofu, Ansible, and other infrastructure-as-code / configuration-as-code assets.

Current status: host-level IaC/CaC scaffolding has started under `infrastructure/hosts/`. Prefer documenting/importing existing live state before applying changes.

### `inventory/`

Machine-readable and generated discovery artifacts. These files are evidence snapshots, not necessarily desired state.

### `scripts/`

Current safe automation and helper scripts. Scripts that handle secrets should accept values from the environment or Vaultwarden and should avoid printing secrets to logs.

### `services/`

Current per-service desired-state documentation and future manifests. Each active service should eventually have a directory containing:

```text
services/<service>/
├── README.md
├── env.example
├── compose.yaml              # if applicable
├── ansible/                  # if applicable
├── terraform/ or opentofu/   # if applicable
└── runbooks/                 # if needed
```

## Promotion workflow from archive to active state

1. Inspect archived files and compare them to live state.
2. Remove or replace secrets with Vaultwarden references.
3. Add or update `env.example` and service documentation.
4. Validate syntax and run read-only checks where possible.
5. Commit the promoted active service separately from unrelated archive cleanup.
6. Apply changes to live hosts only after explicit approval when the operation mutates live infrastructure.

## Secret policy

- Vaultwarden is the runtime secret backend.
- Git stores item names, folder names, field names, and placeholders only.
- Ben's personal Vaultwarden vault is the selected vault for now.
- Homelab secrets should be grouped in a Vaultwarden folder named `homelab`.
- Canonical local Vaultwarden URL: `http://192.168.0.50:8084`.
