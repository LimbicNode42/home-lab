# Mem0 — Hermes/agent integration notes

How the default and worker Hermes profiles point at the self-hosted mem0 instance on tori.

## Current active profile state

As of the 2026-09-20 rollout, all active Hermes profiles that were in scope use the self-hosted mem0 provider.

| Profile | HERMES_HOME | Active provider | mem0 user id | Verification |
|---|---|---|---|---|
| `default` | `/root/.hermes` | `mem0` | `ben-default` | Verified with `hermes memory status` and fresh add/search/delete smoke; marker deleted. |
| `domovoi` | `/root/.hermes/profiles/domovoi` | `mem0` | `ben-domovoi` | Verified with `hermes memory status` and fresh add/search/delete smoke; marker deleted. |
| `kobold` | `/root/.hermes/profiles/kobold` | `mem0` | `ben-kobold` | Verified with `hermes memory status` and fresh add/search/delete smoke; marker deleted. |
| `gremlin` | `/root/.hermes/profiles/gremlin` | `mem0` | `ben-gremlin` | Verified with `hermes memory status` and fresh add/search/delete smoke; marker deleted. |
| `sentinel` | `/root/.hermes/profiles/sentinel` | `mem0` | `ben-sentinel` | Verified with `hermes memory status` and fresh add/search/delete smoke; marker deleted. |
| `scribe` | `/root/.hermes/profiles/scribe` | `mem0` | `ben-scribe` | Verified with `hermes memory status` and fresh add/search/delete smoke; marker deleted. |

Rollout notes:

- No gateway restart/bounce was performed during the worker-profile rollout.
- Smoke tests used a fresh profile-scoped Hermes subprocess with `mem0_search`, `mem0_add`, `mem0_update`, and `mem0_delete` available.
- Temporary smoke-test memories were removed after verification.
- The installed Hermes CLI version rejected `hermes memory setup mem0 --mode ...` flags during rollout, so the verified setup path used the mem0 post-setup provider configuration through fresh profile-scoped Hermes venv subprocesses. Re-check `hermes memory setup mem0 --help` before using the flag form on a future Hermes version.

## Service endpoint reality

- mem0 API is live at `http://127.0.0.1:8888` on tori. It is intentionally localhost-only.
- `GET /docs` returns the FastAPI/OpenAPI documentation page.
- `GET /openapi.json` returns the OpenAPI schema and is the safest unauthenticated HTTP liveness probe for the dashboard status card.
- `GET /health` is absent and returns `404`. Do not build monitoring that expects `/health` until the service actually implements it. Mystery endpoints are not a health strategy.
- Authenticated programmatic access uses `X-API-Key` with the per-user key from Vaultwarden folder `Homelab`, item `mem0/server`, field `api_key`. Do not use the admin key for normal Hermes access.

## Required env vars / config keys

The Hermes mem0 plugin reads:

| Setting | Value |
|---|---|
| `MEM0_HOST` (or `host` in `$HERMES_HOME/mem0.json`) | `http://127.0.0.1:8888` |
| `MEM0_API_KEY` (or `api_key` in `mem0.json`) | per-user API key from Vaultwarden `Homelab/mem0/server` field `api_key` |

The plugin authenticates with `X-API-Key` and uses the server's `/search` and `/memories` routes.

## Smoke-test procedure

Use a fresh profile-scoped session/subprocess after changing a profile so cached tools do not lie to you.

1. Confirm the profile advertises mem0:

```bash
HERMES_HOME=<profile-home> hermes memory status
```

Expected: provider is `mem0` and status is available.

2. In a fresh Hermes session for that profile, verify the mem0 toolset is present: `mem0_search`, `mem0_add`, `mem0_update`, and `mem0_delete`.

3. Add a unique temporary marker, search for it, then delete the exact returned memory id. Example marker shape:

```text
hermes-mem0-smoke-<task-id>-<timestamp>
```

4. Re-run the search for the marker and confirm it is gone. Do not leave smoke-test memories behind.

## Rollback commands

Run only the profile rollback(s) needed. These commands switch Hermes back to Honcho and remove the profile-scoped mem0 client file/env references. They do not delete server-side memories.

### default

```bash
HERMES_HOME=/root/.hermes hermes config set memory.provider honcho
rm -f /root/.hermes/mem0.json
python3 - <<'PY'
from pathlib import Path
env = Path('/root/.hermes/.env')
if env.exists():
    lines = env.read_text().splitlines()
    keep = [line for line in lines if not line.startswith(("MEM0_HOST=", "MEM0_API_KEY="))]
    env.write_text("\n".join(keep) + ("\n" if keep else ""))
PY
```

