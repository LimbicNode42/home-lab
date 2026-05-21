#!/bin/sh
mkdir -p /mnt/nas/services/drone
mkdir -p /mnt/nas/services/drone/data

touch rpc_secret
sudo openssl rand -hex 16 > rpc_secret
cp rpc_secret /mnt/nas/services/drone/

echo "export DRONE_GH_CLIENT_ID=$(infisical secrets get --env prod --path /drone DRONE_GH_CLIENT_ID --plain --silent)" >> .env
echo "export DRONE_GH_CLIENT_SECRET=$(infisical secrets get --env prod --path /drone DRONE_GH_CLIENT_SECRET --plain --silent)" >> .env
echo "export PG_HOST=$(infisical secrets get --env prod --path /postgres PG_HOST --plain --silent)" >> .env
echo "export PG_MASTER_USER=$(infisical secrets get --env prod --path /postgres PG_MASTER_USER --plain --silent)" >> .env
echo "export PG_MASTER_PASS=$(infisical secrets get --env prod --path /postgres PG_MASTER_PASS --plain --silent)" >> .env
source .env

# sudo docker run -d --name drone --restart unless-stopped \
#     -u 1001:1003 \
#     -p 80:80 \
#     -p 443:443 \
#     -e DRONE_GITHUB_CLIENT_ID=$DRONE_GH_CLIENT_ID \
#     -e DRONE_GITHUB_CLIENT_SECRET=$DRONE_GH_CLIENT_SECRET \
#     -e DRONE_RPC_SECRET=$(cat /home/sa/rpc_secret) \
#     -e DRONE_SERVER_HOST=ci.wheeler-network.com \
#     -e DRONE_SERVER_PROTO=https \
#     -e DRONE_DATABASE_DRIVER=postgres \
#     -e DRONE_DATABASE_DATASOURCE="postgresql://$PG_MASTER_USER:$PG_MASTER_PASS@$PG_HOST:5432/drone?sslmode=verify-full&sslrootcert=/opt/infisical/certs/postgres.crt" \
#     -e DRONE_USER_FILTER="LimbicNode42" \
#     -e DRONE_USER_CREATE=username:LimbicNode42,admin:true \
#     -e DRONE_REGISTRATION_CLOSED=true \
#     -e DRONE_LOGS_DEBUG=true \
#     -v /mnt/nas/services/postgres/certs/postgres.crt:/opt/infisical/certs/postgres.crt \
#     -v /mnt/nas/services/drone/data:/data \
#     drone/drone:2

###

# sudo docker run -d --name runner --restart unless-stopped \
#   -p 3000:3000 \
#   -e DRONE_RPC_PROTO=https \
#   -e DRONE_RPC_HOST=ci.wheeler-network.com \
#   -e DRONE_RPC_SECRET=$(cat /home/sa/rpc_secret) \
#   -e DRONE_RUNNER_CAPACITY=5 \
#   -e DRONE_RUNNER_NAME=gh-runner \
#   -v /var/run/docker.sock:/var/run/docker.sock \
#   drone/drone-runner-docker:1

###

mkdir -p /mnt/nas/services/repo/data
mkdir -p /mnt/nas/services/repo/config

sudo docker run --entrypoint htpasswd httpd:2 -Bbn LimbicNode42 Bengina400 > htpasswd

cp htpasswd /mnt/nas/services/repo/config/

sudo docker run -d --name repo --restart unless-stopped \
  -u 1001:1003 \
  -p 5000:5000 \
  -e REGISTRY_LOG_LEVEL=debug \
  -e REGISTRY_LOG_FORMATTER=json \
  -e REGISTRY_HTTP_HOST=https://repo.wheeler-network.com \
  -e REGISTRY_HTTP_SECRET=$(cat rpc_secret) \
  -e REGISTRY_AUTH=htpasswd \
  -e REGISTRY_AUTH_HTPASSWD_REALM="Registry Realm" \
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
  -e REGISTRY_STORAGE_DELETE_ENABLED=true \
  -v /mnt/nas/services/repo/data:/var/lib/registry \
  -v /mnt/nas/services/repo/config:/auth \
  registry:2


###

mkdir -p /mnt/nas/services/portainer/data

sudo docker run -d --name portainer --restart=always \
  -u 1001:1003 \
  -p 9000:9000 \
  -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /mnt/nas/services/portainer/data:/data \
  portainer/portainer-ce:latest