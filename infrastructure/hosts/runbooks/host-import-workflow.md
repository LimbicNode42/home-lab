# Host IaC/CaC import workflow

1. Start with existing sanitized inventory artifacts:
   - `inventory/homelab-discovery-summary.json`
   - `inventory/ssh-host-summary.json`
   - `inventory/discovery/proxmox-discovery.json`
2. Run a fresh read-only discovery pass before promoting any fact to desired state.
3. Store raw sanitized evidence under `inventory/discovery/` with a date in the filename.
4. Promote stable facts into `infrastructure/hosts/inventory.yml` and role-specific seeds.
5. Keep secrets out of Git. Store only Vaultwarden folder/item/field references when credentials are needed.
6. Validate syntax and run a targeted secret scan.
7. Commit documentation/inventory separately from any future live changes.
8. For mutating work, propose a bounded plan with rollback and wait for explicit approval.
