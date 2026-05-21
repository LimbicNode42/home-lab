#!/bin/bash
mkdir -p /mnt/nas/services/homarr/data

sudo openssl rand -hex 64 > encryption_key
cp ./encryption_key /mnt/nas/services/homarr/config/

sudo docker run -d --name homarr --restart unless-stopped \
  -u 1001:1003 \
  -p 7575:7575 \
  -p 6379:6379 \
  -p 3001:3001 \
  -p 2999:3000 \
  -e SECRET_ENCRYPTION_KEY=$(cat ./encryption_key) \
  -e DOCKER_HOSTNAMES="127.0.0.1,192.168.0.51,wheeler-network.com" \
  -e DOCKER_PORTS="7575,6379,3001,3000" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /mnt/nas/services/homarr/data:/appdata \
  -v /mnt/nas/services/homarr/icons:/icons \
  -d ghcr.io/homarr-labs/homarr:latest