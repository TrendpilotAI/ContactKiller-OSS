#!/usr/bin/env bash
# The way to publish ticket data: run the required pre-push export scan, then
# `bd dolt push`. Only run this when the task or owner explicitly authorises
# publishing. A green scan does NOT prove Dolt history is clean; see AGENTS.md.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    --force|-f)
      echo "refusing to force-push tracker data; replacing refs/dolt/data is an owner-only decision" >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
scripts/check-beads-export.sh --local
bd dolt push "$@"
