mkdir -p /mnt/nas/services/grafana/data

sudo docker run -d --name=grafana --restart unless-stopped \
  -u 1001:1003 \
  -p 3002:3000 \
  -v /mnt/nas/services/grafana/data:/var/lib/grafana \
  grafana/grafana-oss