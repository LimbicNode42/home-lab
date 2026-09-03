# Bazarr

Status: **inactive/unverified candidate desired-state seed** (no Bazarr container exists live as of 2026-09-03).

Subtitle management companion to the `*arr` stack and Jellyfin. Bazarr drives automatic
subtitle acquisition from providers such as OpenSubtitles.com and writes `.srt` files
directly alongside media so Jellyfin can pick them up without any extra plugin work.

## Live reconciliation summary (2026-09-03)

The live Jellyfin media stack is split across two hosts and is **not** yet fully
reconciled to the repo candidate seeds:

| Component | Live state | Repo seed state |
|---|---|---|
| Jellyfin | **Running** on `jester` (`192.168.0.8`), host Docker, image `lscr.io/linuxserver/jellyfin:latest` (digest `sha256:fcab6147…`), published `8096/tcp`; binds config `/opt/jellyfin-config:/config`, movies `/mnt/pve/NAS/media/movies:/movies`, tv `/mnt/pve/NAS/media/tv:/tv`; PUID 1001 / PGID 1003; **not** privileged, **not** host-network (`NetworkMode=default`). Jellyfin server id `d85ae9f6…`, version `10.11.8`. | Candidate `services/jellyfin/docker-compose.yml` mounts `/mnt/nas/…` + `/mnt/nas/services/jellyfin/config` and carries `privileged: true` / `network_mode: host` — these diverge from the observed live container and must be reconciled before any apply. |
| Sonarr | **Not running** anywhere. NAS config exists at `/mnt/pve/NAS/services/sonarr/config` (`config.xml` Port 8989, auth enabled), but the DB is empty (`sonarr.db` 0 bytes, mtime 2025-04-28). | Inactive seed; archived script used `/opt/sonarr/config` (README already flags this inconsistency). |
| Radarr | **Not running** anywhere. NAS config exists at `/mnt/pve/NAS/services/radarr/config` (`config.xml` Port 8989, auth enabled, mtime 2025-05-08). | Inactive seed. |
| Prowlarr | **Not running** now; NAS config exists (`/mnt/pve/NAS/services/prowlarr/config`, Port 9696, DB populated to 2025-08-19). | Inactive seed. |
| Bazarr | **Does not exist** — no container, no image, no `/opt/bazarr`, no NAS service dir, no config. | This seed is the first artifact for it. |
| qBittorrent / Jellyseerr | Not running on `jester` (only Jellyfin container exists there). | Inactive seeds. |

Key facts for the Bazarr design:

- **Host:** the media containers belong on `jester` (`192.168.0.8`), which is where live
  Jellyfin runs and which holds the NAS media shares under `/mnt/pve/NAS/media/`.
- **Media root (movies and TV, canonical):** `/mnt/pve/NAS/media/movies` and
  `/mnt/pve/NAS/media/tv`. These are the same physical share Jellyfin indexes, owned
  `uid=1001 gid=1003`, mode `2777`, writable by PUID 1001. Concurrent `.srt` files
  already live next to media (see "Writability" below), so Bazarr writing alongside
  media is the intended, already-proven pattern.
- **Container ports:** archived `arr/init.sh` ran Bazarr on `6767` (published
  `6767:6767`). No listener currently occupies `6767` on `jester`.
- **PUID/PGID:** Bazarr should run as `1001:1003` to match the media ownership and the
  rest of the `*arr` stack, so it can write `.srt` files next to media.

## Bazarr service definition (desired state)

See `docker-compose.yml` in this directory. Highlights:

- Image: `lscr.io/linuxserver/bazarr:latest` (pin to a digest before apply).
- Mounts `/movies` and `/tv` read-write so Bazarr writes subtitles next to media.
- Config volume at `/mnt/nas/services/bazarr/config` (the NAS service path convention;
  the archived script instead used host-local `/opt/bazarr/config`).
