#!/bin/sh
mkdir -p /mnt/nas/stuffs/db/mongo/data
chmod -R 770 /mnt/nas/stuffs/db/mongo/data
chown -R 1000:1000 /mnt/nas/stuffs/db/mongo/data

mkdir -p /mnt/nas/stuffs/db/mongo/config
chmod -R 770 /mnt/nas/stuffs/db/mongo/config
chown -R 1000:1000 /mnt/nas/stuffs/db/mongo/config

docker pull mongo:4.4.18

docker run -d \
  --name mongodb \
  -p 27017:27017 \
  -v /mnt/nas/stuffs/db/mongo/data:/data/db \
  -v /mnt/nas/stuffs/db/mongo/config/mongod.conf:/etc/mongod.conf \
  mongo:4.4.18 --config /etc/mongod.conf


docker update --restart unless-stopped mongodb
