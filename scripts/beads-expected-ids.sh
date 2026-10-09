#!/usr/bin/env bash
# Derive ticket ids from the Beads audit log (.beads/interactions.jsonl).
#
#   beads-expected-ids.sh <log>              ids that should be published:
#                                            every `bd create`, minus ids whose
#                                            latest create/delete event is a
#                                            `bd delete`
#   beads-expected-ids.sh <log> <baseline>   same, for a pull request: creates
#                                            come from <baseline> (the base
#                                            branch's log); `bd delete` events
#                                            are taken from <baseline> and from
#                                            the lines <log> adds after it
#   beads-expected-ids.sh --created <log>    every id that has any `bd create`
#                                            event, deleted or not
#
# Tool names are matched exactly ("bd create", "bd delete"). Record every
# ticket-creating command under "bd create" and every deletion under
# "bd delete", one entry per ticket id (see AGENTS.md).
set -euo pipefail

reduce_ids='
  reduce .[] as $e ({};
    if ($e.tool_name // "") == "bd create" then .[$e.issue_id] = true
    elif ($e.tool_name // "") == "bd delete" then .[$e.issue_id] = false
    else . end)
  | to_entries[] | select(.value) | .key'

case "${1:-}" in
  --created)
    log="${2:?usage: $0 --created <log>}"
    jq -r 'select((.tool_name // "") == "bd create") | .issue_id' "$log" | sort -u
    ;;
  "")
    echo "usage: $0 [--created] <log> [<baseline>]" >&2
    exit 2
    ;;
  *)
    log="$1"
    baseline="${2:-}"
    if [ -z "$baseline" ]; then
      jq -rs "$reduce_ids" "$log" | sort -u
    else
      baseline_size="$(stat -c %s "$baseline")"
      if [ "$(stat -c %s "$log")" -lt "$baseline_size" ] || ! cmp -s -n "$baseline_size" "$baseline" "$log"; then
        echo "$log does not extend the baseline $baseline; refusing to derive ids" >&2
        exit 1
      fi
      {
        cat "$baseline"
        # Only the PR's own additions: re-reading deletes from the shared
        # prefix would wrongly delete a ticket that was re-created later.
        tail -c +"$((baseline_size + 1))" "$log" | jq -c 'select((.tool_name // "") == "bd delete")'
      } | jq -rs "$reduce_ids" | sort -u
    fi
    ;;
esac
