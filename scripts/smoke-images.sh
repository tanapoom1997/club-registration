#!/usr/bin/env bash
# Builds the production images (Dockerfile targets api and web), runs them the way production
# does (postgres + migrate + api + Caddy on one Docker network) and checks what the browser and
# the operator rely on. Needs only Docker (with BuildKit) and curl. Run from anywhere:
#
#   scripts/smoke-images.sh
#
# Behind a TLS-intercepting proxy the build needs its CA: EXTRA_CA_FILE=<pem> (defaults to
# NODE_EXTRA_CA_CERTS when that is set). It is passed as a build secret, never stored in a layer.
#
# Every secret here (database password, JWT_SECRET, the admin's initial password) is random,
# lives only for this run and is never printed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/smoke-common.sh
source scripts/lib/smoke-common.sh

# Same image as the Testcontainers tests (apps/api/test/support/postgres.ts).
readonly POSTGRES_IMAGE='postgres:18-alpine'
readonly API_IMAGE='club-registration-api:smoke'
readonly WEB_IMAGE='club-registration-web:smoke'
# docker stop's grace period; graceful shutdown must finish well inside it.
readonly STOP_TIMEOUT_S=10
readonly MAX_STOP_S=5

run_id="smoke-$$-${RANDOM}"
network="${run_id}-net"
pg_container="${run_id}-postgres"
api_container="${run_id}-api"
web_container="${run_id}-web"
work_dir="$(mktemp -d)"

cleanup() {
  # -v: postgres keeps its data in an anonymous volume, which would otherwise outlive the run.
  docker rm -f -v "$web_container" "$api_container" "$pg_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

# fetch <name> <path> [curl args...]: saves status, headers and body under $work_dir/<name>.*
fetch() {
  local name="$1" path="$2"
  shift 2
  curl -sS -o "$work_dir/$name.body" -D "$work_dir/$name.headers" -w '%{http_code}' \
    "$@" "http://127.0.0.1:${web_port}${path}" >"$work_dir/$name.status"
}
status_is() { [[ "$(cat "$work_dir/$1.status")" == "$2" ]]; }
# Header names are case-insensitive; values are matched as an extended regex.
header_matches() { grep -qiE "^$2: $3" "$work_dir/$1.headers"; }
header_lacks() { ! header_matches "$@"; }
header_count() { grep -ciE "^$2:" "$work_dir/$1.headers" || true; }
body_contains() { grep -qF -- "$2" "$work_dir/$1.body"; }
in_api_image() { docker run --rm --entrypoint sh "$API_IMAGE" -c "$1"; }
pid1_uid() { docker exec "$1" cat /proc/1/status | awk '/^Uid:/ { print $2 }'; }

api_healthy() {
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$api_container")" == healthy ]]
}

build_args=()
extra_ca="${EXTRA_CA_FILE:-${NODE_EXTRA_CA_CERTS:-}}"
if [[ -n "$extra_ca" && -s "$extra_ca" ]]; then
  build_args+=(--secret "id=extra_ca,src=$extra_ca")
fi

log 'Building images'
docker build "${build_args[@]}" --target api -t "$API_IMAGE" .
docker build "${build_args[@]}" --target web -t "$WEB_IMAGE" .

log 'Starting postgres'
docker network create "$network" >/dev/null
POSTGRES_PASSWORD="$(random_secret)"
JWT_SECRET="$(random_secret)"
APP_DB_PASSWORD="$(random_hex)"
# The owner (migrate) and club_app (create-admin, the api), as in compose.prod.yml.
DATABASE_URL="postgres://club:${POSTGRES_PASSWORD}@${pg_container}:5432/club"
APP_DATABASE_URL="postgres://club_app:${APP_DB_PASSWORD}@${pg_container}:5432/club"
export POSTGRES_PASSWORD JWT_SECRET DATABASE_URL APP_DB_PASSWORD APP_DATABASE_URL
# -e NAME (no value) copies it from this script's environment, keeping secrets out of `ps`.
docker run -d --name "$pg_container" --network "$network" \
  -e POSTGRES_USER=club -e POSTGRES_DB=club -e POSTGRES_PASSWORD \
  "$POSTGRES_IMAGE" >/dev/null
