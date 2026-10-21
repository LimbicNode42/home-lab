# Perlite — Obsidian vault web viewer

LAN-only, read-only browser viewer for Ben's Obsidian vault. Perlite renders
Markdown from the vault folder — it is a *viewer*, not an editor. Content is
created in the Obsidian desktop/mobile app (synced to the vault via the
`obsidian-livesync` CouchDB backend); Perlite just displays whatever `.md`
files are present.

## Status

- **Live:** yes (scaffolded empty; vault currently has no notes)
- **Host:** critical (192.168.0.50), Docker 25.0.5 (no Compose plugin)
- **URL:** http://192.168.0.50:8484 (LAN-only, no Traefik route, no auth)
- **Vault mount:** `/mnt/nas/obsidian/vault` → read-only at `/var/www/perlite/Notes`

## Architecture

Two containers, replicating upstream `docker-compose.yml` with plain `docker run`
(critical has no Compose plugin; see `run-perlite.sh`):

| Container    | Image              | Role                                    |
|--------------|--------------------|-----------------------------------------|
| `perlite`    | `sec77/perlite`    | PHP-FPM; Perlite code baked into image  |
| `perlite_web`| `nginx:stable`     | nginx, serves on `192.168.0.50:8484`    |

They share a bridge network `perlite-net` so nginx resolves `fastcgi_pass
perlite:9000` by name — this is implicit in Compose but NOT with plain `docker run`.

## Deploy / recreate

```sh
/mnt/nas/services/perlite/run-perlite.sh
```

The script is idempotent (recreates both containers, reuses the network).

## Config

- `.env` — vault path, site title, display settings. Git-ignored (see `.env.example`).
- `web/config/perlite.conf` — nginx server block (copied from upstream; blocks
  direct `.md`/`.json` access, exposes only via PHP).

## Files

- `run-perlite.sh` — plain-docker deploy helper
- `web/config/perlite.conf` — nginx config
- `.env.example` — config template (no secrets)

## References

- Upstream: https://github.com/secure-77/Perlite
- Note: Perlite's `NOTES_PATH` points at the host vault dir; the container sees it
  as `/var/www/perlite/Notes` (set `NOTES_PATH=Notes` inside the container).