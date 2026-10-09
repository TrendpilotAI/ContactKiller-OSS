#!/usr/bin/env bash
# Require the base revision's .beads/interactions.jsonl to be a byte prefix of
# the working tree's copy, so the audit log is only ever appended to.
#   usage: scripts/check-audit-append-only.sh <base-revision>
# A base revision without the file passes (the log is being introduced).
set -euo pipefail

base="${1:?usage: $0 <base-revision>}"
file=.beads/interactions.jsonl

cd "$(git rev-parse --show-toplevel)"

if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "base revision $base is not available in this clone; cannot verify the audit log" >&2
  exit 1
fi

if ! git cat-file -e "$base:$file" 2>/dev/null; then
  echo "$file does not exist on $base; nothing to compare."
  exit 0
fi

[ -f "$file" ] || { echo "$file exists on $base but was removed" >&2; exit 1; }

base_copy="$(mktemp)"
trap 'rm -f "$base_copy"' EXIT
git show "$base:$file" > "$base_copy"
base_size="$(stat -c %s "$base_copy")"
head_size="$(stat -c %s "$file")"

if [ "$head_size" -lt "$base_size" ]; then
  echo "$file shrank ($base_size -> $head_size bytes); it is append-only" >&2
  exit 1
fi
if ! cmp -s -n "$base_size" "$base_copy" "$file"; then
  echo "$file was modified before byte $base_size; it is append-only" >&2
  exit 1
fi
echo "$file is append-only relative to $base ($base_size -> $head_size bytes)."
