#!/bin/sh
mkdir -p /mnt/nas/services/infisical/config

sudo openssl rand -hex 16 > encryption_key
cp encryption_key /mnt/nas/services/infisical/config/

sudo openssl rand -base64 32 > auth_secret
cp auth_secret /mnt/nas/services/infisical/config/

echo "export PG_HOST=$(infisical secrets get --env prod --path /postgres PG_HOST --plain --silent)" >> .env
echo "export PG_INFISICAL_USER=$(infisical secrets get --env prod --path /postgres PG_INFISICAL_USER --plain --silent)" >> .env
echo "export PG_INFISICAL_PASS=$(infisical secrets get --env prod --path /postgres PG_INFISICAL_PASS --plain --silent)" >> .env
echo "export REDIS_HOST=$(infisical secrets get --env prod --path /redis REDIS_HOST --plain --silent)" >> .env
echo "export INF_URL=$(infisical secrets get --env prod --path /infisical INF_URL --plain --silent)" >> .env
source .env

sudo docker pull infisical/infisical:v0.106.0-postgres

sudo docker run --env DB_CONNECTION_URI=postgresql://$PG_INFISICAL_USER:$PG_INFISICAL_PASS@$PG_HOST:5432/infisical infisical/infisical:v0.106.0-postgres npm run migration:latest

sudo docker run -d --name infisical --restart unless-stopped \
    -u 1001:1003 \
    -p 8083:8080  \
    -e ENCRYPTION_KEY=<placeholder> \
    -e AUTH_SECRET=<placeholder> \
    -e DB_CONNECTION_URI="postgresql://<placeholder>:<placeholder>@192.168.0.50:5432/infisical?sslmode=verify-full&sslrootcert=/opt/infisical/certs/postgres.crt" \
    -e REDIS_URL="redis://192.168.0.50:6379" \
    -e SITE_URL="infisical.wheeler-network.com" \
    -e INF_APP_CONNECTION_GITHUB_APP_CLIENT_ID="<placeholder>" \
    -e INF_APP_CONNECTION_GITHUB_APP_CLIENT_SECRET="<placeholder>" \
    -e INF_APP_CONNECTION_GITHUB_APP_SLUG="infisical-oauth" \
    -e INF_APP_CONNECTION_GITHUB_APP_ID="<placeholder>" \
    -e INF_APP_CONNECTION_GITHUB_APP_PRIVATE_KEY="<placeholder>" \
    -v /mnt/nas/services/postgres/certs/postgres.crt:/opt/infisical/certs/postgres.crt \
    infisical/infisical:v0.106.0-postgres

# TODO: need to sleep or add readiness probe before this command
infisical secrets set --env prod --path /infisical ENCRYPTION_KEY=$(cat ./encryption_key) AUTH_SECRET=$(cat ./auth_secret)

# MANUAL
# Login and create terraform-oidc identity
# Add details to local machine env vars prefixed with 'TF_VAR_'
