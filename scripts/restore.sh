#!/usr/bin/env bash
# Restores the production database from a backup made by scripts/backup.sh (docs/operations.md "Backup และ
# Restore"):
#
#   scripts/restore.sh --yes <source>                       replace production with the backup
#   scripts/restore.sh --target-db <name> [--keep] <source> drill: restore into a scratch database
#   scripts/restore.sh --certs --yes <source>               put back Caddy's /data (certificates)
#
# <source> is an s3:// URI, a local file, `latest` (newest object under BACKUP_S3_URI) or
# `latest-local` (newest file in BACKUP_DIR, for when S3 is unreachable).
#
# Production restore, all or nothing:
# 1. download and verify the whole archive (pg_restore); a truncated or corrupt file stops here,
#    before anything is stopped or changed;
# 2. stop web and api, so nobody writes to data that is about to be replaced;
# 3. pg_restore --no-owner --exit-on-error --single-transaction into a new, empty database
#    <db>_restoring (a failure drops it and restarts the old stack: production never changed);
# 4. in one transaction rename <db> to <db>_before_restore and <db>_restoring to <db>: the
#    database the api uses is either entirely the old one or entirely the backup, never a mix;
# 5. run the migrations (the dump may predate the current schema), start the stack and wait for
#    every service to be healthy.
# The previous database stays as <db>_before_restore until the next restore (drop it by hand once
# the restored data is confirmed).
#
# The drill (--target-db) does steps 1 and 3 into <name> without touching production or stopping
# anything, prints row counts and the registration invariant, then drops <name> (--keep leaves it
# for inspection). Do one every month and before each registration round.
#
# --yes is required for anything that replaces data (production, certificates, an existing
# --target-db database); without it the script explains what would be replaced and exits 2.
# Exit codes: 0 done, 1 failed, 2 usage error or refused, 3 another backup/restore is running.
# Settings: scripts/lib/backup-common.sh.
set -euo pipefail

# shellcheck source=lib/backup-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-common.sh"

