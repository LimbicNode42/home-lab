
sudo docker stop db-mcp-server && sudo docker rm db-mcp-server && \
sudo docker pull limbicnode42/db-mcp-server:latest && \
sudo docker run -d --name db-mcp-server --restart unless-stopped \
  -p 8000:8000 \
  -e HOST=0.0.0.0 \
  -e ENABLE_POSTGRES=true \
  -e ENABLE_REDIS=true \
  -e ENABLE_MONGODB=true \
  -e ENABLE_INFLUXDB=true \
  -e POSTGRES_HOST=192.168.0.50 \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_USER=$PG_MASTER_USER \
  -e POSTGRES_PASSWORD=$PG_MASTER_PASS \
  -e POSTGRES_DB=postgres \
  -e REDIS_HOST=192.168.0.50 \
  -e REDIS_PORT=6379 \
  -e REDIS_DB=0 \
  -e MONGODB_HOST=192.168.0.50 \
  -e MONGODB_PORT=27017 \
  -e MONGODB_USER=$MONGO_USER \
  -e MONGODB_PASSWORD=$MONGO_PASS \
  -e MONGODB_DB=admin \
  -e INFLUXDB_HOST=192.168.0.50 \
  -e INFLUXDB_PORT=8086 \
  -e INFLUXDB_TOKEN=$INFLUXDB_TOKEN \
  -e INFLUXDB_ORG=proxmox \
  -e INFLUXDB_BUCKET=proxmox \
  -e API_KEY=temp-db-mcp-server-api-key \
  limbicnode42/db-mcp-server:latest

sudo docker stop auth-mcp-server && sudo docker rm auth-mcp-server && \
sudo docker pull limbicnode42/auth-mcp-server:latest && \
sudo docker run -d --name auth-mcp-server --restart unless-stopped \
  -p 8001:8000 \
  -e HOST=0.0.0.0 \
  -e KEYCLOAK_URL=https://keycloak.wheeler-network.com \
  -e KEYCLOAK_USERNAME=$KEYCLOAK_USER \
  -e KEYCLOAK_PASSWORD=$KEYCLOAK_PASS \
  -e INFISICAL_URL=https://infisical.wheeler-network.com \
  -e INFISICAL_CLIENT_ID=$INFISICAL_CLIENT_ID \
  -e INFISICAL_CLIENT_SECRET=$INFISICAL_CLIENT_SECRET \
  -e INFISICAL_TOKEN=$INFISICAL_TOKEN \
  -e INFISICAL_ORG_ID=$INFISICAL_ORG_ID \
  -e INFISICAL_PROJECT_ID=$INFISICAL_PROJECT_ID \
  -e INFISICAL_ENVIRONMENT_SLUG=$INFISICAL_ENVIRONMENT_SLUG \
  -e KEYCLOAK_INFISICAL_INTEGRATION_ENABLED=true \
  -e API_KEY=temp-auth-mcp-server-api-key \
  limbicnode42/auth-mcp-server:latest

sudo docker run -d --name github-mcp-server --restart unless-stopped \
  -e GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PERSONAL_ACCESS_TOKEN \
  -e GITHUB_TOOLSETS="all" \
  ghcr.io/github/github-mcp-server

# MetaMCP
su - sa
mkdir -p /home/sa/mcp
cd /home/sa/mcp
git clone https://github.com/metatool-ai/metamcp.git
cd metamcp
cp example.env .env
openssl rand -hex 32 | base64 # YjVhMmY0Y2I0ODgzODMzZTM5MjI5NTk1YWUwZGU0YjhhMTA2Njg3ZDQ0YTFmMTBiM2RiOGJjMDIwNDk5N2VlMQo=
docker compose up -d