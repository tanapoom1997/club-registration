#!/usr/bin/env bash
# Backs up the production database (docs/operations.md "Backup และ Restore"):
#
#   scripts/backup.sh [--local-only] [--include-certs]
#
# 1. pg_dump --format=custom inside the postgres container (no database port on the host), into
#    <BACKUP_DIR>/<db>-<YYYYmmddTHHMMSSZ>.dump (UTC), mode 600 in a mode 700 directory;
# 2. verifies the whole archive with pg_restore before keeping it (a broken dump is deleted, never
#    uploaded);
# 3. uploads it to <BACKUP_S3_URI>/<same name> with server-side encryption (SSE-S3) and checks the
#    object's size against the local file;
# 4. keeps the newest BACKUP_KEEP_LOCAL local copies. Old objects in S3 are removed by the
#    bucket's lifecycle rule, not here (the instance role has no delete permission).
#
# --local-only   skip S3 (for when S3 or the network is down); upload later with `aws s3 cp`.
# --include-certs  also archive Caddy's /data volume (certificates and ACME account key) as
#                <BACKUP_DIR>/caddy-data-<stamp>.tar.gz and upload it next to the dump, so a
#                rebuilt server can reuse its certificate instead of asking Let's Encrypt again.
#
# Non-interactive and safe to run from cron or a systemd timer: a lock (shared with restore.sh)
# stops runs from overlapping. Exit codes: 0 done, 1 failed (nothing kept or uploaded),
# 2 usage or configuration error, 3 another backup/restore is running, 4 the upload failed (the
# verified local copy is kept). Settings: scripts/lib/backup-common.sh.
set -euo pipefail

# shellcheck source=lib/backup-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/backup-common.sh"

usage() { sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }

local_only=false
include_certs=false
while (($# > 0)); do
  case "$1" in
    --local-only) local_only=true ;;
    --include-certs) include_certs=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit "$EXIT_USAGE"
      ;;
  esac
  shift
done

load_config
if ! $local_only; then
  [[ -n "$BACKUP_S3_URI" ]] ||
    die "$EXIT_USAGE" 'BACKUP_S3_URI is not set; set it in the env file, or use --local-only'
  require_aws
fi
prepare_backup_dir

service_running postgres || die "$EXIT_FAILURE" 'the postgres service is not running'
if $include_certs; then
  service_running web || die "$EXIT_FAILURE" '--include-certs needs the web service running'
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_name="${DB_NAME}-${stamp}.dump"
dump_file="${BACKUP_DIR}/${dump_name}"
certs_name="${CERTS_PREFIX}-${stamp}.tar.gz"
certs_file="${BACKUP_DIR}/${certs_name}"
[[ ! -e "$dump_file" ]] || die "$EXIT_FAILURE" "${dump_file} already exists"
# Written under a temporary name and renamed once verified, so a crash never leaves a file that
# looks like a finished backup (pruning and `latest-local` only see finished ones).
partial_files=("${dump_file}.partial" "${certs_file}.partial")
trap 'rm -f -- "${partial_files[@]}"' EXIT

log "Dumping database ${DB_NAME}"
compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom >"${dump_file}.partial" ||
  die "$EXIT_FAILURE" 'pg_dump failed; nothing was kept'
log 'Verifying the archive (pg_restore --list, then a full read)'
verify_dump "${dump_file}.partial" ||
  die "$EXIT_FAILURE" 'the new dump failed verification; it was deleted and nothing was uploaded'
mv -- "${dump_file}.partial" "$dump_file"
log "Local copy ${dump_file} ($(wc -c <"$dump_file") bytes)"

if $include_certs; then
  log "Archiving Caddy's /data (certificates)"
  compose exec -T web tar -C /data -czf - . >"${certs_file}.partial" ||
    die "$EXIT_FAILURE" 'archiving /data of the web service failed'
  verify_certs_archive "${certs_file}.partial" ||
    die "$EXIT_FAILURE" 'the certificate archive failed verification'
  mv -- "${certs_file}.partial" "$certs_file"
  log "Local copy ${certs_file} ($(wc -c <"$certs_file") bytes)"
fi

prune_local() {
  local prefix="$1" suffix="$2" excess
  local -a files
  mapfile -t files < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${prefix}-*${suffix}" \
    -printf '%f\n' | grep -E "^${prefix}-${STAMP_PATTERN}${suffix//./\\.}$" | sort)
  excess=$((${#files[@]} - BACKUP_KEEP_LOCAL))
  if ((excess > 0)); then
    log "Removing ${excess} old local file(s) ${prefix}-*${suffix} (keeping ${BACKUP_KEEP_LOCAL})"
    (cd "$BACKUP_DIR" && rm -f -- "${files[@]:0:excess}")
  fi
}

# upload <file> <name>: SSE-S3 (AES256) on every object, whatever the bucket's default; then the
# object must exist with the local file's size (`s3 ls` needs only ListBucket on the prefix).
upload() {
  local file="$1" name="$2" uri="${BACKUP_S3_URI}/${2}" remote_size
  aws s3 cp "$file" "$uri" --sse AES256 --only-show-errors || return 1
  remote_size="$(aws s3 ls "$uri" | awk -v name="$name" '$4 == name { print $3 }')"
  [[ "$remote_size" == "$(wc -c <"$file" | tr -d ' ')" ]] || {
    warn "${uri} is missing or its size differs from the local copy"
    return 1
  }
  log "Uploaded ${uri}"
}

upload_failed=false
if $local_only; then
  log '--local-only: nothing uploaded'
else
  upload "$dump_file" "$dump_name" || upload_failed=true
  if $include_certs && ! $upload_failed; then
    upload "$certs_file" "$certs_name" || upload_failed=true
  fi
fi

prune_local "$DB_NAME" .dump
prune_local "$CERTS_PREFIX" .tar.gz

if $upload_failed; then
  die "$EXIT_UPLOAD_FAILED" "the upload to S3 failed; the verified local copy is" \
    "kept in ${BACKUP_DIR}; upload it once S3 is reachable with:" \
    "aws s3 cp ${dump_file} ${BACKUP_S3_URI}/${dump_name} --sse AES256"
fi
log 'Backup finished'
