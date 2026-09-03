# Bazarr — subtitle engine

Status: **inactive / not-yet-deployed desired-state seed** (no Bazarr container, image, or
config exists live as of 2026-09-03).

Bazarr is the primary subtitle engine for the `*arr` + Jellyfin media stack. It connects
to Sonarr (TV) and Radarr (movies) over their HTTP APIs to learn what media exists, then
queries subtitle providers (primarily OpenSubtitles.com) and writes `.srt` files directly
alongside media so Jellyfin picks them up on its next refresh — including backfilling
titles that shipped without subtitles in their original download.

## Scope of this card

This directory is an implementation seed (compose + docs + env-map), **not** a deployment.
Doing any of the following belongs to the deploy card, which is credential-gated:

- creating/running the Bazarr container,
- writing provider credentials into Bazarr's config DB,
- writing to `/mnt/pve/NAS/media/...`,
- touching the live Jellyfin/Sonarr/Radarr containers.

## Service definition

`docker-compose.yml` in this directory. Highlights:

- **Image:** `lscr.io/linuxserver/bazarr:latest`. Pin to a digest at deploy time (the
  archival `arr/init.sh` used a floating `latest` tag).
- **Mounts:**
  - `/mnt/pve/NAS/media/movies:/movies` and `/mnt/pve/NAS/media/tv:/tv` — read-write, and
    the **same canonical media roots the live Jellyfin on `jester` indexes** (see below),
    so subtitles land next to media and Jellyfin indexes external `.srt` natively.
  - `/mnt/pve/NAS/services/bazarr/config:/config` — stateful config (DB, provider
    settings, Sonarr/Radarr API keys).
- **Port:** `6767:6767` for the Bazarr web UI (matches the archival convention; nothing
  on `jester` listens there).
- **PUID/PGID:** `1001:1003`, matching the other `*arr` containers and the media
  directory ownership (`uid=1001 gid=1003`, mode `2777`).
- Runs as a normal unprivileged published-port container. The `privileged`/`network_mode:
  host` caveats on the Jellyfin seed do **not** apply here and must not be copied over.

## Host and mount reconciliation (verified 2026-09-03)

The live media stack lives on **`jester` (192.168.0.8)**, host Docker:

| Component | Live state |
|---|---|
| Jellyfin | Running; image `lscr.io/linuxserver/jellyfin:latest` (digest `sha256:fcab6147…`), published `8096`; binds movies `/mnt/pve/NAS/media/movies:/movies`, tv `/mnt/pve/NAS/media/tv:/tv`; PUID 1001 / PGID 1003; not privileged, not host-network. |
| Sonarr | Not running; NAS config exists at `/mnt/pve/NAS/services/sonarr/config` (port 8989, auth enabled, DB empty). |
| Radarr | Not running; NAS config exists at `/mnt/pve/NAS/services/radarr/config` (port 8989, auth enabled). |
| Prowlarr | Not running; NAS config exists (port 9696). |
| Bazarr | Absent (no container/image/config). |

These seeds deliberately use the **live** `/mnt/pve/NAS/...` mount convention (the path
Jellyfin actually binds on `jester`), rather than the older `/mnt/nas/...` convention
still used by some inactive repo candidates. Both are the same NAS share mounted at
different paths. Deploying Bazarr against `/mnt/pve/NAS/...` keeps it on the exact share
Jellyfin indexes; still re-confirm the target host's mount at deploy time before apply.

## Sonarr / Radarr connection (required)

Bazarr indexes nothing until it can reach Sonarr (TV) and Radarr (movies):

- **Sonarr:** host `192.168.0.8`, port `8989`. API key in `<ApiKey>` of
  `/mnt/pve/NAS/services/sonarr/config/config.xml`.
- **Radarr:** host `192.168.0.8`, port `8989` (app port). API key in `<ApiKey>` of
  `/mnt/pve/NAS/services/radarr/config/config.xml`.

Both API keys are secrets. Bazarr stores them in its config DB (not as Docker env vars);
the env-map (`bazarr.env.map.example`) records the Vaultwarden locations the deploy card
must render from. **Never commit the key values.**

> Dependency flag: Sonarr and Radarr are **not currently running**. The deploy card must
> sequence their bring-up (or record it as a known blocker) before Bazarr provisioning is
> marked complete.

## Providers

- **Primary — OpenSubtitles.com** (English default). Requires an account + API key. This
  is a **human-fetched credential**: Ben must obtain/supply it; neither the design nor
  any automation can invent it. Store in Vaultwarden folder `homelab`, item
  `bazarr/opensubtitles` (fields `username`, `api_key`). The deploy card treats this
  item's absence as a **hard block**.
- **Secondary — Jellyfin OpenSubtitles plugin**, on-demand/connect-per-library fallback
  only (outlined in the Jellyfin plugin implementation card). It does **not** do
  proactive whole-library backfill; Bazarr is the primary backfill engine.

## Language policy

- **Default:** English (`en`) only.
- **Fast-follow:** additional desired languages / foreign-audio-only items are explicit
  language-profile expansions to add after the English baseline is verified.

## Backup / rollback

- **Config is stateful and the most important artifact.** It holds the DB, provider
  settings, and Sonarr/Radarr API keys at
  `/mnt/pve/NAS/services/bazarr/config`. Back it up before any config change.
- **Media is treated as read-only by Bazarr except for additive `.srt` writes.** Bazarr
  must never move/rename/delete media. Rolling back a bad subtitle run = delete the
  offending `.srt` files (additive, non-media, safe to remove).
- **Pre-deploy snapshot:** record existing media `.srt` files and the Jellyfin server id
  so "new" subtitles can be attributed correctly.
- **Rollback path:** no live counterpart exists. "Rollback" = stop/remove the container,
  restore the pre-deploy config backup, and delete any unwanted `.srt` files it wrote.
- **Stale-NFS discipline:** Bazarr holds the same NAS media binds as Jellyfin; if it hits
  stale file handles after a NAS outage, restart only the Bazarr container (never delete
  media or recreate volumes) — see `services/jellyfin/README.md` incident notes.

## Risks / caveats

- Writes `.srt` next to media on NAS (owned 1001:1003, mode 2777) — intended and
  already-proven; running as 1001:1003 keeps ownership correct.
- Sonarr/Radarr must be up before Bazarr can index.
- OpenSubtitles credential is human-gated.
- Mount-path drift (`/mnt/nas` vs `/mnt/pve/NAS`) resolved here in favour of the live
  Jellyfin path; verify on the target host at deploy time.

## Secret handling

No Bazarr secrets exist on disk. These must exist in Vaultwarden (folder `homelab`)
before deploy and must never appear in Git:

| Purpose | Item | Fields |
|---|---|---|
| OpenSubtitles.com account | `bazarr/opensubtitles` | `username`, `api_key` |
| Sonarr API key | `sonarr/service` | `api_key` |
| Radarr API key | `radarr/service` | `api_key` |

See `bazarr.env.map.example` for the canonical `ENV_NAME|folder|item|field` render map.