- Port `6767` for the Bazarr web UI.
- Runs unprivileged as `1001:1003` — no privileged/host-network needed (those caveats
  belong to Jellyfin's seed and are **not** transferred to Bazarr).

### Mount path caveat (reconcile before apply)

Every repo `*arr` seed (and this one) uses `/mnt/nas/...`, but the live Jellyfin
container on `jester` binds `/mnt/pve/NAS/...`. The two are the same NAS share mounted
at different paths (Proxmox storage `NAS` exposes it as `/mnt/pve/NAS` on `jester`;
older CT/archive references used a `/mnt/nas` bind). Pick one convention and reconcile
all seeds together before deploying Bazarr — otherwise Bazarr could end up writing
subtitles on a different mount than Jellyfin indexes.

The safest interim choice is to match the **live** Jellyfin container exactly:
`/mnt/pve/NAS/media/{movies,tv}` and `/mnt/pve/NAS/services/bazarr/config`. Do not apply
until this is confirmed on the target host at deploy time.

## Sonarr/Radarr connection details (Bazarr needs these)

Bazarr connects to Sonarr (TV) and Radarr (movies) over their HTTP APIs to learn what
media exists, then queries subtitle providers and writes `.srt` next to the episodes
and movies it finds.

- **Sonarr:** host `192.168.0.8`, port `8989` (from live `config.xml`). API key lives in
  `<ApiKey>` in `/mnt/pve/NAS/services/sonarr/config/config.xml`. Authentication is
  `Enabled`.
- **Radarr:** host `192.168.0.8`, port `8989` (from live `config.xml`; note the archived
  run script published the container at host `8990` — reconcile the container port vs.
  the app port before wiring Bazarr). API key lives in `<ApiKey>` in
  `/mnt/pve/NAS/services/radarr/config/config.xml`. Authentication is `Enabled`.

**These API keys are secrets.** Bazarr's config references them; the repo must NEVER
carry the key values. Store them in Vaultwarden at folder `homelab`, items
`sonarr/service` (field `api_key`) and `radarr/service` (field `api_key`), following the
existing `docs/secrets/vaultwarden-item-map.md` convention. The Bazarr deploy card must
render these values from Vaultwarden at runtime, not from Git.

Important: Sonarr and Radarr are **not currently running**. Bazarr cannot index anything
until those services are brought up (out of scope for the subtitle design task, but the
deploy card must sequence or at least document this dependency).

## Provider config

- **Primary: OpenSubtitles.com** (English default). Requires an account and API key.
  That credential is a **human-fetched credential** — Ben must obtain/provide the
  OpenSubtitles account + API key; neither the design nor the deploy can invent it.
  Store it in Vaultwarden folder `homelab`, item `bazarr/opensubtitles` (fields
  `username`, `api_key`). The deploy card must treat this item's absence as a hard
  block and surfacing it is the human-fetch signal.

- **Secondary: Jellyfin OpenSubtitles plugin.** See "Jellyfin plugin path" below.

## Jellyfin OpenSubtitles plugin as a secondary path

Jellyfin has a built-in "Open Subtitles / Subtitle Downloads" plugin that can fetch
subtitles on demand for items that already lack them. Current live state on `jester`:

- Jellyfin `10.11.8` is installed with the default metadata plugins only
  (`MusicBrainz`, `StudioImages`, `Omdb`, `Tmdb`). There is **no OpenSubtitles plugin
  installed yet**; `/opt/jellyfin-config/plugins/` and `plugins/configurations/` are
  empty of any subtitle provider config.
- A populated `/opt/jellyfin-config/data/data/subtitles/` cache directory exists, but
  its presence only reflects prior subtitle activity — it is **not** evidence that the
  OpenSubtitles plugin is currently enabled.

How the plugin path works (for the downstream implementation card):

1. Enable it from Jellyfin Admin Dashboard → Plugins → Catalog → "Open Subtitles".
2. Configure the provider with the same OpenSubtitles account/API key (or a separate one).
3. Scope/coverage: the plugin is primarily an on-demand/manual and connect-per-library
   subtitle downloader. It does **not** do the same proactive whole-library backfill,
   language-rule automation, or connected `*arr`-aware scheduling that Bazarr does. It is
   the belt-and-braces fallback, not the primary backfill engine.

The plugin configuration is part of a parallel implementation card (Jellyfin plugin
impl), per the epic decomposition. This document only fixes the policy: plugin = secondary,
on-demand backfill; Bazarr = primary, automated.

## Language policy

- **Interim default: English only.** Bazarr's default language profile is set to `en`.
- **Fast-follow:** foreign-audio-only items (e.g. non-English original audio where
  English subtitles are unavailable/undesired) and additional desired languages. These
  are explicit language-profile expansions to do after the English baseline is verified,
  not part of the initial bring-up.

## Backup / rollback notes

- **Config is stateful:** Bazarr config lives at `/mnt/nas/services/bazarr/config`
  (or the reconciled path). It holds the DB, provider settings, and the Sonarr/Radarr
  API keys. Back it up before any config change; it is the single most important
  Bazarr artifact.
- **Media is read-mostly by Bazarr but writable:** the only thing Bazarr writes into
  media roots are subtitle files next to existing media. It must **not** move, rename,
  or delete media. Rollback of a bad subtitle run = delete the offending `.srt` files
  (safe: they are additive, non-media files).
- **Pre-deploy snapshot:** before the first Bazarr apply, capture the existing media
  `.srt` files present (there are already many, e.g. in movies and tv), and record the
  Jellyfin server id so any perceived "new subtitles" can be attributed correctly.
- **Rollback path:** Bazarr has no live counterpart to preserve. "Rollback" = stop and
  remove the new container, restore the pre-deploy config backup (if any changes were
  made), and delete/none the subtitles it wrote if they are unwanted. No legacy
  container, image, or data volume exists to preserve (verified 2026-09-03).
- **Restore a container-restart discipline:** this host has a documented Jellyfin
  "stale NFS handle" failure mode (`services/jellyfin/ops/jellyfin-stale-handle-watchdog`).
  Bazarr will hold the same NAS media binds; if it hits stale file handles after a NAS
  outage, restart only the Bazarr container after verifying the host mount is healthy —
  do not delete media or recreate volumes. See the Jellyfin README "Incident notes" for
  the exact pattern.

## Risks and caveats

- **Writes next to media on NAS.** Bazarr writes `.srt` files into `/mnt/pve/NAS/media/...`.
  The media dirs are `uid=1001 gid=1003`, mode `2777`, and **writable by PUID 1001** —
  verified by a write test and by the presence of many existing `.srt` files alongside
  media. Running Bazarr as `1001:1003` gives it the same ownership as the media, so
  subtitle writes will land with the correct ownership and Jellyfin (also reading these
  dirs) will index them normally.
- **No disturbance to Jellyfin indexing.** `.srt` files are recognized by Jellyfin as
  external subtitle tracks. Writing them is additive and does not disturb existing
  media files or Jellyfin's library scan. (Confirm the Jellyfin library has "Save
  subtitles into media folders" behavior set to expect external `.srt` files, which is
  the default expectation for this layout.)
