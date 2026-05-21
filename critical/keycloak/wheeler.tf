resource "random_password" "wheeler" {
  length  = 32
  special = false # Set to true if you want special characters
}

resource "keycloak_openid_client" "wheeler" {
  realm_id  = keycloak_realm.shadow.id
  client_id = "wheeler"

  name        = "wheeler"
  description = "Access gateway for wheeler-network"
  enabled     = true

  access_type   = "CONFIDENTIAL"
  client_secret = random_password.client_dev_site.result

  standard_flow_enabled        = true
  direct_access_grants_enabled = true

  valid_redirect_uris = [
    "https://portainer.wheeler-network.com/*"
  ]
}