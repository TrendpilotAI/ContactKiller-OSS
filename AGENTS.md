# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

## Work Tracking (required)

All work in this repository is tracked as `bd` tickets, from now on. This is a
repo-level rule and takes precedence over the generated Beads block below.

1. **File** a ticket before you start (`bd create`). Every ticket carries the
   provenance described in the next section.
2. **Claim** it (`bd update <id> --claim`) when you begin.
3. **Update** it as work progresses (status, notes, follow-on tickets).
4. **Close** it (`bd close <id> --reason "..."`) when the work lands, and
   reference the final PR or commit.
5. **Record** every ticket creation as an audit event (see Provenance).

Durable work items (anything another agent or a later session needs to see)
belong in `bd`, not in markdown TODO files or chat-only plans. In-session
scratch todos (for example an agent's TodoWrite or TaskCreate checklist for the
current turn) and agent memory features (including `MEMORY.md`-style files) are
allowed. Treat them as private scratch space, not shared project state, and
move anything durable into a ticket. This overrides the generated Beads block
below, which says never to use those tools.

Open GitHub issues and pull requests each get a ticket whose `--external-ref`
is the GitHub URL.

Before ending a session: close or update your tickets, run the relevant quality
gates, and report status. Commit, push, and publish ticket data only when the
task or owner explicitly authorises it, and publish ticket data only with
`scripts/bd-push.sh` (see "Persistence and publishing"). The generated block
below has the full Session Completion protocol.

Install: `npm install -g @beads/bd@1.3.1` (the version CI uses); upstream is
<https://github.com/gastownhall/beads>. This repo was set up with bd 1.3.1,
issue prefix `ck`, embedded Dolt storage. `bd` usage metrics default to on;
see "Cursor hook" below for how to turn them off.

## Provenance

bd 1.3.1 does have a native provenance table (`bd provenance record`, `log`
and `by-ref`; an append-only `provenance_events` table). **This repo does not
use it, and `bd provenance record` is forbidden here.** The table is not part of
`bd export`, `bd dolt push` would publish it with its full history, and nothing
in the PR flow makes it reviewable. The export scan dumps `bd provenance log
--json` for every ticket and fails if any row exists. Provenance instead uses
this fixed mapping:

