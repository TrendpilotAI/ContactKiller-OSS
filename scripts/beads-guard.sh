#!/usr/bin/env bash
# Guards shared by check-beads-export.sh and bd-push.sh. Each fails closed.
#
#   beads-guard.sh config                  no export-owner exclusion or directory
#                                          label filter is configured anywhere
#   beads-guard.sh listing <export-file>   the export holds exactly the records
#                                          bd lists, ignoring those filters
#   beads-guard.sh no-allow <dir>          nothing in <dir> carries a gitleaks
#                                          allow comment
#   beads-guard.sh autopush-files          dolt.auto-push is not enabled in
#                                          config.yaml, config.local.yaml or the
#                                          environment (usable before bootstrap)
#   beads-guard.sh gitleaks-version        gitleaks is 8.30.x
#   beads-guard.sh gitleaks <dir>          run gitleaks 8.30.x on <dir> with
#                                          every suppression mechanism disabled
#   beads-guard.sh synced-tables <dir>     the Dolt tables `bd dolt push`
#                                          publishes but the export does not
#                                          contain are empty (metadata: only
#                                          expected keys); dumps them into <dir>
#                                          for scanning. Needs the dolt CLI.
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
#
# dolt.auto-push makes every bd write push to the public remote on its own,
# bypassing scripts/bd-push.sh and every scan, so it must be off in every source
# (config.yaml, config.local.yaml, the environment, the config table); the
# committed config.yaml must not mention it at all.
set -euo pipefail

# Is this config value one of the spellings that mean "off"?
is_off() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    ""|false|0|no|off|n|f) return 0 ;;
    *) return 1 ;;
  esac
}

autopush_files() {
  local yaml key value
  yaml="${BEADS_DIR:-.beads}/config.yaml"
  # The committed config must not carry the knob at all, even as false.
  if [ -f "$yaml" ] && sed 's/#.*//' "$yaml" | grep -qiE 'auto[-_]push'; then
    echo "$yaml mentions dolt.auto-push; the committed config must not set it (every bd write would push publicly)." >&2
    exit 1
  fi
  # config.yaml, config.local.yaml (nested or dotted) and the environment, as bd reads them.
  for key in dolt.auto-push dolt.auto_push; do
    value="$(bd config get "$key")"
    case "$value" in
      "$key (not set"*) ;;
      *)
        if ! is_off "$value"; then
          echo "$key is enabled (config.yaml, config.local.yaml or the environment); every bd write would push to the public remote." >&2
          exit 1
        fi
        ;;
    esac
  done
  if ! is_off "${BD_DOLT_AUTO_PUSH:-}"; then
    echo "BD_DOLT_AUTO_PUSH is set in the environment; every bd write would push to the public remote." >&2
    exit 1
  fi
}

autopush_table() {
  local table keys
  table="$1"
  keys="$(printf '%s' "$table" | jq -r 'to_entries[] | select(.key | test("^dolt\\.auto[-_]push"; "i")) | "\(.key)\t\(.value)"')"
  while IFS=$'\t' read -r key value; do
    [ -n "$key" ] || continue
    if ! is_off "$value"; then
      echo "the Dolt config table enables $key; every bd write would push to the public remote (it travels with refs/dolt/data)." >&2
      exit 1
    fi
  done <<<"$keys"
}

cmd="${1:-}"
case "$cmd" in
  autopush-files)
    autopush_files
    ;;

  config)
    autopush_files
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
    autopush_table "$table"
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

  gitleaks-version)
    version="$(gitleaks version 2>/dev/null || true)"
    case "$version" in
      8.30.*) ;;
      *) echo "gitleaks 8.30.x is required (found: ${version:-none})" >&2; exit 1 ;;
    esac
    ;;

  gitleaks)
    dir="${2:?usage: $0 gitleaks <dir>}"
    "$0" gitleaks-version
    # No environment-provided rules, and an empty ignore file, so neither a
    # config override nor a .gitleaksignore can suppress findings on ticket data.
    unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML
    empty_ignore="$(mktemp)"
    trap 'rm -f "$empty_ignore"' EXIT
    gitleaks dir "$dir" --redact --no-banner --ignore-gitleaks-allow -i "$empty_ignore"
    ;;

  synced-tables)
    dir="${2:?usage: $0 synced-tables <dir>}"
    command -v dolt >/dev/null 2>&1 || { echo "the dolt CLI is required to check the synced tables" >&2; exit 1; }
    db="$(jq -er '.dolt_database' "${BEADS_DIR:-.beads}/metadata.json")"
    case "$db" in
      ""|*[!A-Za-z0-9_-]*) echo "unexpected dolt_database name in metadata.json" >&2; exit 1 ;;
    esac
    store="${BEADS_DIR:-.beads}/embeddeddolt/$db"
    [ -d "$store" ] || { echo "no embedded Dolt store at $store" >&2; exit 1; }
    mkdir -p "$dir/synced-tables"
    # Published by `bd dolt push` but not part of `bd export`; policy is to leave them empty.
    for table in issue_snapshots compaction_snapshots federation_peers interactions routes custom_types custom_statuses; do
      out="$dir/synced-tables/$table.json"
      (cd "$store" && dolt sql -r json -q "SELECT * FROM \`$table\`") > "$out"
      rows="$(jq '(.rows // []) | length' "$out")"
      if [ "$rows" -ne 0 ]; then
        echo "synced table $table holds $rows row(s); this repo expects it to stay empty (see AGENTS.md)" >&2
        exit 1
      fi
    done
    # metadata: bd's own bookkeeping keys only.
    out="$dir/synced-tables/metadata.json"
    (cd "$store" && dolt sql -r json -q "SELECT * FROM metadata") > "$out"
    unexpected="$(jq -r '(.rows // [])[] | .key | select(. as $k | ["_project_id","clone_id","last_import_time","repo_id"] | index($k) | not)' "$out")"
    if [ -n "$unexpected" ]; then
      echo "synced table metadata holds unexpected key(s):" >&2
      printf '  %s\n' $unexpected >&2
      exit 1
    fi
    # The config table's values are scanned too (its keys are policed by the config guard).
    bd config list --json > "$dir/synced-tables/config.json"
    ;;

  *)
    echo "usage: $0 config | autopush-files | listing <export-file> | no-allow <dir> | gitleaks-version | gitleaks <dir> | synced-tables <dir>" >&2
    exit 2
    ;;
esac
