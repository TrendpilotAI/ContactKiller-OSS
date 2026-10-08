#!/usr/bin/env bash
# Fail-closed public scan of the Beads tracker export.
#
#   scripts/check-beads-export.sh            CI mode: bootstrap from the published
#                                            tracker data (clean checkout only),
#                                            export, scan.
#   scripts/check-beads-export.sh --local    Pre-push mode: export the local
#                                            database and scan it. Required before
#                                            every `bd dolt push` (scripts/bd-push.sh
#                                            runs it for you) but not sufficient on
#                                            its own; see AGENTS.md.
#
# Optional environment:
#   BEADS_AUDIT_BASELINE  Path to an audit log (possibly empty) to derive the
#                         expected ticket ids from instead of the working-tree
#                         log. CI sets it on pull requests to the base branch's
#                         log, so a PR that records a new `bd create` is not
#                         red just because that ticket is not published yet.
#
# Requires: bd, jq, bun, gitleaks, git. Any missing tool, bootstrap/export
# error, empty export while tickets are expected, or scanner error fails the run.
#
# Not covered: the scan sees only current rows of `bd export --all`. It does
# not see the kv, config and events tables or the Dolt commit history.
set -euo pipefail

mode=published
case "${1:-}" in
  "") ;;
  --local) mode=local ;;
  *) echo "usage: $0 [--local]" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)"

for tool in bd jq bun gitleaks git; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

export BD_NON_INTERACTIVE=1
export DO_NOT_TRACK=1
audit_log=.beads/interactions.jsonl
[ -s "$audit_log" ] || { echo "$audit_log is missing or empty" >&2; exit 1; }

if [ "$mode" = published ]; then
  if [ -e .beads/embeddeddolt ]; then
    echo ".beads/embeddeddolt already exists: published mode is for clean CI checkouts" >&2
    echo "and would otherwise scan the local database instead of the published data." >&2
    echo "Use --local to scan the local database, or run from a fresh clone." >&2
    exit 1
  fi
  bd bootstrap --yes
fi

scan_dir="$(mktemp -d)"
trap 'rm -rf "$scan_dir"' EXIT
export_file="$scan_dir/beads-export.jsonl"
bd export --all -o "$export_file"

expected_source="${BEADS_AUDIT_BASELINE:-$audit_log}"
[ -f "$expected_source" ] || { echo "audit baseline not found: $expected_source" >&2; exit 1; }

# Tickets expected to be published: every `bd create` in the log, minus any
# whose latest create/delete event is a `bd delete`.
expected_ids="$(jq -rs '
  reduce .[] as $e ({};
    if ($e.tool_name // "") == "bd create" then .[$e.issue_id] = true
    elif (($e.tool_name // "") | startswith("bd delete")) then .[$e.issue_id] = false
    else . end)
  | to_entries[] | select(.value) | .key' "$expected_source" | sort -u)"
exported_ids="$(jq -r 'select(has("id")) | .id' "$export_file" | sort -u)"
exported_count="$(printf '%s\n' "$exported_ids" | grep -c . || true)"
expected_count="$(printf '%s\n' "$expected_ids" | grep -c . || true)"

if [ "$expected_count" -gt 0 ] && [ "$exported_count" -eq 0 ]; then
  echo "export is empty but $expected_count ticket(s) are expected from $expected_source" >&2
  exit 1
fi
missing="$(comm -23 <(printf '%s\n' "$expected_ids") <(printf '%s\n' "$exported_ids"))"
if [ -n "$missing" ]; then
  echo "tickets recorded in $expected_source are missing from the export:" >&2
  printf '%s\n' "$missing" >&2
  exit 1
fi

cp "$audit_log" "$scan_dir/interactions.jsonl"
if [ ! -s "$export_file" ]; then
  # Only reachable when no tickets are expected; there is nothing to scan but
  # the audit log itself.
  rm -f "$export_file"
  echo "export is empty and no tickets are expected; scanning the audit log only" >&2
  bun scripts/check-public-release.ts --scan-export "$scan_dir/interactions.jsonl"
else
  bun scripts/check-public-release.ts --scan-export "$export_file" "$scan_dir/interactions.jsonl"
fi
gitleaks dir "$scan_dir" --redact --no-banner

echo "Beads export scan passed: $exported_count ticket(s) exported ($mode mode)."
