#!/bin/sh
mkdir -p /mnt/nas/services/postgres/data

mkdir -p /mnt/nas/services/postgres/certs
cd /mnt/nas/services/postgres/certs

openssl genpkey -algorithm RSA -out postgres.key
openssl req -new -key postgres.key -out postgres.csr -subj "/CN=postgres" \
    -addext "subjectAltName = DNS:postgres, DNS:localhost, IP:127.0.0.1, IP:192.168.0.50"
openssl x509 -req -in postgres.csr -signkey postgres.key -out postgres.crt -days 3650 \
    -extfile <(echo "subjectAltName = DNS:postgres, DNS:localhost, IP:127.0.0.1, IP:192.168.0.50")

chmod 600 postgres.key
chmod 644 postgres.crt

sudo chown -R 1001:1003 /mnt/nas/services/postgres/data
sudo chmod -R 700 /mnt/nas/services/postgres/data

echo "export PG_MASTER_USER=$(infisical secrets get --env prod --path /postgres PG_MASTER_USER --plain --silent)" >> .env
echo "export PG_MASTER_PASS=$(infisical secrets get --env prod --path /postgres PG_MASTER_PASS --plain --silent)" >> .env
source .env

sudo docker pull postgres:latest

sudo docker run -d --name postgres --restart unless-stopped \
    -u 1001:1003 \
    -p 5432:5432 \
    -e POSTGRES_USER=$PG_MASTER_USER \
    -e POSTGRES_PASSWORD=$PG_MASTER_PASS \
    -v /mnt/nas/services/postgres/data:/var/lib/postgresql/data \
    -v /mnt/nas/services/postgres/certs:/var/lib/postgresql/certs \
    postgres:latest \
    -c ssl=on \
    -c ssl_cert_file=/var/lib/postgresql/certs/postgres.crt \
    -c ssl_key_file=/var/lib/postgresql/certs/postgres.key

    # Could be added for tighter security
    # Requires sharing public key with clients
    # -c ssl_ciphers='HIGH:!aNULL:!MD5' \
    # -c ssl_prefer_server_ciphers=on

docker run -d --name postgres \
    --restart unless-stopped \
    --platform linux/arm64 \
    -p 5432:5432 \
    -e POSTGRESQL_PASSWORD=$PG_MASTER_PASS \
    -e POSTGRESQL_POSTGRES_PASSWORD=$PG_MASTER_PASS \
    -e POSTGRESQL_TLS_ENABLED=yes \
    -e POSTGRESQL_TLS_CERT_FILE=/opt/bitnami/postgresql/certs/postgres.crt \
    -e POSTGRESQL_TLS_KEY_FILE=/opt/bitnami/postgresql/certs/postgres.key \
    -v /mnt/nas/services/postgres:/bitnami/postgresql \
    -v /mnt/nas/services/postgres/certs:/opt/bitnami/postgresql/certs \
    bitnamilegacy/postgresql:17

sudo docker exec -it postgres bash -c "sed -i 's/^host all all all scram-sha-256/hostssl all all all md5/' /var/lib/postgresql/data/pg_hba.conf"
sudo docker exec -it postgres bash -c "echo 'hostnossl all all all reject' >> /var/lib/postgresql/data/pg_hba.conf"
sudo docker exec -it postgres bash -c "cat /var/lib/postgresql/data/pg_hba.conf"

sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE terraform WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE keycloak WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE infisical WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE drone WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE vaultwarden WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE docmost WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE mcp WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE in_memoria WITH OWNER $PG_MASTER_USER ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"

mkdir -p /mnt/nas/services/qdrant/data
sudo docker run -d --name qdrant --restart unless-stopped \
    -p 6333:6333 \
    -p 6334:6334 \
    -v "/mnt/nas/services/qdrant/data:/qdrant/storage:z" \
    qdrant/qdrant
