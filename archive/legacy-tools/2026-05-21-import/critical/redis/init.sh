#!/bin/sh
mkdir -p /mnt/nas/services/redis/data

sudo docker pull redis/redis-stack:latest

sudo docker run -d --name redis --restart unless-stopped \
  -u 1001:1003 \
  -p 6379:6379 \
  -v /mnt/nas/services/redis/data:/data \
  -e REDIS_ARGS="--appendonly yes --bind 0.0.0.0 --protected-mode no" \
  redis/redis-stack-server:latest

# LOCAL TEST
sudo docker exec -it redis redis-cli -h <node-ip> -p 6379 ping

# REMOTE TEST
redis-cli -h 192.168.0.111 -p 6379 ping