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
  client_id                = nonsensitive(data.infisical_secrets.keycloak.secrets["KC_TF_CLIENT_ID"].value)
  client_secret            = sensitive(data.infisical_secrets.keycloak.secrets["KC_TF_CLIENT_SECRET"].value)
  url                      = "https://${nonsensitive(data.infisical_secrets.keycloak.secrets["KEYCLOAK_HOST"].value)}:8443"
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
  workspace_id = data.terraform_remote_state.infisical.outputs.dev_site_project_id
  env_slug     = "prod"
  folder_path  = "/keycloak"
}