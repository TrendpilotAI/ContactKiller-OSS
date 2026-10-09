#!/usr/bin/env bash
# The way to publish ticket data: run the required pre-push scans and guards,
# then `bd dolt push`. Only run this when the task or owner explicitly
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

# Dolt only pushes committed state, while the scans read the working set. So
# first require a clean working set: `bd dolt commit` is the only way bd 1.3.1
# exposes in embedded mode to find out (it prints exactly "Nothing to commit."
# when clean, and otherwise commits what was pending). Pending changes abort the
# push; they are now committed, so re-running scans exactly what would be pushed.
require_clean_working_set() {
  local out
  out="$(bd dolt commit 2>&1)" || { echo "bd dolt commit failed: $out" >&2; exit 1; }
  if [ "$out" != "Nothing to commit." ]; then
    echo "the Dolt working set had uncommitted changes; they were just committed. Review them and re-run." >&2
    exit 1
  fi
}

dolt_head() {
  bd vc status --json | jq -er '.commit'
}

export_digest() {
  local f
  f="$(mktemp)"
  bd export --all -o "$f" >/dev/null
  sha256sum "$f" | cut -d' ' -f1
  rm -f "$f"
}

require_clean_working_set
head_before="$(dolt_head)"
digest_before="$(export_digest)"

# The single full content scan: release check, export scan (guards, scanners,
# gitleaks) and the allow-comment check on the tracked tracker files.
bun scripts/check-public-release.ts
scripts/check-beads-export.sh --local
scripts/beads-guard.sh no-allow .beads

# Last step before pushing: nothing may have changed since the scan began.
require_clean_working_set
head_after="$(dolt_head)"
if [ "$head_after" != "$head_before" ]; then
  echo "Dolt HEAD moved during the scan ($head_before -> $head_after); not pushing. Re-run." >&2
  exit 1
fi
if [ "$(export_digest)" != "$digest_before" ]; then
  echo "the exported tracker content changed during the scan; not pushing. Re-run." >&2
  exit 1
fi
scripts/beads-guard.sh config

# Remaining window: another process could still commit between the checks above
# and the push below (milliseconds). bd offers no lock or compare-and-swap for
# `bd dolt push`, so do not run other bd writers while publishing.
bd dolt push --no-adopt "${remote_args[@]}"
