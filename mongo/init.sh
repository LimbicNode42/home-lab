docker pull mongo:4.4.18

mkdir -p /mnt/nas/mongo/data /mnt/nas/mongo/config

docker run -d \
  --name mongodb \
  -p 27017:27017 \
  -v /mnt/nas/mongo/data:/data/db \
  -v /mnt/nas/mongo/config/mongod.conf:/etc/mongod.conf \
  mongo:4.4.18 --config /etc/mongod.conf


docker update --restart unless-stopped mongodb