| Fact | Where it lives |
| --- | --- |
| GitHub PR or issue URL | `--external-ref <url>` |
| Follow-on work | `discovered-from` dependency on the parent ticket |
| Factory task | label `factory:<alias>` |
| Originating agent | label `agent:<alias>` (and the ticket assignee when it is claimed) |
| Commit SHA | label `commit:<sha7>` (see below) |
| Event log | `bd audit record` -> `.beads/interactions.jsonl` (append-only; provenance goes in the entry's `extra` field) |
| Per-ticket change trail | `bd history <id>` (add `--events` for field/label events) |

### Public aliases

This repo is public, so tickets, labels, assignees, audit entries and docs use
short **opaque aliases**, never internal ids:

- agents: `cloud-1`, `cloud-2`, ... for individual cloud agents, and `factory`
  for work that has no single cloud agent (for example Dependabot intake);
- factory tasks: `oss-<topic>` (for example `oss-beads`, `oss-surreal-exa`) and
  `dependabot` for the Dependabot PR tickets.

The alias-to-id mapping lives **only in the private tracker**. Do not write the
mapping, or any internal cloud-agent id, factory task id, or originating-agent
name, anywhere in this repository. If you need a new alias, allocate it in the
private tracker and use only the alias here. The scanner fails the build if an
internal cloud-agent id, internal factory task id, or internal originating-agent
name shows up in a tracked file or in the Beads export.

### Convention

Applied identically to every ticket:

- Labels are authoritative: exactly one `factory:`, one `agent:`, and one
  `commit:` label per ticket. `commit:` is the 7-character SHA the work is
  anchored to: the head of the PR for PR tickets, otherwise the tip of `main`
  when the ticket was filed. Add a further `commit:` label when work lands.
- The description ends with a human-readable line that mirrors the labels:
  `Provenance: factory=<alias>; agent=<alias>; commit=<sha7>[; external-ref=<url>]`.
- Never put secrets, tokens, private identifiers, or private-repo operational
  details in tickets, labels, audit entries, or this file.
- Set `BEADS_ACTOR=<your agent alias>` so ticket history and audit entries
  attribute the right actor. `bd` takes the ticket owner from `git config
  user.email`; the export scan rejects non-example email domains, so set a
  noreply address first: `git config --local user.email "<alias>@users.noreply.github.com"`.

Create a ticket and log its creation event:

```bash
export BEADS_ACTOR=cloud-1
id=$(bd create --title "..." --description "...

Provenance: factory=oss-example; agent=cloud-1; commit=abc1234; external-ref=https://github.com/TrendpilotAI/ContactKiller-OSS/pull/N" \
  --type task --priority 2 \
  --labels "factory:oss-example,agent:cloud-1,commit:abc1234" \
  --external-ref https://github.com/TrendpilotAI/ContactKiller-OSS/pull/N \
  --silent)
echo "{\"kind\":\"tool_call\",\"tool_name\":\"bd create\",\"issue_id\":\"$id\",\"exit_code\":0,\
\"response\":\"created $id\",\
\"extra\":{\"factory\":\"oss-example\",\"agent\":\"cloud-1\",\"commit\":\"abc1234\",\
\"external_ref\":\"https://github.com/TrendpilotAI/ContactKiller-OSS/pull/N\"}}" \
  | bd audit record --stdin
```

Follow-on work discovered while doing a ticket (also log its creation event):

```bash
child=$(bd create --title "..." --description "...

Provenance: factory=oss-example; agent=cloud-1; commit=abc1234" \
  --deps discovered-from:<parent-id> \
  --labels "factory:oss-example,agent:cloud-1,commit:abc1234" --silent)
echo "{\"kind\":\"tool_call\",\"tool_name\":\"bd create\",\"issue_id\":\"$child\",\"exit_code\":0,\
\"response\":\"created $child (discovered-from <parent-id>)\",\
\"extra\":{\"factory\":\"oss-example\",\"agent\":\"cloud-1\",\"commit\":\"abc1234\"}}" \
  | bd audit record --stdin
```

**Audit entries are matched exactly by `tool_name`.** Every command that
creates a ticket (`bd create` with any flags, `bd q`, `bd create --file` or
`--graph`, and anything else that adds an issue) must be recorded as
`"tool_name":"bd create"`, one entry per new ticket id. Every deletion must be
recorded as `"tool_name":"bd delete"`, one entry per deleted id. The export scan
fails if a published ticket has no `bd create` entry, so an unrecorded creation
is caught even if the audit step was forgotten. Other event names (claim,
close, and so on) are free-form.

Record significant later events (claim, handoff, close, PR opened) the same way,
with `--tool-name "<bd command>"` and the relevant `issue_id`.
`.beads/interactions.jsonl` is committed and must only ever be appended to. (It
was rewritten exactly once, when internal ids were replaced with the aliases
above; do not repeat that.)

### Persistence and publishing

Ticket data lives in the embedded Dolt database (`.beads/embeddeddolt/`, not
committed). Share it with `scripts/bd-push.sh` (publish) and `bd dolt pull`
(fetch); it is stored under
`refs/dolt/data` on the git remote, separate from branches (bd also keeps a
marker branch `__dolt_remote_info__` there; do not delete it). On a fresh
clone, run `bd bootstrap --yes` to fetch the tickets, then `git config
beads.role maintainer` (or `contributor`). `bd history <id>` (Dolt commit
snapshots) is shared with the data; `bd history <id> --events` (field and label
events) is local to the clone that made the change, so rely on the audit log
for the cross-clone event trail. Upstream's
[sync-concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)
lists the anti-patterns (JSONL is a passive export, not the source of truth;
do not `bd import` during normal operation). Tracked in git:
`.beads/config.yaml`, `.beads/metadata.json`, `.beads/README.md`,
`.beads/.gitignore`, and the audit log `.beads/interactions.jsonl`. Do not put
credentials in `.beads/config.yaml` (for example, keep `sync.remote` free of
embedded tokens).

**Every `bd dolt push` publishes the whole tracker, including its full Dolt
history, to the public remote, and published history cannot be cleanly
retracted.** That makes the following a hard rule:

> **Never write an internal id, email address, phone number, secret, or any
> other private detail into a ticket, label, assignee, description, note,
> comment, memory, or audit entry, not even temporarily.** Editing or deleting
> it afterwards does not help: Dolt keeps every earlier version, and the next
> push publishes that history. Cleaning it out later needs an owner-approved
> replacement of `refs/dolt/data` and a GitHub purge request.

**What the scan does and does not prove.** `scripts/check-beads-export.sh` scans
the current rows of `bd export --all` (issues, memories, infrastructure records,
templates and gates), the per-ticket output of `bd provenance log --json`, and
the audit log, using the same email, phone, Supabase, forbidden-content and
private-identifier checks as `scripts/check-public-release.ts`, then gitleaks.
It does **not** see the kv, config and events tables, provenance rows of
tickets that no longer exist, or the Dolt commit history. A green scan therefore
does not prove that history is clean; only the rule above does.

To publish ticket data, and only when the task or owner explicitly authorises
it:

1. Make sure no private detail was ever written to the tracker (the rule above).
2. Push with `scripts/bd-push.sh`, never a bare `bd dolt push`. It runs
   `scripts/check-beads-export.sh --local` (needs `bd`, `jq`, `bun`, `gitleaks`)
   and only then `bd dolt push`. The scan is required, but it is a backstop, not
   permission to be careless.
3. Never force-push, delete, or replace `refs/dolt/data`; `bd-push.sh` refuses
   `--force`, `--force=...` and short flag clusters containing `f`. Replacement
   is an owner-only decision.

CI runs the same scan on the published data in
`.github/workflows/beads-export.yml` (a separate workflow so the daily run does
not re-run the app jobs). It runs on pull requests, pushes to `main`, a daily
schedule and manual dispatch, because a push to `refs/dolt/data` cannot trigger
a workflow itself. It installs a checksum-pinned `bd` (with metrics off) and
runs `scripts/check-beads-export.sh` on a clean checkout. It fails closed: a
missing tool, an existing local database in published mode, a `sync.remote` that
is not `git+https://github.com/<owner>/<repo>`, a `.beads/metadata.json` that is
not embedded Dolt, a bootstrap that did not sync-clone from that remote (for
example a local import or a fresh init), a failed export, an empty export while
tickets are expected, an expected ticket missing from the export, a published
ticket with no `bd create` audit entry, any native provenance row, or any
scanner error fails the job.

- **Which tickets are expected.** Every `bd create` event in the audit log,
  except those whose latest event for that id is a `bd delete`. When you delete
  a ticket, record a `bd delete` audit entry for it (same `bd audit record`
  form, `"tool_name":"bd delete"`), or the scan will fail forever on the missing
  ticket. A later `bd create` for the same id makes it expected again.
- **Pull requests.** `bd create` events come from the base branch's audit log,
  so a PR that records a new ticket is not red just because the ticket is not
  published yet. `bd delete` events that the PR itself appends are also applied
  (safe because the append-only check guarantees the PR's log extends the
  base's), so a PR that deletes a published ticket is not red either. The PR's
  own audit log and the published export are still scanned. After merge, the
  `main` run expects new tickets to be published.
- **Append-only.** The public-release job requires the previous revision's
  `.beads/interactions.jsonl` to be a byte prefix of the new one
  (`scripts/check-audit-append-only.sh`): on pull requests against
  `github.event.pull_request.base.sha`, on pushes to `main` against
  `github.event.before` (skipped for the all-zeros SHA of a new ref). A file
  that is missing on the previous revision passes; a previous revision that is
  not available in the clone fails.
- **Failure alerts.** When a scheduled or manually dispatched run fails, the
  `alert` job opens, or comments on, an open issue titled "Beads export scan
  failing" that links to the run. It never copies scan output, since that may
  contain the leaked value. Only that job has `issues: write`.
- **Scheduled runs can go dormant.** GitHub disables scheduled workflows in a
  public repository after 60 days without repository activity. If the daily scan
  stops appearing in the Actions tab, re-enable it with
  `gh workflow enable beads-export.yml` (or the "Enable workflow" button on the
  workflow's page) and trigger one run with
  `gh workflow run beads-export.yml`.

### Cursor hook (opt-in, local only)

`.cursor/hooks.json` is not tracked (it is gitignored and forbidden by the
release manifest). Contributors who want Beads context injected into Cursor can
create it locally with exactly this content:

```json
{
  "hooks": {
    "postToolUse": [
      {
        "command": "bd cursor-hook postToolUse"
      }
    ],
    "preCompact": [
      {
        "command": "bd cursor-hook preCompact"
      }
    ],
    "sessionStart": [
      {
        "command": "bd cursor-hook sessionStart"
      }
    ]
  },
  "version": 1
}
```

It requires `bd` on your `PATH`; without it the hooks fail. Note that `bd`
anonymous usage metrics are **on by default** (command names, bd version and OS
platform are sent to the upstream project). Turn them off with `bd metrics off`
(stored per user in `~/.config/bd/config.yaml`); `bd metrics` shows the current
state and `bd metrics example` shows what is sent. `DO_NOT_TRACK=1` in the
environment also disables them; CI sets it and runs `bd metrics off`.

### Public-release check

`scripts/check-public-release.ts` allowlists every tracked file and forbids
`.jsonl`. The manifest's `forbiddenExtensionExceptions` carves out only
`.beads/interactions.jsonl`; any other new tracker file must be added to
`PUBLIC_RELEASE_MANIFEST.json` `allowedFiles`. Pass `--scan-export <file>...`
to run only the content checks on arbitrary files, as the export scan does. It
also fails on internal cloud-agent ids (full UUID form, and the `bc-` plus 8-hex
short form when it contains a digit), internal factory task ids and
originating-agent names in every tracked file, itself included; its own patterns
are written so their source cannot match.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Overrides of the generated Beads block

The generated block below is standard Beads text and is stricter or looser than
this repository in a few places. These repo rules win:

- Do not run a bare `bd dolt push` (its Session Completion step lists one).
  Publish ticket data only with `scripts/bd-push.sh`, and only when the task or
  owner explicitly authorises it.
- Do not use `bd provenance record`; see "Provenance".
- In-session scratch todos and agent memory are allowed (see "Work Tracking").

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
