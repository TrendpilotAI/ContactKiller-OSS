#!/usr/bin/env bash
# Guards shared by check-beads-export.sh and bd-push.sh. Each fails closed.
#
#   beads-guard.sh config                  no export owner exclusion is in effect
#   beads-guard.sh listing <export-file>   the export holds exactly the tickets
#                                          bd lists (independent of exclusions)
#   beads-guard.sh no-allow <dir>          nothing in <dir> carries a gitleaks
#                                          allow comment
#
# Why: `bd export` silently drops issues whose owner matches export.exclude_owner
# or export.exclude_owners (config.yaml nested or dotted, the Dolt config table,
# or the environment), which would make the export scan pass on an empty or
# partial export while `bd dolt push` still publishes everything.
set -euo pipefail

cmd="${1:-}"
case "$cmd" in
  config)
    for key in export.exclude_owner export.exclude_owners; do
      value="$(bd config get "$key")"
      # `bd config get` prints "<key> (not set ...)" for an unset key.
      case "$value" in
        "$key (not set"*|"") ;;
        *)
          echo "$key is set; bd export would silently drop tickets from the scan." >&2
          echo "Unset it (bd config unset $key, or remove it from .beads/config.yaml)." >&2
          exit 1
          ;;
      esac
    done
    ;;

  listing)
    export_file="${2:?usage: $0 listing <export-file>}"
    listed="$(bd list --all --limit 0 --include-infra --include-templates --include-gates --json \
      | jq -r '.[].id' | sort -u)"
    exported="$(jq -r 'select(has("id")) | .id' "$export_file" | sort -u)"
    if [ "$listed" != "$exported" ]; then
      echo "the export does not hold exactly the tickets bd lists (an owner exclusion, a filter, or a bd bug):" >&2
      echo "  listed but not exported:" >&2
      comm -23 <(printf '%s\n' "$listed") <(printf '%s\n' "$exported") | sed 's/^/    /' >&2
      echo "  exported but not listed:" >&2
      comm -13 <(printf '%s\n' "$listed") <(printf '%s\n' "$exported") | sed 's/^/    /' >&2
      exit 1
    fi
    ;;

  no-allow)
    dir="${2:?usage: $0 no-allow <dir>}"
    status=0
    grep -rqF 'gitleaks:allow' "$dir" || status=$?
    case "$status" in
      0) echo "a file in $dir contains a gitleaks allow comment, which would suppress findings" >&2; exit 1 ;;
      1) ;;
      *) echo "grep failed (exit $status) while checking for gitleaks allow comments" >&2; exit 1 ;;
    esac
    ;;

  *)
    echo "usage: $0 config | listing <export-file> | no-allow <dir>" >&2
    exit 2
    ;;
esac
