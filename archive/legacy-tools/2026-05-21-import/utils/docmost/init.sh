su - sa

mkdir -p /mnt/nas/services/docmost/appdata

sudo docker run -d --name docs --restart=unless-stopped \
  -p 3003:3000 \
  -e APP_URL="https://docs.wheeler-network.com" \
  -e APP_SECRET=$DOCMOST_APP_SECRET \
  -e DATABASE_URL="postgresql://$PG_MASTER_USER:$PG_MASTER_PASS@192.168.0.50:5432/docmost?sslmode=verify-full&sslrootcert=/opt/postgres/certs/postgres.crt" \
  -e REDIS_URL="redis://192.168.0.50:6379" \
  -v /mnt/nas/services/postgres/certs/postgres.crt:/opt/postgres/certs/postgres.crt \
  -v /mnt/nas/services/docmost/appdata:/app/data/storage \
  docmost/docmost:latest