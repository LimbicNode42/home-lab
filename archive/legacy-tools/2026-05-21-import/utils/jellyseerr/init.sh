mkdir -p /mnt/nas/services/jellyseerr/appdata/config

sudo docker run -d --name jellyseerr --restart unless-stopped \
  -u 1001:1003 \
  -p 5055:5055 \
  -e LOG_LEVEL=debug \
  -e TZ=Australia/Sydney \
  -v /mnt/nas/services/jellyseerr/appdata/config:/app/config \
  ghcr.io/fallenbagel/jellyseerr