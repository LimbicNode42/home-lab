# Unified Inbox runbook

## Current state

This backend foundation is local-testable only. It is not deployed and no connector credentials have been rendered.

## Approval gates before live use

Get explicit approval before any of these actions:

1. Create or chown `/var/lib/unified-inbox` on `critical`.
2. Create `/mnt/nas/services/unified-inbox` directories.
3. Render any environment file from Vaultwarden.
4. Start, restart, or recreate the `unified-inbox` container.
5. Create a Postgres database/user or apply migrations.
6. Invite/configure Discord, Telegram, Matrix, Slack, or Android connectors.
7. Edit Traefik, Cloudflare Tunnel, or DNS routing.
8. Expose message bodies/senders in the dashboard before sanitizer/auth review.
9. Enable webhook ingestion — the `POST /api/unified-inbox/webhook/*` route is opt-in and off by default (no `webhookIngest` router means `404`); public exposure additionally requires the public webhook exposure review.
10. Wire any IMAP/RSS connector with real credentials — app passwords/OAuth refs must be rendered from Vaultwarden only.

## Local verification

```sh
cd services/unified-inbox
npm test
git diff --check -- services/unified-inbox
# Run the repo/operator-approved secret scanner over services/unified-inbox.
```

The secret scanner should produce no matches for credential values. Variable names and Vaultwarden field names are expected in `.env.example` and `env.map.example`.

## First deployment shape, after approval

1. Sync `services/unified-inbox/` to the approved app path on `critical`.
2. Create host-local runtime root `/var/lib/unified-inbox`; keep it off NAS/NFS.
3. Create NAS immutable export directories under `/mnt/nas/services/unified-inbox`.
4. Render operator-local secret env, if needed, from Vaultwarden folder `homelab`.
5. Run `scripts/run-critical-docker.sh` from the synced app path.
6. Verify `curl http://127.0.0.1:8766/healthz` or the approved host/IP equivalent.
7. Verify `/api/unified-inbox/status` shows connector health and exclusions without local paths, credential refs, or message bodies.

## Connector onboarding checklist

- Use only sanctioned platform APIs and read-only scopes where available.
- Add connector tests before production connector code.
- Confirm Vaultwarden item and fields in `env.map.example`.
- Confirm rate-limit/backoff behavior reports structured health rather than crash-looping.
- Do not add reply/send/delete/archive/mark-read paths in phase 1.
