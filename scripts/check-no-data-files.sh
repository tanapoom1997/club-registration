#!/usr/bin/env bash
# Fails when git tracks a file that could hold real data: a spreadsheet, CSV, database dump or
# archive outside templates/ (which keeps empty templates only), or an env file other than the
# committed examples. The repo is public (CLAUDE.md rules 9 and 12). .gitignore already stops
# these, but `git add -f` gets past it; this is the check CI runs on every PR and push to main.
#
# Prints only the offending paths, never file contents. Exit 0 = clean, 1 = offending files.
#
#   scripts/check-no-data-files.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Patterns are matched case-insensitively, so X.XLSX or Backup.DUMP are caught too.
shopt -s nocasematch

is_data_file() {
  local path=$1
  [[ $path == templates/* ]] && return 1
  case "$path" in
    *.xlsx | *.xls | *.csv | *.dump | *.sql.gz | *.tar.gz) return 0 ;;
  esac
  return 1
}

# .env, .env.local, production.env, production.env.bak ...; only the *.example templates may be
# committed.
is_env_file() {
  local name=${1##*/}
  [[ $name == *.example ]] && return 1
  case "$name" in
    .env | .env.* | *.env | *.env.*) return 0 ;;
  esac
  return 1
}

offending=()
# -z: paths with spaces or non-ASCII names arrive verbatim, not quoted by git.
while IFS= read -r -d '' path; do
  if is_data_file "$path" || is_env_file "$path"; then
    offending+=("$path")
  fi
done < <(git ls-files -z)

if ((${#offending[@]} > 0)); then
  echo "check-no-data-files: these tracked files may hold real data or secrets (the repo is public):" >&2
  printf '  %s\n' "${offending[@]}" >&2
  echo "Remove them with git rm --cached and keep real files outside the repo." >&2
  exit 1
fi
echo 'check-no-data-files: no data or env files tracked outside templates/'