usage() { sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

confirmed=false
certs=false
keep_target=false
target_db=''
source_arg=''
while (($# > 0)); do
  case "$1" in
    --yes) confirmed=true ;;
    --certs) certs=true ;;
    --keep) keep_target=true ;;
    --target-db)
      (($# >= 2)) || die "$EXIT_USAGE" '--target-db needs a database name'
      target_db="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit "$EXIT_USAGE"
      ;;
    *)
      [[ -z "$source_arg" ]] || die "$EXIT_USAGE" 'give exactly one source'
      source_arg="$1"
      ;;
  esac
  shift
done
[[ -n "$source_arg" ]] || {
  usage >&2
  exit "$EXIT_USAGE"
}

load_config

staging_db="${DB_NAME}_restoring"
previous_db="${DB_NAME}_before_restore"
if [[ -n "$target_db" ]]; then
  $certs && die "$EXIT_USAGE" '--certs and --target-db do not go together'
  [[ "$target_db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    die "$EXIT_USAGE" '--target-db must be lower-case letters, digits and _'
  case "$target_db" in
    "$DB_NAME" | "$staging_db" | "$previous_db" | postgres | template0 | template1)
      die "$EXIT_USAGE" "--target-db ${target_db} is not a scratch database; pick another name"
      ;;
  esac
elif $keep_target; then
  die "$EXIT_USAGE" '--keep only applies to --target-db'
fi

if $certs; then
  name_prefix="$CERTS_PREFIX" name_suffix='.tar.gz'
else
  name_prefix="$DB_NAME" name_suffix='.dump'
fi

# Resolve the source to an S3 URI or a local file. Read-only, so it happens before the refusal
# below, which can then name exactly what would be restored.
source_uri=''
source_file=''
case "$source_arg" in
  latest)
    [[ -n "$BACKUP_S3_URI" ]] || die "$EXIT_USAGE" 'latest needs BACKUP_S3_URI; try latest-local'
    require_aws
    newest="$(newest_s3_name "$name_prefix" "$name_suffix")"
    [[ -n "$newest" ]] ||
      die "$EXIT_FAILURE" "no ${name_prefix}-*${name_suffix} under ${BACKUP_S3_URI}/"
    source_uri="${BACKUP_S3_URI}/${newest}"
    ;;
  latest-local)
    newest="$(newest_local_file "$name_prefix" "$name_suffix")"
    [[ -n "$newest" ]] || die "$EXIT_FAILURE" "no ${name_prefix}-*${name_suffix} in ${BACKUP_DIR}"
    source_file="${BACKUP_DIR}/${newest}"
    ;;
  s3://*)
    require_aws
    source_uri="$source_arg"
    ;;
  *)
    [[ "$source_arg" == /* ]] || source_arg="${CALLER_DIR}/${source_arg}"
    [[ -f "$source_arg" && -r "$source_arg" ]] || die "$EXIT_USAGE" "not a readable file: ${source_arg}"
    source_file="$source_arg"
    ;;
esac
source_label="${source_uri:-$source_file}"

if ! $confirmed; then
  if $certs; then
    die "$EXIT_USAGE" "refusing without --yes: this stops the web service and replaces" \
      "everything in Caddy's /data volume (certificates, ACME account) with ${source_label}."
  elif [[ -z "$target_db" ]]; then
    die "$EXIT_USAGE" "refusing without --yes: this stops api and web and replaces the whole" \
      "production database ${DB_NAME} with ${source_label}. Every change made after that backup" \
      "is lost; the current database is kept as ${previous_db} until the next restore." \
      "To practise without touching production: --target-db <scratch_name>."
  fi
fi

prepare_backup_dir
work_dir="$(mktemp -d "${BACKUP_DIR}/.restore.XXXXXX")"
# Set while services this script stopped are down: the `compose up` arguments that bring them back
# if a later step fails. Empty when they were not running to begin with (a new server), so a
# failed restore never starts a site on an empty database.
restart_after_failure=()
on_exit() {
  local code=$?
  rm -rf -- "$work_dir"
  if ((code != 0 && ${#restart_after_failure[@]} > 0)); then
    warn "starting again what was stopped (docker compose up ${restart_after_failure[*]})"
    compose up "${restart_after_failure[@]}" >&2 ||
      warn 'it did not come back healthy; check "docker compose ps" and the logs'
  fi
  exit "$code"
}
trap on_exit EXIT

if [[ -n "$source_uri" ]]; then
  log "Downloading ${source_uri}"
  source_file="${work_dir}/$(basename "$source_uri")"
  aws s3 cp "$source_uri" "$source_file" --only-show-errors || die "$EXIT_FAILURE" 'download failed'
fi

# ------------------------------------------------------------------ certificates (Caddy /data)
if $certs; then
  verify_certs_archive "$source_file" ||
    die "$EXIT_FAILURE" "${source_label} is not a readable .tar.gz; nothing was changed"
  log 'Stopping web'
  if service_running web; then
    restart_after_failure=(-d --wait --wait-timeout 180 --no-deps web)
  fi
  compose stop web
  log "Replacing Caddy's /data with ${source_label}"
  compose run --rm --no-deps -T --entrypoint sh web \
    -c 'find /data -mindepth 1 -delete && tar -xzf - -C /data' <"$source_file" ||
    die "$EXIT_FAILURE" "extracting into /data failed"
  restart_after_failure=()
  compose up -d --wait --wait-timeout 180 --no-deps web || die "$EXIT_FAILURE" 'web did not start'
  log 'Certificates restored'
  exit 0
fi

# ------------------------------------------------------------------ database
if ! service_running postgres; then
  # E.g. a rebuilt server: the volume is created empty and initialised from the env file.
  log 'Starting postgres'
  compose up -d --wait --wait-timeout 180 postgres || die "$EXIT_FAILURE" 'postgres did not start'
fi

log "Verifying ${source_label} (pg_restore --list, then a full read)"
verify_dump "$source_file" ||
  die "$EXIT_FAILURE" "${source_label} is not a complete pg_dump archive; nothing was stopped or changed"

# restore_into <database>: a fresh database, filled in one transaction, so it either holds the
# whole backup or (after a failure, when it is dropped) nothing.
restore_into() {
  local database="$1"
  # Called from `||`, where set -e does not apply: every step checks its own status.
  drop_database "$database" >/dev/null || return 1
  # Roles belong to the server, not to one database, so pg_dump leaves them out while the dump
  # still GRANTs to club_app (apps/api/migrations/20261119000000_app-role.sql). On a rebuilt server
  # the role does not exist yet and pg_restore would stop at the first GRANT: create it NOLOGIN, as
  # that migration does; migrate gives it its login after the switch below.
  psql_in postgres <<'SQL' || return 1
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'club_app') THEN
    CREATE ROLE club_app NOLOGIN;
  END IF;
END
$$;
SQL
  psql_in postgres -v name="$database" <<<'CREATE DATABASE :"name";' || return 1
  log "Restoring into ${database}"
  if ! without_details compose exec -T postgres pg_restore -U "$DB_USER" -d "$database" \
    --no-owner --exit-on-error --single-transaction <"$source_file"; then
    drop_database "$database" >/dev/null || true
    return 1
  fi
  # Only this application's dump may replace its database.
  [[ "$(psql_in "$database" -tA <<<"SELECT to_regclass('public.pgmigrations') IS NOT NULL AND to_regclass('public.users') IS NOT NULL;")" == t ]] || {
    drop_database "$database" >/dev/null || true
    warn "${source_label} is not a dump of this application (no pgmigrations/users tables)"
    return 1
  }
}

if [[ -n "$target_db" ]]; then
  if database_exists "$target_db"; then
    $confirmed ||
      die "$EXIT_USAGE" "database ${target_db} already exists; pass --yes to replace it, or pick another name"
  fi
  restore_into "$target_db" || die "$EXIT_FAILURE" "restoring into ${target_db} failed; production untouched"
  log "Drill database ${target_db}: $(report_database "$target_db")"
  if $keep_target; then
    log "Kept ${target_db} (it holds personal data: drop it when done with" \
      "docker compose ... exec postgres dropdb -U ${DB_USER} ${target_db})"
  else
    drop_database "$target_db" >/dev/null || die "$EXIT_FAILURE" "could not drop ${target_db}"
    log "Dropped ${target_db}"
  fi
  log 'Drill finished: production was not touched'
  exit 0
fi

log 'Stopping web and api'
if service_running api || service_running web; then
  restart_after_failure=(-d --wait --wait-timeout 180)
fi
compose stop web api
restore_into "$staging_db" ||
  die "$EXIT_FAILURE" 'restore failed; the production database was not changed'

log "Switching ${DB_NAME} to the restored data (the old one becomes ${previous_db})"
drop_database "$previous_db" >/dev/null ||
  die "$EXIT_FAILURE" "could not drop the old ${previous_db}; the production database was not changed"
# The renames commit together or not at all (psql stops at the first error and the open
# transaction is rolled back), and a failure is reported as 1 like every other failure.
psql_in postgres -v db="$DB_NAME" -v staging="$staging_db" -v previous="$previous_db" <<'SQL' ||
-- Nothing else may hold a connection to a database being renamed; the api is already stopped,
-- this ends anything left over (an operator's psql).
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
WHERE datname IN (:'db', :'staging') AND pid <> pg_backend_pid() \g /dev/null
SELECT EXISTS (SELECT FROM pg_database WHERE datname = :'db') AS has_current \gset
BEGIN;
\if :has_current
ALTER DATABASE :"db" RENAME TO :"previous";
\endif
ALTER DATABASE :"staging" RENAME TO :"db";
COMMIT;
SQL
  die "$EXIT_FAILURE" 'switching to the restored database failed; the production database was not changed'

log 'Running migrations'
# From here the new data is in place: a failure must not bring back an api on an unmigrated
# schema (compose would re-run migrate first anyway, but say plainly what happened).
restart_after_failure=()
compose run --rm --no-deps -T migrate ||
  die "$EXIT_FAILURE" "the backup is in ${DB_NAME} but the migrations failed (see the output" \
    "above); api stays down. The old data is in ${previous_db}."
log 'Starting the stack'
compose up -d --wait --wait-timeout 180 || die "$EXIT_FAILURE" 'the stack did not become healthy'
log "Restored ${DB_NAME} from ${source_label}: $(report_database "$DB_NAME")"
log "The previous database is kept as ${previous_db}; once the restored data is confirmed, drop" \
  "it with: docker compose ... exec postgres dropdb -U ${DB_USER} ${previous_db}"
