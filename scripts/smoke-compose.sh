#!/usr/bin/env bash
# Runs the production stack from compose.prod.yml (postgres, migrate, api, Caddy) the way the
# server does, with a throwaway env file made from deploy/production.env.example, and checks what
# operators and browsers rely on: HTTPS with HSTS, the HTTP redirect, the one-off migrate,
# create-admin, what is and is not reachable, data and certificates surviving restarts, Caddy's
# body limit and log rotation. Needs Docker (with Compose v2 and BuildKit) and curl:
#
#   scripts/smoke-compose.sh
#
# SITE_ADDRESS=localhost makes Caddy issue the certificate from its own local CA, so no domain or
# internet access is needed; curl trusts that CA explicitly (--cacert with the root exported from
# the container) instead of turning verification off, so a broken chain still fails the test.
#
# Host ports default to 18080/18443 so the test runs next to anything holding 80/443:
# SMOKE_HTTP_PORT, SMOKE_HTTPS_PORT. Behind a TLS-intercepting proxy the build needs its CA:
# EXTRA_CA_FILE=<pem> (defaults to NODE_EXTRA_CA_CERTS when that is set).
#
# Every secret (database password, JWT_SECRET, the admin's initial password) is random, lives only
# in a temporary directory for this run and is never printed. The stack, its volumes and images
# are removed on exit; the development database (docker-compose.yml) is a different project and
# is never touched.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/smoke-common.sh
source scripts/lib/smoke-common.sh

readonly SITE='localhost'
readonly HTTP_PORT="${SMOKE_HTTP_PORT:-18080}"
readonly HTTPS_PORT="${SMOKE_HTTPS_PORT:-18443}"
readonly ADMIN_LOGIN='smoke-admin'
readonly CA_PATH='/data/caddy/pki/authorities/local/root.crt'
readonly LEAF_PATH="/data/caddy/certificates/local/${SITE}/${SITE}.crt"
readonly HSTS='max-age=31536000; includeSubDomains'
# A little above Caddy's 6 MiB request_body limit on /api/*, and one above the api's own 64 KiB.
readonly OVERSIZED_BYTES=$((7 * 1024 * 1024))
readonly API_SIZED_BYTES=$((100 * 1024))

project="crsmoke-$$-${RANDOM}"
work_dir="$(mktemp -d)"
env_file="$work_dir/production.env"

compose() { docker compose -p "$project" -f "$PROD_COMPOSE_FILE" --env-file "$env_file" "$@"; }

