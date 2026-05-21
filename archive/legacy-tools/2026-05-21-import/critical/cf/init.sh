echo "export CF_ZT_TOKEN=$(infisical secrets get --env prod --path /cf CF_ZT_TOKEN --plain --silent)" >> .env
source .env

docker pull cloudflare/cloudflared:latest

docker run -d --name cloudflare --restart unless-stopped \
    cloudflare/cloudflared:latest tunnel \
    --no-autoupdate run \
    --token "$CF_ZT_TOKEN"