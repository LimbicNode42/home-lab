#!/bin/bash

cat <<EOF > terraform.auto.tfvars
infisical_api_url = "$TF_VAR_INF_URL"
infisical_client_id = "$TF_VAR_INF_TF_CLIENT_ID"
infisical_client_secret = "$TF_VAR_INF_TF_CLIENT_SECRET"
EOF

cat <<EOF > backend.hcl
conn_str      = "postgres://${TF_VAR_PG_MASTER_USER}:${TF_VAR_PG_MASTER_PASS}@${TF_VAR_PG_HOST}:5432/terraform?sslmode=disable"
schema_name   = "infisical"
EOF