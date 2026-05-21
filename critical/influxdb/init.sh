mkdir -p /mnt/nas/services/influxdb/data
mkdir -p /mnt/nas/services/influxdb/config

sudo docker run -d --name influx --restart unless-stopped \
    -u 1001:1003 \
    -p 8086:8086 \
    -e DOCKER_INFLUXDB_INIT_MODE=setup \
    -e DOCKER_INFLUXDB_INIT_USERNAME=influx \
    -e DOCKER_INFLUXDB_INIT_PASSWORD=<placeholder> \
    -e DOCKER_INFLUXDB_INIT_ORG=proxmox \
    -e DOCKER_INFLUXDB_INIT_BUCKET=proxmox \
    -e DOCKER_INFLUXDB_INIT_RETENTION=52w \
    -e DOCKER_INFLUXDB_INIT_ADMIN_TOKEN=<placeholder> \
    -v /mnt/nas/services/influxdb/data:/var/lib/influxdb2 \
    -v /mnt/nas/services/influxdb/config:/etc/influxdb2 \
    influxdb:2
