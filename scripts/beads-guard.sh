#!/usr/bin/env bash
# Guards shared by check-beads-export.sh and bd-push.sh. Each fails closed.
#
#   beads-guard.sh config                  no export-owner exclusion or directory
#                                          label filter is configured anywhere
#   beads-guard.sh listing <export-file>   the export holds exactly the records
#                                          bd lists, ignoring those filters
#   beads-guard.sh no-allow <dir>          nothing in <dir> carries a gitleaks
#                                          allow comment
#
# Why: `bd export` silently drops issues whose creator matches
# export.exclude_owner / export.exclude_owners, and a bare `bd list` silently
# applies directory.labels. Those keys can come from config.yaml (nested or
# dotted), the environment, or the Dolt config table, which travels with
# refs/dolt/data. `bd config get` sees only YAML and environment, so the config
# guard also reads `bd config list --json` (the config table). The listing guard
# is the backstop for anything else that makes the export differ from what bd
# lists; it cannot see a filter that also hides records from `bd list` itself,
# which is why the config guard rejects the keys outright.
set -euo pipefail

cmd="${1:-}"
case "$cmd" in
  config)
    bad_key='^(export\.exclude_owner|directory\.label)'
    # YAML and environment (`bd config get` prints "<key> (not set ...)" when unset).
    for key in export.exclude_owner export.exclude_owners directory.labels directory.label; do
      value="$(bd config get "$key")"
      case "$value" in
        "$key (not set"*|"") ;;
        *)
          echo "$key is set (config.yaml or environment); it would silently filter the export or the listing." >&2
          echo "Remove it from .beads/config.yaml / the environment." >&2
          exit 1
          ;;
      esac
    done
    # config.yaml itself: `bd config get` cannot see a directory.labels map (it
    # prints "not set"), yet bd list applies it to the matching directory.
    yaml="${BEADS_DIR:-.beads}/config.yaml"
    if [ -f "$yaml" ] && sed 's/#.*//' "$yaml" | grep -qiE \
        '^[[:space:]]*["'\'']?directory["'\'']?[[:space:]]*:|directory\.label|exclude_owner'; then
      echo "$yaml configures a directory label filter or an export owner exclusion; remove it." >&2
      exit 1
    fi
    # The Dolt config table: any key of that shape, with any value.
    table="$(bd config list --json)"
    printf '%s' "$table" | jq -e 'type == "object"' >/dev/null \
      || { echo "unexpected output from 'bd config list --json'; refusing to continue" >&2; exit 1; }
    table_keys="$(printf '%s' "$table" | jq -r --arg re "$bad_key" 'keys[] | select(test($re; "i"))')"
    if [ -n "$table_keys" ]; then
      echo "the Dolt config table holds a key that would silently filter the export or the listing:" >&2
      printf '  %s\n' $table_keys >&2
      echo "Remove it (bd config unset <key>); it travels with refs/dolt/data." >&2
      exit 1
    fi
    ;;

  listing)
    export_file="${2:?usage: $0 listing <export-file>}"
    # --skip-labels makes bd ignore directory.labels; --limit 0 lifts the default cap of 50.
    listing="$(bd list --all --limit 0 --skip-labels --include-infra --include-templates --include-gates --json)"
    printf '%s' "$listing" | jq -e '
        type == "object" and (.issues | type) == "array"
        and has("meta") and has("schema_version")' >/dev/null \
      || { echo "unexpected 'bd list --json' shape (expected {issues, meta, schema_version}); refusing to continue" >&2; exit 1; }

    # One "id<TAB>status<TAB>updated_at" line per record, in each source.
    fields='[.id, (.status // ""), (.updated_at // "")] | @tsv'
    listed_rows="$(printf '%s' "$listing" | jq -r ".issues[] | $fields")"
    exported_rows="$(jq -r "select(has(\"id\")) | $fields" "$export_file")"

    # Counts before any de-duplication, then duplicates on either side.
    listed_count="$(printf '%s' "$listed_rows" | grep -c . || true)"
    exported_count="$(printf '%s' "$exported_rows" | grep -c . || true)"
    if [ "$listed_count" -ne "$exported_count" ]; then
      echo "record counts differ: bd lists $listed_count, the export holds $exported_count" >&2
      exit 1
    fi
    for side in listed exported; do
      rows="$listed_rows"
      [ "$side" = exported ] && rows="$exported_rows"
      dup="$(printf '%s\n' "$rows" | cut -f1 | sort | uniq -d)"
      if [ -n "$dup" ]; then
        echo "duplicate ids on the $side side:" >&2
        printf '%s\n' "$dup" | sed 's/^/    /' >&2
        exit 1
      fi
    done

    if [ "$(printf '%s\n' "$listed_rows" | sort)" != "$(printf '%s\n' "$exported_rows" | sort)" ]; then
      echo "the export does not hold exactly the records bd lists (id, status, updated_at):" >&2
      echo "  listed but not exported:" >&2
      comm -23 <(printf '%s\n' "$listed_rows" | sort) <(printf '%s\n' "$exported_rows" | sort) | sed 's/^/    /' >&2
      echo "  exported but not listed:" >&2
      comm -13 <(printf '%s\n' "$listed_rows" | sort) <(printf '%s\n' "$exported_rows" | sort) | sed 's/^/    /' >&2
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
