#!/bin/sh
mkdir -p /mnt/nas/services/keycloak/data
mkdir -p /mnt/nas/services/keycloak/certs

# Exit sa
su

mkdir -p /srv/keycloak/data
sudo chmod -R 770 /srv/keycloak/data
sudo chown -R 1000:1000 /srv/keycloak/data
mkdir -p /srv/keycloak/certs

openssl genpkey -algorithm RSA -out keycloak.key
openssl req -new -key keycloak.key -out keycloak.csr -subj "/CN=keycloak" \
    -addext "subjectAltName = DNS:localhost, IP:127.0.0.1, DNS:keycloak, DNS:keycloak.wheeler-network.com, IP:192.168.0.50"
openssl x509 -req -in keycloak.csr -signkey keycloak.key -out keycloak.crt -days 3650 \
    -extfile <(echo "subjectAltName = DNS:localhost, IP:127.0.0.1, DNS:keycloak, DNS:keycloak.wheeler-network.com, IP:192.168.0.50")
openssl pkcs12 -export -in keycloak.crt -inkey keycloak.key -name keycloak -out keycloak.p12

cp -r ./ /srv/keycloak/certs/

sudo chmod -R 770 /srv/keycloak/certs
sudo chown -R 1000:1000 /srv/keycloak/certs

sudo echo "export KEYCLOAK_HOST=$(infisical secrets get --env prod --path /keycloak KEYCLOAK_HOST --plain --silent)" >> .env
sudo echo "export HTTPS_KEYSTORE_PASS=$(infisical secrets get --env prod --path /keycloak HTTPS_KEYSTORE_PASS --plain --silent)" >> .env
sudo echo "export PG_HOST=$(infisical secrets get --env prod --path /postgres PG_HOST --plain --silent)" >> .env
sudo echo "export PG_KEYCLOAK_USER=$(infisical secrets get --env prod --path /postgres PG_KEYCLOAK_USER --plain --silent)" >> .env
sudo echo "export PG_KEYCLOAK_PASS=$(infisical secrets get --env prod --path /postgres PG_KEYCLOAK_PASS --plain --silent)" >> .env
sudo echo "export PG_MASTER_USER=$(infisical secrets get --env prod --path /postgres PG_MASTER_USER --plain --silent)" >> .env
sudo echo "export PG_MASTER_PASS=$(infisical secrets get --env prod --path /postgres PG_MASTER_PASS --plain --silent)" >> .env
sudo echo "export RSYNC_PASS=$(infisical secrets get --env prod --path /omv RSYNC_PASS --plain --silent)" >> .env
sudo echo "export OMV_HOST=$(infisical secrets get --env prod --path /omv OMV_HOST --plain --silent)" >> .env
source .env

sudo docker run -d --name keycloak --restart unless-stopped \
    -p 8082:8080 \
    -e KC_HOSTNAME=https://keycloak.wheeler-network.com \
    -e KC_HOSTNAME_ADMIN=https://keycloak.wheeler-network.com \
    -e KC_HOSTNAME_DEBUG=true \
    -e KC_HTTP_ENABLED=true \
    -e KC_PROXY_HEADERS=xforwarded \
    -e KC_DB_URL="jdbc:postgresql://192.168.0.50:5432/keycloak?sslmode=verify-full&sslrootcert=/opt/keycloak/certs/postgres.crt" \
    -e KC_DB=postgres \
    -e KC_DB_URL_HOST=192.168.0.50 \
    -e KC_DB_URL_DATABASE=keycloak \
    -e KC_DB_USERNAME=<placeholder> \
    -e KC_DB_PASSWORD=<placeholder> \
    -v /srv/keycloak/data:/opt/keycloak/data \
    -v /srv/keycloak/certs:/opt/keycloak/certs \
    -v /mnt/nas/services/postgres/certs/postgres.crt:/opt/keycloak/certs/postgres.crt \
    quay.io/keycloak/keycloak:latest start --verbose

sudo docker exec -it keycloak /opt/keycloak/bin/kc.sh bootstrap-admin user

echo $RSYNC_PASS > /etc/rsync_pass
sudo chmod 600 /etc/rsync_pass

crontab -e

# Add 
0 12 0 0 0 rsync -rd --password-file=/etc/rsync_pass  /srv/keycloak rsync://rsync@$OMV_HOST:873/Alpine

#
# After Accessing UI
#
# 1. Create admin user in master realm
# 2. Delete bootstrap admin user
# 3. Create Terraform Client as per https://registry.terraform.io/providers/keycloak/keycloak/latest/docs
# 4. Grant admin to Terraform Client service account