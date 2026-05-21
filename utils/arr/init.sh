mkdir -p /mnt/nas/services/sonarr/config
mkdir -p /mnt/nas/services/radarr/config
mkdir -p /mnt/nas/services/prowlarr/config
mkdir -p /mnt/nas/media/downloads

sudo docker run -d --name=sonarr --restart unless-stopped \
  -e PUID=1001 \
  -e PGID=1003 \
  -e TZ=Australia/Sydney \
  -p 8989:8989 \
  -v /opt/sonarr/config:/config \
  -v /mnt/nas/media/tv:/tv \
  -v /mnt/nas/media/downloads:/downloads \
  lscr.io/linuxserver/sonarr:4.0.13

sudo docker run -d --name=radarr --restart unless-stopped \
  -u 1001:1003 \
  -e PUID=1001 \
  -e PGID=1003 \
  -e TZ=Australia/Sydney \
  -p 8990:8989 \
  -v /opt/sonarr/config:/config \
  -v /mnt/nas/media/movies:/movies \
  -v /mnt/nas/media/downloads:/downloads \
  lscr.io/linuxserver/radarr:latest

sudo docker run -d --name=prowlarr --restart unless-stopped \
  -u 1001:1003 \
  -e PUID=1001 \
  -e PGID=1003 \
  -e TZ=Australia/Sydney \
  -p 9696:9696 \
  -v /mnt/nas/services/prowlarr/config:/config \
  lscr.io/linuxserver/prowlarr:latest

sudo docker run -d --name=flaresolverr --restart unless-stopped \
  -p 8191:8191 \
  -e LOG_LEVEL=info \
  ghcr.io/flaresolverr/flaresolverr:latest

sudo docker run -d --name=bazarr --restart unless-stopped \
  -u 1001:1003 \
  -e PUID=1001 \
  -e PGID=1003 \
  -e TZ=Australia/Sydney \
  -p 6767:6767 \
  -v /opt/bazarr/config:/config \
  -v /mnt/nas/media/movies:/movies \
  -v /mnt/nas/media/tv:/tv \
  lscr.io/linuxserver/bazarr:latest
