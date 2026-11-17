# shellcheck shell=bash
# Helpers shared by the smoke scripts (scripts/smoke-*.sh); sourced, never run on its own.
# A sourcing script runs from the repository root and counts failed checks in $failures.

readonly PROD_COMPOSE_FILE='compose.prod.yml'
readonly PROD_ENV_TEMPLATE='deploy/production.env.example'

failures=0

log() { printf '==> %s\n' "$*"; }
pass() { printf '  ok    %s\n' "$*"; }
fail() {
  printf '  FAIL  %s\n' "$*"
  failures=$((failures + 1))
}
check() {
  local description="$1"
  shift
  if "$@"; then pass "$description"; else fail "$description"; fi
}
negate() { ! "$@"; }

wait_for() {
  local description="$1" attempts="$2"
  shift 2
  for _ in $(seq "$attempts"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for $description" >&2
  return 1
}

random_secret() { head -c 48 /dev/urandom | base64 | tr -d '\n/+='; }
# Hex, as the env template asks for the database password (it is embedded in DATABASE_URL).
random_hex() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# write_prod_env_file <out> [KEY=VALUE...]: a throwaway env file from the production template with
# a random database password and JWT_SECRET. Each KEY=VALUE replaces the template's KEY= line, or
# is appended when the template has none. Built with shell builtins and created under umask 077,
# so no secret shows up in a process list or a readable file.
write_prod_env_file() {
  local out="$1"
  shift
  (
    umask 077
    local line pair
    while IFS= read -r line; do
      for pair in "$@"; do
        if [[ "$line" == "${pair%%=*}="* ]]; then line="$pair"; fi
      done
      case "$line" in
        POSTGRES_PASSWORD=) line="POSTGRES_PASSWORD=$(random_hex)" ;;
        JWT_SECRET=) line="JWT_SECRET=$(random_secret)" ;;
      esac
      printf '%s\n' "$line"
    done <"$PROD_ENV_TEMPLATE" >"$out"
    for pair in "$@"; do
      grep -q "^${pair%%=*}=" "$out" || printf '%s\n' "$pair" >>"$out"
    done
  )
  # The template must keep its blanks where the loop above fills them in.
  grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$out"
  grep -qE '^JWT_SECRET=.{32,}$' "$out"
}

# build_prod_images <project> <env_file> <scratch_dir>: `docker compose build` of compose.prod.yml.
# Behind a TLS-intercepting proxy, EXTRA_CA_FILE=<pem> (or NODE_EXTRA_CA_CERTS) becomes the
# Dockerfile's optional build secret through a temporary override file; compose.prod.yml itself
# never needs it. Bake (Compose's builder) refuses to read a file outside the project directory
# unless the fs entitlement check is lifted, which is done for this one command only.
build_prod_images() {
  local project="$1" env_file="$2" scratch_dir="$3" extra_ca
  local -a files=(-f "$PROD_COMPOSE_FILE") build_env=()
  extra_ca="${EXTRA_CA_FILE:-${NODE_EXTRA_CA_CERTS:-}}"
  if [[ -n "$extra_ca" && -s "$extra_ca" ]]; then
    cat >"$scratch_dir/extra-ca.yml" <<EOF
services:
  api:
    build:
      secrets: [extra_ca]
  web:
    build:
      secrets: [extra_ca]
secrets:
  extra_ca:
    file: $(cd "$(dirname "$extra_ca")" && pwd)/$(basename "$extra_ca")
EOF
    files+=(-f "$scratch_dir/extra-ca.yml")
    build_env+=(BUILDX_BAKE_ENTITLEMENTS_FS=0)
  fi
  env "${build_env[@]}" docker compose -p "$project" "${files[@]}" --env-file "$env_file" build
}
