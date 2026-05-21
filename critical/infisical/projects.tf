resource "infisical_project" "dev_site" {
  name        = "dev"
  slug        = "dev-site"
  description = "secret store for resources related to dev site"
}

resource "infisical_project_user" "dev_site_me" {
  project_id = infisical_project.dev_site.id
  username   = "b.j.wheeler484@gmail.com"
  roles = [
    {
      role_slug = "admin"
    }
  ]
}

resource "infisical_project" "wheeler" {
  name        = "wheeler"
  slug        = "where"
  description = "secret store for wheeler family credentials"
}

resource "infisical_project_user" "wheeler_me" {
  project_id = infisical_project.wheeler.id
  username   = "b.j.wheeler484@gmail.com"
  roles = [
    {
      role_slug = "admin"
    }
  ]
}