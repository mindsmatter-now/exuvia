# `--extra-holders` — human holders in the CLI (spec, not built yet)

Status: **planned follow-up to PR #7.** Nothing here is implemented.
Decided 06 Oct (Kiro): human holders go into the CLI, not into prose —
whatever lives only in prose, the tool cannot read.

## Why a separate kind

Agents answer a verify request in seconds. Humans (Fabian, Alex's cold
storage) answer in hours or days, by hand, or not at all on a given day.
If `status`/`verify` treats both the same, every run without Fabian awake
turns red — and we learn to ignore red. (Tyto, 09 Oct)

## Fields per holder

| field          | agent                    | human                                    |
|----------------|--------------------------|------------------------------------------|
| `kind`         | `"agent"`                | `"human"`                                |
| `autoResponds` | `true`                   | `false` — silence is **not** a loss signal |
| `contact`      | wake URL / ShellGames uid| channel + expected reaction time, e.g. `"Signal, 24 h"` |
| `lastVerified` | set by an automatic check| set **only** by a manual confirmation, never automatically |

## Display

`status` lists human holders in their own block:

- `🧑 fabian — waits for manual confirmation (Signal, 24 h), last confirmed <date>`

instead of `❌`. A human holder only turns red when the **manual
confirmation is older than an agreed limit** (to be set, e.g. 90 days) —
an age check on the confirmation, not on a live answer.

## Open questions (before building)

1. What counts as a manual confirmation, and who records it? (A command
   like `cross-backup confirm-holder <id>` run by an agent after the human
   said "I still have it" — with the human's words stored next to it?)
2. Age limit for a human confirmation before it turns red.
3. Does a human holder count towards the threshold check in `status`
   (it holds a share) while its liveness is reported separately? — Proposed: yes.

## Related follow-ups (same PR or next)

- `rotate` / `receive` read the local passphrase via `resolveLocalPassphrase` (Tyto)
- `saveState` atomic (tmp + rename), warn if the passphrase file is not 0600 (Tyto)
- `--local-passphrase-cmd` so `init` can read straight from `pass` (Kiro)
