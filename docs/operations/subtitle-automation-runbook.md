# Subtitle Automation — Runbook & Status

Status: LIVE. Bazarr now serves both movies and TV, a free-provider tier is
enabled alongside OpenSubtitles.com, a full-library English backfill has been
run (provider-limited), and a redacted status panel is live on the Home
Dashboard. This is the durable reference for providers, the TV-import fix, the
backfill, and how to continue or re-run safely.

Source tasks (self-reports, point-in-time): provider research `t_d99dcb40`,
TV-import + provider enablement `t_f4573054`, full-library backfill
`t_64d85e19`, dashboard surface `t_3dd47ad1`.

Hosts: Bazarr / Sonarr / Radarr / Jellyfin run on `jester` (192.168.0.8).
Home Dashboard / personal-dashboard runs on `critical` (192.168.0.50).

## 1. Providers (enabled set, auth, rate limits, avoided)

Bazarr 1.6.0. Provider registry is dynamic (every `*Provider` class in the
source tree auto-registers); the practical ground truth is which provider files
exist plus `bazarr/app/get_providers.py` (throttle/backoff map and
`PROVIDERS_FORCED_OFF`). Sources of truth:

- Source tree: https://github.com/morpheus65535/bazarr/tree/master/custom_libs/subliminal_patch/providers
- Registry/throttle: https://raw.githubusercontent.com/morpheus65535/bazarr/master/bazarr/app/get_providers.py
- Docs: https://wiki.bazarr.media/ (Providers, Subtitles, Whisper-Provider, OpenSubtitles-migration)

### Currently enabled (as applied by `t_f4573054`)

`enabled_providers` = `opensubtitlescom, embeddedsubtitles, subf2m, gestdown, subx`

| Provider | Media | Auth | Notes / rate limits |
|---|---|---|---|
| OpenSubtitles.com (`opensubtitlescom`) | M + TV | user + pass + API key (all required) | Anchor provider. Daily download quota with `remaining` + `reset_time`; 429 → 1 min throttle, `DownloadLimitExceeded` → 6 h throttle. VIP raises quota. Credentials are in Vaultwarden (see below) — NOT committed. |
| SubF2M (`subf2m`) | M + TV | none (scraped) | Free English. No account; reliability hinges on site stability. Primary OpenSubs relief for movies. |
| Gestdown (`gestdown`) | TV only | none (free API) | Free English TV source; episodes only. Strong TV relief — produced all 10 backfill downloads. |
| SubX (`subx`) | M + TV | none (scraped) | Free open-subtitle aggregator via `subx-api.duckdns.org`; low risk. |
| Embedded Subtitles (`embeddedsubtitles`) | M + TV | none | Not a "source" — extracts subs already in the media file. Free, stops redundant network search. |

### Auth requirements (references only — no secrets)

- OpenSubtitles.com: username + password + API key. Stored in Ben's Vaultwarden
  vault, folder `homelab`, item `OPENSUBS_CREDENTIALS` (fields: username /
  password / api_key). Git stores only the item/field reference, never values.
- SubF2M, Gestdown, SubX, Embedded: no account, no key.

### Disabled / avoided provider rationale

| Provider | Rationale |
|---|---|
| Podnapisi | Obsolete — no provider file in current Bazarr source. |
| Subscene | Obsolete — `subscene_api` present only as a 0-byte stub; no provider class. |
| Legacy OpenSubtitles (.org) | Separate account system; only `opensubtitlescom` is integrated (no ".org legacy" fallback). Use the documented .org→.com migration. |
| Addic7ed | `PROVIDERS_FORCED_OFF`; TV-only; free tier ~40 subs/day; login requires reCAPTCHA (needs an anti-captcha service). High-touch, not worth enabling. |
| superSubtitles (feliratok.eu) | `PROVIDERS_FORCED_OFF`; login + captcha; Hungarian-first — wrong language focus. |
| Assrt | Token-gated; Chinese/Asian-first — wrong language focus. |
| SubDL | Solid second anchor, but needs an API key Ben does not hold yet (needs_input). |
| SubSource | Freemium API; needs a key (needs_input). |
| Whisper AI (via SubGen) | Not a provider — a local generator. See below. |

