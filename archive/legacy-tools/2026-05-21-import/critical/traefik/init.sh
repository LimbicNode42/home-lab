#!/bin/sh
echo "export CF_DNS_API_TOKEN=$(infisical secrets get --env prod --path /cf CF_DNS_API_TOKEN --plain --silent)" >> .env
source .env

mkdir -p /mnt/nas/services/traefik
nano /mnt/nas/services/traefik/traefik.toml
nano /mnt/nas/services/traefik/dynamic-config.yaml
nano /mnt/nas/services/traefik/dynamic-config.toml
nano /mnt/nas/services/traefik/acme.json

sudo docker pull traefik:v2.5

sudo docker run -d --name=proxy --restart unless-stopped \
    -p 80:80 \
    -p 443:443 \
    -p 8080:8080 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /mnt/nas/services/traefik/traefik.toml:/traefik.toml \
    -v /mnt/nas/services/traefik/dynamic-config.yaml:/dynamic-config.yaml \
    -v /mnt/nas/services/traefik/acme.json:/acme.json \
    -e CF_API_EMAIL="b.j.wheeler484@gmail.com" \
    -e CF_DNS_API_TOKEN="zWjaRf1R9SAgdoYM6V6BfQ3QzknegzSQmTzcZ27e" \
    traefik:v2.5