cleanup() {
  if [[ -f "$env_file" ]]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker image rm "${project}-api" "${project}-web" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

dump_logs() {
  echo '--- compose ps ---'
  compose ps -a || true
  echo '--- logs ---'
  compose logs --no-color --tail 40 || true
}

container_of() { compose ps -aq "$1"; }
inspect() { docker inspect -f "$2" "$(container_of "$1")"; }
is_healthy() { [[ "$(inspect "$1" '{{.State.Health.Status}}')" == healthy ]]; }

# fetch <name> <scheme> <path> [curl args...]: saves status, headers and body under $work_dir.
fetch() {
  local name="$1" scheme="$2" path="$3" url
  shift 3
  if [[ "$scheme" == https ]]; then
    url="https://${SITE}:${HTTPS_PORT}${path}"
    set -- --cacert "$work_dir/root.crt" --resolve "${SITE}:${HTTPS_PORT}:127.0.0.1" "$@"
  else
    url="http://127.0.0.1:${HTTP_PORT}${path}"
    set -- -H "Host: ${SITE}" "$@"
  fi
  curl -sS -o "$work_dir/$name.body" -D "$work_dir/$name.headers" -w '%{http_code}' \
    "$@" "$url" >"$work_dir/$name.status"
}
status_is() { [[ "$(cat "$work_dir/$1.status")" == "$2" ]]; }
header_value() {
  grep -iE "^$2:" "$work_dir/$1.headers" | head -n 1 | cut -d: -f2- | sed 's/^ *//; s/\r$//'
}
header_is() { [[ "$(header_value "$1" "$2")" == "$3" ]]; }
header_count() { grep -ciE "^$2:" "$work_dir/$1.headers" || true; }
body_contains() { grep -qF -- "$2" "$work_dir/$1.body"; }
body_lacks() { ! body_contains "$@"; }
body_is_empty() { [[ ! -s "$work_dir/$1.body" ]]; }

login() {
  local name="$1"
  printf '{"loginId":"%s","password":"%s"}' "$ADMIN_LOGIN" "$admin_password" |
    fetch "$name" https /api/auth/login -X POST -H 'Content-Type: application/json' \
      --data-binary @-
}
# Copies a file out of the web container's /data volume.
copy_from_web() { compose cp "web:$1" "$2" >/dev/null 2>&1; }

web_connects() { compose exec -T web nc -z -w 3 "$1" "$2" >/dev/null 2>&1; }
api_fetches() {
  compose exec -T api node --input-type=module -e \
    "await fetch(process.argv[1], { redirect: 'manual', signal: AbortSignal.timeout(3000) })" \
    "$1" >/dev/null 2>&1
}
no_port_bindings() { [[ "$(inspect "$1" '{{json .HostConfig.PortBindings}}')" == '{}' ]]; }
log_rotation_set() {
  [[ "$(inspect "$1" '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}')" == 'json-file 10m 5' ]]
}
memory_limited() { (($(inspect "$1" '{{.HostConfig.Memory}}') > 0)); }
# compose.prod.yml's x-hardening, read back from the container Docker actually created.
hardened() {
  [[ "$(inspect "$1" '{{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}')" == 'true ["ALL"] ["no-new-privileges:true"]' ]]
}
# The effective capabilities of the service's main process: all zero once cap_drop ALL holds.
no_effective_caps() {
  [[ "$(compose exec -T "$1" sh -c 'grep "^CapEff:" /proc/1/status')" =~ ^CapEff:[[:space:]]+0+$ ]]
}
root_fs_read_only() { ! compose exec -T "$1" sh -c 'touch /smoke-write-test' >/dev/null 2>&1; }
# migrate's own report (run-migrations.ts): one JSON line naming what it applied.
migrate_logged() { compose logs --no-log-prefix migrate | grep -qF "\"msg\":\"$1\""; }
migrate_done_once() {
  [[ "$(inspect migrate '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}} {{.HostConfig.RestartPolicy.Name}}')" == 'exited 0 0 no' ]]
}
postgres_setting_is() {
  # shellcheck disable=SC2016 # expanded by sh inside the container, not here
  [[ "$(compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SHOW $1"' sh "$1")" == "$2" ]]
}
# Every client connection to the database other than this psql, by role. Right after a request
# the api's pool still holds its connection (pg's idle timeout is 10 s), and it must be club_app.
database_client_roles() {
  # shellcheck disable=SC2016 # expanded by sh inside the container, not here
  compose exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' <<'SQL'
SELECT string_agg(DISTINCT usename, ',') FROM pg_stat_activity
WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid();
SQL
}
api_heap_limit_mib() {
  compose exec -T api node -p 'Math.round(require("v8").getHeapStatistics().heap_size_limit / 2 ** 20)'
}

log "Writing a throwaway env file from $PROD_ENV_TEMPLATE"
write_prod_env_file "$env_file" "SITE_ADDRESS=${SITE}" "HTTP_PORT=${HTTP_PORT}" \
  "HTTPS_PORT=${HTTPS_PORT}"

log "Building images (project ${project})"
build_prod_images "$project" "$env_file" "$work_dir"

log 'Starting the stack (up --wait)'
if ! compose up -d --wait --wait-timeout 180; then
  dump_logs
  exit 1
fi

log 'Checking services'
check 'postgres is healthy' is_healthy postgres
check 'api is healthy' is_healthy api
check 'web is healthy (loopback health listener)' is_healthy web
check 'migrate exited 0, once, with restart policy "no"' migrate_done_once
check 'migrate logged the migrations it applied' migrate_logged 'migrations applied'

log "Checking HTTP on 127.0.0.1:${HTTP_PORT}"
fetch redirect http /student/clubs
check 'HTTP is redirected (308)' status_is redirect 308
check 'HTTP redirects to the same path over HTTPS' \
  header_is redirect location "https://${SITE}/student/clubs"
check 'the HTTP redirect has no Strict-Transport-Security' \
  test "$(header_count redirect strict-transport-security)" -eq 0

log "Checking HTTPS on ${SITE}:${HTTPS_PORT} (Caddy's local CA)"
wait_for "Caddy's local CA" 30 copy_from_web "$CA_PATH" "$work_dir/root.crt"
wait_for "the site certificate" 30 copy_from_web "$LEAF_PATH" "$work_dir/leaf-before.crt"
cp "$work_dir/root.crt" "$work_dir/root-before.crt"

fetch index https /
check '/ is 200 over HTTPS (certificate verified against the exported CA)' status_is index 200
check '/ is the SPA HTML' body_contains index '<div id="root"></div>'
check "/ has Strict-Transport-Security: ${HSTS}" header_is index strict-transport-security "$HSTS"
check '/ has Content-Security-Policy' \
  header_is index content-security-policy "$(grep -oE "default-src 'self';[^\"]+" Caddyfile)"

fetch health https /api/health
check '/api/health is 200 over HTTPS' status_is health 200
check '/api/health reports database up' body_contains health '"database":"up"'
check 'the api connects to the database as club_app only' \
  test "$(database_client_roles)" == club_app
check '/api/health has one Strict-Transport-Security (helmet; Caddy adds none)' \
  test "$(header_count health strict-transport-security)" -eq 1
check '/api/health Strict-Transport-Security is the same as the site' \
  header_is health strict-transport-security "$HSTS"

log 'Checking what is reachable'
check 'postgres publishes no host port' no_port_bindings postgres
check 'api publishes no host port' no_port_bindings api
check 'migrate publishes no host port' no_port_bindings migrate
# Each refusal is paired with a connection that must work, so a refusal cannot pass because the
# probe itself is broken.
check 'web reaches the api (frontend network)' web_connects api 3000
check 'web cannot reach postgres (not on the backend network)' negate web_connects postgres 5432
check 'the api reaches web on port 80' api_fetches 'http://web:80/'
check "the api cannot reach Caddy's health listener (bound to the container's loopback)" \
  negate api_fetches 'http://web:2020/health'

log 'Checking settings'
check 'postgres runs with shared_buffers=128MB' postgres_setting_is shared_buffers 128MB
check 'postgres runs with max_connections=50' postgres_setting_is max_connections 50
heap_mib="$(api_heap_limit_mib)"
check "api heap limit (${heap_mib} MiB) is under its 512 MiB container limit" \
  test "$heap_mib" -lt 512
for service in postgres migrate api web; do
  check "${service} logs rotate (json-file, 10m x 5)" log_rotation_set "$service"
  check "${service} has a memory limit" memory_limited "$service"
  check "${service} is read-only, drops every capability, no new privileges" hardened "$service"
done
for service in postgres api web; do
  check "${service}'s main process has no effective capabilities" no_effective_caps "$service"
  check "${service} cannot write to its root filesystem" root_fs_read_only "$service"
done
check 'postgres runs as uid 70 (postgres), not root' test "$(compose exec -T postgres id -u)" == 70

log 'Creating an admin (docker compose run --rm --no-deps api node dist/create-admin.js)'
# Output holds the initial password: kept in a variable, never echoed.
admin_output="$(compose run --rm --no-deps -T api node dist/create-admin.js "$ADMIN_LOGIN" 2>/dev/null)"
admin_password="$(sed -n 's/^Initial password (shown once, not stored): //p' <<<"$admin_output")"
check 'create-admin printed a password' test -n "$admin_password"
login login
check 'the admin logs in over HTTPS' status_is login 200
check 'create-admin left migrate alone (--no-deps)' migrate_done_once

log 'Checking request body limits on /api/*'
head -c "$OVERSIZED_BYTES" /dev/zero |
  fetch oversized https /api/auth/login -X POST -H 'Content-Type: application/json' \
    --data-binary @-
check "a ${OVERSIZED_BYTES}-byte body is rejected with 413" status_is oversized 413
check '... by Caddy, before the api (empty body, not the api JSON error)' body_is_empty oversized
head -c "$API_SIZED_BYTES" /dev/zero |
  fetch api_sized https /api/auth/login -X POST -H 'Content-Type: application/json' \
    --data-binary @-
check "a ${API_SIZED_BYTES}-byte body still reaches the api (its own JSON 413)" \
  body_contains api_sized '"code":"bad_request"'

log 'Restarting the api container'
compose restart api >/dev/null 2>&1
wait_for 'api healthcheck after restart' 60 is_healthy api
login login_after_restart
check 'the admin still logs in after an api restart' status_is login_after_restart 200

log 'docker compose down (keeping volumes), then up again'
compose down >/dev/null 2>&1
if ! compose up -d --wait --wait-timeout 180 >/dev/null 2>&1; then
  dump_logs
  exit 1
fi
check 'migrate ran again on up and exited 0 (nothing to apply)' migrate_done_once
check 'migrate logged that nothing was pending' migrate_logged 'no pending migrations'
login login_after_down
check 'the admin still logs in after down/up (postgres volume kept)' status_is login_after_down 200
wait_for "Caddy's local CA after up" 30 copy_from_web "$CA_PATH" "$work_dir/root-after.crt"
wait_for 'the site certificate after up' 30 copy_from_web "$LEAF_PATH" "$work_dir/leaf-after.crt"
check 'the CA survived down/up (caddy-data volume kept)' \
  cmp -s "$work_dir/root-before.crt" "$work_dir/root-after.crt"
check 'the site certificate was reused, not issued again' \
  cmp -s "$work_dir/leaf-before.crt" "$work_dir/leaf-after.crt"
fetch index_after_down https /
check '/ is still served over HTTPS after down/up' status_is index_after_down 200

if ((failures > 0)); then
  log "${failures} check(s) failed"
  dump_logs
  exit 1
fi
log 'All checks passed'
