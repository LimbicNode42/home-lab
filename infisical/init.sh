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
    -p 8080:8080  \
    -e ENCRYPTION_KEY=$(cat ./encryption_key) \
    -e AUTH_SECRET=$(cat ./auth_secret) \
    -e DB_CONNECTION_URI="postgresql://$PG_INFISICAL_USER:$PG_INFISICAL_PASS@$PG_HOST:5432/infisical?sslmode=verify-full&sslrootcert=/opt/infisical/certs/postgres.crt" \
    -e REDIS_URL="redis://$REDIS_HOST:6379" \
    -e SITE_URL="$INF_URL" \
    -v /mnt/nas/services/postgres/certs/postgres.crt:/opt/infisical/certs/postgres.crt \
    infisical/infisical:v0.106.0-postgres

# TODO: need to sleep or add readiness probe before this command
infisical secrets set --env prod --path /infisical ENCRYPTION_KEY=$(cat ./encryption_key) AUTH_SECRET=$(cat ./auth_secret)

# MANUAL
# Login and create terraform-oidc identity
# Add details to local machine env vars prefixed with 'TF_VAR_'
