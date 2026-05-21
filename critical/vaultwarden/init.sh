su - sa

mkdir -p /mnt/nas/services/vaultwarden/data

sudo chown -R 1001:1003 /mnt/nas/services/vaultwarden/data
sudo chmod -R 700 /mnt/nas/services/vaultwarden/data

sudo docker run --detach --name vaultwarden --restart unless-stopped \
  -u 1001:1003 \
  -p 8084:80 \
  -e DOMAIN="https://vault.wheeler-network.com" \
  -e DATABASE_URL="postgresql://$PG_MASTER_USER:$PG_MASTER_PASS@192.168.0.50:5432/vaultwarden?sslmode=verify-full&sslrootcert=/opt/postgres/certs/postgres.crt" \
  -v /mnt/nas/services/vaultwarden/data/:/data/ \
  -v /mnt/nas/services/postgres/certs/postgres.crt:/opt/postgres/certs/postgres.crt \
  vaultwarden/server:latest

sudo docker run --detach --name vaultwarden --restart unless-stopped \
  -u 1001:1003 \
  -p 8084:80 \
  -e DOMAIN="https://vault.wheeler-network.com" \
  -e DATABASE_URL="postgresql://$PG_MASTER_USER:$PG_MASTER_PASS@192.168.0.50:5432/vaultwarden?sslmode=disable" \
  -v /mnt/nas/services/vaultwarden/data/:/data/ \
  vaultwarden/server:latest