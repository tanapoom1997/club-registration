#!/usr/bin/env bash
# Exercises scripts/backup.sh and scripts/restore.sh against the real production stack
# (compose.prod.yml with SITE_ADDRESS=:80) and a local S3-compatible server (MinIO), with
# fictional data only. Needs Docker (with Compose v2 and BuildKit), curl and flock:
#
#   scripts/smoke-backup.sh
#
# What it checks: a backup lands in S3 with server-side encryption and the local copy is mode 600;
# the documented IAM policy (deploy/s3-backup-policy.example.json) is enough for backup and
# restore but cannot delete or list outside the prefix; the lock stops a second run; restore
# refuses without --yes and changes nothing; after the stack and its volumes are destroyed, the
# Caddy /data archive and then `restore.sh --yes latest` bring back identical data (row counts and
# checksums of every table), the registration invariant holds and the admin logs in through Caddy;
# a drill into a scratch database leaves production alone; a truncated or garbage dump is rejected
# before anything is stopped, and a restore that fails after stopping leaves the data as it was
# and restarts the stack; --local-only and an unreachable S3 keep a verified local copy; old local
# copies are pruned; and no script output contains the fictional names.
#
# The AWS CLI on the host is used when present (GitHub's ubuntu-24.04 runner has it). Without one,
# a pinned amazon/aws-cli image stands in through a wrapper on PATH for this test only;
# production always uses the host's CLI (README "Backup และ Restore"). SMOKE_AWS_CONTAINER=1
# forces the wrapper. Host ports default to 18081/18444 (SMOKE_BACKUP_HTTP_PORT,
# SMOKE_BACKUP_HTTPS_PORT); behind a TLS-intercepting proxy set EXTRA_CA_FILE=<pem> for the build.
#
# Every secret (database password, JWT_SECRET, admin password, MinIO credentials and KMS key) is
# random, lives only in a temporary directory for this run and is never printed. Everything the
# test creates (stack, volumes, images, MinIO) is removed on exit; the development database
# (docker-compose.yml) is a different project and is never touched.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/smoke-common.sh
source scripts/lib/smoke-common.sh

# Test-only images, pinned by tag and multi-arch digest. MinIO no longer publishes images of its
# own, so this is Bitnami's last community build of the MinIO server.
readonly MINIO_IMAGE='bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20'
readonly AWS_CLI_IMAGE='amazon/aws-cli:2.31.0@sha256:3b018ce74732c98acf6f1de59b3a89587cb7f9eb6ea0d1447d1779091b2bf057'
readonly HTTP_PORT="${SMOKE_BACKUP_HTTP_PORT:-18081}"
readonly HTTPS_PORT="${SMOKE_BACKUP_HTTPS_PORT:-18444}"
readonly BUCKET='smoke-club-backups'
readonly PREFIX='prod'
readonly KEEP_LOCAL=3
readonly ADMIN_LOGIN='smoke-admin'
# From deploy/production.env.example.
readonly DB='club_registration'
readonly DB_USER='club'
readonly DRILL_DB='drill_check'
# Appears in every fictional student's name; no script output may contain it.
readonly NAME_MARKER='นักเรียนสมมติ'
readonly DUMP_NAME_RE="^${DB}-[0-9]{8}T[0-9]{6}Z\\.dump\$"
readonly TABLES=(users student_profiles rounds clubs club_advisors registrations
  registration_events waitlist_entries queue_tickets password_issuances pgmigrations)

project="crbackup-$$-${RANDOM}"
work_dir="$(mktemp -d)"
env_file="$work_dir/production.env"
backup_dir="$work_dir/backups"
out_dir="$work_dir/out"
minio_container="${project}-minio"
mkdir -p "$out_dir"

compose() { docker compose -p "$project" -f "$PROD_COMPOSE_FILE" --env-file "$env_file" "$@"; }

