# Legacy tools archive

This directory preserves scripts/configs imported from the previous `home-lab` layout.

The files here are not considered current desired state. They are retained so useful pieces can be reviewed and promoted into the new structure without losing historical context.

## Contents

- `alpine/` - legacy Alpine/init helper.
- `critical/` - legacy scripts/config for services that previously lived on the `critical` host.
- `dumptruck/` - legacy host init helper.
- `utils/` - legacy utility service scripts.
- `jellyfin.sh` - legacy Jellyfin helper.
- `TODO` - historical notes.

## Handling rules

1. Do not run these scripts directly against live hosts without reviewing them.
2. Compare against live state before promotion.
3. Replace any secret values with Vaultwarden references before promoting.
4. Prefer moving one service at a time into `services/<service>/` with docs and validation.
5. Keep archive cleanup separate from live remediation commits.

## Secret note

The historical `utils/sample-secrets-raw.json` export was replaced with `utils/sample-secrets-redacted.json` because raw secret export-shaped files do not belong in Git, even as examples.
