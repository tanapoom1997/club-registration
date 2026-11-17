# shellcheck shell=bash disable=SC2034 # its variables are used by the scripts sourcing it
# Shared by scripts/backup.sh and scripts/restore.sh; sourced, never run on its own.
#
# Both scripts drive the production stack through `docker compose -f compose.prod.yml` with the
# production env file, so they need no database port on the host and no Postgres client tools:
# pg_dump, pg_restore and psql run inside the postgres container, and the dump travels over the
# exec's stdin/stdout. The S3 side uses the host's AWS CLI (`aws`), which on EC2 picks up the
# instance role; AWS_ENDPOINT_URL, AWS_REGION and the usual AWS_* variables pass straight through.
#
# Settings come from the environment first, then from the env file, then the defaults below:
#   PROD_ENV_FILE      env file (default deploy/production.env, relative to the repo root)
#   BACKUP_S3_URI      s3://<bucket>/<prefix> the dumps go to (required unless --local-only)
#   BACKUP_DIR         local copies (default /var/backups/club-registration), kept at mode 700
#   BACKUP_KEEP_LOCAL  how many local copies to keep (default 7); S3 retention is a lifecycle rule
#   BACKUP_AWS_REGION  exported as AWS_REGION when set
#   COMPOSE_PROJECT_NAME  read by docker compose itself (default: compose.prod.yml's name)
#
# The dump holds student names and password hashes: it is only ever written to a file created
# under umask 077, and nothing here prints a dump's contents or table rows.

# Exit codes, the same for both scripts so a timer or cron job can tell them apart.
readonly EXIT_FAILURE=1
readonly EXIT_USAGE=2
readonly EXIT_LOCKED=3
readonly EXIT_UPLOAD_FAILED=4

readonly COMPOSE_FILE_NAME='compose.prod.yml'
readonly DEFAULT_BACKUP_DIR='/var/backups/club-registration'
readonly DEFAULT_KEEP_LOCAL=7
# <db>-<UTC timestamp>.dump, e.g. club_registration-20261117T153000Z.dump. The timestamp sorts
# lexicographically, so "newest" is simply the last name in sorted order, locally and in S3.
readonly STAMP_PATTERN='[0-9]{8}T[0-9]{6}Z'
readonly CERTS_PREFIX='caddy-data'

# Paths in settings (PROD_ENV_FILE, BACKUP_DIR) are relative to the repo root, where compose.prod.yml
# is; a file given on the command line is relative to where the script was started.
CALLER_DIR="$PWD"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly CALLER_DIR REPO_ROOT
cd "$REPO_ROOT" || exit 1

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s WARNING %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  local code="$1"
  shift
  printf '%s ERROR %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit "$code"
}

# env_value <NAME> [default]: a non-empty environment variable wins, then the last NAME= line of
# the env file (surrounding quotes removed), then the default. The env file is read as data, never
# sourced: compose's env-file syntax is not shell syntax.
env_value() {
  local name="$1" default="${2-}" line value
  if [[ -n "${!name-}" ]]; then
    printf '%s' "${!name}"
    return
  fi
  line="$(grep -E "^${name}=" "$PROD_ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "${value:-$default}"
}