cleanup() {
  if [[ -f "$env_file" ]]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rm -f -v "$minio_container" >/dev/null 2>&1 || true
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

# run <name> <command...>: runs a backup/restore command, shows its output indented and keeps it
# (checked for personal data at the end); its exit code is left in $rc.
run() {
  local name="$1"
  shift
  log "\$ ${*}"
  set +e
  "$@" >"$out_dir/$name.log" 2>&1
  rc=$?
  set -e
  sed 's/^/    | /' "$out_dir/$name.log"
}
rc_is() { [[ "$rc" == "$1" ]]; }
output_has() { grep -qF -- "$2" "$out_dir/$1.log"; }

container_of() { compose ps -aq "$1"; }
inspect() { docker inspect -f "$2" "$(container_of "$1")"; }
is_healthy() { [[ "$(inspect "$1" '{{.State.Health.Status}}')" == healthy ]]; }
started_at() { inspect "$1" '{{.State.StartedAt}}'; }
migrate_exited_ok() { [[ "$(inspect migrate '{{.State.Status}} {{.State.ExitCode}}')" == 'exited 0' ]]; }

# sql <database>: runs stdin in psql inside the postgres container, unaligned, no headers.
sql() { compose exec -T postgres psql -X -q -tA -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$1"; }
sql_value() { sql "$1" <<<"$2"; }
database_exists() { [[ "$(sql_value postgres "SELECT count(*) FROM pg_database WHERE datname = '$1'")" == 1 ]]; }
# Row count and an md5 over every row of each table (ordered by its text form), one line per
# table: equal fingerprints mean equal data. Written to a file, never printed.
fingerprint() {
  local table query=''
  for table in "${TABLES[@]}"; do
    query+="${query:+ UNION ALL }SELECT '${table} ' || count(*) || ' ' || md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM ${table} t"
  done
  sql_value "$1" "${query};" >"$2"
}
same_file() { cmp -s "$1" "$2"; }
invariant_holds() {
  [[ "$(sql_value "$1" 'SELECT count(*) FROM clubs c WHERE c.registered <> (SELECT count(*) FROM registrations r WHERE r.club_id = c.id) OR c.registered > c.capacity')" == 0 ]]
}

# fetch <name> <path> [curl args...] through Caddy on plain HTTP (SITE_ADDRESS=:80).
fetch() {
  local name="$1" path="$2"
  shift 2
  curl -sS -o "$work_dir/$name.body" -D "$work_dir/$name.headers" -w '%{http_code}' \
    "$@" "http://127.0.0.1:${HTTP_PORT}${path}" >"$work_dir/$name.status"
}
status_is() { [[ "$(cat "$work_dir/$1.status")" == "$2" ]]; }
login() {
  printf '{"loginId":"%s","password":"%s"}' "$ADMIN_LOGIN" "$2" |
    fetch "$1" /api/auth/login -X POST -H 'Content-Type: application/json' --data-binary @-
}

aws_as() {
  local user="$1" secret="$2"
  shift 2
  # A subshell on purpose: these credentials apply to this one call only.
  (
    # shellcheck disable=SC2030
    export AWS_ACCESS_KEY_ID="$user" AWS_SECRET_ACCESS_KEY="$secret"
    aws "$@"
  )
}
aws_root() { aws_as "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" "$@"; }
s3_dumps() { aws s3 ls "s3://${BUCKET}/${PREFIX}/" | awk '{ print $4 }' | grep -E "$DUMP_NAME_RE" || true; }
s3_dump_count() { s3_dumps | wc -l | tr -d ' '; }
local_dumps() { find "$backup_dir" -maxdepth 1 -name "${DB}-*.dump" -printf '%f\n' | sort; }
local_dump_count() { local_dumps | wc -l | tr -d ' '; }
mode_is() { [[ "$(stat -c %a "$1")" == "$2" ]]; }

# ---------------------------------------------------------------------------------------- setup
if [[ "${SMOKE_AWS_CONTAINER:-}" == 1 ]] || ! command -v aws >/dev/null 2>&1; then
  log "No host AWS CLI: using ${AWS_CLI_IMAGE%@*} through a wrapper (this test only)"
  mkdir -p "$work_dir/bin"
  # Host networking reaches MinIO on 127.0.0.1; the work directory is mounted at the same path so
  # file arguments mean the same inside and out. Credentials come from the environment (-e NAME
  # without a value), never from the command line.
  cat >"$work_dir/bin/aws" <<EOF
#!/usr/bin/env bash
exec docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \\
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION -e AWS_DEFAULT_REGION \\
  -e AWS_ENDPOINT_URL -e AWS_EC2_METADATA_DISABLED -e AWS_MAX_ATTEMPTS \\
  -e AWS_CONFIG_FILE -e AWS_SHARED_CREDENTIALS_FILE \\
  -v "${work_dir}:${work_dir}" -w "${work_dir}" "${AWS_CLI_IMAGE}" "\$@"
EOF
  chmod +x "$work_dir/bin/aws"
  PATH="$work_dir/bin:$PATH"
else
  log "Using the host AWS CLI ($(aws --version 2>&1))"
fi

log 'Starting MinIO (S3 with SSE-S3 through its built-in KMS key)'
MINIO_ROOT_USER="smoke-root-${RANDOM}"
MINIO_ROOT_PASSWORD="$(random_secret)"
MINIO_KMS_SECRET_KEY="smoke-key:$(head -c 32 /dev/urandom | base64)"
BACKUP_USER="smoke-backup-${RANDOM}"
BACKUP_SECRET="$(random_secret)"
export MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_KMS_SECRET_KEY BACKUP_USER BACKUP_SECRET
docker run -d --name "$minio_container" -p 127.0.0.1::9000 \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD -e MINIO_KMS_SECRET_KEY "$MINIO_IMAGE" >/dev/null
minio_port="$(docker port "$minio_container" 9000/tcp | head -n 1 | sed 's/.*://')"
# The scripts see only these, the way they would see the instance role and a region on EC2. The
# config/credentials paths do not exist, so nothing from a developer's ~/.aws leaks in.
export AWS_ENDPOINT_URL="http://127.0.0.1:${minio_port}" AWS_REGION='us-east-1'
export AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE="$work_dir/no-aws-config"
export AWS_SHARED_CREDENTIALS_FILE="$work_dir/no-aws-credentials"
wait_for 'MinIO' 60 curl -sf "${AWS_ENDPOINT_URL}/minio/health/ready"

log "Creating bucket ${BUCKET} (versioning, lifecycle) and a user with the documented policy"
aws_root s3 mb "s3://${BUCKET}" >/dev/null
aws_root s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
cp deploy/s3-lifecycle.example.json "$work_dir/lifecycle.json"
aws_root s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "file://${work_dir}/lifecycle.json"
sed "s/example-club-backups/${BUCKET}/g" deploy/s3-backup-policy.example.json \
  >"$work_dir/policy.json"
docker cp "$work_dir/policy.json" "$minio_container:/tmp/backup-policy.json" >/dev/null
# shellcheck disable=SC2016 # expanded by sh inside the MinIO container, not here
docker exec -e BACKUP_USER -e BACKUP_SECRET "$minio_container" sh -c '
  export MC_CONFIG_DIR=/tmp/.mc MC_HOST_smoke="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000"
  mc admin policy create smoke club-backup /tmp/backup-policy.json &&
    mc admin user add smoke "$BACKUP_USER" "$BACKUP_SECRET" &&
    mc admin policy attach smoke club-backup --user "$BACKUP_USER"' >/dev/null
# From here on the scripts (and plain `aws`) run as that least-privilege user.
# shellcheck disable=SC2031 # aws_as only changes them inside its own subshell
export AWS_ACCESS_KEY_ID="$BACKUP_USER" AWS_SECRET_ACCESS_KEY="$BACKUP_SECRET"

log "Writing a throwaway env file from $PROD_ENV_TEMPLATE"
write_prod_env_file "$env_file" 'SITE_ADDRESS=:80' "HTTP_PORT=${HTTP_PORT}" \
  "HTTPS_PORT=${HTTPS_PORT}" "BACKUP_S3_URI=s3://${BUCKET}/${PREFIX}/" \
  "BACKUP_DIR=${backup_dir}" "BACKUP_KEEP_LOCAL=${KEEP_LOCAL}"
# How the scripts find this stack: the env file, and compose's own project-name variable.
export PROD_ENV_FILE="$env_file" COMPOSE_PROJECT_NAME="$project"

log "Building images (project ${project})"
build_prod_images "$project" "$env_file" "$work_dir"

log 'Starting the stack (up --wait)'
if ! compose up -d --wait --wait-timeout 180; then
  dump_logs
  exit 1
fi

log 'Creating fictional data: an admin (create-admin, password changed through the API) and SQL'
# Output holds the initial password: kept in a variable, never echoed.
admin_output="$(compose run --rm --no-deps -T api node dist/create-admin.js "$ADMIN_LOGIN" 2>/dev/null)"
initial_password="$(sed -n 's/^Initial password (shown once, not stored): //p' <<<"$admin_output")"
admin_password="$(random_secret)"
login login_initial "$initial_password"
check 'the new admin logs in through Caddy' status_is login_initial 200
session_cookie="$(grep -i '^set-cookie:' "$work_dir/login_initial.headers" | head -n 1 |
  sed 's/^[^:]*: *//; s/;.*//')"
printf '{"currentPassword":"%s","newPassword":"%s"}' "$initial_password" "$admin_password" |
  fetch change_password /api/auth/change-password -X POST -H 'Content-Type: application/json' \
    -H "Cookie: ${session_cookie}" --data-binary @-
check 'the admin changes the initial password through the API' status_is change_password 200

sql "$DB" <<SQL
BEGIN;
INSERT INTO rounds (term, grade, opens_at, closes_at)
VALUES ('2/2569', 4, now() - interval '1 day', now() + interval '1 day');
INSERT INTO clubs (round_id, club_code, name, description, capacity)
SELECT r.id, 'SMK' || g, 'ชุมนุมสมมติ ' || g, 'รายละเอียดสมมติ', 10
FROM rounds r CROSS JOIN generate_series(1, 5) AS g;
INSERT INTO club_advisors (club_id, full_name, phone)
SELECT id, 'ครูสมมติ ' || club_code, '000-000-0000' FROM clubs;
WITH students AS (
  INSERT INTO users (login_id, full_name, role, password_hash)
  SELECT 'smoke' || lpad(g::text, 4, '0'), '${NAME_MARKER} ' || g, 'student', '!unissued'
  FROM generate_series(1, 40) AS g
  RETURNING id, right(login_id, 4)::int AS n
)
INSERT INTO student_profiles (user_id, grade, classroom, seat_no)
SELECT id, 4, (1 + n % 2)::text, n FROM students;
-- 30 of the 40 register, six per club; registered is set from the rows, as the app keeps it.
INSERT INTO registrations (round_id, student_id, club_id)
SELECT c.round_id, u.id, c.id
FROM users u JOIN clubs c ON c.club_code = 'SMK' || (1 + (right(u.login_id, 4)::int - 1) % 5)
WHERE u.role = 'student' AND right(u.login_id, 4)::int <= 30;
UPDATE clubs c SET registered = (SELECT count(*) FROM registrations r WHERE r.club_id = c.id);
INSERT INTO registration_events (round_id, student_id, club_id, event_type, actor_id, idempotency_key)
SELECT round_id, student_id, club_id, 'register', student_id, 'smoke-' || student_id
FROM registrations;
COMMIT;
SQL
check 'fictional data: 30 registrations' test "$(sql_value "$DB" 'SELECT count(*) FROM registrations')" -eq 30
check 'fictional data: the registration invariant holds' invariant_holds "$DB"
fingerprint "$DB" "$work_dir/fp-backup.txt"
# A file in Caddy's /data, to recognise the certificate volume after it is restored.
compose exec -T web sh -c 'echo smoke > /data/smoke-marker'

# --------------------------------------------------------------------------------- 1. backup
log '1. Backup to S3'
run backup scripts/backup.sh --include-certs
check 'backup.sh exits 0' rc_is 0
check 'exactly one dump object in S3' test "$(s3_dump_count)" -eq 1
dump_name="$(s3_dumps | tail -n 1)"
check "the object is named <db>-<UTC stamp>.dump (${dump_name})" grep -qE "$DUMP_NAME_RE" <<<"$dump_name"
sse="$(aws s3api head-object --bucket "$BUCKET" --key "${PREFIX}/${dump_name}" \
  --query ServerSideEncryption --output text)"
check "the object is encrypted at rest (ServerSideEncryption=${sse})" test "$sse" == AES256
check 'the local copy exists' test -f "$backup_dir/$dump_name"
check 'the local copy is mode 600' mode_is "$backup_dir/$dump_name" 600
check 'the backup directory is mode 700' mode_is "$backup_dir" 700
remote_size="$(aws s3 ls "s3://${BUCKET}/${PREFIX}/${dump_name}" | awk '{ print $3 }')"
check 'the object has the local copy'"'"'s size' \
  test "$remote_size" -eq "$(wc -c <"$backup_dir/$dump_name")"
certs_name="$(find "$backup_dir" -maxdepth 1 -name 'caddy-data-*.tar.gz' -printf '%f\n' | sort | tail -n 1)"
check 'the Caddy /data archive is kept locally, mode 600' mode_is "$backup_dir/$certs_name" 600
check 'the Caddy /data archive holds the volume' \
  bash -c "tar -tzf '$backup_dir/$certs_name' | grep -qx './smoke-marker'"
check 'the Caddy /data archive is uploaded' \
  bash -c "aws s3 ls 's3://${BUCKET}/${PREFIX}/${certs_name}' >/dev/null"
check 'the instance policy cannot delete a backup' \
  negate aws s3 rm "s3://${BUCKET}/${PREFIX}/${dump_name}" --only-show-errors
check '... and the backup is still there' test "$(s3_dump_count)" -eq 1
check 'the instance policy cannot list outside its prefix' negate aws s3 ls "s3://${BUCKET}/"

sleep 1 # backups are named by the second
run locked flock "$backup_dir/.lock" scripts/backup.sh
check 'a second backup while the lock is held exits 3' rc_is 3
check '... and makes no dump' test "$(local_dump_count)" -eq 1

# ------------------------------------------------------------------- 2. refusal, then restore
log '2. Restore'
# A change after the backup: one student cancels (row, counter and event, as the app does it).
sql "$DB" <<'SQL'
BEGIN;
WITH gone AS (
  DELETE FROM registrations
  WHERE id = (SELECT min(id) FROM registrations)
  RETURNING round_id, student_id, club_id
), counted AS (
  UPDATE clubs SET registered = registered - 1 WHERE id = (SELECT club_id FROM gone)
)
INSERT INTO registration_events (round_id, student_id, club_id, event_type, actor_id, idempotency_key)
SELECT round_id, student_id, club_id, 'cancel', student_id, 'smoke-cancel' FROM gone;
COMMIT;
SQL
fingerprint "$DB" "$work_dir/fp-changed.txt"
check 'the data changed after the backup' negate same_file "$work_dir/fp-backup.txt" \
  "$work_dir/fp-changed.txt"
api_started="$(started_at api)"
run refused scripts/restore.sh latest
check 'restore without --yes exits 2' rc_is 2
check '... and says what it would replace' output_has refused "production database ${DB}"
fingerprint "$DB" "$work_dir/fp-after-refusal.txt"
check '... and changes no data' same_file "$work_dir/fp-changed.txt" "$work_dir/fp-after-refusal.txt"
check '... and leaves the api running' test "$(started_at api)" == "$api_started"

log 'Destroying the stack and its volumes (down -v), as on a lost server'
compose down -v >/dev/null 2>&1
check 'no containers are left' test -z "$(compose ps -aq)"

# The documented order on a new server: certificates first, so Caddy's first start with the real
# domain finds them, then the database.
run certs_refused scripts/restore.sh --certs latest
check 'restoring certificates without --yes exits 2' rc_is 2
check '... and creates nothing' test -z "$(compose ps -aq)"
run certs scripts/restore.sh --certs --yes latest
check 'restore --certs --yes latest exits 0 (into a new volume)' rc_is 0
check "Caddy's /data is back (marker file)" compose exec -T web test -e /data/smoke-marker
check 'web is healthy after the certificate restore' is_healthy web

restore_started="$(date +%s)"
run restore scripts/restore.sh --yes latest
restore_seconds=$(($(date +%s) - restore_started))
check "restore --yes latest exits 0 (took ${restore_seconds}s)" rc_is 0
check 'api is healthy after the restore' is_healthy api
check 'web is healthy after the restore' is_healthy web
check 'migrate ran after the restore and exited 0' migrate_exited_ok
fingerprint "$DB" "$work_dir/fp-restored.txt"
check 'every table matches the backup (row counts and checksums)' \
  same_file "$work_dir/fp-backup.txt" "$work_dir/fp-restored.txt"
check 'the registration invariant holds after the restore' invariant_holds "$DB"
login login_restored "$admin_password"
check 'the admin logs in through Caddy with the password set before the backup' \
  status_is login_restored 200
check "the replaced database is kept as ${DB}_before_restore" database_exists "${DB}_before_restore"
check "no ${DB}_restoring database is left" negate database_exists "${DB}_restoring"
check "Caddy's restored /data survived the database restore" \
  compose exec -T web test -e /data/smoke-marker

# -------------------------------------------------------------------------------- 3. drill
log '3. Drill into a scratch database'
api_started="$(started_at api)"
run drill scripts/restore.sh --target-db "$DRILL_DB" --keep latest
check 'the drill exits 0' rc_is 0
fingerprint "$DRILL_DB" "$work_dir/fp-drill.txt"
check 'the drill database matches the backup' same_file "$work_dir/fp-backup.txt" "$work_dir/fp-drill.txt"
fingerprint "$DB" "$work_dir/fp-after-drill.txt"
check 'production data is untouched by the drill' \
  same_file "$work_dir/fp-restored.txt" "$work_dir/fp-after-drill.txt"
check 'the api kept running during the drill' test "$(started_at api)" == "$api_started"
run drill_exists scripts/restore.sh --target-db "$DRILL_DB" latest-local
check 'a drill into an existing database without --yes exits 2' rc_is 2
run drill_replace scripts/restore.sh --target-db "$DRILL_DB" --yes latest-local
check 'a drill with --yes from the local copy exits 0' rc_is 0
check '... and drops the scratch database afterwards (no --keep)' negate database_exists "$DRILL_DB"
run drill_prod scripts/restore.sh --target-db "$DB" --yes latest
check 'a drill into the production database name is refused (exit 2)' rc_is 2

# ------------------------------------------------------------------------- 4. broken dumps
log '4. Truncated and garbage dumps'
api_started="$(started_at api)"
full_size="$(wc -c <"$backup_dir/$dump_name")"
head -c "$((full_size / 2))" "$backup_dir/$dump_name" >"$work_dir/truncated.dump"
head -c 4096 /dev/urandom >"$work_dir/garbage.dump"
for broken in truncated garbage; do
  # Started from the dump's directory with a relative path, as an operator would type it.
  # shellcheck disable=SC2016 # expanded by the inner bash
  run "restore_${broken}" bash -c 'cd "$1" && exec "$2" --yes "$3"' _ "$work_dir" \
    "$PWD/scripts/restore.sh" "${broken}.dump"
  check "restoring a ${broken} dump fails (exit 1)" rc_is 1
  check '... before anything is stopped' output_has "restore_${broken}" 'nothing was stopped or changed'
done
check 'the api was never stopped' test "$(started_at api)" == "$api_started"
check 'the api is still healthy' is_healthy api
fingerprint "$DB" "$work_dir/fp-after-broken.txt"
check 'production data is unchanged' same_file "$work_dir/fp-restored.txt" "$work_dir/fp-after-broken.txt"
check "no ${DB}_restoring database is left" negate database_exists "${DB}_restoring"

# A complete, valid archive of the wrong database passes verification and only fails once api and
# web are stopped: production must stay as it was and the stack must come back by itself.
compose exec -T postgres pg_dump -U "$DB_USER" -d postgres --format=custom >"$work_dir/foreign.dump"
run restore_foreign scripts/restore.sh --yes "$work_dir/foreign.dump"
check 'restoring a dump of another database fails (exit 1)' rc_is 1
check '... after api and web were stopped' output_has restore_foreign 'Stopping web and api'
check '... and they are started again: api healthy' is_healthy api
check '... web healthy' is_healthy web
fingerprint "$DB" "$work_dir/fp-after-foreign.txt"
check '... production data is unchanged' \
  same_file "$work_dir/fp-restored.txt" "$work_dir/fp-after-foreign.txt"
check "... no ${DB}_restoring database is left" negate database_exists "${DB}_restoring"

# ----------------------------------------------------------------- 5. without S3, and pruning
log '5. Backups without S3'
objects_before="$(s3_dump_count)"
sleep 1
# Nothing listens on port 9: any S3 call would fail.
run s3_down env AWS_ENDPOINT_URL=http://127.0.0.1:9 AWS_MAX_ATTEMPTS=1 scripts/backup.sh
check 'a backup with S3 unreachable exits 4' rc_is 4
check '... keeps the verified local copy' test "$(local_dump_count)" -eq 2
check '... and says how to upload it later' output_has s3_down 'aws s3 cp'
sleep 1
run local_only env AWS_ENDPOINT_URL=http://127.0.0.1:9 AWS_MAX_ATTEMPTS=1 \
  scripts/backup.sh --local-only
check '--local-only exits 0 with S3 unreachable' rc_is 0
check '... and keeps a local copy' test "$(local_dump_count)" -eq 3
oldest_dump="$(local_dumps | head -n 1)"
sleep 1
run local_only_prune scripts/backup.sh --local-only
check "--local-only keeps the newest ${KEEP_LOCAL} local copies" \
  test "$(local_dump_count)" -eq "$KEEP_LOCAL"
check '... removing the oldest' negate test -e "$backup_dir/$oldest_dump"
check 'nothing was uploaded by those runs' test "$(s3_dump_count)" -eq "$objects_before"

# ------------------------------------------------------------------------------ 6. the logs
log '6. Script output'
# shellcheck disable=SC2016 # a literal $, not an expansion
check 'no script output contains a fictional name or a password hash' \
  negate grep -rqF -e "$NAME_MARKER" -e '$argon2id' "$out_dir"

if ((failures > 0)); then
  log "${failures} check(s) failed"
  dump_logs
  exit 1
fi
log 'All checks passed'
