resource "infisical_secret_folder" "adam" {
  project_id       = infisical_project.wheeler.id
  environment_slug = "prod"

  name        = "adam"
  folder_path = "/"
}

resource "infisical_secret_folder" "ben" {
  project_id       = infisical_project.wheeler.id
  environment_slug = "prod"

  name        = "ben"
  folder_path = "/"
}

resource "infisical_secret_folder" "cheryl" {
  project_id       = infisical_project.wheeler.id
  environment_slug = "prod"

  name        = "cheryl"
  folder_path = "/"
}

resource "infisical_secret_folder" "courtney" {
  project_id       = infisical_project.wheeler.id
  environment_slug = "prod"

  name        = "courtney"
  folder_path = "/"
}

resource "infisical_secret_folder" "phoebe" {
  project_id       = infisical_project.wheeler.id
  environment_slug = "prod"

  name        = "phoebe"
  folder_path = "/"
}