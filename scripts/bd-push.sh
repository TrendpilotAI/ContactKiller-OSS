#!/usr/bin/env bash
# The way to publish ticket data: run the required pre-push export scan and
# guards, then `bd dolt push`. Only run this when the task or owner explicitly
# authorises publishing. A green scan does NOT prove Dolt history is clean; see
# AGENTS.md.
#
# Accepted arguments: none, or exactly `--remote origin`. Everything else
# (including -C/--directory, --db, --readonly, --sandbox, --dolt-auto-commit,
# --force and any other bd flag) is rejected, so the push always targets the
# workspace and remote that were scanned.
set -euo pipefail

remote_args=()
case "$#" in
  0) ;;
  2)
    if [ "$1" = "--remote" ] && [ "$2" = "origin" ]; then
      remote_args=(--remote origin)
    else
      echo "unsupported arguments; bd-push.sh accepts none, or exactly: --remote origin" >&2
      exit 2
    fi
    ;;
  *)
    echo "unsupported arguments; bd-push.sh accepts none, or exactly: --remote origin" >&2
    exit 2
    ;;
esac

cd "$(git rev-parse --show-toplevel)"

scripts/check-beads-export.sh --local

# Re-check immediately before pushing, on a fresh export.
scripts/beads-guard.sh config
guard_dir="$(mktemp -d)"
trap 'rm -rf "$guard_dir"' EXIT
bd export --all -o "$guard_dir/beads-export.jsonl"
scripts/beads-guard.sh listing "$guard_dir/beads-export.jsonl"
scripts/beads-guard.sh no-allow "$guard_dir"
scripts/beads-guard.sh no-allow .beads

bd dolt push --no-adopt "${remote_args[@]}"
