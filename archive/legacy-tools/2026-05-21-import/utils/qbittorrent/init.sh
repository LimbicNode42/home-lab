mkdir -p /mnt/nas/services/qbittorrent/appdata

sudo docker run -d --name=torrent --restart unless-stopped \
  -u 1001:1003 \
  -e PUID=1001 \
  -e PGID=1003 \
  -e TZ=Australia/Sydney \
  -e WEBUI_PORT=8081 \
  -e TORRENTING_PORT=6881 \
  -p 8081:8081 \
  -p 6881:6881 \
  -p 6881:6881/udp \
  -v /mnt/nas/services/qbittorrent/appdata:/config \
  -v /mnt/nas/media/downloads:/downloads \
  lscr.io/linuxserver/qbittorrent:latest