# Services

Active service desired-state documentation and future manifests belong here.

Each service should eventually have a directory like:

```text
services/<service>/
├── README.md
├── env.example
├── compose.yaml
├── ansible/
├── terraform/ or opentofu/
└── runbooks/
```

Do not copy legacy service scripts from `archive/` into this directory without reviewing them against live state and replacing secrets with Vaultwarden references.

## Experimental candidates

- `graphiti/` - Git-only scaffold for a future experimental read-only shared knowledge graph service. Not deployed; mem0 remains the active personal/preference memory provider.
