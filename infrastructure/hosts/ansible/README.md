# Ansible host workspace

Status: scaffold only. Do not run mutating playbooks until they are reviewed and explicitly approved.

Use this area for host configuration-as-code after read-only discovery has been refreshed. Start with check-mode and facts-gathering playbooks before adding roles that change state.

Recommended first playbooks:

- `gather-host-facts.yml` - read-only host facts, service status, mounts, Docker state.
- `check-baseline.yml` - assert expected packages/settings without changing them.
- Future mutating playbooks should include rollback notes and a small blast radius.

Secrets must come from Vaultwarden or environment variables and must not be committed.