# Over TCP: the entrypoint's temporary init server listens on the socket only.
wait_for 'postgres' 60 docker exec "$pg_container" pg_isready -h 127.0.0.1 -U club -d club

log 'Running migrations (one-off container)'
docker run --rm --network "$network" -e DATABASE_URL -e APP_DB_PASSWORD "$API_IMAGE" \
  node dist/migrate.js

log 'Creating an admin with create-admin (one-off container)'
# Output holds the initial password: kept in a variable, never echoed.
# DATABASE_URL=... as a prefix, then -e NAME: the secret stays out of `ps`, as above.
admin_output="$(DATABASE_URL="$APP_DATABASE_URL" docker run --rm --network "$network" \
  -e DATABASE_URL "$API_IMAGE" node dist/create-admin.js smoke-admin)"
admin_password="$(sed -n 's/^Initial password (shown once, not stored): //p' <<<"$admin_output")"

log 'Checking that the api refuses to start as the database owner'
# NODE_ENV=production comes from the image. Output is kept for the check, never printed: it is
# the api's own error, but the rule is that nothing from a container run with secrets is echoed.
owner_rc=0
owner_output="$(docker run --rm --network "$network" -e DATABASE_URL -e JWT_SECRET \
  "$API_IMAGE" 2>&1)" || owner_rc=$?
check 'api exits non-zero with the owner DATABASE_URL' test "$owner_rc" -ne 0
check 'api names club_app as the role it must use' \
  grep -q 'the api must connect as club_app' <<<"$owner_output"

log 'Starting api and web'
# The alias makes the Caddyfile's default upstream (api:3000) resolve, so the default is tested.
DATABASE_URL="$APP_DATABASE_URL" docker run -d --name "$api_container" --network "$network" \
  --network-alias api -e DATABASE_URL -e JWT_SECRET -e TRUST_PROXY=true "$API_IMAGE" >/dev/null
docker run -d --name "$web_container" --network "$network" -p 127.0.0.1::80 \
  "$WEB_IMAGE" >/dev/null
web_port="$(docker port "$web_container" 80/tcp | head -n 1 | sed 's/.*://')"
wait_for 'api healthcheck' 60 api_healthy
wait_for 'web' 30 curl -sf -o /dev/null "http://127.0.0.1:${web_port}/"

log "Checking through Caddy on 127.0.0.1:${web_port}"
check 'api container reports healthy (HEALTHCHECK)' api_healthy

fetch health /api/health
check '/api/health is 200' status_is health 200
check '/api/health reports database up' body_contains health '"database":"up"'
check '/api/* keeps the api CSP only (no second one from Caddy)' \
  test "$(header_count health content-security-policy)" -eq 1

fetch notfound /api/nonexistent
check '/api/nonexistent is 404' status_is notfound 404
check '/api/nonexistent is the api JSON error, not index.html' \
  body_contains notfound '"code":"not_found"'

fetch index /
check '/ is 200' status_is index 200
check '/ is the SPA HTML' body_contains index '<div id="root"></div>'
check '/ has Content-Security-Policy' \
  header_matches index content-security-policy "default-src 'self'; script-src 'self'"
check '/ has X-Content-Type-Options' header_matches index x-content-type-options nosniff
check '/ has X-Frame-Options' header_matches index x-frame-options DENY
check '/ has Referrer-Policy' header_matches index referrer-policy no-referrer
check '/ has Permissions-Policy' header_matches index permissions-policy 'camera=\(\)'
check '/ is revalidated (no-cache)' header_matches index cache-control no-cache
check '/ has no Strict-Transport-Security over plain HTTP' \
  header_lacks index strict-transport-security '.*'

fetch deeplink /student/clubs
check '/student/clubs falls back to index.html' body_contains deeplink '<div id="root"></div>'
check '/student/clubs is 200' status_is deeplink 200

