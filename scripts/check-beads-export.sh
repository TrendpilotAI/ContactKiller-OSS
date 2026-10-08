#!/usr/bin/env bash
# Fail-closed public scan of the Beads tracker export.
#
#   scripts/check-beads-export.sh            CI mode: bootstrap from the published
#                                            tracker data, export, scan.
#   scripts/check-beads-export.sh --local    Pre-push mode: export the local
#                                            database and scan it. Run this and
#                                            get a pass before every `bd dolt push`.
#
# Requires: bd, jq, bun, gitleaks, git. Any missing tool, bootstrap/export
# error, empty export while tickets exist, or scanner error fails the run.
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
audit_log=.beads/interactions.jsonl
[ -s "$audit_log" ] || { echo "$audit_log is missing or empty" >&2; exit 1; }

if [ "$mode" = published ]; then
  bd bootstrap --yes
fi

scan_dir="$(mktemp -d)"
trap 'rm -rf "$scan_dir"' EXIT
export_file="$scan_dir/beads-export.jsonl"
bd export -o "$export_file"

expected_ids="$(jq -r 'select(.tool_name == "bd create") | .issue_id' "$audit_log" | sort -u)"
exported_ids="$(jq -r '.id' "$export_file" | sort -u)"
exported_count="$(printf '%s\n' "$exported_ids" | grep -c . || true)"
expected_count="$(printf '%s\n' "$expected_ids" | grep -c . || true)"

if [ "$expected_count" -gt 0 ] && [ "$exported_count" -eq 0 ]; then
  echo "export is empty but $expected_count ticket(s) were recorded in $audit_log" >&2
  exit 1
fi
missing="$(comm -23 <(printf '%s\n' "$expected_ids") <(printf '%s\n' "$exported_ids"))"
if [ -n "$missing" ]; then
  echo "tickets recorded in $audit_log are missing from the export:" >&2
  printf '%s\n' "$missing" >&2
  exit 1
fi

cp "$audit_log" "$scan_dir/interactions.jsonl"
bun scripts/check-public-release.ts --scan-export "$export_file" "$scan_dir/interactions.jsonl"
gitleaks dir "$scan_dir" --redact --no-banner

echo "Beads export scan passed: $exported_count ticket(s) exported ($mode mode)."
