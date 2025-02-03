data "infisical_secrets" "infisical" {
  workspace_id = data.terraform_remote_state.infisical.outputs.dev_site_project_id
  env_slug     = "prod"
  folder_path  = "/infisical"
}

resource "random_password" "client_infisical" {
  length  = 32
  special = false # Set to true if you want special characters
}

resource "keycloak_openid_client" "infisical" {
  realm_id  = keycloak_realm.shadow.id
  client_id = "infisical"

  name        = "infisical"
  description = "Infisical identity provider"
  enabled     = true

  access_type   = "CONFIDENTIAL"
  client_secret = random_password.client_dev_site.result

  service_accounts_enabled = false

  standard_flow_enabled = true
  direct_access_grants_enabled = true

  # Enable once backoffice ingress is setup
  valid_redirect_uris = [
      "${nonsensitive(data.infisical_secrets.infisical.secrets["INF_URL"].value)}/auth/callback"
  ]
  web_origins = [
      nonsensitive(data.infisical_secrets.infisical.secrets["INF_URL"].value)
  ]
}