load_config() {
  PROD_ENV_FILE="${PROD_ENV_FILE:-deploy/production.env}"
  [[ -f "$PROD_ENV_FILE" && -r "$PROD_ENV_FILE" ]] ||
    die "$EXIT_USAGE" "env file not readable: ${PROD_ENV_FILE} (set PROD_ENV_FILE)"

  DB_NAME="$(env_value POSTGRES_DB)"
  DB_USER="$(env_value POSTGRES_USER)"
  # Both end up in SQL identifiers and file names; the template's values pass easily.
  [[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] ||
    die "$EXIT_USAGE" 'POSTGRES_DB must be lower-case letters, digits and _ (at most 41)'
  [[ "$DB_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    die "$EXIT_USAGE" 'POSTGRES_USER must be lower-case letters, digits and _'

  BACKUP_S3_URI="$(env_value BACKUP_S3_URI)"
  BACKUP_S3_URI="${BACKUP_S3_URI%/}"
  if [[ -n "$BACKUP_S3_URI" && ! "$BACKUP_S3_URI" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](/[A-Za-z0-9._/-]*)?$ ]]; then
    die "$EXIT_USAGE" 'BACKUP_S3_URI must look like s3://<bucket>/<prefix>'
  fi

  BACKUP_DIR="$(env_value BACKUP_DIR "$DEFAULT_BACKUP_DIR")"
  [[ "$BACKUP_DIR" == /* ]] || BACKUP_DIR="${REPO_ROOT}/${BACKUP_DIR}"
  BACKUP_KEEP_LOCAL="$(env_value BACKUP_KEEP_LOCAL "$DEFAULT_KEEP_LOCAL")"
  [[ "$BACKUP_KEEP_LOCAL" =~ ^[1-9][0-9]*$ ]] ||
    die "$EXIT_USAGE" 'BACKUP_KEEP_LOCAL must be a whole number of at least 1'

  local region
  region="$(env_value BACKUP_AWS_REGION)"
  if [[ -n "$region" ]]; then export AWS_REGION="$region"; fi
}

compose() { docker compose -f "$COMPOSE_FILE_NAME" --env-file "$PROD_ENV_FILE" "$@"; }

require_aws() {
  command -v aws >/dev/null 2>&1 ||
    die "$EXIT_USAGE" 'the AWS CLI (aws) is not installed on this host; use --local-only or a local file'
}

# Creates the backup directory owner-only and takes the lock shared by backup and restore, so a
# scheduled backup never runs during a restore and two backups never overlap. The lock is
# released when the process exits, however it exits.
prepare_backup_dir() {
  umask 077
  mkdir -p "$BACKUP_DIR" || die "$EXIT_FAILURE" "cannot create ${BACKUP_DIR}"
  chmod 700 "$BACKUP_DIR" || die "$EXIT_FAILURE" "cannot set ${BACKUP_DIR} to mode 700"
  LOCK_FILE="${BACKUP_DIR}/.lock"
  exec {LOCK_FD}>>"$LOCK_FILE" || die "$EXIT_FAILURE" "cannot open ${LOCK_FILE}"
  flock -n "$LOCK_FD" ||
    die "$EXIT_LOCKED" "another backup or restore holds ${LOCK_FILE}; nothing was done"
}

service_running() { [[ -n "$(compose ps --status running -q "$1" 2>/dev/null)" ]]; }

# Errors from the server can carry a DETAIL line quoting row values (a duplicate key, say), and
# those would end up in journald; everything else in pg_restore/psql errors is about structure.
without_details() { "$@" 2> >(grep -vE '^(DETAIL|CONTEXT): ' >&2); }

# psql_in <database> [psql args...]: psql inside the postgres container over its socket (trust
# auth inside the container, so no password is passed around). Never used to print table rows.
psql_in() {
  local database="$1"
  shift
  without_details compose exec -T postgres \
    psql -X -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$database" "$@"
}

database_exists() {
  [[ "$(psql_in postgres -tA -v name="$1" <<<"SELECT count(*) FROM pg_database WHERE datname = :'name';")" == 1 ]]
}

drop_database() {
  psql_in postgres -v name="$1" <<<'SET client_min_messages = warning;
DROP DATABASE IF EXISTS :"name" WITH (FORCE);'
}

# verify_dump <file>: the archive must be a complete pg_dump custom-format file. `pg_restore
# --list` reads only the table of contents at the start, which a truncated file still has, so the
# whole archive is also read through (converted to SQL into /dev/null inside the container):
# truncation or corruption anywhere fails here, before anything is stopped or replaced.
verify_dump() {
  local file="$1"
  [[ -s "$file" ]] || return 1
  compose exec -T postgres pg_restore --list <"$file" >/dev/null || return 1
  compose exec -T postgres pg_restore --file=/dev/null <"$file" >/dev/null || return 1
}

verify_certs_archive() { gzip -t "$1" && tar -tzf "$1" >/dev/null; }

# Non-PII facts about a restored database for the log: row counts and the registration invariant
# (every club's registered = its registrations), plus the newest migration applied.
report_database() {
  psql_in "$1" -tA -F ' ' <<'SQL'
SELECT 'users=' || (SELECT count(*) FROM users)
    || ' students=' || (SELECT count(*) FROM student_profiles)
    || ' rounds=' || (SELECT count(*) FROM rounds)
    || ' clubs=' || (SELECT count(*) FROM clubs)
    || ' registrations=' || (SELECT count(*) FROM registrations)
    || ' events=' || (SELECT count(*) FROM registration_events)
    || ' clubs_with_wrong_registered=' || (
         SELECT count(*) FROM clubs c
         WHERE c.registered <> (SELECT count(*) FROM registrations r WHERE r.club_id = c.id))
    || ' last_migration=' || coalesce((SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1), '-');
SQL
}

# The newest object or file name matching ^<prefix>-<stamp><suffix>$, or nothing.
newest_s3_name() {
  local prefix="$1" suffix="$2"
  aws s3 ls "${BACKUP_S3_URI}/" | awk '{ print $4 }' |
    grep -E "^${prefix}-${STAMP_PATTERN}${suffix//./\\.}$" | sort | tail -n 1 || true
}
newest_local_file() {
  local prefix="$1" suffix="$2"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${prefix}-*${suffix}" -printf '%f\n' 2>/dev/null |
    grep -E "^${prefix}-${STAMP_PATTERN}${suffix//./\\.}$" | sort | tail -n 1 || true
}