### Whisper / SubGen fallback (recommended future relief)

Self-hosted `SubGen` (whisper-asr-webservice) generating English subs locally is
the highest-leverage way to relieve OpenSubtitles rate-limit pressure with zero
account/ban risk. If enabled, treat it as **fallback only** (not a first-class
source, or backfill turns into a local CPU/GPU burn), and **lower** the "minimum
score for episodes/movies" below Whisper's fixed scores (~61% episodes / ~33%
movies) or auto-search will never accept generated subs. Not yet deployed —
candidate follow-up.

### Provider settings the implementer should preserve/avoid

- OpenSubtitles.com: enable `use_hash` search; consider VIP before a large
  backfill. Bazarr self-throttles on `DownloadLimitExceeded` (6 h) — that is the
  pause-and-resume signal, do not force-clear backoffs.
- Adaptive searching: set `false` on this NAS-class host (spinning drives +
  CPU burden; multi-provider simultaneous search is backfill-hostile).
- Do NOT set "Skip Video File Hash Calculation" during backfill — hash match is
  the key OpenSubtitles de-dup.

## 2. TV import fix (root cause + correct path mapping)

### Root cause

Bazarr mirrors Sonarr. Sonarr held exactly **1 series (Ahsoka)** while the live
`/tv` filesystem had **138 top-level folders** (and ~4770 media items), so the
entire TV library was missing upstream from Bazarr and therefore not
subtitle-eligible.

### Fix (metadata-only)

Ingested the existing TV library into Sonarr (TVDB metadata import, no media
moved/renamed/deleted), then Bazarr's Sonarr sync pulled it in.

| Metric | Before | After |
|---|---|---|
| Sonarr series | 1 | 118 |
| Bazarr shows | 1 | 110 |
| Bazarr episodes | 8 | 612 |
| Bazarr missing-episode badge | 0 | ~73 |

- Dry-run TVDB lookup first: 137 candidates, 113 auto-matched, 24 flagged
  needs-review.
- Imported 106 series via `POST /api/v3/series` (rootFolderPath `/tv`,
  monitored=true, seasonFolder=true, searchForMissingEpisodes=false).
- 7 auto-matches failed on transient TVDB errors; the obvious titles were
  re-added by explicit `tvdbId` (final DB count 118).
- ~20 `/tv` folders remain unmapped: mostly duplicate release-name dirs that
  already have a clean-title series entry, plus a handful needing manual TVDB
  title matching. Safe to leave; candidate for a follow-up cleanup card.

### Correct path mapping (all four containers agree)

| Host path | Container path | Consumers |
|---|---|---|
| `/mnt/pve/NAS/media/tv` | `/tv` | Bazarr, Sonarr, Jellyfin |
| `/mnt/pve/NAS/media/movies` | `/movies` | Bazarr, Radarr, Jellyfin |

Write permissions verified as uid `abc` (1001/1003) on `/tv`, `/movies`,
`/config`.

## 3. Full-library backfill (results + re-run/continuation)

Run as `t_64d85e19`. **Honest, bounded, provider-limited — not complete.**

### Preflight (PASS)

Bazarr 1.6.0 healthy; saw 792 movies / 118 series / 612 episodes; wanted
(missing English) at start = 409 movies + 63 episodes; write perms OK. No
media/subtitle content touched at preflight.

### Run

Triggered Bazarr-native bulk tasks via `POST /api/system/tasks`:

- `wanted_search_missing_subtitles_movies` — 02:19:10–02:21:46 (UTC)
- `wanted_search_missing_subtitles_series` — 02:22:13–02:29:44 (UTC)

### Results

| Metric | Value |
|---|---|
| Movies considered (wanted) | 409 |
| Episodes considered (wanted) | 63 |
| Downloaded this run | 10 episodes, 0 movies |
| Producer | gestdown (all 10, "English HI", ~93.89%) |
| Movies still wanted after | 409 (unchanged) |
| Episodes still wanted after | 53 (was 63) |
| Failed providers | opensubtitlescom (AuthenticationError), subf2m (ConfigurationError) |
| Retry candidates | 409 movies + 53 episodes once providers recover |

