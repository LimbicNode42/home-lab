resource "infisical_project" "dev_site" {
  name        = "dev site"
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