# Kanban runtime secret access via Vaultwarden/BW

Status: desired-state specification for Kanban workers and ASX screener provider keys. No live Vaultwarden items, scheduler settings, gateway settings, or rendered secret files were changed for this spec.

## Source of truth

Vaultwarden/Bitwarden Password Manager is the persistent protected store for homelab application secrets.

Git may store only non-secret references:

- Vaultwarden server URL when non-secret and already documented;
- folder name;
- item name;
- field name;
- target runtime environment variable name;
- examples using placeholders such as `REPLACE_WITH_...`.

Git must not store secret values, Bitwarden sessions, rendered long-lived app `.env` files, API keys, passwords, private keys, shell transcripts containing secrets, or command examples that put secret values in process arguments.

For Kanban worker execution, the normal architecture is command-scoped runtime injection: fetch the approved item/field immediately before running the child command, place the value only in that child process environment, and avoid writing a rendered app secret file unless a specific deployment workflow explicitly requires a root-only local `.env` as a temporary handoff.

## Mapping format

Repository mapping files used by `scripts/secrets/render-env-from-vaultwarden.sh` and future command-scoped wrappers should use this pipe-delimited format:

```text
ENV_NAME|folder|item|field
```

Example:

```text
FMP_API_KEY|homelab|investment-screener/fmp|api_key
```

Legacy notes that described `folder|item|field|env` or `ENV=bw://folder/item/field` were documentation formats, not the renderer contract. New implementation work should support the canonical `ENV_NAME|folder|item|field` contract first and may add backward-compatible parsing only if tests make the behavior explicit.

## ASX/FMP secret references

Current actual item reported by the dashboard unblock path:

| Purpose | Folder | Item | Field | Runtime env |
|---|---|---|---|---|
| FMP provider key, current | `homelab` | `FMP_API_KEY` | `password` | `FMP_API_KEY` |

Preferred normalized future item:

| Purpose | Folder | Item | Field | Runtime env |
|---|---|---|---|---|
| FMP provider key, normalized | `homelab` | `investment-screener/fmp` | `api_key` | `FMP_API_KEY` |

Do not mutate the Vaultwarden item name or field as part of worker execution unless Ben explicitly approves that item change. Until the normalized item exists, wrappers should be able to use the current actual item reference.

## Runtime wrapper pattern

Desired shape for a command-scoped helper:

```sh
scripts/secrets/run-with-vaultwarden-env.sh \
  services/personal-dashboard/personal-dashboard.env.map.example \
  -- \
  services/personal-dashboard/scripts/run-asx-screener-hydration.sh
```

Required behavior:

1. Require an unlocked Bitwarden CLI session through `BW_SESSION` or a documented unlock bootstrap path.
2. Parse `ENV_NAME|folder|item|field` mapping lines; ignore blank lines and comments.
3. Fetch each field with `scripts/secrets/bw-get-field.sh` or equivalent `bw` calls using `--session "$BW_SESSION"`.
4. Export the resolved values only into the child command environment.
5. Run or `exec` the child command without printing the secret values.
6. Preserve child exit status.
7. Fail closed if any required item/field is missing or empty.
8. Never enable shell tracing around secret resolution.

The wrapper may print non-secret diagnostics such as mapping file path, target env var names, item references, and child command name. It must not print field values.

## Unlock choices for unattended workers

At least one of these must be true before a headless Kanban worker can fetch secrets:

1. Inherited `BW_SESSION`: the dispatcher or wrapper process inherits a still-valid unlocked Bitwarden session. Treat `BW_SESSION` as a secret; do not commit or log it.
2. Non-interactive unlock from protected bootstrap credentials: local root-only secret storage provides `BW_SERVER`, `BW_CLIENTID`, `BW_CLIENTSECRET`, and `BW_PASSWORD`, then `scripts/secrets/bw-login-vaultwarden.sh` runs `bw login --apikey` and `bw unlock --passwordenv BW_PASSWORD --raw`. These bootstrap values are secrets and must remain outside Git.
3. Human-unlocked session before dispatch: Ben or an operator unlocks Bitwarden on the execution host and starts the bounded worker/job with that session available.

If none of those is available, the worker should block with a precise access request instead of asking for the API key value in chat or writing it to a `.env` file.

## ASX/FMP execution notes

FMP remains an optional fail-closed provider for the investment screener. `FMP_API_KEY` should be present only for the command that needs it, for example a smoke or supervised top-400 ASX hydration run. The screener and owner wrapper should keep logs sanitized: coverage, run id, source/provenance labels, and failure counts are acceptable; provider payloads and key material are not.

The first credentialed run should stay bounded:

1. Preflight that no ASX hydration job is already running.
2. Use command-scoped injection for `FMP_API_KEY`.
3. Run a tiny smoke first, preferably top 5 or a known previously-failed slice if supported.
4. If smoke passes, run a supervised top-400 prefix.
5. Verify coverage, provenance, previous latest preservation, secret redaction, and whether the 88% top-400 gate is cleared.

## Acceptance criteria for follow-up cards

### Implementation card

- Adds a reusable command-scoped wrapper, such as `scripts/secrets/run-with-vaultwarden-env.sh`.
- Uses `ENV_NAME|folder|item|field` mapping files.
- Supports the current FMP item `FMP_API_KEY|homelab|FMP_API_KEY|password` and documents the normalized future item `FMP_API_KEY|homelab|investment-screener/fmp|api_key`.
- Fails fast when `BW_SESSION` is absent, an item is missing, a field is missing, or a fetched value is empty.
- Injects values only into the child command environment and preserves child exit status.
- Has tests or dry-run fixtures proving parsing, missing-session behavior, no secret echo in stdout/stderr, and command-scoped env visibility.
- Does not perform live hydration, scheduler changes, gateway changes, or Vaultwarden item mutation.

### Review card

- Confirms no committed files contain raw secret values, Bitwarden sessions, or credential-shaped placeholders that look real.
- Confirms examples and maps agree on `ENV_NAME|folder|item|field`.
- Confirms wrapper logs reveal only variable names and item references, not values.
- Confirms ASX/FMP docs still require bounded smoke verification before top-400/full-seed runs.
- Confirms any long-lived rendered `.env` file is documented as a deployment-specific exception, not the normal Kanban worker pattern.

### Ops card

- Chooses and documents one unlock path for unattended execution: inherited `BW_SESSION`, non-interactive protected bootstrap credentials, or human-unlocked pre-dispatch session.
- Stores any bootstrap credentials only in approved local secret storage with restrictive permissions.
- Verifies `bw status`, `bw sync`, and one non-secret dry-run path on the execution host.
- Verifies the actual FMP item location before running ASX smoke hydration.
- Keeps scheduler/gateway restarts out of scope unless separately approved.
