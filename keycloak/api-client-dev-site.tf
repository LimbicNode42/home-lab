resource "random_password" "client_dev_site" {
  length  = 32
  special = false # Set to true if you want special characters
}

resource "keycloak_openid_client" "dev_site" {
  realm_id  = keycloak_realm.shadow.id
  client_id = "api-dev-site"

  name        = "dev site api"
  description = "API token for dev site GraphQL API"
  enabled     = true

  access_type   = "CONFIDENTIAL"
  client_secret = random_password.client_dev_site.result

  service_accounts_enabled = true

  # Enable once backoffice ingress is setup
  # valid_redirect_uris = [
  #     "backoffice.wheeler-network.com"
  # ]
  # web_origins = [
  #     "backoffice.wheeler-network.com"
  # ]
}