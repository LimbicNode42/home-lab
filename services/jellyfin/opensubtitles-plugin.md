# Jellyfin Open Subtitles plugin — secondary subtitle path

Status: **documented desired-state procedure only** (no live mutation). The plugin is not
installed, configured, or touched against the running Jellyfin instance as of 2026-09-03.
Installation/activation against live state is the deploy card's job (credential-gated).

This is the **secondary (belt-and-braces)** subtitle download path for the Jellyfin media
stack. Bazarr (see `../bazarr/README.md`) is the **primary** engine: it holds the
OpenSubtitles.com credential in its own config, and it does **proactive whole-library
backfill** of titles that shipped without subtitles. This plugin is the on-demand/per-library
fallback so that Jellyfin alone can still fetch subtitles if Bazarr is down or out of scope.

## Plugin identity (verified against the Jellyfin plugin catalog, 2026-09-03)

| Field | Value |
|---|---|
| Name | `Open Subtitles` |
| GUID | `4b9ed42f-5185-48b5-9803-6ff2989014c4` |
| Category | Subtitles |
| Owner | `jellyfin` (official, bundled in the default catalog) |
| Current version | `24.0.0.0` |
| Target ABI | `10.11.8.0` — matches live Jellyfin `10.11.8` on `jester` (`192.168.0.8`) |
| Source zip | `https://repo.jellyfin.org/files/plugin/open-subtitles/open-subtitles_24.0.0.0.zip` |
| MD5 checksum | `37e6bbe279fc197dffc55008f2096113` |

No third-party repository is required — this plugin ships from Jellyfin's default plugin
catalog (`repo.jellyfin.org`), which the live instance already uses.

## What it does and does NOT do

Does:

- Download external subtitles for a media item on demand (via the per-item subtitle menu,
  "Edit Subtitles → Search") using the configured OpenSubtitles.com credential.
- Fetch subtitles for **newly added** items during the library's normal scan/refresh, and via
  the scheduled "Download Subtitles" task, for any library that has the per-library
  "Download subtitles" option enabled.
- Serve as a self-contained fallback inside Jellyfin with no separate service dependency.

Does **NOT**:

- **Batch-backfill a pre-existing library** the way Bazarr does. The plugin runs on scan and
  on the scheduled task with no per-item tuning, no score thresholds, and no provider
  ranking. A full existing-library backfill (all titles missing subtitles at install time) is
  Bazarr's job, not this plugin's.
- Replace Bazarr as the source of truth for subtitles. Bazarr remains the primary engine; this
  plugin is a layered safety net only.

> Explicit note for the deploy card: installing this plugin does **not** retroactively subtitle
> the existing library. Do not mark "library backfilled" complete on the strength of this plugin
> alone — that is a Bazarr deliverable.

## Installation procedure (Jellyfin UI — human-guided, deploy card only)

The canonical path is the Jellyfin web UI. A plugin install requires a Jellyfin server
restart, so the deploy card must sequence it (and only it may). All steps below are UI
paths, not executed here.

1. Open Jellyfin on `jester` (`http://192.168.0.8:8096`), logged in as an administrator.
2. **Dashboard → Plugins → Catalog**, search `Open Subtitles`.
3. Install the `Open Subtitles` entry (GUID `4b9ed42f-...`, version `24.0.0.0`).
4. Confirm the "restart required" prompt and restart Jellyfin.

### Credential configuration

The plugin authenticates to **OpenSubtitles.com** using a username/password pair (a VIP API
key may be used in place of the password). This is a **human-fetched credential**: it cannot
be invented or derived — Ben must supply it, and its absence is a hard block for the deploy
card.

Configure it at:

```
Dashboard → Plugins → My Plugins → Open Subtitles → Settings
    Username:  <OpenSubtitles.com username>
    Password:  <OpenSubtitles.com password / VIP API key>
```

Credential values are stored **inside Jellyfin's plugin config** (not Docker env vars) and
must **never** be committed to Git. Reference Vaultwarden only:

| Purpose | Folder | Item | Fields |
|---|---|---|---|
| OpenSubtitles.com account | `homelab` | `jellyfin/opensubtitles` | `username`, `password` (or `api_key`) |

No secret value appears in this repo; the deploy card renders these from Vaultwarden at
activation time.

### Enable per-library downloading

The plugin only acts on libraries where the download flag is set:

1. **Dashboard → Libraries** → edit a library (live libraries on `jester` are `Movies`
   (`/movies`) and `TV Shows` (`/tv`)).
2. Scroll to **Subtitle Downloads** and enable **Download subtitles**.
3. Set **Preferred subtitle language** to **English** (`en`) — matching the English-only
   language policy on the Bazarr side.
4. Save. Repeat for each library that should have the fallback.

### Scheduled task

The actual periodic fetch is a scheduled task, not a library-scan side effect alone:

```
Dashboard → Scheduled Tasks → "Download Subtitles"
```

Set the interval to taste (Bazarr handles the aggressive/backfill cadence; keep this modest,
e.g. daily). Runs against every library with "Download subtitles" enabled.

> Deploy-card verification: after install + credential + library flag, confirm the task
> appears under **Dashboard → Scheduled Tasks** and does not error on a manual run.

## Secret handling

- The OpenSubtitles.com `username`/`password` (or `api_key`) is the only secret involved.
- Never commit it. Reference Vaultwarden folder `homelab`, item `jellyfin/opensubtitles`.
- This doc contains no live credentials, only Vaultwarden references.

## Relationship to Bazarr

| Concern | Bazarr (primary) | Jellyfin Open Subtitles plugin (secondary) |
|---|---|---|
| Scope | Whole-library proactive backfill + ongoing | On-demand + per-library scan/scheduled fetch |
| Credential store | Bazarr config DB (`/mnt/pve/NAS/services/bazarr/config`) | Jellyfin plugin config |
| Credential item | `homelab` / `bazarr/opensubtitles` | `homelab` / `jellyfin/opensubtitles` |
| Subtitles written | `.srt` next to media on NAS | `.srt` into Jellyfin's metadata path (config dir) |
| Language | English only | English only |

Both share the same OpenSubtitles.com account family; the deploy card may use one account for
both, or separate accounts — that decision is not settled here.