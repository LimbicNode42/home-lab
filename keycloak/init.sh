#!/bin/sh
mkdir -p /mnt/nas/services/keycloak/data
mkdir -p /mnt/nas/services/keycloak/certs

# Exit sa
su

mkdir -p /srv/keycloak/data
sudo chmod -R 770 /srv/keycloak/data
sudo chown -R 1000:1000 /srv/keycloak/data
mkdir -p /srv/keycloak/certs

openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout keycloak.key -out keycloak.crt

openssl pkcs12 -export -in keycloak.crt -inkey keycloak.key -name keycloak -out keycloak.p12

cp -r ./ /srv/keycloak/certs/

sudo chmod -R 770 /srv/keycloak/certs
sudo chown -R 1000:1000 /srv/keycloak/certs

echo "export KEYCLOAK_HOST=$(infisical secrets get --env prod --path /keycloak KEYCLOAK_HOST --plain --silent)" >> .env
echo "export HTTPS_KEYSTORE_PASS=$(infisical secrets get --env prod --path /keycloak HTTPS_KEYSTORE_PASS --plain --silent)" >> .env
echo "export PG_HOST=$(infisical secrets get --env prod --path /postgres PG_HOST --plain --silent)" >> .env
echo "export PG_KEYCLOAK_USER=$(infisical secrets get --env prod --path /postgres PG_KEYCLOAK_USER --plain --silent)" >> .env
echo "export PG_KEYCLOAK_PASS=$(infisical secrets get --env prod --path /postgres PG_KEYCLOAK_PASS --plain --silent)" >> .env
echo "export RSYNC_PASS=$(infisical secrets get --env prod --path /omv RSYNC_PASS --plain --silent)" >> .env
echo "export OMV_HOST=$(infisical secrets get --env prod --path /omv OMV_HOST --plain --silent)" >> .env
source .env

docker pull quay.io/keycloak/keycloak:latest

docker run -d --name keycloak \
    -p 8443:8443 \
    -e KC_HOSTNAME=$KEYCLOAK_HOST \
    -e KC_HTTPS_KEY_STORE_FILE=/opt/keycloak/certs/keycloak.p12 \
    -e KC_HTTPS_KEY_STORE_PASSWORD=$HTTPS_KEYSTORE_PASS \
    -e KC_DB=postgres \
    -e KC_DB_URL_HOST=$PG_HOST \
    -e KC_DB_URL_DATABASE=keycloak \
    -e KC_DB_USERNAME=$PG_KEYCLOAK_USER \
    -e KC_DB_PASSWORD=$PG_KEYCLOAK_PASS \
    -v /srv/keycloak/data:/opt/keycloak/data \
    -v /srv/keycloak/certs:/opt/keycloak/certs \
    quay.io/keycloak/keycloak:latest start

docker exec -it keycloak /opt/keycloak/bin/kc.sh bootstrap-admin user

docker update --restart unless-stopped keycloak

echo $RSYNC_PASS > /etc/rsync_pass
sudo chmod 600 /etc/rsync_pass

crontab -e

# Add 
0 12 0 0 0 rsync -rdog --password-file=/etc/rsync_pass  /srv/keycloak rsync://rsync@$OMV_HOST:873/Alpine

#
# After Accessing UI
#
# 1. Create admin user in master realm
# 2. Delete bootstrap admin user
# 3. Create Terraform Client as per https://registry.terraform.io/providers/keycloak/keycloak/latest/docs
# 4. Grant admin to Terraform Client service account