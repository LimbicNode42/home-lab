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

Recovery note, 2026-05-22:

OpenClaw had left the live Traefik container running from CLI flags instead of `/traefik.toml`, and `/mnt/nas/services/traefik/dynamic-config.yaml` was missing. Hermes restored `dynamic-config.yaml`, corrected the dashboard upstream from HTTPS to HTTP, and recreated `proxy` with `--configFile=/traefik.toml`.

Known follow-up:

- `cluster.wheeler-network.com` was still disabled in Traefik v2.5 after restoration because `serversTransport` lookup failed. The dynamic config in this directory uses `http.serversTransports`, which is the desired shape; verify against the running Traefik version before relying on the cluster route.
- The recreated container did not inherit a Cloudflare DNS token from the broken old container, so ACME/cert renewal may need the token restored from Vaultwarden and the container recreated/reloaded.