### domovoi

```bash
HERMES_HOME=/root/.hermes/profiles/domovoi hermes config set memory.provider honcho
rm -f /root/.hermes/profiles/domovoi/mem0.json
python3 - <<'PY'
from pathlib import Path
env = Path('/root/.hermes/profiles/domovoi/.env')
if env.exists():
    lines = env.read_text().splitlines()
    keep = [line for line in lines if not line.startswith(("MEM0_HOST=", "MEM0_API_KEY="))]
    env.write_text("\n".join(keep) + ("\n" if keep else ""))
PY
```

### kobold

```bash
HERMES_HOME=/root/.hermes/profiles/kobold hermes config set memory.provider honcho
rm -f /root/.hermes/profiles/kobold/mem0.json
python3 - <<'PY'
from pathlib import Path
env = Path('/root/.hermes/profiles/kobold/.env')
if env.exists():
    lines = env.read_text().splitlines()
    keep = [line for line in lines if not line.startswith(("MEM0_HOST=", "MEM0_API_KEY="))]
    env.write_text("\n".join(keep) + ("\n" if keep else ""))
PY
```

### gremlin

```bash
HERMES_HOME=/root/.hermes/profiles/gremlin hermes config set memory.provider honcho
rm -f /root/.hermes/profiles/gremlin/mem0.json
python3 - <<'PY'
from pathlib import Path
env = Path('/root/.hermes/profiles/gremlin/.env')
if env.exists():
    lines = env.read_text().splitlines()
    keep = [line for line in lines if not line.startswith(("MEM0_HOST=", "MEM0_API_KEY="))]
    env.write_text("\n".join(keep) + ("\n" if keep else ""))
PY
```

### sentinel

```bash
HERMES_HOME=/root/.hermes/profiles/sentinel hermes config set memory.provider honcho
rm -f /root/.hermes/profiles/sentinel/mem0.json
python3 - <<'PY'
from pathlib import Path
env = Path('/root/.hermes/profiles/sentinel/.env')
if env.exists():
    lines = env.read_text().splitlines()
    keep = [line for line in lines if not line.startswith(("MEM0_HOST=", "MEM0_API_KEY="))]
    env.write_text("\n".join(keep) + ("\n" if keep else ""))
PY
```

### scribe

```bash
HERMES_HOME=/root/.hermes/profiles/scribe hermes config set memory.provider honcho
rm -f /root/.hermes/profiles/scribe/mem0.json
python3 - <<'PY'
from pathlib import Path
env = Path('/root/.hermes/profiles/scribe/.env')
if env.exists():
    lines = env.read_text().splitlines()
    keep = [line for line in lines if not line.startswith(("MEM0_HOST=", "MEM0_API_KEY="))]
    env.write_text("\n".join(keep) + ("\n" if keep else ""))
PY
```

## Backup/timer state

- Systemd timer: `mem0-backup.timer` on tori.
- State verified 2026-09-20: enabled, active/waiting, daily at 03:30 AEST, persistent.
- Last verified run: 2026-09-20 03:30:00–03:30:53 AEST, `Result=success`, exit status `0`.
- Latest completed backup manifest observed: `/mnt/pve/NAS/backups/mem0/20260919T173001Z/MANIFEST.txt`.
- Backup contents: `mem0-postgres-all.sql.gz`, `mem0-history.tar.gz`, and `MANIFEST.txt`.
- Freshness target for dashboard status: newest completed `MANIFEST.txt` under `/mnt/pve/NAS/backups/mem0/*/` must be no older than 36 hours.

Operator checks:

```bash
systemctl status mem0-backup.timer --no-pager
systemctl show mem0-backup.timer -p UnitFileState -p ActiveState -p SubState -p LastTriggerUSec -p NextElapseUSecRealtime --no-pager
journalctl -u mem0-backup.service -n 40 --no-pager
```

## Home Dashboard visibility

The personal dashboard now has two forms of mem0 rollout visibility:

1. Overview service status:
   - `Mem0 API (local-only)` probes `http://127.0.0.1:8888/openapi.json` server-side.
   - `Mem0 backup freshness` reads the newest completed backup manifest from the NAS backup directory server-side and returns only status, age, and timestamp; it does not expose local filesystem paths to the browser.
2. Knowledge → Documentation:
   - `Mem0 Service Runbook` serves `services/mem0/README.md`.
   - `Mem0 Hermes Rollout State and Rollback` serves this document.

The dashboard intentionally displays a safe label instead of a clickable mem0 API URL because the API is bound to tori localhost and should not be exposed through the household dashboard.
