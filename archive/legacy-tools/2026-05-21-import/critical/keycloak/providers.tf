terraform {
  required_version = ">= 1.7.0"
  required_providers {
    infisical = {
      source  = "infisical/infisical"
      version = ">= 0.12.13"
    }
    keycloak = {
      source  = "keycloak/keycloak"
      version = ">= 5.1.0"
    }
  }
  backend "pg" {}
}

provider "infisical" {
  host = var.infisical_api_url
  auth = {
    universal = {
      client_id     = var.infisical_client_id
      client_secret = var.infisical_client_secret
    }
  }
}

provider "keycloak" {
  # client_id                = nonsensitive(data.infisical_secrets.keycloak.secrets["KC_TF_CLIENT_ID"].value)
  client_id = "terraform-oidc"
  # client_secret            = sensitive(data.infisical_secrets.keycloak.secrets["<redacted legacy field>"].value)
  client_secret            = "<placeholder>"
  url                      = "https://keycloak.wheeler-network.com"
  tls_insecure_skip_verify = true
}

data "terraform_remote_state" "infisical" {
  backend = "pg"

  config = {
    conn_str    = var.postgres_conn_string
    schema_name = "infisical"
  }
}

data "infisical_secrets" "keycloak" {
  workspace_id = "e3ddc353-e6ec-45dd-b038-a46e2f50fe45"
  env_slug     = "prod"
  folder_path  = "/keycloak"
}