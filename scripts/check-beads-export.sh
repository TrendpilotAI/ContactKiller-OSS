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
#   BEADS_AUDIT_BASELINE  Path to the base branch's audit log (possibly empty).
#                         CI sets it on pull requests: `bd create` events come
#                         from the baseline, so a PR that records a new ticket is
#                         not red just because it is not published yet, while
#                         `bd delete` events the PR adds are still applied, so a
#                         PR that deletes a published ticket is not red either.
#   GITHUB_REPOSITORY     owner/name used to pin sync.remote in published mode
#                         (default: TrendpilotAI/ContactKiller-OSS).
#
# Requires: bd, jq, bun, gitleaks 8.30.x, git, and the standalone dolt CLI (for
# the synced-tables check). Any missing tool, bootstrap/export
# error, empty export while tickets are expected, or scanner error fails the run.
#
# Also fails when an export owner exclusion is configured or the export does not
# hold exactly the tickets `bd list` shows (scripts/beads-guard.sh), when a
# scanned file carries a gitleaks allow comment, and when `bd provenance log`
# returns anything for a ticket: this repo does not use the native provenance
# table (AGENTS.md).
#
# Also refuses dolt.auto-push in any source (scripts/beads-guard.sh), runs
# gitleaks with every suppression mechanism disabled, and checks that the
# synced Dolt tables outside the export are empty.
#
# Not covered. The scan sees only current rows of `bd export --all`, the
# per-ticket `bd provenance log`, the config table's values, and the dumps of
# the tables listed below. `bd dolt push` also publishes things it does not read:
# the kv and events tables, provenance rows of deleted tickets, the leases,
# wisp and counter tables, and the full Dolt commit history. (Dolt history is not
# scanned from inside bd; it could be walked with the dolt CLI, which this script
# does not do.) The tables issue_snapshots, compaction_snapshots,
# federation_peers, interactions, routes, custom_types and custom_statuses are
# required to be empty, and metadata may hold only bd's own bookkeeping keys;
# their dumps are scanned as well.
set -euo pipefail

mode=published
case "${1:-}" in
  "") ;;
  --local) mode=local ;;
  *) echo "usage: $0 [--local]" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)"

for tool in bd jq bun gitleaks git dolt; do
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

  jq -e '.backend == "dolt" and .dolt_mode == "embedded"' .beads/metadata.json >/dev/null \
    || { echo ".beads/metadata.json must select the embedded Dolt backend" >&2; exit 1; }

  # Before anything that could write: nothing may be configured to auto-push.
  scripts/beads-guard.sh autopush-files

  # The committed config decides where bootstrap fetches from; a PR must not be
  # able to point it at a different (clean-looking) remote.
  expected_remote="git+https://github.com/${GITHUB_REPOSITORY:-TrendpilotAI/ContactKiller-OSS}"
  configured_remote="$(bd config get sync.remote)"
  if [ "$configured_remote" != "$expected_remote" ]; then
    echo "sync.remote is not the canonical remote for this repository" >&2
    echo "  expected: $expected_remote" >&2
    echo "  found:    $configured_remote" >&2
    exit 1
  fi

  bootstrap_log="$(mktemp)"
  bd bootstrap --yes 2>&1 | tee "$bootstrap_log"
  # Whole-line match: bd prints this on a line of its own.
  if ! grep -qxF "Synced database from $expected_remote" "$bootstrap_log"; then
    echo "bootstrap did not sync-clone the published data from $expected_remote" >&2
    echo "(it may have imported local files or created a fresh database)" >&2
    exit 1
  fi
  rm -f "$bootstrap_log"
  origin_remote="$(bd dolt remote list | awk '$1 == "origin" { print $2 }')"
  if [ "$origin_remote" != "$expected_remote" ]; then
    echo "bd's Dolt remote 'origin' is not $expected_remote" >&2
    exit 1
  fi
fi

scan_dir="$(mktemp -d)"
trap 'rm -rf "$scan_dir"' EXIT
export_file="$scan_dir/beads-export.jsonl"
scripts/beads-guard.sh config
bd export --all -o "$export_file"
scripts/beads-guard.sh listing "$export_file"
scripts/beads-guard.sh synced-tables "$scan_dir"

if [ -n "${BEADS_AUDIT_BASELINE:-}" ]; then
  [ -f "$BEADS_AUDIT_BASELINE" ] || { echo "audit baseline not found: $BEADS_AUDIT_BASELINE" >&2; exit 1; }
  expected_ids="$(scripts/beads-expected-ids.sh "$audit_log" "$BEADS_AUDIT_BASELINE")"
else
  expected_ids="$(scripts/beads-expected-ids.sh "$audit_log")"
fi
created_ids="$(scripts/beads-expected-ids.sh --created "$audit_log")"
exported_ids="$(jq -r 'select(has("id")) | .id' "$export_file" | sort -u)"
exported_count="$(printf '%s\n' "$exported_ids" | grep -c . || true)"
expected_count="$(printf '%s\n' "$expected_ids" | grep -c . || true)"

if [ "$expected_count" -gt 0 ] && [ "$exported_count" -eq 0 ]; then
  echo "export is empty but $expected_count ticket(s) are expected from the audit log" >&2
  exit 1
fi
missing="$(comm -23 <(printf '%s\n' "$expected_ids") <(printf '%s\n' "$exported_ids"))"
if [ -n "$missing" ]; then
  echo "tickets recorded in the audit log are missing from the export:" >&2
  printf '%s\n' "$missing" >&2
  exit 1
fi
unrecorded="$(comm -13 <(printf '%s\n' "$created_ids") <(printf '%s\n' "$exported_ids"))"
if [ -n "$unrecorded" ]; then
  echo "tickets in the export have no \"bd create\" entry in the audit log (record one per ticket):" >&2
  printf '%s\n' "$unrecorded" >&2
  exit 1
fi

# The native provenance table is not used in this repo and is not part of
# `bd export`; dump it per ticket so it is scanned, and fail if it has rows.
provenance_dir="$scan_dir/provenance"
mkdir -p "$provenance_dir"
provenance_rows=0
n=0
for id in $exported_ids; do
  n=$((n + 1))
  out="$provenance_dir/ticket-$n.json"
  bd provenance log "$id" --json > "$out"
  rows="$(jq 'length' "$out")"
  provenance_rows=$((provenance_rows + rows))
done

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
bun scripts/check-public-release.ts --scan-export "$scan_dir"/synced-tables/*.json
if compgen -G "$provenance_dir/*.json" >/dev/null; then
  bun scripts/check-public-release.ts --scan-export "$provenance_dir"/*.json
fi
scripts/beads-guard.sh no-allow "$scan_dir"
scripts/beads-guard.sh gitleaks "$scan_dir"

if [ "$provenance_rows" -gt 0 ]; then
  echo "bd provenance log returned $provenance_rows row(s): the native provenance table must stay empty in this public repo (AGENTS.md)" >&2
  exit 1
fi

echo "Beads export scan passed: $exported_count ticket(s) exported ($mode mode)."
