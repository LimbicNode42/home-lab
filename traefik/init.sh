#!/bin/sh

sudo docker run -d \
 --name=traefik \
 -p 80:80 \
 -p 443:443 \
 -p 8080:8080 \
 -v /var/run/docker.sock:/var/run/docker.sock \
 -v /home/traefik/traefik.toml:/traefik.toml \
 -v /home/traefik/dynamic-config.toml:/dynamic-config.toml \
 -v /home/traefik/acme.json:/acme.json \
 --restart unless-stopped \
 -e CF_API_EMAIL="placeholder" \
 -e CF_DNS_API_TOKEN=$CF_DNS_API_TOKEN \
 traefik:v2.5

sudo docker update --restart unless-stopped traefik