asset_path="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$work_dir/index.body" | head -n 1 || true)"
check 'index.html references a hashed script' test -n "$asset_path"
fetch asset "$asset_path" -H 'Accept-Encoding: zstd, gzip'
check "$asset_path is 200" status_is asset 200
check "$asset_path is cached immutable" header_matches asset cache-control '.*immutable'
check "$asset_path is JavaScript" header_matches asset content-type 'text/javascript'
check "$asset_path is compressed" header_matches asset content-encoding '(zstd|gzip)'

fetch missing_asset /assets/index-missing.js
check 'a missing asset is 404, not index.html' status_is missing_asset 404
check 'a missing asset is not cached immutable' \
  header_lacks missing_asset cache-control '.*immutable'

login_body="$(printf '{"loginId":"smoke-admin","password":"%s"}' "$admin_password")"
fetch login /api/auth/login -X POST -H 'Content-Type: application/json' --data-binary @- \
  <<<"$login_body"
check 'create-admin printed a password' test -n "$admin_password"
check 'the created admin logs in through Caddy (argon2id in the image)' status_is login 200

log 'Checking the containers and images'
check 'api runs as a non-root user' test "$(pid1_uid "$api_container")" != 0
check 'web (Caddy) runs as a non-root user' test "$(pid1_uid "$web_container")" != 0
check 'api image has the PDF fonts and their licence' \
  in_api_image 'test -f assets/fonts/Sarabun-Regular.ttf && test -f assets/fonts/OFL.txt'
check 'api image has the import template where the api looks for it' \
  docker run --rm "$API_IMAGE" node --input-type=module -e \
  "const { IMPORT_TEMPLATE_PATH } = await import('./dist/import/template.js');
   await (await import('node:fs/promises')).access(IMPORT_TEMPLATE_PATH);"
check 'api image has no sources, tests or dev dependencies' \
  in_api_image 'test ! -e src && test ! -e test && ! ls node_modules/.pnpm | grep -qE "^(typescript|vitest|tsx|testcontainers)@"'
check 'api image has no development entry points (seed-dev, generate-template, dist/dev/)' \
  in_api_image 'test ! -e dist/seed-dev.js && test ! -e dist/generate-template.js && test ! -e dist/dev'
check 'web answers on its loopback health listener (compose healthcheck)' \
  docker exec "$web_container" wget -q -O /dev/null http://127.0.0.1:2020/health
# A CA key baked in at build time would be shared by every container and volume from the image.
# shellcheck disable=SC2016 # expanded by sh inside the image, not here
check 'web image ships empty /data and /config (no certificates or CA keys)' \
  docker run --rm --user 0 --entrypoint sh "$WEB_IMAGE" -c \
  'test -z "$(find /data /config -type f)"'
# shellcheck disable=SC2016 # expanded by sh inside the image, not here
no_secret_files='test -z "$(find / -xdev \( -name ".env" -o -name ".env.*" -o -name ".dev-credentials.txt" -o -name "*.dump" \) 2>/dev/null)"'
check 'api image has no .env, credentials or dump files' \
  docker run --rm --user 0 --entrypoint sh "$API_IMAGE" -c "$no_secret_files"
check 'web image has no .env, credentials or dump files' \
  docker run --rm --user 0 --entrypoint sh "$WEB_IMAGE" -c "$no_secret_files"

log 'Stopping api (graceful shutdown)'
started_at="$(date +%s)"
docker stop -t "$STOP_TIMEOUT_S" "$api_container" >/dev/null
stop_seconds=$(($(date +%s) - started_at))
check "api stopped within ${MAX_STOP_S}s (took ${stop_seconds}s)" test "$stop_seconds" -le "$MAX_STOP_S"
check 'api exited with code 0 (not killed)' \
  test "$(docker inspect -f '{{.State.ExitCode}}' "$api_container")" -eq 0
check 'api logged its shutdown' bash -c "docker logs '$api_container' 2>&1 | grep -q 'shutting down'"

log 'Image sizes'
docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' "$API_IMAGE"
docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' "$WEB_IMAGE"

if ((failures > 0)); then
  log "${failures} check(s) failed"
  echo '--- api logs ---'
  docker logs "$api_container" 2>&1 | tail -n 50
  echo '--- web logs ---'
  docker logs "$web_container" 2>&1 | tail -n 50
  exit 1
fi
log 'All checks passed'