- **Privileged / host-network caveat does NOT apply to Bazarr.** Those caveats are
  documented on the Jellyfin seed only. Bazarr is a normal published-port container.
  Do not copy `privileged: true` / `network_mode: host` from Jellyfin.
- **Sonarr/Radarr down.** Bazarr is useless until Sonarr and Radarr are running and
  reachable. The deploy card must sequence their bring-up (or treat it as a known
  blocker) before Bazarr provisioning is marked complete.
- **OpenSubtitles credential is human-gated.** No automation can provision the account
  or API key; it is a hard block for the deploy card until Ben supplies it.
- **Media mount-path drift.** `/mnt/nas` vs `/mnt/pve/NAS` must be resolved before apply
  (see caveat above) so Bazarr and Jellyfin reference the same physical share.

## Secret handling

None identified on disk for Bazarr (no container, no config exists). The following
credentials must exist before deploy and must live only in Vaultwarden (`homelab` folder):

| Purpose | Item | Fields |
|---|---|---|
| OpenSubtitles account | `bazarr/opensubtitles` | `username`, `api_key` |
| Sonarr API key | `sonarr/service` | `api_key` |
| Radarr API key | `radarr/service` | `api_key` |

Never commit any of these values. The Bazarr config references them via Vaultwarden
render flows at deploy time.
