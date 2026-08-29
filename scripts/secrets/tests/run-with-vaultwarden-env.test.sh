#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="$repo_root/scripts/secrets/run-with-vaultwarden-env.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle; got: $haystack"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "expected output not to contain secret marker: $needle; got: $haystack"
}

make_fake_get_field() {
  local path="$1"
  cat >"$path" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$FAKE_BW_CALL_LOG"
case "$1|$2|$3" in
  'homelab|FMP_API_KEY|password') printf 'SECRET_CURRENT_FMP_VALUE\n' ;;
  'homelab|investment-screener/fmp|api_key') printf 'SECRET_NORMALIZED_FMP_VALUE\n' ;;
  'homelab|empty/value|password') printf '\n' ;;
  *) echo "unexpected fake bw lookup: $1|$2|$3" >&2; exit 44 ;;
esac
FAKE
  chmod +x "$path"
}

test_missing_bw_session_fails_fast() {
  local tmp output status
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  printf 'FMP_API_KEY|homelab|FMP_API_KEY|password\n' >"$tmp/map"
  make_fake_get_field "$tmp/get-field"

  set +e
  output="$(env -u BW_SESSION RUN_WITH_VAULTWARDEN_GET_FIELD="$tmp/get-field" "$script" "$tmp/map" -- env 2>&1)"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "missing BW_SESSION unexpectedly succeeded"
  assert_contains "$output" "BW_SESSION must be exported"
  assert_not_contains "$output" "SECRET_CURRENT_FMP_VALUE"
}

test_injects_current_and_normalized_fmp_items_into_child_only() {
  local tmp output status
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  printf '%s\n' \
    '# comments and blank lines are ignored' \
    '' \
    'FMP_API_KEY|homelab|FMP_API_KEY|password' \
    'NORMALIZED_FMP_API_KEY|homelab|investment-screener/fmp|api_key' >"$tmp/map"
  make_fake_get_field "$tmp/get-field"
  export FAKE_BW_CALL_LOG="$tmp/calls"

  set +e
  output="$(BW_SESSION=dummy RUN_WITH_VAULTWARDEN_GET_FIELD="$tmp/get-field" \
    "$script" "$tmp/map" -- bash -c '[[ "$FMP_API_KEY" == SECRET_CURRENT_FMP_VALUE ]] && [[ "$NORMALIZED_FMP_API_KEY" == SECRET_NORMALIZED_FMP_VALUE ]]' 2>&1)"
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || fail "env injection command failed with $status: $output"
  [[ -z "$output" ]] || fail "wrapper printed unexpected output: $output"
  grep -qx 'homelab|FMP_API_KEY|password' "$tmp/calls" || fail "current FMP lookup was not performed"
  grep -qx 'homelab|investment-screener/fmp|api_key' "$tmp/calls" || fail "normalized FMP lookup was not performed"

  [[ -z "${FMP_API_KEY:-}" ]] || fail "FMP_API_KEY leaked into parent shell"
  [[ -z "${NORMALIZED_FMP_API_KEY:-}" ]] || fail "NORMALIZED_FMP_API_KEY leaked into parent shell"
}

test_does_not_echo_secrets_when_child_does_not_print_them() {
  local tmp output status
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  printf 'FMP_API_KEY|homelab|FMP_API_KEY|password\n' >"$tmp/map"
  make_fake_get_field "$tmp/get-field"
  export FAKE_BW_CALL_LOG="$tmp/calls"

  set +e
  output="$(BW_SESSION=dummy RUN_WITH_VAULTWARDEN_GET_FIELD="$tmp/get-field" \
    "$script" "$tmp/map" -- bash -c 'test -n "$FMP_API_KEY"' 2>&1)"
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || fail "child failed unexpectedly: $output"
  assert_not_contains "$output" "SECRET_CURRENT_FMP_VALUE"
}

test_empty_secret_value_fails_without_running_child() {
  local tmp output status marker
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  marker="$tmp/child-ran"
  printf 'EMPTY_VALUE|homelab|empty/value|password\n' >"$tmp/map"
  make_fake_get_field "$tmp/get-field"
  export FAKE_BW_CALL_LOG="$tmp/calls"

  set +e
  output="$(BW_SESSION=dummy RUN_WITH_VAULTWARDEN_GET_FIELD="$tmp/get-field" \
    "$script" "$tmp/map" -- bash -c "touch '$marker'" 2>&1)"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "empty secret mapping unexpectedly succeeded"
  [[ ! -e "$marker" ]] || fail "child command ran despite empty secret"
  assert_contains "$output" "empty value for EMPTY_VALUE"
}

test_preserves_child_exit_status() {
  local tmp output status
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  printf 'FMP_API_KEY|homelab|FMP_API_KEY|password\n' >"$tmp/map"
  make_fake_get_field "$tmp/get-field"
  export FAKE_BW_CALL_LOG="$tmp/calls"

  set +e
  output="$(BW_SESSION=dummy RUN_WITH_VAULTWARDEN_GET_FIELD="$tmp/get-field" \
    "$script" "$tmp/map" -- bash -c 'exit 37' 2>&1)"
  status=$?
  set -e

  [[ "$status" -eq 37 ]] || fail "expected child status 37, got $status with output: $output"
}

for test_name in \
  test_missing_bw_session_fails_fast \
  test_injects_current_and_normalized_fmp_items_into_child_only \
  test_does_not_echo_secrets_when_child_does_not_print_them \
  test_empty_secret_value_fails_without_running_child \
  test_preserves_child_exit_status; do
  "$test_name"
  echo "ok - $test_name"
done
