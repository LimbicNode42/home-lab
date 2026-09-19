# Jellyfin In-App Subtitle Search/Download — Setup & Blocker Runbook

Status: PARTIALLY BLOCKED. Jellyfin is correctly configured for in-app subtitle
search/download via the Open Subtitles plugin, but the OpenSubtitles.com account
credentials are rejected by the provider, so the end-to-end download path cannot
be verified until Ben reconciles the account. No live mutation was required or
performed.

Host: `jester` (192.168.0.8), host Docker container `jellyfin`.
Jellyfin version: 10.11.8. Public port: 8096.

Source tasks (point-in-time self-reports): audit `t_2f3ce20c` / `t_052ca1b5`,
implementation `t_80176d97` / `t_c10673b9`, dashboard `t_6a4b4b24`, review
`t_025902ee`, verification `t_e48f28ac`.

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
  key reference, NOT account credentials. The Jellyfin plugin cannot consume it
  (no field; it hardcodes its own consumer key). It is not the fix for the
  in-app path; it may be usable by Bazarr or a custom integration only.

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

Latest Jellyfin-side verification (`t_e48f28ac`, 2026-09-19) used Jellyfin user
`ben` against movie `Pain & Gain` and did not use Bazarr as acceptance evidence.

- Jellyfin service: running, HTTP 200 on `/System/Info/Public`, server id
  `d85ae9f6b5d34e779ed6f4f7cb1991ad`.
- Open Subtitles plugin config: `CredentialsInvalid=true`. Redacted local
  verification confirmed that the Jellyfin plugin credential fields were
  populated from Vaultwarden item `OPENSUBS_CREDENTIALS`; Git stores only the
  folder/item/field reference, not account values or credential fingerprints.
- Search path works: `GET /Items/312b6d0fc5ff5cfe8827672a55901c82/RemoteSearch/Subtitles/eng`
  returned HTTP 200 and 16 Open Subtitles results for `Pain & Gain`; the first
  result was an English SRT hash match.
- Download path is still blocked: `POST /Items/312b6d0fc5ff5cfe8827672a55901c82/RemoteSearch/Subtitles/<subtitleId>`
  returned HTTP 204 to the client, but Jellyfin logged
  `System.Security.Authentication.AuthenticationException: Unable to login`.
- Post-download checks found no new/recent subtitle sidecar on disk and Jellyfin
  item metadata still reported zero external subtitle streams for the tested item.
- Verdict: `blocked_by_opensubtitles_account_authentication`. In-app search is
  available; in-app download is blocked by the OpenSubtitles.com account/login
  condition, not by Bazarr, media path permissions, or a missing Jellyfin plugin.

## 7. Dashboard status

The Home Dashboard media subtitle capability panel (from `t_6a4b4b24`) is the
operator-facing status surface for this workflow. Read it as follows:

- `degraded` / blocked Jellyfin in-app subtitle status means Jellyfin itself is
  reachable but Open Subtitles download is not currently usable.
- The panel should show Open Subtitles as the Jellyfin provider, include audit
  freshness, and identify the next action as reconciling `OPENSUBS_CREDENTIALS`
  / clearing `CredentialsInvalid`.
- Bazarr should appear as healthy automation/backfill if it is still running; it
  does not prove that the Jellyfin in-app manual path works.
- Treat service reachability alone (`Jellyfin up`) as insufficient. The acceptance
  signal is a successful Jellyfin-side subtitle search plus download that creates
  a visible external subtitle track/sidecar.

## 8. Rollback notes

- No live mutation was performed across audit/implementation/review/verification:
  no Jellyfin restart, no config edit, no credential write, no media write/delete,
  no Docker recreation, no Bazarr change. Therefore no rollback is required.
- If credentials are ever edited and need reverting: restore the prior
  `/opt/jellyfin-config/data/plugins/configurations/Jellyfin.Plugin.OpenSubtitles.xml`
  (mode 0600) and restart only the `jellyfin` container if the plugin requires it.

## 9. Remaining Ben action items (blocked on human)

1. Log in at https://opensubtitles.com with the account referenced by
   Vaultwarden folder `homelab`, item `OPENSUBS_CREDENTIALS`, field `username`,
   using the corresponding `password` field from that same item.
2. Confirm it is an OpenSubtitles `.com` account, not legacy `.org`.
3. If login fails, use "forgot password" to reset it and complete any
   email/captcha/account validation.
4. Wait out the ~24h soft-lock if the provider still reports the password was
   "already tried in the past 24 hours".
5. Update Vaultwarden item `OPENSUBS_CREDENTIALS` if the username or password
   changed.
6. In Jellyfin Admin Dashboard -> Plugins -> Open Subtitles, re-enter/save the
   reconciled username/password and run "Validate login" until
   `CredentialsInvalid` clears.
7. Re-run Jellyfin-side verification: search should still return results, download
   should complete without the `Unable to login` log error, and Jellyfin should
   show the downloaded external subtitle track.

## 10. Ben user workflow

Until the credential blocker is resolved, Ben can search but should expect download
to fail. After credentials are corrected:

1. Open Jellyfin as user `ben`.
2. Open a movie or episode details page, or start playback and open subtitle
   options.
3. Use the subtitle search/download action. In Jellyfin API terms, this is the
   `RemoteSearch/Subtitles/<language>` path using the Open Subtitles provider.
4. Pick an Open Subtitles result, preferably a hash match / correct release, and
   download it.
5. Confirm Jellyfin shows the new external subtitle track. If `SaveSubtitlesWithMedia`
   remains enabled, the subtitle should also exist as a sidecar file under the
   matching `/movies` or `/tv` path.