DB receipts (read-only on `/config/db/bazarr.db`):
episodes_subtitles 4457 → 4723 (+266 session, +10 this run); movies_subtitles
483 unchanged; history_episode 71 rows all gestdown; history_movie 40 rows, none
since 02:19.

### Why 0 movies (root cause, not a bug)

At run time the movie library had no working external provider:

- opensubtitlescom → AuthenticationError ("Login failed"); credentials are
  failing auth — needs Ben to reconcile the OpenSubtitles.com account/API key.
- subf2m → ConfigurationError (empty `user_agent`), 12 h backoff. Config was
  subsequently fixed (UA set); it auto-retries once the backoff clears.
- gestdown/subx → Good, but TV-oriented; found nothing for movies.
- embeddedsubtitles → only extracts already-embedded tracks.

### Blocking next step (Ben action)

Reconcile OpenSubtitles.com credentials in the `OPENSUBS_CREDENTIALS`
Vaultwarden item (username / password / API key). Until then the movie backfill
cannot progress. This is the single highest-leverage fix.

### How to re-run / continue safely

Scheduled tasks remain enabled and self-heal: `wanted_search_missing_subtitles_movies`
and `wanted_search_missing_subtitles_series` run every 6 h, so the backfill
resumes automatically once opensubtitlescom/subf2m recover.

To re-run manually after the credential fix, POST the same endpoints:

```sh
curl -X POST http://192.168.0.8:6767/api/system/tasks \
  -H "X-API-KEY: <bazarr api key>" \
  -H "Content-Type: application/json" \
  --data '{"taskid":"wanted_search_missing_subtitles_movies"}'
curl -X POST http://192.168.0.8:6767/api/system/tasks \
  -H "X-API-KEY: <bazarr api key>" \
  -H "Content-Type: application/json" \
  --data '{"taskid":"wanted_search_missing_subtitles_series"}'
```

Do not force-clear provider backoffs; let Bazarr's throttle map pace the sweep.
No media/subtitle deletions, no Jellyfin/Traefik restarts were performed and
none are required to continue.

### Safety posture

No deletions, no forced backoff clears, no Jellyfin/Traefik restarts. Expected
subtitle-file writes are in scope; deleting/replacing media or existing
subtitles is not (requires explicit Ben approval).

## 4. Home Dashboard status

A redacted "Subtitle automation" panel is live on the Home Dashboard Overview
(commit `fe12753` on `wt/t_3dd47ad1`), exposing:

- Bazarr link: http://192.168.0.8:6767
- last-run timestamp (lastRunAt)
- coverage/wanted summary (10 downloaded / 53 episodes wanted / 409 movies
  wanted at last write)

Coverage is deliberately **last-known**, not live-polled: Bazarr's `/api/*` is
auth-walled and the dashboard holds no API key. Bazarr service reachability
remains live via the existing status probe (up / 200 / ~65 ms). Config block is
served at `/api/config/public` with `state: provider_limited`.

## 5. Fast-follows

- Foreign-audio-only filtering (English subs are currently attempted for all
  titles regardless of audio language).
- Extra languages (English-only policy enforced today).
- Provider credential additions (SubDL / SubSource keys; OpenSubtitles.com VIP).
- Whisper/SubGen fallback deployment.
- Manual TVDB matching for the ~20 unmapped `/tv` folders.
- Retry pacing: 6 h wanted-search cadence is the retry mechanism.

## Receipts

- Provider matrix: bazarr-provider-matrix.md (task t_d99dcb40).
- Implementation handoff: handoff-report.md (task t_f4573054).
- Backfill handoff: backfill-handoff_1.md (task t_64d85e19).
- Dashboard handoff metadata: task t_3dd47ad1.
- Bazarr live API/DB receipts: /api/badges, /api/providers, /api/movies/wanted,
  /api/episodes/wanted, /api/system/tasks, /api/movies/history,
  /api/episodes/history; /config/db/bazarr.db (read-only); /config/log/bazarr.log.
