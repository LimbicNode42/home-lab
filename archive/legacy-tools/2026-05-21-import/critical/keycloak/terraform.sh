#!/bin/bash

cat <<EOF > backend.hcl
conn_str      = "postgres://${TF_VAR_PG_MASTER_USER}:${TF_VAR_PG_MASTER_PASS}@192.168.0.50:5432/terraform?sslmode=require"
schema_name   = "keycloak"
EOF

cat <<EOF > terraform.auto.tfvars
infisical_api_url = "https://infisical.wheeler-network.com"
infisical_client_id = "$TF_VAR_INF_TF_CLIENT_ID"
infisical_client_secret = "$TF_VAR_INF_TF_CLIENT_SECRET"
postgres_conn_string = "postgres://${TF_VAR_PG_MASTER_USER}:${TF_VAR_PG_MASTER_PASS}@192.168.0.50:5432/terraform?sslmode=require"
EOF

terraform init -reconfigure -backend-config=backend.hcl
