terraform {
  required_version = ">= 1.7.0"
  required_providers {
    infisical = {
      source  = "infisical/infisical"
      version = ">= 0.12.13"
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
