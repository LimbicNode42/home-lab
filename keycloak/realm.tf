resource "keycloak_realm" "shadow" {
  # General
  realm             = "shadow"
  enabled           = true
  display_name      = "shadow"
  display_name_html = "<h1>shadow</h1>"
  ssl_required      = "external"

  # Login
  reset_password_allowed = true
  remember_me            = true

  security_defenses {
    brute_force_detection {
      permanent_lockout                = false
      max_login_failures               = 20
      wait_increment_seconds           = 300
      quick_login_check_milli_seconds  = 1000
      minimum_quick_login_wait_seconds = 60
      max_failure_wait_seconds         = 43200
      failure_reset_time_seconds       = 43200
    }
  }

  # Sessions
  sso_session_idle_timeout             = "2h"
  sso_session_max_lifespan             = "12h"
  sso_session_max_lifespan_remember_me = "720h"
  sso_session_idle_timeout_remember_me = "720h"
  client_session_idle_timeout          = "2h"
  client_session_max_lifespan          = "12h"
  offline_session_idle_timeout         = "720h"
  offline_session_max_lifespan_enabled = true
  offline_session_max_lifespan         = "720h"
  access_code_lifespan                 = "10m"
  access_code_lifespan_user_action     = "4m"
  access_code_lifespan_login           = "5m"
}

resource "keycloak_realm_events" "shadow_events" {
  realm_id = keycloak_realm.shadow.id

  events_enabled    = true
  events_expiration = 604800

  events_listeners = [
    "jboss-logging"
  ]
}