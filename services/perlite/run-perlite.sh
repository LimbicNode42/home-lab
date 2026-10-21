#!/usr/bin/env sh
# Perlite deploy helper for critical (192.168.0.50), which has Docker 25.0.5
# but no Docker Compose plugin. Replicates Perlite's docker-compose.yml using
# plain docker run: a PHP-FPM container (perlite) + nginx web container sharing
# the perlite filesystem via volumes_from.
#
# Equivalent to upstream compose:
#   perlite: sec77/perlite:latest, vault mounted RO at /var/www/perlite/Notes
#   web:     nginx:stable, port 80->8484, perlite.conf, volumes_from perlite
set -eu

APP_DIR=${APP_DIR:-/mnt/nas/services/perlite}
VAULT_PATH=${VAULT_PATH:-/mnt/nas/obsidian/vault}
PUBLISH_PORT=${PERLITE_PORT:-8484}
CONTAINER_APP=perlite
CONTAINER_WEB=perlite_web
NETWORK=perlite-net

# Vault MUST exist before start (even empty) so the mount is a real dir.
test -d "$VAULT_PATH" || { echo "vault path missing: $VAULT_PATH" >&2; exit 1; }

cd "$APP_DIR"

# Shared bridge so nginx can resolve "perlite" (fastcgi_pass) by name.
# With Docker Compose this is implicit; with plain docker run it is not.
docker network create "$NETWORK" >/dev/null 2>&1 || true

# --- PHP-FPM app container ---
docker rm -f "$CONTAINER_APP" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_APP" \
  --restart unless-stopped \
  --network "$NETWORK" \
  -e NOTES_PATH=Notes \
  -e VAULT_NAME="${PERLITE_VAULT_NAME:-Ben Vault}" \
  -e SITE_TITLE="${PERLITE_TITLE:-Notes}" \
  -e HOME_FILE=README \
  -e HIDE_FOLDERS= \
  -v "$VAULT_PATH:/var/www/perlite/Notes:ro" \
  sec77/perlite:latest

# --- nginx web container, shares perlite FS ---
docker rm -f "$CONTAINER_WEB" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_WEB" \
  --restart unless-stopped \
  --network "$NETWORK" \
  -p "192.168.0.50:${PUBLISH_PORT}:80" \
  -v "$APP_DIR/web/config/perlite.conf:/etc/nginx/conf.d/default.conf:ro" \
  --volumes-from "$CONTAINER_APP" \
  nginx:stable

echo "Perlite up: http://192.168.0.50:${PUBLISH_PORT}  (vault=$VAULT_PATH)"