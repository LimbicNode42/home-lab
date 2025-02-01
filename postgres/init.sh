#!/bin/sh
mkdir -p /mnt/nas/services/postgres/data

sudo docker pull postgres:latest

sudo docker run -d --name postgres \
    -u 1001:1001 \
    -p 5432:5432 \
    -e POSTGRES_USER=$TF_VAR_PG_MASTER_USER \
    -e POSTGRES_PASSWORD=$TF_VAR_PG_MASTER_PASS \
    -v /mnt/nas/services/postgres/data:/var/lib/postgresql/data \
    postgres:latest

sudo docker update --restart unless-stopped postgres

sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE terraform WITH OWNER <service-dbu> ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE keycloak WITH OWNER <service-dbu> ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
sudo docker exec -it postgres psql -U postgres -c "CREATE DATABASE infisical WITH OWNER <service-dbu> ENCODING 'UTF8' LC_COLLATE='en_US.UTF-8' LC_CTYPE='en_US.UTF-8' TEMPLATE=template0;"
