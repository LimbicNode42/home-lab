#!/bin/sh
mkdir -p /mnt/nas/services/mongo/data
chmod -R 770 /mnt/nas/services/mongo/data
# sudo chown -R 1000:1000 /mnt/nas/services/mongo/data

mkdir -p /mnt/nas/services/mongo/config
chmod -R 770 /mnt/nas/services/mongo/config
# chown -R 1000:1000 /mnt/nas/services/mongo/config

sudo docker run -d --name mongodb --restart unless-stopped \
  -u 1001:1003 \
  -p 27017:27017 \
  -v /mnt/nas/services/mongo/data:/data/db \
  -v /mnt/nas/services/mongo/config/mongod.conf:/etc/mongod.conf \
  mongo:4.4.18 --config /etc/mongod.conf

sudo docker run --name mongodb --restart unless-stopped \
  -u 1001:1003 \
  -p 27017:27017 \
  -v /mnt/nas/services/mongo/data:/data/db \
  -v /mnt/nas/services/mongo/config/mongod.conf:/etc/mongod.conf \
  mongo:4.4.18 \
  mongod --repair --config /etc/mongod.conf --dbpath /data/db