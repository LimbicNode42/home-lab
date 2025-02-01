resource "infisical_secret_folder" "inifisical" {
  project_id       = infisical_project.dev_site.id
  environment_slug = "prod"

  name        = "infisical"
  folder_path = "/"
}

resource "infisical_secret_folder" "keycloak" {
  project_id       = infisical_project.dev_site.id
  environment_slug = "prod"

  name        = "keycloak"
  folder_path = "/"
}

resource "infisical_secret_folder" "mongo" {
  project_id       = infisical_project.dev_site.id
  environment_slug = "prod"

  name        = "mongo"
  folder_path = "/"
}

resource "infisical_secret_folder" "omv" {
  project_id       = infisical_project.dev_site.id
  environment_slug = "prod"

  name        = "omv"
  folder_path = "/"
}

resource "infisical_secret_folder" "postgres" {
  project_id       = infisical_project.dev_site.id
  environment_slug = "prod"

  name        = "postgres"
  folder_path = "/"
}

resource "infisical_secret_folder" "redis" {
  project_id       = infisical_project.dev_site.id
  environment_slug = "prod"

  name        = "redis"
  folder_path = "/"
}