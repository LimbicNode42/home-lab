# Traefik service

Traefik runs in the `critical` LXC at `192.168.0.50` as Docker container `proxy`.

Live config path:

- `/mnt/nas/services/traefik/traefik.toml`
- `/mnt/nas/services/traefik/dynamic-config.yaml`
- `/mnt/nas/services/traefik/acme.json`

The container must be started with the file config explicitly:

```sh
docker run -d --name=proxy --restart unless-stopped \
  -p 80:80 \
  -p 443:443 \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /mnt/nas/services/traefik/traefik.toml:/traefik.toml \
  -v /mnt/nas/services/traefik/dynamic-config.yaml:/dynamic-config.yaml \
  -v /mnt/nas/services/traefik/acme.json:/acme.json \
  --env-file /path/to/local/traefik.env \
  traefik:v2.5 --configFile=/traefik.toml
```

Secrets are not stored in Git. Required secret refs:

- Vaultwarden folder: `homelab`
- Item: `cloudflare/dns-api-token`
- Field: `CF_DNS_API_TOKEN`

Cloudflare Tunnel routing note:

The Cloudflare Zero Trust tunnel publishes `vault.wheeler-network.com` to the local origin `http://192.168.0.50:80`, so the Vaultwarden router must be bound to Traefik's `web` entrypoint. Binding Vaultwarden only to `websecure` makes direct HTTPS-to-Traefik tests work, but tunnel traffic returns Traefik's default 404.

Dashboard ingress note:

The dashboard app trusts Cloudflare Access identity headers, so its router must not accept arbitrary LAN clients that can forge `cf-access-*` headers. The intended shape is:

- `personal-dashboard` publishes `4322` on the Docker bridge host gateway (`172.17.0.1`) only.
- Traefik reaches it from the `proxy` container via the Docker host gateway, `http://172.17.0.1:4322`.
- The `dashboard` router uses the `dashboard-cloudflared-only` `ipWhiteList` middleware to allow only Docker-network source ranges (`172.16.0.0/12`), where the `cloudflare`/cloudflared container is the expected caller.

This closes both LAN bypasses: direct `192.168.0.50:4322` is no longer published, and Host-header requests to Traefik from `192.168.0.0/24` do not reach the dashboard router.

Recovery note, 2026-05-22:

OpenClaw had left the live Traefik container running from CLI flags instead of `/traefik.toml`, and `/mnt/nas/services/traefik/dynamic-config.yaml` was missing. Hermes restored `dynamic-config.yaml`, corrected the dashboard upstream from HTTPS to HTTP, and recreated `proxy` with `--configFile=/traefik.toml`.

Operational note: the live config is on the NAS bind mount. Traefik v2.5 did not always auto-reload a changed `dynamic-config.yaml` from that mount via the file provider watcher; if the API/dashboard still shows stale routers after copying a config change, restart only the `proxy` container and re-check `/api/http/routers`.

Known follow-up:

- `cluster.wheeler-network.com` was still disabled in Traefik v2.5 after restoration because `serversTransport` lookup failed. The dynamic config in this directory uses `http.serversTransports`, which is the desired shape; verify against the running Traefik version before relying on the cluster route.
- The recreated container did not inherit a Cloudflare DNS token from the broken old container, so ACME/cert renewal may need the token restored from Vaultwarden and the container recreated/reloaded.
