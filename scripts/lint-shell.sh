#!/usr/bin/env bash
# Runs ShellCheck on every shell script git tracks: *.sh, plus any file without the extension
# whose first line is a sh/bash shebang, so a new script cannot be left out by its name. The
# backup, restore and smoke scripts handle production data and secrets, where an unquoted
# variable or an ignored exit code does real damage (CLAUDE.md: shellcheck after editing them).
# Settings come from .shellcheckrc (follows `source` to scripts/lib/).
#
# Exit 0 = clean, 1 = findings, 2 = shellcheck missing. CI (ci.yml job check) runs it as is.
#
#   scripts/lint-shell.sh          # or: pnpm lint:sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v shellcheck >/dev/null; then
  echo 'lint-shell: shellcheck not found. Install it, e.g. apt-get install shellcheck' >&2
  echo '  or brew install shellcheck (CI uses the Ubuntu 24.04 package).' >&2
  exit 2
fi

is_shell_script() {
  local path=$1 first=''
  [[ $path == *.sh ]] && return 0
  # A file shorter than one line, or binary, simply does not match.
  IFS= read -r first <"$path" 2>/dev/null || true
  [[ $first =~ ^\#!.*(/|[[:space:]])(ba|da)?sh([[:space:]]|$) ]]
}

scripts=()
# -z: paths with spaces or non-ASCII names arrive verbatim, not quoted by git.
while IFS= read -r -d '' path; do
  # Tracked but deleted in the working tree: nothing to lint.
  [[ -f $path ]] || continue
  if is_shell_script "$path"; then
    scripts+=("$path")
  fi
done < <(git ls-files -z)

if ((${#scripts[@]} == 0)); then
  echo 'lint-shell: no shell scripts found' >&2
  exit 1
fi

echo "lint-shell: $(shellcheck --version | sed -n 's/^version: //p'), ${#scripts[@]} scripts"
shellcheck "${scripts[@]}"
echo 'lint-shell: no findings'
