# Jellyfin In-App Subtitle Search/Download — Setup & Blocker Runbook

Status: PARTIALLY BLOCKED. Jellyfin is correctly configured for in-app subtitle
search/download via the Open Subtitles plugin, but the OpenSubtitles.com account
credentials are rejected by the provider, so the end-to-end download path cannot
be verified until Ben reconciles the account. No live mutation was required or
performed.

Host: `jester` (192.168.0.8), host Docker container `jellyfin`.
Jellyfin version: 10.11.8. Public port: 8096.

Source tasks (point-in-time self-reports): audit `t_2f3ce20c` / `t_052ca1b5`,
implementation `t_80176d97` / `t_c10673b9`, review `t_025902ee`, verification
`t_421289e8`.

## 1. Provider / plugin configured

- Plugin: `Open Subtitles` (Jellyfin.Plugin.OpenSubtitles), v24.0.0.0, installed
  under `/opt/jellyfin-config/data/plugins/Open Subtitles/`.
- Backend: OpenSubtitles.com API (`api.opensubtitles.com/api/v1/login`), NOT the
  legacy OpenSubtitles.org system.
- Auth model: username + password only. The plugin hardcodes a shared public
  consumer key (`OpenSubtitlesPlugin.ApiKey`, sent as the `Api-Key` header on
  every request) — it is not a user secret and has no editable field. The
  user-editable API-key field was removed in plugin v20 (upstream PR #132).
- Catalog reality: the official Jellyfin plugin catalog exposes exactly two
  Subtitles-category plugins — `Open Subtitles` (internet download) and
  `Subtitle Extract` (embedded-track extraction only). There is no other
  supported in-Jellyfin internet subtitle provider to install as a fallback.

## 2. Credentials (references only — no secret values)

- Account credentials live in Ben's Vaultwarden vault, folder `homelab`, item
  `OPENSUBS_CREDENTIALS` (fields: username / password). Git stores only this
  item/field reference, never values.
- The plugin persists those values in
  `/opt/jellyfin-config/data/plugins/configurations/Jellyfin.Plugin.OpenSubtitles.xml`
  (mode `0600`, owner/root only). This is standard Jellyfin plugin behavior.
- A separate Vaultwarden item `OPENSUBS_API_KEY` exists but is a consumer/API
  key (username "Jellyfin", 32-char password field), NOT account credentials.
  The Jellyfin plugin cannot consume it (no field; it hardcodes its own consumer
  key). It is not the fix for the in-app path; it may be usable by Bazarr or a
  custom integration only.

## 3. Users who can manually search/download

- Single observed Jellyfin user: `ben`, with broad admin-style permissions
  (EnableUserPreferenceAccess=1, RememberSubtitleSelections=1). This is the user
  to use for any manual search/download test.

## 4. Write access handling

- Media binds are read-write: `/mnt/pve/NAS/media/movies -> /movies:rw` and
  `/mnt/pve/NAS/media/tv -> /tv:rw`.
- Both Movies and Shows libraries have `SaveSubtitlesWithMedia=true` and
  `RequirePerfectSubtitleMatch=true`, with no disabled subtitle fetchers, so a
  downloaded subtitle is saved as a sidecar next to the media item.
- Container write probe against `/movies` and `/tv` succeeded (uid abc, mode
  2777). Note: mode 2777 (setgid world-writable) is pre-existing and a future
  hardening candidate only — not introduced by this work.

## 5. How Bazarr fits alongside

- Bazarr remains a separate automation/backfill path and was NOT made the only
  way to obtain subtitles. It runs in its own container, synced with Radarr
  (192.168.0.8:7878) and Sonarr (192.168.0.8:8989), with enabled providers
  `opensubtitlescom, embeddedsubtitles, subf2m, gestdown, subx`.
- Division of labor: Bazarr = scheduled automation/backfill; Jellyfin Open
  Subtitles plugin = manual in-app search/download. They share the same `/movies`
  and `/tv` media paths but are otherwise independent.
- See `docs/operations/subtitle-automation-runbook.md` for the Bazarr-side
  provider matrix, TV-import fix, and backfill results.

## 6. Verification results

- Jellyfin service: running, HTTP 200 on `/System/Info/Public`, server id
  `d85ae9f6b5d34e779ed6f4f7cb1991ad`.
- Open Subtitles plugin config: `CredentialsInvalid=true` with unchanged
  credential fingerprints (username len 12 / sha256 prefix `d7a7e5bd`; password
  len 11 / sha256 prefix `18fe20ab`) — identical to Vaultwarden
  `OPENSUBS_CREDENTIALS`.
- Live login re-test of the exact plugin flow returned HTTP 401
  `"Error, invalid username/password ... this password was already tried in the
  past 24 hours"` — i.e. the stored credentials are genuinely invalid at the
  provider and the account is inside the ~24h soft-lock window.
- No provider quota/search call was spent in the final verification run (the
  invalid login was already proven; repeating it is quota-burning).
- Verdict: `blocked_by_human_provider_credential`. This is a real account
  condition, not a config/compatibility gap.

## 7. Rollback notes

- No live mutation was performed across audit/implementation/review/verification:
  no Jellyfin restart, no config edit, no credential write, no media write/delete,
  no Docker recreation, no Bazarr change. Therefore no rollback is required.
- If credentials are ever edited and need reverting: restore the prior
  `/opt/jellyfin-config/data/plugins/configurations/Jellyfin.Plugin.OpenSubtitles.xml`
  (mode 0600) and restart only the `jellyfin` container if the plugin requires it.

## 8. Remaining Ben action items (blocked on human)

1. Log in at https://opensubtitles.com with the account in Vaultwarden
   `OPENSUBS_CREDENTIALS` (username "LimbicNode42").
2. Confirm it is an OpenSubtitles `.com` account, not legacy `.org`.
3. If login fails, use "forgot password" to reset it and complete any
   email/captcha/account validation.
4. Wait out the ~24h soft-lock if the provider still reports the password was
   "already tried in the past 24 hours".
5. Update Vaultwarden `OPENSUBS_CREDENTIALS` if the password changed.
6. In Jellyfin Admin Dashboard -> Plugins -> Open Subtitles, re-enter/save the
   reconciled username/password and run "Validate login" until
   `CredentialsInvalid` clears.
7. Unblock the workflow; the downstream verification task will then run a real
   Jellyfin-side subtitle search/download test using user `ben` against a Movies
   or Shows item.

## User workflow (after credentials are corrected)

1. Open Jellyfin.
2. Open a movie or episode.
3. Use the subtitle search/download action from the item's playback/details UI.
4. Select an OpenSubtitles result and download it.
5. Verify the item shows the new external subtitle track and, if saved beside
   media, the sidecar file appears under the matching `/movies` or `/tv` path.
